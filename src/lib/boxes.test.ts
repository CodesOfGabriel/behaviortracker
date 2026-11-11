import { describe, expect, it } from "vitest";
import { boxFromPoints, detectorTrajectory, provisionalBoxAt, translateBox } from "./boxes";
import { applyCorrections } from "./corrections";
import { originalPose, metricEligible } from "./pose";
import { parseCanonicalPoseCsv, poseToCsv } from "./csv";
import type { CorrectionEvent, PoseSample } from "../types";

const raw:PoseSample={frameIndex:3,timestampSec:.125,keypoint:"box_center",xPx:50,yPx:60,status:"valid",likelihood:0,source:"segmented",
  spatialRegion:"floor",bbox:{x:30,y:40,width:40,height:40},metricReference:"box_center",referenceApproved:false};
const edit:CorrectionEvent={id:"box",type:"SET_BOX",frameIndex:3,timestampSec:.125,keypoint:"box_center",source:"manual",createdAt:"now",afterBox:{x:50,y:50,width:40,height:20}};

describe("caixa macro e correções auditáveis",()=>{
  it("mostra o percurso das caixas mesmo quando o ponto anatômico tem baixa confiança, sem criar pontes",()=>{
    const frames:PoseSample[]=[0,1,2,3,4].map(frameIndex=>({
      frameIndex,timestampSec:frameIndex/25,keypoint:"mouse_center",xPx:20,yPx:20,
      likelihood:.1,status:"low_confidence",source:"detected",
      bbox:frameIndex===2?undefined:{x:frameIndex*10,y:20,width:20,height:20},
    }));
    const track=detectorTrajectory(frames,100,80,5);
    expect(track).toMatchObject({observedFrames:4,totalFrames:5,coveragePct:80});
    expect(track.segments).toEqual([
      [{x:10,y:30},{x:20,y:30}],
      [{x:40,y:30},{x:50,y:30}],
    ]);
    const withPrediction={...frames[2],source:"predicted" as const,bbox:{x:20,y:20,width:20,height:20}};
    expect(detectorTrajectory([...frames,withPrediction],100,80,5).observedFrames).toBe(4);
    const manualBox={...frames[2],source:"manual" as const,bbox:{x:20,y:20,width:20,height:20}};
    expect(detectorTrajectory([...frames,manualBox],100,80,5).observedFrames).toBe(4);
  });
  it("desenha em qualquer direção e limita a translação à imagem",()=>{
    expect(boxFromPoints({x:100,y:90},{x:50,y:30})).toEqual({x:50,y:30,width:50,height:60});
    expect(translateBox({x:10,y:20,width:30,height:40},{x:1000,y:-200},100,80)).toEqual({x:70,y:0,width:30,height:40});
  });
  it("clique posiciona uma caixa provisória ajustável dentro da imagem",()=>{
    expect(provisionalBoxAt({x:50,y:40},100,80)).toEqual({x:44,y:34,width:12,height:12});
    expect(provisionalBoxAt({x:0,y:0},100,80)).toEqual({x:0,y:0,width:12,height:12});
    expect(provisionalBoxAt({x:100,y:80},100,80)).toEqual({x:88,y:68,width:12,height:12});
  });
  it("edita caixa e trajeto sem deslocar outros pontos ou alterar o bruto",()=>{
    const [revised,nose]=applyCorrections([raw,{...raw,keypoint:"nose"}],[edit]);
    expect(revised).toMatchObject({xPx:70,yPx:60,bbox:edit.afterBox,source:"manual"});
    expect(nose.xPx).toBe(50);
    expect(originalPose(revised)).toMatchObject(raw);
    expect(raw.bbox?.x).toBe(30);
  });
  it("cria a caixa ausente usando o relógio do frame, sem preencher outros frames",()=>{
    const missing={...raw,bbox:undefined,xPx:null,yPx:null,status:"missing" as const};
    expect(applyCorrections([missing],[edit])[0]).toMatchObject({xPx:70,status:"valid",source:"manual"});
    expect(applyCorrections([],[edit])).toHaveLength(1);
    expect(applyCorrections([],[{...edit,timestampSec:undefined}])).toEqual([]);
  });
  it("exporta e restaura as caixas bruta/revisada e a origem verdadeira",()=>{
    const [revised]=applyCorrections([raw],[edit]);
    const [restored]=parseCanonicalPoseCsv(poseToCsv([revised]));
    expect(restored.bbox).toEqual(edit.afterBox);
    expect(originalPose(restored)).toMatchObject(raw);
    expect(metricEligible(originalPose(restored))).toBe(false);
  });
  it("não converte previsão em medição por causa de um retângulo",()=>{
    const predicted={...raw,source:"predicted" as const,referenceApproved:true};
    expect(metricEligible(predicted)).toBe(false);
    const [confirmed]=applyCorrections([predicted],[{...edit,type:"CONFIRM_POINT"}]);
    expect(confirmed.source).toBe("predicted");
    const [positioned]=applyCorrections([predicted],[edit]);
    expect(positioned.source).toBe("manual");
    expect(originalPose(positioned).source).toBe("predicted");
  });
  it("centro geométrico segmentado só entra após consentimento e observação estável no chão",()=>{
    expect(metricEligible(raw)).toBe(false);
    expect(metricEligible({...raw,referenceApproved:true})).toBe(true);
    expect(metricEligible({...raw,referenceApproved:true,status:"low_confidence"})).toBe(false);
    expect(metricEligible({...raw,referenceApproved:true,spatialRegion:"wall_projection"})).toBe(false);
  });
  it("desfazer restaura caixa e trajeto originais; rejeita caixas inválidas",()=>{
    expect(applyCorrections([raw],[edit,{id:"undo",type:"REVERT_EVENT",targetEventId:edit.id,source:"manual",createdAt:"now"}])).toEqual([raw]);
    expect(applyCorrections([raw],[{...edit,afterBox:{x:10,y:20,width:-3,height:10}}])).toEqual([raw]);
    expect(()=>parseCanonicalPoseCsv(poseToCsv([{...raw,bbox:{x:10,y:20,width:0,height:10}}]))).toThrow();
  });
  it("interpola caixas entre dois quadros-chave pelo tempo real, sem validar as previsões",()=>{
    const frames:PoseSample[]=[
      {...raw,frameIndex:0,timestampSec:0},
      {...raw,frameIndex:1,timestampSec:.1,xPx:null,yPx:null,bbox:undefined,status:"missing"},
      {...raw,frameIndex:2,timestampSec:.4},
      {...raw,frameIndex:3,timestampSec:.5},
    ];
    const first={...edit,frameIndex:0,timestampSec:0,afterBox:{x:0,y:20,width:20,height:20}};
    const last={...edit,id:"last",frameIndex:3,timestampSec:.5,afterBox:{x:50,y:30,width:40,height:30}};
    const revised=applyCorrections(frames,[first,last]);
    expect(revised.map((sample)=>sample.source)).toEqual(["manual","predicted","predicted","manual"]);
    expect(revised[1].bbox).toEqual({x:10,y:22,width:24,height:22});
    expect(revised[2].bbox).toEqual({x:40,y:28,width:36,height:28});
    expect(revised[1]).toMatchObject({reason:"manual_keyframe_interpolation",status:"low_confidence",referenceApproved:false});
    expect(metricEligible(revised[1])).toBe(false);
    expect(originalPose(revised[1])).toMatchObject({xPx:null,yPx:null,status:"missing"});
    expect(frames[2].bbox?.x).toBe(30);
    expect(originalPose(revised[2]).bbox?.x).toBe(30);
  });
  it("cria previsão onde o detector omitiu a linha, mas preserva ausência manual e o bruto",()=>{
    const frames=[{...raw,frameIndex:0,timestampSec:0},
      {...raw,frameIndex:1,timestampSec:.1,keypoint:"nose"},
      {...raw,frameIndex:2,timestampSec:.2,keypoint:"nose"},
      {...raw,frameIndex:3,timestampSec:.3,keypoint:"nose"},
      {...raw,frameIndex:4,timestampSec:.4}];
    const first={...edit,frameIndex:0,timestampSec:0,afterBox:{x:0,y:0,width:20,height:20}};
    const last={...edit,id:"last",frameIndex:4,timestampSec:.4,afterBox:{x:40,y:0,width:20,height:20}};
    const missing:CorrectionEvent={id:"missing",type:"MARK_MISSING",frameIndex:2,timestampSec:.2,keypoint:"box_center",source:"manual",createdAt:"now"};
    const revised=applyCorrections(frames,[first,last,missing]);
    const boxes=revised.filter((sample)=>sample.keypoint==="box_center");
    expect(boxes.map((sample)=>sample.frameIndex)).toEqual([0,1,3,4]);
    expect(boxes[1].bbox?.x).toBe(10);
    expect(originalPose(boxes[1])).toMatchObject({xPx:null,yPx:null,status:"missing",source:"detected"});
    const [exported]=parseCanonicalPoseCsv(poseToCsv([boxes[1]]));
    expect(exported.source).toBe("predicted");
    expect(exported.reason).toBe("manual_keyframe_interpolation");
    expect(originalPose(exported)).toMatchObject({xPx:null,yPx:null,status:"missing",source:"detected"});
    expect(boxes[2].bbox?.x).toBeCloseTo(30);
    expect(frames).toHaveLength(5);
  });
  it("novo quadro-chave divide o intervalo; desfazer recalcula a previsão original",()=>{
    const frames=Array.from({length:5},(_,index)=>({...raw,frameIndex:index,timestampSec:index*.1}));
    const first={...edit,frameIndex:0,timestampSec:0,afterBox:{x:0,y:0,width:20,height:20}};
    const last={...edit,id:"last",frameIndex:4,timestampSec:.4,afterBox:{x:40,y:0,width:20,height:20}};
    const middle={...edit,id:"middle",frameIndex:2,timestampSec:.2,afterBox:{x:20,y:40,width:30,height:30}};
    expect(applyCorrections(frames,[first,last,middle])[1].bbox).toEqual({x:10,y:20,width:25,height:25});
    const reverted=applyCorrections(frames,[first,last,middle,{id:"undo",type:"REVERT_EVENT",targetEventId:"middle",source:"manual",createdAt:"now"}]);
    expect(reverted[1].bbox).toEqual({x:10,y:0,width:20,height:20});
    expect(reverted[2].source).toBe("predicted");
  });
});
