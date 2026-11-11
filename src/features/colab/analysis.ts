import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ArenaConfig, VideoPreparation } from "../../types";

const STAGING_CHUNK_SIZE = 4 * 1024 * 1024;
export type HybridBundleId = "wistar_df_v1" | "wistar_df_v2";
export const LATEST_HYBRID_BUNDLE_ID: HybridBundleId = "wistar_df_v2";
export type HybridBundleStatus = { bundleId: HybridBundleId; installed: boolean; error: string | null };

export function getHybridBundleStatus(bundleId: HybridBundleId) {
  return invoke<HybridBundleStatus>("hybrid_bundle_status", { bundleId });
}

export function getHybridBundleAvailability(bundleId: HybridBundleId) {
  return invoke<HybridBundleStatus>("hybrid_bundle_available", { bundleId });
}

export function importHybridBundle(bundleId: HybridBundleId, sourceDirectory: string) {
  return invoke<HybridBundleStatus>("import_hybrid_bundle", { bundleId, sourceDirectory });
}

export type ColabJob = {
  jobId: string;
  experimentId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  stage: string;
  progress: number;
  message: string;
  runtimeName: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  events: ColabJobEvent[];
  diagnostic?: DiagnosticRange | null;
  resultsReady?: boolean;
  training?: boolean;
  customModel?: boolean;
  engineId?: "superanimal_video_adapt_b_legacy" | "wistar_superanimal_hybrid_v1";
  modelBundleId?: string | null;
};

export type DiagnosticRange = { startSec: number; endSec: number };

export type ColabJobEvent = {
  id: number;
  stage: string;
  status: ColabJob["status"];
  progress: number;
  message: string;
  createdAt: string;
};

type VideoStaging = {
  uploadId: string;
  expectedSize: number;
  receivedSize: number;
};

export function checkVideoStaging(experimentId: string, uploadId: string) {
  return invoke<boolean>("check_video_staging", { experimentId, uploadId });
}

export async function stageVideo(
  experimentId: string,
  file: File,
  onProgress: (progress: number, message: string) => void,
) {
  const staging = await invoke<VideoStaging>("begin_video_staging", {
    experimentId,
    filename: file.name,
    expectedSize: file.size,
  });

  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + STAGING_CHUNK_SIZE, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    await invoke<VideoStaging>("append_video_staging_raw", bytes, {
      headers: { "x-upload-id": staging.uploadId, "x-offset": String(offset) },
    });
    offset = end;
    onProgress(
      Math.round((offset / file.size) * 100),
      `Preparando vídeo no desktop · ${Math.round((offset / file.size) * 100)}%`,
    );
  }

  await invoke<VideoStaging>("finish_video_staging", { uploadId: staging.uploadId });
  return staging.uploadId;
}

export function startColabJob(experimentId: string, uploadId: string,
  workload: { width: number; height: number; durationSec: number }, arena: ArenaConfig,
  engineId: "superanimal_video_adapt_b_legacy" | "wistar_superanimal_hybrid_v1" = "wistar_superanimal_hybrid_v1",
  modelBundleId: HybridBundleId = LATEST_HYBRID_BUNDLE_ID) {
  return invoke<ColabJob>("start_colab_analysis", {
    request: { experimentId, uploadId, workload, arena: { ...arena, videoWidth: workload.width, videoHeight: workload.height },
      engineId, ...(engineId === "wistar_superanimal_hybrid_v1" ? { modelBundleId } : {}) },
  });
}

export async function prepareVideo(experimentId: string, file: File, metadata: { width: number; height: number },
  onProgress: (progress: number, message: string) => void): Promise<VideoPreparation> {
  const uploadId = await stageVideo(experimentId, file, onProgress);
  onProgress(0, "Compactando sem perda e verificando os frames · o original permanece intacto");
  const result = await invoke<VideoPreparation>("prepare_analysis_video", { uploadId, width: metadata.width, height: metadata.height });
  onProgress(100, result.message);
  return result;
}

export type ColabVideoArtifact = { jobId: string; videoPath: string | null; videoError: string | null };
export async function loadColabVideo(jobId: string) {
  const artifact = await invoke<ColabVideoArtifact>("get_colab_job_video", { jobId });
  return { ...artifact, videoUrl: artifact.videoPath ? convertFileSrc(artifact.videoPath) : null };
}

export function loadColabJob(jobId: string) {
  return invoke<ColabJob>("get_colab_job", { jobId });
}

export function loadLatestColabJob(experimentId: string) {
  return invoke<ColabJob | null>("get_latest_colab_job", { experimentId });
}

export function loadColabJobs(experimentId: string) {
  return invoke<ColabJob[]>("list_colab_jobs", { experimentId });
}

export function loadColabResult(jobId: string) {
  return invoke<string>("get_colab_job_result", { jobId });
}

export function loadColabLog(jobId: string) {
  return invoke<string>("get_colab_job_log", { jobId });
}

export async function waitForColabJob(
  jobId: string,
  onUpdate: (job: ColabJob) => void,
) {
  for (;;) {
    const job = await loadColabJob(jobId);
    onUpdate(job);
    if (job.status === "succeeded" || job.status === "failed") return job;
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
  }
}
