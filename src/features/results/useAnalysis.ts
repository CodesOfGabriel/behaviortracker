import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { parseCanonicalPoseCsv } from "../../lib/csv";
import { selectTrackingReview } from "../../lib/tracking-reviews";
import { preparedGeometry, scaleArenaToUpload, scalePoseToOriginal } from "../colab/videoGeometry";
import { useAppStore } from "../../store/AppStore";
import type { OpenFieldExperiment, TrackingSelection } from "../../types";
import {
  checkVideoStaging, getColabJobPreparation, getHybridBundleStatus, loadColabJobs, loadColabResult,
  prepareVideo, startColabJob, waitForColabJob, type ColabJob,
} from "../colab/analysis";
import {
  COLAB_STATUS_EVENT, emptyColabSummary, isTauriRuntime, loadColabSummary,
  type OAuthProfileSummary,
} from "../colab/connection";
import { loadLocalResult } from "../local/api";

export function useAnalysis(experimentId: string) {
  const {
    getExperiment, assets, setAsset, trackingData, setTrackingData,
    updateExperiment, analysisActivity, setAnalysisActivity,
  } = useAppStore();
  const experiment = getExperiment(experimentId) as OpenFieldExperiment | undefined;
  const asset = assets[experimentId];
  const fileRef = useRef<HTMLInputElement>(null);
  const analysisRequested = useRef(false);
  const sourceRequest = useRef(0);
  const attemptedSource = useRef<string | null>(null);
  const [history, setHistory] = useState<ColabJob[]>([]);
  const [summary, setSummary] = useState<OAuthProfileSummary>(emptyColabSummary);
  const [error, setError] = useState<string | null>(null);
  const [loadingResult, setLoadingResult] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const activity = analysisActivity[experimentId] ?? { starting: false, message: "", error: null };
  const runningJob = history.find((job) => job.status === "running" || job.status === "queued");
  const activeJob = activity.starting && !runningJob && !selectedHistoryId ? null : selectedHistoryId
    ? history.find((job) => job.jobId === selectedHistoryId) ?? runningJob ?? history[0] ?? null
    : runningJob ?? history[0] ?? null;
  const busy = activity.starting || Boolean(runningJob);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    let revision = 0;
    const onStatus = (event: Event) => {
      revision += 1;
      setSummary((event as CustomEvent<OAuthProfileSummary>).detail);
    };
    window.addEventListener(COLAB_STATUS_EVENT, onStatus);
    const requestRevision = ++revision;
    void loadColabSummary().then((value) => {
      if (active && revision === requestRevision) setSummary(value);
    }).catch(() => undefined);
    return () => { active = false; window.removeEventListener(COLAB_STATUS_EVENT, onStatus); };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    const refresh = () => {
      void loadColabJobs(experimentId).then((jobs) => {
        if (active) setHistory(jobs.filter((job) => !job.diagnostic && !job.training));
      }).catch(() => undefined);
      setClock(Date.now());
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [experimentId]);

  const selectSource = useCallback(async (selection: TrackingSelection) => {
    attemptedSource.current = `${selection.engine}:${selection.jobId}`;
    const request = ++sourceRequest.current;
    setLoadingResult(true);
    setError(null);
    try {
      let samples = selection.engine === "colab"
        ? parseCanonicalPoseCsv(await loadColabResult(selection.jobId))
        : await loadLocalResult(selection.jobId);
      if (selection.engine === "colab" && experiment) {
        const preparation = await getColabJobPreparation(experimentId, selection.jobId);
        if (preparation) samples = scalePoseToOriginal(samples, experiment.video, preparation);
      }
      if (request !== sourceRequest.current) return;
      if (!samples.length) throw new Error("A execução não contém frames.");
      setTrackingData(experimentId, samples);
      if (experiment?.trackingSelection?.engine !== selection.engine || experiment.trackingSelection.jobId !== selection.jobId) {
        updateExperiment(experimentId, (current) => selectTrackingReview(current, selection, samples));
      }
      return true;
    } catch (reason) {
      if (request === sourceRequest.current) setError(`Não foi possível abrir o resultado: ${String(reason)}`);
      return false;
    } finally {
      if (request === sourceRequest.current) setLoadingResult(false);
    }
  }, [experiment?.trackingSelection?.engine, experiment?.trackingSelection?.jobId,
    experimentId, setTrackingData, updateExperiment]);

  useEffect(() => {
    if (!experiment || trackingData[experimentId]?.length || loadingResult) return;
    const selection = experiment.trackingSelection
      ?? (history.find((job) => job.resultsReady || job.status === "succeeded")
        ? { engine: "colab" as const, jobId: history.find((job) => job.resultsReady || job.status === "succeeded")!.jobId }
        : null);
    if (selection && attemptedSource.current !== `${selection.engine}:${selection.jobId}`) void selectSource(selection);
  }, [experiment, experimentId, history, loadingResult, selectSource, trackingData]);

  const run = async (selectedFile?: File) => {
    if (!experiment || busy) return;
    if (!isTauriRuntime()) { setError("A análise Colab requer o aplicativo desktop."); return; }
    if (!summary.connected) { setError("Conecte o Google Colab antes de iniciar a análise."); return; }
    const file = selectedFile ?? asset?.file;
    let preparation = selectedFile ? undefined : experiment.video.preparation;
    if (preparation && preparation.originalBytes > 100_000_000 && preparation.policyVersion !== "quality-upload-2") preparation = undefined;
    if (!file && !preparation) {
      analysisRequested.current = true;
      fileRef.current?.click();
      return;
    }
    setAnalysisActivity(experimentId, { starting: true, message: "Verificando a conexão com o Colab", error: null });
    setError(null);
    setSelectedHistoryId(null);
    try {
      const connection = await loadColabSummary();
      setSummary(connection);
      if (!connection.connected) throw new Error("Conecte o Google Colab antes de iniciar a análise.");
      if (connection.providerError) throw new Error(connection.providerError);
      if (connection.eligibleGpuCount < 1) throw new Error("Nenhum runtime GPU elegível está disponível.");
      const bundleId = experiment.modelBundleId ?? "wistar_df_v1";
      if (bundleId !== "wistar_df_v1" && bundleId !== "wistar_df_v2") throw new Error(`Modelo desconhecido: ${bundleId}`);
      if ((experiment.analysisEngine ?? "wistar_superanimal_hybrid_v1") === "wistar_superanimal_hybrid_v1") {
        const bundle = await getHybridBundleStatus(bundleId);
        if (!bundle.installed) throw new Error(bundle.error || `Bundle ${bundleId} ausente`);
      }
      if (preparation && !await checkVideoStaging(experimentId, preparation.uploadId)) preparation = undefined;
      if (!preparation && !file) {
        analysisRequested.current = true;
        fileRef.current?.click();
        setError("Selecione novamente o vídeo original para processar.");
        return;
      }
      updateExperiment(experimentId, { status: "processing" });
      if (!preparation) {
        preparation = await prepareVideo(experimentId, file!, experiment.video, (_progress, message) =>
          setAnalysisActivity(experimentId, { message }));
        updateExperiment(experimentId, { video: { ...experiment.video, preparation } });
      }
      const geometry = preparedGeometry(experiment.video, preparation);
      const started = await startColabJob(experimentId, preparation.uploadId, {
        width: geometry.width, height: geometry.height,
        durationSec: experiment.video.durationSec,
      }, scaleArenaToUpload(experiment.arena, experiment.video, preparation), experiment.analysisEngine ?? "wistar_superanimal_hybrid_v1", bundleId);
      setHistory((current) => [started, ...current.filter((job) => job.jobId !== started.jobId)]);
      setSelectedHistoryId(started.jobId);
      const completed = await waitForColabJob(started.jobId, (job) => {
        setHistory((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
        setAnalysisActivity(experimentId, { message: job.message });
      });
      if (completed.status === "failed" && !completed.resultsReady) {
        throw new Error(completed.error || "A execução falhou antes de gerar resultados.");
      }
      if (!await selectSource({ engine: "colab", jobId: completed.jobId })) {
        throw new Error("A execução terminou, mas o resultado não pôde ser aberto.");
      }
      if (completed.status === "failed") setError(`Poses preservadas; a execução parou após a inferência: ${completed.error || completed.message}`);
      updateExperiment(experimentId, (current) => ({ video: { ...current.video, preparation }, status: "review" }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setAnalysisActivity(experimentId, { error: message, message });
      updateExperiment(experimentId, { status: "failed" });
    } finally {
      setAnalysisActivity(experimentId, { starting: false });
    }
  };

  const attachFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !experiment) return;
    event.target.value = "";
    if (file.size !== experiment.video.sizeBytes) {
      setError(`O arquivo tem ${file.size} bytes; o vídeo do experimento tem ${experiment.video.sizeBytes} bytes.`);
      return;
    }
    if (asset?.objectUrl) URL.revokeObjectURL(asset.objectUrl);
    setAsset(experimentId, { ...asset, objectUrl: URL.createObjectURL(file), file });
    if (analysisRequested.current) {
      analysisRequested.current = false;
      void run(file);
    }
  };

  const started = activeJob ? Date.parse(activeJob.createdAt) : 0;
  const ended = activeJob?.status === "running" || activeJob?.status === "queued"
    ? clock : activeJob ? Date.parse(activeJob.updatedAt) : 0;
  return {
    fileRef, attachFile, run, selectSource, history, activeJob, busy, summary,
    error: error ?? activity.error, message: activity.message,
    loadingResult, selectedHistoryId, setSelectedHistoryId,
    elapsedSec: Math.max(0, (ended - started) / 1000) || 0,
  };
}
