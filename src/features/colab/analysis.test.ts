import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { defaultArena } from "../../lib/demo-data";
import { loadColabVideo, loadDiagnosticResult, prepareVideo, startColabJob, resolveDiagnosticUpload } from "./analysis";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({}), convertFileSrc: (path: string) => `asset://${path}` }));

describe("geometria enviada ao backend Colab", () => {
  it("envia borda, chão, revisão e resolução na mesma solicitação", async () => {
    await startColabJob("experiment", "upload", { width: 1280, height: 720, durationSec: 10 }, defaultArena);
    expect(invoke).toHaveBeenLastCalledWith("start_colab_analysis", { request: {
      experimentId: "experiment", uploadId: "upload", workload: { width: 1280, height: 720, durationSec: 10 },
      arena: { ...defaultArena, videoWidth: 1280, videoHeight: 720 },
    } });
  });

  it("não inventa a borda de projetos antigos", async () => {
    const { rimCornersPx: _, ...legacy } = defaultArena;
    await startColabJob("legacy", "upload", { width: 1280, height: 720, durationSec: 10 }, legacy);
    const request = vi.mocked(invoke).mock.lastCall?.[1] as { request: { arena: unknown } };
    expect(request.request.arena).not.toHaveProperty("rimCornersPx");
  });
  it("identifica o teste curto sem alterar a geometria nem a duração do vídeo original", async () => {
    await startColabJob("exp", "upload", { width:1280,height:720,durationSec:306 }, defaultArena, {startSec:1,endSec:6});
    expect(invoke).toHaveBeenLastCalledWith("start_colab_analysis", {request:{experimentId:"exp",uploadId:"upload",workload:{width:1280,height:720,durationSec:306},arena:{...defaultArena,videoWidth:1280,videoHeight:720},diagnostic:{startSec:1,endSec:6}}});
  });
  it("recusa relatório diagnóstico incompleto antes de abrir o player", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({report:{schemaVersion:1},rawPoseCsv:"",clipPath:null});
    await expect(loadDiagnosticResult("bad")).rejects.toThrow("incompatível ou incompleto");
  });
  it("prepara a cópia local antes de iniciar qualquer upload remoto", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === "begin_video_staging" ? { uploadId: "original" }
      : command === "prepare_analysis_video" ? { uploadId: "optimized", pixelVerified: true, uploadBytes: 2, originalBytes: 4 } : {});
    const file = { name: "video.mp4", size: 4, slice: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }) } as unknown as File;
    const result = await prepareVideo("experiment", file, { width: 1920, height: 1080 }, vi.fn());
    expect(result.uploadId).toBe("optimized");
    expect(invoke).toHaveBeenLastCalledWith("prepare_analysis_video", { uploadId: "original", width: 1920, height: 1080 });
    expect(vi.mocked(invoke).mock.calls.slice(-4).map(([name]) => name)).toEqual(["begin_video_staging", "append_video_staging_chunk", "finish_video_staging", "prepare_analysis_video"]);
  });
  it("usa URL de arquivo local sem carregar o MP4 inteiro no JavaScript", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ jobId: "job", videoPath: "/results/job-dlc.mp4", videoError: null });
    expect((await loadColabVideo("job")).videoUrl).toBe("asset:///results/job-dlc.mp4");
    vi.mocked(invoke).mockResolvedValueOnce({ jobId: "old", videoPath: null, videoError: "Reprocesse" });
    expect((await loadColabVideo("old")).videoUrl).toBeNull();
  });
});

describe("cache de vídeo antes do diagnóstico", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());
  it("reutiliza somente um cache confirmado no backend", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);
    expect(await resolveDiagnosticUpload("exp","cached",undefined,vi.fn())).toBe("cached");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("check_video_staging",{experimentId:"exp",uploadId:"cached"});
  });
  it("solicita o original quando ready no banco aponta para arquivo removido", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(false);
    expect(await resolveDiagnosticUpload("exp","deleted",undefined,vi.fn())).toBeNull();
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["check_video_staging"]);
  });
  it("refaz o staging a partir do arquivo selecionado sem tentar usar o cache removido", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === "check_video_staging" ? false
      : command === "begin_video_staging" ? {uploadId:"restored"} : {});
    const file = {name:"original.mp4",size:4,slice:()=>({arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer})} as unknown as File;
    expect(await resolveDiagnosticUpload("exp","deleted",file,vi.fn())).toBe("restored");
    expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(["check_video_staging","begin_video_staging","append_video_staging_chunk","finish_video_staging"]);
    expect(invoke).not.toHaveBeenCalledWith("start_colab_analysis",expect.anything());
  });
  it("não confunde falha ao consultar o banco com cache inexistente", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("Banco indisponível");
    await expect(resolveDiagnosticUpload("exp","cached",undefined,vi.fn())).rejects.toBe("Banco indisponível");
  });
});
