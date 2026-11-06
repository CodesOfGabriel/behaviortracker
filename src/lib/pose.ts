import type { Point, PoseSample } from "../types";

export function drawablePose(sample: PoseSample | undefined): sample is PoseSample & { xPx: number; yPx: number } {
  return Boolean(sample && sample.status !== "missing" && sample.status !== "out_of_arena"
    && sample.xPx != null && sample.yPx != null && Number.isFinite(sample.xPx) && Number.isFinite(sample.yPx)
    && sample.xPx >= 0 && sample.yPx >= 0);
}

export function confidenceLabel(sample: PoseSample | undefined) {
  return sample && sample.status !== "missing" && Number.isFinite(sample.likelihood) && sample.likelihood > 0 && sample.likelihood <= 1
    ? `${Math.round(sample.likelihood * 100)}%` : "—";
}

export function trajectorySegments(samples: PoseSample[]): Point[][] {
  const segments: Point[][] = [];
  let current: Point[] = [];
  let previous: PoseSample | undefined;
  for (const sample of samples) {
    const usable = drawablePose(sample) && sample.status !== "jump";
    if (!usable || (previous && sample.frameIndex !== previous.frameIndex + 1)) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    if (usable) current.push({ x: sample.xPx, y: sample.yPx });
    previous = usable ? sample : undefined;
  }
  if (current.length > 1) segments.push(current);
  return segments;
}
