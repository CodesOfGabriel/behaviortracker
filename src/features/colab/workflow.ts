import type { ColabJob, ColabJobEvent } from "./analysis";
import type { LocalJob } from "../local/api";

export type WorkflowProtocol = NonNullable<ColabJob["protocol"]>;

export const workflowSteps = [
  { title: "Preparando vídeo", description: "Leitura do arquivo e conferência dos frames", stages: ["preparing", "queued", "authorizing"] },
  { title: "Conectando à GPU", description: "Alocação da GPU para análise", stages: ["runtime", "workspace", "gpu_ready"] },
  { title: "Enviando vídeo", description: "Transferência do arquivo para o ambiente de análise", stages: ["uploading"] },
  { title: "Validando arquivo", description: "Conferência do tamanho e da integridade", stages: ["verifying", "video_ready"] },
  { title: "Preparando modelos", description: "Carregamento do detector Wistar e da HRNet na GPU", stages: ["environment_check", "installing", "environment_ready"] },
  { title: "Detectando animal", description: "Detector Wistar localiza o animal; HRNet-W32 estima 27 pontos anatômicos", stages: ["inference", "training"] },
  { title: "Preparando resultados", description: "Poses, trajetória e vídeo ficam disponíveis para revisão", stages: ["downloading", "rendering", "completed"] },
] as const;

export const fstWorkflowSteps = [
  { title: "Preparando vídeo", description: "Arquivo original e metadados", stages: ["preparing", "queued", "authorizing"] },
  { title: "Conectando à GPU", description: "Runtime CUDA para HRNet-w32", stages: ["runtime", "workspace", "gpu_ready"] },
  { title: "Enviando vídeo", description: "Transferência ao Colab", stages: ["uploading"] },
  { title: "Validando vídeo", description: "Tamanho e SHA-256", stages: ["verifying", "video_ready"] },
  { title: "Validando cilindros e modelo", description: "ROIs fixas e SuperAnimal Quadruped", stages: ["environment_check", "installing", "environment_ready", "validating_tanks"] },
  { title: "Localizando o corpo", description: "Presença e caixas visuais por cilindro", stages: ["presence"] },
  { title: "Inferindo 39 pontos", description: "HRNet-w32 usa a caixa corporal; frames sem caixa ficam sem pose", stages: ["inference"] },
  { title: "Calculando indicadores", description: "Movimento e qualidade por animal", stages: ["indicators"] },
  { title: "Renderizando vídeo", description: "Caixas dinâmicas e pontos visíveis só com presença", stages: ["rendering"] },
  { title: "Recebendo resultados", description: "Dados, MP4 e manifesto FST", stages: ["downloading", "completed"] },
] as const;

export type CheckpointState = "pending" | "active" | "done" | "failed";

const ramWorkflowSteps = workflowSteps.map((step, index) => {
  if (index === 5) return { ...step, description: "Detector Wistar e HRNet acompanham o animal dentro da área marcada" };
  if (index === 6) return { ...step, description: "Centros observados e arquivos ficam disponíveis para revisão" };
  return step;
});

const colabSteps = { open_field: workflowSteps, forced_swim: fstWorkflowSteps, radial_arm_maze: ramWorkflowSteps };

export function localCheckpoints(job: LocalJob | null, preparing: boolean, failed: boolean, protocol: WorkflowProtocol) {
  const wistar = job?.config.strategy === "wistar_hrnet" || (!job && protocol === "open_field");
  const steps = wistar ? [
    { title: "Preparando vídeo", description: "Reutilização da cópia de análise do projeto" },
    { title: "Preparando modelos", description: "Configuração do ambiente Wistar e HRNet" },
    { title: "Detectando animal", description: "Detector Wistar na área calibrada" },
    { title: "Estimando pose", description: "HRNet estima 27 pontos anatômicos" },
    { title: "Preparando resultados", description: "Verificação das poses e vídeo anotado para auditoria" },
  ] : [
    { title: "Preparando vídeo", description: "Leitura do arquivo e preparação da cópia local" },
    { title: "Preparando OpenCV", description: "Inicialização do processamento no computador" },
    { title: "Preparando detecção", description: protocol === "forced_swim" ? "Montagem da referência visual dos cilindros" : "Reconhecimento do animal na área analisável" },
    { title: protocol === "forced_swim" ? "Detectando presença" : "Detectando animal", description: "Processamento dos frames no computador" },
    { title: "Renderizando vídeo", description: "MP4 com as observações da execução para auditoria" },
  ];
  const phase = job?.report.phase;
  const wistarStages: Record<string, number> = { tracking: 2, pose: 3, quality: 4, rendering: 4, complete: 4 };
  const isFinal = phase === "rendering" || phase === "complete";
  const current = !job ? 0 : wistar ? wistarStages[phase ?? ""] ?? 1
    : isFinal ? 4 : phase === "reference" || phase === "recognition" ? 2
      : phase || job.report.framesProcessed != null ? 3 : 1;
  return steps.map((step, index) => {
    let state: CheckpointState = "pending";
    if (job?.state === "succeeded" || index < current) state = "done";
    else if (index === current && failed) state = "failed";
    else if (index === current && (job || preparing)) state = "active";
    return { ...step, state };
  });
}

export function preparingNewAnalysis(starting: boolean, liveJob: ColabJob | null, history: ColabJob[]) {
  return starting && !liveJob && !history.some((job) => job.status === "running" || job.status === "queued");
}

export function displayAnalysisMessage(message: string) {
  return message.replace(/\bD\+F\b\s*:?\s*/gi, "")
    .replace(/\b\d+(?:[.,]\d+)?\s*%(?:\s*[-–]\s*\d+(?:[.,]\d+)?\s*%)*/g, "")
    .replace(/\s*[·:]\s*$/g, "").replace(/\s{2,}/g, " ").trim();
}

export function reportedFrameProgress(job: ColabJob | null, protocol: WorkflowProtocol) {
  if (!job || job.status !== "running" || job.stage !== "inference") return null;
  const match = protocol === "forced_swim"
    ? /FST_FRAMES=([A-Za-z0-9_]+):(\d+)\/(\d+)/.exec(job.message)
    : /Recuperação visual: (\d+)\/(\d+) frames verificados/.exec(job.message)
      ?? /Detector Wistar · (\d+)\/(\d+)(?=\s|$)/.exec(job.message);
  if (!match) return null;
  const currentText = protocol === "forced_swim" ? match[2] : match[1];
  const totalText = protocol === "forced_swim" ? match[3] : match[2];
  const processed = Number(currentText);
  const total = Number(totalText);
  if (!Number.isSafeInteger(processed) || !Number.isSafeInteger(total) || total <= 0 || processed < 0 || processed > total) return null;
  let scope = job.message.includes("Recuperação visual:") ? "Recuperação visual" : "Detecção";
  if (protocol === "forced_swim") {
    const animal = /^animal_(\d+)$/.exec(match[1]);
    scope = animal ? `Animal ${animal[1]}` : match[1];
  }
  return { processed, total, remaining: total - processed, scope };
}

export function diaryEvents(events: ColabJobEvent[], protocol: WorkflowProtocol) {
  const steps = colabSteps[protocol];
  const entries: { id: number; createdAt: string; status: ColabJobEvent["status"]; message: string }[] = [];
  const seen = new Set<number>();
  for (const event of events) {
    const index = stageIndex(event.stage, protocol);
    if (index < 0) {
      if (event.status === "failed") entries.push({ id: event.id, createdAt: event.createdAt, status: event.status,
        message: `Execução interrompida: ${displayAnalysisMessage(event.message) || "consulte o log técnico"}` });
      continue;
    }
    if (event.status === "failed") {
      entries.push({ id: event.id, createdAt: event.createdAt, status: event.status,
        message: `Falha em ${steps[index].title.toLowerCase()}: ${displayAnalysisMessage(event.message) || "consulte o log técnico"}` });
    } else if (!seen.has(index)) {
      seen.add(index);
      entries.push({ id: event.id, createdAt: event.createdAt, status: event.status,
        message: `${steps[index].title}${event.status === "succeeded" ? " concluído" : " em andamento"}` });
    }
  }
  return entries;
}

export function stageIndex(stage: string, protocol: WorkflowProtocol = "open_field") {
  return colabSteps[protocol].findIndex((step) => (step.stages as readonly string[]).includes(stage));
}

export function checkpoints(job: ColabJob | null, preparing = false, localError = false, protocol: WorkflowProtocol = "open_field") {
  const steps = colabSteps[protocol];
  const events = job?.events ?? [];
  const currentIndex = job ? stageIndex(job.stage, protocol) : 0;
  return steps.map((step, index) => {
    const stepEvents = events.filter((event) => stageIndex(event.stage, protocol) === index);
    const lastEvent = stepEvents.at(-1);
    let state: CheckpointState = "pending";
    if (!job) {
      if (index === 0 && preparing) state = "active";
      if (index === 0 && localError) state = "failed";
    } else if (job.status === "succeeded") state = "done";
    else if (index === currentIndex) {
      state = job.status === "failed" ? "failed" : "active";
      if (job.status !== "failed" && ["gpu_ready", "video_ready", "environment_ready"].includes(job.stage)) state = "done";
    } else if (events.some((event) => stageIndex(event.stage, protocol) > index)) state = "done";
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
