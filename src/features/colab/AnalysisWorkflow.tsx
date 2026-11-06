import { ArrowRight, Check, CircleAlert, CloudDownload, Cpu, FileVideo, LoaderCircle, ScanSearch, ShieldCheck, UploadCloud, WandSparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatDuration } from "../../lib/format";
import type { ColabJob } from "./analysis";
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
  const failed = job?.status === "failed" || (!job && localError);
  const active = preparing || job?.status === "running" || job?.status === "queued";
  const gpu = gpuMessage(events);
  const flowRef = useRef<HTMLDivElement>(null);
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
            return (
              <li key={step.title} className={`checkpoint checkpoint-${step.state}`} aria-current={step.state === "active" ? "step" : undefined}>
                <div className="checkpoint-path"><span className="checkpoint-icon">{step.state === "done" ? <Check size={20} /> : step.state === "failed" ? <CircleAlert size={20} /> : step.state === "active" ? <LoaderCircle size={20} className="animate-spin" /> : <Icon size={20} />}</span>{index < steps.length - 1 && <ArrowRight size={15} className="checkpoint-arrow" />}</div>
                <span className="checkpoint-number">Etapa {index + 1}</span>
                <strong>{step.title}</strong>
                <p>{index === 1 && gpu ? gpu : step.description}</p>
                <small>{step.state === "done" ? "Concluído" : step.state === "failed" ? "Falhou nesta etapa" : step.state === "active" ? "Em andamento" : "Aguardando"}</small>
              </li>
            );
          })}
        </ol>
      </div>
      <div className={`workflow-current ${failed ? "workflow-current-error" : ""}`} role="status" aria-live="polite">
        {failed ? <CircleAlert size={17} /> : active ? <LoaderCircle size={17} className="animate-spin" /> : <ScanSearch size={17} />}
        <span>{job?.error || localError || job?.message || message || "Ao iniciar, cada checkpoint será atualizado com as confirmações do Colab."}</span>
      </div>
      {events.length > 0 ? (
        <details className="workflow-log" open>
          <summary>Diário da execução <span>{events.length} eventos registrados</span></summary>
          <ol aria-label="Eventos reais da análise">
            {[...events].reverse().map((event) => (
              <li key={event.id} className={event.status === "failed" ? "log-failed" : ""}>
                <time>{new Date(event.createdAt).toLocaleTimeString("pt-BR")}</time>
                <span className="log-dot" />
                <span>{event.message}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : job && <p className="workflow-legacy-note">Esta execução foi criada antes do registro de checkpoints. Os detalhes aparecerão nas próximas análises.</p>}
    </section>
  );
}
