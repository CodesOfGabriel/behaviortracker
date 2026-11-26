"""Compare B (visual), C (visual + TCN), D (visual + geometry/motion + TCN)."""
import argparse
import json
from pathlib import Path
import random
import numpy as np
from common import load_dataset, target, write_json, dataset_provenance
from behavior.contracts import FEATURES, vector
from behavior.normalization import fit_training
from behavior.temporal_windows import windows


def train(dataset,output,architecture='hybrid_tcn',epochs=20,seed=42,device='cpu'):
    import cv2 as cv
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, Dataset
    from networks import VisualEncoder, RearingTCN
    torch.manual_seed(seed);np.random.seed(seed);random.seed(seed)
    root,rows=load_dataset(dataset)
    train_rows=[r for r in rows if r['split']=='train' and target(r)[1][0]]
    if {target(r)[0][0] for r in train_rows}!={0.,1.}:
        raise ValueError('Both human rearing and hard-negative labels are required')
    if not any(r['split']=='validation' and target(r)[1][0] for r in rows):
        raise ValueError('Human validation annotations are required')
    subtype={r['label'] for r in train_rows if target(r)[1][1]}=={'REARING_SUPPORTED','REARING_UNSUPPORTED'}
    norm=fit_training([r['values'] for r in train_rows])
    encoder=VisualEncoder().to(device);head=nn.Linear(128,2).to(device)
    mean=torch.tensor([.485,.456,.406])[:,None,None];std=torch.tensor([.229,.224,.225])[:,None,None]
    class Crops(Dataset):
        def __init__(self,items,augment=False):self.items=items;self.augment=augment
        def __len__(self):return len(self.items)
        def __getitem__(self,index):
            row=self.items[index]
            image=cv.imread(str(root/row['cropPath'])) if row.get('cropPath') else None
            if image is None:raise ValueError('Missing crop')
            image=cv.cvtColor(image,cv.COLOR_BGR2RGB).copy()
            if self.augment:
                # Visual pretraining only: temporal sequences are never independently rotated.
                image=np.rot90(image,random.randrange(4)).copy()
                if random.random()<.5:image=image[:,::-1].copy()
                image=np.clip(image.astype(np.float32)*random.uniform(.85,1.15),0,255).astype(np.uint8)
            values,masks=target(row)
            return (torch.from_numpy(image).permute(2,0,1).float()/255.-mean)/std,torch.tensor(values),torch.tensor(masks)
    def loss_fn(logits,y,mask):
        if not subtype:mask=mask.clone();mask[:,1]=0
        return (nn.functional.binary_cross_entropy_with_logits(logits,y,reduction='none')*mask).sum()/mask.sum().clamp_min(1)
    val_rows=[r for r in rows if r['split']=='validation' and target(r)[1][0]]
    optimizer=torch.optim.AdamW(list(encoder.parameters())+list(head.parameters()),lr=1e-4)
    train_loader=DataLoader(Crops(train_rows,True),batch_size=16,shuffle=True,num_workers=0)
    val_loader=DataLoader(Crops(val_rows),batch_size=32,num_workers=0)
    best,best_state=float('inf'),None
    for epoch in range(epochs):
        encoder.train();head.train()
        for x,y,mask in train_loader:
            optimizer.zero_grad();loss=loss_fn(head(encoder(x.to(device))),y.to(device),mask.to(device));loss.backward();optimizer.step()
        encoder.eval();head.eval();losses=[]
        with torch.no_grad():
            for x,y,mask in val_loader:losses.append(float(loss_fn(head(encoder(x.to(device))),y.to(device),mask.to(device))))
        score=float(np.mean(losses));print(json.dumps({'phase':'visual','epoch':epoch+1,'validationLoss':score}),flush=True)
        if score<best:
            best=score;best_state=({k:v.cpu().clone() for k,v in encoder.state_dict().items()},{k:v.cpu().clone() for k,v in head.state_dict().items()})
    encoder.load_state_dict(best_state[0]);head.load_state_dict(best_state[1]);encoder.eval()
    output=Path(output);output.mkdir(parents=True,exist_ok=False)
    torch.save(best_state[0],output/'encoder.pt')
    if architecture=='visual':
        classifier=head;dim=128
    else:
        # Cache each frame's embedding once. Context includes unlabeled/uncertain frames,
        # while the supervised loss is masked independently for each head.
        embeddings=np.zeros((len(rows),128),np.float32)
        usable=[i for i,r in enumerate(rows) if r.get('cropPath')]
        with torch.no_grad():
            loader=DataLoader(Crops([rows[i] for i in usable]),batch_size=32,num_workers=0)
            cursor=0
            for x,_,_ in loader:
                values=encoder(x.to(device)).cpu().numpy();embeddings[usable[cursor:cursor+len(values)]]=values;cursor+=len(values)
        np.save(output/'training_embeddings.npy',embeddings)
        matrices=[];targets=[];masks=[];partitions=[]
        for vid in dict.fromkeys(r['videoId'] for r in rows):
            indices=[i for i,r in enumerate(rows) if r['videoId']==vid]
            features=np.asarray([vector(rows[i]['values'],norm) for i in indices],np.float32)
            matrix=embeddings[indices]
            if architecture=='hybrid_tcn':matrix=np.concatenate((matrix,features),1)
            for start,batch in windows(matrix,[rows[i]['observation']=='OBSERVED' for i in indices]):
                for j,value in enumerate(batch):
                    i=indices[start+j];y,mask=target(rows[i])
                    matrices.append(value);targets.append(y);masks.append(mask);partitions.append(rows[i]['split'])
        tensors=torch.tensor(np.asarray(matrices)),torch.tensor(targets),torch.tensor(masks)
        dim=tensors[0].shape[1];classifier=RearingTCN(dim).to(device)
        optimizer=torch.optim.AdamW(classifier.parameters(),lr=1e-3)
        indices={split:[i for i,p in enumerate(partitions) if p==split and masks[i][0]] for split in ('train','validation')}
        best,best_state=float('inf'),None
        for epoch in range(epochs):
            classifier.train();random.shuffle(indices['train'])
            for start in range(0,len(indices['train']),32):
                batch=indices['train'][start:start+32];x,y,mask=[t[batch].to(device) for t in tensors]
                optimizer.zero_grad();loss=loss_fn(classifier(x),y,mask);loss.backward();optimizer.step()
            classifier.eval();losses=[]
            with torch.no_grad():
                for start in range(0,len(indices['validation']),32):
                    batch=indices['validation'][start:start+32];x,y,mask=[t[batch].to(device) for t in tensors];losses.append(float(loss_fn(classifier(x),y,mask)))
            score=float(np.mean(losses));print(json.dumps({'phase':'temporal','epoch':epoch+1,'validationLoss':score}),flush=True)
            if score<best:best=score;best_state={k:v.cpu().clone() for k,v in classifier.state_dict().items()}
        classifier.load_state_dict(best_state)
    torch.save({k:v.cpu() for k,v in classifier.state_dict().items()},output/'classifier.pt')
    write_json(output/'normalization.json',norm)
    write_json(output/'training.json',dict(architecture=architecture,featureDim=dim,sampleRateHz=json.loads((root/'dataset_manifest.json').read_text())['sampleRateHz'],
        seed=seed,epochs=epochs,subtypeTrained=subtype,sourceDataset=str(root.resolve()),validationLoss=best,datasetProvenance=dataset_provenance(root,rows)))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('dataset');p.add_argument('output');p.add_argument('--architecture',choices=['visual','visual_tcn','hybrid_tcn'],default='hybrid_tcn');p.add_argument('--epochs',type=int,default=20);p.add_argument('--seed',type=int,default=42);p.add_argument('--device',default='cpu');a=p.parse_args()
    if a.epochs<1:raise ValueError('At least one epoch is required')
    train(a.dataset,a.output,a.architecture,a.epochs,a.seed,a.device)
