import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  CloudCog,
  Download,
  Footprints,
  Gauge,
  Info,
  Map,
  PackageOpen,
  RefreshCw,
  Route,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { applyCorrections } from "../../lib/corrections";
import { detectorTrajectory } from "../../lib/boxes";
import { preferredReference, reviewEvents, trackingSourceKey } from "../../lib/tracking-reviews";
import { downloadText, poseToCsv } from "../../lib/csv";
import { centerPolygonPx, pointsToSvg } from "../../lib/geometry";
import { calculateOftMetrics, METRIC_POLICY } from "../../lib/metrics";
import { metricEligible, originalPose, referencePoseSamples, trajectorySegments } from "../../lib/pose";
import { formatDuration } from "../../lib/format";
import { useAppStore } from "../../store/AppStore";
import { loadColabVideo } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { AnalysisWorkflow } from "../colab/AnalysisWorkflow";
import { useAnalysis } from "./useAnalysis";
import type { OftMetrics } from "../../types";

function metricValue(value: number | null, suffix: string, digits = 1) {
  return value == null ? "Não mensurável" : `${value.toFixed(digits)} ${suffix}`;
}

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
  const experiment = getExperiment(experimentId);
  const [trajectorySource, setTrajectorySource] = useState<"detector" | "anatomical">("detector");
  const [showExport, setShowExport] = useState(false);
  const [videoExportError, setVideoExportError] = useState<string | null>(null);
  const [modelVideo, setModelVideo] = useState<{ jobId: string; videoUrl: string | null; videoError: string | null } | null>(null);
  const [modelVideoLoading, setModelVideoLoading] = useState(false);
  const [modelVideoPlaybackError, setModelVideoPlaybackError] = useState(false);
  const [modelVideoRefresh, setModelVideoRefresh] = useState(0);
  const selectedColabJobId = experiment?.trackingSelection?.engine === "colab" ? experiment.trackingSelection.jobId : null;
  const selectedColabStage = analysis.history.find((job) => job.jobId === selectedColabJobId);
  const selectedVideoStage = `${selectedColabStage?.status}:${selectedColabStage?.stage}`;
  const activeModelVideo = modelVideo?.jobId === selectedColabJobId ? modelVideo : null;

  useEffect(() => {
    if (!selectedColabJobId || !isTauriRuntime()) return;
    let cancelled = false;
    setModelVideoLoading(true);
    setModelVideoPlaybackError(false);
    void loadColabVideo(selectedColabJobId)
      .then((video) => { if (!cancelled) setModelVideo(video); })
      .catch((error) => {
        if (!cancelled) setModelVideo({
          jobId: selectedColabJobId,
          videoUrl: null,
          videoError: typeof error === "string" ? error : "Não foi possível consultar o vídeo desta análise.",
        });
      })
      .finally(() => { if (!cancelled) setModelVideoLoading(false); });
    return () => { cancelled = true; };
  }, [selectedColabJobId, selectedVideoStage, modelVideoRefresh]);
  const inputSamples = trackingData[experimentId] ?? [];
  const versionC = inputSamples.some((sample) => sample.processingVersion === "dlc-adapted-trajectory-c-1");
  const events = useMemo(() => experiment ? reviewEvents(experiment) : [], [experiment]);
  const rawSamples = useMemo(() => inputSamples.map(originalPose), [inputSamples]);
  const detectorTrack = useMemo(
    () => detectorTrajectory(rawSamples, experiment?.video.width ?? 0, experiment?.video.height ?? 0,
      experiment?.video.preparation?.frameCount ?? 0),
    [rawSamples, experiment?.video.width, experiment?.video.height, experiment?.video.preparation?.frameCount],
  );
  const hasDetectorTrack = experiment?.trackingSelection?.engine === "colab" && detectorTrack.observedFrames > 0;
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
  const metrics = reviewedMetrics;
  const samples = reviewedReference;

  if (!experiment) {
    return <div className="page not-found"><h1>Experimento não encontrado</h1><Button onClick={() => navigate({ name: "dashboard" })}>Voltar</Button></div>;
  }
  if (!metrics) {
    return (
      <div className="page results-page">
        <input ref={analysis.fileRef} type="file" accept="video/*" className="sr-only" onChange={analysis.attachFile} />
        <button className="back-link" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16} /> Experimentos</button>
        <section className="page-heading results-heading">
          <div><div className="eyebrow">Análise Completa · Open Field Test</div><h1>{experiment.title}</h1><p>{experiment.subjectId} · Aguardando resultado do tracking</p></div>
          <div className="results-actions">
            <Button variant="secondary" icon={<CloudCog size={16} />} onClick={() => navigate({ name: "colab" })}>{analysis.summary.connected ? "Colab conectado" : "Conectar Colab"}</Button>
            <Button disabled={analysis.busy || analysis.loadingResult || !analysis.summary.connected} onClick={() => void analysis.run()}>{analysis.busy ? "Processando…" : "Analisar no Colab"}</Button>
          </div>
        </section>
        {analysis.error && <div className="validation-box invalid"><AlertTriangle size={16} />{analysis.error}</div>}
        <AnalysisWorkflow job={analysis.activeJob} preparing={analysis.busy && !analysis.activeJob} message={analysis.message}
          localError={analysis.error} elapsedSec={analysis.elapsedSec} />
        {analysis.loadingResult && <p role="status">Carregando resultado salvo…</p>}
        {analysis.history.length > 0 && <div className="analysis-history-list">{analysis.history.map((job) =>
          <button type="button" className={`analysis-run analysis-run-${job.status}`} key={job.jobId}
            onClick={() => { analysis.setSelectedHistoryId(job.jobId); if (job.resultsReady || job.status === "succeeded") void analysis.selectSource({ engine: "colab", jobId: job.jobId }); }}>
            <div><strong>{job.modelBundleId || "Colab"}</strong><small>{new Date(job.createdAt).toLocaleString("pt-BR")} · {job.status}</small></div>
          </button>)}</div>}
      </div>
    );
  }

  const centerPolygon = centerPolygonPx(experiment.arena);
  const displayDetectorTrack = hasDetectorTrack && trajectorySource === "detector";
  const trajectory = displayDetectorTrack ? detectorTrack.segments
    : trajectorySegments(samples.map((sample) => metricEligible(sample) ? sample : { ...sample, status: "missing" }));
  const startPoint = trajectory[0]?.[0], endPoint = trajectory.at(-1)?.at(-1);
  const centerPct = metrics.centerPctClassifiable ?? 0;
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

  const exportCorrections = () => {
    downloadText("corrections.jsonl", experiment.corrections.map((event) => JSON.stringify(event)).join("\n"), "application/x-ndjson");
  };

  const exportColabVideo = async () => {
    if (!activeModelVideo?.videoUrl) return;
    setVideoExportError(null);
    try {
      const response = await fetch(activeModelVideo.videoUrl);
      if (!response.ok) throw new Error("O MP4 salvo não pôde ser lido.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${experiment.id}-analise-colab.mp4`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setVideoExportError(error instanceof Error ? error.message : "Não foi possível exportar o MP4 da análise.");
    }
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
          <Button variant="secondary" icon={<CloudCog size={16} />} onClick={() => navigate({ name: "colab" })}>{analysis.summary.connected ? "Colab conectado" : "Conectar Colab"}</Button>
          <Button variant="secondary" disabled={analysis.busy || !analysis.summary.connected} onClick={() => void analysis.run()}>{analysis.busy ? "Processando…" : "Reprocessar"}</Button>
          <Button variant="secondary" icon={<Download size={16} />} onClick={() => setShowExport((current) => !current)}>Exportar</Button>
          <Button icon={<Check size={16} />} disabled={analysis.busy} onClick={() => updateExperiment(experiment.id, { status: "completed" })}>Concluir análise</Button>
        </div>
      </section>
      {analysis.error && <div className="validation-box invalid"><AlertTriangle size={16} />{analysis.error}</div>}
      {analysis.busy && <AnalysisWorkflow job={analysis.activeJob} preparing={!analysis.activeJob} message={analysis.message}
        localError={analysis.error} elapsedSec={analysis.elapsedSec} />}
      {analysis.history.filter((job) => job.resultsReady || job.status === "succeeded").length > 1 &&
        <label className="results-source-select">Execução exibida
          <select value={experiment.trackingSelection?.engine === "colab" ? experiment.trackingSelection.jobId : ""}
            onChange={(event) => void analysis.selectSource({ engine: "colab", jobId: event.target.value })}>
            {experiment.trackingSelection?.engine !== "colab" && <option value="">Resultado atual</option>}
            {experiment.trackingSelection?.engine === "colab" && !analysis.history.some((job) => job.jobId === experiment.trackingSelection?.jobId)
              && <option value={experiment.trackingSelection.jobId}>Execução atual · {experiment.trackingSelection.jobId.slice(0, 8)}</option>}
            {analysis.history.filter((job) => job.resultsReady || job.status === "succeeded").map((job) =>
              <option key={job.jobId} value={job.jobId}>{job.modelBundleId || "Colab"} · {new Date(job.createdAt).toLocaleString("pt-BR")}</option>)}
          </select>
        </label>}
      {videoExportError && <div className="validation-box invalid"><AlertTriangle size={16} />{videoExportError}</div>}

      {showExport && (
        <section className="export-drawer panel">
          <div><PackageOpen size={22} /><div><h2>Exportações reprodutíveis</h2><p>Os arquivos identificam a execução e as correções históricas.</p></div></div>
          <div className="export-buttons">
            <Button size="sm" variant="secondary" onClick={exportExperiment}>experiment.json</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadText("poses_raw.csv", poseToCsv(rawSamples), "text/csv")}>poses_raw.csv</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadText("poses_reviewed.csv", poseToCsv(reviewedSamples), "text/csv")}>poses_reviewed.csv</Button>
            <Button size="sm" variant="secondary" onClick={exportCorrections}>corrections.jsonl</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadText("metrics.csv", metricsCsv(metrics), "text/csv")}>metrics.csv</Button>
            {rawMetrics && <Button size="sm" variant="secondary" onClick={() => downloadText("metrics_raw.csv", metricsCsv(rawMetrics), "text/csv")}>metrics_raw.csv</Button>}
          </div>
        </section>
      )}

      <section className="results-context panel">
        <Badge tone="info">Resultados da análise</Badge>
        {hasDetectorTrack ? <>
          <Badge tone={detectorTrack.coveragePct >= 90 ? "success" : "warning"} dot>Caixa detectada {detectorTrack.coveragePct.toFixed(1)}%</Badge>
          <span>Tempo válido nas métricas: {metrics.coveragePct.toFixed(1)}%</span>
        </> : <Badge tone={metrics.coveragePct >= 90 ? "success" : "warning"} dot>Cobertura {metrics.coveragePct.toFixed(1)}%</Badge>}
        <span>{versionLabel}</span>
        <span>{experiment.video.timingSource === "synthetic" ? "Dados sintéticos" : experiment.trackingSelection?.engine === "opencv" ? "OpenCV · caixa / silhueta" : "Colab · pontos anatômicos"}</span>
        <span>Centro: {Math.round(experiment.arena.centerAreaFraction * 100)}% da área</span>
      </section>

      {hasDetectorTrack && <p className="results-detector-note">A cobertura da caixa mede frames com detecção observada ({detectorTrack.observedFrames.toLocaleString("pt-BR")}/{detectorTrack.totalFrames.toLocaleString("pt-BR")}); não mede acurácia anatômica. Distância, velocidade e zonas abaixo continuam calculadas apenas com a referência anatômica válida.</p>}

      {selectedColabJobId && (
        <section className="results-video-section" aria-label="Vídeo com pontos anatômicos da análise Colab">
          <div className="results-video-heading">
            <div>
              <h2>Vídeo {experiment.analysisEngine === "wistar_superanimal_hybrid_v1" ? "científico" : "exportado"} da análise</h2>
              <p>MP4 do Colab para esta execução. {experiment.analysisEngine === "wistar_superanimal_hybrid_v1" && "O gráfico, quando presente, usa o mouse_center bruto do modelo. "}As métricas abaixo incluem eventuais correções antigas desta execução.</p>
            </div>
            <Button size="sm" variant="secondary" icon={<RefreshCw size={15} />} disabled={modelVideoLoading}
              onClick={() => setModelVideoRefresh((value) => value + 1)}>Recarregar</Button>
            {activeModelVideo?.videoUrl && <Button size="sm" variant="secondary" icon={<Download size={15} />}
              onClick={() => void exportColabVideo()}>Baixar MP4</Button>}
          </div>
          <div className="dlc-video-panel results-video-player">
            {modelVideoLoading ? <p className="results-video-message" role="status">Carregando vídeo salvo no dispositivo…</p>
              : activeModelVideo?.videoUrl ? (
                <>
                  <video key={activeModelVideo.jobId} src={activeModelVideo.videoUrl} controls playsInline preload="metadata"
                    aria-label="Vídeo da análise Colab com pontos anatômicos"
                    onError={() => setModelVideoPlaybackError(true)} />
                  {modelVideoPlaybackError && <p className="results-video-message" role="alert">O player não conseguiu reproduzir este MP4. As métricas da execução continuam disponíveis abaixo.</p>}
                </>
              ) : <p className="results-video-message" role="status">{activeModelVideo?.videoError ?? "Esta análise ainda não disponibilizou um vídeo. Recarregue após a renderização terminar ou consulte o diário da execução."}</p>}
          </div>
        </section>
      )}

      <section className="metric-grid">
        <article className="metric-card"><div className="metric-icon distance"><Route size={20} /></div><span>Distância válida</span><strong>{metricValue(metrics.distanceCm, "cm")}</strong><small>Sem unir lacunas</small></article>
        <article className="metric-card"><div className="metric-icon speed"><Gauge size={20} /></div><span>Velocidade média</span><strong>{metricValue(metrics.meanSpeedCmS, "cm/s", 2)}</strong><small>Tempo de pares válidos</small></article>
        <article className="metric-card"><div className="metric-icon center-time"><Map size={20} /></div><span>Tempo no centro</span><strong>{metricValue(metrics.validDurationSec > 0 ? metrics.centerTimeSec : null, "s")}</strong><small>{metrics.centerPctClassifiable?.toFixed(1) ?? "—"}% do classificável</small></article>
        <article className="metric-card"><div className="metric-icon entries"><Footprints size={20} /></div><span>Entradas observadas no centro</span><strong>{metrics.validDurationSec > 0 ? metrics.centerEntries : "Não mensurável"}</strong><small>Com dwell mínimo de 0,2 s</small></article>
      </section>

      <div className="results-main-grid">
        <section className="panel trajectory-card">
          <div className="panel-header"><div><h2>Trajetória espacial</h2><p>{displayDetectorTrack ? "Centro geométrico das caixas observadas, sem preencher frames sem detecção." : "Segmentos válidos da referência anatômica ou do centro da caixa, com correções aplicadas."}</p></div><Badge>{displayDetectorTrack ? "Caixa do detector" : versionC ? "Versão C" : "Referência 2D"}</Badge></div>
          {hasDetectorTrack && <div className="trajectory-source-toggle" role="group" aria-label="Origem da trajetória">
            <button type="button" className={displayDetectorTrack ? "active" : ""} aria-pressed={displayDetectorTrack} onClick={() => setTrajectorySource("detector")}>Caixa do detector</button>
            <button type="button" className={!displayDetectorTrack ? "active" : ""} aria-pressed={!displayDetectorTrack} onClick={() => setTrajectorySource("anatomical")}>Ponto anatômico</button>
          </div>}
          <div className="trajectory-canvas">
            <svg viewBox={`0 0 ${experiment.video.width} ${experiment.video.height}`} preserveAspectRatio="xMidYMid meet">
              <rect width={experiment.video.width} height={experiment.video.height} fill="#f1f3ee" />
              <polygon points={pointsToSvg(experiment.arena.cornersPx)} fill="#e7eae3" stroke="#9ca9a2" strokeWidth="5" />
              <polygon points={pointsToSvg(centerPolygon)} fill="#85ae98" fillOpacity=".11" stroke="#4ca383" strokeWidth="3" strokeDasharray="10 8" />
              {trajectory.map((segment, index) => <polyline key={index} points={pointsToSvg(segment)} fill="none" stroke={displayDetectorTrack ? "#f0f0ed" : "#a7adb2"} strokeWidth={displayDetectorTrack ? "2.5" : "4"} strokeOpacity=".82" strokeLinecap="round" strokeLinejoin="round" />)}
              {startPoint && <circle cx={startPoint.x} cy={startPoint.y} r="9" fill="#a7adb2" stroke="#242628" strokeWidth="3" />}
              {endPoint && <circle cx={endPoint.x} cy={endPoint.y} r="9" fill="#242628" />}
            </svg>
            <div className="trajectory-legend"><span><i className="start" /> Início</span><span><i className="end" /> Fim</span><span><i className="center" /> Centro</span>{displayDetectorTrack && <span><i className="detector" /> Caixa observada</span>}</div>
          </div>
        </section>

        <section className="panel zone-card">
          <div className="panel-header compact"><div><h2>Ocupação por zona</h2><p>Percentual do tempo classificável.</p></div></div>
          <div className="zone-donut" style={{ background: `conic-gradient(#00d9a0 0 ${centerPct}%, #34594e ${centerPct}% 100%)` }}><div><strong>{centerPct.toFixed(1)}%</strong><span>no centro</span></div></div>
          <div className="zone-breakdown">
            <div><span><i className="center" /> Centro</span><strong>{formatDuration(metrics.centerTimeSec)}</strong></div>
            <div><span><i className="periphery" /> Periferia</span><strong>{formatDuration(metrics.peripheralTimeSec)}</strong></div>
            <div><span><i className="unknown" /> Desconhecido</span><strong>{formatDuration(metrics.unknownTimeSec)}</strong></div>
          </div>
        </section>
      </div>

      <div className="results-detail-grid">
        <section className="panel detail-table-card">
          <div className="panel-header compact"><div><h2>Métricas complementares</h2><p>Definições operacionais versionadas.</p></div></div>
          <div className="detail-table">
            <div><span><Clock3 size={16} /> Duração observada</span><strong>{formatDuration(metrics.analysisDurationSec)}</strong></div>
            <div><span><ShieldCheck size={16} /> Duração válida</span><strong>{formatDuration(metrics.validDurationSec)}</strong></div>
            <div><span><TimerReset size={16} /> Latência até o centro</span><strong>{metrics.centerLatencySec == null ? "Não observada" : formatDuration(metrics.centerLatencySec)}</strong></div>
            <div><span><Footprints size={16} /> Imobilidade operacional</span><strong>{formatDuration(metrics.immobilityTimeSec)}</strong></div>
          </div>
        </section>

        <section className="interpretation-card">
          <div className="interpretation-icon"><Info size={20} /></div>
          <div><h3>Interpretação responsável</h3><p>Tempo no centro é um indicador comportamental, não um diagnóstico de ansiedade. Interprete com distância, cobertura, protocolo, iluminação e possíveis efeitos motores.</p></div>
        </section>
      </div>

      {metrics.coveragePct < 90 && (
        <div className="coverage-warning"><AlertTriangle size={18} /><div><strong>Tempo válido para métricas abaixo de 90%</strong><span>{hasDetectorTrack ? "O detector acompanhou o animal, mas o ponto anatômico escolhido teve baixa confiança em muitos frames. As métricas permanecem parciais; revise os pontos antes de comparar grupos." : "Resultados são parciais. Revise pontos ausentes antes de comparar grupos."}</span></div></div>
      )}
      {experiment.status === "completed" && <div className="completed-toast"><CheckCircle2 size={17} /> Análise marcada como concluída neste dispositivo.</div>}
    </div>
  );
}
