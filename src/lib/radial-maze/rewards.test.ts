import { expect, it } from "vitest";
import { reviewRewardEvidence, rewardWindows, type RewardObservation } from "./rewards";
const choices=[{armId:1 as const,frameIndex:100,timestampSec:4,status:"confirmed" as const,distalReached:true}];
it("limits reward classification to visit context and never confirms food removal",()=>{
  const observations:RewardObservation[]=[2,3,5,6,20].map((t,i)=>({armId:1,frameIndex:i,timestampSec:t,state:t<4?"reward_present":"reward_absent",confidence:.99,modelVersion:"mobilenetv3-v7"}));
  const review=reviewRewardEvidence(choices,observations)[0];
  expect(review.observations).toHaveLength(4);
  expect(review.stateChangeCandidate).toBe(true);
  expect(review.removalStatus).toBe("PENDING");
  expect(reviewRewardEvidence(choices,[])[0].removalStatus).toBe("PENDING");
  expect(()=>rewardWindows(choices,NaN)).toThrow();
});
