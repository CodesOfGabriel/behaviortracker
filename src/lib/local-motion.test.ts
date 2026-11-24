import { describe, expect, it } from "vitest";
import { boxMotionSeries, pointImageMotionSeries } from "./local-motion";
import type { PoseSample } from "../types";

const sample = (frameIndex: number, timestampSec: number, x: number): PoseSample => ({
  frameIndex, timestampSec, keypoint: "box_center", xPx: null, yPx: null, status: "low_confidence", likelihood: 0,
  source: "segmented", trackingAccepted: true, spatialRegion: "wall_projection", bbox: { x, y: 20, width: 10, height: 10 },
});
describe("velocidade visual do centro da caixa", () => {
  it("usa PTS e conserva zero observado mesmo com restrição geométrica", () => {
    const values = boxMotionSeries([sample(0,0,10), sample(1,.1,20), sample(2,.3,20)],100,80);
    expect(values.map(v=>v.speedPxSec)).toEqual([null,100,0]);
  });
  it("não interpola perda, previsão, rejeição ou salto temporal", () => {
    const rows = [sample(0,0,10), sample(1,.1,20), sample(2,.2,30), sample(3,.3,40), sample(5,.4,50), sample(6,1,60), sample(7,1.1,70)];
    rows[1].source="predicted"; rows[2].trackingAccepted=false;
    const values = boxMotionSeries(rows,100,80);
    expect(values.slice(0,6).every(v=>v.speedPxSec==null)).toBe(true);
    expect(values[6].speedPxSec).toBeCloseTo(100);
  });
});


describe("locomoção de centros observados sem caixa",()=>{
  const point=(frameIndex:number,timestampSec:number,xPx:number|null):PoseSample=>({frameIndex,timestampSec,xPx,yPx:xPx==null?null:10,keypoint:"mouse_center",likelihood:.9,status:xPx==null?"missing":"valid",source:"detected"});
  it("usa as coordenadas observadas e o PTS, sem fabricar caixas",()=>{
    const rows=[point(0,0,10),point(1,.1,20),point(2,.2,20)];
    expect(pointImageMotionSeries(rows).map(row=>row.speedPxSec)).toEqual([null,100,0]);
    expect(rows.every(row=>row.bbox===undefined)).toBe(true);
  });
  it("mantém lacunas por perda, previsão, rejeição e descontinuidade temporal",()=>{
    const rows=[point(0,0,10),point(1,.1,null),{...point(2,.2,20),source:"predicted" as const},point(3,.3,30),point(5,.4,40),point(6,1,50),{...point(7,1.1,60),trackingAccepted:false}];
    expect(pointImageMotionSeries(rows).every(row=>row.speedPxSec===null)).toBe(true);
  });
});
