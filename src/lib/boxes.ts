import type { BoundingBox, Point, PoseSample } from "../types";

export type BoxTrajectoryState = "observed" | "uncertain" | "recovered" | "predicted";
export type BoxTrajectorySegment = { state: BoxTrajectoryState; points: Point[] };
export const boxTrajectoryStyle = {
  observed: { color: "#218381", dash: undefined },
  uncertain: { color: "#b78532", dash: undefined },
  recovered: { color: "#9766b4", dash: "7 5" },
  predicted: { color: "#9766b4", dash: "3 5" },
} as const;

/** Visualização das caixas exibidas, independente da elegibilidade científica.
 * Não interpola perdas e conserva a origem e os alertas de cada observação.
 */
export function boxCenterTrajectory(samples: readonly PoseSample[], width: number, height: number, expectedFrames = 0) {
  const frames = new Map<number, PoseSample>();
  const priority = (sample: PoseSample) => sample.source === "manual" ? 4
    : sample.source === "predicted" ? 1 : sample.source === "recovered" ? 2 : 3;
  let lastFrame = -1;
  for (const sample of samples) {
    if (!Number.isInteger(sample.frameIndex) || sample.frameIndex < 0) continue;
    lastFrame = Math.max(lastFrame, sample.frameIndex);
    const box = sample.bbox;
    if (!box || ![box.x, box.y, box.width, box.height, sample.timestampSec].every(Number.isFinite)
      || box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0
      || box.x+box.width > width+1 || box.y+box.height > height+1
      || sample.status === "missing" && sample.source !== "detected") continue;
    const existing = frames.get(sample.frameIndex);
    if (!existing || priority(sample) > priority(existing)) frames.set(sample.frameIndex, {
      ...sample, xPx: box.x+box.width/2, yPx: box.y+box.height/2,
    });
  }
  const centers = [...frames.values()].sort((a, b) => a.frameIndex-b.frameIndex);
  const state = (sample: PoseSample): BoxTrajectoryState => sample.source === "predicted" ? "predicted"
    : sample.source === "recovered" ? "recovered"
      : sample.source === "manual" && sample.status === "valid" ? "observed"
        : sample.status !== "valid" || sample.trackingAccepted === false || sample.reason === "camera_shift"
          || sample.spatialRegion === "outside" || sample.localQuality?.tracking === "uncertain"
        ? "uncertain" : "observed";
  const severity: Record<BoxTrajectoryState, number> = { observed: 0, uncertain: 1, recovered: 2, predicted: 3 };
  const segments: BoxTrajectorySegment[] = [];
  let previous: PoseSample | undefined;
  for (const sample of centers) {
    const point = { x: sample.xPx!, y: sample.yPx! };
    const dt = previous ? sample.timestampSec-previous.timestampSec : 0;
    const continuous = previous && sample.frameIndex === previous.frameIndex+1 && dt > 0 && dt <= .5;
    if (previous && continuous) {
      const kind = severity[state(previous)] > severity[state(sample)] ? state(previous) : state(sample);
      const current = segments.at(-1);
      if (current?.state === kind) current.points.push(point);
      else {
        if (current?.points.length === 1) segments.pop();
        segments.push({ state: kind, points: [{ x: previous.xPx!, y: previous.yPx! }, point] });
      }
    } else segments.push({ state: state(sample), points: [point] });
    previous = sample;
  }
  const totalFrames = Math.max(lastFrame+1, expectedFrames > 0 && Number.isInteger(expectedFrames) ? expectedFrames : 0);
  return { centers, segments, boxFrames: centers.length, totalFrames,
    uncertainFrames: centers.filter(sample => state(sample) === "uncertain").length,
    predictedFrames: centers.filter(sample => ["predicted", "recovered"].includes(state(sample))).length };
}

export function detectorTrajectory(samples: PoseSample[], width: number, height: number, expectedFrames = 0) {
  const centers = new Map<number, Point>();
  let lastFrame = -1;
  for (const sample of samples) {
    const frame = sample.frameIndex;
    if (!Number.isInteger(frame) || frame < 0) continue;
    lastFrame = Math.max(lastFrame, frame);
    if (centers.has(frame) || (sample.source != null && sample.source !== "detected")) continue;
    const box = sample.bbox;
    if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)
      || box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0
      || box.x + box.width > width + 1 || box.y + box.height > height + 1) continue;
    centers.set(frame, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  const totalFrames = Math.max(lastFrame + 1, Number.isInteger(expectedFrames) && expectedFrames > 0 ? expectedFrames : 0);
  const segments: Point[][] = [];
  let current: Point[] = [];
  let previousFrame = -2;
  for (const [frame, point] of [...centers].sort(([a], [b]) => a - b)) {
    if (frame !== previousFrame + 1) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(point);
    previousFrame = frame;
  }
  if (current.length > 1) segments.push(current);
  return {
    segments,
    observedFrames: centers.size,
    totalFrames,
    coveragePct: totalFrames > 0 ? centers.size / totalFrames * 100 : 0,
  };
}

export function boxFromPoints(a: Point, b: Point): BoundingBox {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function translateBox(box: BoundingBox, delta: Point, width: number, height: number): BoundingBox {
  return { ...box, x: Math.max(0, Math.min(width - box.width, box.x + delta.x)),
    y: Math.max(0, Math.min(height - box.height, box.y + delta.y)) };
}

/** Primeira seleção por clique: só posiciona uma caixa ajustável, não detecta o animal. */
export function provisionalBoxAt(point: Point, width: number, height: number): BoundingBox {
  const boxWidth = Math.min(width, Math.max(12, width * .1));
  const boxHeight = Math.min(height, Math.max(12, height * .1));
  return {
    x: Math.max(0, Math.min(width - boxWidth, point.x - boxWidth / 2)),
    y: Math.max(0, Math.min(height - boxHeight, point.y - boxHeight / 2)),
    width: boxWidth,
    height: boxHeight,
  };
}
