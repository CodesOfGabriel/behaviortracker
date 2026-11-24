import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { parseCanonicalPoseCsv } from "../../lib/csv";
import type { ArenaConfig, CorrectionEvent, PoseSample, VideoPreparation } from "../../types";
import type { HybridBundleId } from "../colab/analysis";
import { scalePoseToOriginal } from "../colab/videoGeometry";

export type LocalEnvironment = { ready: boolean; version?: string; message?: string; openclAvailable?: boolean };
export type LocalJob = {
  jobId: string;
  experimentId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  createdAt: string;
  videoSha256: string;
  uploadId: string;
  config: Record<string, unknown> & { videoPreparation?: VideoPreparation };
  report: { phase?: string; referenceFrames?: number; framesProcessed?: number | null; totalFrames?: number | null; processingFps?: number | null; observationCoveragePct?: number; computeBackend?: string;
    segmentationSelection?: { mode: "dark" | "light"; threshold: number; sampledFrames: number; inspectedFrames?: number; validFrames?: number; method: string } | null;
    cameraMotionState?: "stable" | "drift" | "unavailable"; cameraUncertainFrames?: number; cameraMotionPx?: number | null };
};

export const loadLocalResult = (jobId: string) => invoke<PoseSample[]>("get_local_tracking_result", { jobId });
export async function loadLocalOpenFieldResult(jobId: string) {
  const result = await invoke<{ csv: string; width: number; height: number; preparation: VideoPreparation } | null>(
    "get_local_wistar_result", { jobId },
  );
  return result ? scalePoseToOriginal(parseCanonicalPoseCsv(result.csv), result, result.preparation) : loadLocalResult(jobId);
}
export async function loadLocalAuditVideo(jobId: string, render = false) {
  const { videoPath, videoError } = await invoke<{ videoPath: string | null; videoError: string | null }>(
    "get_local_audit_video", { jobId, render },
  );
  return { videoUrl: videoPath ? convertFileSrc(videoPath) : null, videoError };
}
export const getLocalEnvironment = () => invoke<LocalEnvironment>("get_local_tracking_environment");
export const setupLocalEnvironment = () => invoke<LocalEnvironment>("setup_local_tracking_environment");
export const listLocalJobs = (experimentId: string) => invoke<LocalJob[]>("list_local_tracking_jobs", { experimentId });
export const startLocalJob = (experimentId: string, uploadId: string, config: Record<string, unknown>,
  videoOptions?: { optimizeVideo: boolean; expectedVideoSha256?: string }) =>
  invoke<LocalJob>("start_local_tracking", { experimentId, uploadId, config, ...videoOptions });
export const startLocalWistar = (experimentId: string, uploadId: string, originalSha256: string,
  original: { width: number; height: number }, arena: ArenaConfig & { videoWidth: number; videoHeight: number },
  modelBundleId: HybridBundleId) =>
  invoke<LocalJob>("start_local_wistar", { experimentId, uploadId, originalSha256,
    width: original.width, height: original.height, arena, modelBundleId });
export const cancelLocalJob = (jobId: string) => invoke<void>("cancel_local_tracking", { jobId });
export type LocalFstResult = {
  schemaVersion: "fst-local-presence-1"; protocol: "forced_swim"; engineId: string;
  analysisStatus: "EXPERIMENTAL_NOT_FOR_BEHAVIOR"; runId: string;
  video: { sha256: string; width: number; height: number; fps: number; frameCount: number };
  subjects: { animalId: string; subjectId: string }[];
  tanks: { animalId: string; roiPx: { x: number; y: number; width: number; height: number } }[];
  frames: { frame: number; timestampSec: number; animalId: string; presence: "IN_TANK" | "NOT_IN_TANK" | "UNCERTAIN";
    classification: "NOT_CLASSIFIED"; bodyScore: number; bbox: { x: number; y: number; width: number; height: number } | null }[];
  behaviorMetrics: null;
};
export const startLocalFst = (experimentId: string, uploadId: string, config: Record<string, unknown>) =>
  invoke<LocalJob>("start_local_fst", { experimentId, uploadId, config });
export const loadLocalFstResult = (jobId: string) => invoke<LocalFstResult>("get_local_fst_result", { jobId });

export const listRamReviewEvents = (jobId: string) => invoke<CorrectionEvent[]>("list_ram_review_events", { jobId });
export const appendRamReviewEvent = (jobId: string, event: CorrectionEvent) => invoke<void>("append_ram_review_event", { jobId, event });
