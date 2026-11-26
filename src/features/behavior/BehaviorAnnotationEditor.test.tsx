// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BehaviorAnnotationEditor } from "./BehaviorAnnotationEditor";
import { appendAnnotation, annotationContext, exportBehaviorAnnotations, listAnnotations, revealBehaviorExport } from "./api";
import { loadLocalResult } from "../local/api";
import type { BehaviorAnnotation } from "../../lib/behavior/types";
vi.mock("./api",()=>({annotationContext:vi.fn(),listAnnotations:vi.fn(),appendAnnotation:vi.fn(),exportBehaviorDataset:vi.fn(),exportBehaviorAnnotations:vi.fn(),revealBehaviorExport:vi.fn()}));
vi.mock("../local/api",()=>({loadLocalResult:vi.fn()}));
vi.mock("../../lib/useVideoFrameTime",()=>({useVideoFrameTime:()=>({time:.2,readPresentedTime:()=>.2})}));
const props={experimentId:"experiment",trackingJobId:"tracking",videoSha256:"a".repeat(64),videoId:"video",width:640,height:480,animalId:"animal",active:true};
const peak:BehaviorAnnotation={schemaVersion:1,id:"original",type:"PEAK",source:"human",experimentId:"experiment",trackingJobId:"tracking",videoSha256:"a".repeat(64),createdAt:"2026-01-01",timestampSec:.2,frameIndex:1,label:"REARING_SUPPORTED",annotatorId:"original-observer"};
beforeEach(()=>{
  vi.resetAllMocks();sessionStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});
  vi.mocked(annotationContext).mockResolvedValue({videoPath:"fixture.mp4",videoUrl:"fixture.mp4",frameTimes:[0,.2,.4],durationSec:.6});
  vi.mocked(listAnnotations).mockResolvedValue([]);
  vi.mocked(loadLocalResult).mockResolvedValue([]);
  vi.mocked(appendAnnotation).mockResolvedValue(undefined);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

it("exports an apex-only session to a native file and can reveal it",async()=>{
  vi.mocked(listAnnotations).mockResolvedValue([peak]);
  vi.mocked(exportBehaviorAnnotations).mockResolvedValue({path:"/results/peaks.csv"});
  vi.mocked(revealBehaviorExport).mockResolvedValue(undefined);
  const user=userEvent.setup();render(<BehaviorAnnotationEditor {...props}/>);
  const button=await screen.findByRole("button",{name:"Exportar para treinamento"});
  expect((button as HTMLButtonElement).disabled).toBe(false);
  await user.click(button);
  await waitFor(()=>expect(exportBehaviorAnnotations).toHaveBeenCalledWith(props.experimentId,props.trackingJobId,props.videoSha256,"peaks"));
  await user.click(await screen.findByRole("button",{name:"Mostrar arquivo"}));
  expect(revealBehaviorExport).toHaveBeenCalledWith("/results/peaks.csv");
});

it("reports a native export failure without claiming a saved file",async()=>{
  vi.mocked(listAnnotations).mockResolvedValue([peak]);
  vi.mocked(exportBehaviorAnnotations).mockRejectedValue(new Error("Exportação indisponível"));
  const user=userEvent.setup();render(<BehaviorAnnotationEditor {...props}/>);
  await user.click(await screen.findByRole("button",{name:"Exportar para treinamento"}));
  expect((await screen.findByRole("alert")).textContent).toContain("Exportação indisponível");
  expect(screen.queryByRole("button",{name:"Mostrar arquivo"})).toBeNull();
});

it("keeps the entered annotator after the editor unmounts and saves the next peak",async()=>{
  const user=userEvent.setup();const first=render(<BehaviorAnnotationEditor {...props}/>);
  await user.type(await screen.findByRole("textbox",{name:"Anotador"}),"current-observer");
  first.unmount();render(<BehaviorAnnotationEditor {...props}/>);
  const annotator=await screen.findByRole("textbox",{name:"Anotador"});
  expect((annotator as HTMLInputElement).value).toBe("current-observer");
  await user.click(screen.getByRole("button",{name:"Marcar ápice agora (R)"}));
  await user.click(screen.getByRole("button",{name:"Salvar marcação"}));
  await waitFor(()=>expect(appendAnnotation).toHaveBeenCalledWith(expect.objectContaining({type:"PEAK",annotatorId:"current-observer"})));
});

it("credits an edit to the current annotator while preserving the original author's record",async()=>{
  vi.mocked(listAnnotations).mockResolvedValue([peak]);
  const user=userEvent.setup();render(<BehaviorAnnotationEditor {...props}/>);
  await user.type(await screen.findByRole("textbox",{name:"Anotador"}),"reviewing-observer");
  await user.click(screen.getByRole("button",{name:/^Ápice em/}));
  expect((screen.getByRole("textbox",{name:"Anotador"}) as HTMLInputElement).value).toBe("reviewing-observer");
  await user.click(screen.getByRole("radio",{name:"Rearing sem apoio"}));
  await user.click(screen.getByRole("button",{name:"Salvar marcação"}));
  await waitFor(()=>expect(appendAnnotation).toHaveBeenCalledWith(expect.objectContaining({type:"LABEL_PEAK",targetId:"original",annotatorId:"reviewing-observer"})));
  expect(peak.annotatorId).toBe("original-observer");
});

it("requires an identifier if the operator deliberately clears it",async()=>{
  const user=userEvent.setup();render(<BehaviorAnnotationEditor {...props}/>);
  const input=await screen.findByRole("textbox",{name:"Anotador"});
  await user.type(input,"observer");await user.clear(input);
  await user.click(screen.getByRole("button",{name:"Marcar ápice agora (R)"}));
  await user.click(screen.getByRole("button",{name:"Salvar marcação"}));
  expect(screen.getByRole("alert").textContent).toContain("Informe seu identificador de anotador");
  expect(appendAnnotation).not.toHaveBeenCalled();
  await user.type(input,"corrected-observer");
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button",{name:"Salvar marcação"}));
  await waitFor(()=>expect(appendAnnotation).toHaveBeenCalledWith(expect.objectContaining({annotatorId:"corrected-observer"})));
});
