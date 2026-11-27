import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { BehaviorAnnotation, BehaviorJob, BehaviorModelStatus, BehaviorResult, BehaviorReview, ProposalReviewInput } from "../../lib/behavior/types";
import { sessionCache, withTimeout } from "../../lib/session-cache";
export const cachedBehaviorModelStatus = () => sessionCache.peek<BehaviorModelStatus>(["behaviorModel"]);
export const getBehaviorModelStatus = () => sessionCache.read(["behaviorModel"], () => withTimeout(invoke<BehaviorModelStatus>("get_behavior_model_status"), 5000, "A consulta do modelo demorou demais. Tente novamente na detecção automática."));
export const setupBehaviorEnvironment = async () => {
  await invoke<void>("setup_behavior_environment");
  sessionCache.invalidate(["behaviorModel"]);
};
export const downloadBehaviorModel = async (sourceDirectory?: string) => {
  const model = await invoke<BehaviorModelStatus>("download_behavior_model", {sourceDirectory: sourceDirectory || null});
  sessionCache.invalidate(["behaviorModel"]);
  return model;
};
export const cancelBehaviorModelDownload = () => invoke<void>("cancel_behavior_model_download");
export const startBehavior = async (experimentId: string, trackingJobId: string, videoSha256: string, cpuThreads = 2) => {
  const job = await invoke<{jobId: string}>("start_local_behavior_analysis", {experimentId, trackingJobId, videoSha256, cpuThreads});
  sessionCache.invalidate(["behaviorJobs", experimentId, trackingJobId]);
  return job;
};
export const cachedBehaviorJobs = (experimentId: string, trackingJobId: string) => sessionCache.peek<BehaviorJob[]>(["behaviorJobs", experimentId, trackingJobId]);
export const listBehaviorJobs = (experimentId: string, trackingJobId: string, refresh = true) => sessionCache.read(["behaviorJobs", experimentId, trackingJobId], () => invoke<BehaviorJob[]>("list_local_behavior_jobs", {experimentId, trackingJobId}), refresh);
export const cachedBehaviorResult = (jobId: string) => sessionCache.peek<BehaviorResult>(["behaviorResult", jobId]);
export const loadBehaviorResult = (jobId: string) => sessionCache.read(["behaviorResult", jobId], () => invoke<BehaviorResult>("get_local_behavior_result", {jobId}));
export const cancelBehavior = async (jobId: string) => {
  await invoke<void>("cancel_local_behavior_analysis", {jobId});
  sessionCache.invalidate(["behaviorJobs"]);
};
export const cachedAnnotations = (trackingJobId: string) => sessionCache.peek<BehaviorAnnotation[]>(["annotations", trackingJobId]);
export const listAnnotations = (trackingJobId: string) => sessionCache.read(["annotations", trackingJobId], () => invoke<BehaviorAnnotation[]>("list_behavior_annotations", {trackingJobId}));
export const appendAnnotation = async (annotation: BehaviorAnnotation) => {
  await invoke<void>("append_behavior_annotation", {experimentId: annotation.experimentId, trackingJobId: annotation.trackingJobId, videoSha256: annotation.videoSha256, annotation});
  sessionCache.update<BehaviorAnnotation[]>(["annotations", annotation.trackingJobId], old => [...old, annotation]);
};
export async function reviewBehaviorProposal(experimentId:string,trackingJobId:string,videoSha256:string,review:ProposalReviewInput) {
  const entries=await invoke<BehaviorAnnotation[]>("review_behavior_proposal",{experimentId,trackingJobId,videoSha256,review});
  sessionCache.update<BehaviorAnnotation[]>(["annotations",trackingJobId],old=>[...old,...entries]);
  return entries;
}
export const exportBehaviorAnnotations = (experimentId:string, trackingJobId:string, videoSha256:string, kind:"peaks"|"intervals"|"history"|"poses") =>
  invoke<{path:string}>("export_behavior_annotations",{experimentId,trackingJobId,videoSha256,kind});
export const revealBehaviorExport = (path:string) => invoke<void>("reveal_behavior_export",{path});
export type ApexPreview = {candidates:{frameIndex:number;timestampSec:number;score:number;label:string;observation:string}[];
  trackingTermination:{timestampSec:number}|null;message:string;resultDirectory:string;sameTrainingVideo:boolean};
export type GeometryPreview = {state:"proposed"|"insufficient_evidence";message:string;resultDirectory:string;
  scientificallyValidated:false;metricEligible:false;durationMeasured:false;
  annotationComparison?:{annotatedPeaks:number;truePositive:number;falsePositive:number;falseNegative:number;message:string};
  trackingTermination:{timestampSec:number}|null;
  candidates:{frameIndex:number;timestampSec:number;startSec:number;endSec:number;verification:"consistent"|"limited"|"insufficient";
    reasons:string[];evidence?:{axisLengthRatio:number|null;silhouetteAreaRatio:number;headOnWall:boolean}}[]};
export const previewLocalRearingGeometry = (experimentId:string, trackingJobId:string, videoSha256:string) =>
  invoke<GeometryPreview>("preview_local_rearing_geometry",{experimentId,trackingJobId,videoSha256});
export const previewLocalRearingPeaks = (experimentId:string, trackingJobId:string, videoSha256:string, modelDirectory:string) =>
  invoke<ApexPreview>("preview_local_rearing_peaks",{experimentId,trackingJobId,videoSha256,modelDirectory});
export const installLocalRearingApexModel = (modelDirectory:string) =>
  invoke<{scientificallyValidated:false}>("install_local_rearing_apex_model",{modelDirectory});
export const cachedBehaviorReviews = (jobId: string) => sessionCache.peek<BehaviorReview[]>(["reviews", jobId]);
export const listBehaviorReviews = (jobId: string) => sessionCache.read(["reviews", jobId], () => invoke<BehaviorReview[]>("list_behavior_review_events", {jobId}));
export const appendBehaviorReview = async (jobId: string, event: BehaviorReview) => {
  await invoke<void>("append_behavior_review_event", {jobId, event});
  sessionCache.update<BehaviorReview[]>(["reviews", jobId], old => [...old, event]);
};
export async function renderBehaviorVideo(jobId: string) {
  const result=await invoke<{videoPath:string}>("render_behavior_audit_video",{jobId});
  return convertFileSrc(result.videoPath);
}
export async function exportBehaviorDataset(experimentId:string,trackingJobId:string,videoSha256:string,metadata:{animalId:string;sessionId:string;arenaId:string;condition:string},includeVideo:boolean) {
  const result=await invoke<{path:string}>("export_behavior_training_package",{experimentId,trackingJobId,videoSha256,metadata,includeVideo});
  return {...result,url:convertFileSrc(result.path)};
}
export async function exportBehaviorResults(jobId:string) {
  const result=await invoke<{path:string}>("export_behavior_results",{jobId});
  return {...result,url:convertFileSrc(result.path)};
}
export type AnnotationContext = {videoPath: string; frameTimes: number[]; durationSec: number; videoUrl: string};
export const cachedAnnotationContext = (experimentId: string, trackingJobId: string, videoSha256: string) => sessionCache.peek<AnnotationContext>(["annotationContext", experimentId, trackingJobId, videoSha256]);
export function annotationContext(experimentId: string, trackingJobId: string, videoSha256: string) {
  return sessionCache.read(["annotationContext", experimentId, trackingJobId, videoSha256], async () => {
    const context = await invoke<Omit<AnnotationContext, "videoUrl">>("get_behavior_annotation_context", {experimentId, trackingJobId, videoSha256});
    return {...context, videoUrl: convertFileSrc(context.videoPath)};
  });
}
