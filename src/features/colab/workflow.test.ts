import { describe, expect, it } from "vitest";
import type { ColabJob, ColabJobEvent } from "./analysis";
import type { LocalJob } from "../local/api";
import { checkpoints, diaryEvents, displayAnalysisMessage, gpuMessage, localCheckpoints, preparingNewAnalysis, reportedFrameProgress } from "./workflow";

function event(id: number, stage: string, message = stage): ColabJobEvent {
  return { id, stage, message, progress: 0, status: "running", createdAt: "2026-11-06T12:00:00Z" };
}

function job(overrides: Partial<ColabJob>): ColabJob {
  return { jobId: "job-1", experimentId: "experiment-1", status: "running", stage: "queued",
    progress: 0, message: "Aguardando", runtimeName: null, error: null,
    createdAt: "2026-11-06T12:00:00Z", updatedAt: "2026-11-06T12:01:00Z", events: [], ...overrides };
}

describe("checkpoints da análise", () => {
  it("representa a fila, a detecção e o fim de uma execução local no card compartilhado", () => {
    const queued: LocalJob = { jobId: "local-1", experimentId: "experiment-1", state: "queued",
      error: null, createdAt: "2026-11-06T12:00:00Z", videoSha256: "sha", uploadId: "video-1", config: {}, report: {} };
    expect(localCheckpoints(null, false, false, "open_field").every(step => step.state === "pending")).toBe(true);
    expect(localCheckpoints(null, true, false, "open_field").find(step => step.state === "active")?.title).toBe("Preparando vídeo");
    expect(localCheckpoints(queued, false, false, "open_field").find(step => step.state === "active")?.title).toBe("Preparando OpenCV");
    const tracking: LocalJob = { ...queued, state: "running", report: { phase: "tracking", framesProcessed: 20 } };
    expect(localCheckpoints(tracking, false, false, "open_field").find(step => step.state === "active")?.title).toBe("Detectando animal");
    expect(localCheckpoints({ ...tracking, report: { phase: "rendering" } }, false, false, "open_field").at(-1))
      .toMatchObject({ title: "Renderizando vídeo", state: "active" });
    expect(localCheckpoints({ ...tracking, state: "cancelled" }, false, true, "open_field").find(step => step.state === "failed")?.title).toBe("Detectando animal");
    expect(localCheckpoints({ ...tracking, state: "succeeded" }, false, false, "open_field").every(step => step.state === "done")).toBe(true);
  });

  it("exibe a referência de presença para o FST local e o envio de vídeo para o Colab", () => {
    const reference: LocalJob = { jobId: "local-fst", experimentId: "experiment-1", state: "running",
      error: null, createdAt: "2026-11-06T12:00:00Z", videoSha256: "sha", uploadId: "video-1", config: {}, report: { phase: "reference" } };
    expect(localCheckpoints(reference, false, false, "forced_swim").find(step => step.state === "active")?.description).toContain("cilindros");
    expect(checkpoints(job({ stage: "uploading" }), false, false, "forced_swim").find(step => step.state === "active")?.title).toBe("Enviando vídeo");
  });
  it("descreve o fundo da sessão e mantém os checkpoints neurais quando selecionados", () => {
    const reference: LocalJob = { jobId: "local", experimentId: "experiment", state: "running", error: null,
      createdAt: "2026-11-24T12:00:00Z", videoSha256: "sha", uploadId: "original",
      config: { strategy: "classical_roi_v1" }, report: { phase: "reference" } };
    const steps = localCheckpoints(reference, false, false, "open_field");
    expect(steps.find(step => step.state === "active")?.description).toContain("Fundo mediano");
    expect(steps.some(step => step.title === "Estimando pose")).toBe(false);
    expect(localCheckpoints({ ...reference, config: { strategy: "wistar_hrnet" } }, false, false, "open_field")
      .some(step => step.title === "Estimando pose")).toBe(true);
  });

  it("avança da detecção Wistar para a pose antes de preparar o vídeo anotado", () => {
    const pose: LocalJob = { jobId: "local-wistar", experimentId: "experiment-1", state: "running",
      error: null, createdAt: "2026-11-06T12:00:00Z", videoSha256: "sha", uploadId: "video-1",
      config: { strategy: "wistar_hrnet" }, report: { phase: "pose", framesProcessed: 20 } };
    const steps = localCheckpoints(pose, false, false, "open_field");
    expect(steps[2]).toMatchObject({ title: "Detectando animal", state: "done" });
    expect(steps[3]).toMatchObject({ title: "Estimando pose", state: "active" });
    expect(steps[4].state).toBe("pending");
  });

  it("mostra apenas contagens de frames explicitamente reportadas pelo Colab", () => {
    expect(reportedFrameProgress(job({stage:"inference",message:"SuperAnimal em execução · lote atual: Detector Wistar · 240/7356 (3.2 frames/s)"}),"open_field"))
      .toEqual({processed:240,total:7356,remaining:7116,scope:"Detecção"});
    expect(reportedFrameProgress(job({stage:"inference",message:"SuperAnimal em execução · lote atual: 3633/7356 (49%)"}),"open_field")).toBeNull();
    expect(reportedFrameProgress(job({stage:"inference",message:"SuperAnimal em execução · lote atual: Recuperação visual: 240/7356 frames verificados"}),"open_field"))
      .toEqual({processed:240,total:7356,remaining:7116,scope:"Recuperação visual"});
    expect(reportedFrameProgress(job({stage:"inference",message:"FST em execução · lote atual: FST_STAGE=inference · FST_FRAMES=animal_2:600/1200",protocol:"forced_swim"}),"forced_swim"))
      .toEqual({processed:600,total:1200,remaining:600,scope:"Animal 2"});
    expect(reportedFrameProgress(job({stage:"inference",message:"FST_FRAMES=animal_2:1201/1200",protocol:"forced_swim"}),"forced_swim")).toBeNull();
    expect(reportedFrameProgress(job({message:"FST em execução · lote atual: FST_STAGE=presence",protocol:"forced_swim",stage:"presence"}),"forced_swim")).toBeNull();
  });

  it("mostra a preparação de um novo job mesmo após uma execução interrompida", () => {
    const previous = job({ status: "failed", message: "O aplicativo fechou" });
    expect(preparingNewAnalysis(true, null, [previous])).toBe(true);
    expect(preparingNewAnalysis(true, job({ stage: "uploading" }), [previous])).toBe(false);
    expect(preparingNewAnalysis(true, null, [job({ status: "running" })])).toBe(false);
  });

  it("apresenta mensagens históricas sem o codinome do pipeline", () => {
    expect(displayAnalysisMessage("Executando pipeline D+F · detector Wistar")).toBe("Executando pipeline · detector Wistar");
    expect(displayAnalysisMessage("D+F: Detector Wistar · lote 16")).toBe("Detector Wistar · lote 16");
    expect(displayAnalysisMessage("D+F: analisando 1%-2%-5%")).toBe("analisando");
  });
  it("resume o diário por etapa e remove porcentagens e nomes internos", () => {
    const events = [event(1, "inference", "D+F: analisando 1%"), event(2, "inference", "D+F: analisando 2%"),
      event(3, "rendering", "Renderizando 5%"), { ...event(4, "rendering", "D+F: erro 10%"), status: "failed" as const }];
    const entries = diaryEvents(events, "open_field");
    expect(entries.map(item => item.message)).toEqual(["Detectando animal em andamento", "Preparando resultados em andamento", "Falha em preparando resultados: erro"]);
    expect(entries.map(item => item.id)).toEqual([1, 3, 4]);
  });
  it("mostra a etapa ativa e a GPU realmente confirmada", () => {
    const events = [event(1, "runtime"), event(2, "gpu_ready", "Tesla T4 encontrada · sessão pronta"), event(3, "uploading")];
    const steps = checkpoints(job({ stage: "uploading", events }));
    expect(steps.map((step) => step.state)).toEqual(["done", "done", "active", "pending", "pending", "pending", "pending"]);
    expect(gpuMessage(events)).toBe("Tesla T4 encontrada · sessão pronta");
    expect(gpuMessage([event(1, "runtime", "Procurando GPU")])).toBeUndefined();
  });

  it("localiza a falha de arquivo e mantém o processamento pendente", () => {
    const steps = checkpoints(job({ status: "failed", stage: "verifying", events: [event(1, "uploading"), event(2, "verifying")] }));
    expect(steps[2].state).toBe("done");
    expect(steps[3].state).toBe("failed");
    expect(steps[5].state).toBe("pending");
  });

  it("não inventa confirmações para uma execução antiga sem eventos", () => {
    const steps = checkpoints(job({ status: "failed", stage: "failed", progress: 47 }));
    expect(steps.every((step) => step.state === "pending")).toBe(true);
  });

  it("distingue preparação local com erro de uma análise concluída", () => {
    expect(checkpoints(null, true)[0].state).toBe("active");
    expect(checkpoints(null, false, true)[0].state).toBe("failed");
    expect(checkpoints(job({ status: "succeeded", stage: "completed" })).every((step) => step.state === "done")).toBe(true);
  });

  it("mostra a reutilização do ambiente como checkpoint concluído", () => {
    const events = [event(1, "environment_check"), event(2, "environment_ready", "Reutilizando DeepLabCut")];
    const steps = checkpoints(job({ stage: "environment_ready", events }));
    expect(steps[4].state).toBe("done");
    expect(steps[4].event?.message).toBe("Reutilizando DeepLabCut");
    expect(steps[5].state).toBe("pending");
  });

  it("mantém a inferência ativa enquanto reconecta à mesma execução", () => {
    const steps = checkpoints(job({ stage: "inference", events: [event(1, "inference", "Reconectando à mesma execução")] }));
    expect(steps[5].state).toBe("active");
    expect(steps[5].event?.message).toContain("Reconectando");
  });
  it("mantém renderização separada sem reabrir a etapa de inferência", () => {
    const steps = checkpoints(job({stage:"rendering",resultsReady:true,events:[event(1,"inference"),event(2,"downloading"),event(3,"rendering")]}));
    expect(steps[5].state).toBe("done");
    expect(steps[6].state).toBe("active");
  });
  it("usa etapas FST sem nomes e modelos de Campo Aberto", () => {
    const steps = checkpoints(job({protocol:"forced_swim",stage:"inference",events:[event(1,"presence"),event(2,"inference")]}),false,false,"forced_swim");
    expect(steps[5].state).toBe("done");
    expect(steps[6].state).toBe("active");
    expect(steps[5].title).toContain("corpo");
    expect(steps[6].title).toContain("pontos");
    expect(steps.map(step=>step.description).join(" ")).not.toContain("Wistar");
  });
});
