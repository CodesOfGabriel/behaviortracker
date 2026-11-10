import type { ColabJob, ColabJobEvent } from "./analysis";

export const workflowSteps = [
  { title: "Preparar vídeo", description: "Ler o arquivo neste dispositivo", stages: ["preparing", "queued", "authorizing"] },
  { title: "Encontrar GPU", description: "Alocar GPU e abrir a sessão", stages: ["runtime", "workspace", "gpu_ready"] },
  { title: "Enviar vídeo", description: "Transferir para a pasta confirmada", stages: ["uploading"] },
  { title: "Validar arquivo", description: "Conferir tamanho e integridade", stages: ["verifying", "video_ready"] },
  { title: "Preparar modelo", description: "Verificar e reutilizar DeepLabCut", stages: ["environment_check", "installing", "environment_ready"] },
  { title: "Adaptar e processar", description: "Executar o Teste B do SuperAnimal e importar a pose adaptada", stages: ["inference", "training"] },
  { title: "Receber resultado", description: "Baixar poses e gerar vídeo de revisão", stages: ["downloading", "rendering", "completed"] },
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
      if (job.status !== "failed" && ["gpu_ready", "video_ready", "environment_ready"].includes(job.stage)) state = "done";
    } else if (events.some((event) => stageIndex(event.stage) > index)) state = "done";
    return { ...step, state, event: lastEvent,
      ...(job?.diagnostic && index === 5 ? { title: "Testar detector e pose", description: "Medir saídas no trecho curto" } : {}),
      ...(job?.diagnostic && index === 6 ? { title: "Receber diagnóstico", description: "Baixar relatório e pontos brutos" } : {}),
      ...(job?.training && index === 0 ? { title: "Preparar exemplos", description: "Congelar rótulos e imagens revisados" } : {}),
      ...(job?.training && index === 2 ? { title: "Enviar exemplos", description: "Transferir somente os frames revisados" } : {}),
      ...(job?.training && index === 3 ? { title: "Validar dataset", description: "Conferir integridade SHA-256" } : {}),
      ...(job?.training && index === 5 ? { title: "Treinar nova versão", description: "Ajustar detector e partes do animal" } : {}),
      ...(job?.training && index === 6 ? { title: "Receber modelo", description: "Salvar pesos e relatório sem ativar" } : {}) };
  });
}

export function gpuMessage(events: ColabJobEvent[]) {
  return events.find((event) => event.stage === "gpu_ready" && event.status !== "failed")?.message;
}
