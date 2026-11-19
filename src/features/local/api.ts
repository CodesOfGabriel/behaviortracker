import { invoke } from "@tauri-apps/api/core";
import type { PoseSample } from "../../types";

export type LocalEnvironment = { ready: boolean; version?: string; message?: string; openclAvailable?: boolean };
export type LocalJob = {
  jobId: string;
  experimentId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  createdAt: string;
  videoSha256: string;
  uploadId: string;
  config: Record<string, unknown>;
  report: { phase?: string; referenceFrames?: number; framesProcessed?: number; totalFrames?: number; processingFps?: number; observationCoveragePct?: number; computeBackend?: string;
    cameraMotionState?: "stable" | "drift" | "unavailable"; cameraUncertainFrames?: number; cameraMotionPx?: number | null };
};

export const loadLocalResult = (jobId: string) => invoke<PoseSample[]>("get_local_tracking_result", { jobId });
export const getLocalEnvironment = () => invoke<LocalEnvironment>("get_local_tracking_environment");
export const setupLocalEnvironment = () => invoke<LocalEnvironment>("setup_local_tracking_environment");
export const listLocalJobs = (experimentId: string) => invoke<LocalJob[]>("list_local_tracking_jobs", { experimentId });
export const startLocalJob = (experimentId: string, uploadId: string, config: Record<string, unknown>) =>
  invoke<LocalJob>("start_local_tracking", { experimentId, uploadId, config });
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
