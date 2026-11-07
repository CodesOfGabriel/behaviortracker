import type { BoundingBox, Point } from "../types";

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
