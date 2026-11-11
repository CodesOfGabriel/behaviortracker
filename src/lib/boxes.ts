import type { BoundingBox, Point, PoseSample } from "../types";

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
