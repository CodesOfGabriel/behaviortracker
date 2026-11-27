// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useVideoFrameTime } from "./useVideoFrameTime";
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function Probe({source="video-a"}:{source?:string}){
  const ref=useRef<HTMLVideoElement>(null);
  const {time,readPresentedTime}=useVideoFrameTime(ref,source);
  return <><video ref={ref}/><output>{time??"pending"}</output><button onClick={()=>{document.title=String(readPresentedTime());}}>Read</button></>;
}
it("uses presented frames even between timeupdate events, rejects seek capture and cancels old sources",()=>{
  const callbacks=new Map<number,VideoFrameRequestCallback>();let next=0;
  Object.defineProperty(HTMLVideoElement.prototype,"requestVideoFrameCallback",{configurable:true,value:(cb:VideoFrameRequestCallback)=>{callbacks.set(++next,cb);return next;}});
  const cancel=vi.fn((id:number)=>{callbacks.delete(id);});
  Object.defineProperty(HTMLVideoElement.prototype,"cancelVideoFrameCallback",{configurable:true,value:cancel});
  const fire=(time:number)=>act(()=>{const [id,cb]=[...callbacks][0];callbacks.delete(id);cb(0,{mediaTime:time} as VideoFrameCallbackMetadata);});
  const view=render(<Probe/>);const video=view.container.querySelector("video")!;
  video.currentTime=.3;fire(.12);
  expect(screen.getByRole("status").textContent).toBe("0.12");
  act(()=>{video.dispatchEvent(new Event("timeupdate"));});
  expect(screen.getByRole("status").textContent).toBe("0.12");
  fire(.16);expect(screen.getByRole("status").textContent).toBe("0.16");
  const queuedBeforeSeek=[...callbacks.values()][0];
  Object.defineProperty(video,"seeking",{configurable:true,value:true});
  act(()=>{video.dispatchEvent(new Event("seeking"));screen.getByRole("button").click();});
  expect(document.title).toBe("null");
  // Cancellation cannot retract a callback that was already queued by the browser.
  video.currentTime=.44;act(()=>queuedBeforeSeek(0,{mediaTime:.44} as VideoFrameCallbackMetadata));
  expect(screen.getByRole("status").textContent).toBe("pending");
  Object.defineProperty(video,"seeking",{configurable:true,value:false});
  Object.defineProperty(video,"readyState",{configurable:true,value:2});
  act(()=>video.dispatchEvent(new Event("seeked")));
  act(()=>{screen.getByRole("button").click();});expect(document.title).toBe("0.44");
  const stale=[...callbacks.values()][0];view.rerender(<Probe source="video-b"/>);
  expect(cancel).toHaveBeenCalled();act(()=>stale(0,{mediaTime:1} as VideoFrameCallbackMetadata));
  expect(screen.getByRole("status").textContent).toBe("pending");
  view.unmount();expect(callbacks.size).toBe(0);
});

it("uses animation frames as a fallback and withholds boxes during seeks",()=>{
  Object.defineProperty(HTMLVideoElement.prototype,"requestVideoFrameCallback",{configurable:true,value:undefined});
  const callbacks=new Map<number,FrameRequestCallback>();let next=0;
  vi.stubGlobal("requestAnimationFrame",(cb:FrameRequestCallback)=>{callbacks.set(++next,cb);return next;});
  vi.stubGlobal("cancelAnimationFrame",(id:number)=>callbacks.delete(id));
  const view=render(<Probe/>),video=view.container.querySelector("video")!;
  Object.defineProperty(video,"readyState",{configurable:true,value:2});video.currentTime=.12;
  const paint=()=>act(()=>{const [id,cb]=[...callbacks][0];callbacks.delete(id);cb(0);});
  paint();expect(screen.getByRole("status").textContent).toBe("0.12");
  Object.defineProperty(video,"seeking",{configurable:true,value:true});
  act(()=>video.dispatchEvent(new Event("seeking")));video.currentTime=1;paint();
  expect(screen.getByRole("status").textContent).toBe("pending");
  Object.defineProperty(video,"seeking",{configurable:true,value:false});
  act(()=>video.dispatchEvent(new Event("seeked")));expect(screen.getByRole("status").textContent).toBe("1");
  view.unmount();expect(callbacks.size).toBe(0);vi.unstubAllGlobals();
});


it("bootstraps decoded paused frame zero when WebKit has not emitted a presentation callback",()=>{
  Object.defineProperty(HTMLVideoElement.prototype,"requestVideoFrameCallback",{configurable:true,value:vi.fn(()=>1)});
  Object.defineProperty(HTMLVideoElement.prototype,"cancelVideoFrameCallback",{configurable:true,value:vi.fn()});
  const view=render(<Probe/>),video=view.container.querySelector("video")!;
  Object.defineProperty(video,"readyState",{configurable:true,value:2});
  act(()=>video.dispatchEvent(new Event("loadeddata")));
  expect(screen.getByRole("status").textContent).toBe("0");
  video.currentTime=.3;act(()=>video.dispatchEvent(new Event("timeupdate")));
  expect(screen.getByRole("status").textContent).toBe("0");
});

it("resolves paused same-frame seeks even when the decoder emits no new presentation callback",()=>{
  Object.defineProperty(HTMLVideoElement.prototype,"requestVideoFrameCallback",{configurable:true,value:vi.fn(()=>1)});
  Object.defineProperty(HTMLVideoElement.prototype,"cancelVideoFrameCallback",{configurable:true,value:vi.fn()});
  const view=render(<Probe/>),video=view.container.querySelector("video")!;
  Object.defineProperty(video,"readyState",{configurable:true,value:2});
  video.currentTime=.36;
  act(()=>video.dispatchEvent(new Event("seeking")));
  expect(screen.getByRole("status").textContent).toBe("pending");
  act(()=>video.dispatchEvent(new Event("seeked")));
  expect(screen.getByRole("status").textContent).toBe("0.36");
  // The same decoded frame can be sought repeatedly without a new callback.
  act(()=>{video.dispatchEvent(new Event("seeking"));video.dispatchEvent(new Event("seeked"));});
  expect(screen.getByRole("status").textContent).toBe("0.36");
  video.currentTime=.4;act(()=>video.dispatchEvent(new Event("timeupdate")));
  expect(screen.getByRole("status").textContent).toBe("0.36");
});

it("does not let a delayed pre-seek callback replace the decoded paused frame",()=>{
  const callbacks=new Map<number,VideoFrameRequestCallback>();let next=0;
  Object.defineProperty(HTMLVideoElement.prototype,"requestVideoFrameCallback",{configurable:true,value:(cb:VideoFrameRequestCallback)=>{callbacks.set(++next,cb);return next;}});
  Object.defineProperty(HTMLVideoElement.prototype,"cancelVideoFrameCallback",{configurable:true,value:(id:number)=>callbacks.delete(id)});
  const view=render(<Probe/>),video=view.container.querySelector("video")!;
  Object.defineProperty(video,"readyState",{configurable:true,value:2});
  act(()=>video.dispatchEvent(new Event("loadeddata")));
  const delayed=[...callbacks.values()][0];
  video.currentTime=1.08;
  act(()=>video.dispatchEvent(new Event("seeking")));
  act(()=>video.dispatchEvent(new Event("seeked")));
  expect(screen.getByRole("status").textContent).toBe("1.08");
  act(()=>delayed(0,{mediaTime:0} as VideoFrameCallbackMetadata));
  act(()=>screen.getByRole("button").click());
  expect(document.title).toBe("1.08");
  expect(screen.getByRole("status").textContent).toBe("1.08");
});

it("keeps a paused decoded seek stable until playback resumes",()=>{
  const callbacks=new Map<number,VideoFrameRequestCallback>();let next=0;
  Object.defineProperty(HTMLVideoElement.prototype,"requestVideoFrameCallback",{configurable:true,value:(cb:VideoFrameRequestCallback)=>{callbacks.set(++next,cb);return next;}});
  Object.defineProperty(HTMLVideoElement.prototype,"cancelVideoFrameCallback",{configurable:true,value:(id:number)=>callbacks.delete(id)});
  const view=render(<Probe/>),video=view.container.querySelector("video")!;
  Object.defineProperty(video,"readyState",{configurable:true,value:2});
  const fire=(time:number)=>act(()=>{const [id,cb]=[...callbacks][0];callbacks.delete(id);cb(0,{mediaTime:time} as VideoFrameCallbackMetadata);});
  video.currentTime=1.08;
  act(()=>video.dispatchEvent(new Event("seeking")));
  act(()=>video.dispatchEvent(new Event("seeked")));
  fire(0);
  expect(screen.getByRole("status").textContent).toBe("1.08");
  Object.defineProperty(video,"paused",{configurable:true,value:false});
  act(()=>video.dispatchEvent(new Event("playing")));
  video.currentTime=1.3;fire(1.12);
  // During playback the presented frame, rather than currentTime, is authoritative.
  expect(screen.getByRole("status").textContent).toBe("1.12");
});
