import { describe, expect, it } from "vitest";
import { estimatedBodyAxis } from "./body-axis";

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
  it("mantém a linha em corpo arredondado e usa uma direção visual anterior sem nomear anatomia",()=>{
    const horizontal=estimatedBodyAxis(ellipse(20,20));
    const vertical=estimatedBodyAxis(ellipse(20,20),{x:0,y:1});
    expect(horizontal).toHaveLength(7);
    expect(vertical).toHaveLength(7);
    expect(Math.abs(horizontal.at(-1)!.x-horizontal[0].x)).toBeGreaterThan(20);
    expect(Math.abs(vertical.at(-1)!.y-vertical[0].y)).toBeGreaterThan(20);
    for(const point of vertical)expect(((point.x-50)/20)**2+((point.y-50)/20)**2).toBeLessThanOrEqual(1);
  });
  it("não cria silhueta ausente ou inválida",()=>{
    expect(estimatedBodyAxis()).toEqual([]);
    expect(estimatedBodyAxis([{x:0,y:0},{x:NaN,y:20},{x:30,y:30}])).toEqual([]);
  });
});
