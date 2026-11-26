"""Model A: supervised Random Forest, using only the training partition."""
import argparse
from pathlib import Path
import numpy as np
from common import load_dataset, target, write_json, dataset_provenance
from behavior.contracts import vector
from behavior.normalization import fit_training


def train(dataset, output, seed=42):
    import joblib
    from sklearn.ensemble import RandomForestClassifier
    root, rows = load_dataset(dataset)
    train_rows = [r for r in rows if r['split']=='train' and target(r)[1][0]]
    if {r['label'].startswith('REARING_') for r in train_rows}!={False,True}:
        raise ValueError('Human rearing and hard-negative labels are required in train')
    normalization=fit_training([r['values'] for r in train_rows])
    x=np.asarray([vector(r['values'],normalization) for r in train_rows],np.float32)
    y=np.asarray([target(r)[0][0] for r in train_rows],np.int64)
    classifier=RandomForestClassifier(n_estimators=200,min_samples_leaf=3,max_depth=14,class_weight='balanced',random_state=seed,n_jobs=2).fit(x,y)
    sub_rows=[r for r in train_rows if target(r)[1][1]]
    subtype=None
    if {r['label'] for r in sub_rows}=={'REARING_SUPPORTED','REARING_UNSUPPORTED'}:
        subtype=RandomForestClassifier(n_estimators=150,min_samples_leaf=3,max_depth=12,class_weight='balanced',random_state=seed,n_jobs=2).fit(
            np.asarray([vector(r['values'],normalization) for r in sub_rows],np.float32),np.asarray([r['label']=='REARING_SUPPORTED' for r in sub_rows],np.int64))
    output=Path(output);output.mkdir(parents=True,exist_ok=False)
    joblib.dump(dict(rearing=classifier,subtype=subtype),output/'baseline.joblib')
    write_json(output/'normalization.json',normalization)
    write_json(output/'training.json',dict(architecture='random_forest',seed=seed,sampleRateHz=__import__('json').loads((root/'dataset_manifest.json').read_text())['sampleRateHz'],subtypeTrained=subtype is not None,sourceDataset=str(root.resolve()),trainSamples=len(train_rows),datasetProvenance=dataset_provenance(root,rows)))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('dataset');p.add_argument('output');p.add_argument('--seed',type=int,default=42);a=p.parse_args();train(a.dataset,a.output,a.seed)
