import { describe,it,expect } from "vitest";
import { annotationErrors,emptyKeypoints,sampleInterval } from "./schema";
const valid=()=>({width:100,height:100,bbox:{x:10,y:10,width:80,height:80},keypoints:Object.fromEntries(Object.keys(emptyKeypoints()).map((name)=>[name,name==="nose"?{state:"visible",x:20,y:20}:{state:"occluded",x:null,y:null}])) as ReturnType<typeof emptyKeypoints>});
describe("rótulos humanos para treinamento",()=>{
  it("aceita partes ocultas sem inventar coordenadas",()=>{expect(annotationErrors(valid())).toEqual([]);});
  it("não promove rascunhos incompletos",()=>{expect(annotationErrors({...valid(),keypoints:emptyKeypoints()})).toContain("Marque pelo menos uma parte realmente visível.");});
  it("rejeita coordenadas inventadas para partes não visíveis",()=>{const frame=valid();frame.keypoints.hip={state:"occluded",x:30,y:30};expect(annotationErrors(frame).some((e)=>e.includes("inventadas"))).toBe(true);});
  it("exige caixa e pontos dentro da imagem e da caixa",()=>{const frame=valid();frame.keypoints.nose.x=99;expect(annotationErrors(frame).length).toBeGreaterThan(0);expect(annotationErrors({...valid(),bbox:null}).length).toBeGreaterThan(0);});
  it("não replica um único rótulo para um intervalo",()=>{expect(sampleInterval(1,6,2,10)).toEqual([1,3,5]);});
  it("limita intervalos e quantidades antes de extrair imagens",()=>{expect(()=>sampleInterval(0,10,0,10)).toThrow();expect(()=>sampleInterval(5,2,1,10)).toThrow();expect(()=>sampleInterval(0,11,1,10)).toThrow();expect(()=>sampleInterval(0,100,.25,100)).toThrow();});
});
