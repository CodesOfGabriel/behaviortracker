import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PoseSample } from "../types";
import { parseCanonicalPoseCsv, poseToCsv } from "./csv";
import { metricEligible, referencePoseSamples, visiblePose } from "./pose";
import { headTriangle, parseLayeredObservation } from "./oft-layers";
import { scalePoseToOriginal } from "../features/colab/videoGeometry";
import { LocalBodyOverlay } from "../features/local/LocalBodyOverlay";
import { drawPose } from "./video-export";
import pythonFixture from "../../tests/fixtures/oft-layered.csv?raw";

const sample: PoseSample = {
  frameIndex: 0, timestampSec: 0, keypoint: "mouse_center", xPx: 50, yPx: 50,
  likelihood: .9, status: "valid", source: "detected", processingVersion: "oft-layers-1",
  trackingAccepted: true, spatialRegion: "floor", bbox: {x:20,y:30,width:60,height:40},
  bodyAxis: {schemaVersion:"body-axis-2",frameIndex:0,timestampSec:0,
    points:Array.from({length:7},(_,i)=>({x:25+i*8,y:50})),state:"reliable",reason:"ok",
    rawAngleRad:0,angleRad:0,anisotropy:4,filtered:false,anatomicalPose:false},
  oftLayers: {version:"oft-layers-1",orientation:{state:"estimated",reason:"orientation_pending_review",
    head:{x:73,y:50},tailBase:{x:25,y:50},tailTip:null,confidence:.4,source:"temporal_estimate",metricEligible:false},
    rearing:{classification:"REARING_UNSPECIFIED",score:.8,scoreKind:"model_score",reviewStatus:"pending",metricEligible:false}},
};
const metadata=(row:PoseSample)=>JSON.stringify({bodyAxis:row.bodyAxis,oftLayers:row.oftLayers});

describe("camadas de Campo Aberto",()=>{
  it("preserva a origem heurística e checagens sem promover propostas para métricas",()=>{
    const row=structuredClone(sample);
    row.oftLayers!.rearing={classification:"REARING_UNSPECIFIED",score:.7,scoreKind:"heuristic_score",
      verification:"limited",reasons:["shortened_axis"],modelScore:.6,reviewStatus:"pending",metricEligible:false,
      evidence:{axisLengthRatio:.65,silhouetteLengthRatio:.7,silhouetteAreaRatio:.8,aspectRatio:.7,speedBodyLengthsSec:.3,headOnWall:false,floorOverlap:1}};
    const value=JSON.parse(metadata(row));value.oftLayers.rearing.metricEligible=true;value.oftLayers.rearing.reviewStatus="confirmed";
    const parsed=parseLayeredObservation(JSON.stringify(value),row);
    expect(parsed.oftLayers!.rearing).toEqual(row.oftLayers!.rearing);
    for(const [key,invalid] of [["scoreKind","probability"],["verification","confirmed"],["reasons",[12]],["modelScore",1.1]] as const) {
      const broken=JSON.parse(metadata(row));broken.oftLayers.rearing[key]=invalid;
      expect(()=>parseLayeredObservation(JSON.stringify(broken),row)).toThrow();
    }
  });
  it("não recupera a caixa bruta no Canvas quando a camada visual suspende o desenho",()=>{
    for(const state of ["stopped","suspended","unavailable"] as const) {
      const row=structuredClone(sample);
      row.oftLayers!.visualization={version:"image_flow_and_mask_v1",state,source:null,points:[],
        head:null,tailBase:null,box:null,orientationSource:"unknown",ageSec:null,supportScore:0,metricEligible:false};
      const context={beginPath:vi.fn(),stroke:vi.fn(),fill:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),strokeRect:vi.fn(),arc:vi.fn()};
      drawPose(context as unknown as CanvasRenderingContext2D,[row]);
      expect(context.strokeRect).not.toHaveBeenCalled();expect(context.lineTo).not.toHaveBeenCalled();
      expect(context.arc).not.toHaveBeenCalled();
    }
  });
  it("preserva recuperação bidirecional, incerteza e referência futura sem promover estimativas",()=>{
    const row=structuredClone(sample);
    row.oftLayers!.visualization={version:"image_flow_and_mask_v1",state:"estimated",source:"observed_geometry",
      points:row.bodyAxis!.points,head:{x:73,y:50},tailBase:{x:25,y:50},box:row.bbox!,
      orientationSource:"bidirectional_recovery",ageSec:.5,supportScore:.7,metricEligible:false,
      temporal:{version:"offline_pose_v2",orientationState:"estimated",anchorFrameIndex:10,margin:4,uncertaintyPx:2,metricEligible:false}};
    const [restored]=parseCanonicalPoseCsv(poseToCsv([row]));
    expect(restored.oftLayers!.visualization).toEqual(row.oftLayers!.visualization);
    const [scaled]=scalePoseToOriginal([restored],{width:640,height:480},{status:"optimized",uploadWidth:320,uploadHeight:240} as Parameters<typeof scalePoseToOriginal>[2]);
    expect(scaled.oftLayers!.visualization!.temporal!.uncertaintyPx).toBe(4);
    const value=JSON.parse(metadata(row));value.oftLayers.visualization.temporal.metricEligible=true;
    expect(parseLayeredObservation(JSON.stringify(value),row).oftLayers!.visualization!.temporal!.metricEligible).toBe(false);
    const missing=JSON.parse(metadata(row));delete missing.oftLayers.visualization.temporal;
    expect(()=>parseLayeredObservation(JSON.stringify(missing),row)).toThrow();
    for(const [key,invalid] of [["uncertaintyPx",-1],["margin",-1],["anchorFrameIndex",-1],["orientationState","confirmed"]]) {
      const value=JSON.parse(metadata(row));value.oftLayers.visualization.temporal[key]=invalid;
      expect(()=>parseLayeredObservation(JSON.stringify(value),row)).toThrow();
    }
  });
  it("preserva estimativas explícitas durante perdas sem promover os dados originais",()=>{
    const row=structuredClone(sample);row.status="missing";row.xPx=null;row.yPx=null;row.trackingAccepted=false;
    row.bodyAxis!.points=[];row.bodyAxis!.state="missing";
    row.oftLayers!.visualization={version:"image_flow_and_mask_v1",state:"estimated",source:"held_estimate",
      points:sample.bodyAxis!.points,head:{x:73,y:50},tailBase:{x:25,y:50},box:sample.bbox!,
      orientationSource:"previous_direction",ageSec:1.2,supportScore:.1,metricEligible:false};
    const [restored]=parseCanonicalPoseCsv(poseToCsv([row]));
    expect(restored.oftLayers!.visualization).toEqual(row.oftLayers!.visualization);
    expect(metricEligible(restored)).toBe(false);expect(restored.xPx).toBeNull();
    const markup=renderToStaticMarkup(createElement("svg",null,createElement(LocalBodyOverlay,{sample:restored,width:320,height:240})));
    expect(markup).toContain('data-visual-source="held_estimate"');expect(markup).toContain("polyline");
    expect(markup).toContain('data-head-marker="triangle"');expect(markup).not.toContain("<text");
    const context={beginPath:vi.fn(),stroke:vi.fn(),fill:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),strokeRect:vi.fn(),arc:vi.fn(),fillText:vi.fn()};
    drawPose(context as unknown as CanvasRenderingContext2D,[restored]);
    expect(context.lineTo).toHaveBeenCalled();expect(context.fillText).not.toHaveBeenCalled();
    const [scaled]=scalePoseToOriginal([restored],{width:640,height:480},{status:"optimized",uploadWidth:320,uploadHeight:240} as Parameters<typeof scalePoseToOriginal>[2]);
    expect(scaled.oftLayers!.visualization!.head).toEqual({x:146,y:100});
    expect(scaled.oftLayers!.visualization!.box!.width).toBe(120);
    const invalid=JSON.parse(metadata(restored));invalid.oftLayers.visualization.points[0].x=-1;
    expect(()=>parseLayeredObservation(JSON.stringify(invalid),restored)).toThrow();
    invalid.oftLayers.visualization.points[0].x=25;invalid.oftLayers.visualization.metricEligible=true;
    expect(parseLayeredObservation(JSON.stringify(invalid),restored).oftLayers!.visualization!.metricEligible).toBe(false);
  });
  it("preserva a projeção da cabeça na parede e usa um triângulo orientado sem texto",()=>{
    const row=structuredClone(sample);row.oftLayers!.orientation.headRegion="wall_projection";
    const [restored]=parseCanonicalPoseCsv(poseToCsv([row]));
    expect(restored.oftLayers!.orientation.headRegion).toBe("wall_projection");
    expect(headTriangle({x:73,y:50},{x:25,y:50},5)).toEqual([{x:78,y:50},{x:69.5,y:53.5},{x:69.5,y:46.5}]);
    expect(headTriangle({x:25,y:50},{x:25,y:50},5)).toEqual([]);
    const invalid=JSON.parse(metadata(row));invalid.oftLayers.orientation.headRegion="confirmed_rearing";
    expect(()=>parseLayeredObservation(JSON.stringify(invalid),row)).toThrow();
    const markup=renderToStaticMarkup(createElement("svg",null,createElement(LocalBodyOverlay,{sample:restored,width:320,height:240})));
    expect(markup).toContain('data-head-region="wall_projection"');expect(markup).not.toContain("<text");
  });
  it("importa o CSV produzido pelo exportador Python sem promover estimativas",()=>{
    const rows=parseCanonicalPoseCsv(pythonFixture);
    expect(rows).toHaveLength(10);
    const center=rows.find(r=>r.keypoint==="mouse_center")!;
    expect(center.oftLayers!.version).toBe("oft-layers-1");
    expect(center.bodyAxis!.points).toHaveLength(7);
    const estimates=rows.filter(r=>r.source==="recovered");
    expect(estimates).toHaveLength(9);
    expect(estimates.every(r=>r.original?.status==="missing"&&!metricEligible(r))).toBe(true);
  });
  it("preserva JSON com vírgulas e aspas no CSV sem perder a origem das estimativas",()=>{
    const row=structuredClone(sample);row.oftLayers!.orientation.reason='Revisar, ponto "estimado"';
    const [restored]=parseCanonicalPoseCsv(poseToCsv([row]));
    expect(restored.oftLayers).toEqual(row.oftLayers);
    expect(restored.bodyAxis).toEqual(row.bodyAxis);
  });
  it("mostra uma estimativa temporal de 0,4 sem incluí-la nas métricas",()=>{
    const row={...sample,keypoint:"head_midpoint",likelihood:.4,status:"low_confidence" as const,source:"recovered" as const};
    expect(visiblePose(row)).toBe(true);expect(metricEligible(row)).toBe(false);
    expect(visiblePose({...row,trackingAccepted:false})).toBe(false);
    expect(visiblePose({...row,processingVersion:"legacy"})).toBe(false);
  });
  it("rejeita metadados de outro quadro e pontos não finitos",()=>{
    for(const change of [
      (r:PoseSample)=>{r.bodyAxis!.frameIndex=1;},
      (r:PoseSample)=>{r.bodyAxis!.timestampSec=.1;},
      (r:PoseSample)=>{r.oftLayers!.orientation.head!.x=Infinity;},
      (r:PoseSample)=>{r.bodyAxis!.points=[];r.bodyAxis!.state="outlier";r.oftLayers!.orientation.head={x:-1,y:1};},
    ]){const row=structuredClone(sample);change(row);expect(()=>parseLayeredObservation(metadata(row),sample)).toThrow();}
  });
  it("não aceita elegibilidade para métricas ou confirmação vindas do arquivo",()=>{
    const value=JSON.parse(metadata(sample));value.oftLayers.orientation.metricEligible=true;
    value.oftLayers.rearing.metricEligible=true;value.oftLayers.rearing.reviewStatus="confirmed";
    const restored=parseLayeredObservation(JSON.stringify(value),sample);
    expect(restored.oftLayers!.orientation.metricEligible).toBe(false);
    expect(restored.oftLayers!.rearing).toMatchObject({reviewStatus:"pending",metricEligible:false});
  });
  it("escala eixo, cabeça e cauda junto com a caixa ao voltar ao vídeo original",()=>{
    const [scaled]=scalePoseToOriginal([sample],{width:640,height:480},{status:"optimized",uploadWidth:320,uploadHeight:240} as Parameters<typeof scalePoseToOriginal>[2]);
    expect(scaled.bodyAxis!.points[0]).toEqual({x:50,y:100});
    expect(scaled.oftLayers!.orientation.head).toEqual({x:146,y:100});
    expect(scaled.oftLayers!.orientation.tailBase).toEqual({x:50,y:100});
  });
  it("preserva a camada visual quando a geometria impede métricas no piso",()=>{
    const row={...sample,status:"low_confidence" as const,spatialRegion:"wall_projection" as const,
      localQuality:{tracking:"observed" as const,geometry:"wall_projection" as const,reasons:[]}};
    const [reference]=referencePoseSamples([row],"mouse_center");
    expect(reference.xPx).toBeNull();expect(reference.oftLayers).toEqual(row.oftLayers);
    expect(metricEligible(reference)).toBe(false);
  });
  it("renderiza as mesmas camadas recebidas do Colab sem precisar de contorno local",()=>{
    const markup=renderToStaticMarkup(createElement("svg",null,createElement(LocalBodyOverlay,{sample,width:320,height:240})));
    expect(markup).toContain("polyline");expect(markup).toContain("Cabeça estimada");
    expect(markup).toContain('data-orientation-source="temporal_estimate"');
    expect(markup).toContain('data-head-marker="triangle"');
    expect(markup).not.toContain("<text");
  });
  it("o exportador usa marcadores sem texto e encerra a sobreposição na intervenção",()=>{
    const context={canvas:{height:240},beginPath:vi.fn(),stroke:vi.fn(),fill:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),
      strokeRect:vi.fn(),arc:vi.fn(),fillText:vi.fn()};
    drawPose(context as unknown as CanvasRenderingContext2D,[sample]);
    expect(context.fillText).not.toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.arc).toHaveBeenCalledWith(25,50,3,0,Math.PI*2);
    vi.clearAllMocks();
    drawPose(context as unknown as CanvasRenderingContext2D,[{...sample,reason:"researcher_intervention"}]);
    expect(context.stroke).not.toHaveBeenCalled();expect(context.strokeRect).not.toHaveBeenCalled();
  });
});
