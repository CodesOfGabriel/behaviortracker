import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Cpu, Info } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { useAppStore } from "../../store/AppStore";
import type { OpenFieldExperiment, TrackingSelection } from "../../types";
import { getStagedVideoSha256, stageVideo } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { cancelLocalJob, getLocalEnvironment, listLocalJobs, setupLocalEnvironment, startLocalJob,
  type LocalEnvironment, type LocalJob } from "./api";

const stateLabel: Record<LocalJob["state"], string> = {
  queued: "Na fila", running: "Em andamento", succeeded: "Concluída",
  failed: "Falhou", cancelled: "Cancelada",
};

function message(reason: unknown) {
  return typeof reason === "string" ? reason : reason instanceof Error ? reason.message : String(reason);
}

export function LocalAnalysisPanel({ experiment, selectSource, colabBusy }: {
  experiment: OpenFieldExperiment;
  selectSource: (selection: TrackingSelection) => Promise<boolean>;
  colabBusy: boolean;
}) {
  const { assets, setAsset, updateExperiment, analysisActivity, setAnalysisActivity } = useAppStore();
  const asset = assets[experiment.id];
  const [environment, setEnvironment] = useState<LocalEnvironment | null>(null);
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [settingUp, setSettingUp] = useState(false);
  const [running, setRunning] = useState(false);
  const [useOpenCL, setUseOpenCL] = useState(false);
  const [referenceApproved, setReferenceApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const waitingForFile = useRef(false);
  const active = jobs.find(job => job.state === "queued" || job.state === "running");
  const busy = running || settingUp || Boolean(active) || colabBusy;
  const selected = jobs.find(job => experiment.trackingSelection?.engine === "opencv" && job.jobId === experiment.trackingSelection.jobId);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let live = true;
    void getLocalEnvironment().then(value => { if (live) setEnvironment(value); }).catch(reason => { if (live) setError(message(reason)); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let live = true;
    const refresh = () => { void listLocalJobs(experiment.id).then(value => { if (live) setJobs(value); }).catch(reason => { if (live) setError(message(reason)); }); };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [experiment.id]);

  async function setup() {
    setSettingUp(true); setError(null);
    try { setEnvironment(await setupLocalEnvironment()); }
    catch (reason) { setError(message(reason)); }
    finally { setSettingUp(false); }
  }

  async function run(selectedFile?: File) {
    if (busy) return;
    if (experiment.video.timingSource === "synthetic") { setError("A demonstração sintética não possui vídeo original para análise local."); return; }
    if (!isTauriRuntime()) { setError("A análise local requer o aplicativo desktop."); return; }
    if (!environment?.ready) { setError("Prepare o ambiente OpenCV local antes de iniciar."); return; }
    const file = selectedFile ?? asset?.file;
    if (!file) { waitingForFile.current = true; fileRef.current?.click(); return; }
    if (file.name !== experiment.video.filename || file.size !== experiment.video.sizeBytes) {
      setError("Selecione o vídeo original usado para criar este experimento."); return;
    }
    setRunning(true); setError(null);
    setAnalysisActivity(experiment.id, { starting: true, engine: "opencv", startedAt: Date.now(), message: "Copiando o vídeo original", error: null, videoProgress: null });
    let started = false;
    try {
      const uploadId = await stageVideo(experiment.id, file, (_percent, text, detail) =>
        setAnalysisActivity(experiment.id, { message: text, videoProgress: detail
          ? { phase: detail.phase, percent: detail.percent, remainingSec: detail.remainingSec } : null }));
      const sha256 = await getStagedVideoSha256(uploadId);
      if (experiment.video.sha256 && experiment.video.sha256 !== sha256) {
        throw new Error("O SHA-256 não corresponde ao vídeo original do experimento.");
      }
      if (!experiment.video.sha256) updateExperiment(experiment.id, current => ({ video: { ...current.video, sha256 } }));
      if (selectedFile) {
        if (asset?.objectUrl) URL.revokeObjectURL(asset.objectUrl);
        setAsset(experiment.id, { ...asset, file, objectUrl: URL.createObjectURL(file) });
      }
      const job = await startLocalJob(experiment.id, uploadId, {
        width: experiment.video.width, height: experiment.video.height,
        mode: "auto", threshold: 110, minAreaFraction: 0.0001, maxAreaFraction: 0.2,
        maxWidth: 1280, maxPredictionSec: 0.25, referenceApproved,
        useOpenCL: useOpenCL && Boolean(environment.openclAvailable), strategy: "classic", arena: experiment.arena,
      });
      started = true;
      updateExperiment(experiment.id, { status: "processing" });
      setJobs(current => [{ ...job, uploadId, error: null, report: {} }, ...current]);
      setAnalysisActivity(experiment.id, { message: "Analisando frames no computador", videoProgress: null });
      for (;;) {
        const current = (await listLocalJobs(experiment.id)).find(item => item.jobId === job.jobId);
        if (!current) throw new Error("A execução local não foi encontrada.");
        setJobs(previous => [current, ...previous.filter(item => item.jobId !== current.jobId)]);
        setAnalysisActivity(experiment.id, { message: `${current.report.framesProcessed ?? 0} frames analisados` });
        if (current.state === "succeeded") {
          if (!await selectSource({ engine: "opencv", jobId: current.jobId })) throw new Error("O resultado local não pôde ser aberto.");
          break;
        }
        if (current.state === "failed" || current.state === "cancelled") throw new Error(current.error || stateLabel[current.state]);
        await new Promise(resolve => window.setTimeout(resolve, 1_500));
      }
    } catch (reason) {
      const failure = message(reason);
      setError(failure);
      setAnalysisActivity(experiment.id, { error: failure, message: failure });
      if (started) updateExperiment(experiment.id, current => ({ status: current.trackingSelection ? "review" : "failed" }));
    } finally {
      setRunning(false);
      setAnalysisActivity(experiment.id, { starting: false, videoProgress: null });
    }
  }

  function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file && waitingForFile.current) { waitingForFile.current = false; void run(file); }
  }

  return <section className="panel local-analysis-panel" aria-label="Análise local">
    <input ref={fileRef} type="file" accept="video/*" className="sr-only" onChange={attach} />
    <div className="panel-header"><div><h2><Cpu size={20} /> Análise local</h2>
      <p>OpenCV acompanha a caixa do animal no vídeo original. Usa CPU; OpenCL pode ser solicitado para operações compatíveis quando houver GPU disponível.</p></div></div>
    <div className="validation-box"><Info size={16} /><span>O centro da caixa não é pose anatômica. Revise a trajetória e a cobertura antes de interpretar as métricas; frames previstos ou incertos ficam fora dos cálculos.</span></div>
    {environment?.ready ? <p className="local-environment">OpenCV {environment.version} · {environment.openclAvailable ? "GPU OpenCL disponível para teste experimental" : "CPU; GPU OpenCL indisponível"}</p>
      : <div className="local-setup"><p>{environment?.message ?? "Verificando o ambiente local…"}</p>
        <Button variant="secondary" disabled={settingUp || !isTauriRuntime()} onClick={() => void setup()}>{settingUp ? "Preparando OpenCV…" : "Preparar análise local"}</Button></div>}
    <div className="local-analysis-settings">
      <p className="local-auto-note">O analisador estima o contraste do animal e escolhe o limiar a partir do vídeo. Revise as observações antes de interpretar resultados.</p>
      <label className="local-reference-approval"><input type="checkbox" checked={referenceApproved} disabled={busy}
        onChange={event => setReferenceApproved(event.target.checked)} />
        <span>Aprovo o centro da caixa segmentada como referência 2D para calcular métricas de Campo Aberto nesta execução.</span></label>
      <details className="local-options"><summary>Opções avançadas</summary>
        <label className="local-reference-approval"><input type="checkbox" checked={useOpenCL}
          disabled={busy || !environment?.openclAvailable} onChange={event => setUseOpenCL(event.target.checked)} />
          <span>Solicitar OpenCL nesta execução (experimental; padrão CPU).</span></label>
      </details>
    </div>
    <div className="results-actions"><Button disabled={busy || !environment?.ready || experiment.video.timingSource === "synthetic"}
      onClick={() => void run()}>{running || active ? "Processando localmente…" : "Analisar localmente"}</Button>
      {active && <Button variant="secondary" onClick={() => void cancelLocalJob(active.jobId).catch(reason => setError(message(reason)))}>Cancelar</Button>}</div>
    {error && <div className="validation-box invalid" role="alert"><Info size={16} />{error}</div>}
    {active && <div className="local-progress" role="status"><strong>{active.report.framesProcessed ?? 0}{active.report.totalFrames ? ` / ${active.report.totalFrames}` : ""} frames</strong>
      <span> · {active.report.phase === "recognition" ? "Reconhecendo contraste do animal" : `${active.report.processingFps?.toFixed(1) ?? "—"} FPS de processamento · ${active.report.computeBackend ?? "CPU"}`}</span></div>}
    {selected?.report.segmentationSelection && <p className="local-detection-result">Contraste estimado: {selected.report.segmentationSelection.mode === "dark" ? "animal escuro" : "animal claro"} · limiar {selected.report.segmentationSelection.threshold} · {selected.report.segmentationSelection.inspectedFrames ?? selected.report.segmentationSelection.sampledFrames} frames inspecionados.</p>}
    {analysisActivity[experiment.id]?.starting && !active && <p role="status">{analysisActivity[experiment.id].message}</p>}
    {jobs.length > 0 && <div className="local-job-history"><h3>Execuções locais</h3>
      {jobs.map(job => <button type="button" key={job.jobId} disabled={job.state !== "succeeded"}
        aria-pressed={selected?.jobId === job.jobId} onClick={() => void selectSource({ engine: "opencv", jobId: job.jobId })}>
        <strong>{new Date(job.createdAt).toLocaleString("pt-BR")}</strong>
        <span>{stateLabel[job.state]} · {job.report.observationCoveragePct == null ? "" : `${job.report.observationCoveragePct.toFixed(1)}% de cobertura · `}{job.report.computeBackend ?? "CPU"}</span>
      </button>)}</div>}
    {selected && (selected.report.cameraUncertainFrames ?? 0) > 0 && <div className="validation-box invalid" role="status"><Info size={16} />
      Foi detectado deslocamento visual em relação à calibração; {selected.report.cameraUncertainFrames} frames ficaram incertos e fora das métricas. Confira a arena e o vídeo.
    </div>}
    {selected?.report.cameraMotionState === "unavailable" && <div className="validation-box" role="status"><Info size={16} />
      Não foi possível verificar a estabilidade da câmera com pontos estáticos na arena. Confira visualmente a calibração ao longo do vídeo.
    </div>}
    {selected?.config.referenceApproved === false && <p className="local-environment">Esta execução não aprovou o centro da caixa para métricas. Reprocesse com a referência 2D aprovada após conferir o vídeo.</p>}
  </section>;
}
