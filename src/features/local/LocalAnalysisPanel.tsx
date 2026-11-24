import type { LocalAnalysisControls } from "../results/AnalysisWorkspace";
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { formatBytes } from "../../lib/format";
import { useAppStore } from "../../store/AppStore";
import type { OpenFieldExperiment, TrackingSelection } from "../../types";
import { LATEST_HYBRID_BUNDLE_ID, loadStagedVideo, prepareColabVideo, type VideoPreparationProgress } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { preparedGeometry, scaleArenaToUpload } from "../colab/videoGeometry";
import { cancelLocalJob, listLocalJobs, startLocalWistar, type LocalJob } from "./api";

const stateLabel: Record<LocalJob["state"], string> = {
  queued: "Na fila", running: "Em andamento", succeeded: "Concluída",
  failed: "Falhou", cancelled: "Cancelada",
};

function message(reason: unknown) {
  return typeof reason === "string" ? reason : reason instanceof Error ? reason.message : String(reason);
}

export function LocalAnalysisPanel({ experiment, selectSource, colabBusy, children }: {
  experiment: OpenFieldExperiment;
  selectSource: (selection: TrackingSelection) => Promise<boolean>;
  colabBusy: boolean;
  children: (controls: LocalAnalysisControls) => ReactNode;
}) {
  const { assets, setAsset, updateExperiment, setAnalysisActivity } = useAppStore();
  const asset = assets[experiment.id];
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const active = jobs.find(job => job.state === "queued" || job.state === "running");
  const busy = running || Boolean(active) || colabBusy;
  const selected = jobs.find(job => experiment.trackingSelection?.engine === "opencv" && job.jobId === experiment.trackingSelection.jobId);
  const preparation = (active ?? selected)?.config.videoPreparation;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let live = true;
    const refresh = () => { void listLocalJobs(experiment.id).then(value => { if (live) setJobs(value); }).catch(reason => { if (live) setError(message(reason)); }); };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [experiment.id]);

  function confirmAnalysis() {
    const dialog = dialogRef.current;
    if (busy || !dialog || dialog.open) return;
    dialog.showModal();
  }

  async function run(selectedFile?: File) {
    if (busy) return;
    if (experiment.video.timingSource === "synthetic") { setError("A demonstração sintética não possui vídeo original para análise local."); return; }
    if (!isTauriRuntime()) { setError("A análise local requer o aplicativo desktop."); return; }
    const file = selectedFile ?? asset?.file;
    setRunning(true); setError(null);
    setAnalysisActivity(experiment.id, { starting: true, engine: "opencv", startedAt: Date.now(),
      message: "Verificando a cópia local do vídeo",
      error: null, videoProgress: null });
    let started = false;
    try {
      const updateVideoProgress = (_percent: number, text: string, detail?: VideoPreparationProgress) =>
        setAnalysisActivity(experiment.id, { message: text, videoProgress: detail
          ? { phase: detail.phase, percent: detail.percent, remainingSec: detail.remainingSec } : null });
      const bundleId = experiment.modelBundleId ?? (experiment.analysisEngine === "superanimal_video_adapt_b_legacy"
        ? LATEST_HYBRID_BUNDLE_ID : "wistar_df_v1");
      if (bundleId !== "wistar_df_v1" && bundleId !== "wistar_df_v2") throw new Error(`Modelo desconhecido: ${bundleId}`);
      const media = await prepareColabVideo(experiment.id, experiment.video, file, updateVideoProgress);
      if (!media) { fileRef.current?.click(); return; }
      const { preparation, originalSha256 } = media;
      const geometry = preparedGeometry(experiment.video, preparation);
      const arena = scaleArenaToUpload(experiment.arena, experiment.video, preparation);
      const job = await startLocalWistar(experiment.id, preparation.uploadId, originalSha256, experiment.video,
        { ...arena, videoWidth: geometry.width, videoHeight: geometry.height }, bundleId);
      started = true;
      updateExperiment(experiment.id, current => ({
        status: "processing",
        video: { ...current.video, sha256: originalSha256, preparation },
      }));
      setJobs(current => [{ ...job, error: null, report: {} }, ...current]);
      if (selectedFile || !asset?.objectUrl) {
        if (asset?.objectUrl) URL.revokeObjectURL(asset.objectUrl);
        const objectUrl = file ? URL.createObjectURL(file)
          : await loadStagedVideo(experiment.id, job.uploadId).catch(() => undefined);
        setAsset(experiment.id, { ...asset, file, objectUrl });
      }
      setAnalysisActivity(experiment.id, { message: "Preparando os modelos Wistar e HRNet", videoProgress: null });
      for (;;) {
        const current = (await listLocalJobs(experiment.id)).find(item => item.jobId === job.jobId);
        if (!current) throw new Error("A execução local não foi encontrada.");
        setJobs(previous => [current, ...previous.filter(item => item.jobId !== current.jobId)]);
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
    if (file) void run(file);
  }

  const panel = <>
    <input ref={fileRef} type="file" accept="video/*" className="sr-only" onChange={attach} />
    <dialog ref={dialogRef} className="confirm-modal local-analysis-modal"
      aria-labelledby={dialogTitleId} aria-describedby={dialogDescriptionId}>
      <form onSubmit={event => {
        event.preventDefault();
        dialogRef.current?.close();
        void run();
      }}>
        <h2 id={dialogTitleId}>Analisar na máquina local</h2>
        <p id={dialogDescriptionId}>O detector Wistar localiza o animal e a HRNet estima 27 pontos anatômicos. A análise e a renderização do vídeo acontecem neste computador.</p>
        <p>A primeira execução requer Python 3.10 a 3.13 de 64 bits e pode baixar os modelos e as dependências. Em CPU, o processamento pode levar mais tempo.</p>
        <div className="confirm-modal-actions">
          <Button type="button" variant="secondary" onClick={() => dialogRef.current?.close()}>Cancelar</Button>
          <Button type="submit" disabled={busy}>Iniciar análise</Button>
        </div>
      </form>
    </dialog>
    {(jobs.length > 0 || error) && <section className="panel local-analysis-panel" aria-label="Execuções locais">
      {active && <Button variant="secondary" onClick={() => void cancelLocalJob(active.jobId).catch(reason => setError(message(reason)))}>Cancelar</Button>}
      {error && <div className="validation-box invalid" role="alert"><Info size={16} />{error}</div>}
      {active?.report.computeBackend && <div className="local-progress" role="status"><strong>{active.report.computeBackend}</strong>
        {active.report.processingFps != null && <span> · {active.report.processingFps.toFixed(1)} FPS de processamento</span>}</div>}
      {preparation && <p>{preparation.message} Original {formatBytes(preparation.originalBytes)} · análise {formatBytes(preparation.uploadBytes)}</p>}
      {selected?.report.segmentationSelection && <p className="local-detection-result">Contraste estimado: {selected.report.segmentationSelection.mode === "dark" ? "animal escuro" : "animal claro"} · limiar {selected.report.segmentationSelection.threshold} · {selected.report.segmentationSelection.inspectedFrames ?? selected.report.segmentationSelection.sampledFrames} frames inspecionados.</p>}
      {jobs.length > 0 && <div className="local-job-history"><h3>Execuções locais</h3>
        {jobs.map(job => <button type="button" key={job.jobId} disabled={busy || job.state !== "succeeded"}
          aria-pressed={selected?.jobId === job.jobId} onClick={() => void selectSource({ engine: "opencv", jobId: job.jobId })}>
          <strong>{new Date(job.createdAt).toLocaleString("pt-BR")}</strong>
          <span>{stateLabel[job.state]} · {job.config.strategy === "wistar_hrnet" ? "Wistar + HRNet" : "OpenCV"}
            {job.report.observationCoveragePct == null ? "" : ` · ${job.report.observationCoveragePct.toFixed(1)}% de cobertura`}</span>
        </button>)}</div>}
      {selected && (selected.report.cameraUncertainFrames ?? 0) > 0 && <div className="validation-box invalid" role="status"><Info size={16} />
        Foi detectado deslocamento visual em relação à calibração; {selected.report.cameraUncertainFrames} frames ficaram incertos e fora das métricas. Confira a arena e o vídeo.
      </div>}
      {selected?.report.cameraMotionState === "unavailable" && <div className="validation-box" role="status"><Info size={16} />
        Não foi possível verificar a estabilidade da câmera com pontos estáticos na arena. Confira visualmente a calibração ao longo do vídeo.
      </div>}
      {selected?.config.referenceApproved === false && <p className="local-environment">O centro da caixa desta execução está disponível para revisão. Uma nova análise local usa os pontos anatômicos para calcular as métricas.</p>}
    </section>}
  </>;
  return children({ run: confirmAnalysis, busy, ready: experiment.video.timingSource !== "synthetic", job: active ?? jobs[0] ?? null, panel });
}
