import { describe, expect, it } from "vitest";
import { humanReferenceCsv, parseValidationPilot, type HumanAnnotation } from "./validation";

describe("validation reference", () => {
  it("requires frame timestamps tied to a video hash", () => {
    const recording = { videoId: "video_1", protocol: "open_field", partition: "holdout",
      filename: "video.mp4", videoSha256: "a".repeat(64), width: 640, height: 480,
      timingSource: "ffprobe_best_effort_pts", frames: [{ frameIndex: 10, timestampSec: .4 }],
      clips: [{ clipIndex: 0, startFrame: 10, endFrame: 11, startSec: .4, endSec: .44,
        frames: [{ frameIndex: 10, timestampSec: .4 }] }] };
    expect(parseValidationPilot(JSON.stringify({ schemaVersion: 1, selectionVersion: "pilot-1", seed: 3, recordings: [recording] })).recordings[0].frames[0].frameIndex).toBe(10);
    expect(() => parseValidationPilot(JSON.stringify({ schemaVersion: 1, selectionVersion: "pilot-1", seed: 3,
      recordings: [{ ...recording, videoSha256: "prediction" }] }))).toThrow();
  });

  it("exports only explicitly approved visible human coordinates as eligible", () => {
    const base: HumanAnnotation = { id: "a", experimentId: "exp", videoSha256: "a".repeat(64),
      frameIndex: 2, timestampSec: .08, animalId: "animal_1", keypoint: "nose",
      xPx: 10, yPx: 12, visibility: "visible", annotatorId: "observer_1", status: "approved",
      reviewerId: "reviewer_1", revision: 2, createdAt: "now", updatedAt: "now" };
    const csv = humanReferenceCsv([base, { ...base, id: "b", frameIndex: 3, status: "draft", reviewerId: null }]);
    expect(csv).toContain("2,animal_1,nose,10,12,true,visible");
    expect(csv).toContain("3,animal_1,nose,10,12,false,visible");
  });
});
