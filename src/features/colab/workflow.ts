import type { ColabJob, ColabJobEvent } from "./analysis";

export const workflowSteps = [
  { title: "Preparar vídeo", description: "Ler o arquivo neste dispositivo", stages: ["preparing", "queued", "authorizing"] },
  { title: "Encontrar GPU", description: "Alocar GPU e abrir a sessão", stages: ["runtime", "workspace", "gpu_ready"] },
  { title: "Enviar vídeo", description: "Transferir para a pasta confirmada", stages: ["uploading"] },
  { title: "Validar arquivo", description: "Conferir tamanho e integridade", stages: ["verifying", "video_ready"] },
  { title: "Preparar modelo", description: "Instalar DeepLabCut no Colab", stages: ["installing"] },
  { title: "Processar vídeo", description: "Rastrear o animal com SuperAnimal", stages: ["inference"] },
  { title: "Receber resultado", description: "Baixar poses para revisar no editor", stages: ["downloading", "completed"] },
] as const;

export type CheckpointState = "pending" | "active" | "done" | "failed";

export function stageIndex(stage: string) {
  return workflowSteps.findIndex((step) => (step.stages as readonly string[]).includes(stage));
}

export function checkpoints(job: ColabJob | null, preparing = false, localError = false) {
  const events = job?.events ?? [];
  const currentIndex = job ? stageIndex(job.stage) : 0;
  return workflowSteps.map((step, index) => {
    const stepEvents = events.filter((event) => stageIndex(event.stage) === index);
    const lastEvent = stepEvents.at(-1);
    let state: CheckpointState = "pending";
    if (!job) {
      if (index === 0 && preparing) state = "active";
      if (index === 0 && localError) state = "failed";
    } else if (job.status === "succeeded") state = "done";
    else if (index === currentIndex) {
      state = job.status === "failed" ? "failed" : "active";
      if (job.status !== "failed" && ["gpu_ready", "video_ready"].includes(job.stage)) state = "done";
    } else if (events.some((event) => stageIndex(event.stage) > index)) state = "done";
    return { ...step, state, event: lastEvent };
  });
}

export function gpuMessage(events: ColabJobEvent[]) {
  return events.find((event) => event.stage === "gpu_ready" && event.status !== "failed")?.message;
}
