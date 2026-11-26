import {test,expect,openExperiment} from "./desktop";
import {sampleFixture} from "../fixtures/experiment";
import type {PoseSample} from "../../src/types";

test("Layered orientation stays identified and disappears after intervention",async({page})=>{
  const samples:PoseSample[]=sampleFixture().map(row=>{
    const stopped=row.frameIndex>=30;
    return {...row,...(stopped?{bbox:undefined,status:"missing" as const,xPx:null,yPx:null,trackingAccepted:false,reason:"researcher_intervention"}:{}),
      bodyAxis:{schemaVersion:"body-axis-2",frameIndex:row.frameIndex,timestampSec:row.timestampSec,
        points:stopped?[]:Array.from({length:7},(_,i)=>({x:row.xPx!-22+i*7,y:row.yPx!})),state:stopped?"missing":"reliable",
        reason:stopped?"researcher_intervention":"ok",rawAngleRad:0,angleRad:0,anisotropy:4,filtered:false,anatomicalPose:false},
      oftLayers:{version:"oft-layers-1",orientation:{state:stopped?"missing":"estimated",reason:"orientation_pending_review",
        head:stopped?null:{x:row.xPx!+22,y:row.yPx!},tailBase:stopped?null:{x:row.xPx!-22,y:row.yPx!},tailTip:null,
        confidence:.4,source:stopped?null:"temporal_estimate",metricEligible:false},
        rearing:{classification:"UNKNOWN",reviewStatus:"pending",metricEligible:false}}};
  });
  await openExperiment(page,"idle",samples);
  await page.getByRole("tab",{name:"Detalhes",exact:true}).click();
  const video=page.locator(".tracking-details-player video");
  await video.evaluate(v=>{(v as HTMLVideoElement).currentTime=.8;});
  const overlay=page.locator('.tracking-details-player g[data-axis-state="reliable"]');
  await expect(overlay).toHaveAttribute("data-frame-index","20");
  await expect(overlay.locator('[data-head-marker="triangle"]')).toHaveCount(1);
  await expect(overlay.locator('text')).toHaveCount(0);
  await expect(overlay.locator('[data-orientation-source="temporal_estimate"]')).toHaveCount(1);
  await video.evaluate(v=>{(v as HTMLVideoElement).currentTime=1.24;});
  await expect(page.locator(".tracking-details-player svg")).toHaveCount(0);
});

test("Details overlay follows presented frames between timeupdate events and after a paused seek",async({page})=>{
  await openExperiment(page);
  await page.getByRole("tab",{name:"Detalhes",exact:true}).click();
  const video=page.locator(".tracking-details-player video");
  await expect(video).toBeVisible();
  // Sample the rendered overlay on the next paint after each native frame callback.
  // A timeupdate-driven implementation leaves the previous box for several frames.
  const observations=await video.evaluate(async node=>{
    const v=node as HTMLVideoElement;
    v.playbackRate=.5;
    const rows:{pts:number;frame:number;boxX:number}[]=[];
    const done=new Promise<void>(resolve=>{
      const frame:VideoFrameRequestCallback=(_now,metadata)=>{
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
          const rect=document.querySelector(".tracking-details-player rect[data-frame-index]");
          if(rect)rows.push({pts:metadata.mediaTime,frame:Number(rect.getAttribute("data-frame-index")),boxX:Number(rect.getAttribute("x"))});
          if(rows.length>=12||v.ended){v.pause();resolve();}else v.requestVideoFrameCallback(frame);
        }));
      };
      v.requestVideoFrameCallback(frame);
    });
    await v.play();await done;return rows;
  });
  expect(observations.length).toBeGreaterThanOrEqual(12);
  for(const row of observations){
    expect(row.frame,`presented PTS ${row.pts}`).toBe(Math.floor((row.pts+1e-6)*25));
    expect(row.boxX).toBe(280+row.frame/2);
  }
  await video.evaluate(v=>{(v as HTMLVideoElement).currentTime=1.24;});
  await expect(page.locator("rect[data-frame-index]")).toHaveAttribute("data-frame-index","31");
  await expect.poll(()=>video.evaluate(v=>(v as HTMLVideoElement).paused)).toBe(true);
});

test("Body axis rejects a perpendicular spike consistently when seeking forward and backward",async({page})=>{
  const samples=sampleFixture().map(row=>{
    const vertical=row.frameIndex===20;
    const x=row.xPx!,y=row.yPx!;
    return {...row,contour:Array.from({length:40},(_,i)=>{
      const t=i*Math.PI*2/40,a=24*Math.cos(t),b=7*Math.sin(t);
      return {x:x+(vertical?-b:a),y:y+(vertical?a:b)};
    })};
  });
  await openExperiment(page,"idle",samples);
  await page.getByRole("tab",{name:"Detalhes",exact:true}).click();
  const video=page.locator(".tracking-details-player video");
  const overlay=page.locator(".tracking-details-player g[data-axis-state]");
  for(const frame of [19,20,21,20,19]){
    await video.evaluate((v,t)=>{(v as HTMLVideoElement).currentTime=t;},frame/25);
    await expect(page.locator("rect[data-frame-index]")).toHaveAttribute("data-frame-index",String(frame));
    await expect(overlay).toHaveAttribute("data-axis-state",frame===20?"outlier":"reliable");
    if(frame===20){
      await expect(overlay.locator("polyline")).toHaveCount(0);
      await expect(overlay).toHaveAttribute("aria-label","Orientação incerta");
      await expect(overlay.locator("text")).toHaveCount(0);
    }else{
      const points=await overlay.locator("polyline").getAttribute("points");
      const path=points!.split(" ").map(p=>p.split(",").map(Number));
      expect(Math.abs(path.at(-1)![0]-path[0][0])).toBeGreaterThan(20);
      expect(Math.abs(path.at(-1)![1]-path[0][1])).toBeLessThan(3);
    }
  }
});
