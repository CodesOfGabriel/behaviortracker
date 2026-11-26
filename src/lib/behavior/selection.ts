import type { BehaviorJob, BehaviorResult } from "./types";

export type BehaviorSelection = {jobId: string; videoSha256: string};

/** An explicit choice never falls back to a different run when it disappears. */
export function selectedBehaviorRun(jobs: BehaviorJob[], videoSha256: string, selection?: BehaviorSelection) {
  if (selection) {
    return selection.videoSha256 === videoSha256 && jobs.some(job => job.jobId === selection.jobId && job.videoSha256 === videoSha256)
      ? selection.jobId : "";
  }
  return jobs.find(job => job.state === "succeeded" && job.videoSha256 === videoSha256)?.jobId ?? "";
}

export function assertBehaviorSource(result: BehaviorResult, experimentId: string, trackingJobId: string, videoSha256: string) {
  if (result.manifest.experimentId !== experimentId || result.manifest.trackingJobId !== trackingJobId || result.manifest.videoSha256 !== videoSha256) {
    throw new Error("O resultado comportamental não pertence ao vídeo e ao tracking selecionados.");
  }
}
