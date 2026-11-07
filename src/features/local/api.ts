import { invoke } from "@tauri-apps/api/core";
import type { ArenaConfig, BoundingBox, Point, PoseSample } from "../../types";

export type LocalConfig = {width:number;height:number;arena:ArenaConfig;mode:"light"|"dark"|"background";threshold:number;
  minAreaFraction:number;maxAreaFraction:number;maxWidth:number;maxPredictionSec:number;referenceApproved:boolean;seed?:Point|null;initialBox?:BoundingBox|null;backgroundFrameIndex?:number|null};
export type LocalJob = {jobId:string;experimentId:string;state:"queued"|"running"|"succeeded"|"cancelled"|"failed";error?:string;config:LocalConfig;createdAt:string;videoSha256:string;
  report?:{framesProcessed?:number;totalFrames?:number;elapsedSec?:number;processingFps?:number;observationCoveragePct?:number;counts?:{observed:number;predicted:number;missing:number;suspect:number}}};
export const localEnvironment=()=>invoke<{ready:boolean;version?:string;message?:string}>("get_local_tracking_environment");
export const setupLocalEnvironment=()=>invoke<{ready:boolean;version?:string}>("setup_local_tracking_environment");
export const listLocalJobs=(experimentId:string)=>invoke<LocalJob[]>("list_local_tracking_jobs",{experimentId});
export const startLocalTracking=(experimentId:string,uploadId:string,config:LocalConfig)=>invoke<LocalJob>("start_local_tracking",{experimentId,uploadId,config});
export const localUpdates=(jobId:string,offset:number)=>invoke<{offset:number;samples:PoseSample[]}>("get_local_tracking_updates",{jobId,offset});
export const loadLocalResult=(jobId:string)=>invoke<PoseSample[]>("get_local_tracking_result",{jobId});
export const cancelLocalTracking=(jobId:string)=>invoke<void>("cancel_local_tracking",{jobId});
export const localFrameIndex=(experimentId:string,uploadId:string,time:number)=>invoke<number>("local_frame_index",{experimentId,uploadId,time});
