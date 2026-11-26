import { describe, expect, it } from "vitest";
import { activeAnnotations, activePeaks, peaksCsv, annotationOverlap, annotationsCsv, frameAt, intervalError } from "./validation";
import { reviewedEvents } from "./events";
import { reviewedSummary } from "./metrics";
import type { BehaviorAnnotation, BehaviorEvent, BehaviorReview } from "./types";
import type { BehaviorJob, BehaviorResult } from "./types";
import { assertBehaviorSource, selectedBehaviorRun } from "./selection";
const annotation:BehaviorAnnotation={schemaVersion:1,id:"a",type:"INTERVAL",source:"human",experimentId:"experiment",trackingJobId:"tracking",videoSha256:"a".repeat(64),createdAt:"2026-01-01",startSec:1,endSec:2,label:"REARING_UNSPECIFIED",annotatorId:"A"};
const event:BehaviorEvent={eventId:"rear_1",startSec:1,endSec:2,durationSec:1,behavior:"REARING_UNSPECIFIED",score:.9,reviewStatus:"pending",observedIntervals:[[1,2]],censored:false};
describe("human behavior annotations",()=>{
  it("undo preserves history and removes only its target",()=>{const history=[annotation,{...annotation,id:"undo",type:"UNDO" as const,targetId:"a"}];expect(activeAnnotations(history)).toEqual([]);expect(history).toHaveLength(2);});
  it("overlap excludes adjacent half-open intervals",()=>{expect(annotationOverlap([annotation],2,3)).toBe(false);expect(annotationOverlap([annotation],1.5,3)).toBe(true);});
  it("unlabeled space is not exported as negative",()=>{const csv=annotationsCsv([annotation],"video");expect(csv.split("\n").filter(Boolean)).toHaveLength(2);expect(csv).not.toContain("NON_REARING");});
  it("invalid interval bounds are rejected",()=>{for(const bounds of [[-1,2],[2,2],[2,4],[NaN,2]])expect(intervalError(bounds[0],bounds[1],3)).not.toBeNull();});
  it("frame steps use VFR timestamps",()=>{expect(frameAt([0,.04,.11,.12],.115)).toBe(2);expect(frameAt([0,.04,.11,.12],0)).toBe(0);});
});
describe("persisted behavior run selection",()=>{
  const jobs:BehaviorJob[]=[{jobId:"new",videoSha256:"a",state:"succeeded",createdAt:"",error:null,modelVersion:"1",report:{}},
    {jobId:"old",videoSha256:"a",state:"succeeded",createdAt:"",error:null,modelVersion:"1",report:{}}];
  it("keeps an explicitly selected earlier run",()=>expect(selectedBehaviorRun(jobs,"a",{jobId:"old",videoSha256:"a"})).toBe("old"));
  it("does not substitute another run after an explicit choice disappears",()=>expect(selectedBehaviorRun(jobs,"a",{jobId:"missing",videoSha256:"a"})).toBe(""));
  it("never reuses a selection from another video",()=>expect(selectedBehaviorRun(jobs,"b",{jobId:"old",videoSha256:"a"})).toBe(""));
  it("selects the latest completed run only when no explicit selection exists",()=>expect(selectedBehaviorRun(jobs,"a")).toBe("new"));
  it("verifies experiment, tracking job and video before displaying metrics",()=>{
    const result={manifest:{experimentId:"experiment",trackingJobId:"tracking",videoSha256:"a"}} as BehaviorResult;
    expect(()=>assertBehaviorSource(result,"experiment","tracking","a")).not.toThrow();
    for(const source of [["other","tracking","a"],["experiment","other","a"],["experiment","tracking","b"]]) {
      expect(()=>assertBehaviorSource(result,source[0],source[1],source[2])).toThrow();
    }
  });
});
describe("behavior review source separation",()=>{
  const correct:BehaviorReview={id:"review",type:"CORRECT",eventId:"rear_1",reviewerId:"A",createdAt:"2026-01-01",startSec:1.1,endSec:2.3,label:"REARING_SUPPORTED"};
  it("keeps automatic output immutable",()=>{const result=reviewedEvents([event],[correct]);expect(result[0].startSec).toBe(1.1);expect(event.startSec).toBe(1);expect(reviewedSummary(result).count).toBe(1);});
  it("confirm after correction preserves corrected boundaries",()=>{const result=reviewedEvents([event],[correct,{...correct,id:"confirm",type:"CONFIRM"}]);expect(result[0].endSec).toBe(2.3);expect(result[0].reviewStatus).toBe("confirmed");});
  it("reviews from another behavior event cannot change this event",()=>{expect(reviewedEvents([event],[{...correct,eventId:"other_run_event"}])).toEqual([event]);});
  it("rejected and pending episodes never inflate reviewed counts",()=>{expect(reviewedSummary([event]).count).toBe(0);expect(reviewedSummary(reviewedEvents([event],[{...correct,type:"REJECT"}])).count).toBe(0);});
});

it("peak subtype edits preserve the source frame and never become training intervals",()=>{
  const peak:BehaviorAnnotation={...annotation,type:"PEAK",startSec:undefined,endSec:undefined,timestampSec:.17,frameIndex:2};
  const edit:BehaviorAnnotation={...annotation,id:"edit",type:"LABEL_PEAK",targetId:peak.id,label:"REARING_SUPPORTED"};
  const history=[peak,edit];
  expect(activePeaks(history)[0]).toMatchObject({id:peak.id,timestampSec:.17,frameIndex:2,label:"REARING_SUPPORTED"});
  expect(activeAnnotations(history)).toEqual([]);
  expect(annotationsCsv(history,"v").trim().split("\n")).toHaveLength(1);
  expect(peaksCsv(history,"v")).toContain('"0.17","2","REARING_SUPPORTED"');
  expect(peak.label).toBe("REARING_UNSPECIFIED");
  expect(activePeaks([...history,{...edit,id:"undo",type:"UNDO",targetId:peak.id}])).toEqual([]);
});
