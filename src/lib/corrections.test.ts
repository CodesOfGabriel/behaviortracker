import { describe, expect, it } from "vitest";
import { applyCorrections } from "./corrections";
import { calculateOftMetrics } from "./metrics";
import { originalPose, referencePoseSamples, trajectorySegments } from "./pose";
import type { ArenaConfig, CorrectionEvent, PoseSample } from "../types";

const arena: ArenaConfig = { revision: 1, cornersPx: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}], widthCm:100,heightCm:100,centerAreaFraction:.25,boundaryPolicy:"center_inclusive" };
const point = (frameIndex: number, keypoint = "body_center"): PoseSample => ({frameIndex,timestampSec:frameIndex*.1,keypoint,xPx:10+frameIndex*10,yPx:50,likelihood:.9,status:"valid"});
const move = (frameIndex: number, x: number, keypoint = "body_center"): CorrectionEvent => ({id:`move-${frameIndex}-${keypoint}`,type:"MOVE_POINT",createdAt:"now",source:"manual",frameIndex,keypoint,after:{x,y:50}});

describe("correções manuais alimentam trajeto e métricas", () => {
  it("restaura um ponto ausente sem inventar o score nem alterar os dados brutos", () => {
    const raw = [point(0),{...point(1),xPx:null,yPx:null,likelihood:0,status:"missing" as const},point(2)];
    const revised = applyCorrections(raw,[move(1,20)]);
    expect(revised[1]).toMatchObject({xPx:20,yPx:50,source:"manual",status:"valid",likelihood:0});
    expect(originalPose(revised[1])).toMatchObject({xPx:null,yPx:null,status:"missing"});
    expect(raw[1].xPx).toBeNull();
    expect(calculateOftMetrics(raw,arena).distanceCm).toBeNull();
    expect(calculateOftMetrics(revised,arena).distanceCm).toBeCloseTo(20);
    expect(calculateOftMetrics(revised,arena).coveragePct).toBeCloseTo(100);
    expect(trajectorySegments(revised)).toEqual([[{x:10,y:50},{x:20,y:50},{x:30,y:50}]]);
  });
  it("cria a linha omitida usando o timestamp observado de outra parte no mesmo frame", () => {
    const raw = [point(0),point(1,"nose"),point(2)];
    const revised = applyCorrections(raw,[move(1,20)]);
    const center = revised.filter((p)=>p.keypoint==="body_center");
    expect(center).toHaveLength(3);
    expect(center[1]).toMatchObject({timestampSec:.1,xPx:20,source:"manual"});
    expect(calculateOftMetrics(center,arena).distanceCm).toBeCloseTo(20);
    expect(raw).toHaveLength(3);
  });
  it("não atravessa um frame inteiro omitido, mesmo com intervalo menor que meio segundo", () => {
    const raw = [point(0),point(2)];
    expect(calculateOftMetrics(raw,arena).unknownTimeSec).toBeCloseTo(.2);
    expect(calculateOftMetrics(raw,arena).distanceCm).toBeNull();
    expect(trajectorySegments(raw)).toEqual([]);
    const revised = applyCorrections(raw,[{...move(1,20),timestampSec:.1}]);
    expect(calculateOftMetrics(revised,arena).distanceCm).toBeCloseTo(20);
  });
  it("desfazer uma posição adicionada devolve a lacuna e as métricas anteriores", () => {
    const raw = [point(0),point(1,"nose"),point(2)];
    const event = move(1,20);
    const revised = applyCorrections(raw,[event,{id:"undo",type:"REVERT_EVENT",targetEventId:event.id,createdAt:"now",source:"manual"}]);
    expect(revised).toEqual(raw);
    expect(calculateOftMetrics(revised.filter(p=>p.keypoint==="body_center"),arena).distanceCm).toBeNull();
  });
  it("corrigir focinho não desloca silenciosamente o centro corporal", () => {
    const raw = [point(0),point(1),point(1,"nose"),point(2)];
    const revised = applyCorrections(raw,[move(1,90,"nose")]);
    expect(revised.find(p=>p.keypoint==="body_center"&&p.frameIndex===1)?.xPx).toBe(20);
  });
  it("recalcula tempo de centro, periferia e velocidade com as coordenadas revisadas", () => {
    const raw=[point(0),point(1),point(2)];
    const revised=applyCorrections(raw,[move(1,50)]);
    expect(calculateOftMetrics(raw,arena).centerTimeSec).toBe(0);
    const metrics=calculateOftMetrics(revised,arena);
    expect(metrics.centerTimeSec).toBeCloseTo(.1);
    expect(metrics.peripheralTimeSec).toBeCloseTo(.1);
    expect(metrics.distanceCm).toBeCloseTo(60);
    expect(metrics.meanSpeedCmS).toBeCloseTo(300);
  });
  it("não cria observações para confirmação sem posição, coordenadas inválidas ou tempo desconhecido", () => {
    expect(applyCorrections([], [{...move(1,20),type:"CONFIRM_POINT"}])).toEqual([]);
    expect(applyCorrections([], [move(1,20)])).toEqual([]);
    expect(applyCorrections([point(0)], [{...move(1,Number.NaN),timestampSec:.1}])).toEqual([point(0)]);
  });
  it("não esconde tempo desconhecido quando o centro foi omitido no início ou no fim", () => {
    const raw=[point(0,"nose"),point(1),point(2),point(3,"nose")];
    const centers=referencePoseSamples(raw,"body_center");
    expect(centers.map(p=>p.status)).toEqual(["missing","valid","valid","missing"]);
    expect(centers[0].original).toBeUndefined();
    expect(calculateOftMetrics(centers,arena).analysisDurationSec).toBeCloseTo(.3);
    expect(calculateOftMetrics(centers,arena).unknownTimeSec).toBeCloseTo(.2);
    expect(calculateOftMetrics(centers,arena).coveragePct).toBeCloseTo(100/3);
  });
  it("uma posição humana fora do chão não vira ocupação válida", () => {
    const revised = applyCorrections([point(0),point(1),point(2)],[move(1,150)]);
    expect(calculateOftMetrics(revised,arena).coveragePct).toBe(0);
    expect(calculateOftMetrics(revised,arena).distanceCm).toBeNull();
  });
});
