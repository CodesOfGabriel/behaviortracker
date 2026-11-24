import type { PoseSample } from "../types";
import { boxCenterTrajectory } from "./boxes";

export function acceptedLocalBody(sample: PoseSample) {
  const quality = sample.localQuality;
  return !["missing", "jump"].includes(sample.status) && sample.reason !== "camera_shift"
    && sample.source !== "predicted" && sample.source !== "recovered" && sample.trackingAccepted !== false
    && (!quality || quality.tracking === "observed") && (sample.trackingAccepted === true || sample.status === "valid");
}

/** Visual image velocity, never a scientific floor or behavioral metric. */
export function boxMotionSeries(samples: readonly PoseSample[], width: number, height: number) {
  let previous: PoseSample | undefined;
  return boxCenterTrajectory(samples, width, height).centers.map(sample => {
    const accepted = acceptedLocalBody(sample);
    const dt = previous ? sample.timestampSec-previous.timestampSec : 0;
    const speed = accepted && previous && sample.frameIndex === previous.frameIndex+1 && dt > 0 && dt <= .5
      ? Math.hypot(sample.xPx!-previous.xPx!, sample.yPx!-previous.yPx!)/dt : null;
    previous = accepted ? sample : undefined;
    return { frameIndex: sample.frameIndex, timestampSec: sample.timestampSec, speedPxSec: speed };
  });
}

/** Visual velocity of already-observed image points, without boxes or floor metrics. */
export function pointImageMotionSeries(samples: readonly PoseSample[]) {
  let previous: PoseSample | undefined;
  return [...samples].sort((a,b)=>a.timestampSec-b.timestampSec||a.frameIndex-b.frameIndex).map(sample=>{
    const accepted=acceptedLocalBody(sample)&&Number.isFinite(sample.xPx)&&Number.isFinite(sample.yPx);
    const dt=previous?sample.timestampSec-previous.timestampSec:0;
    const speed=accepted&&previous&&sample.frameIndex===previous.frameIndex+1&&dt>0&&dt<=.5
      ?Math.hypot(sample.xPx!-previous.xPx!,sample.yPx!-previous.yPx!)/dt:null;
    previous=accepted?sample:undefined;
    return {frameIndex:sample.frameIndex,timestampSec:sample.timestampSec,speedPxSec:speed};
  });
}
