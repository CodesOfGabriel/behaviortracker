"""FST automatic presence/absence postprocessor. OpenCV CPU, per-animal cylinder ROIs."""
import cv2
import numpy as np
import pandas as pd
from pathlib import Path

# Animal IDs come from the validated FST run configuration.


def calculate_empty_reference(video, rects, n_frames, fps, max_samples=72):
    """Dark-percentile temporal reference; doesn't require manually supplied entry times."""
    cap=cv2.VideoCapture(str(video))
    if not cap.isOpened(): raise RuntimeError(f'Unable to open {video}')
    first=min(n_frames-1,max(1,round(8*fps)))
    locations=sorted(set(int(q) for q in np.linspace(0,n_frames-1,max_samples)) |
                     set(int(q) for q in np.linspace(0,first,25)))
    references={a:[] for a in rects}
    for index in locations:
        cap.set(cv2.CAP_PROP_POS_FRAMES,index)
        ok,img=cap.read()
        if not ok:continue
        for animal,(x1,y1,x2,y2) in rects.items():
            references[animal].append(cv2.cvtColor(img[y1:y2,x1:x2],cv2.COLOR_BGR2GRAY))
    cap.release()
    result={}
    for animal,frames in references.items():
        if len(frames)<5:raise ValueError(f'Not enough reference frames for {animal}')
        result[animal]=np.percentile(np.stack(frames,axis=0),8,axis=0).astype(np.uint8)
    return result


def body_evidence(crop, ref, min_area_frac=.035, min_width_frac=.29, min_height_frac=.12,
                  delta=38, debug=False):
    """Detect compact bright body vs temporal background, rejecting thin vertical reflections.
    Data-driven heuristic: verify in each new acquisition setup.
    """
    h,w=crop.shape[:2]
    gray=cv2.GaussianBlur(cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY),(5,5),0)
    bg=cv2.GaussianBlur(ref,(5,5),0)
    shift=float(np.median(gray.astype(np.int16)-bg.astype(np.int16)))
    difference=cv2.subtract(gray,np.clip(bg.astype(np.float32)+shift,0,255).astype(np.uint8))
    foreground_fraction=float(np.mean(difference>=delta))
    binary=np.uint8(difference>=delta)*255
    size=int(np.clip(round(min(w,h)*.05),7,13))
    size=size if size%2 else size+1
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(size,size))
    binary=cv2.morphologyEx(binary,cv2.MORPH_OPEN,kernel)
    binary=cv2.morphologyEx(binary,cv2.MORPH_CLOSE,
                           cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(7,7)))
    n,lab,stats,center=cv2.connectedComponentsWithStats(binary,8)
    selected=None
    for j in range(1,n):
        xx,yy,bw,bh,area=[int(x) for x in stats[j,:5]]
        fill=area/max(1,bw*bh)
        if (area<min_area_frac*w*h or bw<min_width_frac*w or
            bh<min_height_frac*h or fill<.22 or bw>.95*w or bh>.83*h):
            continue
        score=area/(w*h)
        if selected is None or score>selected['score']:
            selected={'score':float(score),'area':area,'bbox':(xx,yy,xx+bw,yy+bh),
                      'fill':float(fill),'width':bw,'height':bh}
    if selected is None:
        selected={'score':0.0,'area':0,'bbox':None,'fill':np.nan,'width':0,'height':0}
    selected['foreground_fraction']=foreground_fraction
    if debug:selected['mask']=binary
    return selected


def static_body_evidence(crop):
    """Fallback for recordings that begin with an animal already in the tank.

    A temporally stationary body can be absorbed into the dark-percentile reference.
    This independent silhouette check does not use DLC pose coverage.
    """
    h, w = crop.shape[:2]
    gray = cv2.GaussianBlur(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    otsu, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = np.uint8(gray >= max(92, otsu)) * 255
    size = max(5, min(13, round(min(w, h) * .04)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    best = None
    for j in range(1, n):
        x, y, bw, bh, area = [int(v) for v in stats[j, :5]]
        fraction = area / (w * h)
        fill = area / max(1, bw * bh)
        if not (.035 <= fraction <= .45 and .25*w <= bw <= .90*w
                and .12*h <= bh <= .70*h and fill >= .32 and bw/bh >= .35):
            continue
        candidate = {'score':float(fraction), 'area':area, 'bbox':(x,y,x+bw,y+bh),
                     'fill':float(fill), 'width':bw, 'height':bh}
        if best is None or candidate['score'] > best['score']:
            best = candidate
    return best


def _runs(mask):
    if not len(mask):return []
    flags=np.asarray(mask,dtype=bool)
    breaks=np.flatnonzero(np.diff(flags.astype(np.int8))!=0)+1
    edges=np.concatenate(([0],breaks,[len(mask)]))
    return [(int(edges[i]),int(edges[i+1]),bool(flags[edges[i]])) for i in range(len(edges)-1)]


def debounce_presence(raw, fps, foreground_fractions=None, entry_hold_s=.18, bridge_gap_s=.42, exit_hold_s=1.0):
    """Temporal consensus, not a fixed timestamp. 'UNCERTAIN' never means immobility."""
    raw=np.asarray(raw,dtype=bool)
    stable=raw.copy()
    min_run=max(2,round(fps*entry_hold_s))
    for start,end,on in _runs(stable):
        if on and end-start<min_run:stable[start:end]=False
    gap=max(1,round(fps*bridge_gap_s))
    for start,end,on in _runs(stable):
        if not on and end-start<=gap and start>0 and end<len(stable) and stable[start-1] and stable[end]:
            stable[start:end]=True
    # Delay short isolated candidate flickers to ensure spatial+temporal evidence.
    for start,end,on in _runs(stable):
        if on and end-start<min_run:stable[start:end]=False
    states=np.array(['UNCERTAIN']*len(stable),dtype='<U16')
    states[stable]='IN_TANK'
    if stable.any():
        first=int(np.flatnonzero(stable)[0])
        states[:first]='NOT_IN_TANK'
        min_exit=max(1,round(fps*exit_hold_s))
        # Learn the appearance of an empty cylinder from the automatically
        # identified pre-entry portion. Do not require an annotated entry time.
        empty_limit=None
        if foreground_fractions is not None and first>=max(8,round(.5*fps)):
            sample=np.asarray(foreground_fractions[:first],dtype=float)
            sample=sample[np.isfinite(sample)]
            if len(sample)>=8:
                empty_limit=max(.05,float(np.quantile(sample,.90)+.02))
        for start,end,on in _runs(stable):
            if not on and start>first and end-start>=min_exit:
                # Mark absence only when the cylinder ALSO resembles its empty
                # reference, not merely when DLC points or silhouettes vanish.
                if empty_limit is not None:
                    fraction=np.asarray(foreground_fractions[start:end],dtype=float)
                    if np.mean(fraction<=empty_limit)>=.80:
                        states[start:end]='NOT_IN_TANK'
                    else:
                        states[start:end]='UNCERTAIN'
                else:
                    states[start:end]='UNCERTAIN'
    else:
        # If no body is detected in entire recording, do not assert tank is empty!
        states[:]='UNCERTAIN'
    return states,stable


def classify_presence_rows(rows, fps):
    """Prefer temporal foreground when it confirms an entry.

    A stationary reflection can look like a body in the static fallback. Before
    a later visual entry, that evidence is uncertain rather than confirmed.
    """
    fractions = [row['foreground_fraction'] for row in rows]
    temporal_states, temporal_stable = debounce_presence(
        [row['temporal_candidate'] for row in rows], fps, fractions)
    if temporal_stable.any():
        first = int(np.flatnonzero(temporal_stable)[0])
        temporal_states[:first][[row['static_candidate'] for row in rows[:first]]] = 'UNCERTAIN'
        return temporal_states, temporal_stable
    return debounce_presence([row['body_candidate'] for row in rows], fps, fractions)


def detect_presence_video(video,rects,references,n_frames,fps):
    cap=cv2.VideoCapture(str(video))
    if not cap.isOpened():raise RuntimeError(video)
    results={a:[] for a in rects}
    try:
        for i in range(n_frames):
            ok,frame=cap.read()
            if not ok:raise RuntimeError(f'Frame not readable: {i}')
            for a,(x1,y1,x2,y2) in rects.items():
                crop=frame[y1:y2,x1:x2]
                result=body_evidence(crop,references[a])
                temporal_candidate=result['bbox'] is not None
                static_candidate=False
                if result['bbox'] is None:
                    static=static_body_evidence(crop)
                    if static is not None:
                        static_candidate=True
                        static['foreground_fraction']=result['foreground_fraction']
                        result=static
                results[a].append({'frame':i,'time_video_s':i/fps,'animal_id':a,
                                   'body_candidate':bool(result['bbox']),
                                   'temporal_candidate':temporal_candidate,
                                   'static_candidate':static_candidate,
                                   'body_score':result['score'],
                                   'body_area_px':result['area'],
                                   'foreground_fraction':result['foreground_fraction'],
                                   'body_bbox_local':result['bbox']})
            if i%max(1,round(30*fps))==0 and i:
                print('BEHAVETRACKER_FST_PHASE=presence',flush=True)
                print(f'Análise de presença: {i/n_frames:.0%}',flush=True)
    finally:cap.release()
    frames=[]
    for a,rows in results.items():
        states,stable=classify_presence_rows(rows,fps)
        for i,record in enumerate(rows):
            record['presence_state']=str(states[i])
            record['presence_confirmed']=bool(stable[i])
            frames.append(record)
    return pd.DataFrame(frames).sort_values(['frame','animal_id']).reset_index(drop=True)


def bbox_from_pose(pose,rect,thr=0.35):
    x1,y1,x2,y2=rect
    p=np.asarray(pose,dtype=float)
    ok=(np.isfinite(p).all(axis=1)&(p[:,2]>=thr)&
        (p[:,0]>=0)&(p[:,0]<x2-x1)&(p[:,1]>=0)&(p[:,1]<y2-y1))
    pts=p[ok,:2]
    if len(pts)<3:return None,pts
    lo=np.quantile(pts,.10,axis=0)
    hi=np.quantile(pts,.90,axis=0)
    if hi[0]-lo[0]<14 or hi[1]-lo[1]<14:return None,pts
    return np.array([lo[0],lo[1],hi[0],hi[1]],dtype=float),pts


def estimate_body_box(frame,rect,ar,state,fps):
    x1,y1,x2,y2=rect
    crop=frame[y1:y2,x1:x2]
    h,w=crop.shape[:2]
    if not h or not w:return None,'NO_FRAME',0
    pose_box,pts=bbox_from_pose(ar,rect)
    gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
    blur=cv2.GaussianBlur(gray,(5,5),0)
    otsu,_=cv2.threshold(blur,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
    threshold=max(92.,float(otsu))
    _,mask=cv2.threshold(blur,threshold,255,cv2.THRESH_BINARY)
    opening=max(5,min(21,int(min(w,h)*.065)//2*2+1))
    k=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(opening,opening))
    mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,k)
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(7,7)))
    n,lab,stats,cent=cv2.connectedComponentsWithStats(mask,8)
    previous=state.get('box')
    pc=None if previous is None else ((previous[0]+previous[2])/2,(previous[1]+previous[3])/2)
    candidates=[]
    for j in range(1,n):
        area=float(stats[j,cv2.CC_STAT_AREA]);fraction=area/(w*h)
        xx,yy,bw,bh=[int(v) for v in stats[j,:4]]
        if not (.008<=fraction<=.55):continue
        if bw<max(12,w*.12) or bh<max(15,h*.10):continue
        if bw>w*.86 or bh>h*.72:continue
        if pose_box is not None:
            pw=max(1.,pose_box[2]-pose_box[0]);ph=max(1.,pose_box[3]-pose_box[1])
            if bw>max(w*.5,pw*2.6) or bh>max(h*.32,ph*2.2):continue
        if bw/bh<.14:continue
        cx,cy=cent[j]
        hits=int(sum(1 for px,py in pts if xx-8<=px<=xx+bw+8 and yy-8<=py<=yy+bh+8))
        pose_support=hits/max(1,len(pts))
        dist=(np.hypot(cx-pc[0],cy-pc[1])/np.hypot(w,h)) if pc is not None else 0
        score=2.5*pose_support+2*min(fraction/.20,1.0)-2.5*dist
        if xx<=2 or yy<=2 or xx+bw>=w-2 or yy+bh>=h-2:score-=.65
        candidates.append((score,j,hits,(xx,yy,xx+bw,yy+bh),fraction))
    candidates.sort(reverse=True,key=lambda z:z[0])
    chosen=None;method='NO_BOX'
    if candidates:
        score,j,hits,region,fraction=candidates[0]
        if (hits>=1 and score>0.4) or (len(pts)<3 and pc is not None and score>0.9) or (len(pts)==0 and pc is None and score>1.0):
            chosen=np.array(region,dtype=float)
            method='SEGMENT_POSE' if hits>=1 else 'SEGMENT'
    if chosen is None and pose_box is not None:
        chosen=pose_box;method='POSE'
    if chosen is None:
        state['miss']=state.get('miss',0)+1
        if previous is not None and state['miss']<=max(5,round(fps*.5)):
            return previous.copy(),'HOLD',len(pts)
        state['box']=None
        return None,'NO_BOX',len(pts)
    state['miss']=0
    xx1,yy1,xx2,yy2=chosen
    boxw=max(30.,xx2-xx1);boxh=max(35.,yy2-yy1)
    pad_x=max(20.,.22*boxw);pad_y=max(22.,.22*boxh)
    chosen=np.array([xx1-pad_x,yy1-pad_y,xx2+pad_x,yy2+pad_y],dtype=float)
    if previous is not None:
        alpha=.45 if method=='SEGMENT_POSE' else .28
        chosen=alpha*chosen+(1-alpha)*previous
    chosen[0]=np.clip(chosen[0],0,w-2)
    chosen[1]=np.clip(chosen[1],0,h-2)
    chosen[2]=np.clip(chosen[2],chosen[0]+1,w-1)
    chosen[3]=np.clip(chosen[3],chosen[1]+1,h-1)
    state['box']=chosen
    return chosen,method,len(pts)
