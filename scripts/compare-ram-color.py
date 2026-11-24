"""Compare a completed local RAM v2 job with the supplied frozen v1 diagnostic.

Usage: python3 scripts/compare-ram-color.py --package PACKAGE.zip --run JOB_DIR --output OUT_DIR
No video or human annotations are copied into the repository.
"""
import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import statistics
from zipfile import ZipFile


def iou(a,b):
    inter=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter
    return inter/union if union>0 else 0


def compare(package,run,output):
    report=json.loads((run/'status.json').read_text())
    manifest=json.loads((run/'run_manifest.json').read_text())
    if report['state']!='succeeded': raise ValueError('A completed local job is required')
    if manifest['timing']!='ffprobe_pts': raise ValueError('Verified PTS required')
    with ZipFile(package) as z:
        annotation_bytes=z.read('02_gt_revisada/human_bbox_23_APPROVED.csv')
        annotations=list(csv.DictReader(io.StringIO(annotation_bytes.decode('utf-8-sig'))))
        baseline=list(csv.DictReader(io.StringIO(z.read('02_gt_revisada/23frame_comparison.csv').decode('utf-8-sig'))))
        baseline_report=json.loads(z.read('03_resultados_video/run_report.json'))
    if baseline_report['video_sha256']!=manifest['config']['videoSha256']: raise ValueError('Video hash mismatch')
    if any(a['video_sha256']!=manifest['config']['videoSha256'] or a['approved'].lower()!='true' for a in annotations): raise ValueError('Reference not approved or mismatched')
    samples=[json.loads(line) for line in (run/'samples.jsonl').read_text().splitlines()]
    if len(samples)!=baseline_report['frames'] or any(s['frameIndex']!=i for i,s in enumerate(samples)): raise ValueError('Missing or duplicate frames')
    if any(b['timestampSec']<=a['timestampSec'] for a,b in zip(samples,samples[1:])): raise ValueError('Invalid PTS')
    rows=[]
    for a in annotations:
        index=int(a['frame_index']); s=samples[index]; b=s.get('bbox')
        gt=[float(a[k]) for k in ('gt_x1','gt_y1','gt_x2','gt_y2')]
        candidate=[b['x'],b['y'],b['x']+b['width'],b['y']+b['height']] if b else None
        reference=next(v for v in baseline if int(v['frame_index'])==index)
        rows.append(dict(frameIndex=index,v1IoU=float(reference['ram_iou']),v2IoU=iou(candidate,gt) if candidate else 0,
            v2CenterErrorPx=math.dist(((candidate[0]+candidate[2])/2,(candidate[1]+candidate[3])/2),((gt[0]+gt[2])/2,(gt[1]+gt[3])/2)) if candidate else None,
            observationState=s['observationState'],timestampSec=s['timestampSec']))
    states={state:sum(s['observationState']==state for s in samples) for state in ('observed','uncertain','missing')}
    summary=dict(strictlyDiagnostic=True,independentHoldout=False,videoSha256=manifest['config']['videoSha256'],
        packageSha256=hashlib.file_digest(package.open('rb'),'sha256').hexdigest(),
        annotationsSha256=hashlib.sha256(annotation_bytes).hexdigest(),algorithmVersion=manifest['algorithmVersion'],
        frameCount=len(samples),referenceFrames=len(rows),timing='ffprobe_pts',v1Timing='nominal_frame_over_fps',
        v1=dict(iou50=sum(r['v1IoU']>=.5 for r in rows),meanIoU=statistics.mean(r['v1IoU'] for r in rows),coverageObservedPct=baseline_report['coverage_observed_pct']),
        v2=dict(iou50Candidates=sum(r['v2IoU']>=.5 for r in rows),iou50Accepted=sum(r['v2IoU']>=.5 and r['observationState']=='observed' for r in rows),
            meanIoU=statistics.mean(r['v2IoU'] for r in rows),medianBBoxCenterErrorPx=statistics.median(r['v2CenterErrorPx'] for r in rows if r['v2CenterErrorPx'] is not None),
            states=states,coverageObservedPct=100*states['observed']/len(samples),elapsedSec=report['elapsedSec'],processingFps=report['processingFps']),
        limitations=['Same recording used to choose parameters; no independent validation',
            'Reference includes tail in some frames; v2 body bbox is a different extent',
            'BBox center is not an anatomical body keypoint',
            'Sparse reference does not validate continuity, identity, arm events or food removal'],
        config=manifest['config'])
    output.mkdir(parents=True,exist_ok=True)
    with (output/'comparison.csv').open('w',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps(summary,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--package',type=Path,required=True);p.add_argument('--run',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();compare(a.package,a.run,a.output)
