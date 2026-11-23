import type { CorrectionEvent, PoseSample, RadialMazeExperiment, RadialMazeGeometry } from "../../types";
import { applyCorrections } from "../corrections";
import { detectRamChoices, type RamFrame } from "./events";
import { pointInPolygon, spatialRegion, validateRamEventGeometry } from "./geometry";
import { calculateRamMetrics } from "./metrics";

export function correctedRamSamples(raw: PoseSample[], events: CorrectionEvent[]) {
  // RAM corrections apply only to the inspected frame; never interpolate gaps.
  const byFrame = new Map<number, CorrectionEvent[]>();
  for (const event of events) if (event.frameIndex != null) byFrame.set(event.frameIndex, [...(byFrame.get(event.frameIndex) ?? []), event]);
  return raw.map(s => {
    const edits = byFrame.get(s.frameIndex);
    if (!edits?.length) return s;
    const corrected = applyCorrections([s], edits)[0];
    return { ...corrected, centerDefinition: corrected.source === "manual" ? "manual_body_reference" : corrected.centerDefinition, bodyBbox: corrected.bbox ?? null, bodyCenter: corrected.xPx == null || corrected.yPx == null ? undefined : { x: corrected.xPx, y: corrected.yPx },
      observationState: corrected.status === "missing" ? "missing" as const : corrected.status === "valid" ? "observed" as const : "uncertain" as const };
  });
}

export function ramFrames(samples: PoseSample[], geometry?: RadialMazeGeometry): RamFrame[] {
  return samples.map(s => {
    const observed = s.status === "valid" && s.source !== "predicted" && s.source !== "recovered" && s.xPx != null && s.yPx != null
      && (!geometry?.walkablePolygonPx || pointInPolygon({ x: s.xPx, y: s.yPx }, geometry.walkablePolygonPx));
    return { frameIndex: s.frameIndex, timestampSec: s.timestampSec,
      center: observed ? { x: s.xPx!, y: s.yPx! } : null, identity: observed ? "confirmed" : "uncertain",
      source: observed ? s.source === "manual" ? "manual" : "segmented" : "missing" };
  });
}

export function deriveRamResult(samples: PoseSample[], experiment: RadialMazeExperiment) {
  const { geometry, video, visitPolicy } = experiment;
  const frames = ramFrames(samples, geometry);
  const geometryError = validateRamEventGeometry(geometry, video.width, video.height);
  const baited = geometry.arms.filter(a => a.baited).map(a => a.id);
  const choices = geometryError ? [] : detectRamChoices(frames, geometry, visitPolicy);
  const metrics = geometryError ? null : calculateRamMetrics(choices, baited, frames[0]?.timestampSec ?? 0);
  const occupancySec: Record<string, number> = {};
  const transitions: { frameIndex: number; timestampSec: number; from: string; to: string; status: "confirmed" | "pending" }[] = [];
  const displacement: { frameIndex: number; timestampSec: number; distancePx: number | null; speedCmS: number | null }[] = [];
  const scale = experiment.spatialCalibration?.pixelsPerCm;
  const pixelsPerCm = scale && Number.isFinite(scale) && scale > 0 ? scale : null;
  let distancePx = 0, observedSec = 0, unknownSec = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i-1], b = frames[i], dt = b.timestampSec-a.timestampSec;
    const continuous = dt > 0 && dt <= .25 && b.frameIndex === a.frameIndex+1 && a.center && b.center;
    const from = geometryError ? "UNKNOWN" : spatialRegion(a.center, geometry);
    const to = geometryError ? "UNKNOWN" : spatialRegion(b.center, geometry);
    if (from !== to) transitions.push({ frameIndex: b.frameIndex, timestampSec: b.timestampSec, from, to,
      status: continuous && from !== "UNKNOWN" && to !== "UNKNOWN" ? "confirmed" : "pending" });
    if (continuous) {
      const step = Math.hypot(b.center!.x-a.center!.x, b.center!.y-a.center!.y);
      distancePx += step; observedSec += dt;
      occupancySec[from] = (occupancySec[from] ?? 0)+dt;
      displacement.push({ frameIndex: b.frameIndex, timestampSec: b.timestampSec, distancePx: step, speedCmS: pixelsPerCm ? step/pixelsPerCm/dt : null });
    } else {
      unknownSec += Math.max(0,dt);
      displacement.push({ frameIndex: b.frameIndex, timestampSec: b.timestampSec, distancePx: null, speedCmS: null });
    }
  }
  const duration = Math.max(0, (frames.at(-1)?.timestampSec ?? 0)-(frames[0]?.timestampSec ?? 0));
  return { geometryError, choices: metrics?.choices ?? [], metrics: metrics ? { ...metrics,
    // Complete metrics require both a complete event log and continuous temporal evidence.
    definitive: metrics.definitive && unknownSec === 0, scope: "observed_confirmed_log" as const,
    correctChoiceEfficiency: unknownSec > 0 ? null : metrics.correctChoiceEfficiency, firstChoiceLatencySec: unknownSec > 0 ? null : metrics.firstChoiceLatencySec } : null,
    transitions, occupancySec, displacement, distanceCm: pixelsPerCm ? distancePx/pixelsPerCm : null,
    meanSpeedCmS: pixelsPerCm && observedSec ? distancePx/pixelsPerCm/observedSec : null,
    temporalQuality: { observedSec, unknownSec, durationSec: duration, observedCoveragePct: duration ? 100*observedSec/duration : 0 },
    scientificallyValidated: false, rewardRemoval: "NOT_CONFIRMED" as const };
}
