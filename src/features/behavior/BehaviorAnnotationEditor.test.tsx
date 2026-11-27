// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BehaviorAnnotationEditor } from "./BehaviorAnnotationEditor";
import { appendAnnotation, annotationContext, cachedAnnotationContext, exportBehaviorAnnotations, exportBehaviorDataset, listAnnotations, revealBehaviorExport, reviewBehaviorProposal } from "./api";
import { loadLocalResult } from "../local/api";
import type { BehaviorAnnotation } from "../../lib/behavior/types";
vi.mock("./api",()=>({cachedAnnotationContext:vi.fn(),cachedAnnotations:vi.fn(),annotationContext:vi.fn(),listAnnotations:vi.fn(),appendAnnotation:vi.fn(),exportBehaviorDataset:vi.fn(),exportBehaviorAnnotations:vi.fn(),revealBehaviorExport:vi.fn(),reviewBehaviorProposal:vi.fn()}));
vi.mock("../local/api",()=>({cachedLocalResult:vi.fn(),loadLocalResult:vi.fn()}));
vi.mock("../../lib/useVideoFrameTime",()=>({useVideoFrameTime:()=>({time:.2,readPresentedTime:()=>.2})}));
const props={experimentId:"experiment",trackingJobId:"tracking",videoSha256:"a".repeat(64),videoId:"video",width:640,height:480,animalId:"animal",active:true};
const peak:BehaviorAnnotation={schemaVersion:1,id:"original",type:"PEAK",source:"human",experimentId:"experiment",trackingJobId:"tracking",videoSha256:"a".repeat(64),createdAt:"2026-01-01",timestampSec:.2,frameIndex:1,label:"REARING_SUPPORTED",annotatorId:"original-observer"};
beforeEach(()=>{
  vi.resetAllMocks();sessionStorage.clear();
  // jsdom lacks native dialog methods; real modal/focus behavior is covered in Playwright.
  HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  HTMLDialogElement.prototype.close=function(){this.open=false;};
  vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});
  vi.mocked(annotationContext).mockResolvedValue({videoPath:"fixture.mp4",videoUrl:"fixture.mp4",frameTimes:[0,.2,.4],durationSec:.6});
  vi.mocked(listAnnotations).mockResolvedValue([]);
  vi.mocked(loadLocalResult).mockResolvedValue([]);
  vi.mocked(appendAnnotation).mockResolvedValue(undefined);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

it("quick confirmation requires the current annotator and updates the timeline only after native success",async()=>{
  let finish!:(entries:BehaviorAnnotation[])=>void;
  vi.mocked(reviewBehaviorProposal).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const user=userEvent.setup();
  render(<BehaviorAnnotationEditor {...props} renderDetection={({onReview,reviews,disabled})=><>
    <button disabled={disabled} onClick={()=>void onReview({frameIndex:1,timestampSec:.2,decision:"accept",label:"REARING_UNSPECIFIED"})}>Confirmar sugestão</button>
    <span>{reviews[1]?.decision??"pending"}</span>
  </>}/>);
  await user.click(await screen.findByRole("tab",{name:"Detecção automática"}));
  await user.click(screen.getByRole("button",{name:"Confirmar sugestão"}));
  expect(screen.getByRole("alert").textContent).toContain("Informe seu identificador");
  expect(reviewBehaviorProposal).not.toHaveBeenCalled();
  await user.type(screen.getByRole("textbox",{name:"Anotador"}),"reviewer");
  await user.click(screen.getByRole("button",{name:"Confirmar sugestão"}));
  expect(reviewBehaviorProposal).toHaveBeenCalledWith(props.experimentId,props.trackingJobId,props.videoSha256,{frameIndex:1,timestampSec:.2,decision:"accept",label:"REARING_UNSPECIFIED",annotatorId:"reviewer"});
  expect(screen.getByText("pending")).toBeTruthy();
  expect((screen.getByRole("button",{name:"Confirmar sugestão"}) as HTMLButtonElement).disabled).toBe(true);
  finish([{...peak,id:"confirmed",annotatorId:"reviewer",label:"REARING_UNSPECIFIED"}]);
  expect(await screen.findByText("accept")).toBeTruthy();
  expect(screen.getByRole("button",{name:/^Ápice em/})).toBeTruthy();
  expect(screen.getByRole("button",{name:/2. Completar episódios/}).getAttribute("aria-label")).toContain("1 pendente");
});

it("quick review preserves drafts and a failed save leaves the proposal pending for retry",async()=>{
  vi.mocked(reviewBehaviorProposal).mockRejectedValue(new Error("Disco indisponível"));
  const user=userEvent.setup();
  render(<BehaviorAnnotationEditor {...props} renderDetection={({onReview,reviews})=><>
    <button onClick={()=>void onReview({frameIndex:2,timestampSec:.4,decision:"reject"})}>Rejeitar sugestão</button>
    <span>{reviews[2]?.decision??"pending"}</span>
  </>}/>);
  await user.type(await screen.findByRole("textbox",{name:"Anotador"}),"reviewer");
  await user.click(screen.getByRole("button",{name:"Marcar ápice agora (R)"}));
  await user.click(screen.getByRole("tab",{name:"Detecção automática"}));
  await user.click(screen.getByRole("button",{name:"Rejeitar sugestão"}));
  expect(screen.getByRole("alert").textContent).toContain("Salve ou descarte");
  expect(reviewBehaviorProposal).not.toHaveBeenCalled();
  await user.click(screen.getByRole("tab",{name:/^Anotação$/}));
  await user.click(screen.getByRole("button",{name:"Descartar marcação"}));
  await user.click(screen.getByRole("tab",{name:"Detecção automática"}));
  await user.click(screen.getByRole("button",{name:"Rejeitar sugestão"}));
  expect((await screen.findByRole("alert")).textContent).toContain("Disco indisponível");
  expect(screen.getByText("pending")).toBeTruthy();
  vi.mocked(reviewBehaviorProposal).mockResolvedValue([{...peak,id:"review",type:"PROPOSAL_REVIEW",frameIndex:2,timestampSec:.4,decision:"reject",label:undefined}]);
  await user.click(screen.getByRole("button",{name:"Rejeitar sugestão"}));
  expect(await screen.findByText("reject")).toBeTruthy();
  expect(screen.queryByRole("button",{name:/^Ápice em/})).toBeNull();
});

it("preserves unsaved edits to an existing human peak when an automatic proposal is selected",async()=>{
  vi.mocked(listAnnotations).mockResolvedValue([peak]);
  const user=userEvent.setup();
  render(<BehaviorAnnotationEditor {...props} renderDetection={({onSeek})=><button onClick={()=>onSeek(.4)}>Ver proposta automática</button>}/>);
  await user.click(await screen.findByRole("button",{name:/^Ápice em/}));
  await user.click(screen.getByRole("radio",{name:"Rearing sem apoio"}));
  await user.click(screen.getByRole("tab",{name:"Detecção automática"}));
  await user.click(screen.getByRole("button",{name:"Ver proposta automática"}));
  expect(screen.getByRole("alert").textContent).toContain("Salve ou descarte a anotação em edição");
  expect(document.querySelector("video")?.currentTime).toBe(.2);
  await user.click(screen.getByRole("tab",{name:/^Anotação$/}));
  expect((screen.getByRole("radio",{name:"Rearing sem apoio"}) as HTMLInputElement).checked).toBe(true);
  expect(appendAnnotation).not.toHaveBeenCalled();
});

it("waits for human history when only part of the startup snapshot is cached",async()=>{
  vi.mocked(cachedAnnotationContext).mockReturnValue({videoPath:"fixture.mp4",videoUrl:"fixture.mp4",frameTimes:[0,.2,.4],durationSec:.6});
  let finish!:(events:BehaviorAnnotation[])=>void;
  vi.mocked(listAnnotations).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  render(<BehaviorAnnotationEditor {...props}/>);
  expect(screen.queryByRole("textbox",{name:"Anotador"})).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Carregando");
  finish([peak]);
  expect(await screen.findByRole("button",{name:/^Ápice em/})).toBeTruthy();
  expect(screen.getByRole("textbox",{name:"Anotador"})).toBeTruthy();
});

it("exports an apex-only session to a native file and can reveal it",async()=>{
  vi.mocked(listAnnotations).mockResolvedValue([peak]);
  vi.mocked(exportBehaviorAnnotations).mockResolvedValue({path:"/results/peaks.csv"});
  vi.mocked(revealBehaviorExport).mockResolvedValue(undefined);
  const user=userEvent.setup();render(<BehaviorAnnotationEditor {...props}/>);
  const button=await screen.findByRole("button",{name:"Exportar ápices CSV"});
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
  await user.click(await screen.findByRole("button",{name:"Exportar ápices CSV"}));
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

it("guides existing peaks into human intervals and advances without altering original peaks",async()=>{
 const later:BehaviorAnnotation={...peak,id:"later",timestampSec:.4,frameIndex:2};
 vi.mocked(listAnnotations).mockResolvedValue([peak,later]);
 const user=userEvent.setup();render(<BehaviorAnnotationEditor {...props}/>);
 await user.type(await screen.findByRole("textbox",{name:"Anotador"}),"episode-reviewer");
 await user.click(screen.getByRole("button",{name:/2. Completar episódios/}));
 await user.type(screen.getByRole("spinbutton",{name:"Início (s)"}),"0");
 await user.type(screen.getByRole("spinbutton",{name:"Fim (s)"}),"0.3");
 await user.click(screen.getByRole("button",{name:"Salvar episódio e próximo"}));
 await waitFor(()=>expect(appendAnnotation).toHaveBeenCalledWith(expect.objectContaining({type:"INTERVAL",peakId:"original",startSec:0,endSec:.3,annotatorId:"episode-reviewer"})));
 expect(screen.getByText("Completar episódio · ápice 0.400 s")).toBeTruthy();
 expect(screen.getByRole("button",{name:/2. Completar episódios/}).getAttribute("aria-label")).toContain("1 pendente");
 expect(peak.annotatorId).toBe("original-observer");
});

it("rejects an interval that excludes its selected apex and preserves the draft after save failure",async()=>{
 vi.mocked(listAnnotations).mockResolvedValue([peak]);
 const user=userEvent.setup();render(<BehaviorAnnotationEditor {...props}/>);
 await user.type(await screen.findByRole("textbox",{name:"Anotador"}),"reviewer");
 await user.click(screen.getByRole("button",{name:/2. Completar episódios/}));
 await user.type(screen.getByRole("spinbutton",{name:"Início (s)"}),"0.3");
 await user.type(screen.getByRole("spinbutton",{name:"Fim (s)"}),"0.5");
 await user.click(screen.getByRole("button",{name:"Salvar episódio e próximo"}));
 expect(screen.getByRole("alert").textContent).toContain("deve conter o ápice");expect(appendAnnotation).not.toHaveBeenCalled();
 await user.clear(screen.getByRole("spinbutton",{name:"Início (s)"}));await user.type(screen.getByRole("spinbutton",{name:"Início (s)"}),"0");
 vi.mocked(appendAnnotation).mockRejectedValueOnce(new Error("Disco indisponível"));
 await user.click(screen.getByRole("button",{name:"Salvar episódio e próximo"}));
 await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("Disco indisponível"));
 expect((screen.getByRole("spinbutton",{name:"Fim (s)"}) as HTMLInputElement).value).toBe("0.5");
});


it("opens explicit negative examples without labeling the rest of the video",async()=>{
 const user=userEvent.setup();render(<BehaviorAnnotationEditor {...props}/>);
 await user.type(await screen.findByRole("textbox",{name:"Anotador"}),"reviewer");
 await user.click(screen.getByRole("button",{name:"3. Exemplos e incertezas"}));
 expect((screen.getByRole("radio",{name:"Não rearing"}) as HTMLInputElement).checked).toBe(true);
 await user.type(screen.getByRole("spinbutton",{name:"Início (s)"}),"0.1");
 await user.type(screen.getByRole("spinbutton",{name:"Fim (s)"}),"0.4");
 await user.click(screen.getByRole("button",{name:"Salvar intervalo"}));
 await waitFor(()=>expect(appendAnnotation).toHaveBeenCalledTimes(1));
 expect(appendAnnotation).toHaveBeenCalledWith(expect.objectContaining({type:"INTERVAL",label:"NON_REARING",exampleKind:"walking",startSec:.1,endSec:.4}));
});

it("training export opens the complete package and requires arena metadata before creating it",async()=>{
 vi.mocked(listAnnotations).mockResolvedValue([peak]);
 vi.mocked(exportBehaviorDataset).mockResolvedValue({path:"/results/training.zip",url:"asset://training.zip"});
 HTMLElement.prototype.scrollIntoView=vi.fn();
 const user=userEvent.setup();render(<BehaviorAnnotationEditor {...props}/>);
 await user.click(await screen.findByRole("button",{name:"Exportar para treinamento"}));
 expect((screen.getByRole("button",{name:"Preparar ZIP"}) as HTMLButtonElement).disabled).toBe(true);
 expect(exportBehaviorDataset).not.toHaveBeenCalled();
 await user.type(screen.getByRole("textbox",{name:"Arena"}),"arena-01");
 await user.click(screen.getByRole("button",{name:"Preparar ZIP"}));
 await waitFor(()=>expect(exportBehaviorDataset).toHaveBeenCalledWith(props.experimentId,props.trackingJobId,props.videoSha256,{animalId:"animal",sessionId:"experiment",arenaId:"arena-01",condition:"unspecified"},false));
});
