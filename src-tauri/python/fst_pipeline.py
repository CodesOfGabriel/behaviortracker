"""FST v6.2 pose inference with v6.4 visual presence, isolated from OFT.

Inputs are a SHA-verified video and validated full-cylinder fixed ROIs. The compact
result.json is for the UI; CSV/NPZ files retain raw coordinates and provenance.
"""
import csv
import gc
import hashlib
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from fst_presence import calculate_empty_reference, detect_presence_video, estimate_body_box

ENGINE = 'fst_superanimal_quadruped_v1'
VERSION = 'fst-0.1'
VALID_SCORE = 0.60
DRAW_SCORE = 0.35
MIN_MOTION_POINTS = 3
CHUNK_SECONDS = 20


def _sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for piece in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            h.update(piece)
    return h.hexdigest()


def _finite(value):
    value = float(value)
    return value if math.isfinite(value) else None


def _extract_pose(pred):
    # Directly follows the response shapes used in FST v6.2, cell 10.
    if not isinstance(pred, dict):
        raise ValueError(f'Unexpected DLC response: {type(pred)}')
    if 'bodypart' in pred and isinstance(pred['bodypart'], dict):
        raw = pred['bodypart'].get('poses')
    elif 'bodyparts' in pred:
        raw = pred['bodyparts']
    else:
        raise ValueError(f'DLC response has no pose: {list(pred)}')
    if raw is None:
        return None
    arr = np.asarray(raw)
    if arr.ndim == 4 and arr.shape[0] == 1:
        arr = arr[0]
    if arr.ndim == 3:
        if arr.shape[0] == 0:
            return None
        arr = arr[0]
    if arr.ndim != 2 or arr.shape[1] < 3:
        raise ValueError(f'Unexpected pose shape: {arr.shape}')
    return np.asarray(arr[:, :3], dtype=np.float32)


def _checkpoint(path, count, fingerprint):
    if not path.is_file():
        return None
    try:
        with np.load(path, allow_pickle=False) as data:
            arr = data['poses']
            if (arr.ndim == 3 and arr.shape[0] == count and arr.shape[2] == 3
                    and str(data['fingerprint'][0]) == fingerprint):
                return arr.copy()
    except (OSError, ValueError, KeyError, EOFError, IndexError):
        pass
    return None


def _save_checkpoint(path, arr, fingerprint):
    tmp = path.with_suffix('.npz.partial')
    with tmp.open('wb') as handle:
        np.savez_compressed(handle, poses=arr.astype(np.float32),
                            fingerprint=np.array([fingerprint]))
    os.replace(tmp, path)


def _validate(config, width, height):
    assert config['protocol'] == 'forced_swim' and config['engineId'] == ENGINE
    assert width == config['video']['width'] and height == config['video']['height'], 'Video resolution changed'
    tanks = config['tanks']
    assert 1 <= len(tanks) <= 2
    assert len(tanks) == len(config['subjects'])
    rects = {}
    for tank, subject in zip(tanks, config['subjects']):
        assert tank['animalId'] == subject['animalId'] and tank['subjectId'] == subject['subjectId']
        x, y, w, h = [tank['roiPx'][key] for key in ('x', 'y', 'width', 'height')]
        assert all(isinstance(v, (int, float)) and math.isfinite(v) for v in (x, y, w, h))
        assert all(v == int(v) for v in (x, y, w, h)), 'ROI coordinates must be integer pixels'
        x, y, w, h = map(round, (x, y, w, h))
        assert x >= 0 and y >= 0 and w >= 80 and h >= 80 and x+w <= width and y+h <= height
        assert h / height >= .55, 'Full-cylinder ROI must cover at least 55% of video height'
        assert tank['animalId'] not in rects
        rects[tank['animalId']] = (x, y, x+w, y+h)
    if len(rects) == 2:
        a, b = list(rects.values())
        assert max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1])) == 0
    return rects


def _runner(batch):
    import deeplabcut.pose_estimation_pytorch as pep
    from deeplabcut.pose_estimation_pytorch.modelzoo.inference_helpers import create_superanimal_inference_runners
    runner, detector, cfg = create_superanimal_inference_runners(
        superanimal_name='superanimal_quadruped', model_name='hrnet_w32',
        detector_name=None, max_individuals=1, batch_size=int(batch), device='cuda:0')
    assert detector is None, 'FST Faster R-CNN must be disabled'
    names = []
    try:
        cfg = dict(cfg)
        for item in (cfg.get('metadata', {}).get('bodyparts'), cfg.get('all_joints_names'), cfg.get('bodyparts')):
            if isinstance(item, (list, tuple)) and all(isinstance(s, str) for s in item):
                names = list(item)
                break
    except (TypeError, ValueError, AttributeError):
        pass
    return pep, runner, names


def _infer(video, cache, rects, fps, n_frames, fingerprint):
    import torch
    assert torch.cuda.is_available(), 'CUDA is required for FST inference'
    torch.backends.cudnn.benchmark = True
    gb = torch.cuda.get_device_properties(0).total_memory / 2**30
    batch = 16 if gb >= 28 else 8 if gb >= 14 else 4
    pep, runner, names = _runner(batch)
    chunk_frames = max(30, round(CHUNK_SECONDS * fps))
    arrays = {animal: [] for animal in rects}
    cap = cv2.VideoCapture(str(video))
    assert cap.isOpened(), 'Cannot reopen video'
    try:
        for chunk in range(math.ceil(n_frames/chunk_frames)):
            count = min(chunk_frames, n_frames-chunk*chunk_frames)
            available = {a: _checkpoint(cache/f'{a}_{chunk:04d}.npz', count, fingerprint) for a in rects}
            pending = [a for a, arr in available.items() if arr is None]
            clips = {}
            writers = {}
            try:
                for animal in pending:
                    x1,y1,x2,y2=rects[animal]
                    w,h=x2-x1,y2-y1
                    cw,ch=w+w%2,h+h%2
                    clip=cache/f'{animal}_{chunk:04d}.mp4'
                    writer=cv2.VideoWriter(str(clip),cv2.VideoWriter_fourcc(*'mp4v'),fps,(cw,ch))
                    if not writer.isOpened():
                        raise RuntimeError(f'Cannot create ROI clip {clip}')
                    clips[animal]=(clip,cw,ch)
                    writers[animal]=writer
                for offset in range(count):
                    if pending:
                        ok, frame = cap.read()
                        if not ok:
                            raise RuntimeError(f'Video ended at frame {chunk*chunk_frames+offset}')
                        for animal, writer in writers.items():
                            x1,y1,x2,y2=rects[animal]
                            crop=frame[y1:y2,x1:x2]
                            if crop.shape[1]%2 or crop.shape[0]%2:
                                crop=cv2.copyMakeBorder(crop,0,crop.shape[0]%2,0,crop.shape[1]%2,cv2.BORDER_CONSTANT,value=(0,0,0))
                            writer.write(crop)
                    elif not cap.grab():
                        raise RuntimeError(f'Video ended while skipping checkpoint {chunk}')
                for writer in writers.values():
                    writer.release()
                writers.clear()
                for animal in pending:
                    clip,cw,ch=clips[animal]
                    while True:
                        video_it=pep.VideoIterator(str(clip))
                        if video_it.get_n_frames(robust=True) != count:
                            raise RuntimeError(f'ROI clip frame count mismatch: {animal} {chunk}')
                        bbox=np.array([[0,0,cw,ch]],dtype=np.float32)
                        video_it.set_context([{'bboxes':bbox.copy()} for _ in range(count)])
                        try:
                            with torch.inference_mode():
                                result=pep.video_inference(video=video_it,pose_runner=runner,detector_runner=None)
                            break
                        except RuntimeError as error:
                            if 'out of memory' not in str(error).lower() or batch <= 1:
                                raise
                            batch=max(1,batch//2)
                            del runner, video_it
                            gc.collect();torch.cuda.empty_cache()
                            pep,runner,names=_runner(batch)
                    if len(result)!=count:
                        raise RuntimeError(f'DLC returned {len(result)} poses, expected {count}')
                    shapes=[_extract_pose(pred) for pred in result]
                    good=[p for p in shapes if p is not None]
                    k=good[0].shape[0] if good else len(names) or 39
                    if k != 39 or any(p.shape!=(k,3) for p in good):
                        raise RuntimeError(f'FST HRNet expected 39 consistent keypoints; got {k}')
                    arr=np.full((count,k,3),np.nan,dtype=np.float32)
                    arr[:,:,2]=0
                    for i,pose in enumerate(shapes):
                        if pose is not None:
                            arr[i]=pose
                    _save_checkpoint(cache/f'{animal}_{chunk:04d}.npz',arr,fingerprint)
                    available[animal]=arr
                    print(f'FST inference {animal}: {min(n_frames,(chunk+1)*chunk_frames)}/{n_frames} frames, batch={batch}',flush=True)
                    del result,shapes,good,arr,video_it
                    gc.collect()
                for animal, arr in available.items():
                    arrays[animal].append(arr)
            finally:
                for writer in writers.values():writer.release()
                for clip,_,_ in clips.values():clip.unlink(missing_ok=True)
    finally:
        cap.release()
    arrays={a:np.concatenate(parts,axis=0) for a,parts in arrays.items()}
    if any(len(arr)!=n_frames for arr in arrays.values()):raise RuntimeError('Incomplete FST poses')
    return arrays, names, batch


def _review_windows(frames, animals, fps, out):
    """v6.2 window reliability and rank, after v6.4 presence masking."""
    import pandas as pd
    all_windows = {}
    for seconds in (1, 3):
        width = max(1, round(fps * seconds))
        rows = []
        for animal in animals:
            group = [row for row in frames if row['animalId'] == animal]
            for start in range(0, len(group), width):
                part = group[start:start+width]
                if len(part) < width * .75:
                    continue
                motion = [row['relativeMotion'] for row in part if row['relativeMotion'] is not None]
                ratio = len(motion) / len(part)
                coverage = float(np.mean([row['poseCoverage'] for row in part]))
                reliable = ratio >= .60 and coverage >= .12
                rows.append({'animal_id':animal,'start_s':part[0]['timestampSec'],
                    'end_s':part[-1]['timestampSec']+1/fps,'n_frames':len(part),
                    'mean_pose_coverage':coverage,'motion_measurable_ratio':ratio,
                    'relative_motion_median':float(np.median(motion)) if reliable else np.nan,
                    'pose_reliable':reliable,'fst_behavior':'NOT_CLASSIFIED',
                    'movement_candidate':'TRACKING_INSUFFICIENT'})
        table = pd.DataFrame(rows)
        if not table.empty:
            for animal in animals:
                sub = table[(table.animal_id==animal)&table.pose_reliable]
                if len(sub) < 6:
                    continue
                lo = sub.relative_motion_median.quantile(.25)
                hi = sub.relative_motion_median.quantile(.75)
                table.loc[sub.index,'movement_candidate']='INTERMEDIATE_MOVEMENT'
                table.loc[sub.index[sub.relative_motion_median<=lo],'movement_candidate']='LOWER_OBSERVED_MOTION'
                table.loc[sub.index[sub.relative_motion_median>=hi],'movement_candidate']='HIGHER_OBSERVED_MOTION'
        table.to_csv(out/f'activity_windows_{seconds}s.csv',index=False)
        all_windows[seconds]=table
    shortlist=[]
    table=all_windows[3]
    if not table.empty:
        for animal in animals:
            group=table[table.animal_id==animal]
            valid=group[group.pose_reliable]
            for reason,selection in [('LOWER_OBSERVED_MOTION',valid.nsmallest(6,'relative_motion_median')),
                                     ('HIGHER_OBSERVED_MOTION',valid.nlargest(6,'relative_motion_median')),
                                     ('TRACKING_INSUFFICIENT',group[~group.pose_reliable].nsmallest(5,'mean_pose_coverage'))]:
                for row in selection.itertuples(index=False):
                    shortlist.append({'animalId':animal,'startSec':float(row.start_s),'endSec':float(row.end_s),
                                      'reason':reason,'relativeMotion':_finite(row.relative_motion_median),
                                      'meanPoseCoverage':float(row.mean_pose_coverage)})
    unique=[];seen=set()
    for item in shortlist:
        key=(item['animalId'],item['startSec'])
        if key not in seen:unique.append(item);seen.add(key)
    shortlist=unique
    shortlist.sort(key=lambda item:(item['animalId'],item['startSec']))
    pd.DataFrame([{'animal_id':item['animalId'],'start_s':item['startSec'],'end_s':item['endSec'],
                   'reason':item['reason'],'relative_motion_median':item['relativeMotion'],
                   'mean_pose_coverage':item['meanPoseCoverage']} for item in shortlist],
                 columns=['animal_id','start_s','end_s','reason','relative_motion_median','mean_pose_coverage'])\
        .to_csv(out/'review_shortlist.csv',index=False)
    return shortlist


def run(video_path, output_path, config):
    import deeplabcut
    import torch
    started=time.monotonic()
    video=Path(video_path);out=Path(output_path);out.mkdir(parents=True,exist_ok=True)
    assert torch.cuda.is_available(), 'CUDA unavailable'
    sha=_sha(video)
    assert sha==config['video']['sha256'], 'Video SHA-256 changed after upload'
    cap=cv2.VideoCapture(str(video))
    if not cap.isOpened():raise RuntimeError('Cannot open video')
    width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH));height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps=float(cap.get(cv2.CAP_PROP_FPS));n_frames=int(cap.get(cv2.CAP_PROP_FRAME_COUNT));cap.release()
    if not (width>80 and height>80 and fps>0 and n_frames>=round(3*fps)):
        raise RuntimeError('Invalid video dimensions, FPS, or length')
    rects=_validate(config,width,height)
    print('BEHAVETRACKER_FST_PHASE=validating_tanks',flush=True)
    fingerprint_data={'videoSha256':sha,'rects':{a:list(r) for a,r in rects.items()},'model':'superanimal_quadruped/hrnet_w32',
                      'deeplabcutVersion':deeplabcut.__version__,'engine':ENGINE,'algorithmVersion':VERSION,
                      'frameCount':n_frames,'fps':fps}
    fingerprint=hashlib.sha256(json.dumps(fingerprint_data,sort_keys=True).encode()).hexdigest()
    cache=Path('/content/behavetracker/fst-cache')/fingerprint
    cache.mkdir(parents=True,exist_ok=True)
    cache_config=cache/'config.json'
    if cache_config.exists() and json.loads(cache_config.read_text())!=fingerprint_data:
        raise RuntimeError('Checkpoint fingerprint collision')
    cache_config.write_text(json.dumps(fingerprint_data,indent=2))
    print('BEHAVETRACKER_FST_PHASE=inference',flush=True)
    arrays,names,batch=_infer(video,cache,rects,fps,n_frames,fingerprint)
    if len(names)!=39:names=[f'keypoint_{i:02d}' for i in range(39)]
    print('BEHAVETRACKER_FST_PHASE=presence',flush=True)
    references=calculate_empty_reference(video,rects,n_frames,fps)
    presence=detect_presence_video(video,rects,references,n_frames,fps)
    presence.to_csv(out/'presence.csv',index=False)
    events=[];presence_summary=[]
    for animal,group in presence.groupby('animal_id',sort=True):
        previous=None
        for row in group.itertuples(index=False):
            if row.presence_state!=previous:
                events.append({'animal_id':animal,'frame':int(row.frame),'timestamp_sec':float(row.frame/fps),
                               'state':row.presence_state,'previous_state':previous})
                previous=row.presence_state
        first=group[group.presence_state=='IN_TANK'].frame
        presence_summary.append({'animal_id':animal,'first_confirmed_frame':int(first.iloc[0]) if len(first) else None,
            'confirmed_frames':int((group.presence_state=='IN_TANK').sum()),
            'absent_frames':int((group.presence_state=='NOT_IN_TANK').sum()),
            'uncertain_frames':int((group.presence_state=='UNCERTAIN').sum())})
    import pandas as pd
    pd.DataFrame(events).to_csv(out/'presence_events.csv',index=False)
    pd.DataFrame(presence_summary).to_csv(out/'presence_summary.csv',index=False)
    state_lookup={(row.animal_id,int(row.frame)):row for row in presence.itertuples(index=False)}
    print('BEHAVETRACKER_FST_PHASE=indicators',flush=True)
    pose_arrays={};frames=[];quality={};activity_rows=[];box_rows=[]
    for animal,arr in arrays.items():
        x1,y1,x2,y2=rects[animal]
        np.savez_compressed(out/f'{animal}_pose_raw.npz',poses=arr,fps=np.array([fps]),
                            original_rect=np.array(rects[animal]),keypoint_names=np.array(names))
        packed=[]
        with (out/f'{animal}_pose_raw.csv').open('w',newline='') as handle:
            writer=csv.writer(handle)
            writer.writerow(['animal_id','frame','timestamp_sec','keypoint','x_crop_px','y_crop_px','x_original_px','y_original_px','likelihood'])
            for i in range(n_frames):
                frame_points=[]
                for k,name in enumerate(names):
                    x,y,score=arr[i,k]
                    writer.writerow([animal,i,i/fps,name,_finite(x),_finite(y),_finite(x+x1),_finite(y+y1),_finite(score)])
                    frame_points.append([_finite(x+x1),_finite(y+y1),_finite(score) or 0])
                packed.append(frame_points)
        pose_arrays[animal]=packed
        diag=math.hypot(x2-x1,y2-y1)
        previous_fraction=None
        covered=[];insufficient=0;confirmed=0
        cap=cv2.VideoCapture(str(video));box_state={'box':None,'miss':0}
        if not cap.isOpened():raise RuntimeError('Cannot reopen video for FST indicators')
        try:
            for i in range(n_frames):
                ok,frame=cap.read()
                if not ok:raise RuntimeError(f'Cannot read indicator frame {i}')
                p=state_lookup[(animal,i)]
                present=p.presence_state=='IN_TANK'
                if not present:box_state={'box':None,'miss':0}
                valid=(np.isfinite(arr[i,:,:2]).all(axis=1)&np.isfinite(arr[i,:,2])&(arr[i,:,2]>=VALID_SCORE)
                       &(arr[i,:,0]>=0)&(arr[i,:,0]<x2-x1)&(arr[i,:,1]>=0)&(arr[i,:,1]<y2-y1))
                coverage=float(np.mean(valid))
                relative=centroid=None
                if i>0 and present and state_lookup[(animal,i-1)].presence_state=='IN_TANK':
                    prior=(np.isfinite(arr[i-1,:,:2]).all(axis=1)&np.isfinite(arr[i-1,:,2])&(arr[i-1,:,2]>=VALID_SCORE)
                           &(arr[i-1,:,0]>=0)&(arr[i-1,:,0]<x2-x1)&(arr[i-1,:,1]>=0)&(arr[i-1,:,1]<y2-y1))
                    pairs=valid&prior
                    delta=arr[i,pairs,:2]-arr[i-1,pairs,:2]
                    delta=delta[np.linalg.norm(delta,axis=1)<diag*.25]
                    if len(delta)>=MIN_MOTION_POINTS:
                        shift=np.median(delta,axis=0)
                        relative=float(np.median(np.linalg.norm(delta-shift,axis=1))*fps/diag)
                        centroid=float(np.linalg.norm(shift)*fps/diag)
                fraction=float(p.foreground_fraction)
                silhouette=abs(fraction-previous_fraction)*fps if previous_fraction is not None and present else None
                previous_fraction=fraction if present else None
                box=None
                if present:
                    confirmed+=1;covered.append(coverage)
                    local_box,method,support=estimate_body_box(frame,rects[animal],arr[i],box_state,fps)
                    if local_box is not None:
                        bx1,by1,bx2,by2=local_box
                        confidence=float(min(1,max(0,float(p.body_score)*4+support/39*.3)))
                        if method=='HOLD':confidence=min(confidence,.25)
                        box={'x':_finite(bx1+x1),'y':_finite(by1+y1),'width':_finite(bx2-bx1),
                             'height':_finite(by2-by1),'confidence':confidence,'method':method}
                if present and relative is None:insufficient+=1
                frame_row={'frame':i,'timestampSec':i/fps,'animalId':animal,'presence':p.presence_state,
                           'bodyScore':float(p.body_score),'silhouetteChange':silhouette,'bbox':box,
                           'poseCoverage':coverage,'relativeMotion':relative,'centroidMotion':centroid,
                           'classification':'NOT_CLASSIFIED'}
                frames.append(frame_row)
                activity_rows.append([animal,i,i/fps,p.presence_state,coverage,relative,centroid,silhouette,'NOT_CLASSIFIED'])
                box_rows.append([animal,i,i/fps,p.presence_state,*([box[k] for k in ('x','y','width','height','confidence','method')] if box else [None]*6)])
        finally:cap.release()
        quality[animal]={'presenceSec':confirmed/fps,'anatomicalCoverage':float(np.mean(covered)) if covered else 0,
                         'insufficientDataSec':insufficient/fps}
    frames.sort(key=lambda x:(x['frame'],x['animalId']))
    insufficient_intervals={}
    for animal in rects:
        rows=[row for row in frames if row['animalId']==animal]
        intervals=[];start=None
        for row in rows:
            missing=row['presence']=='IN_TANK' and row['relativeMotion'] is None
            if missing and start is None:start=row['timestampSec']
            if not missing and start is not None:
                intervals.append({'startSec':start,'endSec':row['timestampSec']})
                start=None
        if start is not None:intervals.append({'startSec':start,'endSec':rows[-1]['timestampSec']+1/fps})
        insufficient_intervals[animal]=intervals
    with (out/'activity.csv').open('w',newline='') as handle:
        writer=csv.writer(handle);writer.writerow(['animal_id','frame','timestamp_sec','presence','pose_coverage','relative_motion_diag_s','centroid_motion_diag_s','silhouette_change_s','classification']);writer.writerows(activity_rows)
    with (out/'boxes.csv').open('w',newline='') as handle:
        writer=csv.writer(handle);writer.writerow(['animal_id','frame','timestamp_sec','presence','x','y','width','height','confidence','method']);writer.writerows(box_rows)
    shortlist=_review_windows(frames,rects.keys(),fps,out)
    result={'schemaVersion':'fst-result-1','protocol':'forced_swim','engineId':ENGINE,'analysisVersion':VERSION,
            'runId':config['runId'],'video':{'sha256':sha,'originalSha256':config['video']['originalSha256'],'width':width,'height':height,'fps':fps,'frameCount':n_frames,'filename':config['video']['filename'],
                'sourceWidth':config['video'].get('sourceWidth'),'sourceHeight':config['video'].get('sourceHeight'),
                'sourceToUploadScaleX':width/config['video']['sourceWidth'] if config['video'].get('sourceWidth') else None,
                'sourceToUploadScaleY':height/config['video']['sourceHeight'] if config['video'].get('sourceHeight') else None,
                'preparationPolicyVersion':config['video'].get('preparationPolicyVersion')},
            'subjects':config['subjects'],'tanks':config['tanks'],'frames':frames,'keypointNames':names,'poseArrays':pose_arrays,'quality':quality,
            'reviewShortlist':shortlist,'insufficientIntervals':insufficient_intervals}
    (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'),allow_nan=False))
    manifest={'schemaVersion':'fst-manifest-1','protocol':'forced_swim','engineId':ENGINE,'analysisVersion':VERSION,
              'runId':config['runId'],'createdAt':datetime.now(timezone.utc).isoformat(),
              'title':config.get('title'),'group':config.get('group'),'notes':config.get('notes'),'video':result['video'],
              'subjects':config['subjects'],'tanks':config['tanks'],'model':fingerprint_data['model'],
              'deeplabcutVersion':deeplabcut.__version__,'modelFingerprint':fingerprint,
              'inferenceRoiMode':'full_cylinder_fixed','detector':'none','validScore':VALID_SCORE,'drawScore':DRAW_SCORE,
              'presenceAlgorithm':'fst-v6.4-visual-presence-plus-static-start-1','classification':'NOT_CLASSIFIED',
              'checkpointCache':str(cache),'checkpointKey':fingerprint,'finalBatchSize':batch}
    (out/'run_manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    (out/'execution_report.json').write_text(json.dumps({'durationSec':time.monotonic()-started,'quality':quality,'gpu':torch.cuda.get_device_name(0)},indent=2))
    print('BEHAVETRACKER_FST_PHASE=rendering',flush=True)
    _render(video,out,arrays,rects,frames,names,fps,width,height)
    print('BEHAVETRACKER_FST_RESULT_OK',flush=True)


def _render(video,out,arrays,rects,frames,names,fps,width,height):
    look={(f['animalId'],f['frame']):f for f in frames}
    cap=cv2.VideoCapture(str(video))
    path=out/'dlc_labeled.mp4'
    writer=cv2.VideoWriter(str(path),cv2.VideoWriter_fourcc(*'mp4v'),fps,(width,height))
    if not writer.isOpened():raise RuntimeError('Cannot render FST MP4')
    colors=[(90,220,80),(90,180,240)]
    try:
        for i in range(len(next(iter(arrays.values())))):
            ok,frame=cap.read()
            if not ok:raise RuntimeError(f'Cannot render frame {i}')
            for j,(animal,arr) in enumerate(arrays.items()):
                item=look[(animal,i)];color=colors[j]
                if item['presence']=='IN_TANK':
                    box=item['bbox']
                    if box:
                        x,y,w,h=[round(box[k]) for k in ('x','y','width','height')]
                        cv2.rectangle(frame,(x,y),(x+w,y+h),color,2)
                    x1,y1,x2,y2=rects[animal]
                    for x,y,score in arr[i]:
                        if (np.isfinite(x) and np.isfinite(y) and np.isfinite(score) and score>=DRAW_SCORE
                                and 0<=x<x2-x1 and 0<=y<y2-y1):
                            cv2.circle(frame,(round(x+x1),round(y+y1)),3,color,-1)
                x1,y1,_,_=rects[animal]
                cv2.putText(frame,f'{animal}: {item["presence"]}',(x1+5,max(20,y1+22)),cv2.FONT_HERSHEY_SIMPLEX,.6,color,2)
            writer.write(frame)
    finally:cap.release();writer.release()
    if not path.is_file() or path.stat().st_size==0:raise RuntimeError('FST MP4 missing')
    (out/'video_artifact.json').write_text(json.dumps({'available':True,'filename':'dlc_labeled.mp4',
        'source':'behavetracker-fst-v1','sizeBytes':path.stat().st_size,'sha256':_sha(path)}))
