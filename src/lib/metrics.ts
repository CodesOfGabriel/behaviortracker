import type { ArenaConfig, OftMetrics, Point, PoseSample } from "../types";
import { isCenterPoint, pixelToFloorMatrix, transformPoint } from "./geometry";
import { metricEligible } from "./pose";
import { boxCenterTrajectory } from "./boxes";

export const METRIC_POLICY = { version: "oft-0.2", maxPairGapSec: .5, minScore: .6,
  immobilityThresholdCmS: 2, minImmobilityDurationSec: .5, minCenterDwellSec: .2,
  eligibility: "valid_detected_or_manually_confirmed", intervalPolicy: "both_endpoints_valid", requireConsecutiveFrames: true } as const;

export interface MetricOptions {
  maxPairGapSec?: number;
  immobilityThresholdCmS?: number;
  minImmobilityDurationSec?: number;
  minCenterDwellSec?: number;
  revision?: "raw" | "reviewed";
}

type Zone = "center" | "periphery" | "unknown";

function usablePoint(sample: PoseSample, eligible: (sample: PoseSample) => boolean): Point | null {
  if (
    !eligible(sample) || sample.xPx == null ||
    sample.yPx == null ||
    sample.status === "missing" ||
    sample.status === "out_of_arena"
  ) {
    return null;
  }
  return { x: sample.xPx, y: sample.yPx };
}

function calculateMetrics(
  input: PoseSample[],
  arena: ArenaConfig,
  options: MetricOptions,
  eligible: (sample: PoseSample) => boolean,
): OftMetrics {
  const samples = [...input].sort((a, b) => a.timestampSec - b.timestampSec);
  const maxPairGapSec = options.maxPairGapSec ?? METRIC_POLICY.maxPairGapSec;
  const immobilityThreshold = options.immobilityThresholdCmS ?? METRIC_POLICY.immobilityThresholdCmS;
  const minImmobilityDuration = options.minImmobilityDurationSec ?? METRIC_POLICY.minImmobilityDurationSec;
  const minCenterDwell = options.minCenterDwellSec ?? METRIC_POLICY.minCenterDwellSec;
  const matrix = pixelToFloorMatrix(arena);

  if (samples.length < 2) {
    return {
      revision: options.revision ?? "reviewed",
      analysisDurationSec: 0,
      validDurationSec: 0,
      coveragePct: 0,
      distanceCm: null,
      meanSpeedCmS: null,
      centerTimeSec: 0,
      peripheralTimeSec: 0,
      unknownTimeSec: 0,
      centerPctClassifiable: null,
      centerEntries: 0,
      centerLatencySec: null,
      immobilityTimeSec: 0,
    };
  }

  const floorPoints = samples.map((sample) => {
    const point = usablePoint(sample, eligible);
    if (!point) return null;
    try {
      const floor = transformPoint(point, matrix);
      if (floor.x < 0 || floor.x > arena.widthCm || floor.y < 0 || floor.y > arena.heightCm) return null;
      return floor;
    } catch {
      return null;
    }
  });

  const zones: Zone[] = floorPoints.map((point) =>
    point ? (isCenterPoint(point, arena) ? "center" : "periphery") : "unknown",
  );

  let analysisDuration = 0;
  let centerTime = 0;
  let peripheralTime = 0;
  let unknownTime = 0;
  let distance = 0;
  let validPairTime = 0;
  let validPairCount = 0;
  let immobilityTime = 0;
  let immobilityRun = 0;
  const intervals: Array<{ start: number; duration: number; zone: Zone }> = [];

  const flushImmobility = () => {
    if (immobilityRun >= minImmobilityDuration) immobilityTime += immobilityRun;
    immobilityRun = 0;
  };

  for (let index = 0; index < samples.length - 1; index += 1) {
    const delta = samples[index + 1].timestampSec - samples[index].timestampSec;
    if (!(delta > 0)) continue;
    analysisDuration += delta;
    const consecutive = samples[index + 1].frameIndex === samples[index].frameIndex + 1;
    const pairEligible = floorPoints[index] && floorPoints[index + 1] && delta <= maxPairGapSec && consecutive;
    const zone = pairEligible ? zones[index] : "unknown";
    intervals.push({ start: samples[index].timestampSec, duration: delta, zone });
    if (zone === "center") centerTime += delta;
    else if (zone === "periphery") peripheralTime += delta;
    else unknownTime += delta;

    const current = floorPoints[index];
    const next = floorPoints[index + 1];
    if (!current || !next || delta > maxPairGapSec || !consecutive) {
      flushImmobility();
      continue;
    }
    const pairDistance = Math.hypot(next.x - current.x, next.y - current.y);
    const speed = pairDistance / delta;
    distance += pairDistance;
    validPairTime += delta;
    validPairCount += 1;
    if (speed <= immobilityThreshold) immobilityRun += delta;
    else flushImmobility();
  }
  flushImmobility();

  let centerEntries = 0;
  let centerLatencySec: number | null = null;
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index - 1].zone !== "periphery" || intervals[index].zone !== "center") continue;
    let dwell = 0;
    for (let cursor = index; cursor < intervals.length && intervals[cursor].zone === "center"; cursor += 1) {
      dwell += intervals[cursor].duration;
      if (dwell >= minCenterDwell) break;
    }
    if (dwell < minCenterDwell) continue;
    centerEntries += 1;
    if (centerLatencySec == null) centerLatencySec = intervals[index].start - samples[0].timestampSec;
  }

  const classifiable = centerTime + peripheralTime;
  return {
    revision: options.revision ?? "reviewed",
    analysisDurationSec: analysisDuration,
    validDurationSec: classifiable,
    coveragePct: analysisDuration > 0 ? (classifiable / analysisDuration) * 100 : 0,
    distanceCm: validPairCount > 0 ? distance : null,
    meanSpeedCmS: validPairTime > 0 ? distance / validPairTime : null,
    centerTimeSec: centerTime,
    peripheralTimeSec: peripheralTime,
    unknownTimeSec: unknownTime,
    centerPctClassifiable: classifiable > 0 ? (centerTime / classifiable) * 100 : null,
    centerEntries,
    centerLatencySec,
    immobilityTimeSec: immobilityTime,
  };
}



/** Reviewed/scientific path; the existing eligibility policy is unchanged. */
export function calculateOftMetrics(input:PoseSample[],arena:ArenaConfig,options:MetricOptions={}):OftMetrics {
  return calculateMetrics(input,arena,options,metricEligible);
}

export const BOX_ESTIMATE_POLICY = {version:"oft-floor-box-estimate-1",reference:"box_center",units:{distance:"cm",speed:"cm/s",time:"s"},
  referenceApproval:"not_granted",requireConsecutiveFrames:true,maxPairGapSec:.5,minCenterDwellSec:.2,
  eligibility:"observed_floor_boxes_only",scientificValidation:"not_established"} as const;

function floorBoxExclusion(sample:PoseSample):string|null {
  if(!sample.bbox)return "no_box";
  if(sample.source==="predicted"||sample.source==="recovered")return "predicted_or_recovered";
  if(sample.reason==="camera_shift")return "camera_shift";
  if(sample.spatialRegion==="outside"||sample.spatialRegion==="wall_projection")return "not_floor";
  if(sample.source==="manual")return sample.status==="valid"?null:"uncertain_observation";
  if(sample.localQuality&&sample.localQuality.geometry!=="floor")return "not_floor";
  if(sample.source==="segmented"&&sample.spatialRegion!=="floor")return "not_floor";
  if(sample.trackingAccepted===false||sample.localQuality&&sample.localQuality.tracking!=="observed")return "uncertain_tracking";
  return sample.status==="valid"?null:"uncertain_observation";
}

/** Separate geometric estimates; never mutates samples, approvals or scientific eligibility. */
export function calculateObservedFloorBoxMetrics(input:PoseSample[],arena:ArenaConfig,width:number,height:number) {
  const boxes=new Map(boxCenterTrajectory(input,width,height).centers.map(sample=>[sample.frameIndex,sample]));
  const clock=new Map<number,PoseSample>();
  for(const sample of input)if(!clock.has(sample.frameIndex))clock.set(sample.frameIndex,sample);
  const reference=[...clock.values()].map(sample=>boxes.get(sample.frameIndex)??{
    ...sample,xPx:null,yPx:null,bbox:undefined,status:"missing" as const,
  });
  const exclusions:Record<string,number>={};
  const matrix=pixelToFloorMatrix(arena);
  let pendingReferenceFrames=0,eligibleFloorFrames=0;
  for(const sample of reference){
    let reason=floorBoxExclusion(sample);
    if(!reason){
      try {const point=transformPoint({x:sample.xPx!,y:sample.yPx!},matrix);
        if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<0||point.y<0||point.x>arena.widthCm||point.y>arena.heightCm)reason="outside_calibrated_floor";
      }catch{reason="outside_calibrated_floor";}
    }
    if(reason)exclusions[reason]=(exclusions[reason]??0)+1;
    else {eligibleFloorFrames++;if(sample.source==="segmented"&&sample.referenceApproved!==true)pendingReferenceFrames++;}
  }
  return {policy:BOX_ESTIMATE_POLICY,metrics:calculateMetrics(reference,arena,{revision:"raw"},sample=>floorBoxExclusion(sample)===null),
    frameCount:clock.size,boxFrames:boxes.size,eligibleFloorFrames,pendingReferenceFrames,exclusions};
}
