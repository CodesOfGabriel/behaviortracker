"""Display estimates only. Never replaces observed poses or metric eligibility."""
import heapq
import math
import cv2 as cv
import numpy as np

VERSION = "image_flow_and_mask_v1"


def initial_direction(video,rows,size,cancelled=lambda:False):
    """Use the first supported direction backwards for an unresolved prefix.

    Every filled point remains an estimate and records its future anchor. No
    anatomical identity is invented when the entire recording has no anchor.
    """
    anchor=next((i for i,row in enumerate(rows) if (row.get("oftLayers",{}).get("visualization") or {}).get("head")),None)
    if not anchor:return 0
    from layer_video import capture
    cap=capture(video);tracker=VisualContinuity(*size)
    changed=0;origin=rows[anchor]["timestampSec"]
    try:
        for i in range(anchor,-1,-1):
            if cancelled():raise InterruptedError("Visualização cancelada")
            if not cap.set(cv.CAP_PROP_POS_FRAMES,i):raise ValueError("Quadro de referência visual indisponível")
            ok,frame=cap.read()
            if not ok:raise ValueError("Vídeo interrompido ao preencher a orientação inicial")
            frame=cv.resize(frame,(640,round(frame.shape[0]*640/frame.shape[1]))) if frame.shape[1]>640 else frame
            row=rows[i];sample={**row,"timestampSec":origin-row["timestampSec"]}
            if i==anchor:
                v=row["oftLayers"]["visualization"]
                orientation=dict(state="estimated",source="tail_silhouette",head=v["head"],tailBase=v["tailBase"])
                tracker.update(frame,sample,orientation)
                continue
            visual=tracker.update(frame,sample,dict(state="ambiguous"))
            if visual["head"]:
                visual.update(orientationSource="future_direction",directionAnchorFrameIndex=anchor)
                row["oftLayers"]["visualization"]=visual;changed+=1
    finally:cap.release()
    return changed


def points(values):
    return [dict(x=float(x), y=float(y)) for x, y in values]


def curve(contour, direction=None):
    """Infer a center path through current foreground, including curved bodies."""
    if not contour or len(contour)<3:return None
    polygon=np.array([[p["x"],p["y"]] for p in contour],float)
    origin=polygon.min(0);extent=np.ptp(polygon,axis=0)
    if not np.isfinite(polygon).all() or min(extent)<3:return None
    scale=min(1.,92/max(extent));size=np.ceil(extent*scale).astype(int)+3
    mask=np.zeros((size[1],size[0]),np.uint8)
    cv.fillPoly(mask,[np.rint((polygon-origin)*scale+1).astype(np.int32)],255)
    distance=cv.distanceTransform(mask,cv.DIST_L2,3)
    yy,xx=np.nonzero(distance>=max(1.,distance.max()*.2))
    if len(xx)<9:return None
    pixels=np.column_stack([xx,yy])
    if direction is None or np.linalg.norm(direction)<1:
        _,vectors=np.linalg.eigh(np.cov(pixels.T));direction=vectors[:,-1]
    direction=np.asarray(direction)/np.linalg.norm(direction)
    projection=pixels@direction
    ends=[]
    for fraction in [.08,.92]:
        target=np.quantile(projection,fraction)
        selection=np.flatnonzero(np.abs(projection-target)<=max(1.,np.ptp(projection)*.04))
        ends.append(tuple(pixels[selection[np.argmax(distance[yy[selection],xx[selection]])]]))
    start,end=ends
    costs={start:0.};parents={};queue=[(0.,start)]
    while queue:
        cost,node=heapq.heappop(queue)
        if cost!=costs[node]:continue
        if node==end:break
        x,y=node
        for dx,dy in [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]:
            nx,ny=x+dx,y+dy
            if not 0<=ny<mask.shape[0] or not 0<=nx<mask.shape[1] or not mask[ny,nx]:continue
            step=math.hypot(dx,dy)*(1+3/max(.5,float(distance[ny,nx])))
            candidate=cost+step
            if candidate<costs.get((nx,ny),math.inf):
                costs[(nx,ny)]=candidate;parents[(nx,ny)]=node;heapq.heappush(queue,(candidate,(nx,ny)))
    if end not in costs:return None
    path=[end]
    while path[-1]!=start:path.append(parents[path[-1]])
    path=np.asarray(path[::-1],float)
    if len(path)<3:return None
    lengths=np.r_[0,np.cumsum(np.linalg.norm(np.diff(path,axis=0),axis=1))]
    path=np.column_stack([np.interp(np.linspace(0,lengths[-1],7),lengths,path[:,i]) for i in [0,1]])
    return (path-1)/scale+origin


class VisualContinuity:
    def __init__(self,width,height):
        self.size=np.array([width,height],float)
        self.gray=None;self.features=None;self.last=None;self.stopped=False
        self.opposed=None
        self.evidence={"flowMatrix":None}

    def update(self,frame,sample,orientation):
        time=float(sample["timestampSec"])
        self.evidence={"flowMatrix":None}
        result=dict(version=VERSION,state="unavailable",source=None,points=[],head=None,tailBase=None,
            box=None,orientationSource="unknown",ageSec=None,supportScore=0.,metricEligible=False)
        reason=sample.get("reason","")
        self.stopped |= reason=="researcher_intervention"
        if self.stopped or reason=="researcher_intervention_pending":
            self.gray=None;self.features=None;self.last=None
            self.opposed=None
            return {**result,"state":"stopped" if self.stopped else "suspended"}
        scale=min(1.,640/frame.shape[1]);gray=cv.cvtColor(cv.resize(frame,None,fx=scale,fy=scale),cv.COLOR_BGR2GRAY)
        factor=np.array([gray.shape[1],gray.shape[0]])/self.size
        previous=self.last if self.last and 0<time-self.last["time"]<=.25 else None
        transform=None
        if previous and self.gray is not None and self.features is not None and len(self.features)>=4:
            boxes=[b for b in [previous["box"],sample.get("bbox")] if b]
            if boxes:
                pad=max(max(b["width"],b["height"]) for b in boxes)*.65
                low=np.floor((np.array([min(b["x"] for b in boxes),min(b["y"] for b in boxes)])-pad)*factor).astype(int)
                high=np.ceil((np.array([max(b["x"]+b["width"] for b in boxes),max(b["y"]+b["height"] for b in boxes)])+pad)*factor).astype(int)
                low=np.maximum(0,low);high=np.minimum([gray.shape[1],gray.shape[0]],high)
            else:low=np.array([0,0]);high=np.array([gray.shape[1],gray.shape[0]])
            left,top=low;right,bottom=high
            old=self.gray[top:bottom,left:right];new=gray[top:bottom,left:right]
            features=self.features-low.astype(np.float32)
            tracked,ok,_=cv.calcOpticalFlowPyrLK(old,new,features,None,winSize=(21,21),maxLevel=3) if min(old.shape)>=8 and old.shape==new.shape else (None,None,None)
            if tracked is not None:
                backward,back_ok,_=cv.calcOpticalFlowPyrLK(new,old,tracked,None,winSize=(21,21),maxLevel=3)
                if backward is not None:
                    valid=(ok.ravel()>0)&(back_ok.ravel()>0)&(np.linalg.norm((backward-features).reshape(-1,2),axis=1)<=1.5)
                    if np.count_nonzero(valid)>=4:
                        tracked=tracked+low.astype(np.float32)
                        matrix,inliers=cv.estimateAffinePartial2D(self.features[valid],tracked[valid],method=cv.RANSAC,ransacReprojThreshold=2.)
                        if matrix is not None and inliers is not None and np.count_nonzero(inliers)>=4:
                            stretch=np.linalg.norm(matrix[0,:2]);shift=np.median(np.linalg.norm((tracked[valid]-self.features[valid]).reshape(-1,2),axis=1))
                            if .85<=stretch<=1.18 and shift<=max(gray.shape)*.15:
                                transform=matrix
        if transform is not None:
            original=transform.copy()
            original[:,:2]=transform[:,:2]*factor[None,:]/factor[:,None]
            original[:,2]=transform[:,2]/factor
            self.evidence["flowMatrix"]=original.tolist()
        def move(values):
            values=np.asarray(values,float)
            if transform is None:return values.copy()
            return ((values*factor)@transform[:,:2].T+transform[:,2])/factor
        projected=move(previous["path"]) if previous else None
        direction=projected[-1]-projected[0] if projected is not None else None
        axis=sample.get("bodyAxis") or {}
        current=sample.get("contour") if sample.get("source")=="segmented" else None
        observed=axis.get("state")=="reliable" and len(axis.get("points",[]))==7
        if observed:
            path=np.array([[p["x"],p["y"]] for p in axis["points"]])
            source="observed_geometry"
        elif current:
            path=curve(sample.get("bodyAxisContour") or current,direction)
            source="current_silhouette"
        else:path=None;source=None
        if path is None and projected is not None:
            path=projected;source="optical_flow" if transform is not None else "held_estimate"
        known=bool(previous and previous["known"])
        orientation_source="flow_direction" if known and transform is not None else "previous_direction" if known else "unknown"
        if path is not None:
            if direction is not None and np.dot(path[-1]-path[0],direction)<0:path=path[::-1].copy()
            if orientation.get("state")=="estimated" and orientation.get("source")=="tail_silhouette":
                proposed=np.array([orientation["head"]["x"]-orientation["tailBase"]["x"],orientation["head"]["y"]-orientation["tailBase"]["y"]])
                # Current bidirectional image motion outranks an isolated new
                # tail proposal, while gradual real turns rotate the estimate.
                agrees=not known or direction is None or np.dot(proposed,direction)>=0
                tip=orientation.get("tailTip")
                tail_length=math.hypot(tip["x"]-orientation["tailBase"]["x"],tip["y"]-orientation["tailBase"]["y"]) if tip else 0.
                fresh_tail=bool(previous and time-previous["anchor"]>2 and tail_length>np.linalg.norm(path[-1]-path[0])*.9)
                confirmed=False
                if not agrees and transform is None:
                    pending=self.opposed
                    consistent=pending and np.dot(pending["direction"],proposed)>0
                    if not consistent:self.opposed=dict(time=time,direction=proposed,count=1)
                    else:self.opposed["count"]+=1
                    confirmed=self.opposed["count"]>=3 and time-self.opposed["time"]>=.25-1e-6
                else:self.opposed=None
                if agrees or confirmed or fresh_tail:
                    if np.dot(path[-1]-path[0],proposed)<0:path=path[::-1].copy()
                    known=True;orientation_source="current_tail"
                    self.opposed=None
            else:self.opposed=None
            path=np.clip(path,[0,0],self.size-1)
            head,tail=None,None
            if known:
                head,tail=path[-1],path[0]
                if orientation_source=="current_tail":
                    head=np.array([orientation["head"]["x"],orientation["head"]["y"]])
                    tail=np.array([orientation["tailBase"]["x"],orientation["tailBase"]["y"]])
            box=sample.get("trackingBox") or sample.get("bbox")
            if box:
                low=np.clip([box["x"],box["y"]],[0,0],self.size-1)
                high=np.clip([box["x"]+box["width"],box["y"]+box["height"]],[0,0],self.size-1)
                box=dict(x=float(low[0]),y=float(low[1]),width=float(high[0]-low[0]),height=float(high[1]-low[1])) if np.all(high>low) else None
            if not box and previous and previous["box"]:
                b=previous["box"];corners=move([[b["x"],b["y"]],[b["x"]+b["width"],b["y"]],[b["x"]+b["width"],b["y"]+b["height"]],[b["x"],b["y"]+b["height"]]])
                corners=np.clip(corners,[0,0],self.size-1);low,high=corners.min(0),corners.max(0)
                box=dict(x=float(low[0]),y=float(low[1]),width=float(high[0]-low[0]),height=float(high[1]-low[1]))
            # Seeing a fresh undirected axis does not reset the age of an
            # inferred head/tail identity.
            anchor=time if observed and orientation_source=="current_tail" else previous["anchor"] if previous else time
            age=max(0.,time-anchor)
            result.update(state="estimated",source=source,points=points(path),box=box,
                head=points([head])[0] if head is not None else None,tailBase=points([tail])[0] if tail is not None else None,
                orientationSource=orientation_source,ageSec=age,supportScore=float((1. if observed else .65 if current else .4 if transform is not None else .15)*math.exp(-min(age,30)/3)))
            self.last=dict(time=time,path=path,known=known,box=box,anchor=anchor)
        else:self.last=None
        feature_mask=np.zeros(gray.shape,np.uint8)
        if current:cv.fillPoly(feature_mask,[np.rint(np.array([[p["x"],p["y"]] for p in current])*factor).astype(np.int32)],255)
        elif result["box"]:
            b=result["box"];a=np.rint(np.array([b["x"],b["y"]])*factor).astype(int);z=np.rint(np.array([b["x"]+b["width"],b["y"]+b["height"]])*factor).astype(int)
            cv.rectangle(feature_mask,tuple(a),tuple(z),255,-1)
        self.features=cv.goodFeaturesToTrack(gray,maxCorners=60,qualityLevel=.015,minDistance=3,mask=feature_mask)
        self.gray=gray
        return result
