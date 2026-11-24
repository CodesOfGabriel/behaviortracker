import { ArrowRight, Check, CircleAlert, Clock3, CloudDownload, Cpu, FileVideo, LoaderCircle, ScanSearch, ShieldCheck, UploadCloud, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatElapsedClock } from "../../lib/format";
import type { LocalVideoProgress } from "../../store/AppStore";
import type { ColabJob } from "./analysis";
import { loadColabLog } from "./analysis";
import type { LocalJob } from "../local/api";
import { checkpoints, diaryEvents, displayAnalysisMessage, gpuMessage, localCheckpoints, reportedFrameProgress, stageIndex, type WorkflowProtocol } from "./workflow";

const icons = [FileVideo, Cpu, UploadCloud, ShieldCheck, WandSparkles, ScanSearch, CloudDownload];
const localIcons = [FileVideo, Cpu, WandSparkles, ScanSearch, CloudDownload];

export function AnalysisWorkflow({ job, preparing, message, localError, elapsedSec, startedAt, localProgress,
  protocol: requestedProtocol = "open_field", logOnly = false, engine = "colab", localJob = null, controls }: {
  job: ColabJob | null;
  preparing: boolean;
  message: string;
  localError: string | null;
  elapsedSec: number;
  startedAt?: number | null;
  localProgress?: LocalVideoProgress | null;
  protocol?: WorkflowProtocol;
  logOnly?: boolean;
  engine?: "colab" | "opencv";
  localJob?: LocalJob | null;
  controls?: ReactNode;
}) {
  const protocol = job?.protocol ?? requestedProtocol;
  const isLocal = engine === "opencv";
  const succeeded = job?.status === "succeeded" || localJob?.state === "succeeded";
  const cancelled = localJob?.state === "cancelled";
  const failed = job?.status === "failed" || localJob?.state === "failed" || cancelled || Boolean(!job && localError);
  const active = preparing || job?.status === "running" || job?.status === "queued"
    || localJob?.state === "running" || localJob?.state === "queued";
  const steps = isLocal ? localCheckpoints(localJob, preparing, failed, protocol)
    : checkpoints(job, preparing, Boolean(!job && localError), protocol);
  const events = job?.events ?? [];
  const progress = job?.status === "succeeded" ? 100 : Math.min(100, Math.max(0, job?.progress ?? 0, ...events.map((event) => event.progress)));
  const processed = localJob?.report.framesProcessed;
  const total = localJob?.report.totalFrames;
  const renderingLocalVideo = localJob?.report.phase === "rendering";
  const framePercent = !renderingLocalVideo && processed != null && total != null && total > 0 ? Math.min(100, 100 * processed / total) : null;
  const shownProgress = succeeded ? 100 : job ? Math.round(progress) : localJob ? framePercent == null ? null : Math.round(framePercent)
    : localProgress?.percent ?? null;
  const progressLabel = localJob && framePercent != null && !succeeded ? "Frames analisados"
    : !job && localProgress?.phase === "staging" ? "Cópia local do vídeo"
    : !job && localProgress ? "Preparação do vídeo" : "Progresso da análise";
  const compactEvents = diaryEvents(events, protocol);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const startedJob = job ?? localJob;
  const startTime = Math.min(startedAt ?? Infinity, startedJob ? Date.parse(startedJob.createdAt) : Infinity);
  const duration = active && Number.isFinite(startTime)
    ? Math.max(0, (now - startTime) / 1_000) : elapsedSec;
  const frameProgress = reportedFrameProgress(job, protocol);
  const gpu = gpuMessage(events);
  const localStep = steps.find(step => step.state === "active");
  const localStatus = localJob && localStep && !renderingLocalVideo && processed != null
    ? `${localStep.title} · ${processed.toLocaleString("pt-BR")}${total ? ` / ${total.toLocaleString("pt-BR")}` : ""} frames`
    : localStep?.title;
  const flowRef = useRef<HTMLDivElement>(null);
  const [technicalLog, setTechnicalLog] = useState<string | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const selectedJob = useRef(job?.jobId);
  selectedJob.current = job?.jobId;
  useEffect(() => { setTechnicalLog(null); setLoadingLog(false); }, [job?.jobId]);
  const showTechnicalLog = async () => {
    if (!job) return;
    const jobId = job.jobId;
    setLoadingLog(true);
    try {
      const log = await loadColabLog(jobId);
      if (selectedJob.current === jobId) setTechnicalLog(log);
    } catch (error) {
      if (selectedJob.current === jobId) setTechnicalLog(String(error));
    } finally {
      if (selectedJob.current === jobId) setLoadingLog(false);
    }
  };
  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const focusCheckpoint = () => {
      const current = flow.querySelector<HTMLElement>(".checkpoint-active, .checkpoint-failed");
      if (!current) return;
      flow.scrollTo({ left: Math.max(0, current.offsetLeft - (flow.clientWidth - current.clientWidth) / 2),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    };
    focusCheckpoint();
    const observer = new ResizeObserver(focusCheckpoint);
    observer.observe(flow);
    return () => observer.disconnect();
  }, [engine, job?.jobId, job?.stage, job?.status, localJob?.jobId, localJob?.state, localJob?.report.phase, preparing, localError]);
  return (
    <section className="analysis-workflow" aria-label={logOnly ? "Diário da execução" : "Etapas do processamento"}>
      <div className="workflow-heading">
        <div className="workflow-heading-copy">
          <span className={`workflow-status ${failed ? "workflow-status-failed" : active ? "workflow-status-active" : "workflow-status-complete"}`}>
            <span className="workflow-status-dot" />{cancelled ? "Cancelada" : failed ? "Interrompida" : active ? "Em execução" : succeeded ? "Concluída" : "Aguardando"}
          </span>
          <h3>{failed ? "Execução interrompida" : succeeded ? "Resultado pronto" : active ? "Análise em andamento" : "Tudo pronto para começar"}</h3>
          <p>{active ? "A análise continua em segundo plano enquanto você navega pelo aplicativo." : failed ? "Veja abaixo em que etapa a execução parou." : succeeded ? "Os resultados estão disponíveis para revisão." : "Acompanhe aqui as etapas do processamento."}</p>
        </div>
        {(job || active) && <div className="workflow-duration">
          <div className="workflow-duration-label"><Clock3 size={15} /><span>Tempo de execução</span></div>
          <time aria-label={`Tempo de execução: ${formatElapsedClock(duration)}`}>{formatElapsedClock(duration)}</time>
        </div>}
      </div>
      {controls}
      {(job || active || (localJob && shownProgress != null)) && <div className="workflow-progress-overview">
        <div className="workflow-progress-label"><span>{progressLabel}</span><strong>{shownProgress == null ? active ? "Em andamento" : "—" : `${shownProgress}%`}</strong></div>
        <div className={`workflow-progress ${shownProgress == null && active ? "workflow-progress-indeterminate" : ""}`} role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shownProgress ?? undefined}>
          <span style={shownProgress == null ? undefined : { width: `${shownProgress}%` }} />
        </div>
        {!job && localProgress?.phase === "encoding" && localProgress.remainingSec != null &&
          <p className="workflow-progress-eta">Conversão: tempo restante estimado de {formatElapsedClock(localProgress.remainingSec)}</p>}
      </div>}
      {frameProgress && <div className="workflow-frames" aria-label={`Frames reportados pelo Colab para ${frameProgress.scope}`}>
        <div><span>Frames analisados · {frameProgress.scope}</span><strong>{frameProgress.processed.toLocaleString("pt-BR")} <small>/ {frameProgress.total.toLocaleString("pt-BR")}</small></strong></div>
        <div><span>Restantes nesta etapa</span><strong>{frameProgress.remaining.toLocaleString("pt-BR")}</strong></div>
        <p>Contagem informada pelo Colab para esta etapa.</p>
      </div>}
      {!logOnly && <div ref={flowRef} className="workflow-scroll" tabIndex={0} aria-label="Fluxograma horizontal; deslize para ver todas as etapas">
        <ol className={`workflow-checkpoints${isLocal ? " workflow-checkpoints-local"
          : protocol === "forced_swim" ? " workflow-checkpoints-fst" : ""}`}>
          {steps.map((step, index) => {
            const Icon = (isLocal ? localIcons : icons)[index] ?? CloudDownload;
            const description = index === 1 && gpu ? gpu : step.description;
            return (
              <li key={step.title} className={`checkpoint checkpoint-${step.state}`} aria-current={step.state === "active" ? "step" : undefined}>
                <div className="checkpoint-path"><span className="checkpoint-icon">{step.state === "done" ? <Check size={20} /> : step.state === "failed" ? <CircleAlert size={20} /> : step.state === "active" ? <LoaderCircle size={20} className="animate-spin" /> : <Icon size={20} />}</span>{index < steps.length - 1 && <ArrowRight size={15} className="checkpoint-arrow" />}</div>
                <span className="checkpoint-number">Etapa {index + 1}</span>
                <strong>{step.title}</strong>
                <p>{description}</p>
                <small>{step.state === "done" ? "Concluído" : step.state === "failed" ? "Falhou nesta etapa" : step.state === "active" ? "Em andamento" : "Aguardando"}</small>
              </li>
            );
          })}
        </ol>
      </div>}
      {job && <div className="workflow-technical">
        <button type="button" className="button button-ghost" onClick={showTechnicalLog} disabled={loadingLog}>
          {loadingLog ? "Carregando log…" : technicalLog === null ? "Ver log técnico" : "Atualizar log técnico"}
        </button>
        {technicalLog !== null && <details open className="workflow-log"><summary>Saída técnica do runtime</summary><pre>{technicalLog}</pre></details>}
      </div>}
      <div className={`workflow-current ${failed ? "workflow-current-error" : ""}`} role="status" aria-live="polite">
        {failed ? <CircleAlert size={17} /> : active ? <LoaderCircle size={17} className="animate-spin" /> : <ScanSearch size={17} />}
        <span>{failed ? displayAnalysisMessage(job?.error || localJob?.error || localError || (cancelled ? "A análise foi cancelada." : "A execução foi interrompida."))
          : isLocal && localJob ? localStatus ?? (succeeded ? "Resultados locais prontos para revisão." : localJob.state === "queued" ? "Aguardando a execução local." : "Análise em andamento")
          : job ? (steps[stageIndex(job.stage, protocol)]?.title || "Análise em andamento")
          : displayAnalysisMessage(message || "As etapas serão atualizadas durante a análise.")}</span>
      </div>
      {job ? (
        <details className="workflow-log" open>
          <summary>Diário da execução</summary>
          {compactEvents.length > 0 && <ol aria-label="Eventos da análise">
            {[...compactEvents].reverse().map((event) => (
              <li key={event.id} className={event.status === "failed" ? "log-failed" : ""}>
                <time>{new Date(event.createdAt).toLocaleTimeString("pt-BR")}</time>
                <span className="log-dot" />
                <span>{event.message}</span>
              </li>
            ))}
          </ol>}
        </details>
      ) : null}
    </section>
  );
}
