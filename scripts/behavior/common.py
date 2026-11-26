"""Training-only helpers; never bundled as local inference dependencies."""
import json
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'src-tauri/python'))
from behavior.contracts import FEATURES, POSTURES, vector


def load_dataset(path):
    path = Path(path)
    rows = [json.loads(line) for line in (path/'dataset.jsonl').read_text().splitlines()]
    if not rows:
        raise ValueError('Dataset is empty')
    for key in ('animalId', 'sessionId', 'videoSha256'):
        sets = {split: {r[key] for r in rows if r['split'] == split} for split in ('train', 'validation', 'test')}
        if any(sets[a] & sets[b] for a, b in (('train','test'),('train','validation'),('test','validation'))):
            raise ValueError(f'Data leakage across partitions: {key}')
    return path, rows


def target(row):
    label = row['label']
    known = label != 'UNKNOWN' and row['observation'] == 'OBSERVED' and row.get('cropUsable', False)
    rearing = label.startswith('REARING_')
    subtype_known = known and label in ('REARING_SUPPORTED', 'REARING_UNSUPPORTED')
    return [float(rearing), float(label == 'REARING_SUPPORTED')], [float(known), float(subtype_known)]


def dataset_provenance(root, rows):
    hashes = {}
    for filename in ('dataset.jsonl', 'dataset_manifest.json', 'splits.json', 'human_intervals.csv'):
        path = Path(root)/filename
        if path.is_file():
            digest=hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
            hashes[filename]=digest.hexdigest()
    return dict(filesSha256=hashes, conditions=sorted({r.get('condition','unspecified') for r in rows if r['split']=='train'}),
                arenaIds=sorted({r.get('arenaId','unspecified') for r in rows if r['split']=='train'}),
                partitions={split:dict(animals=len({r['animalId'] for r in rows if r['split']==split}),
                    sessions=len({r['sessionId'] for r in rows if r['split']==split}),
                    animalIds=sorted({r['animalId'] for r in rows if r['split']==split}),
                    sessionIds=sorted({r['sessionId'] for r in rows if r['split']==split}),
                    videoSha256=sorted({r['videoSha256'] for r in rows if r['split']==split})) for split in ('train','validation','test')})


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False)+'\n')
