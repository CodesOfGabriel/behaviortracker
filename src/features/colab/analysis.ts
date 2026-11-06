import { invoke } from "@tauri-apps/api/core";

const STAGING_CHUNK_SIZE = 4 * 1024 * 1024;

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
};

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
    await invoke<VideoStaging>("append_video_staging_chunk", {
      uploadId: staging.uploadId,
      offset,
      bytes: Array.from(bytes),
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
  workload: { width: number; height: number; durationSec: number }) {
  return invoke<ColabJob>("start_colab_analysis", {
    request: { experimentId, uploadId, workload },
  });
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
