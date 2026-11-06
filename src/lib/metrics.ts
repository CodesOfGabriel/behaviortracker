import type { ArenaConfig, OftMetrics, Point, PoseSample } from "../types";
import { isCenterPoint, pixelToFloorMatrix, transformPoint } from "./geometry";
import { metricEligible } from "./pose";

export const METRIC_POLICY = { version: "oft-0.2", maxPairGapSec: .5, minScore: .6,
  immobilityThresholdCmS: 2, minImmobilityDurationSec: .5, minCenterDwellSec: .2,
  eligibility: "valid_detected_or_manually_confirmed", intervalPolicy: "both_endpoints_valid" } as const;

export interface MetricOptions {
  maxPairGapSec?: number;
  immobilityThresholdCmS?: number;
  minImmobilityDurationSec?: number;
  minCenterDwellSec?: number;
  revision?: "raw" | "reviewed";
}

type Zone = "center" | "periphery" | "unknown";

function usablePoint(sample: PoseSample): Point | null {
  if (
    !metricEligible(sample) || sample.xPx == null ||
    sample.yPx == null ||
    sample.status === "missing" ||
    sample.status === "out_of_arena"
  ) {
    return null;
  }
  return { x: sample.xPx, y: sample.yPx };
}

export function calculateOftMetrics(
  input: PoseSample[],
  arena: ArenaConfig,
  options: MetricOptions = {},
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
    const point = usablePoint(sample);
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
    const pairEligible = floorPoints[index] && floorPoints[index + 1] && delta <= maxPairGapSec;
    const zone = pairEligible ? zones[index] : "unknown";
    intervals.push({ start: samples[index].timestampSec, duration: delta, zone });
    if (zone === "center") centerTime += delta;
    else if (zone === "periphery") peripheralTime += delta;
    else unknownTime += delta;

    const current = floorPoints[index];
    const next = floorPoints[index + 1];
    if (!current || !next || delta > maxPairGapSec) {
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

