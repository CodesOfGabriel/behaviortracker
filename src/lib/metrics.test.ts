import { describe, expect, it } from "vitest";
import { calculateOftMetrics } from "./metrics";
import type { ArenaConfig, PoseSample, PoseStatus } from "../types";

const arena: ArenaConfig = {
  revision: 1,
  cornersPx: [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 60 },
    { x: 0, y: 60 },
  ],
  widthCm: 60,
  heightCm: 60,
  centerAreaFraction: 0.25,
  boundaryPolicy: "center_inclusive",
};

function sample(frame: number, time: number, x: number | null, y: number | null, status: PoseStatus = "valid"): PoseSample {
  return {
    frameIndex: frame,
    timestampSec: time,
    keypoint: "body_center",
    xPx: x,
    yPx: y,
    likelihood: status === "missing" ? 0.1 : 0.99,
    status,
  };
}

describe("métricas OFT", () => {
  it("SCI-001: calcula distância 3-4-5 e velocidade pelo tempo observado", () => {
    const result = calculateOftMetrics([sample(0, 0, 0, 0), sample(1, 1, 3, 4)], arena, { maxPairGapSec: 2 });
    expect(result.distanceCm).toBeCloseTo(5, 8);
    expect(result.meanSpeedCmS).toBeCloseTo(5, 8);
  });

  it("SCI-002: não cria uma ponte através de ponto ausente", () => {
    const result = calculateOftMetrics([
      sample(0, 0, 0, 0),
      sample(1, 1, null, null, "missing"),
      sample(2, 2, 30, 40),
    ], arena, { maxPairGapSec: 2 });
    expect(result.distanceCm).toBeNull();
    expect(result.unknownTimeSec).toBeCloseTo(1, 8);
  });

  it("SCI-004: separa centro, periferia e tempo desconhecido", () => {
    const result = calculateOftMetrics([
      sample(0, 0, 30, 30),
      sample(1, 2, 5, 5),
      sample(2, 5, null, null, "missing"),
      sample(3, 6, 5, 5),
    ], arena, { maxPairGapSec: 4 });
    expect(result.centerTimeSec).toBeCloseTo(2, 8);
    expect(result.peripheralTimeSec).toBeCloseTo(3, 8);
    expect(result.unknownTimeSec).toBeCloseTo(1, 8);
    expect(result.centerPctClassifiable).toBeCloseTo(40, 8);
  });

  it("SCI-005: não conta entrada quando a sessão começa no centro", () => {
    const result = calculateOftMetrics([
      sample(0, 0, 30, 30),
      sample(1, 1, 31, 30),
      sample(2, 2, 5, 5),
    ], arena, { maxPairGapSec: 2 });
    expect(result.centerEntries).toBe(0);
    expect(result.centerLatencySec).toBeNull();
  });

  it("SCI-006: conta transições observáveis com dwell mínimo", () => {
    const result = calculateOftMetrics([
      sample(0, 0, 5, 5),
      sample(1, 1, 30, 30),
      sample(2, 2, 31, 30),
      sample(3, 3, 5, 5),
      sample(4, 4, 30, 30),
      sample(5, 5, 31, 30),
    ], arena, { maxPairGapSec: 2, minCenterDwellSec: 0.5 });
    expect(result.centerEntries).toBe(2);
    expect(result.centerLatencySec).toBeCloseTo(1, 8);
  });
});

