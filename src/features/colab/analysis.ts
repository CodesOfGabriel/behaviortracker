import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ArenaConfig, VideoPreparation } from "../../types";

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
  diagnostic?: DiagnosticRange | null;
  resultsReady?: boolean;
  training?: boolean;
  customModel?: boolean;
};

export type DiagnosticRange = { startSec: number; endSec: number };
export type DiagnosticFrame = { frameIndex: number; timestampSec: number; state: string;
  bbox: { x: number; y: number; width: number; height: number; score: number } | null;
  availablePoints: number; totalPoints: number; strongPoints: number; canonicalCenterAvailable: boolean };
export type DiagnosticReport = { schemaVersion: number; selection: DiagnosticRange; fps: number; durationSec: number;
  confidencePolicy?: string;
  geometry: { videoWidth: number; videoHeight: number }; frames: DiagnosticFrame[]; timings: Record<string, number>;
  summary: { frameCount: number; states: Record<string, number>; detectorCoveragePct: number; centerCoveragePct: number; accuracyMeasured: false };
  warning: string };
export async function loadDiagnosticResult(jobId: string) {
  const result = await invoke<{ report: DiagnosticReport; rawPoseCsv: string; clipPath: string | null }>("get_colab_diagnostic_result", { jobId });
  const r = result.report;
  if (!r || r.schemaVersion !== 1 || !Number.isFinite(r.fps) || r.fps <= 0 || r.fps > 240
    || !Number.isFinite(r.durationSec) || r.durationSec <= 0 || r.durationSec > 61
    || !r.geometry || !Number.isFinite(r.geometry.videoWidth) || !Number.isFinite(r.geometry.videoHeight) || r.geometry.videoWidth <= 0 || r.geometry.videoHeight <= 0
    || !Array.isArray(r.frames) || !r.frames.length || r.frames.length > 14401
    || !r.timings || Object.values(r.timings).some((n) => !Number.isFinite(n) || n < 0)
    || !r.summary || !Number.isFinite(r.summary.detectorCoveragePct) || !Number.isFinite(r.summary.centerCoveragePct)
    || !r.summary.states || Object.values(r.summary.states).some((n) => !Number.isInteger(n) || n < 0)
    || !r.selection || !Number.isFinite(r.selection.startSec) || !Number.isFinite(r.selection.endSec)
    || r.frames.some((frame, index) => frame.frameIndex !== index || !Number.isFinite(frame.timestampSec)
      || (frame.bbox && Object.values(frame.bbox).some((n) => !Number.isFinite(n))))) throw new Error("Relatório diagnóstico incompatível ou incompleto. Consulte o log técnico.");
  return { ...result, clipUrl: result.clipPath ? convertFileSrc(result.clipPath) : null };
}

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

export async function resolveDiagnosticUpload(experimentId: string, cachedId: string | undefined, file: File | undefined,
  onProgress: (progress: number, message: string) => void): Promise<string | null> {
  if (cachedId && await checkVideoStaging(experimentId, cachedId)) return cachedId;
  return file ? stageVideo(experimentId, file, onProgress) : null;
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
  workload: { width: number; height: number; durationSec: number }, arena: ArenaConfig, diagnostic?: DiagnosticRange) {
  return invoke<ColabJob>("start_colab_analysis", {
    request: { experimentId, uploadId, workload, arena: { ...arena, videoWidth: workload.width, videoHeight: workload.height }, ...(diagnostic ? { diagnostic } : {}) },
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
