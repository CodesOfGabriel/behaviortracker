import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { defaultArena } from "../../lib/demo-data";
import type { ForcedSwimExperiment, RadialMazeExperiment, VideoPreparation } from "../../types";
import { loadColabVideo, prepareFstVideo, prepareVideo, startColabJob, startFstJob, startRamJob } from "./analysis";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({}), convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

describe("geometria enviada ao backend Colab", () => {
  it("envia borda, chão, revisão e resolução na mesma solicitação", async () => {
    await startColabJob("experiment", "upload", { width: 1280, height: 720, durationSec: 10 }, defaultArena);
    expect(invoke).toHaveBeenLastCalledWith("start_colab_analysis", { request: {
      experimentId: "experiment", uploadId: "upload", workload: { width: 1280, height: 720, durationSec: 10 },
      arena: { ...defaultArena, videoWidth: 1280, videoHeight: 720 },
      engineId: "wistar_superanimal_hybrid_v1",
      modelBundleId: "wistar_df_v2",
    } });
  });

  it("não inventa a borda de projetos antigos", async () => {
    const { rimCornersPx: _, ...legacy } = defaultArena;
    await startColabJob("legacy", "upload", { width: 1280, height: 720, durationSec: 10 }, legacy);
    const request = vi.mocked(invoke).mock.lastCall?.[1] as { request: { arena: unknown } };
    expect(request.request.arena).not.toHaveProperty("rimCornersPx");
  });
  it("preserva o bundle informado por um experimento antigo", async () => {
    await startColabJob("v1", "upload", { width: 1280, height: 720, durationSec: 10 }, defaultArena, "wistar_superanimal_hybrid_v1", "wistar_df_v1");
    expect((vi.mocked(invoke).mock.lastCall?.[1] as {request: {modelBundleId: string}}).request.modelBundleId).toBe("wistar_df_v1");
  });
  it("envia cilindros FST convertidos para o vídeo reduzido e registra a escala", async () => {
    const preparation = { uploadId: "prepared", uploadWidth: 1920, uploadHeight: 1080,
      policyVersion: "quality-upload-2" } as VideoPreparation;
    const experiment = { id: "fst", title: "Nado", video: { width: 3840, height: 2160, durationSec: 10 },
      subjects: [{ animalId: "animal_1", subjectId: "R1" }],
      tanks: [{ tankId: "tank_1", animalId: "animal_1", subjectId: "R1", revision: 1,
        roiPx: { x: 200, y: 100, width: 1000, height: 1800 } }] } as ForcedSwimExperiment;
    await startFstJob(experiment, preparation);
    const request = (vi.mocked(invoke).mock.lastCall?.[1] as { request: { workload: unknown; fst: { tanks: ForcedSwimExperiment["tanks"]; sourceWidth: number; sourceHeight: number; preparationPolicyVersion: string } } }).request;
    expect(request.workload).toEqual({ width: 1920, height: 1080, durationSec: 10 });
    expect(request.fst.tanks[0].roiPx).toEqual({ x: 100, y: 50, width: 500, height: 900 });
    expect(request.fst).toMatchObject({ sourceWidth: 3840, sourceHeight: 2160, preparationPolicyVersion: "quality-upload-2" });
  });
  it("envia somente a área analisável RAM na escala do vídeo preparado", async () => {
    const preparation = { uploadId: "ram-prepared", uploadWidth: 960, uploadHeight: 540,
      policyVersion: "fst-adaptive-1" } as VideoPreparation;
    const experiment = { id: "ram", video: { width: 1920, height: 1080, durationSec: 30 },
      geometry: { revision: 2, walkableMaskVersion: "mask-2", walkablePolygonPx: [
        { x: 200, y: 100 }, { x: 1600, y: 100 }, { x: 1600, y: 900 }, { x: 200, y: 900 } ] } } as RadialMazeExperiment;
    await startRamJob(experiment, preparation);
    const request = (vi.mocked(invoke).mock.lastCall?.[1] as { request: Record<string, unknown> }).request;
    expect(request).toMatchObject({ experimentId: "ram", uploadId: "ram-prepared",
      engineId: "wistar_ram_hybrid_v1", modelBundleId: "wistar_df_v2",
      workload: { width: 960, height: 540, durationSec: 30 },
      ram: { revision: 2, walkableMaskVersion: "mask-2", sourceWidth: 1920, sourceHeight: 1080,
        walkablePolygonPx: [{ x: 100, y: 50 }, { x: 800, y: 50 }, { x: 800, y: 450 }, { x: 100, y: 450 }] } });
    expect(request).not.toHaveProperty("arena");
  });
  it("prepara a cópia local antes de iniciar qualquer upload remoto", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === "begin_video_staging" ? { uploadId: "original" }
      : command === "prepare_analysis_video" ? { uploadId: "optimized", pixelVerified: true, uploadBytes: 2, originalBytes: 4 } : {});
    const file = { name: "video.mp4", size: 4, slice: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }) } as unknown as File;
    const progress = vi.fn();
    const result = await prepareVideo("experiment", file, { width: 1920, height: 1080 }, progress);
    expect(result.uploadId).toBe("optimized");
    expect(invoke).toHaveBeenLastCalledWith("prepare_analysis_video", { uploadId: "original", width: 1920, height: 1080 });
    expect(vi.mocked(invoke).mock.calls.slice(-4).map(([name]) => name)).toEqual(["begin_video_staging", "append_video_staging_raw", "finish_video_staging", "prepare_analysis_video"]);
    expect(vi.mocked(invoke).mock.calls.at(-3)?.[1]).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(vi.mocked(invoke).mock.calls.at(-3)?.[2]).toEqual({ headers: { "x-upload-id": "original", "x-offset": "0" } });
    expect(progress).toHaveBeenCalledWith(100, "Cópia local concluída", { uploadId: "original", phase: "staging", percent: 100, remainingSec: 0 });
  });
  it("informa codificação e conferência no Campo Aberto", async () => {
    const unlisten = vi.fn();
    let notify: ((event: { payload: { uploadId: string; phase: "encoding" | "verifying"; percent: number; remainingSec: number | null } }) => void) | undefined;
    vi.mocked(listen).mockImplementationOnce(async (_event, callback) => {
      notify = callback as typeof notify;
      return unlisten;
    });
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "begin_video_staging") return { uploadId: "original" };
      if (command === "prepare_analysis_video") {
        notify?.({ payload: { uploadId: "outro", phase: "encoding", percent: 30, remainingSec: 40 } });
        notify?.({ payload: { uploadId: "original", phase: "encoding", percent: 60, remainingSec: 12 } });
        notify?.({ payload: { uploadId: "original", phase: "verifying", percent: 92, remainingSec: null } });
        return { uploadId: "optimized", message: "Vídeo preparado" };
      }
      return {};
    });
    const file = { name: "campo.mp4", size: 4, slice: () => ({ arrayBuffer: async () => new Uint8Array(4).buffer }) } as unknown as File;
    const progress = vi.fn();
    await prepareVideo("campo", file, { width: 1920, height: 1080 }, progress);
    expect(progress).toHaveBeenCalledWith(60, "Otimizando vídeo para envio", { uploadId: "original", phase: "encoding", percent: 60, remainingSec: 12 });
    expect(progress).toHaveBeenCalledWith(92, "Conferindo frames e tempos", { uploadId: "original", phase: "verifying", percent: 92, remainingSec: null });
    expect(progress).not.toHaveBeenCalledWith(30, expect.anything(), expect.anything());
    expect(unlisten).toHaveBeenCalledOnce();
  });
  it("usa a política adaptativa apenas para o vídeo FST", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === "begin_video_staging" ? { uploadId: "original" }
      : command === "get_video_staging_sha256" ? "digest"
      : command === "prepare_analysis_video" ? { uploadId: "original", policyVersion: "fst-adaptive-1" } : {});
    const file = { name: "nado.mp4", size: 4, slice: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }) } as unknown as File;
    const result = await prepareFstVideo("fst", file, { width: 1920, height: 1080 }, vi.fn(), "digest");
    expect(result.preparation.policyVersion).toBe("fst-adaptive-1");
    expect(invoke).toHaveBeenLastCalledWith("prepare_analysis_video", { uploadId: "original", width: 1920, height: 1080, fstAdaptive: true });
  });
  it("mostra somente o progresso do vídeo atual e libera o ouvinte", async () => {
    const unlisten = vi.fn();
    let notify: ((event: { payload: { uploadId: string; phase: "encoding"; percent: number; remainingSec: number } }) => void) | undefined;
    vi.mocked(listen).mockImplementationOnce(async (_event, callback) => {
      notify = callback as typeof notify;
      return unlisten;
    });
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "begin_video_staging") return { uploadId: "original" };
      if (command === "get_video_staging_sha256") return "digest";
      if (command === "prepare_analysis_video") {
        notify?.({ payload: { uploadId: "outro", phase: "encoding", percent: 20, remainingSec: 30 } });
        notify?.({ payload: { uploadId: "original", phase: "encoding", percent: 47, remainingSec: 12 } });
        return { uploadId: "prepared", policyVersion: "fst-adaptive-1" };
      }
      return {};
    });
    const file = { name: "nado.mp4", size: 4, slice: () => ({ arrayBuffer: async () => new Uint8Array(4).buffer }) } as unknown as File;
    const progress = vi.fn();
    await prepareFstVideo("fst", file, { width: 1920, height: 1080 }, progress, "digest");
    expect(progress).toHaveBeenCalledWith(47, "Convertendo vídeo para H.264", { uploadId: "original", phase: "encoding", percent: 47, remainingSec: 12 });
    expect(progress).not.toHaveBeenCalledWith(20, expect.anything(), expect.anything());
    expect(unlisten).toHaveBeenCalledOnce();
  });
  it("usa URL de arquivo local sem carregar o MP4 inteiro no JavaScript", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ jobId: "job", videoPath: "/results/job-dlc.mp4", videoError: null });
    expect((await loadColabVideo("job")).videoUrl).toBe("asset:///results/job-dlc.mp4");
    vi.mocked(invoke).mockResolvedValueOnce({ jobId: "old", videoPath: null, videoError: "Reprocesse" });
    expect((await loadColabVideo("old")).videoUrl).toBeNull();
  });
});
