import type { BoundingBox, ForcedSwimExperiment, FstAnnotation, TankConfig, TankPresence } from "../types";

export const FST_ENGINE = "fst_superanimal_quadruped_v1" as const;
export const FST_VERSION = "fst-0.1" as const;

export function validateTanks(tanks: TankConfig[], width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 80 || height < 80) return "Resolução do vídeo inválida.";
  if (tanks.length < 1 || tanks.length > 2) return "Informe um ou dois cilindros.";
  if (new Set(tanks.map(t => t.animalId)).size !== tanks.length || new Set(tanks.map(t => t.subjectId.trim())).size !== tanks.length || new Set(tanks.map(t => t.tankId)).size !== tanks.length) return "Cada cilindro precisa de identificadores de animal, sujeito e tanque distintos.";
  for (const tank of tanks) {
    const { x, y, width: w, height: h } = tank.roiPx;
    if (!tank.tankId || !tank.animalId || !tank.subjectId || !Number.isInteger(tank.revision) || tank.revision < 1) return "Identificação ou revisão do cilindro inválida.";
    if (![x,y,w,h].every(Number.isInteger) || x < 0 || y < 0 || w < 80 || h < 80 || x + w > width || y + h > height) return `A região de ${tank.animalId} precisa usar pixels inteiros, medir pelo menos 80 × 80 px e permanecer dentro do vídeo.`;
    if (h / height < 0.55) return `A região de ${tank.animalId} precisa cobrir todo o cilindro (ao menos 55% da altura do vídeo).`;
  }
  if (tanks.length === 2) {
    const a = tanks[0].roiPx, b = tanks[1].roiPx;
    const overlap = Math.max(0, Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)) * Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
    if (overlap > 0) return "As regiões dos cilindros não podem se sobrepor.";
  }
  return null;
}

export function validateForcedSwim(experiment: ForcedSwimExperiment): string | null {
  if (!experiment.title.trim()) return "Informe o nome do experimento.";
  if (experiment.analysisEngine !== FST_ENGINE || experiment.analysisMethodVersion !== FST_VERSION) return "Versão de análise FST inválida.";
  if (!Number.isFinite(experiment.video.durationSec) || experiment.video.durationSec <= 0) return "Duração do vídeo inválida.";
  if (experiment.subjects.length !== experiment.tanks.length || experiment.subjects.some((subject, i) => subject.animalId !== experiment.tanks[i].animalId || subject.subjectId !== experiment.tanks[i].subjectId)) return "Sujeitos e cilindros não correspondem.";
  return validateTanks(experiment.tanks, experiment.video.width, experiment.video.height);
}

export function displayableFstPose(pose: { xPx: number | null; yPx: number | null; likelihood: number }, tank: TankConfig, presence: TankPresence, threshold = 0.35) {
  const { x, y, width, height } = tank.roiPx;
  return presence === "IN_TANK" && pose.xPx !== null && pose.yPx !== null &&
    Number.isFinite(pose.xPx) && Number.isFinite(pose.yPx) && Number.isFinite(pose.likelihood) &&
    pose.likelihood >= threshold && pose.xPx >= x && pose.xPx < x+width && pose.yPx >= y && pose.yPx < y+height;
}

export interface FstFrame {
  frame: number; timestampSec: number; animalId: string; presence: TankPresence;
  bodyScore: number; silhouetteChange: number | null;
  bbox: (BoundingBox & { confidence: number; method: string }) | null;
  poseCoverage: number; relativeMotion: number | null; centroidMotion: number | null;
  classification: "NOT_CLASSIFIED";
}
export interface FstResult {
  schemaVersion: "fst-result-1"; protocol: "forced_swim"; engineId: typeof FST_ENGINE;
  analysisVersion: typeof FST_VERSION; runId: string; video: { sha256: string; originalSha256: string; width: number; height: number; fps: number; frameCount: number; filename: string };
  subjects: ForcedSwimExperiment["subjects"]; tanks: TankConfig[]; frames: FstFrame[];
  keypointNames: string[]; poseArrays: Record<string, [number | null, number | null, number][][]>;
  quality: Record<string, { presenceSec: number; anatomicalCoverage: number; insufficientDataSec: number }>;
  reviewShortlist: { animalId: string; startSec: number; endSec: number; reason: "LOWER_OBSERVED_MOTION" | "HIGHER_OBSERVED_MOTION" | "TRACKING_INSUFFICIENT"; relativeMotion: number | null; meanPoseCoverage: number }[];
  insufficientIntervals: Record<string, { startSec: number; endSec: number }[]>;
  annotations?: FstAnnotation[];
}
