import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { BehaviorAnnotation, BehaviorJob, BehaviorModelStatus, BehaviorResult, BehaviorReview } from "../../lib/behavior/types";
export const getBehaviorModelStatus = () => invoke<BehaviorModelStatus>("get_behavior_model_status");
export const setupBehaviorEnvironment = () => invoke<void>("setup_behavior_environment");
export const downloadBehaviorModel = (sourceDirectory?: string) => invoke<BehaviorModelStatus>("download_behavior_model", {sourceDirectory: sourceDirectory || null});
export const cancelBehaviorModelDownload = () => invoke<void>("cancel_behavior_model_download");
export const startBehavior = (experimentId: string, trackingJobId: string, videoSha256: string, cpuThreads = 2) => invoke<{jobId: string}>("start_local_behavior_analysis", {experimentId, trackingJobId, videoSha256, cpuThreads});
export const listBehaviorJobs = (experimentId: string, trackingJobId: string) => invoke<BehaviorJob[]>("list_local_behavior_jobs", {experimentId, trackingJobId});
export const loadBehaviorResult = (jobId: string) => invoke<BehaviorResult>("get_local_behavior_result", {jobId});
export const cancelBehavior = (jobId: string) => invoke<void>("cancel_local_behavior_analysis", {jobId});
export const listAnnotations = (trackingJobId: string) => invoke<BehaviorAnnotation[]>("list_behavior_annotations", {trackingJobId});
export const appendAnnotation = (annotation: BehaviorAnnotation) => invoke<void>("append_behavior_annotation", {experimentId: annotation.experimentId, trackingJobId: annotation.trackingJobId, videoSha256: annotation.videoSha256, annotation});
export const exportBehaviorAnnotations = (experimentId:string, trackingJobId:string, videoSha256:string, kind:"peaks"|"intervals"|"history") =>
  invoke<{path:string}>("export_behavior_annotations",{experimentId,trackingJobId,videoSha256,kind});
export const revealBehaviorExport = (path:string) => invoke<void>("reveal_behavior_export",{path});
export type ApexPreview = {candidates:{frameIndex:number;timestampSec:number;score:number;label:string;observation:string}[];
  trackingTermination:{timestampSec:number}|null;message:string;resultDirectory:string;sameTrainingVideo:boolean};
export const previewLocalRearingPeaks = (experimentId:string, trackingJobId:string, videoSha256:string, modelDirectory:string) =>
  invoke<ApexPreview>("preview_local_rearing_peaks",{experimentId,trackingJobId,videoSha256,modelDirectory});
export const installLocalRearingApexModel = (modelDirectory:string) =>
  invoke<{scientificallyValidated:false}>("install_local_rearing_apex_model",{modelDirectory});
export const listBehaviorReviews = (jobId: string) => invoke<BehaviorReview[]>("list_behavior_review_events", {jobId});
export const appendBehaviorReview = (jobId: string, event: BehaviorReview) => invoke<void>("append_behavior_review_event", {jobId, event});
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
export async function annotationContext(experimentId: string, trackingJobId: string, videoSha256: string) {
  const context = await invoke<{videoPath: string; frameTimes: number[]; durationSec: number}>("get_behavior_annotation_context", {experimentId, trackingJobId, videoSha256});
  return {...context, videoUrl: convertFileSrc(context.videoPath)};
}
