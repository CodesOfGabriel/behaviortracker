import type { ArmId } from "../../types";
import type { RamChoice } from "./events";

export type RewardState = "reward_present" | "reward_absent" | "occluded" | "uncertain";
export interface RewardObservation {
  frameIndex: number; timestampSec: number; armId: ArmId;
  state: RewardState; confidence: number; modelVersion: string;
}

export function rewardWindows(choices: RamChoice[], contextSec = 2) {
  if (!Number.isFinite(contextSec) || contextSec < 0 || contextSec > 30) throw new Error("Contexto de recompensa inválido");
  return choices.map(c=>({ armId:c.armId, startSec:Math.max(0,c.timestampSec-contextSec), endSec:c.timestampSec+contextSec, choiceStatus:c.status }));
}

export function reviewRewardEvidence(choices: RamChoice[], observations: RewardObservation[], contextSec = 2) {
  for (const o of observations) {
    if (!Number.isInteger(o.frameIndex) || o.frameIndex < 0 || !Number.isFinite(o.timestampSec) || o.timestampSec < 0
      || ![1,2,3,4,5,6,7,8].includes(o.armId) || !["reward_present","reward_absent","occluded","uncertain"].includes(o.state)
      || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1 || !o.modelVersion) throw new Error("Observação de recompensa inválida");
  }
  return rewardWindows(choices,contextSec).map((w,i)=>{
    const selected=observations.filter(o=>o.armId===w.armId && o.timestampSec>=w.startSec && o.timestampSec<=w.endSec);
    const before=selected.filter(o=>o.timestampSec<choices[i].timestampSec && o.confidence>=.8 && o.state==="reward_present");
    const after=selected.filter(o=>o.timestampSec>choices[i].timestampSec && o.confidence>=.8 && o.state==="reward_absent");
    return {...w, observations:selected, stateChangeCandidate:before.length>=2 && after.length>=2,
      removalStatus:"PENDING" as const, reason:selected.length ? "Classificações auxiliares exigem revisão humana; aproximação não comprova retirada" : "Sem evidência do classificador"};
  });
}
