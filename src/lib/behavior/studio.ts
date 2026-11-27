import type { PoseSample } from "../../types";
import type { BehaviorAnnotation } from "./types";
import { activeAnnotations, activePeaks, frameAt } from "./validation";

export function episodeForPeak(events: BehaviorAnnotation[], peak: BehaviorAnnotation) {
  return activeAnnotations(events).find(e => e.label?.startsWith("REARING_") && e.startSec! <= peak.timestampSec! && peak.timestampSec! < e.endSec!);
}
export function pendingEpisodes(events: BehaviorAnnotation[]) {
  return activePeaks(events).filter(p => p.label?.startsWith("REARING_") && !episodeForPeak(events,p)).sort((a,b)=>a.timestampSec!-b.timestampSec!);
}
export function activePoseFrames(events: BehaviorAnnotation[]) {
  const undone=new Set(events.filter(e=>e.type==="UNDO").map(e=>e.targetId));
  const byFrame=new Map<number,BehaviorAnnotation>();
  for(const e of events) if(e.type==="POSE_FRAME"&&!undone.has(e.id)) byFrame.set(e.frameIndex!,e);
  return [...byFrame.values()].sort((a,b)=>a.frameIndex!-b.frameIndex!);
}
/** A review queue, never generated anatomical labels or behavioral negatives. */
export function suggestedPoseFrames(times:number[], events:BehaviorAnnotation[], samples:PoseSample[], limit=200) {
  if(!times.length)return [];
  const selected=new Set<number>();
  const add=(time:number)=>{if(selected.size<limit)selected.add(frameAt(times,Math.max(0,time)));};
  for(const p of activePeaks(events))add(p.timestampSec!);
  for(const e of activeAnnotations(events))add((e.startSec!+e.endSec!)/2);
  for(const p of activePeaks(events))for(const offset of [-.5,.5])add(p.timestampSec!+offset);
  const uncertain=samples.filter(s=>s.status!=="valid"||s.bodyAxis?.state!=="reliable");
  const uncertaintySlots=Math.min(40,Math.floor(limit/4));
  for(let i=0;i<uncertaintySlots&&uncertain.length;i++)add(uncertain[Math.floor(i*uncertain.length/uncertaintySlots)].timestampSec);
  for(let i=0;i<limit&&selected.size<limit;i++)selected.add(Math.round(i*(times.length-1)/Math.max(1,limit-1)));
  // Saved manual choices must remain reachable even outside the suggested batch.
  return [...new Set([...selected,...activePoseFrames(events).map(e=>e.frameIndex!)])].sort((a,b)=>a-b);
}
/** Map object-fit:contain clicks, rejecting letterbox bars. */
export function videoPoint(clientX:number,clientY:number,rect:{left:number;top:number;width:number;height:number},width:number,height:number) {
  const scale=Math.min(rect.width/width,rect.height/height);
  if(!(scale>0))return null;
  const x=(clientX-rect.left-(rect.width-width*scale)/2)/scale;
  const y=(clientY-rect.top-(rect.height-height*scale)/2)/scale;
  return x>=0&&y>=0&&x<width&&y<height?{x:Math.round(x*100)/100,y:Math.round(y*100)/100}:null;
}
