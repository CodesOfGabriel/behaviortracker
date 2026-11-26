import { SelectMenu } from "../../components/ui/SelectMenu";
import type { LocalAnalysisControls } from "../results/AnalysisWorkspace";
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { formatBytes } from "../../lib/format";
import { useAppStore } from "../../store/AppStore";
import type { BoundingBox, OpenFieldExperiment, TrackingSelection } from "../../types";
import { LocalTargetSeed } from "./LocalTargetSeed";
import { LATEST_HYBRID_BUNDLE_ID, loadStagedVideo, prepareColabVideo, type VideoPreparationProgress } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { preparedGeometry, scaleArenaToUpload } from "../colab/videoGeometry";
import { cancelLocalJob, getLocalEnvironment, setupLocalEnvironment, listLocalJobs, stageLocalOriginal, startLocalJob, startLocalWistar, type LocalJob } from "./api";
import { getBehaviorModelStatus, startBehavior } from "../behavior/api";

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
  const [strategy, setStrategy] = useState("classical_roi_v1");
  const [processingWidth, setProcessingWidth] = useState(640);
  const [initialBox, setInitialBox] = useState<BoundingBox>();
  const [detectRearing, setDetectRearing] = useState(false);
  const [behaviorReady, setBehaviorReady] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const active = jobs.find(job => job.state === "queued" || job.state === "running");
  const busy = running || Boolean(active) || colabBusy;
  const selected = jobs.find(job => experiment.trackingSelection?.engine === "opencv" && job.jobId === experiment.trackingSelection.jobId);
  const preparation = (active ?? selected)?.config.videoPreparation;

  useEffect(() => {
    setInitialBox(undefined);
  }, [experiment.id]);

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
    void getBehaviorModelStatus().then(value=>setBehaviorReady(value.installed&&value.environmentReady)).catch(()=>setBehaviorReady(false));
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
      let job: LocalJob;
      let originalSha256: string;
      let preparation = experiment.video.preparation;
      if (strategy === "classical_roi_v1") {
        const media = await stageLocalOriginal(experiment.id, experiment.video, file, updateVideoProgress);
        if (!media) { fileRef.current?.click(); return; }
        originalSha256 = media.originalSha256;
        if (!(await getLocalEnvironment()).ready) {
          setAnalysisActivity(experiment.id, { message: "Preparando OpenCV local", videoProgress: null });
          if (!(await setupLocalEnvironment()).ready) throw new Error("Não foi possível preparar OpenCV local.");
        }
        job = await startLocalJob(experiment.id, media.uploadId, {
          protocol: "open_field", strategy, width: experiment.video.width, height: experiment.video.height,
          arena: experiment.arena, mode: "auto", threshold: 25, minAreaFraction: .001,
          maxAreaFraction: .12, maxWidth: processingWidth, maxPredictionSec: .25,
          referenceApproved: false, useOpenCL: false, autorotate: true,
          ...(initialBox ? { initialBox } : {}),
        }, { optimizeVideo: false, expectedVideoSha256: originalSha256 });
      } else {
        const bundleId = experiment.modelBundleId ?? (experiment.analysisEngine === "superanimal_video_adapt_b_legacy"
          ? LATEST_HYBRID_BUNDLE_ID : "wistar_df_v1");
        if (bundleId !== "wistar_df_v1" && bundleId !== "wistar_df_v2") throw new Error(`Modelo desconhecido: ${bundleId}`);
        const media = await prepareColabVideo(experiment.id, experiment.video, file, updateVideoProgress);
        if (!media) { fileRef.current?.click(); return; }
        ({ preparation, originalSha256 } = media);
        const geometry = preparedGeometry(experiment.video, preparation);
        const arena = scaleArenaToUpload(experiment.arena, experiment.video, preparation);
        job = await startLocalWistar(experiment.id, preparation.uploadId, originalSha256, experiment.video,
          { ...arena, videoWidth: geometry.width, videoHeight: geometry.height }, bundleId);
      }
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
      setAnalysisActivity(experiment.id, { message: strategy === "classical_roi_v1" ? "Construindo a referência de fundo" : "Preparando o detector Wistar e as camadas corporais", videoProgress: null });
      for (;;) {
        const current = (await listLocalJobs(experiment.id)).find(item => item.jobId === job.jobId);
        if (!current) throw new Error("A execução local não foi encontrada.");
        setJobs(previous => [current, ...previous.filter(item => item.jobId !== current.jobId)]);
        if (current.state === "succeeded") {
          if (!await selectSource({ engine: "opencv", jobId: current.jobId })) throw new Error("O resultado local não pôde ser aberto.");
          if (strategy === "classical_roi_v1" && detectRearing && behaviorReady) {
            try { await startBehavior(experiment.id, current.jobId, originalSha256); }
            catch (reason) { setError(`Tracking concluído. Não foi possível iniciar rearing: ${message(reason)}`); }
          }
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
    {/* The panel lives inside closed history details. A modal there makes the
        page inert while remaining invisible, so mount it outside that subtree. */}
    {createPortal(<dialog ref={dialogRef} className="confirm-modal local-analysis-modal"
      aria-labelledby={dialogTitleId} aria-describedby={dialogDescriptionId}>
      <form onSubmit={event => {
        event.preventDefault();
        dialogRef.current?.close();
        void run();
      }}>
        <h2 id={dialogTitleId}>Analisar na máquina local</h2>
        <p id={dialogDescriptionId}>A análise e o vídeo de revisão são processados neste computador.</p>
        <SelectMenu label="Método" value={strategy} disabled={busy} onChange={setStrategy} options={[{value:"classical_roi_v1",label:"OpenCV rápido · CPU (experimental)"},{value:"wistar_hrnet",label:"Wistar em camadas · caixa e orientação"}]}/>
        {strategy === "classical_roi_v1" ? <>
          <p>Fundo fixo, diferenças de cor e continuidade visual para localizar o corpo e reduzir trocas por reflexos. O MP4 inclui um eixo geométrico e um gráfico de deslocamento. Após o tracking, a aba Rearing permite anotar os episódios e executar um classificador supervisionado instalado.</p>
          <SelectMenu label="Largura de processamento" value={String(processingWidth)} disabled={busy} onChange={value=>setProcessingWidth(Number(value))} options={[480,640,960].map(value=>({value:String(value),label:`${value} px`}))}/>
          <LocalTargetSeed experiment={experiment} file={asset?.file} disabled={busy} box={initialBox} onChange={setInitialBox} />
          <p>As estimativas de cabeça e cauda são identificadas no vídeo. Se um modelo de ápices estiver selecionado na aba Rearing, as propostas serão geradas automaticamente.</p>
          <label className="local-rearing-option"><input type="checkbox" checked={detectRearing} disabled={busy||!behaviorReady} onChange={event=>setDetectRearing(event.target.checked)}/><span>Classificar episódios completos após o tracking</span></label>
          <p>{behaviorReady?"O classificador de episódios será executado em CPU como uma etapa independente. Acompanhe o resultado na aba Rearing.":"Para habilitar a classificação de episódios e duração, instale um modelo supervisionado de episódios na aba Rearing."}</p>
          <p>A primeira execução requer Python 3 e pode baixar OpenCV e suas dependências. Métricas exigem revisão das observações.</p>
        </> : <p>O detector Wistar localiza a caixa. As etapas seguintes analisam a silhueta, o eixo corporal e a orientação de cabeça e cauda. Estimativas ficam identificadas para revisão. Um modelo de ápices selecionado permite propor rearings. A primeira execução requer Python 3.10 a 3.13 de 64 bits e pode baixar dependências.</p>}
        <div className="confirm-modal-actions">
          <Button type="button" variant="secondary" onClick={() => dialogRef.current?.close()}>Cancelar</Button>
          <Button type="submit" disabled={busy}>Iniciar análise</Button>
        </div>
      </form>
    </dialog>, document.body)}
    {(jobs.length > 0 || error) && <section className="panel local-analysis-panel" aria-label="Execuções locais">
      {active && <Button variant="secondary" onClick={() => void cancelLocalJob(active.jobId).catch(reason => setError(message(reason)))}>Cancelar</Button>}
      {error && <div className="validation-box invalid" role="alert"><Info size={16} />{error}</div>}
      {active?.report.computeBackend && <div className="local-progress" role="status"><strong>{active.report.computeBackend}</strong>
        {active.report.processingFps != null && <span> · {active.report.processingFps.toFixed(1)} FPS de processamento</span>}</div>}
      {preparation && <p>{preparation.message} Original {formatBytes(preparation.originalBytes)} · análise {formatBytes(preparation.uploadBytes)}</p>}
      {selected?.report.segmentationSelection && <p className="local-detection-result">{selected.report.backgroundReference ? "Contraste auxiliar estimado" : "Contraste estimado"}: {selected.report.segmentationSelection.mode === "dark" ? "animal escuro" : "animal claro"} · limiar {selected.report.segmentationSelection.threshold} · {selected.report.segmentationSelection.inspectedFrames ?? selected.report.segmentationSelection.sampledFrames} frames inspecionados.</p>}
      {selected?.report.backgroundReference && <p>Fundo fixo estimado com {selected.report.backgroundReference.sampledFrames} amostras da sessão.
        {selected.report.trackingObservedCoveragePct != null && ` ${selected.report.trackingObservedCoveragePct.toFixed(1)}% de localizações aceitas pelo rastreador.`}
        {selected.report.validObservationCoveragePct != null && ` ${selected.report.validObservationCoveragePct.toFixed(1)}% de observações sem alertas.`}
        {selected.report.reviewRequiredFrames != null && ` ${selected.report.reviewRequiredFrames} frames exigem revisão.`}</p>}
      {selected?.report.rearing&&<p role="status">{selected.report.rearing.state==="model_unavailable"
        ? "Rearing não classificado: selecione um modelo de ápices na aba Comportamento para as próximas análises."
        : `${selected.report.rearing.candidates.length} propostas de rearing para revisão. Cabeça e cauda são estimativas; não entram nas métricas automáticas.`}</p>}
      {selected?.report.qualityReasonCounts && <details><summary>Motivos de revisão</summary>
        <p>{selected.report.geometryRejectedFrames ?? 0} localizações aceitas pelo rastreador têm geometria insuficiente para métricas no piso.</p>
        <p>Caixas recuperadas e previsões continuam fora das métricas. Os indicadores do rastreador são heurísticos.</p>
        <ul>{Object.entries(selected.report.qualityReasonCounts).sort((a, b) => b[1]-a[1]).map(([reason, count]) =>
          <li key={reason}>{({ near_wall_or_partial: "Próximo à borda ou projeção na parede", silhouette_clipped: "Silhueta cortada pela área analisável",
            ambiguous_candidates: "Candidatos semelhantes", identity_pending: "Identificação inicial pendente", reacquisition_pending: "Reidentificação pendente",
            appearance_changed: "Aparência diferente", area_changed: "Área corporal diferente", outside_floor_candidate: "Candidato sem apoio suficiente no piso", shape_inconsistent: "Formato inconsistente", no_contour: "Sem silhueta", camera_shift: "Câmera deslocada" } as Record<string, string>)[reason] ?? "Outro alerta"}: {count}</li>)}</ul>
      </details>}
      {jobs.length > 0 && <div className="local-job-history"><h3>Execuções locais</h3>
        {jobs.map(job => <button type="button" key={job.jobId} disabled={busy || job.state !== "succeeded"}
          aria-pressed={selected?.jobId === job.jobId} onClick={() => void selectSource({ engine: "opencv", jobId: job.jobId })}>
          <strong>{new Date(job.createdAt).toLocaleString("pt-BR")}</strong>
          <span>{stateLabel[job.state]} · {job.config.strategy === "wistar_hrnet" ? job.config.modelBundleId==="wistar_df_v2"?"Wistar em camadas":"Wistar + HRNet" : "OpenCV"}
            {job.report.observationCoveragePct == null ? "" : ` · ${job.report.observationCoveragePct.toFixed(1)}% de cobertura`}</span>
        </button>)}</div>}
      {selected && (selected.report.cameraUncertainFrames ?? 0) > 0 && <div className="validation-box invalid" role="status"><Info size={16} />
        Foi detectado deslocamento visual em relação à calibração; {selected.report.cameraUncertainFrames} frames ficaram incertos e fora das métricas. Confira a arena e o vídeo.
      </div>}
      {selected?.report.cameraMotionState === "unavailable" && <div className="validation-box" role="status"><Info size={16} />
        Não foi possível verificar a estabilidade da câmera com pontos estáticos na arena. Confira visualmente a calibração ao longo do vídeo.
      </div>}
      {selected?.config.referenceApproved === false && <p className="local-environment">Centro da caixa e silhueta disponíveis para revisão. Observações incertas e previsões ficam fora das métricas; o centro da caixa não é um ponto anatômico.</p>}
    </section>}
  </>;
  return children({ run: confirmAnalysis, busy, ready: experiment.video.timingSource !== "synthetic", job: active ?? jobs[0] ?? null, panel });
}
