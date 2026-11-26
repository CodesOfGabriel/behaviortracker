import { describe, expect, it } from "vitest";
import { axisAngleDelta, bodyAxisAt, BodyAxisFilter, estimatedBodyAxis, measureBodyAxis } from "./body-axis";
import type { PoseSample } from "../types";

const ellipse = (rx: number, ry: number) => Array.from({length:40},(_,i)=>({
  x:50+rx*Math.cos(i/40*Math.PI*2),y:50+ry*Math.sin(i/40*Math.PI*2),
}));
describe("eixo corporal geométrico",()=>{
  it("desenha pontos conectados dentro de uma silhueta alongada",()=>{
    const path=estimatedBodyAxis(ellipse(35,8));
    expect(path).toHaveLength(7);
    for(const point of path)expect(((point.x-50)/35)**2+((point.y-50)/8)**2).toBeLessThanOrEqual(1);
    expect(Math.abs(path.at(-1)!.x-path[0].x)).toBeGreaterThan(40);
  });
  it("oculta orientação ambígua em vez de inventar direção ou herdar um eixo perpendicular",()=>{
    const horizontal=estimatedBodyAxis(ellipse(20,20));
    const vertical=estimatedBodyAxis(ellipse(20,20),{x:0,y:1});
    expect(horizontal).toEqual([]);
    expect(vertical).toEqual([]);
    expect(measureBodyAxis(ellipse(20,20)).reason).toBe("ambiguous_orientation");
  });
  it("não cria silhueta ausente ou inválida",()=>{
    expect(estimatedBodyAxis()).toEqual([]);
    expect(estimatedBodyAxis([{x:0,y:0},{x:NaN,y:20},{x:30,y:30}])).toEqual([]);
  });
  it("rejeita uma máscara com ramificação larga que poderia girar o eixo",()=>{
    const contour=[[10,10],[35,10],[35,40],[80,40],[80,65],[35,65],[35,90],[10,90]].map(([x,y])=>({x,y}));
    expect(["concave_body","fragmented_body"]).toContain(measureBodyAxis(contour).reason);
    expect(estimatedBodyAxis(contour)).toEqual([]);
  });
});

const row=(frame:number,angle=0):PoseSample=>{
  const contour=ellipse(35,10).map(p=>({x:50+(p.x-50)*Math.cos(angle)-(p.y-50)*Math.sin(angle),y:50+(p.x-50)*Math.sin(angle)+(p.y-50)*Math.cos(angle)}));
  return {frameIndex:frame,timestampSec:frame*.04,keypoint:"box_center",source:"segmented",status:"valid",xPx:50,yPx:50,likelihood:0,bbox:{x:10,y:10,width:80,height:80},contour};
};
describe("rejeição temporal de outliers do eixo",()=>{
  it("suprime um salto de 90 graus e volta à orientação observada no próximo frame",()=>{
    const filter=new BodyAxisFilter();
    for(let i=0;i<5;i++)expect(filter.update(row(i)).state).toBe("reliable");
    const spike=filter.update(row(5,Math.PI/2));
    expect(spike.state).toBe("outlier");expect(spike.points).toEqual([]);
    const recovered=filter.update(row(6));
    expect(recovered.state).toBe("reliable");expect(Math.abs(recovered.angleRad!)).toBeLessThan(.05);
  });
  it("confirma uma virada persistente sem manter a linha horizontal sobre um corpo vertical",()=>{
    const filter=new BodyAxisFilter();
    for(let i=0;i<5;i++)filter.update(row(i));
    expect(filter.update(row(5,Math.PI/2)).points).toEqual([]);
    expect(filter.update(row(6,Math.PI/2)).points).toEqual([]);
    const turned=filter.update(row(7,Math.PI/2));
    expect(turned.reason).toBe("change_confirmed");
    expect(Math.abs(axisAngleDelta(turned.angleRad!,Math.PI/2))).toBeLessThan(.05);
  });
  it("seeks e frames de apresentação pulados usam o mesmo contexto da fonte",()=>{
    const timeline=Array.from({length:14},(_,i)=>row(i,i===7?Math.PI/2:0));
    const filter=new BodyAxisFilter(),expected=timeline.map(s=>filter.update(s));
    for(const index of [12,7,8,5,13])expect(bodyAxisAt(timeline[index],timeline)).toEqual(expected[index]);
  });
  it("recompõe a suavização em vídeos de baixa frequência sem depender da ordem de navegação",()=>{
    const timeline=Array.from({length:80},(_,i)=>({...row(i,.4*Math.sin(i*.2)),timestampSec:i*.25}));
    const filter=new BodyAxisFilter(),expected=timeline.map(s=>filter.update(s));
    for(const i of [79,40,59]){
      const actual=bodyAxisAt(timeline[i],timeline)!;
      expect(actual.state).toBe(expected[i].state);
      expect(Math.abs(axisAngleDelta(actual.angleRad!,expected[i].angleRad!))).toBeLessThan(1e-9);
    }
  });
  it("mantém a observação bruta e não cria linha através de perda ou câmera deslocada",()=>{
    const filter=new BodyAxisFilter(),first=row(0);const before=JSON.stringify(first);filter.update(first);
    expect(JSON.stringify(first)).toBe(before);
    expect(filter.update({...row(1),reason:"camera_shift"}).points).toEqual([]);
    expect(filter.update({...row(2),source:"recovered"}).points).toEqual([]);
    expect(filter.update({...row(3),status:"missing"}).points).toEqual([]);
  });
  it("usa a máscara apoiada na imagem atual e não volta à máscara contaminada se faltar apoio",()=>{
    const sample={...row(0),bodyAxisContour:row(0,Math.PI/2).contour};
    const result=new BodyAxisFilter().update(sample);
    expect(result.state).toBe("reliable");
    expect(Math.abs(axisAngleDelta(result.angleRad!,Math.PI/2))).toBeLessThan(.05);
    expect(new BodyAxisFilter().update({...sample,bodyAxisContour:[]}).points).toEqual([]);
  });
});
