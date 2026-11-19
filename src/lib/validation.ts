export type ValidationFrame = { frameIndex: number; timestampSec: number; reviewCategory?: string };
export type ValidationClip = { clipIndex: number; startFrame: number; endFrame: number; startSec: number; endSec: number; frames: ValidationFrame[]; reviewCategory?: string };
export type ValidationRecording = {
  videoId: string; protocol: string; partition: "development" | "holdout";
  filename: string; videoSha256: string; width: number; height: number;
  timingSource: "ffprobe_best_effort_pts"; frames: ValidationFrame[]; clips: ValidationClip[];
};
export type ValidationPilot = { schemaVersion: 1; selectionVersion: string; seed: number; recordings: ValidationRecording[] };
export type HumanAnnotation = {
  id: string; experimentId: string; videoSha256: string; frameIndex: number; timestampSec: number;
  animalId: string; keypoint: string; xPx: number | null; yPx: number | null;
  visibility: "visible" | "occluded" | "not_visible" | "uncertain";
  annotatorId: string; status: "draft" | "submitted" | "approved" | "rejected";
  reviewerId: string | null; revision: number; createdAt: string; updatedAt: string;
};
export type HumanAnnotationRevision = HumanAnnotation & { supersededAt: string };

function frame(value: unknown): value is ValidationFrame {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.frameIndex === "number" && Number.isSafeInteger(item.frameIndex) && item.frameIndex >= 0
    && typeof item.timestampSec === "number" && Number.isFinite(item.timestampSec) && item.timestampSec >= 0;
}

export function parseValidationPilot(text: string): ValidationPilot {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("Manifesto de validação inválido.");
  const pilot = value as ValidationPilot;
  if (pilot.schemaVersion !== 1 || !Array.isArray(pilot.recordings) || !pilot.recordings.length
    || typeof pilot.selectionVersion !== "string" || !Number.isSafeInteger(pilot.seed)) {
    throw new Error("Manifesto de validação incompatível.");
  }
  for (const recording of pilot.recordings) {
    if (!/^[a-f0-9]{64}$/i.test(recording.videoSha256) || !["development", "holdout"].includes(recording.partition)
      || recording.timingSource !== "ffprobe_best_effort_pts" || !Number.isSafeInteger(recording.width)
      || !Number.isSafeInteger(recording.height) || !Array.isArray(recording.frames)
      || !recording.frames.length || !recording.frames.every(frame) || !Array.isArray(recording.clips)
      || recording.clips.some(clip => !Array.isArray(clip.frames) || !clip.frames.length || !clip.frames.every(frame))) {
      throw new Error("Vídeo ou frames inválidos no manifesto de validação.");
    }
  }
  return pilot;
}

function cell(value: string | number | null | undefined): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function humanReferenceCsv(annotations: HumanAnnotation[]): string {
  const header = ["frame_index", "animal_id", "keypoint", "x_px", "y_px", "approved", "visibility",
    "annotator_id", "reviewer_id", "video_sha256", "experiment_id", "timestamp_sec", "annotation_id", "revision", "status", "annotation_source"];
  const rows = annotations.map(item => [item.frameIndex, item.animalId, item.keypoint, item.xPx,
    item.yPx, item.status === "approved" ? "true" : "false", item.visibility, item.annotatorId,
    item.reviewerId, item.videoSha256, item.experimentId, item.timestampSec, item.id, item.revision, item.status, "human"]);
  return [header, ...rows].map(row => row.map(cell).join(",")).join("\n") + "\n";
}
