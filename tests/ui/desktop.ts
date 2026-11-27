import { readFileSync } from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";
import { experimentFixture, jobFixture, sampleFixture } from "../fixtures/experiment";

type Scenario = "many-proposals" | "proposal-review-error" | "saved-proposals" | "detection-error" | "empty" | "idle" | "running" | "start-error" | "stage-error" | "model-slow" | "model-error" | "cancel-error" | "annotation-error" | "startup-slow" | "context-error" | "fresh-login" | "tracking-slow" | "jobs-slow";
type Call = { command: string; args: Record<string, unknown> };
declare global {
  interface Window {
    __desktopTest: { calls: Call[]; unexpected: string[]; annotations: Record<string, unknown>[]; releaseContext?: () => void; contextLoaded?: boolean; connected?: boolean };
  }
}

// Only the IPC boundary is simulated. Components, store, routing, CSS, native
// dialog behavior, focus, keyboard, media decoding and click hit testing are real.
export async function prepareDesktop(page: Page, scenario: Scenario = "idle", samples = sampleFixture(), annotations: Record<string,unknown>[] = []) {
  const video = "data:video/mp4;base64," + readFileSync(new URL("../fixtures/arena.mp4", import.meta.url)).toString("base64");
  await page.addInitScript(({ experiment, job, samples, video, scenario, annotations }) => {
    if (scenario === "empty") { experiment.trackingSelection = undefined; }
    localStorage.setItem("behavetracker.experiments.v1", JSON.stringify([experiment]));
    localStorage.setItem("behavetracker.researcher.v1", JSON.stringify({ name: "Pesquisador de teste", laboratory: "Laboratório", university: "Universidade" }));
    const state: Window["__desktopTest"] = { calls: [], unexpected: [], annotations };
    window.__desktopTest = state;
    if(scenario === "saved-proposals"||scenario==="proposal-review-error"){
      state.annotations=JSON.parse(sessionStorage.getItem("test-proposal-history")??"null")??annotations;
      job.report.rearing={state:"proposed",message:"Propostas salvas para revisão.",candidates:[{frameIndex:10,timestampSec:.4},{frameIndex:30,timestampSec:1.2}]};
    }
    if(scenario==="many-proposals")job.report.rearing={state:"proposed",message:"Propostas para revisão.",candidates:Array.from({length:24},(_,i)=>({frameIndex:i*2,timestampSec:i*2/25}))};
    let currentJob = job;
    const failure = "Falha de teste: não foi possível iniciar o processamento.";
    const invoke = async (command: string, args: Record<string, unknown> = {}) => {
      state.calls.push({ command, args });
      switch (command) {
        case "get_google_oauth_config": return { connected: scenario!=="fresh-login"||Boolean(state.connected), accountEmail: "researcher@example.test", eligibleGpuCount: 0, runtimes: [], profiles: [] };
        case "list_local_tracking_jobs":
          if(scenario === "jobs-slow")return new Promise(()=>{});
          return scenario === "empty" ? [] : [currentJob];
        case "list_colab_jobs": case "list_local_behavior_jobs": return [];
        case "get_local_tracking_result": return scenario === "tracking-slow" ? new Promise(()=>{}) : samples;
        case "get_local_wistar_result": case "get_colab_job_preparation": return null;
        case "get_local_audit_video": return { videoPath: video, videoError: null };
        case "get_staged_video_path": return video;
        case "get_local_tracking_environment": return { ready: true, version: "4.13.0", openclAvailable: false };
        case "get_behavior_model_status":
          if (scenario === "model-slow") return new Promise(() => {});
          if (scenario === "model-error") throw new Error("Modelo indisponível");
          return { environmentReady: false, installed: false, remoteAvailable: false,
            manifest: { modelVersion: "untrained", sampleRateHz: 15, architecture: "hybrid_tcn" } };
        case "get_staged_analysis_video":
          if (scenario === "stage-error") throw new Error("Falha de teste ao verificar o vídeo original.");
          return { originalUploadId: "original-01", originalSha256: experiment.video.sha256 };
        case "start_local_tracking":
          if (scenario === "start-error") throw new Error(failure);
          currentJob = { ...currentJob, state: "running", report: { ...currentJob.report, framesProcessed: 1 } };
          return currentJob;
        case "cancel_local_tracking":
          if (scenario === "cancel-error") throw new Error("Falha de teste ao cancelar.");
          currentJob = { ...currentJob, state: "cancelled" };
          return null;
        case "get_behavior_annotation_context":
          if(scenario === "context-error")throw new Error("Vídeo original indisponível para anotação.");
          if(scenario === "startup-slow"||scenario === "fresh-login")await new Promise<void>(resolve => {state.releaseContext = resolve;});
          state.contextLoaded = true;
          return { videoPath: video, frameTimes: samples.map(row => row.timestampSec), durationSec: 2 };
        case "list_behavior_annotations": return structuredClone(state.annotations);
        case "export_behavior_annotations": return {path:`/results/${args.kind}.${args.kind==="history"?"jsonl":"csv"}`};
        case "reveal_behavior_export": return null;
        case "export_behavior_training_package": return {path:"/results/training.zip"};
        case "preview_local_rearing_peaks": return {candidates:[{frameIndex:20,timestampSec:.8,score:.7,label:"REARING_UNSPECIFIED",observation:"UNCERTAIN"}],
          trackingTermination:{timestampSec:1.8},sameTrainingVideo:true,message:"Propostas de teste para revisão.",resultDirectory:"/results/apex-test"};
        case "preview_local_rearing_geometry":
          if(scenario === "detection-error"&&state.calls.filter(call=>call.command===command).length===1)throw new Error("Falha de teste ao procurar rearing.");
          return {state:"proposed",scientificallyValidated:false,metricEligible:false,durationMeasured:false,
          candidates:[{frameIndex:20,timestampSec:.8,startSec:.6,endSec:1,verification:"limited",
            reasons:["shortened_axis","compact_silhouette","posture_transition"],evidence:{axisLengthRatio:.65,silhouetteAreaRatio:.7,headOnWall:false}}],
          trackingTermination:{timestampSec:1.8},message:"Confirme no vídeo. Limites são estimados.",resultDirectory:"/results/geometry-test"};
        case "append_behavior_annotation":
          if(scenario === "annotation-error" && state.calls.filter(call=>call.command === command).length === 1) throw new Error("Falha de teste ao salvar a marcação.");
          state.annotations.push(structuredClone(args.annotation as Record<string, unknown>)); return null;
        case "review_behavior_proposal": {
          if(scenario==="proposal-review-error"&&state.calls.filter(call=>call.command===command).length===1)throw new Error("Falha de teste ao salvar a revisão.");
          const review=args.review as {frameIndex:number;timestampSec:number;annotatorId:string;decision:string;label?:string};
          const base={schemaVersion:1,source:"human",experimentId:args.experimentId,trackingJobId:args.trackingJobId,videoSha256:args.videoSha256,createdAt:new Date().toISOString(),annotatorId:review.annotatorId};
          const undone=new Set(state.annotations.filter(a=>a.type==="UNDO").map(a=>a.targetId));
          const peak=state.annotations.find(a=>a.type==="PEAK"&&a.frameIndex===review.frameIndex&&!undone.has(a.id));
          const id=crypto.randomUUID(),entries:Record<string,unknown>[]=[];
          if(review.decision==="accept")entries.push({...base,id,type:peak?"LABEL_PEAK":"PEAK",label:review.label??"REARING_UNSPECIFIED",
            ...(peak?{targetId:peak.id}:{timestampSec:review.timestampSec,frameIndex:review.frameIndex})});
          else if(peak)entries.push({...base,id,type:"UNDO",targetId:peak.id});
          entries.push({...base,id:crypto.randomUUID(),type:"PROPOSAL_REVIEW",...review,...(review.decision==="accept"?{peakId:peak?.id??id}:{})});
          state.annotations.push(...structuredClone(entries));
          sessionStorage.setItem("test-proposal-history",JSON.stringify(state.annotations));
          return entries;
        }
        case "plugin:event|listen": return 1;
        case "plugin:event|unlisten": return null;
        case "plugin:window|is_maximized": case "plugin:window|is_fullscreen": return false;
        default:
          state.unexpected.push(command);
          throw new Error(`Unexpected desktop command in test: ${command}`);
      }
    };
    Object.assign(window, {
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        convertFileSrc: (path: string) => path, transformCallback: () => 1, unregisterCallback: () => {}, invoke },
    });
  }, { experiment: experimentFixture(), job: jobFixture(scenario === "running" || scenario === "cancel-error" ? "running" : "succeeded"),
    samples, video, scenario, annotations });
}

export async function openExperiment(page: Page, scenario: Scenario = "idle", samples = sampleFixture(), annotations: Record<string,unknown>[] = []) {
  await prepareDesktop(page, scenario, samples, annotations);
  await page.goto("/");
  await expect(page.locator("#startup-splash")).toHaveCount(0);
  await page.getByRole("heading", { name: "Campo aberto de teste", exact: true }).click();
  await page.getByRole("tab", { name: "Análise", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analisar", exact: true })).toBeVisible();
}

export const test = base.extend<{ checkBrowserErrors: void }>({
  checkBrowserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await use();
    expect(errors, "unhandled errors in the real application").toEqual([]);
    expect(await page.evaluate(() => window.__desktopTest?.unexpected ?? []), "unmocked IPC contracts").toEqual([]);
  }, { auto: true }],
});
export { expect };
