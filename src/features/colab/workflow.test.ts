import { describe, expect, it } from "vitest";
import type { ColabJob, ColabJobEvent } from "./analysis";
import { checkpoints, displayAnalysisMessage, gpuMessage, preparingNewAnalysis } from "./workflow";

function event(id: number, stage: string, message = stage): ColabJobEvent {
  return { id, stage, message, progress: 0, status: "running", createdAt: "2026-11-06T12:00:00Z" };
}

function job(overrides: Partial<ColabJob>): ColabJob {
  return { jobId: "job-1", experimentId: "experiment-1", status: "running", stage: "queued",
    progress: 0, message: "Aguardando", runtimeName: null, error: null,
    createdAt: "2026-11-06T12:00:00Z", updatedAt: "2026-11-06T12:01:00Z", events: [], ...overrides };
}

describe("checkpoints da análise", () => {
  it("mostra a preparação de um novo job mesmo após uma execução interrompida", () => {
    const previous = job({ status: "failed", message: "O aplicativo fechou" });
    expect(preparingNewAnalysis(true, null, [previous])).toBe(true);
    expect(preparingNewAnalysis(true, job({ stage: "uploading" }), [previous])).toBe(false);
    expect(preparingNewAnalysis(true, null, [job({ status: "running" })])).toBe(false);
  });

  it("apresenta mensagens históricas sem o codinome do pipeline", () => {
    expect(displayAnalysisMessage("Executando pipeline D+F · detector Wistar")).toBe("Executando pipeline · detector Wistar");
    expect(displayAnalysisMessage("D+F: Detector Wistar · lote 16")).toBe("Detector Wistar · lote 16");
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
    const steps = checkpoints(job({protocol:"forced_swim",stage:"presence",events:[event(1,"inference"),event(2,"presence")]}),false,false,"forced_swim");
    expect(steps[5].state).toBe("done");
    expect(steps[6].state).toBe("active");
    expect(steps[6].title).toContain("presença");
    expect(steps.map(step=>step.description).join(" ")).not.toContain("Wistar");
  });
});
