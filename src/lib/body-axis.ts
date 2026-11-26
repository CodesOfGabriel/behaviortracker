import type { BodyAxisObservation, Point, PoseSample } from "../types";

export const BODY_AXIS_VERSION="body-axis-2" as const;
const radians=(n:number)=>n*Math.PI/180;
export const axisAngleDelta=(value:number,reference:number)=>((value-reference+Math.PI/2)%Math.PI+Math.PI)%Math.PI-Math.PI/2;
const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return n%2?sorted[n>>1]:(sorted[n/2-1]+sorted[n/2])/2;};
export function insideSilhouette(point:Point,contour:readonly Point[]){
  let yes=false;
  for(let i=0;i<contour.length;i++){
    const a=contour[i],b=contour[(i+1)%contour.length];
    if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)yes=!yes;
  }
  return yes;
}
export function drawableSilhouette(sample:PoseSample|undefined){
  if(!sample?.bbox||!sample.contour||["missing","out_of_arena","jump"].includes(sample.status)||["predicted","recovered","manual"].includes(sample.source??""))return false;
  const rejected=["camera_shift","silhouette_clipped","ambiguous_candidates","identity_pending","reacquisition_pending","appearance_changed","researcher_intervention"];
  return ![sample.reason??"",...(sample.localQuality?.reasons??[])].some(reason=>rejected.some(tag=>reason.endsWith(tag)||reason.startsWith(tag)));
}
type Measurement={points:Point[];reason:string;angleRad:number|null;anisotropy:number|null;areaPx:number|null;center:Point|null};
const cache=new WeakMap<readonly Point[],Measurement>();
function convexCoreArea(pixels:Point[]){
  const sorted=[...pixels].sort((a,b)=>a.x-b.x||a.y-b.y);
  const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  function half(rows:Point[]){const hull:Point[]=[];for(const p of rows){while(hull.length>=2&&cross(hull[hull.length-2],hull[hull.length-1],p)<=0)hull.pop();hull.push(p);}return hull;}
  const hull=[...half(sorted).slice(0,-1),...half(sorted.reverse()).slice(0,-1)];
  const area=Math.abs(hull.reduce((n,p,i)=>{const q=hull[(i+1)%hull.length];return n+p.x*q.y-p.y*q.x;},0))/2;
  return area+Math.max(...pixels.map(p=>p.x))-Math.min(...pixels.map(p=>p.x))+Math.max(...pixels.map(p=>p.y))-Math.min(...pixels.map(p=>p.y))+1;
}

/** Thick-body geometry; thin tails and bridges do not determine its direction. */
export function measureBodyAxis(contour?:readonly Point[]):Measurement{
  const empty:Measurement={points:[],reason:"invalid_contour",angleRad:null,anisotropy:null,areaPx:null,center:null};
  if(!contour||contour.length<3||contour.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))return empty;
  const cached=cache.get(contour);if(cached)return cached;
  const save=(value:Measurement)=>{cache.set(contour,value);return value;};
  const origin={x:Math.min(...contour.map(p=>p.x)),y:Math.min(...contour.map(p=>p.y))};
  const extent={x:Math.max(...contour.map(p=>p.x))-origin.x,y:Math.max(...contour.map(p=>p.y))-origin.y};
  if(Math.min(extent.x,extent.y)<3)return save(empty);
  const scale=Math.min(1,62/Math.max(extent.x,extent.y));
  const polygon=contour.map(p=>({x:(p.x-origin.x)*scale+1,y:(p.y-origin.y)*scale+1}));
  const w=Math.ceil(extent.x*scale)+3,h=Math.ceil(extent.y*scale)+3;
  const distance=new Float64Array(w*h),mask=new Uint8Array(w*h);
  let area=0;
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++)if(insideSilhouette({x,y},polygon)){mask[y*w+x]=1;distance[y*w+x]=w+h;area++;}
  if(area<16)return save(empty);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;if(mask[i])distance[i]=Math.min(distance[i],1+Math.min(distance[i-1],distance[i-w-1],distance[i-w],distance[i-w+1]));
  }
  let maximum=0;
  for(let y=h-2;y>0;y--)for(let x=w-2;x>0;x--){
    const i=y*w+x;if(mask[i]){distance[i]=Math.min(distance[i],1+Math.min(distance[i+1],distance[i+w-1],distance[i+w],distance[i+w+1]));maximum=Math.max(maximum,distance[i]);}
  }
  if(maximum<2)return save({...empty,reason:"thin_mask"});
  const minimum=Math.max(1.5,maximum*.35),visited=new Uint8Array(w*h),components:number[][]=[];
  let coreCount=0;
  for(let i=0;i<mask.length;i++)if(distance[i]>=minimum){
    coreCount++;if(visited[i])continue;
    const queue=[i];visited[i]=1;
    for(let cursor=0;cursor<queue.length;cursor++){
      const j=queue[cursor];
      for(const offset of [-w-1,-w,-w+1,-1,1,w-1,w,w+1]){
        const next=j+offset;if(!visited[next]&&distance[next]>=minimum){visited[next]=1;queue.push(next);}
      }
    }
    components.push(queue);
  }
  components.sort((a,b)=>b.length-a.length);const core=components[0];
  if(!core)return save({...empty,reason:"thin_mask"});
  if(core.length<.7*coreCount)return save({...empty,reason:"fragmented_body"});
  core.sort((a,b)=>a-b);
  if(core.length/convexCoreArea(core.map(i=>({x:i%w,y:Math.floor(i/w)})))<.8)return save({...empty,reason:"concave_body"});
  let weight=0,cx=0,cy=0;
  for(const i of core){const d=distance[i]**2;weight+=d;cx+=(i%w)*d;cy+=Math.floor(i/w)*d;}
  cx/=weight;cy/=weight;
  let xx=0,yy=0,xy=0;
  for(const i of core){const x=i%w-cx,y=Math.floor(i/w)-cy,d=distance[i]**2;xx+=x*x*d;yy+=y*y*d;xy+=x*y*d;}
  const disc=Math.hypot(xx-yy,2*xy),ratio=(xx+yy+disc)/2/Math.max(1,(xx+yy-disc)/2);
  const angle=.5*Math.atan2(2*xy,xx-yy),direction={x:Math.cos(angle),y:Math.sin(angle)};
  const measured={...empty,angleRad:angle,anisotropy:ratio,areaPx:area/(scale*scale),center:{x:(cx-1)/scale+origin.x,y:(cy-1)/scale+origin.y}};
  if(ratio<1.5)return save({...measured,reason:"ambiguous_orientation"});
  const pixels=core.map(i=>({x:i%w,y:Math.floor(i/w),d:distance[i]**2,t:Math.round(((i%w)*direction.x+Math.floor(i/w)*direction.y)*1e9)/1e9}));
  const ordered=pixels.map(p=>p.t).sort((a,b)=>a-b),low=ordered[Math.floor(ordered.length*.02)],high=ordered[Math.min(ordered.length-1,Math.floor(ordered.length*.98))];
  const path:Point[]=[];
  for(let i=0;i<7;i++){
    const section=pixels.filter(p=>p.t>=low+(high-low)*i/7&&p.t<=low+(high-low)*(i+1)/7);
    if(!section.length)return save({...measured,reason:"incomplete_axis"});
    const total=section.reduce((n,p)=>n+p.d,0),center={x:section.reduce((n,p)=>n+p.x*p.d,0)/total,y:section.reduce((n,p)=>n+p.y*p.d,0)/total};
    const squared=(p:Point)=>(p.x-center.x)**2+(p.y-center.y)**2;
    const nearest=section.reduce((best,p)=>squared(p)<squared(best)-1e-9?p:best);
    path.push({x:(nearest.x-1)/scale+origin.x,y:(nearest.y-1)/scale+origin.y});
  }
  if(!supportedPath(path,contour))return save({...measured,reason:"disconnected_axis"});
  return save({...measured,points:path,reason:"ok"});
}
function supportedPath(path:readonly Point[],contour:readonly Point[]){
  return path.slice(1).every((b,index)=>{const a=path[index];return Array.from({length:17},(_,i)=>({x:a.x+(b.x-a.x)*i/16,y:a.y+(b.y-a.y)*i/16})).every(p=>insideSilhouette(p,contour));});
}
export function estimatedBodyAxis(contour?:readonly Point[],_directionHint?:Point){return measureBodyAxis(contour).points;}
type History={angle:number;filteredAngle:number;time:number;area:number;center:Point};
/** Outliers are quarantined, never replaced with a stale perpendicular axis. */
export class BodyAxisFilter{
  private history:History[]=[];
  private pending:{angle:number;area:number;center:Point;reason:string;time:number;count:number}|null=null;
  private lastSeen:{frame:number;time:number}|null=null;
  update(sample:PoseSample):BodyAxisObservation{
    const frame=sample.frameIndex,time=sample.timestampSec;
    if(this.lastSeen&&(frame!==this.lastSeen.frame+1||!(time>this.lastSeen.time&&time-this.lastSeen.time<=.25))){this.history=[];this.pending=null;}
    this.lastSeen={frame,time};
    const base:BodyAxisObservation={schemaVersion:BODY_AXIS_VERSION,frameIndex:frame,timestampSec:time,points:[],state:"missing",reason:"unobserved",rawAngleRad:null,angleRad:null,anisotropy:null,filtered:false,anatomicalPose:false};
    if(!drawableSilhouette(sample)){this.history=[];this.pending=null;return base;}
    const contour=sample.bodyAxisContour??sample.contour;
    const measured=measureBodyAxis(contour);base.rawAngleRad=measured.angleRad;base.anisotropy=measured.anisotropy;
    if(!measured.points.length){this.history=[];this.pending=null;return {...base,state:"ambiguous",reason:sample.bodyAxisContour&&!contour?.length?"unsupported_current_image":measured.reason};}
    const angle=measured.angleRad!,area=measured.areaPx!,center=measured.center!;
    this.history=this.history.slice(-7).filter(old=>time-old.time<=.3);
    const old=this.history.at(-1);let reason:string|undefined;
    if(old){
      const velocities=this.history.slice(1).map((b,i)=>axisAngleDelta(b.angle,this.history[i].angle)/(b.time-this.history[i].time));
      const velocity=velocities.length?Math.max(-Math.PI*4,Math.min(Math.PI*4,median(velocities.slice(-3)))):0;
      const innovation=Math.abs(axisAngleDelta(angle,old.angle+velocity*(time-old.time)));
      const residuals=this.history.slice(1).map((b,i)=>Math.abs(axisAngleDelta(b.angle,this.history[i].angle)));
      const noise=residuals.length?median(residuals):0,medianArea=median(this.history.map(row=>row.area));
      if(innovation>Math.max(radians(35),Math.min(radians(65),noise*3)))reason="orientation_outlier";
      else if(area/medianArea<.55||area/medianArea>1.8)reason="area_outlier";
      else if(Math.hypot(center.x-old.center.x,center.y-old.center.y)>1.25*Math.sqrt(medianArea))reason="position_outlier";
    }
    let confirmed=false;
    if(reason){
      const p=this.pending,consistent=p&&p.reason===reason&&Math.abs(axisAngleDelta(angle,p.angle))<radians(20)&&area/p.area>=.7&&area/p.area<=1.4&&Math.hypot(center.x-p.center.x,center.y-p.center.y)<=1.25*Math.sqrt(area);
      if(!consistent)this.pending={angle,area,center,reason,time,count:1};
      else{this.pending!.count++;confirmed=this.pending!.count>=2&&time-this.pending!.time>=.08-1e-6;}
      if(!confirmed)return {...base,state:"outlier",reason};
      this.history=[];
    }
    this.pending=null;let smoothed=angle;
    if(old&&!confirmed){const change=axisAngleDelta(angle,old.filteredAngle);smoothed=angle-Math.max(-radians(8),Math.min(radians(8),change*.25));}
    let points=measured.points;const rotation=axisAngleDelta(smoothed,angle);
    if(Math.abs(rotation)>1e-6){
      const c=Math.cos(rotation),s=Math.sin(rotation),rotated=points.map(p=>({x:center.x+(p.x-center.x)*c-(p.y-center.y)*s,y:center.y+(p.x-center.x)*s+(p.y-center.y)*c}));
      if(supportedPath(rotated,contour!))points=rotated;else smoothed=angle;
    }
    this.history.push({angle,filteredAngle:smoothed,time,area,center});
    return {...base,points,angleRad:smoothed,state:"reliable",reason:confirmed?"change_confirmed":"ok",filtered:Math.abs(axisAngleDelta(smoothed,angle))>1e-6};
  }
}
/** Replay bounded source context so seeks and dropped display frames agree. */
export function bodyAxisAt(sample:PoseSample|undefined,timeline?:readonly PoseSample[]):BodyAxisObservation|undefined{
  if(!sample)return;
  const filter=new BodyAxisFilter();
  if(timeline?.length){
    let lo=0,hi=timeline.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(timeline[mid].frameIndex<sample.frameIndex)lo=mid+1;else hi=mid;}
    const end=lo;let start=end;
    while(start>0&&end-start<96&&(end-start<16||sample.timestampSec-timeline[start-1].timestampSec<=.6))start--;
    for(let i=start;i<end;i++)filter.update(timeline[i]);
  }
  return filter.update(sample);
}
