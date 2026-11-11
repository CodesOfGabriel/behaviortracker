import type { ColabJob, ColabJobEvent } from "./analysis";

export const workflowSteps = [
  { title: "Preparando vídeo", description: "Leitura do arquivo e conferência dos frames", stages: ["preparing", "queued", "authorizing"] },
  { title: "Conectando à GPU", description: "Alocação da GPU para análise", stages: ["runtime", "workspace", "gpu_ready"] },
  { title: "Enviando vídeo", description: "Transferência do arquivo para o ambiente de análise", stages: ["uploading"] },
  { title: "Validando arquivo", description: "Conferência do tamanho e da integridade", stages: ["verifying", "video_ready"] },
  { title: "Preparando modelos", description: "Carregamento do detector Wistar e da HRNet na GPU", stages: ["environment_check", "installing", "environment_ready"] },
  { title: "Detectando animal", description: "Detector Wistar localiza o animal; HRNet-W32 estima 27 pontos anatômicos", stages: ["inference", "training"] },
  { title: "Preparando resultados", description: "Poses, trajetória e vídeo ficam disponíveis para revisão", stages: ["downloading", "rendering", "completed"] },
] as const;

export type CheckpointState = "pending" | "active" | "done" | "failed";

export function preparingNewAnalysis(starting: boolean, liveJob: ColabJob | null, history: ColabJob[]) {
  return starting && !liveJob && !history.some((job) => job.status === "running" || job.status === "queued");
}

export function displayAnalysisMessage(message: string) {
  return message.replace(/D\+F:\s*/g, "").replace(/\s+D\+F\b/g, "");
}

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
      if (job.status !== "failed" && ["gpu_ready", "video_ready", "environment_ready"].includes(job.stage)) state = "done";
    } else if (events.some((event) => stageIndex(event.stage) > index)) state = "done";
    return { ...step, state, event: lastEvent,
      ...(job?.diagnostic && index === 5 ? { title: "Testando detector e pose", description: "Medição das saídas no trecho curto" } : {}),
      ...(job?.diagnostic && index === 6 ? { title: "Preparando diagnóstico", description: "Relatório e pontos brutos disponíveis para revisão" } : {}),
      ...(job?.training && index === 0 ? { title: "Preparando exemplos", description: "Consolidação dos rótulos e imagens revisados" } : {}),
      ...(job?.training && index === 2 ? { title: "Enviando exemplos", description: "Transferência dos frames revisados" } : {}),
      ...(job?.training && index === 3 ? { title: "Validando dataset", description: "Conferência da integridade SHA-256" } : {}),
      ...(job?.training && index === 5 ? { title: "Treinando nova versão", description: "Ajuste do detector e dos pontos anatômicos" } : {}),
      ...(job?.training && index === 6 ? { title: "Preparando modelo", description: "Pesos e relatório salvos sem ativação" } : {}) };
  });
}

export function gpuMessage(events: ColabJobEvent[]) {
  return events.find((event) => event.stage === "gpu_ready" && event.status !== "failed")?.message;
}
