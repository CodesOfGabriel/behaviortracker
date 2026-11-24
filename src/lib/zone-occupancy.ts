import type { ArenaConfig, PoseSample } from "../types";
import { boxCenterTrajectory } from "./boxes";
import { isCenterPoint, pixelToFloorMatrix, transformPoint } from "./geometry";
import { acceptedLocalBody } from "./local-motion";
import { metricEligible, referencePoseSamples } from "./pose";
import { preferredReference } from "./tracking-reviews";

/** Visual occupancy of observed box centers. Does not approve scientific metrics. */
export function visualZoneOccupancy(samples: readonly PoseSample[], arena: ArenaConfig, width: number, height: number) {
  const boxes = new Map(boxCenterTrajectory(samples,width,height).centers.map(row=>[row.frameIndex,row]));
  const fallback = referencePoseSamples([...samples],preferredReference([...samples]));
  const matrix = pixelToFloorMatrix(arena);
  const timeline = fallback.map(row=>{
    const box=boxes.get(row.frameIndex);
    const candidate=box??row;
    const observed=box ? (box.source==="manual" || acceptedLocalBody(box)
      || (box.source==="detected" || box.source===undefined) && box.trackingAccepted!==false
        && (!box.localQuality || box.localQuality.tracking==="observed"))
      && box.reason!=="camera_shift" && box.source!=="predicted" && box.source!=="recovered" && box.status!=="jump"
      : metricEligible(row);
    if(!observed || candidate.xPx==null || candidate.yPx==null)return {...row,zone:"unknown" as const};
    try {
      const point=transformPoint({x:candidate.xPx,y:candidate.yPx},matrix);
      const zone=point.x<0||point.y<0||point.x>arena.widthCm||point.y>arena.heightCm ? "unknown"
        : isCenterPoint(point,arena)?"center":"periphery";
      return {...row,zone};
    } catch {
      return {...row,zone:"unknown" as const};
    }
  });
  let centerSec=0,peripherySec=0,unknownSec=0;
  for(let i=1;i<timeline.length;i++){
    const previous=timeline[i-1],current=timeline[i],dt=current.timestampSec-previous.timestampSec;
    if(!(dt>0))continue;
    const zone=dt<=.5 && current.frameIndex===previous.frameIndex+1 && current.zone!=="unknown" ? previous.zone : "unknown";
    if(zone==="center")centerSec+=dt;
    else if(zone==="periphery")peripherySec+=dt;
    else unknownSec+=dt;
  }
  const observedSec=centerSec+peripherySec,totalSec=observedSec+unknownSec;
  return {centerSec,peripherySec,unknownSec,observedSec,totalSec,
    centerPct:observedSec>0?centerSec/observedSec*100:null,
    observedPct:totalSec>0?observedSec/totalSec*100:0};
}
