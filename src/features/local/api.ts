import { invoke } from "@tauri-apps/api/core";
import type { PoseSample } from "../../types";

// Compatibilidade de leitura para resultados OpenCV salvos antes da remoção do fluxo local.
export const loadLocalResult=(jobId:string)=>invoke<PoseSample[]>("get_local_tracking_result",{jobId});
