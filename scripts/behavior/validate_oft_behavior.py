"""Independent session evaluation with one-to-one temporal-IoU event matching."""
import argparse
import csv
import json
import subprocess
from pathlib import Path
import numpy as np
from common import load_dataset, write_json
from behavior.event_decoder import decode
from behavior.onnx_inference import Inference
from behavior.metrics import calculate
from behavior.open_field import sha256


def event_metrics(predicted, truth, threshold=.5):
    from scipy.optimize import linear_sum_assignment
    overlaps=np.zeros((len(truth),len(predicted)))
    for i,a in enumerate(truth):
        for j,b in enumerate(predicted):
            intersection=max(0.,min(a['endSec'],b['endSec'])-max(a['startSec'],b['startSec']))
            union=max(a['endSec'],b['endSec'])-min(a['startSec'],b['startSec'])
            overlaps[i,j]=intersection/union if union else 0.
    # Maximize valid match count first, then temporal IoU. No event can match twice.
    pairs=[]
    if overlaps.size:
        cardinality_weight=min(overlaps.shape)+1
        indices=linear_sum_assignment(-(overlaps>=threshold).astype(float)*cardinality_weight-overlaps)
        pairs=[(int(i),int(j)) for i,j in zip(*indices) if overlaps[i,j]>=threshold]
    tp=len(pairs);fp=len(predicted)-tp;fn=len(truth)-tp
    precision=tp/(tp+fp) if tp+fp else None;recall=tp/(tp+fn) if tp+fn else None
    f1=2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None
    return dict(tp=tp,fp=fp,fn=fn,precision=precision,recall=recall,f1=f1,
        onsetMedianAbsoluteErrorSec=float(np.median([abs(truth[i]['startSec']-predicted[j]['startSec']) for i,j in pairs])) if pairs else None,
        offsetMedianAbsoluteErrorSec=float(np.median([abs(truth[i]['endSec']-predicted[j]['endSec']) for i,j in pairs])) if pairs else None,
        countRelativeError=abs(len(predicted)-len(truth))/len(truth) if truth else 0. if not predicted else None,
        matchedPairs=[dict(truth=i,predicted=j,temporalIoU=float(overlaps[i,j])) for i,j in pairs])


def development_targets(frame, event, duration_error, coverage_pct, exhaustive, truth_count):
    """Negative sessions must reject false positives; positive-only metrics remain N/A."""
    if not exhaustive or coverage_pct is None or coverage_pct < 95:
        return False
    if truth_count == 0:
        return event['tp']==0 and event['fp']==0 and frame['fp']==0 and duration_error==0
    values=[frame['precision'],frame['recall'],frame['f1'],event['f1'],event['onsetMedianAbsoluteErrorSec'],
            event['offsetMedianAbsoluteErrorSec'],event['countRelativeError'],duration_error]
    return all(value is not None for value in values) and all(value>=.9 for value in values[:4]) and all(value<=.15 for value in values[4:6]) and all(value<=.1 for value in values[6:])


def independent_evaluation(manifest, rows):
    trained=manifest.get('training',{}).get('datasetProvenance',{}).get('partitions',{}).get('train',{})
    for key,field in (('animalId','animalIds'),('sessionId','sessionIds'),('videoSha256','videoSha256')):
        if not trained.get(field):
            return False
        if set(trained[field]) & {row[key] for row in rows}:
            raise ValueError(f'Evaluation overlaps the model training partition: {key}')
    return True


def render_error_clips(errors, dataset_manifest, video_directory, output, ffmpeg='ffmpeg', limit=30):
    """Qualitative error review; clips never become replacement human ground truth."""
    if limit < 0:
        raise ValueError('Error clip limit cannot be negative')
    output=Path(output);output.mkdir(parents=True,exist_ok=False)
    metadata={video['video_id']:video for video in dataset_manifest['videos']}
    checked=set();clips=[]
    for index,error in enumerate(errors[:limit]):
        video=metadata[error['videoId']]
        name=video.get('filename') or video['video_id']+'.mp4'
        if Path(name).name!=name or '/' in name or '\\' in name:
            raise ValueError('Video filename must stay inside the supplied video directory')
        source=Path(video_directory)/name
        if error['videoId'] not in checked:
            if sha256(source)!=video['sha256']:
                raise ValueError('Original-video hash differs from the evaluation dataset')
            checked.add(error['videoId'])
        start=max(0.,error['startSec']-1.)
        end=min(dataset_manifest['reports'][error['videoId']]['durationSec'],error['endSec']+1.)
        filename=f"error_{index+1:04d}_{error['errorType']}.mp4"
        subprocess.run([ffmpeg,'-nostdin','-v','error','-ss',str(start),'-i',str(source),'-t',str(end-start),
            '-map','0:v:0','-an','-c:v','libx264','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(output/filename)],check=True)
        clips.append(dict(file=filename,videoSha256=video['sha256'],sourceStartSec=start,sourceEndSec=end,error=error))
    write_json(output/'error_clips.json',dict(schemaVersion=1,clips=clips,totalErrorIntervals=len(errors),
        limit=limit,purpose='qualitative_error_review_not_ground_truth'))
    return clips


def evaluate(dataset, model, output, split='test', source_videos=None, error_clip_limit=30, ffmpeg='ffmpeg'):
    import cv2 as cv
    root,all_rows=load_dataset(dataset)
    rows=[r for r in all_rows if r['split']==split]
    if not rows:raise ValueError('No independent evaluation sessions in requested partition')
    inference=Inference(model)
    independence=independent_evaluation(inference.manifest,rows)
    dataset_manifest=json.loads((root/'dataset_manifest.json').read_text())
    if inference.manifest['sampleRateHz']!=dataset_manifest['sampleRateHz']:raise ValueError('Sampling mismatch')
    with (root/'human_intervals.csv').open(newline='') as stream:human=list(csv.DictReader(stream))
    reports={};errors=[]
    for vid in dict.fromkeys(r['videoId'] for r in rows):
        session=[r for r in rows if r['videoId']==vid]
        embeddings=np.zeros((len(session),128 if inference.encoder else 0),np.float32)
        valid=[i for i,r in enumerate(session) if r.get('cropPath')]
        for start in range(0,len(valid),16):
            indices=valid[start:start+16]
            crops=[]
            for i in indices:
                image=cv.imread(str(root/session[i]['cropPath']))
                if image is None:raise ValueError('Missing validation crop')
                crops.append(cv.cvtColor(image,cv.COLOR_BGR2RGB))
            embeddings[indices]=inference.encode(crops)
        scores=inference.classify(session,embeddings,[r['observation']=='OBSERVED' for r in session])
        predictions=[]
        for row,score in zip(session,scores):
            predictions.append(dict(timestampSec=row['timestampSec'],endSec=row['endSec'],observation=row['observation'],
                pRearing=float(score[0]) if row['observation']=='OBSERVED' else None,
                pSupportedGivenRearing=float(score[1]) if inference.manifest.get('subtypeTrained') else None,
                classification='NON_REARING' if row['observation']=='OBSERVED' else 'UNKNOWN'))
        events=decode(predictions,inference.decoder)
        for p in predictions:
            event=next((e for e in events if any(a<=p['timestampSec']<b for a,b in e['observedIntervals'])),None)
            p['classification']=event['behavior'] if event else 'NON_REARING' if p['observation']=='OBSERVED' and p['pRearing']<inference.decoder['offsetThreshold'] else 'UNKNOWN'
        truth=[dict(startSec=float(a['start_sec']),endSec=float(a['end_sec']),behavior=a['label']) for a in human if a['video_id']==vid and a['label'].startswith('REARING_')]
        em=event_metrics(events,truth)
        support=np.asarray([r['endSec']-r['timestampSec'] for r in session])
        known=np.array([r['label']!='UNKNOWN' for r in session]);classified=np.array([p['classification']!='UNKNOWN' for p in predictions]);positive=np.array([r['label'].startswith('REARING_') for r in session]);detected=np.array([p['classification'].startswith('REARING_') for p in predictions])
        tp=int((known&classified&positive&detected).sum());fp=int((known&classified&~positive&detected).sum());fn=int((known&positive&~detected).sum())
        frame=dict(tp=tp,fp=fp,fn=fn,precision=tp/(tp+fp) if tp+fp else None,recall=tp/(tp+fn) if tp+fn else None,f1=2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None)
        duration=dataset_manifest['reports'][vid]['durationSec']
        metrics=calculate(predictions,events,duration)
        true_duration=sum(a['endSec']-a['startSec'] for a in truth)
        error=abs(sum(e['durationSec'] for e in events)-true_duration)/true_duration if true_duration else 0. if not events else None
        intervals=sorted((float(a['start_sec']),float(a['end_sec'])) for a in human if a['video_id']==vid and a['label']!='UNKNOWN')
        exhaustive=bool(intervals) and intervals[0][0]<=.002 and intervals[-1][1]>=duration-.002 and all(b[0]<=a[1]+.002 for a,b in zip(intervals,intervals[1:]))
        passes=independence and development_targets(frame,em,error,metrics['coveragePct'],exhaustive,len(truth))
        reports[vid]=dict(animalId=session[0]['animalId'],sessionId=session[0]['sessionId'],condition=session[0]['condition'],arenaId=session[0]['arenaId'],
            humanExhaustivelyReviewed=exhaustive,labeledSupportSec=float(support[known].sum()),frame=frame,event=em,durationRelativeError=error,
            coveragePct=metrics['coveragePct'],meetsDevelopmentTargets=passes,truthEventCount=len(truth),
            notApplicableMetrics=['rearing_recall','rearing_f1','onset_error','offset_error'] if not truth else [],
            subtypes={label:event_metrics([e for e in events if e['behavior']==label],[e for e in truth if e['behavior']==label]) for label in ('REARING_SUPPORTED','REARING_UNSUPPORTED','REARING_UNSPECIFIED')})
        pairs=em['matchedPairs'];matched_pred={pair['predicted'] for pair in pairs};matched_truth={pair['truth'] for pair in pairs}
        errors.extend(dict(videoId=vid,errorType='false_positive',**event) for i,event in enumerate(events) if i not in matched_pred)
        errors.extend(dict(videoId=vid,errorType='false_negative',**event) for i,event in enumerate(truth) if i not in matched_truth)
    output=Path(output);output.mkdir(parents=True,exist_ok=False)
    positive_sessions=sum(r['truthEventCount']>0 for r in reports.values())
    report=dict(schemaVersion=1,split=split,temporalIoUThreshold=.5,matching='one_to_one_maximum_valid_matches',sessions=reports,
        trainingIndependenceVerified=independence,positiveSessionCount=positive_sessions,
        allSessionsMeetDevelopmentTargets=positive_sessions>0 and all(r['meetsDevelopmentTargets'] for r in reports.values()),
        limitation='Development-target screening is not a claim of scientific validity; independent human agreement and experimental coverage must also be assessed.')
    write_json(output/'validation_report.json',report);write_json(output/'error_intervals.json',errors)
    if source_videos is not None:
        render_error_clips(errors,dataset_manifest,source_videos,output/'error_clips',ffmpeg,error_clip_limit)
    print(json.dumps({'sessions':len(reports),'allSessionsMeetDevelopmentTargets':report['allSessionsMeetDevelopmentTargets']}))
    return report


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('dataset');p.add_argument('model');p.add_argument('output');p.add_argument('--split',choices=['validation','test'],default='test')
    p.add_argument('--source-videos',help='Optional original-video directory for qualitative FP/FN clips');p.add_argument('--error-clip-limit',type=int,default=30);p.add_argument('--ffmpeg',default='ffmpeg')
    a=p.parse_args();evaluate(a.dataset,a.model,a.output,a.split,a.source_videos,a.error_clip_limit,a.ffmpeg)
