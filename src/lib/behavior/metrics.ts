import type { BehaviorEvent } from "./types";

export function reviewedSummary(events: BehaviorEvent[]) {
  const confirmed = events.filter(e => (e.reviewStatus === "confirmed" || e.reviewStatus === "corrected") && e.behavior.startsWith("REARING_"));
  return {count: confirmed.length, durationSec: confirmed.reduce((sum,e) => sum+e.durationSec,0),
    pending: events.filter(e => e.reviewStatus === "pending").length, rejected: events.filter(e => e.reviewStatus === "rejected").length};
}
