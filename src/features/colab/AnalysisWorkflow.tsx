import { ArrowRight, Check, CircleAlert, CloudDownload, Cpu, FileVideo, LoaderCircle, ScanSearch, ShieldCheck, UploadCloud, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatDuration } from "../../lib/format";
import type { ColabJob } from "./analysis";
import { loadColabLog } from "./analysis";
import { checkpoints, gpuMessage } from "./workflow";

const icons = [FileVideo, Cpu, UploadCloud, ShieldCheck, WandSparkles, ScanSearch, CloudDownload];

export function AnalysisWorkflow({ job, preparing, message, localError, elapsedSec }: {
  job: ColabJob | null;
  preparing: boolean;
  message: string;
  localError: string | null;
  elapsedSec: number;
}) {
  const steps = checkpoints(job, preparing, Boolean(!job && localError));
  const events = job?.events ?? [];
  const progress = job?.status === "succeeded" ? 100 : Math.min(100, Math.max(0, job?.progress ?? 0, ...events.map((event) => event.progress)));
  const compactEvents = events.filter((event) => event.status === "failed" || !/\d+(?:[.,]\d+)?\s*%/.test(event.message));
  const failed = job?.status === "failed" || (!job && localError);
  const active = preparing || job?.status === "running" || job?.status === "queued";
  const gpu = gpuMessage(events);
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
  }, [job?.jobId, job?.stage, job?.status, preparing, localError]);
  return (
    <section className="analysis-workflow" aria-label="Etapas do processamento">
      <div className="workflow-heading">
        <div><span className="eyebrow">Do vídeo ao rastreamento</span><h3>{failed ? "Execução interrompida" : job?.status === "succeeded" ? "Resultado pronto" : active ? "Análise em andamento" : "Tudo pronto para começar"}</h3></div>
        {(job || preparing) && <span className="workflow-duration">{formatDuration(elapsedSec)} de execução</span>}
      </div>
      <div ref={flowRef} className="workflow-scroll" tabIndex={0} aria-label="Fluxograma horizontal; deslize para ver todas as etapas">
        <ol className="workflow-checkpoints">
          {steps.map((step, index) => {
            const Icon = icons[index];
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
      </div>
      {job && <div className="workflow-technical">
        <button type="button" className="button button-ghost" onClick={showTechnicalLog} disabled={loadingLog}>
          {loadingLog ? "Carregando log…" : technicalLog === null ? "Ver log técnico" : "Atualizar log técnico"}
        </button>
        {technicalLog !== null && <details open className="workflow-log"><summary>Saída técnica do runtime</summary><pre>{technicalLog}</pre></details>}
      </div>}
      <div className={`workflow-current ${failed ? "workflow-current-error" : ""}`} role="status" aria-live="polite">
        {failed ? <CircleAlert size={17} /> : active ? <LoaderCircle size={17} className="animate-spin" /> : <ScanSearch size={17} />}
        <span>{job?.error || localError || (job?.message && !/\d+(?:[.,]\d+)?\s*%/.test(job.message) ? job.message : "Análise em andamento") || message || "As etapas serão atualizadas durante a análise."}</span>
      </div>
      {job ? (
        <details className="workflow-log" open>
          <summary>Diário da execução</summary>
          <div className="workflow-progress" role="progressbar" aria-label="Progresso da análise" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>
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
