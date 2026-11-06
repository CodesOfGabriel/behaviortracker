import { describe, expect, it } from "vitest";
import { calculateHomography, centerPolygonPx, transformPoint, validateArenaCorners } from "./geometry";
import type { ArenaConfig } from "../types";

const squareArena: ArenaConfig = {
  revision: 1,
  cornersPx: [
    { x: 0, y: 0 },
    { x: 600, y: 0 },
    { x: 600, y: 600 },
    { x: 0, y: 600 },
  ],
  widthCm: 60,
  heightCm: 60,
  centerAreaFraction: 0.25,
  boundaryPolicy: "center_inclusive",
};

describe("geometria da arena", () => {
  it("reprojeta os quatro cantos com precisão numérica", () => {
    const source = [
      { x: 120, y: 80 },
      { x: 520, y: 100 },
      { x: 570, y: 460 },
      { x: 70, y: 440 },
    ];
    const destination = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 0, y: 60 },
    ];
    const matrix = calculateHomography(source, destination);
    source.forEach((point, index) => {
      const projected = transformPoint(point, matrix);
      expect(projected.x).toBeCloseTo(destination[index].x, 7);
      expect(projected.y).toBeCloseTo(destination[index].y, 7);
    });
  });

  it("define centro de 25% da área como 30 × 30 cm em arena 60 × 60", () => {
    expect(centerPolygonPx(squareArena)).toEqual([
      { x: 150, y: 150 },
      { x: 450, y: 150 },
      { x: 450, y: 450 },
      { x: 150, y: 450 },
    ]);
  });

  it("recusa quadrilátero cruzado", () => {
    const error = validateArenaCorners([
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    ]);
    expect(error).toMatch(/cruzam|cruzado/);
  });
});

