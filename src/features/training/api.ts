import { invoke } from "@tauri-apps/api/core";
import type { ColabJob } from "../colab/analysis";
import type { TrainingFrame, TrainingInterval } from "./schema";

export type TrainingRun = { job: ColabJob; report: Record<string,unknown> | null; modelAvailable: boolean; active: boolean };
export type TrainingState = { frames: TrainingFrame[]; intervals: TrainingInterval[]; runs: TrainingRun[]; activeModelId: string | null };
export const loadTraining = (experimentId:string) => invoke<TrainingState>("get_training_state",{experimentId});
export const extractTrainingFrame = (experimentId:string,uploadId:string,frameIndex:number,subjectId:string,timestampSec?:number) =>
  invoke<{frame:TrainingFrame; imageUrl:string}>("extract_training_frame",{experimentId,uploadId,frameIndex,subjectId,timestampSec:timestampSec??null});
export const loadTrainingImage = (id:string) => invoke<string>("get_training_image",{id});
export const saveTrainingFrame = (frame:TrainingFrame) => invoke<void>("save_training_frame",{frame});
export const saveTrainingIntervals = (experimentId:string,intervals:TrainingInterval[]) => invoke<void>("save_training_intervals",{experimentId,intervals});
export const trainOnColab = (experimentId:string,epochs:number) => invoke<ColabJob>("start_custom_training",{experimentId,epochs});
export const selectCustomModel = (jobId:string|null) => invoke<void>("select_custom_model",{jobId});
