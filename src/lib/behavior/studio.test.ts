import { expect, it } from "vitest";
import { activePoseFrames, episodeForPeak, pendingEpisodes, suggestedPoseFrames, videoPoint } from "./studio";
import type { BehaviorAnnotation } from "./types";
const peak:BehaviorAnnotation={schemaVersion:1,id:"p",type:"PEAK",source:"human",experimentId:"e",trackingJobId:"t",videoSha256:"a".repeat(64),createdAt:"",timestampSec:.11,frameIndex:2,label:"REARING_SUPPORTED"};
it("only explicit rearing intervals complete peaks and half-open boundaries are respected",()=>{
 const interval:BehaviorAnnotation={...peak,id:"i",type:"INTERVAL",startSec:0,endSec:.11};
 expect(pendingEpisodes([peak,interval])).toEqual([peak]);
 expect(episodeForPeak([peak,{...interval,endSec:.12}],peak)?.id).toBe("i");
 expect(pendingEpisodes([peak,{...interval,endSec:.12,label:"NON_REARING"}])).toEqual([peak]);
 expect(pendingEpisodes([peak,{...peak,id:"unknown",label:"UNKNOWN"}])).toHaveLength(1);
 expect(pendingEpisodes([peak,{...interval,endSec:.12},{...peak,id:"u",type:"UNDO",targetId:"i"}])).toEqual([peak]);
});
it("pose revisions and undo preserve previous human versions without affecting peaks",()=>{
 const first:BehaviorAnnotation={...peak,id:"pose1",type:"POSE_FRAME"};
 const revised={...first,id:"pose2"};
 const history=[peak,first,revised];
 expect(activePoseFrames(history)).toEqual([revised]);
 expect(activePoseFrames([...history,{...peak,id:"undo",type:"UNDO",targetId:"pose2"}])).toEqual([first]);
 expect(history).toHaveLength(3);
});
it("suggests bounded unique source frames without inventing annotations",()=>{
 const times=[0,.04,.11,.12,.3,.6,.9,1.2];
 const suggestions=suggestedPoseFrames(times,[peak],[],5);
 expect(suggestions).toContain(2);expect(new Set(suggestions).size).toBe(suggestions.length);
 expect(suggestions.length).toBeLessThanOrEqual(5);expect(suggestions.every(i=>i>=0&&i<times.length)).toBe(true);
 expect(suggestedPoseFrames([],[],[])).toEqual([]);
});
it("maps clicks to source pixels and rejects letterbox bars at different window sizes",()=>{
 const rect={left:100,top:50,width:800,height:400};
 expect(videoPoint(500,250,rect,640,480)).toEqual({x:320,y:240});
 expect(videoPoint(110,250,rect,640,480)).toBeNull();
 expect(videoPoint(400,200,{left:0,top:0,width:800,height:400},640,480)).toEqual({x:320,y:240});
 expect(videoPoint(0,0,{left:0,top:0,width:0,height:0},640,480)).toBeNull();
});
it("keeps manually chosen saved frames reachable outside the automatic review batch",()=>{
 const times=Array.from({length:100},(_,i)=>i/25);
 const manual:BehaviorAnnotation={...peak,type:"POSE_FRAME",frameIndex:47,timestampSec:times[47]};
 expect(suggestedPoseFrames(times,[manual],[],5)).toContain(47);
});
