import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { experimentFixture, jobFixture, sampleFixture } from "../../../tests/fixtures/experiment";
import { clearAnalysisCache } from "../../lib/session-cache";
import { loadLocalResult } from "../local/api";
import { annotationContext, appendAnnotation, cachedAnnotations, getBehaviorModelStatus, listAnnotations, setupBehaviorEnvironment } from "./api";
import { preloadRearing } from "./preload";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (path:string) => path }));
beforeEach(() => {
  clearAnalysisCache(); vi.resetAllMocks();
  vi.mocked(invoke).mockImplementation(async (command) => {
    switch (command) {
      case "list_local_tracking_jobs": return [jobFixture()];
      case "list_local_behavior_jobs": return [];
      case "get_local_tracking_result": return sampleFixture();
      case "list_behavior_annotations": return [];
      case "get_behavior_annotation_context": return {videoPath:"video.mp4",frameTimes:[0,.04],durationSec:2};
      case "get_behavior_model_status": return {installed:false,environmentReady:false};
      case "append_behavior_annotation": case "setup_behavior_environment": return undefined;
      default: throw new Error(`Unexpected command: ${command}`);
    }
  });
});

it("warms rearing before startup completes and reuses reads on repeated visits", async () => {
  const experiment = experimentFixture();
  await preloadRearing([experiment]);
  for (let visit=0;visit<3;visit++) {
    await Promise.all([annotationContext(experiment.id,"tracking-01",experiment.video.sha256!),listAnnotations("tracking-01"),loadLocalResult("tracking-01"),getBehaviorModelStatus()]);
  }
  for (const command of ["get_behavior_annotation_context","list_behavior_annotations","get_local_tracking_result","get_behavior_model_status"]) {
    expect(vi.mocked(invoke).mock.calls.filter(([name])=>name===command),command).toHaveLength(1);
  }
});

it("keeps successfully appended human history in the next visit and rejects failed writes", async () => {
  await preloadRearing([experimentFixture()]);
  const annotation={schemaVersion:1 as const,id:"peak",type:"PEAK" as const,source:"human" as const,
    experimentId:"ui-open-field",trackingJobId:"tracking-01",videoSha256:"a".repeat(64),createdAt:"2026-01-01",annotatorId:"observer"};
  await appendAnnotation(annotation);
  expect(await listAnnotations("tracking-01")).toEqual([annotation]);
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Disk unavailable"));
  await expect(appendAnnotation({...annotation,id:"failed"})).rejects.toThrow("Disk unavailable");
  expect(cachedAnnotations("tracking-01")).toEqual([annotation]);
});

it("rechecks the model after environment changes", async () => {
  await getBehaviorModelStatus(); await setupBehaviorEnvironment(); await getBehaviorModelStatus();
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==="get_behavior_model_status")).toHaveLength(2);
});

it("excludes another source, incomplete tracking and other protocols from startup", async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if(command==="get_behavior_model_status")return {installed:false};
    if(command==="list_local_tracking_jobs")return [
      {...jobFixture(),videoSha256:"b".repeat(64)},
      {...jobFixture(),state:"running"},
      {...jobFixture(),config:{protocol:"forced_swim"}},
      {...jobFixture(),config:{protocol:"open_field",strategy:"wistar_hrnet"}},
    ];
    throw new Error("Not a valid rearing source");
  });
  await preloadRearing([experimentFixture()]);
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==="get_behavior_annotation_context")).toBe(false);
});

it("one unavailable video does not stop other startup reads and failed reads remain retryable", async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  let contextAttempts=0;
  vi.mocked(invoke).mockImplementation(async (command,args) => {
    if(command==="get_behavior_annotation_context" && contextAttempts++===0)throw new Error("Video missing");
    return original(command,args);
  });
  await preloadRearing([experimentFixture()]);
  expect(await listAnnotations("tracking-01")).toEqual([]);
  await expect(annotationContext("ui-open-field","tracking-01","a".repeat(64))).resolves.toHaveProperty("videoUrl");
  expect(contextAttempts).toBe(2);
});

it("stops startup dependency chains after logout or experiment deletion", async () => {
  const original=vi.mocked(invoke).getMockImplementation()!;
  let release!:(jobs:ReturnType<typeof jobFixture>[])=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>command==="list_local_tracking_jobs"
    ?new Promise(resolve=>{release=resolve;}) :original(command,args));
  const pending=preloadRearing([experimentFixture()]);
  await Promise.resolve();
  clearAnalysisCache();
  release([jobFixture()]);
  await pending;
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==="get_behavior_annotation_context")).toBe(false);
  expect(cachedAnnotations("tracking-01")).toBeUndefined();
});
