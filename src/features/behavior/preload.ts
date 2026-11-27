import type { Experiment, OpenFieldExperiment } from "../../types";
import { assertBehaviorSource, selectedBehaviorRun } from "../../lib/behavior/selection";
import { currentAnalysisCacheGeneration } from "../../lib/session-cache";
import { listLocalJobs, loadLocalResult, type LocalJob } from "../local/api";
import { annotationContext, getBehaviorModelStatus, listAnnotations, listBehaviorJobs, listBehaviorReviews, loadBehaviorResult } from "./api";

export function rearingTrackingJobs(jobs: LocalJob[], videoSha256?: string) {
  return jobs.filter(job => job.state === "succeeded" && job.config.protocol === "open_field"
    && job.videoSha256 === videoSha256 && job.config.strategy !== "wistar_hrnet");
}

export function rearingSourceKey(experiment: Experiment) {
  return JSON.stringify([experiment.id, experiment.video.sha256, experiment.trackingSelection,
    experiment.testType === "open_field" ? experiment.behaviorSelections : undefined]);
}

export async function preloadRearing(experiments: Experiment[]) {
  const eligible = experiments.filter((experiment): experiment is OpenFieldExperiment =>
    experiment.testType === "open_field" && Boolean(experiment.video.sha256));
  if (!eligible.length) return;
  const generation = currentAnalysisCacheGeneration();
  const live = () => generation === currentAnalysisCacheGeneration();
  // Two workspaces at a time: hashing videos and transferring tracking must not
  // saturate disk/IPC when a researcher has many saved experiments.
  let next = 0;
  let retainedResults = 0;
  const warm = async (experiment: OpenFieldExperiment) => {
    const digest = experiment.video.sha256!;
    const jobs = rearingTrackingJobs(await listLocalJobs(experiment.id), digest);
    if (!live()) return;
    const selected = experiment.trackingSelection;
    const job = selected?.engine === "opencv" ? jobs.find(job => job.jobId === selected.jobId) : jobs[0];
    if (!job) return;
    const retainResult = retainedResults++ < 3;
    const behavior = async () => {
      const runs = await listBehaviorJobs(experiment.id, job.jobId);
      if (!live()) return;
      const shown = selectedBehaviorRun(runs, digest, experiment.behaviorSelections?.[job.jobId]);
      if (!shown || runs.find(run => run.jobId === shown)?.state !== "succeeded") return;
      const [result] = await Promise.all([loadBehaviorResult(shown), listBehaviorReviews(shown)]);
      assertBehaviorSource(result, experiment.id, job.jobId, digest);
    };
    await Promise.allSettled([
      annotationContext(experiment.id, job.jobId, digest), listAnnotations(job.jobId), behavior(),
      // Keep large results bounded; other workspaces still have their metadata,
      // source validation and human annotations prepared in the background.
      ...(retainResult ? [loadLocalResult(job.jobId)] : []),
    ]);
  };
  const worker = async () => {
    while (live() && next < eligible.length) {
      const index = next++;
      await warm(eligible[index]).catch(() => undefined);
    }
  };
  await Promise.allSettled([worker(), worker(), getBehaviorModelStatus()]);
}
