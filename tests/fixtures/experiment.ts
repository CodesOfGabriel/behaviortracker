import { makeDemoExperiment } from "../../src/lib/demo-data";
import type { LocalJob } from "../../src/features/local/api";
import type { PoseSample } from "../../src/types";

/** Synthetic, generic fixtures. They contain no researcher data or real video. */
export function experimentFixture() {
  const experiment = makeDemoExperiment("00000000-0000-4000-8000-000000000001")
  experiment.id = "ui-open-field";
  experiment.title = "Campo aberto de teste";
  experiment.subjectId = "subject-01";
  experiment.group = undefined;
  experiment.notes = undefined;
  experiment.createdAt = experiment.updatedAt = "2026-01-01T12:00:00Z";
  experiment.video = { filename: "fixture.mp4", sizeBytes: 4096, width: 640, height: 480,
    durationSec: 2, fps: 25, timingSource: "ffprobe", sha256: "a".repeat(64) };
  experiment.arena = { revision: 1, cornersPx: [{ x: 0, y: 0 }, { x: 640, y: 0 }, { x: 640, y: 480 }, { x: 0, y: 480 }],
    widthCm: 60, heightCm: 45, centerAreaFraction: .25, boundaryPolicy: "center_inclusive" };
  experiment.trackingSelection = { engine: "opencv", jobId: "tracking-01" };
  return experiment;
}

export function jobFixture(state: LocalJob["state"] = "succeeded"): LocalJob {
  return { jobId: "tracking-01", experimentId: "ui-open-field", uploadId: "original-01", state,
    error: null, createdAt: "2026-01-01T12:00:00Z", videoSha256: "a".repeat(64),
    config: { protocol: "open_field", strategy: "classical_roi_v1", width: 640, height: 480 },
    report: { computeBackend: "CPU", framesProcessed: 50, totalFrames: 50, elapsedSec: 2 } };
}

export const sampleFixture = (): PoseSample[] => Array.from({ length: 50 }, (_, index) => ({
  frameIndex: index, timestampSec: index / 25, keypoint: "box_center", xPx: 310 + index / 2, yPx: 240,
  likelihood: 0, status: "low_confidence", source: "segmented", referenceApproved: false,
  metricReference: "box_center", trackingAccepted: true, spatialRegion: "floor",
  localQuality: { tracking: "observed", geometry: "floor", reasons: [] },
  bbox: { x: 280 + index / 2, y: 225, width: 60, height: 30 },
}));
