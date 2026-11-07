import type { BoundingBox, Point } from "../types";

export function boxFromPoints(a: Point, b: Point): BoundingBox {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function translateBox(box: BoundingBox, delta: Point, width: number, height: number): BoundingBox {
  return { ...box, x: Math.max(0, Math.min(width - box.width, box.x + delta.x)),
    y: Math.max(0, Math.min(height - box.height, box.y + delta.y)) };
}
