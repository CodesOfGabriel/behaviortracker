import { describe, expect, it } from "vitest";
import type { CorrectionEvent, Experiment } from "../types";
import { localGuidance, usableLocalGuidance } from "./manual-guidance";

const box = (x: number) => ({ x, y: 20, width: 30, height: 20 });
const event = (id: string, frameIndex: number, timestampSec: number, x: number, reviewSource = "opencv:source"): CorrectionEvent => ({
  id, type: "SET_BOX", source: "manual", createdAt: "2026-11-07T00:00:00Z", frameIndex, timestampSec,
  keypoint: "box_center", afterBox: box(x), reviewSource,
});
const experiment = (corrections: CorrectionEvent[]): Experiment => ({
  id: "experiment", schemaVersion: "1.0", analysisMethodVersion: "oft-0.2", title: "Teste", subjectId: "rato-1",
  testType: "open_field", status: "review", createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z",
  video: { filename: "animal.mp4", sizeBytes: 100, width: 320, height: 240, durationSec: 20, fps: 20, timingSource: "ffprobe" },
  arena: { revision: 1, cornersPx: [{ x: 0, y: 0 }, { x: 320, y: 0 }, { x: 320, y: 240 }, { x: 0, y: 240 }],
    widthCm: 50, heightCm: 50, centerAreaFraction: .25, boundaryPolicy: "center_inclusive" },
  referencePoint: "box_center", trackingSelection: { engine: "opencv", jobId: "source" }, corrections,
});

describe("continuação local com caixas humanas", () => {
  it("usa apenas quadros-chave ativos da execução selecionada", () => {
    const first = event("first", 0, 0, 40);
    const old = event("old", 20, 1, 50);
    const latest = event("latest", 20, 1, 60);
    const excluded = event("excluded", 30, 1.5, 70);
    const input = experiment([
      event("other-run", 50, 2.5, 80, "opencv:other"), first, old, latest, excluded,
      { id: "undo", type: "REVERT_EVENT", source: "manual", createdAt: "now", targetEventId: excluded.id, reviewSource: "opencv:source" },
      { id: "confirm", type: "CONFIRM_POINT", source: "manual", createdAt: "now", frameIndex: 20,
        timestampSec: 1, keypoint: "box_center", reviewSource: "opencv:source" },
    ]);
    const guidance = localGuidance(input);
    expect(guidance).toEqual({ sourceJobId: "source", anchors: [
      { frameIndex: 0, timestampSec: 0, box: first.afterBox, eventId: "first" },
      { frameIndex: 20, timestampSec: 1, box: latest.afterBox, eventId: "latest" },
    ] });
    expect(usableLocalGuidance(guidance)).toBe(true);
    expect(input.corrections).toHaveLength(7);
  });

  it("não transforma interpolação, caixa apagada ou revisão de outra origem em treino", () => {
    const input = experiment([event("first", 0, 0, 40), event("second", 10, .5, 50),
      { id: "missing", type: "MARK_MISSING", source: "manual", createdAt: "now", frameIndex: 10,
        timestampSec: .5, keypoint: "box_center", reviewSource: "opencv:source" },
      event("outside", 20, 1, 400)]);
    expect(localGuidance(input)?.anchors.map(anchor => anchor.eventId)).toEqual(["first"]);
    expect(usableLocalGuidance(localGuidance(input))).toBe(false);
    input.trackingSelection = { engine: "colab", jobId: "source" };
    expect(localGuidance(input)).toBeNull();
  });
});
