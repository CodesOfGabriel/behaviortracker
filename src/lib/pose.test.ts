import { describe, expect, it } from "vitest";
import { parseCanonicalPoseCsv, poseToCsv } from "./csv";
import { confidenceLabel, drawablePose, trajectorySegments } from "./pose";
import { applyCorrections } from "./corrections";
import type { PoseSample } from "../types";

const header = "frame_index,timestamp_sec,animal_id,keypoint,x_px,y_px,likelihood,status";
const point = (frameIndex: number, overrides: Partial<PoseSample> = {}): PoseSample => ({
  frameIndex, timestampSec: frameIndex / 24, keypoint: "body_center", xPx: 100 + frameIndex,
  yPx: 200, likelihood: .9, status: "valid", ...overrides,
});

describe("poses com visibilidade parcial", () => {
  it("normaliza sentinelas de arquivos antigos sem desenhar -1 nem mostrar -100%", () => {
    const [sample] = parseCanonicalPoseCsv(`${header}\n152,6.333,animal_1,body_center,-1,-1,-1,missing`);
    expect(sample.xPx).toBeNull();
    expect(sample.yPx).toBeNull();
    expect(confidenceLabel(sample)).toBe("—");
    expect(drawablePose(sample)).toBe(false);
  });

  it("preserva o ponto de baixa confiança sem fingir que a posição está errada", () => {
    const [sample] = parseCanonicalPoseCsv(`${header}\n1024,42.667,animal_1,body_center,388.6,494.8,.548,low_confidence`);
    expect(drawablePose(sample)).toBe(true);
    expect(confidenceLabel(sample)).toBe("55%");
    expect(sample.status).toBe("low_confidence");
  });

  it("mantém os outros pontos quando apenas uma parte não foi detectada", () => {
    const samples = parseCanonicalPoseCsv(`${header}\n1,.04,animal_1,nose,300,400,.8,valid\n1,.04,animal_1,left_ear,-1,-1,-1,missing`);
    expect(samples.filter(drawablePose).map((sample) => sample.keypoint)).toEqual(["nose"]);
    expect(samples).toHaveLength(2);
  });

  it("não liga a trajetória através de lacunas, sentinelas ou saltos", () => {
    const samples = [point(0), point(1), point(2, { xPx: -1, yPx: -1, status: "missing" }),
      point(3), point(4), point(5, { status: "jump" }), point(6), point(7), point(9), point(10)];
    expect(trajectorySegments(samples).map((segment) => segment.map((value) => value.x))).toEqual([
      [100, 101], [103, 104], [106, 107], [109, 110],
    ]);
  });

  it("uma correção manual não inventa score do modelo para permitir desenhar o ponto", () => {
    const corrected = point(0, { likelihood: 0 });
    expect(drawablePose(corrected)).toBe(true);
    expect(confidenceLabel(corrected)).toBe("—");
  });

  it("não mantém a região do modelo depois de mover o ponto manualmente", () => {
    const [corrected] = applyCorrections([point(0, { spatialRegion: "floor" })], [{
      id: "move", type: "MOVE_POINT", createdAt: "2026-11-06T20:00:00Z", frameIndex: 0,
      keypoint: "body_center", after: { x: 500, y: 500 }, source: "manual",
    }]);
    expect(corrected.spatialRegion).toBe("unknown");
    expect(corrected.likelihood).toBe(.9);
  });

  it("preserva suporte parcial e região projetada no contrato e na exportação", () => {
    const csv = `${header},spatial_region,support_count,support_total\n0,0,animal_1,body_center,300,400,.9,low_confidence,wall_projection,1,3`;
    const samples = parseCanonicalPoseCsv(csv);
    expect(samples[0]).toMatchObject({ spatialRegion: "wall_projection", supportCount: 1, supportTotal: 3, status: "low_confidence" });
    expect(parseCanonicalPoseCsv(poseToCsv(samples))).toEqual(samples);
  });

  it("colunas extras vazias não inventam suporte anatômico para arquivos legados", () => {
    const [sample] = parseCanonicalPoseCsv(poseToCsv([point(0)]));
    expect(sample.supportCount).toBeUndefined();
    expect(sample.supportTotal).toBeUndefined();
  });
});
