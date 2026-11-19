import type { ArmId } from "../../types";
import type { RamChoice } from "./events";

export interface ClassifiedChoice extends RamChoice {
  classification: "CORRECT" | "RME" | "WME" | "RWME" | "PENDING";
}
export function classifyRamChoices(choices: RamChoice[], baited: ArmId[]): ClassifiedChoice[] {
  if (baited.length !== 4 || new Set(baited).size !== 4) throw new Error("Informe quatro braços recompensados distintos.");
  const seen = new Set<ArmId>();
  const ambiguous = new Set<ArmId>();
  return choices.map(choice => {
    if (choice.status === "pending") { ambiguous.add(choice.armId); return { ...choice, classification: "PENDING" }; }
    if (ambiguous.has(choice.armId)) return { ...choice, classification: "PENDING" };
    const repeat = seen.has(choice.armId);
    seen.add(choice.armId);
    return { ...choice, classification: repeat ? (baited.includes(choice.armId) ? "WME" : "RWME")
      : (baited.includes(choice.armId) ? "CORRECT" : "RME") };
  });
}

export function calculateRamMetrics(choices: RamChoice[], baited: ArmId[], startSec = 0) {
  const classified = classifyRamChoices(choices, baited);
  const confirmed = classified.filter(choice => choice.classification !== "PENDING");
  const pending = classified.filter(choice => choice.classification === "PENDING");
  const counts = { correct: 0, rme: 0, wme: 0, rwme: 0 };
  for (const choice of confirmed) {
    if (choice.classification === "CORRECT") counts.correct++;
    if (choice.classification === "RME") counts.rme++;
    if (choice.classification === "WME") counts.wme++;
    if (choice.classification === "RWME") counts.rwme++;
  }
  return {
    analysisMethodVersion: "ram-1.0" as const,
    definitive: pending.length === 0,
    choices: classified,
    confirmedChoices: confirmed.length,
    pendingChoices: pending.length,
    uniqueArms: new Set(confirmed.map(choice => choice.armId)).size,
    firstChoiceLatencySec: pending.length ? null : confirmed.length ? confirmed[0].timestampSec - startSec : null,
    correctChoiceEfficiency: pending.length || !confirmed.length ? null : counts.correct / confirmed.length,
    ...counts,
  };
}
