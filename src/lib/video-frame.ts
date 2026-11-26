import type { PoseSample } from "../types";

/** PTS lookup, with half-open frame intervals. Never borrow a box across a gap. */
export function trackingFrameAt<T extends Pick<PoseSample, "timestampSec" | "frameIndex">>(
  timeline: readonly T[], time: number | null, fps: number,
): T | undefined {
  if (time == null || !Number.isFinite(time) || !timeline.length) return;
  let lo = 0, hi = timeline.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid].timestampSec <= time + 1e-6) lo = mid + 1; else hi = mid;
  }
  const index = lo - 1, row = timeline[index];
  if (!row) return;
  const next = timeline[index + 1];
  // A consecutive VFR frame can legitimately stay displayed longer than 1/fps.
  const end = next?.frameIndex === row.frameIndex + 1 ? next.timestampSec
    : row.timestampSec + (fps > 0 ? 1 / fps : .04);
  return time < end - 1e-6 ? row : undefined;
}
