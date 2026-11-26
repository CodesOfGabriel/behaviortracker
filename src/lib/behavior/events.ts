import type { BehaviorEvent, BehaviorReview } from "./types";

export function reviewedEvents(events: BehaviorEvent[], reviews: BehaviorReview[]): BehaviorEvent[] {
  return events.map(event => {
    let current={...event};
    for(const review of reviews.filter(review=>review.eventId===event.eventId)) {
      if (review.type === "CORRECT" && review.startSec != null && review.endSec != null && review.label) {
        current={...current, startSec: review.startSec, endSec: review.endSec, durationSec: review.endSec-review.startSec,
          behavior: review.label, reviewStatus: "corrected", observedIntervals: [[review.startSec, review.endSec]], censored: false};
      } else current={...current, reviewStatus: review.type === "CONFIRM" ? "confirmed" : "rejected"};
    }
    return current;
  });
}
