import { describe, expect, it } from "vitest";
import { correctedRamSamples, ramFrames, deriveRamResult } from "./review";
import { validateRamEventGeometry } from "./geometry";
import type { CorrectionEvent, PoseSample, RadialMazeExperiment } from "../../types";

const samples: PoseSample[] = [0,1,2].map(frameIndex=>({frameIndex,timestampSec:frameIndex*.04,keypoint:"box_center",xPx:100+frameIndex,yPx:100,source:"segmented",status:"valid",likelihood:0}));
const edit = (frameIndex: number): CorrectionEvent => ({id:`edit-${frameIndex}`,type:"SET_BOX",frameIndex,timestampSec:frameIndex*.04,keypoint:"box_center",afterBox:{x:90,y:90,width:20,height:20},source:"manual",createdAt:"2026-01-01"});
const experiment: RadialMazeExperiment = { id:"experiment",schemaVersion:"1.0",analysisMethodVersion:"ram-1.0",analysisEngine:"wistar_ram_hybrid_v1",modelBundleId:"wistar_df_v2",title:"Session",subjectId:"subject",testType:"radial_arm_maze",status:"draft",createdAt:"2026-01-01",updatedAt:"2026-01-01",corrections:[], geometry:{revision:1,walkablePolygonPx:[{x:0,y:0},{x:320,y:0},{x:320,y:240},{x:0,y:240}],centerPolygonPx:[],arms:[],referenceFrameSec:0,walkableMaskVersion:"mask"},video:{filename:"session.mov",sizeBytes:1,width:320,height:240,durationSec:1,fps:25,timingSource:"ffprobe"},visitPolicy:{minimumArmDwellSec:.1,minimumCenterDwellSec:.1,minimumDistalDwellSec:.1,unknownGapToleranceSec:0,choiceCriterion:"arm_entry"} };

describe("RAM review and temporal evidence",()=>{
  it("keeps raw samples immutable and never interpolates between manual boxes",()=>{
    const result=correctedRamSamples(samples,[edit(0),edit(2)]);
    expect(result[1]).toBe(samples[1]);
    expect(result[0].source).toBe("manual");
    expect(result[0].bodyBbox).toEqual(edit(0).afterBox);
    expect(samples[0].bbox).toBeUndefined();
    const undo:CorrectionEvent={...edit(0),id:"undo",type:"REVERT_EVENT",targetEventId:"edit-0"};
    expect(correctedRamSamples(samples,[edit(0),undo])[0].source).toBe("segmented");
  });
  it("excludes predictions and uncertain detections from metric evidence",()=>{
    const frames=ramFrames([{...samples[0],source:"predicted"},{...samples[1],status:"low_confidence"},samples[2]]);
    expect(frames.map(f=>f.center!==null)).toEqual([false,false,true]);
  });
  it("excludes a manual correction outside the spatial mask",()=>{
    const outside = [{...samples[0],xPx:500,source:"manual" as const},{...samples[1],xPx:501,source:"manual" as const}];
    expect(ramFrames(outside,experiment.geometry).every(f=>f.center===null)).toBe(true);
    expect(deriveRamResult(outside,{...experiment,spatialCalibration:{pixelsPerCm:10,method:"planar_uniform"}}).distanceCm).toBe(0);
  });
  it("does not publish events from mask-only geometry or bridge missing frames",()=>{
    expect(validateRamEventGeometry(experiment.geometry,320,240)).not.toBeNull();
    const result=deriveRamResult([samples[0],samples[2]],experiment);
    expect(result.metrics).toBeNull();
    expect(result.temporalQuality.observedSec).toBe(0);
    expect(result.distanceCm).toBeNull();
    expect(result.rewardRemoval).toBe("NOT_CONFIRMED");
  });
});
