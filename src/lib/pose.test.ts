import { describe, expect, it } from "vitest";
import { parseCanonicalPoseCsv, poseToCsv } from "./csv";
import { confidenceLabel, drawablePose, inferredFps, metricEligible, originalPose, qualityTimelineBins, referencePoseSamples, trajectorySegments } from "./pose";
import { applyCorrections } from "./corrections";
import type { PoseSample } from "../types";

const header = "frame_index,timestamp_sec,animal_id,keypoint,x_px,y_px,likelihood,status";
const point = (frameIndex: number, overrides: Partial<PoseSample> = {}): PoseSample => ({
  frameIndex, timestampSec: frameIndex / 24, keypoint: "body_center", xPx: 100 + frameIndex,
  yPx: 200, likelihood: .9, status: "valid", ...overrides,
});

describe("timeline de qualidade usa o tempo real da seleção", () => {
  it("não pinta de verde o restante do vídeo quando faltam timestamps", () => {
    const bins=qualityTimelineBins([point(0),point(1)],1,24);
    expect(bins[0]).toBe("valid");
    expect(bins.at(-1)).toBe("missing");
  });
  it("preserva alertas curtos e a revisão pendente de recuperações", () => {
    const samples=Array.from({length:24},(_,i)=>point(i,i===12?{source:"recovered"}:{}));
    expect(qualityTimelineBins(samples,1,2)).toContain("low_confidence");
    expect(qualityTimelineBins(samples.map(p=>p.frameIndex===12?{...p,status:"missing"}:p),1,2)).toContain("missing");
  });
  it("preenche bins entre frames conhecidos, sem exigir uma amostra por pixel", () => {
    expect(qualityTimelineBins([point(0),point(1),point(2)],3/24,120).every(status=>status==="valid")).toBe(true);
  });
});

describe("poses com visibilidade parcial", () => {
  it("mostra recuperações por imagem para revisão sem promovê-las a métricas", () => {
    const csv = `${header},source,tracking_accepted,tracking_reason,processing_version,raw_x_px,raw_y_px,raw_likelihood,raw_status,raw_source\n1,.0625,animal_1,mouse_center,50,50,.9,low_confidence,recovered,true,visual_recovery_pending_review,pose-consensus-flow-2,,,.1,missing,detected`;
    const sample = parseCanonicalPoseCsv(poseToCsv(parseCanonicalPoseCsv(csv)))[0];
    expect(sample.source).toBe("recovered");
    expect(drawablePose(sample)).toBe(true);
    expect(metricEligible(sample)).toBe(false);
    expect(confidenceLabel(sample)).toBe("Revisar");
    expect(originalPose(sample)).toMatchObject({ xPx: null, yPx: null, status: "missing", source: "detected" });
    expect(metricEligible(originalPose(sample))).toBe(false);
    expect(referencePoseSamples([sample], "mouse_center")[0].xPx).toBeNull();
  });
  it("preserva a rejeição do consenso Colab na importação, exportação, desenho e métricas", () => {
    const csv = `${header},source,tracking_accepted,tracking_reason,processing_version\n0,0,animal_1,mouse_center,50,50,.99,low_confidence,detected,false,view_disagreement,pose-consensus-1`;
    const sample = parseCanonicalPoseCsv(csv)[0];
    expect(sample).toMatchObject({ xPx: 50, likelihood: .99, trackingAccepted: false,
      reason: "view_disagreement", processingVersion: "pose-consensus-1" });
    const restored = parseCanonicalPoseCsv(poseToCsv([sample]))[0];
    expect(drawablePose(restored)).toBe(false);
    expect(metricEligible(restored)).toBe(false);
    expect(drawablePose({ ...restored, source: "manual" })).toBe(true);
    expect(trajectorySegments([restored, { ...restored, frameIndex: 1 }])).toEqual([]);
  });
  it("não promove caixas previstas ou recuperadas ao construir a referência", () => {
    for (const source of ["predicted", "recovered"] as const) {
      for (const status of ["valid", "low_confidence"] as const) {
        const sample = point(0, { source, status, keypoint: "box_center", metricReference: "box_center",
          bbox: { x: 10, y: 20, width: 20, height: 10 } });
        const [reference] = referencePoseSamples([sample], "box_center");
        expect(reference.xPx).toBeNull();
        expect(metricEligible(reference)).toBe(false);
      }
    }
  });
  it("mantém a caixa do detector independente da pose, respeitando rejeição explícita do tracking", () => {
    const bbox = { x: 10, y: 20, width: 20, height: 10 };
    const uncertain = point(0, { source: "detected", status: "low_confidence", bbox });
    expect(referencePoseSamples([uncertain], "nose")[0].xPx).toBe(20);
    expect(referencePoseSamples([{ ...uncertain, trackingAccepted: false }], "nose")[0].xPx).toBeNull();
    const valid = referencePoseSamples([{ ...uncertain, status: "valid" }], "nose")[0];
    expect(valid.xPx).toBe(20);
    expect(metricEligible(valid)).toBe(true);
  });
  it("separa localização observada na borda da aprovação para métricas", () => {
    const sample = point(0, { source: "segmented", keypoint: "box_center", metricReference: "box_center",
      referenceApproved: true, spatialRegion: "floor", trackingAccepted: true,
      localQuality: { tracking: "observed", geometry: "boundary", reasons: ["near_wall_or_partial"] } });
    expect(metricEligible(sample)).toBe(false);
    const exported = parseCanonicalPoseCsv(poseToCsv([sample]))[0];
    expect(exported.localQuality).toEqual(sample.localQuality);
    expect(exported.trackingAccepted).toBe(true);
    expect(metricEligible(exported)).toBe(false);
    expect(metricEligible({ ...sample, localQuality: { tracking: "observed", geometry: "floor", reasons: [] } })).toBe(true);
    expect(metricEligible({ ...sample, trackingAccepted: false })).toBe(false);
    const [confirmed] = applyCorrections([sample], [{ id: "confirm-boundary", type: "CONFIRM_POINT", frameIndex: 0,
      keypoint: "box_center", source: "manual", createdAt: "now" }]);
    expect(metricEligible(confirmed)).toBe(true);
  });
  it("não transforma uma segmentação 2D não aprovada em detecção válida", () => {
    const segmented = point(0, { keypoint: "box_center", source: "segmented", metricReference: "box_center",
      referenceApproved: false, spatialRegion: "floor", likelihood: 0,
      bbox: { x: 90, y: 190, width: 20, height: 20 } });
    const [reference] = referencePoseSamples([segmented], "box_center");
    expect(metricEligible(reference)).toBe(false);
    expect(reference.xPx).toBeNull();
    expect(metricEligible({ ...segmented, referenceApproved: true })).toBe(true);
  });
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
    expect(parseCanonicalPoseCsv(poseToCsv(samples))).toMatchObject(samples);
  });

  it("mantém o original e a procedência em uma recuperação exportada", () => {
    const sample = point(1, { source: "recovered", original: { xPx: null, yPx: null, status: "missing", likelihood: 0 } });
    const [restored] = parseCanonicalPoseCsv(poseToCsv([sample]));
    expect(restored.source).toBe("recovered");
    expect(originalPose(restored)).toMatchObject({ xPx: null, yPx: null, status: "missing", likelihood: 0, source: "detected" });
    expect(metricEligible(restored)).toBe(false);
    const [confirmed] = applyCorrections([restored], [{ id: "confirm", type: "CONFIRM_POINT", createdAt: "now", source: "manual", frameIndex: 1, keypoint: "body_center" }]);
    expect(metricEligible(confirmed)).toBe(true);
    expect(originalPose(confirmed).xPx).toBeNull();
    expect(confidenceLabel(confirmed)).toBe("Manual");
  });

  it("preserva a versão C e permite comparar o centro filtrado com o bruto", () => {
    const filtered = point(1, { xPx: 105, processingVersion: "dlc-adapted-trajectory-c-1",
      reason: "temporal_smoothing", original: { xPx: 110, yPx: 200, likelihood: .9, status: "valid", source: "detected" } });
    const [restored] = parseCanonicalPoseCsv(poseToCsv([filtered]));
    expect(restored).toMatchObject({ xPx: 105, processingVersion: "dlc-adapted-trajectory-c-1", reason: "temporal_smoothing" });
    expect(originalPose(restored)).toMatchObject({ xPx: 110, processingVersion: "dlc-adapted-trajectory-c-1" });
    expect(metricEligible(restored)).toBe(true);
  });

  it("não permite transformar previsão ou ausência em observação apenas com confirmação", () => {
    const predicted = point(0, { source: "predicted" });
    const [unchanged] = applyCorrections([predicted], [{ id: "confirm", type: "CONFIRM_POINT", createdAt: "now", source: "manual", frameIndex: 0, keypoint: "body_center" }]);
    expect(metricEligible(unchanged)).toBe(false);
  });

  it("rejeita status desconhecido e recuperação sem original", () => {
    expect(() => parseCanonicalPoseCsv(`${header}\n0,0,animal_1,nose,1,2,.8,wrong`)).toThrow();
    expect(() => parseCanonicalPoseCsv(`${header},source\n0,0,animal_1,nose,1,2,.8,valid,recovered`)).toThrow();
  });

  it("usa o FPS dos timestamps em vez de assumir 30 FPS", () => {
    expect(inferredFps([point(0), point(1)], 30)).toBe(24);
  });
  it("confirmar um ponto já movido não perde a correção anterior", () => {
    const events = [{ id: "move", type: "MOVE_POINT" as const, createdAt: "now", source: "manual" as const, frameIndex: 0, keypoint: "body_center", after: { x: 50, y: 60 } },
      { id: "confirm", type: "CONFIRM_POINT" as const, createdAt: "now", source: "manual" as const, frameIndex: 0, keypoint: "body_center", before: { x: 50, y: 60 } }];
    expect(applyCorrections([point(0, { xPx: null, yPx: null, status: "missing" })], events)[0]).toMatchObject({ xPx: 50, yPx: 60, status: "valid", source: "manual" });
    expect(applyCorrections([point(0)], events.slice(1))[0].source).toBeUndefined();
    const legacy = applyCorrections([point(0)], events);
    expect(originalPose(parseCanonicalPoseCsv(poseToCsv(legacy))[0])).toMatchObject({ xPx: 100, yPx: 200 });
  });

  it("colunas extras vazias não inventam suporte anatômico para arquivos legados", () => {
    const [sample] = parseCanonicalPoseCsv(poseToCsv([point(0)]));
    expect(sample.supportCount).toBeUndefined();
    expect(sample.supportTotal).toBeUndefined();
  });
});
