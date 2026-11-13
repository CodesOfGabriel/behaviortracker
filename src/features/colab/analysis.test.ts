import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { defaultArena } from "../../lib/demo-data";
import type { ForcedSwimExperiment, VideoPreparation } from "../../types";
import { loadColabVideo, prepareFstVideo, prepareVideo, startColabJob, startFstJob } from "./analysis";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({}), convertFileSrc: (path: string) => `asset://${path}` }));

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
  it("prepara a cópia local antes de iniciar qualquer upload remoto", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === "begin_video_staging" ? { uploadId: "original" }
      : command === "prepare_analysis_video" ? { uploadId: "optimized", pixelVerified: true, uploadBytes: 2, originalBytes: 4 } : {});
    const file = { name: "video.mp4", size: 4, slice: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }) } as unknown as File;
    const result = await prepareVideo("experiment", file, { width: 1920, height: 1080 }, vi.fn());
    expect(result.uploadId).toBe("optimized");
    expect(invoke).toHaveBeenLastCalledWith("prepare_analysis_video", { uploadId: "original", width: 1920, height: 1080 });
    expect(vi.mocked(invoke).mock.calls.slice(-4).map(([name]) => name)).toEqual(["begin_video_staging", "append_video_staging_raw", "finish_video_staging", "prepare_analysis_video"]);
    expect(vi.mocked(invoke).mock.calls.at(-3)?.[1]).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(vi.mocked(invoke).mock.calls.at(-3)?.[2]).toEqual({ headers: { "x-upload-id": "original", "x-offset": "0" } });
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
  it("usa URL de arquivo local sem carregar o MP4 inteiro no JavaScript", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ jobId: "job", videoPath: "/results/job-dlc.mp4", videoError: null });
    expect((await loadColabVideo("job")).videoUrl).toBe("asset:///results/job-dlc.mp4");
    vi.mocked(invoke).mockResolvedValueOnce({ jobId: "old", videoPath: null, videoError: "Reprocesse" });
    expect((await loadColabVideo("old")).videoUrl).toBeNull();
  });
});
