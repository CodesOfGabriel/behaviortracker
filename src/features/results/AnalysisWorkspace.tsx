import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { useAppStore } from "../../store/AppStore";
import { AnalysisWorkflow } from "../colab/AnalysisWorkflow";
import type { ColabJob } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import type { WorkflowProtocol } from "../colab/workflow";
import type { LocalJob } from "../local/api";
import type { ResultPanels } from "./ResultTabs";

type Engine = "colab" | "opencv";

export type LocalAnalysisControls = {
  run: () => void;
  busy: boolean;
  ready: boolean;
  job: LocalJob | null;
  panel: ReactNode;
  resultPanels?: ResultPanels;
};

export type ColabAnalysisControls = {
  run: () => void;
  connected: boolean;
  job: ColabJob | null;
  error?: string | null;
  panel?: ReactNode;
  resultPanels?: ResultPanels;
};

export function AnalysisWorkspace({ experimentId, protocol, defaultEngine, local, colab, disabled = false }: {
  experimentId: string;
  protocol: WorkflowProtocol;
  defaultEngine: Engine;
  local: LocalAnalysisControls;
  colab: ColabAnalysisControls;
  disabled?: boolean;
}) {
  const { analysisActivity, navigate } = useAppStore();
  const activity = analysisActivity[experimentId];
  const [selection, setSelection] = useState<Engine>(defaultEngine);
  const localRunning = local.job?.state === "running" || local.job?.state === "queued";
  const colabRunning = colab.job?.status === "running" || colab.job?.status === "queued";
  const runningEngine = activity?.starting ? activity.engine
    : localRunning ? "opencv" : colabRunning ? "colab" : undefined;
  const engine = runningEngine ?? selection;
  const isLocal = engine === "opencv";
  const busy = local.busy || colabRunning || Boolean(activity?.starting);
  const currentActivity = activity?.engine === engine ? activity : undefined;
  const preparing = Boolean(currentActivity?.starting);
  const candidate = isLocal ? local.job : colab.job;
  const currentJob = isLocal ? localRunning : colabRunning;
  const attemptInProgress = preparing || Boolean(currentActivity?.error);
  const showingPreviousJob = attemptInProgress && !currentJob && candidate != null && currentActivity?.startedAt != null
    && Date.parse(candidate.createdAt) < currentActivity.startedAt;
  const localJob = isLocal && !showingPreviousJob ? local.job : null;
  const colabJob = !isLocal && !showingPreviousJob ? colab.job : null;
  const failure = currentActivity?.error ?? (!isLocal ? colab.error : null) ?? null;
  const desktop = isTauriRuntime();
  const elapsedSec = colabJob ? Math.max(0, (Date.parse(colabJob.updatedAt) - Date.parse(colabJob.createdAt)) / 1000) : localJob?.report.elapsedSec ?? 0;

  useEffect(() => setSelection(defaultEngine), [defaultEngine]);
  useEffect(() => { if (runningEngine) setSelection(runningEngine); }, [runningEngine]);

  const controls = <div className="analysis-controls">
    <label className="analysis-engine-switch">
      <span className="analysis-engine-option" data-selected={!isLocal}>Google Colab</span>
      <input className="sr-only" type="checkbox" role="switch" aria-label="Usar máquina local em vez do Google Colab"
        checked={isLocal} disabled={busy} onChange={event => setSelection(event.target.checked ? "opencv" : "colab")} />
      <span className="analysis-engine-track" aria-hidden="true" />
      <span className="analysis-engine-option" data-selected={isLocal}>Máquina local</span>
    </label>
    <Button type="button" disabled={disabled || !desktop || busy || (isLocal ? !local.ready : !colab.connected)}
      onClick={event => {
        // WebKit on macOS does not focus buttons on pointer clicks. Give the
        // native dialog a focused opener to restore when Cancel/Escape closes it.
        event.currentTarget.focus();
        if (isLocal) local.run(); else colab.run();
      }}>Analisar</Button>
    {!isLocal && !colab.connected && desktop &&
      <Button type="button" variant="secondary" onClick={() => navigate({ name: "colab" })}>Conectar Colab</Button>}
    {!desktop && <span className="analysis-controls-note">A análise está disponível no aplicativo desktop.</span>}
    <details className="analysis-settings">
      <summary>Configuração e histórico de execuções</summary>
      <div hidden={!isLocal}>{local.panel}</div>
      {colab.panel && <div hidden={isLocal}>{colab.panel}</div>}
    </details>
  </div>;

  return <>
    <AnalysisWorkflow protocol={protocol} engine={engine} job={colabJob} localJob={localJob} controls={controls}
      preparing={preparing && !colabJob && !localJob} message={preparing || failure ? currentActivity?.message ?? "" : ""}
      localError={failure} elapsedSec={elapsedSec}
      startedAt={currentActivity?.startedAt} localProgress={currentActivity?.videoProgress} />
  </>;
}
