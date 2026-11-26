import { OpenFieldMetricSummary, type MetricReferenceMode } from "./OpenFieldMetricSummary";
import { TrackingDetails } from "./TrackingDetails";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../components/ui/card";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  Footprints,
  Info,
  PackageOpen,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ResultTabs } from "./ResultTabs";
import { RunZoneOccupancy } from "./RunZoneOccupancy";
import { applyCorrections } from "../../lib/corrections";
import { detectorTrajectory } from "../../lib/boxes";
import { preferredReference, reviewEvents, trackingSourceKey } from "../../lib/tracking-reviews";
import { downloadText, poseToCsv } from "../../lib/csv";
import { calculateOftMetrics, calculateObservedFloorBoxMetrics, METRIC_POLICY } from "../../lib/metrics";
import { metricEligible, originalPose, referencePoseSamples } from "../../lib/pose";
import { formatDuration } from "../../lib/format";
import { useAppStore } from "../../store/AppStore";
import { isTauriRuntime } from "../colab/connection";
import { AnalysisWorkspace } from "./AnalysisWorkspace";
import { useAnalysis } from "./useAnalysis";
import { LocalAnalysisPanel } from "../local/LocalAnalysisPanel";
import { ExperimentVideos } from "./ExperimentVideos";
import { ExperimentRunSummary } from "./ExperimentRunSummary";
import { listLocalJobs } from "../local/api";
import { BehaviorAnalysisPanel } from "../behavior/BehaviorAnalysisPanel";
import { BehaviorExperimentSummary } from "../behavior/BehaviorExperimentSummary";
import { RunTrajectory } from "./RunTrajectory";
import type { OftMetrics, OpenFieldExperiment } from "../../types";

function metricsCsv(metrics: OftMetrics) {
  const rows = [
    ["metric", "value", "unit", "revision"],
    ["analysis_duration", metrics.analysisDurationSec, "s", metrics.revision],
    ["valid_duration", metrics.validDurationSec, "s", metrics.revision],
    ["coverage", metrics.coveragePct, "%", metrics.revision],
    ["distance", metrics.distanceCm ?? "", "cm", metrics.revision],
    ["mean_speed", metrics.meanSpeedCmS ?? "", "cm/s", metrics.revision],
    ["center_time", metrics.validDurationSec > 0 ? metrics.centerTimeSec : "", "s", metrics.revision],
    ["peripheral_time", metrics.validDurationSec > 0 ? metrics.peripheralTimeSec : "", "s", metrics.revision],
    ["unknown_time", metrics.unknownTimeSec, "s", metrics.revision],
    ["center_pct_classifiable", metrics.centerPctClassifiable ?? "", "%", metrics.revision],
    ["center_entries", metrics.validDurationSec > 0 ? metrics.centerEntries : "", "count", metrics.revision],
    ["center_latency", metrics.centerLatencySec ?? "", "s", metrics.revision],
    ["operational_immobility", metrics.validDurationSec > 0 ? metrics.immobilityTimeSec : "", "s", metrics.revision],
  ];
  return rows.map((row, index) => [...row, index === 0 ? "method_version" : METRIC_POLICY.version].join(",")).join("\n");
}

export function Results({ experimentId }: { experimentId: string }) {
  const { getExperiment, navigate, trackingData, updateExperiment } = useAppStore();
  const analysis = useAnalysis(experimentId);
  const experiment = getExperiment(experimentId) as OpenFieldExperiment | undefined;
  const [resultView, setResultView] = useState<"summary" | "video" | "trajectory" | "details" | "exports" | "runs" | "behavior">(
    experiment?.status === "processing" ? "runs" : "summary",
  );
  const [metricChoice,setMetricChoice]=useState<{source:string;mode:MetricReferenceMode}|null>(null);
  const [latestLocalJobId, setLatestLocalJobId] = useState<string | null>(null);
  const [localHistoryError, setLocalHistoryError] = useState<string | null>(null);
  const selection = experiment?.trackingSelection;
  const showingArtifacts = resultView === "video" || resultView === "trajectory";
  const latestColabJob = analysis.history.find(job => job.resultsReady || job.status === "succeeded");
  const selectedColabJobId = selection?.engine === "colab" ? selection.jobId : latestColabJob?.jobId ?? null;
  const selectedLocalJobId = selection?.engine === "opencv" ? selection.jobId : latestLocalJobId;
  useEffect(() => {
    if (!showingArtifacts || !isTauriRuntime() || selection?.engine === "opencv") return;
    let live = true;
    setLocalHistoryError(null);
    void listLocalJobs(experimentId)
      .then(jobs => { if (live) setLatestLocalJobId(jobs.find(job => job.state === "succeeded")?.jobId ?? null); })
      .catch(error => { if (live) setLocalHistoryError(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, [experimentId, selection?.engine, selection?.jobId, showingArtifacts]);
  const inputSamples = trackingData[experimentId] ?? [];
  const versionC = inputSamples.some((sample) => sample.processingVersion === "dlc-adapted-trajectory-c-1");
  const events = useMemo(() => experiment ? reviewEvents(experiment) : [], [experiment]);
  const rawSamples = useMemo(() => inputSamples.map(originalPose), [inputSamples]);
  const detectorTrack = useMemo(
    () => detectorTrajectory(rawSamples, experiment?.video.width ?? 0, experiment?.video.height ?? 0,
      experiment?.video.preparation?.frameCount ?? 0),
    [rawSamples, experiment?.video.width, experiment?.video.height, experiment?.video.preparation?.frameCount],
  );
  const wistarLocal = experiment?.trackingSelection?.engine === "opencv"
    && inputSamples.some(sample => sample.keypoint === "mouse_center" && sample.source === "detected");
  const hasDetectorTrack = (experiment?.trackingSelection?.engine === "colab" || wistarLocal) && detectorTrack.observedFrames > 0;
  const reviewedSamples = useMemo(
    () => applyCorrections(inputSamples, events),
    [events, inputSamples],
  );
  const referencePoint = experiment?.referencePoint && rawSamples.some(sample => sample.keypoint === experiment.referencePoint)
    ? experiment.referencePoint
    : preferredReference(rawSamples);
  const rawReference = useMemo(() => referencePoseSamples(rawSamples,referencePoint),[rawSamples,referencePoint]);
  const reviewedReference = useMemo(() => referencePoseSamples(reviewedSamples,referencePoint),[reviewedSamples,referencePoint]);
  const rawMetrics = useMemo(
    () => experiment && rawReference.length ? calculateOftMetrics(rawReference, experiment.arena, { revision: "raw" }) : null,
    [experiment, rawReference],
  );
  const reviewedMetrics = useMemo(
    () => experiment && reviewedReference.length ? calculateOftMetrics(reviewedReference, experiment.arena, { revision: "reviewed" }) : null,
    [experiment, reviewedReference],
  );
  const boxEstimates=useMemo(()=>experiment&&reviewedSamples.length?calculateObservedFloorBoxMetrics(reviewedSamples,experiment.arena,experiment.video.width,experiment.video.height):null,
    [reviewedSamples,experiment?.arena,experiment?.video.width,experiment?.video.height]);
  const metricSource=trackingSourceKey(experiment?.trackingSelection);
  const fastLocal=experiment?.trackingSelection?.engine==="opencv"&&rawSamples.some(sample=>sample.source==="segmented");
  const metricMode:MetricReferenceMode=metricChoice?.source===metricSource?metricChoice.mode:fastLocal&&Boolean(boxEstimates?.boxFrames)&&!(reviewedMetrics?.validDurationSec)?"floor_box_estimate":"reviewed";
  const shownMetrics=metricMode==="floor_box_estimate"?boxEstimates?.metrics??reviewedMetrics:reviewedMetrics;
  const metrics = reviewedMetrics;
  const samples = reviewedReference;
  const localMetricsReady = experiment?.trackingSelection?.engine !== "opencv" || samples.some(metricEligible);

  if (!experiment) {
    return <div className="page not-found"><h1>Experimento não encontrado</h1><Button onClick={() => navigate({ name: "dashboard" })}>Voltar</Button></div>;
  }
  const workspace = <div key="analysis" hidden={resultView !== "runs"}
    role="tabpanel" id="oft-result-runs-panel" aria-labelledby="oft-result-runs-tab">
    <LocalAnalysisPanel experiment={experiment} selectSource={analysis.selectSource}
      colabBusy={analysis.busy && analysis.activityEngine !== "opencv"}>
      {local => <AnalysisWorkspace experimentId={experimentId} protocol="open_field"
        defaultEngine={experiment.trackingSelection?.engine ?? "colab"} disabled={analysis.loadingResult}
        local={{ ...local, run: () => { setResultView("runs"); local.run(); } }}
        colab={{
          run: () => { setResultView("runs"); void analysis.run(); },
          connected: analysis.summary.connected, job: analysis.activeJob, error: analysis.error,
          panel: <section className="panel results-runs-panel">
            <h2>Execuções no Colab</h2>
            {analysis.history.length ? <div className="analysis-history-list">{analysis.history.map(job =>
              <button type="button" className={`analysis-run analysis-run-${job.status}`} key={job.jobId} disabled={analysis.busy}
                aria-pressed={analysis.activeJob?.jobId === job.jobId}
                onClick={() => {
                  analysis.setSelectedHistoryId(job.jobId);
                  if (job.resultsReady || job.status === "succeeded") void analysis.selectSource({ engine: "colab", jobId: job.jobId });
                }}>
                <strong>{job.modelBundleId || "Colab"}</strong><span>{new Date(job.createdAt).toLocaleString("pt-BR")} · {job.status}</span>
              </button>)}</div> : <p>Nenhuma execução registrada.</p>}
          </section>,
        }} />}
    </LocalAnalysisPanel>
  </div>;
  if (!metrics) {
    return (
      <div className="page results-page">
        <input ref={analysis.fileRef} type="file" accept="video/*" className="sr-only" onChange={analysis.attachFile} />
        <button className="back-link" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16} /> Experimentos</button>
        <section className="page-heading results-heading">
          <div><div className="eyebrow">Análise Completa · Open Field Test</div><h1>{experiment.title}</h1><p>{experiment.subjectId} · Aguardando resultado do tracking</p></div>
        </section>
        <ResultTabs id="oft-result" label="Áreas dos resultados de Campo Aberto" value={resultView} onChange={setResultView} behavior/>
        {resultView === "behavior" && <div role="tabpanel" id="oft-result-behavior-panel" aria-labelledby="oft-result-behavior-tab"><BehaviorAnalysisPanel experiment={experiment} onSelect={analysis.selectSource}/></div>}
        {workspace}
        {resultView === "trajectory" && <div role="tabpanel" id="oft-result-trajectory-panel" aria-labelledby="oft-result-trajectory-tab">
          <RunZoneOccupancy experiment={experiment} samples={inputSamples} colabJobs={analysis.history} loading={analysis.loadingResult} onSelect={analysis.selectSource}/>
        </div>}
        {resultView === "summary" && <><ExperimentRunSummary experiment={experiment} onSelect={analysis.selectSource}/><BehaviorExperimentSummary key={`${metricSource}:${experiment.video.sha256}`} experiment={experiment} onOpen={()=>setResultView("behavior")}/></>}
        {resultView === "video" && <ExperimentVideos experiment={experiment}/>}
        {resultView !== "behavior" && resultView !== "runs" && resultView !== "trajectory" && resultView !== "summary" && resultView !== "video" && <section className="panel results-empty-state"><p>Selecione uma execução concluída na aba Análise ou em Ocupação por zona, na aba Trajetória.</p><Button onClick={()=>setResultView("runs")}>Abrir análise</Button></section>}
        {analysis.loadingResult && <p role="status">Carregando resultado salvo…</p>}
      </div>
    );
  }

  const versionLabel = versionC ? `Versão C · ${events.length} correções desta fonte` : `Dados da análise · ${events.length} correções desta fonte`;

  const exportExperiment = () => {
    const scientificExperiment = {
      schema_version: experiment.schemaVersion,
      analysis_method_version: METRIC_POLICY.version,
      trajectory_postprocess_version: inputSamples[0]?.processingVersion ?? null,
      metric_policy: METRIC_POLICY,
      id: experiment.id,
      test_type: experiment.testType,
      subject_id: experiment.subjectId,
      group: experiment.group,
      video: experiment.video,
      arena: {
        revision: experiment.arena.revision,
        shape: "quadrilateral",
        corners_px: experiment.arena.cornersPx,
        rim_corners_px: experiment.arena.rimCornersPx,
        geometry_role: "floor_calibration_and_enclosure_roi_2d",
        width_cm: experiment.arena.widthCm,
        height_cm: experiment.arena.heightCm,
        center_area_fraction: experiment.arena.centerAreaFraction,
        boundary_policy: experiment.arena.boundaryPolicy,
        occlusion_polygons_px: experiment.arena.occlusionPolygonsPx,
        calibration_version: experiment.arena.calibrationVersion,
        reference_frame_sec: experiment.arena.referenceFrameSec,
      },
      tracking: { reference_point: experiment.referencePoint, max_animals: 1, selection: experiment.trackingSelection,
        analysis_engine: experiment.analysisEngine ?? "superanimal_video_adapt_b_legacy",
        model_bundle_id: experiment.modelBundleId,
        review_source: trackingSourceKey(experiment.trackingSelection), legacy_review_source: experiment.legacyReviewSource,
        reviews: experiment.trackingReviews,
        coordinate_space: "original_video_pixels", posture_classification: "not_performed",
        occluded_points: "not_imputed", recovered_points: "excluded_until_human_confirmation",
        predicted_boxes: "visual_only_excluded_from_metrics", macro_reference: "geometric_not_anatomical" },
    };
    downloadText("experiment.json", JSON.stringify(scientificExperiment, null, 2), "application/json");
  };

  const exportBoxEstimates=()=>{
    if(!boxEstimates)return;
    const {revision: _revision,...values}=boxEstimates.metrics;
    downloadText("box_metrics_estimated.json",JSON.stringify({schemaVersion:"oft-box-estimates-1",experimentId:experiment.id,
      trackingSelection:experiment.trackingSelection,videoSha256:experiment.video.sha256,arenaRevision:experiment.arena.revision,
      policy:boxEstimates.policy,metrics:values,frameCount:boxEstimates.frameCount,boxFrames:boxEstimates.boxFrames,
      eligibleFloorFrames:boxEstimates.eligibleFloorFrames,exclusions:boxEstimates.exclusions,
      corrections:events,calibration:experiment.arena,scope:"observed_consecutive_floor_intervals_only"},null,2),"application/json");
  };

  const exportCorrections = () => {
    downloadText("corrections.jsonl", experiment.corrections.map((event) => JSON.stringify(event)).join("\n"), "application/x-ndjson");
  };

  return (
    <div className="page results-page">
      <input ref={analysis.fileRef} type="file" accept="video/*" className="sr-only" onChange={analysis.attachFile} />
      <button className="back-link" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16} /> Experimentos</button>
      <section className="page-heading results-heading">
        <div>
          <div className="eyebrow">Análise Completa · Open Field Test</div>
          <h1>{experiment.title}</h1>
          <p>{experiment.subjectId}{experiment.group ? ` · ${experiment.group}` : ""} · Método {METRIC_POLICY.version}</p>
        </div>
        <div className="results-actions">
          <Button variant="secondary" icon={<Download size={16} />} onClick={() => setResultView("exports")}>Exportar</Button>
          <Button icon={<Check size={16} />} disabled={analysis.busy || !localMetricsReady} onClick={() => updateExperiment(experiment.id, { status: "completed" })}>Concluir análise</Button>
        </div>
      </section>
      {analysis.error && resultView !== "runs" && <div className="validation-box invalid"><AlertTriangle size={16} />{analysis.error}</div>}
      <ResultTabs id="oft-result" label="Áreas dos resultados de Campo Aberto" value={resultView} onChange={setResultView} behavior/>
      {resultView === "behavior" && <div role="tabpanel" id="oft-result-behavior-panel" aria-labelledby="oft-result-behavior-tab"><BehaviorAnalysisPanel experiment={experiment} onSelect={analysis.selectSource}/></div>}
      {workspace}

      <div role="tabpanel" id="oft-result-exports-panel" aria-labelledby="oft-result-exports-tab" hidden={resultView !== "exports"}>
        <section className="export-drawer panel">
          <div><PackageOpen size={22} /><div><h2>Exportações reprodutíveis</h2><p>Os arquivos identificam a execução e as correções históricas.</p></div></div>
          <div className="export-buttons">
            <Button size="sm" variant="secondary" onClick={exportExperiment}>experiment.json</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadText("poses_raw.csv", poseToCsv(rawSamples), "text/csv")}>poses_raw.csv</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadText("poses_reviewed.csv", poseToCsv(reviewedSamples), "text/csv")}>poses_reviewed.csv</Button>
            <Button size="sm" variant="secondary" onClick={exportCorrections}>corrections.jsonl</Button>
            {rawSamples.some(sample => sample.features) && <Button size="sm" variant="secondary" onClick={() => downloadText("motion_features.jsonl",
              rawSamples.map(sample => JSON.stringify({ frameIndex: sample.frameIndex, timestampSec: sample.timestampSec,
                source: sample.source, status: sample.status, reason: sample.reason, features: sample.features ?? null,
                trackingAccepted: sample.trackingAccepted, localQuality: sample.localQuality, kalmanUpdated: sample.kalmanUpdated,
                runId: experiment.trackingSelection?.jobId, videoSha256: experiment.video.sha256 })).join("\n") + "\n", "application/x-ndjson")}>motion_features.jsonl</Button>}
            <Button size="sm" variant="secondary" onClick={() => downloadText("metrics.csv", metricsCsv(metrics), "text/csv")}>metrics.csv</Button>
            {boxEstimates&&boxEstimates.boxFrames>0&&<Button size="sm" variant="secondary" onClick={exportBoxEstimates}>box_metrics_estimated.json</Button>}
            {rawMetrics && <Button size="sm" variant="secondary" onClick={() => downloadText("metrics_raw.csv", metricsCsv(rawMetrics), "text/csv")}>metrics_raw.csv</Button>}
          </div>
        </section>
      </div>

      <div role="tabpanel" id="oft-result-summary-panel" aria-labelledby="oft-result-summary-tab" hidden={resultView !== "summary"}>
      {resultView === "summary" && <ExperimentRunSummary experiment={experiment} onSelect={analysis.selectSource}/>}
      <section className="results-context panel">
        <Badge tone="info">Resultados da análise</Badge>
        {hasDetectorTrack ? <>
          <Badge tone={detectorTrack.coveragePct >= 90 ? "success" : "warning"} dot>Caixa detectada {detectorTrack.coveragePct.toFixed(1)}%</Badge>
          <span>Tempo utilizável nos indicadores: {(shownMetrics??metrics).coveragePct.toFixed(1)}%</span>
        </> : <Badge tone={(shownMetrics??metrics).coveragePct >= 90 ? "success" : "warning"} dot>Pares utilizáveis {(shownMetrics??metrics).coveragePct.toFixed(1)}%</Badge>}
        <span>{versionLabel}</span>
        <span>{experiment.video.timingSource === "synthetic" ? "Dados sintéticos"
          : wistarLocal ? "Máquina local · Wistar + HRNet"
          : experiment.trackingSelection?.engine === "opencv" ? "OpenCV · caixa / silhueta" : "Colab · pontos anatômicos"}</span>
        <span>Centro: {Math.round(experiment.arena.centerAreaFraction * 100)}% da área</span>
      </section>

      {hasDetectorTrack && <p className="results-detector-note">A cobertura da caixa mede frames com detecção observada ({detectorTrack.observedFrames.toLocaleString("pt-BR")}/{detectorTrack.totalFrames.toLocaleString("pt-BR")}); não mede acurácia anatômica. Os indicadores abaixo usam a referência selecionada e somente pares consecutivos no piso.</p>}
      <OpenFieldMetricSummary metrics={shownMetrics??metrics} mode={metricMode} onModeChange={mode=>setMetricChoice({source:metricSource,mode})}
        hasBoxes={Boolean(boxEstimates?.boxFrames)} hasPendingReference={Boolean(boxEstimates?.pendingReferenceFrames)} onExport={exportBoxEstimates}
        behavior={resultView==="summary"?<BehaviorExperimentSummary key={`${metricSource}:${experiment.video.sha256}`} experiment={experiment} onOpen={()=>setResultView("behavior")}/>:undefined}/>

      </div>

      <div role="tabpanel" id="oft-result-video-panel" aria-labelledby="oft-result-video-tab" hidden={resultView !== "video"}>
      {resultView === "video" && <ExperimentVideos experiment={experiment}/>}
      </div>

      <div role="tabpanel" id="oft-result-trajectory-panel" aria-labelledby="oft-result-trajectory-tab" hidden={resultView !== "trajectory"}>
      {resultView === "trajectory" && <>
      <div className="results-trajectory-grid">
        <RunTrajectory key={`colab:${selectedColabJobId}`} experiment={experiment} engine="colab" jobId={selectedColabJobId}
          currentSamples={selection?.engine === "colab" || (!selection && !selectedColabJobId) ? inputSamples : undefined} />
        <RunTrajectory key={`opencv:${selectedLocalJobId}`} experiment={experiment} engine="opencv" jobId={selectedLocalJobId}
          currentSamples={selection?.engine === "opencv" ? inputSamples : undefined} />
      </div>
      {localHistoryError && <p className="results-video-message" role="alert">{localHistoryError}</p>}

        <RunZoneOccupancy experiment={experiment} samples={inputSamples} colabJobs={analysis.history}
          loading={analysis.loadingResult} onSelect={analysis.selectSource}/>
      </>}
      </div>

      <div role="tabpanel" id="oft-result-details-panel" aria-labelledby="oft-result-details-tab" hidden={resultView !== "details"}>
      {resultView === "details" && <TrackingDetails experiment={experiment} samples={reviewedSamples}>
        <RunZoneOccupancy experiment={experiment} samples={inputSamples} colabJobs={analysis.history} loading={analysis.loadingResult} onSelect={analysis.selectSource}/>
        <Card className="detail-table-card">
          <CardHeader><CardTitle>{metricMode==="floor_box_estimate"?"Indicadores geométricos complementares":"Métricas complementares"}</CardTitle><CardDescription>{metricMode==="floor_box_estimate"?"Estimativas nos trechos observados no piso.":"Definições operacionais versionadas."}</CardDescription></CardHeader>
          <CardContent className="detail-table">
            <div><span><Clock3 size={16} /> Duração observada</span><strong>{formatDuration((shownMetrics??metrics).analysisDurationSec)}</strong></div>
            <div><span><ShieldCheck size={16} /> Tempo utilizável</span><strong>{formatDuration((shownMetrics??metrics).validDurationSec)}</strong></div>
            <div><span><TimerReset size={16} /> Latência até o centro</span><strong>{(shownMetrics??metrics).centerLatencySec == null ? "Não observada" : formatDuration((shownMetrics??metrics).centerLatencySec!)}</strong></div>
            <div><span><Footprints size={16} /> {metricMode==="floor_box_estimate"?"Tempo abaixo de 2 cm/s":"Imobilidade operacional"}</span><strong>{(shownMetrics??metrics).validDurationSec>0?formatDuration((shownMetrics??metrics).immobilityTimeSec):"Não mensurável"}</strong></div>
          </CardContent>
        </Card>

        <section className="interpretation-card">
          <div className="interpretation-icon"><Info size={20} /></div>
          <div><h3>Interpretação responsável</h3><p>Tempo no centro é um indicador comportamental, não um diagnóstico de ansiedade. Interprete com distância, cobertura, protocolo, iluminação e possíveis efeitos motores.</p></div>
        </section>
      </TrackingDetails>}

      {(shownMetrics??metrics).coveragePct < 90 && (
        <div className="coverage-warning"><AlertTriangle size={18} /><div><strong>Tempo utilizável nos indicadores abaixo de 90%</strong><span>{metricMode==="floor_box_estimate"?"A estimativa considera apenas pares consecutivos de caixas aceitas no piso. Confira a calibração e os trechos excluídos antes de interpretar o resultado.":hasDetectorTrack ? "O detector acompanhou o animal, mas o ponto anatômico escolhido teve baixa confiança em muitos frames. As métricas permanecem parciais; revise os pontos antes de comparar grupos." : "Resultados são parciais. Revise pontos ausentes antes de comparar grupos."}</span></div></div>
      )}
      {experiment.status === "completed" && <div className="completed-toast"><CheckCircle2 size={17} /> Análise marcada como concluída neste dispositivo.</div>}
      </div>
    </div>
  );
}
