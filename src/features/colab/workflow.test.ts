import { describe, expect, it } from "vitest";
import type { ColabJob, ColabJobEvent } from "./analysis";
import { checkpoints, gpuMessage } from "./workflow";

function event(id: number, stage: string, message = stage): ColabJobEvent {
  return { id, stage, message, progress: 0, status: "running", createdAt: "2026-11-06T12:00:00Z" };
}

function job(overrides: Partial<ColabJob>): ColabJob {
  return { jobId: "job-1", experimentId: "experiment-1", status: "running", stage: "queued",
    progress: 0, message: "Aguardando", runtimeName: null, error: null,
    createdAt: "2026-11-06T12:00:00Z", updatedAt: "2026-11-06T12:01:00Z", events: [], ...overrides };
}

describe("checkpoints da análise", () => {
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
});
