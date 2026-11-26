import { readFileSync } from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";
import { experimentFixture, jobFixture, sampleFixture } from "../fixtures/experiment";

type Scenario = "empty" | "idle" | "running" | "start-error" | "stage-error" | "model-slow" | "model-error" | "cancel-error" | "annotation-error";
type Call = { command: string; args: Record<string, unknown> };
declare global {
  interface Window {
    __desktopTest: { calls: Call[]; unexpected: string[]; annotations: Record<string, unknown>[] };
  }
}

// Only the IPC boundary is simulated. Components, store, routing, CSS, native
// dialog behavior, focus, keyboard, media decoding and click hit testing are real.
export async function openExperiment(page: Page, scenario: Scenario = "idle", samples = sampleFixture()) {
  const video = "data:video/mp4;base64," + readFileSync(new URL("../fixtures/arena.mp4", import.meta.url)).toString("base64");
  await page.addInitScript(({ experiment, job, samples, video, scenario }) => {
    if (scenario === "empty") { experiment.trackingSelection = undefined; }
    localStorage.setItem("behavetracker.experiments.v1", JSON.stringify([experiment]));
    localStorage.setItem("behavetracker.researcher.v1", JSON.stringify({ name: "Pesquisador de teste", laboratory: "Laboratório", university: "Universidade" }));
    const state = { calls: [] as Call[], unexpected: [] as string[], annotations: [] as Record<string, unknown>[] };
    window.__desktopTest = state;
    let currentJob = job;
    const failure = "Falha de teste: não foi possível iniciar o processamento.";
    const invoke = async (command: string, args: Record<string, unknown> = {}) => {
      state.calls.push({ command, args });
      switch (command) {
        case "get_google_oauth_config": return { connected: true, accountEmail: "researcher@example.test", eligibleGpuCount: 0, runtimes: [], profiles: [] };
        case "list_local_tracking_jobs": return scenario === "empty" ? [] : [currentJob];
        case "list_colab_jobs": case "list_local_behavior_jobs": return [];
        case "get_local_tracking_result": return samples;
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
        case "get_behavior_annotation_context": return { videoPath: video, frameTimes: samples.map(row => row.timestampSec), durationSec: 2 };
        case "list_behavior_annotations": return structuredClone(state.annotations);
        case "export_behavior_annotations": return {path:`/results/${args.kind}.${args.kind==="history"?"jsonl":"csv"}`};
        case "reveal_behavior_export": return null;
        case "preview_local_rearing_peaks": return {candidates:[{frameIndex:20,timestampSec:.8,score:.7,label:"REARING_UNSPECIFIED",observation:"UNCERTAIN"}],
          trackingTermination:{timestampSec:1.8},sameTrainingVideo:true,message:"Propostas de teste para revisão.",resultDirectory:"/results/apex-test"};
        case "append_behavior_annotation":
          if(scenario === "annotation-error" && state.calls.filter(call=>call.command === command).length === 1) throw new Error("Falha de teste ao salvar a marcação.");
          state.annotations.push(structuredClone(args.annotation as Record<string, unknown>)); return null;
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
    samples, video, scenario });
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
