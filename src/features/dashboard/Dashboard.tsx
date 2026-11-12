import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileVideo,
  FlaskConical,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAppStore } from "../../store/AppStore";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { formatDate, formatDuration } from "../../lib/format";
import type { ExperimentStatus } from "../../types";

const statusLabels: Record<ExperimentStatus, string> = {
  draft: "Rascunho",
  processing: "Processando",
  review: "Resultado disponível",
  completed: "Concluído",
  blocked: "Bloqueado",
  failed: "Falhou",
};

const statusTone: Record<ExperimentStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  draft: "neutral",
  processing: "info",
  review: "warning",
  completed: "success",
  blocked: "danger",
  failed: "danger",
};

export function Dashboard() {
  const { experiments, navigate, openDemo, deleteExperiment } = useAppStore();
  const [pendingDeletion, setPendingDeletion] = useState<{ id: string; title: string } | null>(null);
  const available = experiments.filter((experiment) => experiment.status === "review").length;
  const completed = experiments.filter((experiment) => experiment.status === "completed").length;

  useEffect(() => {
    if (!pendingDeletion) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingDeletion(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingDeletion]);

  const confirmDeletion = () => {
    if (!pendingDeletion) return;
    deleteExperiment(pendingDeletion.id);
    setPendingDeletion(null);
  };

  return (
    <>
      <div className="page dashboard-page">
      <section className="page-heading dashboard-heading">
        <div>
          <div className="eyebrow">Laboratório local</div>
          <h1>Seus experimentos</h1>
          <p>Prepare e documente análises de campo aberto com rastreabilidade.</p>
        </div>
        <Button size="lg" icon={<Plus size={18} />} onClick={() => navigate({ name: "new-experiment" })}>
          Novo experimento
        </Button>
      </section>

      <section className="stats-grid" aria-label="Resumo dos experimentos">
        <article className="stat-card">
          <div className="stat-icon stat-icon-green"><FlaskConical size={20} /></div>
          <div><span>Experimentos locais</span><strong>{experiments.length}</strong></div>
          <small>neste dispositivo</small>
        </article>
        <article className="stat-card">
          <div className="stat-icon stat-icon-amber"><Clock3 size={20} /></div>
          <div><span>Resultados disponíveis</span><strong>{available}</strong></div>
          <small>{available ? "abra a Análise Completa" : "nenhum resultado"}</small>
        </article>
        <article className="stat-card">
          <div className="stat-icon stat-icon-blue"><CheckCircle2 size={20} /></div>
          <div><span>Análises concluídas</span><strong>{completed}</strong></div>
          <small>neste dispositivo</small>
        </article>
      </section>

      <div className="dashboard-grid">
        <section className="panel recent-panel">
          <div className="panel-header">
            <div><h2>Experimentos recentes</h2><p>Arquivos persistidos localmente neste navegador.</p></div>
            {experiments.length > 0 && <button className="text-button">Ver todos <ArrowRight size={14} /></button>}
          </div>
          {experiments.length === 0 ? (
            <div className="empty-experiments">
              <div className="empty-illustration">
                <div className="arena-mini"><span /><span /><span /><span /><i /></div>
              </div>
              <h3>Comece pelo primeiro experimento</h3>
              <p>Importe um vídeo, marque o piso da arena e salve uma calibração reproduzível.</p>
              <div className="empty-actions">
                <Button icon={<Plus size={17} />} onClick={() => navigate({ name: "new-experiment" })}>Criar experimento</Button>
                <Button variant="secondary" icon={<Sparkles size={17} />} onClick={openDemo}>Explorar demonstração</Button>
              </div>
            </div>
          ) : (
            <div className="experiment-list">
              {experiments.slice(0, 6).map((experiment) => (
                <article
                  key={experiment.id}
                  className="experiment-row"
                  onClick={() => navigate({ name: "results", experimentId: experiment.id })}
                >
                  <div className={`experiment-thumb${experiment.calibrationThumbnailDataUrl ? " has-image" : ""}`}>
                    {experiment.calibrationThumbnailDataUrl
                      ? <img src={experiment.calibrationThumbnailDataUrl} alt={`Frame de calibração de ${experiment.title}`} />
                      : <><FileVideo size={20} /><span>Sem prévia</span></>}
                  </div>
                  <div className="experiment-main">
                    <div className="experiment-title-row">
                      <h3>{experiment.title}</h3>
                      <Badge tone={statusTone[experiment.status]} dot>{statusLabels[experiment.status]}</Badge>
                    </div>
                    <p>{experiment.subjectId}{experiment.group ? ` · ${experiment.group}` : ""}</p>
                    <div className="experiment-meta">
                      <span>{formatDate(experiment.updatedAt)}</span>
                      <span>{formatDuration(experiment.video.durationSec)} de vídeo</span>
                      <span>{experiment.video.width} × {experiment.video.height}</span>
                    </div>
                  </div>
                  <button
                    className="icon-button"
                    title="Excluir experimento"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPendingDeletion({ id: experiment.id, title: experiment.title });
                    }}
                  ><Trash2 size={17} /></button>
                  <ChevronRight size={18} className="row-chevron" />
                </article>
              ))}
              <button className="demo-strip" onClick={openDemo}>
                <Sparkles size={17} /> Abrir outro conjunto sintético de demonstração
              </button>
            </div>
          )}
        </section>

        <aside className="dashboard-side">
          <section className="panel workflow-card">
            <div className="panel-header compact"><div><h2>Fluxo recomendado</h2><p>Do vídeo ao resultado auditável.</p></div></div>
            <ol className="workflow-list">
              {[
                ["01", "Configure", "Vídeo, sujeito e protocolo"],
                ["02", "Calibre", "Quatro vértices e dimensões"],
                ["03", "Analise", "Tracking e métricas"],
                ["04", "Exporte", "Métricas e proveniência"],
              ].map(([number, title, description]) => (
                <li key={number}><span>{number}</span><div><strong>{title}</strong><small>{description}</small></div></li>
              ))}
            </ol>
          </section>
          <section className="integrity-card">
            <div className="integrity-icon"><ShieldCheck size={22} /></div>
            <div><h3>Dados sob seu controle</h3><p>Nenhum vídeo é enviado sem uma ação explícita. Correções não alteram o tracking bruto.</p></div>
          </section>
        </aside>
      </div>
      </div>
      {pendingDeletion && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPendingDeletion(null);
          }}
        >
          <section
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-experiment-title"
            aria-describedby="delete-experiment-description"
          >
            <div className="confirm-modal-icon"><Trash2 size={20} /></div>
            <div>
              <h2 id="delete-experiment-title">Excluir experimento?</h2>
              <p id="delete-experiment-description">
                Tem certeza que deseja excluir <strong>{pendingDeletion.title}</strong>? O experimento será removido da lista local. Arquivos de análise e registros associados ainda podem permanecer no dispositivo.
              </p>
            </div>
            <div className="confirm-modal-actions">
              <Button variant="secondary" onClick={() => setPendingDeletion(null)}>Cancelar</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={confirmDeletion}>Excluir experimento</Button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
