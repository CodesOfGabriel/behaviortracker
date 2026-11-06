import { describe, expect, it } from "vitest";
import { behaviorCandidates, behaviorEpisodes, behaviorSummary } from "./behaviors";
import type { CorrectionEvent, Experiment, PoseSample } from "../types";
import { makeDemoExperiment } from "./demo-data";

const event = (id: string, startSec: number, endSec: number, label: "rearing" | "grooming" | "freezing" = "rearing"): CorrectionEvent =>
  ({ id, startSec, endSec, label, type: "ANNOTATE_BEHAVIOR", source: "manual", createdAt: "now" });
const poses = (frames = 36) => Array.from({ length: frames }, (_, frameIndex) =>
  [["body_center", 50, 50], ["nose", 50, 30], ["tail_base", 50, 70], ["left_ear", 45, 35], ["right_ear", 55, 35]].map(([keypoint, x, y]): PoseSample =>
    ({ frameIndex, timestampSec: frameIndex / 24, keypoint: String(keypoint), xPx: Number(x), yPx: Number(y), likelihood: .9, status: "valid", spatialRegion: "floor" }))).flat();

describe("comportamentos com revisão humana", () => {
  it("une sobreposições por classe e aplica limites do vídeo", () => {
    expect(behaviorEpisodes([event("a", 0, 2), event("b", 1, 4), event("c", 4, 5), event("d", 2, 3, "grooming"), event("e", 20, 30)], 10))
      .toEqual([{ label: "rearing", startSec: 0, endSec: 5 }, { label: "grooming", startSec: 2, endSec: 3 }]);
  });
  it("desfazer remove o episódio das métricas, mas não do histórico", () => {
    const events: CorrectionEvent[] = [event("a", 0, 2), { id: "undo", type: "REVERT_EVENT", targetEventId: "a", source: "manual", createdAt: "now" }];
    expect(behaviorEpisodes(events, 10)).toEqual([]);
    expect(events).toHaveLength(2);
  });
  it("distingue não anotado de zero após revisão completa", () => {
    const experiment = { ...makeDemoExperiment(), corrections: [], behaviorReviewed: { rearing: true } } as Experiment;
    const summary = behaviorSummary(experiment, 10);
    expect(summary.find((item) => item.label === "rearing")!.count).toBe(0);
    expect(summary.find((item) => item.label === "grooming")!.count).toBeNull();
  });
  it("gera só candidato de baixa movimentação e não o conta como freezing confirmado", () => {
    const candidates = behaviorCandidates(poses());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].label).toBe("freezing");
    expect(behaviorEpisodes([], 10)).toHaveLength(0);
  });
  it("não sugere freezing com partes ausentes, baixa confiança ou pontos previstos", () => {
    for (const override of [{ source: "predicted" as const }, { source: "recovered" as const }, { status: "low_confidence" as const }, { xPx: null, status: "missing" as const }]) {
      expect(behaviorCandidates(poses().map((point) => point.keypoint === "nose" ? { ...point, ...override } : point))).toEqual([]);
    }
  });
  it("não une sequências separadas por frames ausentes", () => {
    const input = poses().filter((point) => point.frameIndex !== 18);
    expect(behaviorCandidates(input)).toEqual([]);
  });
  it("projeção da parede sozinha não basta para sugerir rearing", () => {
    expect(behaviorCandidates(poses().map((point) => ({ ...point, spatialRegion: "wall_projection" }))).filter((item) => item.label === "rearing")).toEqual([]);
  });
  it("não sugere grooming sem patas anteriores observadas", () => {
    expect(behaviorCandidates(poses()).filter((item) => item.label === "grooming")).toEqual([]);
  });
  it("sugere revisar grooming quando há movimento de pata junto ao focinho", () => {
    const samples = poses();
    const paw = samples.filter((point) => point.keypoint === "nose").map((point) =>
      ({ ...point, keypoint: "left_forepaw", xPx: point.xPx! + (point.frameIndex % 2 ? 3 : -3), yPx: point.yPx! + 2 }));
    expect(behaviorCandidates([...samples, ...paw]).some((item) => item.label === "grooming")).toBe(true);
  });
  it("usa encurtamento corporal junto ao contexto da parede apenas como sugestão", () => {
    const samples = poses(96).map((point) => point.keypoint === "nose" && point.frameIndex >= 60
      ? { ...point, yPx: 50, spatialRegion: "wall_projection" as const } : point);
    expect(behaviorCandidates(samples).some((item) => item.label === "rearing")).toBe(true);
  });
});
