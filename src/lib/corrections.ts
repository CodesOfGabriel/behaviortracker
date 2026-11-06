import type { CorrectionEvent, PoseSample } from "../types";

export function activeCorrectionEvents(events: CorrectionEvent[]) {
  const reverted = new Set(
    events.filter((event) => event.type === "REVERT_EVENT").map((event) => event.targetEventId),
  );
  return events.filter((event) => event.type !== "REVERT_EVENT" && !reverted.has(event.id));
}

export function applyCorrections(samples: PoseSample[], events: CorrectionEvent[]) {
  const overrides = new Map<string, CorrectionEvent[]>();
  activeCorrectionEvents(events).forEach((event) => {
    if (event.frameIndex == null || !event.keypoint) return;
    if (event.type === "MOVE_POINT" || event.type === "MARK_MISSING" || event.type === "CONFIRM_POINT") {
      const key = `${event.frameIndex}:${event.keypoint}`;
      overrides.set(key, [...(overrides.get(key) ?? []), event]);
    }
  });
  return samples.map((sample) => {
    const original = sample.original ?? { xPx: sample.xPx, yPx: sample.yPx, likelihood: sample.likelihood,
      status: sample.status, spatialRegion: sample.spatialRegion, supportCount: sample.supportCount, supportTotal: sample.supportTotal };
    return (overrides.get(`${sample.frameIndex}:${sample.keypoint}`) ?? []).reduce<PoseSample>((current, event) => {
      if (event.type === "CONFIRM_POINT") {
        if (current.source === "predicted" || current.xPx == null || current.yPx == null
          || current.status === "missing" || current.status === "out_of_arena"
          || (event.before && (event.before.x !== current.xPx || event.before.y !== current.yPx))) return current;
        return { ...current, original, status: "valid", source: "manual" };
      }
      if (event.type === "MARK_MISSING") return { ...current, original, xPx: null, yPx: null, status: "missing", source: "manual", spatialRegion: "unknown" };
      if (!event.after || !Number.isFinite(event.after.x) || !Number.isFinite(event.after.y) || event.after.x < 0 || event.after.y < 0) return current;
      return { ...current, original, xPx: event.after.x, yPx: event.after.y, status: "valid", source: "manual", spatialRegion: "unknown" };
    }, sample);
  });
}

