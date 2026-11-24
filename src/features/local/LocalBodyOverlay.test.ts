import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalBodyOverlay } from "./LocalBodyOverlay";
import type { PoseSample } from "../../types";

const sample:PoseSample={frameIndex:0,timestampSec:0,keypoint:"box_center",xPx:50,yPx:50,likelihood:0,status:"low_confidence",source:"segmented",trackingAccepted:false,
  bbox:{x:10,y:30,width:80,height:40},contour:[{x:10,y:30},{x:90,y:30},{x:90,y:70},{x:10,y:70}]};
describe("linha corporal visual",()=>{
  it("conserva uma silhueta incerta em âmbar sem exigir aceitação para métricas",()=>{
    const markup=renderToStaticMarkup(createElement("svg",null,createElement(LocalBodyOverlay,{sample,width:100,height:100})));
    expect(markup).toContain("polyline");expect(markup).toContain("Silhueta incerta");expect(markup).toContain("stroke-dasharray");
  });
  it("não transforma caixa prevista ou sem máscara em skeleton",()=>{
    for(const row of [{...sample,source:"predicted" as const},{...sample,contour:undefined}]){
      expect(renderToStaticMarkup(createElement("svg",null,createElement(LocalBodyOverlay,{sample:row,width:100,height:100})))).not.toContain("polyline");
    }
  });
});
