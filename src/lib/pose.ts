import type { Point, PoseSample } from "../types";

/** Somente evidência observada confiável ou confirmação humana entra nas métricas. */
export function metricEligible(sample: PoseSample | undefined) {
  return drawablePose(sample) && sample.status === "valid"
    && sample.spatialRegion !== "outside"
    && sample.source !== "predicted" && sample.source !== "recovered"
    && (sample.source === "manual" || sample.likelihood >= .6);
}

export function originalPose(sample: PoseSample): PoseSample {
  if (!sample.original) return sample;
  const { original, ...rest } = sample;
  return { ...rest, ...original, supportCount: original.supportCount, supportTotal: original.supportTotal,
    source: "detected" };
}

export function poseSourceLabel(sample: PoseSample | undefined) {
  return sample?.source === "manual" ? "Confirmado manualmente" : sample?.source === "recovered"
    ? "Recuperado · revisar" : sample?.source === "predicted" ? "Previsão · fora das métricas" : "Detecção original";
}

export function inferredFps(samples: PoseSample[], fallback: number | null = null) {
  const first = samples[0];
  const last = samples.find((sample) => first && sample.frameIndex > first.frameIndex && sample.timestampSec > first.timestampSec);
  const fps = first && last ? (last.frameIndex - first.frameIndex) / (last.timestampSec - first.timestampSec) : fallback;
  return fps && Number.isFinite(fps) && fps > 0 ? fps : 30;
}

export function drawablePose(sample: PoseSample | undefined): sample is PoseSample & { xPx: number; yPx: number } {
  return Boolean(sample && sample.status !== "missing" && sample.status !== "out_of_arena"
    && sample.xPx != null && sample.yPx != null && Number.isFinite(sample.xPx) && Number.isFinite(sample.yPx)
    && sample.xPx >= 0 && sample.yPx >= 0);
}

export function confidenceLabel(sample: PoseSample | undefined) {
  if (sample?.source === "manual") return "Manual";
  if (sample?.source === "predicted") return "Previsto";
  return sample && sample.status !== "missing" && Number.isFinite(sample.likelihood) && sample.likelihood > 0 && sample.likelihood <= 1
    ? `${Math.round(sample.likelihood * 100)}%` : "—";
}

export function trajectorySegments(samples: PoseSample[]): Point[][] {
  const segments: Point[][] = [];
  let current: Point[] = [];
  let previous: PoseSample | undefined;
  const family = (sample: PoseSample) => sample.source === "recovered" || sample.source === "predicted" ? sample.source : "observed";
  for (const sample of samples) {
    const usable = drawablePose(sample) && sample.status !== "jump";
    if (!usable || (previous && (sample.frameIndex !== previous.frameIndex + 1 || family(sample) !== family(previous)))) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    if (usable) current.push({ x: sample.xPx, y: sample.yPx });
    previous = usable ? sample : undefined;
  }
  if (current.length > 1) segments.push(current);
  return segments;
}
