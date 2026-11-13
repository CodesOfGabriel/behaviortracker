import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ArenaConfig, ForcedSwimExperiment, VideoPreparation } from "../../types";
import { preparedGeometry, scaleTanksToUpload } from "./videoGeometry";

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
  engineId?: "superanimal_video_adapt_b_legacy" | "wistar_superanimal_hybrid_v1" | "fst_superanimal_quadruped_v1";
  modelBundleId?: string | null;
  protocol?: "open_field" | "forced_swim" | null;
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

export function startFstJob(experiment: ForcedSwimExperiment, preparation: VideoPreparation) {
  const geometry = preparedGeometry(experiment.video, preparation);
  return invoke<ColabJob>("start_colab_analysis", { request: {
    experimentId: experiment.id, uploadId: preparation.uploadId,
    workload: { width: geometry.width, height: geometry.height, durationSec: experiment.video.durationSec },
    engineId: "fst_superanimal_quadruped_v1", fst: { title: experiment.title, group: experiment.group, notes: experiment.notes,
      sourceWidth: experiment.video.width, sourceHeight: experiment.video.height,
      preparationPolicyVersion: preparation.policyVersion,
      subjects: experiment.subjects, tanks: scaleTanksToUpload(experiment.tanks, experiment.video, preparation) },
  } });
}

export function getStagedVideoSha256(uploadId: string) {
  return invoke<string>("get_video_staging_sha256", { uploadId });
}

export function getColabJobPreparation(experimentId: string, jobId: string) {
  return invoke<VideoPreparation | null>("get_colab_job_preparation", { experimentId, jobId });
}

export async function loadStagedVideo(experimentId: string, uploadId: string) {
  const path = await invoke<string>("get_staged_video_path", { experimentId, uploadId });
  return convertFileSrc(path);
}

export async function loadFstArtifacts(jobId: string) {
  const files = await invoke<{ name: string; path: string }[]>("get_fst_job_artifacts", { jobId });
  return files.map(file => ({ ...file, url: convertFileSrc(file.path) }));
}

export function loadFstManifest(jobId: string) {
  return invoke<Record<string, unknown>>("get_fst_job_manifest", { jobId });
}

export async function prepareVideo(experimentId: string, file: File, metadata: { width: number; height: number },
  onProgress: (progress: number, message: string) => void): Promise<VideoPreparation> {
  const uploadId = await stageVideo(experimentId, file, onProgress);
  onProgress(0, "Otimizando o vídeo para envio e conferindo os frames · o original permanece intacto");
  const result = await invoke<VideoPreparation>("prepare_analysis_video", { uploadId, width: metadata.width, height: metadata.height });
  onProgress(100, result.message);
  return result;
}

export async function prepareFstVideo(experimentId: string, file: File, metadata: { width: number; height: number },
  onProgress: (progress: number, message: string) => void, expectedOriginalSha256?: string) {
  const originalUploadId = await stageVideo(experimentId, file, onProgress);
  const originalSha256 = await getStagedVideoSha256(originalUploadId);
  if (expectedOriginalSha256 && originalSha256 !== expectedOriginalSha256) {
    throw new Error("O SHA-256 do arquivo selecionado não corresponde ao vídeo original do experimento.");
  }
  onProgress(0, "Verificando compatibilidade e preparando o vídeo FST, se necessário");
  const preparation = await invoke<VideoPreparation>("prepare_analysis_video", { uploadId: originalUploadId, width: metadata.width, height: metadata.height, fstAdaptive: true });
  onProgress(100, `${preparation.message}${preparation.cacheHit ? " · Cache reutilizado" : ""}`);
  return { preparation, originalSha256 };
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
