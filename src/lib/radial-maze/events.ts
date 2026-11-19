import type { ArmId, Point, RadialMazeGeometry, RamVisitPolicy } from "../../types";
import { crossesGate, spatialRegion } from "./geometry";

export interface RamFrame {
  frameIndex: number;
  timestampSec: number;
  center: Point | null;
  identity: "confirmed" | "uncertain";
  source: "anatomical" | "segmented" | "manual" | "missing";
}
export interface RamChoice {
  armId: ArmId;
  frameIndex: number;
  timestampSec: number;
  distalReached: boolean;
  status: "confirmed" | "pending";
  reason?: string;
}

export function validateVisitPolicy(policy: RamVisitPolicy): string | null {
  if (![policy.minimumArmDwellSec, policy.minimumCenterDwellSec, policy.minimumDistalDwellSec, policy.unknownGapToleranceSec]
    .every(value => Number.isFinite(value) && value >= 0 && value <= 30)) return "Os tempos de permanência devem estar entre 0 e 30 segundos.";
  return null;
}

export function detectRamChoices(frames: RamFrame[], geometry: RadialMazeGeometry, policy: RamVisitPolicy): RamChoice[] {
  if (validateVisitPolicy(policy)) throw new Error("Política de visita inválida.");
  if (geometry.walkablePolygonPx !== undefined) throw new Error("As visitas por braço exigem limites e linhas de entrada validados para cada braço.");
  const choices: RamChoice[] = [];
  let lastTime = -Infinity;
  let centerSince: number | null = null;
  let centerReady = false;
  let candidate: { armId: ArmId; start: RamFrame; distalSince: number | null; distalReached: boolean; gateCrossed: boolean; uncertain: boolean; counted: boolean } | null = null;
  let unknownSince: number | null = null;
  let previousPoint: Point | null = null;
  for (const frame of frames) {
    if (!Number.isFinite(frame.timestampSec) || frame.timestampSec <= lastTime) throw new Error("Frames RAM precisam ter timestamps crescentes.");
    lastTime = frame.timestampSec;
    const region = frame.identity === "confirmed" && frame.source !== "missing" ? spatialRegion(frame.center, geometry) : "UNKNOWN";
    if (region === "UNKNOWN") {
      unknownSince ??= frame.timestampSec;
      continue;
    }
    if (unknownSince !== null) {
      if (frame.timestampSec - unknownSince > policy.unknownGapToleranceSec) {
        if (candidate && !candidate.counted) choices.push({ armId: candidate.armId, frameIndex: candidate.start.frameIndex,
          timestampSec: candidate.start.timestampSec, distalReached: candidate.distalReached, status: "pending", reason: "Lacuna de identidade ou posição durante a escolha" });
        candidate = null; centerReady = false; centerSince = null; previousPoint = null;
      } else if (candidate) candidate.uncertain = true;
      unknownSince = null;
    }
    if (region === "CENTER") {
      if (candidate && !candidate.counted) choices.push({ armId: candidate.armId, frameIndex: candidate.start.frameIndex,
        timestampSec: candidate.start.timestampSec, distalReached: candidate.distalReached, status: "pending", reason: "Permanência insuficiente ou trecho incerto" });
      candidate = null;
      centerSince ??= frame.timestampSec;
      if (frame.timestampSec - centerSince >= policy.minimumCenterDwellSec) centerReady = true;
      previousPoint = frame.center;
      continue;
    }
    const armId = Number(region.split("_").at(-1)) as ArmId;
    if (!candidate || candidate.armId !== armId) {
      if (candidate && !candidate.counted) choices.push({ armId: candidate.armId, frameIndex: candidate.start.frameIndex,
        timestampSec: candidate.start.timestampSec, distalReached: candidate.distalReached, status: "pending", reason: "Troca de braço sem retorno confirmado ao centro" });
      candidate = { armId, start: frame, distalSince: null, distalReached: false, gateCrossed: false, uncertain: !centerReady, counted: false };
      centerReady = false; centerSince = null;
    }
    if (previousPoint && frame.center && crossesGate(previousPoint, frame.center, geometry.arms.find(arm => arm.id === armId)!.entryGatePx)) candidate.gateCrossed = true;
    previousPoint = frame.center;
    if (region.startsWith("DISTAL")) {
      candidate.distalSince ??= frame.timestampSec;
      if (frame.timestampSec - candidate.distalSince >= policy.minimumDistalDwellSec) candidate.distalReached = true;
    } else candidate.distalSince = null;
    const qualifies = candidate.gateCrossed && frame.timestampSec - candidate.start.timestampSec >= policy.minimumArmDwellSec
      && (policy.choiceCriterion === "arm_entry" || candidate.distalReached);
    if (qualifies && !candidate.counted) {
      choices.push({ armId, frameIndex: candidate.start.frameIndex, timestampSec: candidate.start.timestampSec,
        distalReached: candidate.distalReached, status: candidate.uncertain ? "pending" : "confirmed",
        ...(candidate.uncertain ? { reason: "Centro ou lacuna anterior não confirmado" } : {}) });
      candidate.counted = true;
    }
  }
  if (candidate && !candidate.counted) choices.push({ armId: candidate.armId, frameIndex: candidate.start.frameIndex,
    timestampSec: candidate.start.timestampSec, distalReached: candidate.distalReached, status: "pending", reason: "Visita não concluída no fim do registro" });
  return choices;
}
