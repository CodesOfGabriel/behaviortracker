import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { LocalMotionOverlay } from "./LocalMotionOverlay";
import type { PoseSample } from "../../types";

const sample = (frameIndex: number, x: number): PoseSample => ({ frameIndex, timestampSec:frameIndex*.1,
  keypoint:"box_center",xPx:null,yPx:null,status:"valid",likelihood:0,source:"segmented",
  bbox:{x,y:10,width:10,height:10} });
describe("painel de locomoção no vídeo",()=>{
  it("exibe somente o passado e mantém séries separadas por cilindro",()=>{
    const tracks = new Map([
      ["one",[sample(0,10),sample(1,20),sample(2,900)]],
      ["two",[sample(0,200),sample(1,220),sample(2,900)]],
    ]);
    const markup=renderToStaticMarkup(createElement("svg", null, createElement(LocalMotionOverlay, {tracks, width:1000, height:500, time:.1})));
    expect(markup).toContain("C1: 100");
    expect(markup).toContain("C2: 200");
    expect(markup).not.toContain("8800");
    expect(markup).toContain("canto superior direito");
    expect(markup).toContain("px/s");
  });
});
