"""Build crops/features from human intervals, grouped by animal/session/video hash."""
import argparse
import csv
import json
import math
from pathlib import Path
import random
import shutil
import tempfile
from common import write_json
from behavior.contracts import POSTURES, SCHEMA, FEATURES
from behavior.open_field import extract, sha256


def split_videos(videos, seed=42):
    # Connected components also keep repeat sessions and duplicate videos together.
    parents = list(range(len(videos)))
    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    for i, a in enumerate(videos):
        for j in range(i):
            if any(a[k] == videos[j][k] for k in ('animal_id', 'session_id', 'sha256')):
                parents[find(i)] = find(j)
    groups = sorted({find(i) for i in range(len(videos))})
    if len(groups) < 3:
        raise ValueError('At least three independent animal/session/video groups are required for train/validation/test')
    random.Random(seed).shuffle(groups)
    ntest, nval = max(1, round(len(groups)*.2)), max(1, round(len(groups)*.2))
    assignments = {group: 'test' if i < ntest else 'validation' if i < ntest+nval else 'train' for i,group in enumerate(groups)}
    return {v['video_id']: assignments[find(i)] for i,v in enumerate(videos)}


def read_intervals(path):
    grouped = {}
    with Path(path).open(newline='', encoding='utf-8-sig') as source:
        for row in csv.DictReader(source):
            start, end = float(row['start_sec']), float(row['end_sec'])
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or row['label'] not in POSTURES or not row['annotator_id'].strip():
                raise ValueError('Invalid human interval')
            row.update(start=start, end=end)
            grouped.setdefault(row['video_id'], []).append(row)
    for intervals in grouped.values():
        intervals.sort(key=lambda r: r['start'])
        if any(b['start'] < a['end'] for a,b in zip(intervals,intervals[1:])):
            raise ValueError('Overlapping human intervals require adjudication before training')
    return grouped


def build(dataset_root, output, ffmpeg, ffprobe, seed=42, rate=15):
    root, output = Path(dataset_root), Path(output)
    with (root/'annotations/videos.csv').open(newline='', encoding='utf-8-sig') as source:
        videos = list(csv.DictReader(source))
    if len({v['video_id'] for v in videos}) != len(videos):
        raise ValueError('Duplicate video IDs')
    for v in videos:
        if any(not v.get(k,'').strip() for k in ('video_id','animal_id','session_id','arena_id','sha256')):
            raise ValueError('Video provenance is incomplete')
        if Path(v['video_id']).name != v['video_id'] or any(c in v['video_id'] for c in '/\\'):
            raise ValueError('Unsafe video ID')
    assignments = split_videos(videos, seed)
    annotations = read_intervals(root/'annotations/intervals.csv')
    if output.exists():
        raise ValueError('Use a new output directory to preserve dataset snapshots')
    output.parent.mkdir(parents=True,exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='oft-dataset-', dir=output.parent))
    try:
        with (work/'dataset.jsonl').open('w') as stream:
            reports = {}
            for video in videos:
                vid = video['video_id']
                tracking = root/'tracking'/vid
                request = json.loads((tracking/'request.json').read_text())
                filename = video.get('filename') or f'{vid}.mp4'
                if Path(filename).name != filename or '/' in filename or '\\' in filename:
                    raise ValueError('Video filename must stay inside videos/')
                path = root/'videos'/filename
                if sha256(path) != video['sha256']:
                    raise ValueError(f'Video SHA-256 mismatch: {vid}')
                for annotation in annotations.get(vid, []):
                    if annotation.get('video_sha256') and annotation['video_sha256'] != video['sha256']:
                        raise ValueError('Annotation refers to a different video')
                request.update(video=str(path), videoSha256=video['sha256'],samples=str(tracking/'samples.jsonl'), ffmpeg=ffmpeg, ffprobe=ffprobe, sampleRateHz=rate)
                rows, _, report = extract(request, work/vid, save_crops=True)
                if any(a['end'] > report['durationSec']+.002 for a in annotations.get(vid, [])):
                    raise ValueError('Annotation exceeds video support')
                for row in rows:
                    labels = [a for a in annotations.get(vid, []) if a['start'] <= row['timestampSec'] and a['end'] >= row['endSec']]
                    annotation = labels[0] if labels else None
                    row.update(label=annotation['label'] if annotation else 'UNKNOWN', annotatorId=annotation['annotator_id'] if annotation else None,
                        videoId=vid,animalId=video['animal_id'],sessionId=video['session_id'],arenaId=video['arena_id'],condition=video.get('condition','unspecified'),
                        videoSha256=video['sha256'],split=assignments[vid])
                    if row.get('cropPath'):
                        row['cropPath'] = f"{vid}/{row['cropPath']}"
                    stream.write(json.dumps(row, allow_nan=False)+'\n')
                reports[vid] = report
        write_json(work/'splits.json',dict(seed=seed,policy='connected_animal_session_sha256',videos=assignments))
        write_json(work/'dataset_manifest.json',dict(schemaVersion=1,featureSchema=SCHEMA,features=list(FEATURES),sampleRateHz=rate,
            annotationsSha256=sha256(root/'annotations/intervals.csv'),videosSha256=sha256(root/'annotations/videos.csv'),videos=videos,reports=reports))
        shutil.copy(root/'annotations/intervals.csv',work/'human_intervals.csv')
        work.rename(output)
    except BaseException:
        shutil.rmtree(work,ignore_errors=True)
        raise


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root');parser.add_argument('output');parser.add_argument('--ffmpeg',default='ffmpeg');parser.add_argument('--ffprobe',default='ffprobe');parser.add_argument('--seed',type=int,default=42);parser.add_argument('--rate',type=int,choices=[10,15,30],default=15)
    args=parser.parse_args();build(args.root,args.output,args.ffmpeg,args.ffprobe,args.seed,args.rate)
