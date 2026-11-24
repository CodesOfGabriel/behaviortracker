import { describe, expect, it } from "vitest";
import { visualZoneOccupancy } from "./zone-occupancy";
import { metricEligible } from "./pose";
import type { ArenaConfig, PoseSample } from "../types";

const arena:ArenaConfig={revision:1,cornersPx:[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],widthCm:100,heightCm:100,centerAreaFraction:.25,boundaryPolicy:"center_inclusive"};
const row=(frameIndex:number,x:number):PoseSample=>({frameIndex,timestampSec:frameIndex*.1,keypoint:"box_center",xPx:x,yPx:50,likelihood:0,status:"low_confidence",source:"segmented",
  trackingAccepted:true,referenceApproved:false,metricReference:"box_center",spatialRegion:"floor",bbox:{x:x-5,y:45,width:10,height:10}});
describe("ocupação visual por execução",()=>{
  it("mostra observações locais não aprovadas sem modificar a elegibilidade científica",()=>{
    const samples=[row(0,50),row(1,50),row(2,10)];
    expect(visualZoneOccupancy(samples,arena,100,100)).toMatchObject({centerPct:100,observedPct:100});
    expect(samples.every(sample=>!metricEligible(sample))).toBe(true);
    expect(samples.every(sample=>sample.referenceApproved===false&&sample.status==="low_confidence")).toBe(true);
  });
  it("recalcula para outra execução sem misturar coordenadas nem percentuais",()=>{
    const center=[row(0,50),row(1,50)],periphery=[row(0,10),row(1,10)];
    expect(visualZoneOccupancy(center,arena,100,100).centerPct).toBe(100);
    expect(visualZoneOccupancy(periphery,arena,100,100).centerPct).toBe(0);
  });
  it("preserva perdas, previsões e saltos temporais como desconhecidos, sem mostrar zero falso",()=>{
    const samples=[row(0,50),{...row(1,50),source:"predicted" as const},row(3,50),{...row(4,50),timestampSec:1.2}];
    expect(visualZoneOccupancy(samples,arena,100,100).centerPct).toBeNull();
    expect(visualZoneOccupancy(samples,arena,100,100).unknownSec).toBeCloseTo(1.2);
    expect(visualZoneOccupancy([],arena,100,100).centerPct).toBeNull();
  });
});
