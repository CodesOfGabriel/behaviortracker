import type { Point, PoseSample, PoseStatus } from "../types";

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

/** Mantém o relógio dos frames mesmo quando o modelo omite a parte de referência. */
export function referencePoseSamples(samples: PoseSample[], keypoint: string): PoseSample[] {
  const frames = new Map<number, PoseSample>();
  const points = new Map<number, PoseSample>();
  for (const sample of samples) {
    frames.set(sample.frameIndex, sample);
    if (sample.keypoint === keypoint) points.set(sample.frameIndex, sample);
  }
  return [...frames.values()].map((frame) => points.get(frame.frameIndex) ?? {
    frameIndex: frame.frameIndex, timestampSec: frame.timestampSec, keypoint,
    xPx: null, yPx: null, likelihood: 0, status: "missing" as const, source: "detected" as const,
  }).sort((a, b) => a.timestampSec - b.timestampSec || a.frameIndex - b.frameIndex);
}

export function qualityTimelineBins(samples: PoseSample[], duration: number, count = 120): PoseStatus[] {
  if (!samples.length || !(duration > 0) || count < 1) return [];
  const severity: Record<PoseStatus, number> = { valid: 0, low_confidence: 1, jump: 2, missing: 3, out_of_arena: 3 };
  const tolerance = 1.1 / inferredFps(samples);
  return Array.from({ length: count }, (_, index) => {
    const start = index / count * duration, end = (index + 1) / count * duration;
    const middle = (start + end) / 2;
    const nearest = samples.reduce((a, b) => Math.abs(a.timestampSec - middle) < Math.abs(b.timestampSec - middle) ? a : b);
    const nearby = Math.abs(nearest.timestampSec - middle) <= tolerance;
    const inBin = samples.filter((sample) => sample.timestampSec >= start && sample.timestampSec < end);
    if (nearby) inBin.push(nearest);
    return inBin.reduce<PoseStatus>((worst, sample) => {
      const status = sample.source === "recovered" && sample.status === "valid" ? "low_confidence" : sample.status;
      return severity[status] > severity[worst] ? status : worst;
    }, nearby ? "valid" : "missing");
  });
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
