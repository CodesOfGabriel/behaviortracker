import { describe, expect, it } from "vitest";
import { calculateOftMetrics, calculateObservedFloorBoxMetrics } from "./metrics";
import { referencePoseSamples } from "./pose";
import type { ArenaConfig, PoseSample, PoseStatus } from "../types";

const arena: ArenaConfig = {
  revision: 1,
  cornersPx: [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 60 },
    { x: 0, y: 60 },
  ],
  widthCm: 60,
  heightCm: 60,
  centerAreaFraction: 0.25,
  boundaryPolicy: "center_inclusive",
};

function sample(frame: number, time: number, x: number | null, y: number | null, status: PoseStatus = "valid"): PoseSample {
  return {
    frameIndex: frame,
    timestampSec: time,
    keypoint: "body_center",
    xPx: x,
    yPx: y,
    likelihood: status === "missing" ? 0.1 : 0.99,
    status,
  };
}

describe("métricas OFT", () => {
  it("SCI-001: calcula distância 3-4-5 e velocidade pelo tempo observado", () => {
    const result = calculateOftMetrics([sample(0, 0, 0, 0), sample(1, 1, 3, 4)], arena, { maxPairGapSec: 2 });
    expect(result.distanceCm).toBeCloseTo(5, 8);
    expect(result.meanSpeedCmS).toBeCloseTo(5, 8);
  });

  it("SCI-002: não cria uma ponte através de ponto ausente", () => {
    const result = calculateOftMetrics([
      sample(0, 0, 0, 0),
      sample(1, 1, null, null, "missing"),
      sample(2, 2, 30, 40),
    ], arena, { maxPairGapSec: 2 });
    expect(result.distanceCm).toBeNull();
    expect(result.unknownTimeSec).toBeCloseTo(2, 8);
  });

  it("SCI-004: separa centro, periferia e tempo desconhecido", () => {
    const result = calculateOftMetrics([
      sample(0, 0, 30, 30),
      sample(1, 2, 5, 5),
      sample(2, 5, 5, 5),
      sample(3, 6, null, null, "missing"),
    ], arena, { maxPairGapSec: 4 });
    expect(result.centerTimeSec).toBeCloseTo(2, 8);
    expect(result.peripheralTimeSec).toBeCloseTo(3, 8);
    expect(result.unknownTimeSec).toBeCloseTo(1, 8);
    expect(result.centerPctClassifiable).toBeCloseTo(40, 8);
  });

  it("SCI-009: usa o centro da caixa quando não há pontos anatômicos", () => {
    const tracked = [
      sample(0, 0, null, null, "missing"),
      sample(1, 1, null, null, "missing"),
    ].map((pose, index) => ({
      ...pose,
      keypoint: "nose",
      bbox: { x: index === 0 ? 25 : 0, y: index === 0 ? 25 : 0, width: 10, height: 10 },
    }));
    const reference = referencePoseSamples(tracked, "box_center");
    const result = calculateOftMetrics(reference, arena, { maxPairGapSec: 2 });
    expect(reference.map((point) => [point.xPx, point.yPx])).toEqual([[30, 30], [5, 5]]);
    expect(result.centerTimeSec).toBe(1);
    expect(result.peripheralTimeSec).toBe(0);
    expect(result.unknownTimeSec).toBe(0);
  });

  it("SCI-010: ignora ponto anatômico de baixa confiança quando a caixa existe", () => {
    const tracked = [
      { ...sample(0, 0, 30, 30), likelihood: 0.2, status: "low_confidence" as const,
        bbox: { x: 25, y: 25, width: 10, height: 10 } },
      { ...sample(1, 1, 5, 5), likelihood: 0.2, status: "low_confidence" as const,
        bbox: { x: 0, y: 0, width: 10, height: 10 } },
    ];
    const reference = referencePoseSamples(tracked, "body_center");
    const result = calculateOftMetrics(reference, arena, { maxPairGapSec: 2 });
    expect(reference.map((point) => [point.xPx, point.yPx])).toEqual([[30, 30], [5, 5]]);
    expect(result.centerTimeSec).toBe(1);
    expect(result.unknownTimeSec).toBe(0);
  });

  it("SCI-007: não classifica intervalos longos nem pontos recuperados ainda não confirmados", () => {
    const result = calculateOftMetrics([sample(0, 0, 30, 30), sample(1, 3, 31, 30)], arena);
    expect(result.unknownTimeSec).toBe(3);
    expect(result.coveragePct).toBe(0);
    const recovered = [sample(0, 0, 30, 30), { ...sample(1, .04, 31, 30), source: "recovered" as const }];
    expect(calculateOftMetrics(recovered, arena).distanceCm).toBeNull();
    expect(calculateOftMetrics(recovered.map((p) => ({ ...p, source: "manual" as const })), arena).distanceCm).toBeCloseTo(1);
  });

  it("SCI-008: baixa confiança, saltos e previsões não contam como imobilidade", () => {
    for (const override of [{ status: "low_confidence" as const }, { status: "jump" as const }, { source: "predicted" as const }]) {
      const result = calculateOftMetrics([sample(0, 0, 30, 30), { ...sample(1, .4, 30, 30), ...override }, sample(2, .8, 30, 30)], arena);
      expect(result.coveragePct).toBe(0);
      expect(result.immobilityTimeSec).toBe(0);
    }
  });

  it("SCI-005: não conta entrada quando a sessão começa no centro", () => {
    const result = calculateOftMetrics([
      sample(0, 0, 30, 30),
      sample(1, 1, 31, 30),
      sample(2, 2, 5, 5),
    ], arena, { maxPairGapSec: 2 });
    expect(result.centerEntries).toBe(0);
    expect(result.centerLatencySec).toBeNull();
  });

  it("SCI-006: conta transições observáveis com dwell mínimo", () => {
    const result = calculateOftMetrics([
      sample(0, 0, 5, 5),
      sample(1, 1, 30, 30),
      sample(2, 2, 31, 30),
      sample(3, 3, 5, 5),
      sample(4, 4, 30, 30),
      sample(5, 5, 31, 30),
    ], arena, { maxPairGapSec: 2, minCenterDwellSec: 0.5 });
    expect(result.centerEntries).toBe(2);
    expect(result.centerLatencySec).toBeCloseTo(1, 8);
  });
});


describe("estimativas locais pelo centro da caixa no piso",()=>{
  const box=(frame:number,time:number,x:number,y=30):PoseSample=>({frameIndex:frame,timestampSec:time,keypoint:"box_center",xPx:0,yPx:0,
    bbox:{x:x-1,y:y-1,width:2,height:2},likelihood:0,source:"segmented",status:"valid",metricReference:"box_center",referenceApproved:false,
    spatialRegion:"floor",trackingAccepted:true,localQuality:{tracking:"observed",geometry:"floor",reasons:[]}});
  it("calcula a distância pelo centro da caixa sem conceder aprovação à referência",()=>{
    const input=[box(0,0,10,10),box(1,.1,13,14)],before=JSON.stringify(input);
    const result=calculateObservedFloorBoxMetrics(input,arena,60,60);
    expect(result.metrics.distanceCm).toBeCloseTo(5);
    expect(result.metrics.meanSpeedCmS).toBeCloseTo(50);
    expect(result.pendingReferenceFrames).toBe(2);
    expect(result.policy.referenceApproval).toBe("not_granted");
    expect(JSON.stringify(input)).toBe(before);
    expect(calculateOftMetrics(referencePoseSamples(input,"box_center"),arena).distanceCm).toBeNull();
  });
  it("mede centro e entradas somente nos intervalos classificáveis com permanência mínima",()=>{
    const rows=[box(0,0,5),box(1,.1,30),box(2,.2,30),box(3,.3,30),box(4,.4,5)];
    const metrics=calculateObservedFloorBoxMetrics(rows,arena,60,60).metrics;
    expect(metrics.centerTimeSec).toBeCloseTo(.3);expect(metrics.centerEntries).toBe(1);
    expect(metrics.centerPctClassifiable).toBeCloseTo(75);
    expect(metrics.centerLatencySec).toBeCloseTo(.1);
  });
  it("mantém previsões, recuperações, câmera deslocada e rastreamento incerto fora das estimativas",()=>{
    for(const override of [{source:"predicted" as const},{source:"recovered" as const},{reason:"camera_shift"},{trackingAccepted:false},
      {localQuality:{tracking:"uncertain" as const,geometry:"floor" as const,reasons:[]}}]){
      const result=calculateObservedFloorBoxMetrics([box(0,0,10),{...box(1,.1,20),...override},box(2,.2,30)],arena,60,60);
      expect(result.metrics.distanceCm).toBeNull();expect(result.metrics.unknownTimeSec).toBeCloseTo(.2);
    }
  });
  it("rejeita a geometria insuficiente mesmo que a caixa esteja acompanhando o corpo",()=>{
    for(const override of [{spatialRegion:"wall_projection" as const},
      {localQuality:{tracking:"observed" as const,geometry:"boundary" as const,reasons:[]}},
      {spatialRegion:"unknown" as const}]){
      const result=calculateObservedFloorBoxMetrics([box(0,0,10),{...box(1,.1,20),...override}],arena,60,60);
      expect(result.metrics.distanceCm).toBeNull();expect(result.eligibleFloorFrames).toBe(1);
    }
    const outside=calculateObservedFloorBoxMetrics([box(0,0,80),box(1,.1,81)],arena,100,100);
    expect(outside.metrics.distanceCm).toBeNull();expect(outside.eligibleFloorFrames).toBe(0);
    expect(outside.exclusions.outside_calibrated_floor).toBe(2);
  });
  it("preserva saltos de frame e tempo e distingue ausência de medida de zero observado",()=>{
    expect(calculateObservedFloorBoxMetrics([box(0,0,20),box(2,.1,20)],arena,60,60).metrics.distanceCm).toBeNull();
    expect(calculateObservedFloorBoxMetrics([box(0,0,20),box(1,1,20)],arena,60,60).metrics.distanceCm).toBeNull();
    expect(calculateObservedFloorBoxMetrics([box(0,0,20),box(1,.1,20)],arena,60,60).metrics.distanceCm).toBe(0);
  });
  it("conta cada frame uma vez em resultados com vários pontos anatômicos",()=>{
    const rows=[box(0,0,10),box(1,.1,20)];
    const result=calculateObservedFloorBoxMetrics(rows.flatMap(row=>[row,{...row,keypoint:"nose"},{...row,keypoint:"tail"}]),arena,60,60);
    expect(result.frameCount).toBe(2);expect(result.metrics.analysisDurationSec).toBe(.1);expect(result.metrics.distanceCm).toBe(10);
  });
});
