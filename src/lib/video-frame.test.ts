import { expect, it } from "vitest";
import { trackingFrameAt } from "./video-frame";
const rows=[0,.04,.17,.2].map((timestampSec,frameIndex)=>({timestampSec,frameIndex}));
it("selects the presented PTS rather than a rounded playback frame",()=>{
  expect(trackingFrameAt(rows,.169,25)?.frameIndex).toBe(1);
  expect(trackingFrameAt(rows,.17,25)?.frameIndex).toBe(2);
  expect(trackingFrameAt(rows,.199,25)?.frameIndex).toBe(2);
  expect(trackingFrameAt(rows,.2,25)?.frameIndex).toBe(3);
});
it("never borrows a bounding box across a missing frame or beyond the video",()=>{
  const gap=[rows[0],rows[2]];
  expect(trackingFrameAt(gap,.08,25)).toBeUndefined();
  for(const time of [null,NaN,-.04,.3])expect(trackingFrameAt(rows,time,25)).toBeUndefined();
});
