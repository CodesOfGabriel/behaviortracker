import { expect, it } from "vitest";
import type { VideoPreparation } from "../../types";
import { defaultArena } from "../../lib/demo-data";
import { preparedGeometry, scaleArenaToUpload, scalePoseToOriginal, scaleTanksToUpload } from "./videoGeometry";

const video = { width: 3840, height: 2160 };
const preparation: VideoPreparation = { uploadId: "prepared", originalBytes: 120_000_000, uploadBytes: 30_000_000,
  status: "optimized", message: "", policyVersion: "quality-upload-2", pixelVerified: false, frameCount: 100,
  uploadWidth: 1920, uploadHeight: 1080 };

it("converte marcações para 1080p e devolve poses ao sistema de coordenadas original", () => {
  expect(preparedGeometry(video, preparation)).toMatchObject({ width: 1920, height: 1080, scaleX: 0.5, scaleY: 0.5 });
  const arena = scaleArenaToUpload(defaultArena, video, preparation);
  expect(arena.cornersPx[0].x).toBe(defaultArena.cornersPx[0].x / 2);
  const tank = scaleTanksToUpload([{ tankId: "tank_1", animalId: "animal_1", subjectId: "R1", revision: 1,
    roiPx: { x: 200, y: 100, width: 1000, height: 1800 } }], video, preparation)[0];
  expect(tank.roiPx).toEqual({ x: 100, y: 50, width: 500, height: 900 });
  const samples = scalePoseToOriginal([{ frameIndex: 0, timestampSec: 0, keypoint: "nose", xPx: 120, yPx: 240,
    likelihood: 0.9, status: "valid", bbox: { x: 100, y: 200, width: 60, height: 80 },
    original: { xPx: 110, yPx: 230, likelihood: 0.8, status: "valid" } }], video, preparation);
  expect(samples[0]).toMatchObject({ xPx: 240, yPx: 480, bbox: { x: 200, y: 400, width: 120, height: 160 },
    original: { xPx: 220, yPx: 460 } });
});
