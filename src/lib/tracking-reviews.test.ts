import { describe, expect, it } from "vitest";
import { makeDemoExperiment } from "./demo-data";
import { reviewEvents, selectTrackingReview, hasUnassignedCorrections } from "./tracking-reviews";
import { applyCorrections } from "./corrections";
import type { CorrectionEvent, Experiment, PoseSample } from "../types";

const point: PoseSample = {frameIndex:0,timestampSec:0,keypoint:"body_center",xPx:10,yPx:20,status:"valid",likelihood:.9};
const move:CorrectionEvent={id:"original-manual",type:"MOVE_POINT",source:"manual",createdAt:"now",frameIndex:0,keypoint:"body_center",after:{x:90,y:80}};
const colab={engine:"colab" as const,jobId:"original"};
const local={engine:"opencv" as const,jobId:"local"};
const select=(exp:Experiment,selection:typeof colab|typeof local,samples=[point])=>({...exp,...selectTrackingReview(exp,selection,samples)});

describe("revisões isoladas por fonte e execução",()=>{
  it("preserva as marcações do Colab ao selecionar local, voltar e recarregar o projeto",()=>{
    const initial={...makeDemoExperiment(),corrections:[move],referencePoint:"body_center"};
    const original=select(initial,colab);
    const switched=select(original,local,[{...point,keypoint:"box_center"}]);
    expect(switched.corrections).toEqual(initial.corrections);
    expect(reviewEvents(switched)).toEqual([]);
    expect(switched.referencePoint).toBe("box_center");
    const restored=select(JSON.parse(JSON.stringify(switched)),colab);
    expect(restored.referencePoint).toBe("body_center");
    expect(applyCorrections([point],reviewEvents(restored))[0]).toMatchObject({xPx:90,yPx:80,source:"manual"});
  });
  it("não reaplica a revisão de uma execução a um novo processamento do mesmo motor",()=>{
    const initial=select({...makeDemoExperiment(),corrections:[move]},colab);
    const rerun=select(initial,{engine:"colab",jobId:"new"});
    expect(reviewEvents(rerun)).toEqual([]);
    expect(rerun.corrections).toHaveLength(1);
  });
  it("não adivinha a origem das marcações antigas quando o OpenCV já estava selecionado",()=>{
    const initial={...makeDemoExperiment(),trackingSelection:local,corrections:[move]};
    expect(hasUnassignedCorrections(initial)).toBe(true);
    expect(reviewEvents(initial)).toEqual([]);
    const restored=select(initial,colab);
    expect(reviewEvents(restored)).toEqual([]);
    expect(reviewEvents({...restored,legacyReviewSource:"colab:original"})).toEqual([move]);
  });
  it("desfazer herda a fonte do evento alvo e não desfaz correções de outro resultado",()=>{
    const scoped={...move,reviewSource:"colab:original"};
    const localMove={...move,id:"local-correction",reviewSource:"opencv:local",after:{x:30,y:40}};
    const undo:CorrectionEvent={id:"undo",type:"REVERT_EVENT",targetEventId:localMove.id,reviewSource:"colab:original",createdAt:"now",source:"manual"};
    const original={...makeDemoExperiment(),trackingSelection:colab,corrections:[scoped,localMove,undo]};
    expect(reviewEvents(original)).toEqual([scoped]);
    expect(applyCorrections([point],reviewEvents(original))[0].xPx).toBe(90);
    const switched=select(original,local);
    expect(applyCorrections([point],reviewEvents(switched))[0].xPx).toBe(10);
  });
  it("compartilha somente episódios comportamentais confirmados no mesmo vídeo",()=>{
    const videoSha256 = "a".repeat(64);
    const behavior:CorrectionEvent={id:"behavior",type:"ANNOTATE_BEHAVIOR",label:"rearing",startSec:1,endSec:2,createdAt:"now",source:"manual",sourceVideoSha256:videoSha256};
    const original=select({...makeDemoExperiment(),video:{...makeDemoExperiment().video,sha256:videoSha256},corrections:[move,behavior]},colab);
    expect(reviewEvents(select(original,local))).toEqual([behavior]);
  });
  it("não compartilha candidatos rejeitados entre execuções",()=>{
    const candidate:CorrectionEvent={id:"candidate",type:"REJECT_CANDIDATE",candidateId:"rearing-1",createdAt:"now",source:"manual"};
    const original=select({...makeDemoExperiment(),corrections:[candidate]},colab);
    expect(reviewEvents(select(original,{engine:"colab",jobId:"new"}))).toEqual([]);
  });
});
