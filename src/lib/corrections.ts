import type { CorrectionEvent, PoseSample } from "../types";

export function activeCorrectionEvents(events: CorrectionEvent[]) {
  const reverted = new Set(
    events.filter((event) => event.type === "REVERT_EVENT").map((event) => event.targetEventId),
  );
  return events.filter((event) => event.type !== "REVERT_EVENT" && !reverted.has(event.id));
}

export function applyCorrections(samples: PoseSample[], events: CorrectionEvent[]) {
  const overrides = new Map<string, CorrectionEvent>();
  activeCorrectionEvents(events).forEach((event) => {
    if (event.frameIndex == null || !event.keypoint) return;
    if (event.type === "MOVE_POINT" || event.type === "MARK_MISSING") {
      overrides.set(`${event.frameIndex}:${event.keypoint}`, event);
    }
  });
  return samples.map((sample) => {
    const event = overrides.get(`${sample.frameIndex}:${sample.keypoint}`);
    if (!event) return sample;
    if (event.type === "MARK_MISSING") {
      return { ...sample, xPx: null, yPx: null, status: "missing" as const };
    }
    return {
      ...sample,
      xPx: event.after?.x ?? sample.xPx,
      yPx: event.after?.y ?? sample.yPx,
      status: "valid" as const,
    };
  });
}

