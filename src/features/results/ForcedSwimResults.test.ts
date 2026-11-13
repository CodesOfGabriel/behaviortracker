import { describe, expect, it } from "vitest";
import { parseFstResult } from "./ForcedSwimResults";

const result = {
  schemaVersion:"fst-result-1",protocol:"forced_swim",engineId:"fst_superanimal_quadruped_v1",analysisVersion:"fst-0.1",runId:"run-1",
  video:{sha256:"a".repeat(64),originalSha256:"b".repeat(64),filename:"fst.mp4",width:400,height:300,fps:30,frameCount:2},
  subjects:[{animalId:"animal_1",subjectId:"R1"}],tanks:[{tankId:"tank_1",animalId:"animal_1",subjectId:"R1",roiPx:{x:0,y:0,width:200,height:300},revision:1}],
  frames:[{frame:0,timestampSec:0,animalId:"animal_1",presence:"NOT_IN_TANK",bodyScore:0,silhouetteChange:null,bbox:null,poseCoverage:0,relativeMotion:null,centroidMotion:null,classification:"NOT_CLASSIFIED"}],
  keypointNames:["nose"],poseArrays:{animal_1:[[[40,50,.9]]]},quality:{animal_1:{presenceSec:0,anatomicalCoverage:0,insufficientDataSec:0}},reviewShortlist:[],insufficientIntervals:{animal_1:[]}
};
describe("resultado FST",()=>{
  it("aceita presença sem tracking e conserva pose bruta separada",()=>{
    const parsed=parseFstResult(JSON.stringify(result));
    expect(parsed.frames[0].bbox).toBeNull();
    expect(parsed.poseArrays.animal_1[0][0]).toEqual([40,50,.9]);
  });
  it("rejeita caixas durante ausência e classificação automática sem versão validada",()=>{
    expect(()=>parseFstResult(JSON.stringify({...result,frames:[{...result.frames[0],bbox:{x:1,y:2,width:3,height:4}}]}))).toThrow();
    expect(()=>parseFstResult(JSON.stringify({...result,frames:[{...result.frames[0],classification:"IMMOBILITY"}]}))).toThrow();
  });
  it("não interpreta CSV OFT como FST",()=>{
    expect(()=>parseFstResult("frame_index,timestamp_sec,keypoint\n0,0,nose")).toThrow();
  });
});
