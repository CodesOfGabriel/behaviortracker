import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  Footprints,
  Gauge,
  Info,
  Map,
  PackageOpen,
  Route,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { applyCorrections } from "../../lib/corrections";
import { downloadText, poseToCsv } from "../../lib/csv";
import { centerPolygonPx, pointsToSvg } from "../../lib/geometry";
import { calculateOftMetrics, METRIC_POLICY } from "../../lib/metrics";
import { BEHAVIOR_LABELS, BEHAVIOR_POLICY, behaviorCsv, behaviorSummary } from "../../lib/behaviors";
import { metricEligible, originalPose, trajectorySegments } from "../../lib/pose";
import { formatDuration } from "../../lib/format";
import { useAppStore } from "../../store/AppStore";
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
  const experiment = getExperiment(experimentId);
  const [revision, setRevision] = useState<"reviewed" | "raw">("reviewed");
  const [showExport, setShowExport] = useState(false);
  const inputSamples = trackingData[experimentId] ?? [];
  const rawSamples = useMemo(() => inputSamples.map(originalPose), [inputSamples]);
  const reviewedSamples = useMemo(
    () => experiment ? applyCorrections(inputSamples, experiment.corrections) : inputSamples,
    [experiment, inputSamples],
  );
  const referencePoint = experiment?.referencePoint ?? "body_center";
  const rawReference = rawSamples.filter((sample) => sample.keypoint === referencePoint);
  const reviewedReference = reviewedSamples.filter((sample) => sample.keypoint === referencePoint);
  const rawMetrics = useMemo(
    () => experiment && rawReference.length ? calculateOftMetrics(rawReference, experiment.arena, { revision: "raw" }) : null,
    [experiment, rawReference],
  );
  const reviewedMetrics = useMemo(
    () => experiment && reviewedReference.length ? calculateOftMetrics(reviewedReference, experiment.arena, { revision: "reviewed" }) : null,
    [experiment, reviewedReference],
  );
  const metrics = revision === "reviewed" ? reviewedMetrics : rawMetrics;
  const samples = revision === "reviewed" ? reviewedReference : rawReference;

  if (!experiment) {
    return <div className="page not-found"><h1>Experimento não encontrado</h1><Button onClick={() => navigate({ name: "dashboard" })}>Voltar</Button></div>;
  }
  if (!metrics) {
    return (
      <div className="page not-found"><h1>Não há tracking para calcular</h1><p>Processe o vídeo no Colab antes de abrir os resultados.</p><Button onClick={() => navigate({ name: "editor", experimentId })}>Abrir editor</Button></div>
    );
  }

  const centerPolygon = centerPolygonPx(experiment.arena);
  const trajectory = trajectorySegments(samples.map((sample) => metricEligible(sample) ? sample : { ...sample, status: "missing" }));
  const startPoint = trajectory[0]?.[0], endPoint = trajectory.at(-1)?.at(-1);
  const behaviors = behaviorSummary(experiment, experiment.video.durationSec);
  const centerPct = metrics.centerPctClassifiable ?? 0;
  const versionLabel = revision === "reviewed" ? `Revisão · ${experiment.corrections.length} eventos` : "Inferência bruta";

  const exportExperiment = () => {
    const scientificExperiment = {
      schema_version: experiment.schemaVersion,
      analysis_method_version: METRIC_POLICY.version,
      metric_policy: METRIC_POLICY,
      behavior_policy: BEHAVIOR_POLICY,
      behavior_reviewed: experiment.behaviorReviewed ?? {},
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
      },
      tracking: { reference_point: experiment.referencePoint, max_animals: 1,
        coordinate_space: "original_video_pixels", posture_classification: "human_reviewed_candidates",
        occluded_points: "not_imputed", recovered_points: "excluded_until_human_confirmation" },
    };
    downloadText("experiment.json", JSON.stringify(scientificExperiment, null, 2), "application/json");
  };

  const exportCorrections = () => {
    downloadText("corrections.jsonl", experiment.corrections.map((event) => JSON.stringify(event)).join("\n"), "application/x-ndjson");
  };

  return (
    <div className="page results-page">
      <button className="back-link" onClick={() => navigate({ name: "editor", experimentId })}><ArrowLeft size={16} /> Voltar ao editor</button>
      <section className="page-heading results-heading">
        <div>
          <div className="eyebrow">Resultados · Open Field Test</div>
          <h1>{experiment.title}</h1>
          <p>{experiment.subjectId}{experiment.group ? ` · ${experiment.group}` : ""} · Método {METRIC_POLICY.version}</p>
        </div>
        <div className="results-actions">
          <Button variant="secondary" icon={<Download size={16} />} onClick={() => setShowExport((current) => !current)}>Exportar</Button>
          <Button icon={<Check size={16} />} onClick={() => updateExperiment(experiment.id, { status: "completed" })}>Concluir revisão</Button>
        </div>
      </section>

      {showExport && (
        <section className="export-drawer panel">
          <div><PackageOpen size={22} /><div><h2>Exportações reprodutíveis</h2><p>Arquivos identificam a revisão; o vídeo não é incluído automaticamente.</p></div></div>
          <div className="export-buttons">
            <Button size="sm" variant="secondary" onClick={exportExperiment}>experiment.json</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadText("poses_reviewed.csv", poseToCsv(reviewedSamples), "text/csv")}>poses_reviewed.csv</Button>
            <Button size="sm" variant="secondary" onClick={exportCorrections}>corrections.jsonl</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadText("metrics.csv", metricsCsv(metrics), "text/csv")}>metrics.csv</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadText("behaviors.csv", behaviorCsv(experiment, experiment.video.durationSec), "text/csv")}>behaviors.csv</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadText("behavior_summary.csv", ["behavior,count,duration_sec,review_status,source",
              ...behaviors.map((item) => `${item.label},${item.count ?? ""},${item.durationSec ?? ""},${item.reviewed ? "complete_review" : "partial_review"},human_confirmed`)].join("\n"), "text/csv")}>behavior_summary.csv</Button>
          </div>
        </section>
      )}

      <section className="results-context panel">
        <div className="segmented-control">
          <button className={revision === "reviewed" ? "active" : ""} onClick={() => setRevision("reviewed")}>Dados revisados</button>
          <button className={revision === "raw" ? "active" : ""} onClick={() => setRevision("raw")}>Dados brutos</button>
        </div>
        <div className="context-divider" />
        <Badge tone={metrics.coveragePct >= 90 ? "success" : "warning"} dot>Cobertura {metrics.coveragePct.toFixed(1)}%</Badge>
        <span>{versionLabel}</span>
        <span>Centro: {Math.round(experiment.arena.centerAreaFraction * 100)}% da área</span>
      </section>

      <section className="metric-grid">
        <article className="metric-card"><div className="metric-icon green"><Route size={20} /></div><span>Distância válida</span><strong>{metricValue(metrics.distanceCm, "cm")}</strong><small>Sem unir lacunas</small></article>
        <article className="metric-card"><div className="metric-icon blue"><Gauge size={20} /></div><span>Velocidade média</span><strong>{metricValue(metrics.meanSpeedCmS, "cm/s", 2)}</strong><small>Tempo de pares válidos</small></article>
        <article className="metric-card"><div className="metric-icon amber"><Map size={20} /></div><span>Tempo no centro</span><strong>{metricValue(metrics.validDurationSec > 0 ? metrics.centerTimeSec : null, "s")}</strong><small>{metrics.centerPctClassifiable?.toFixed(1) ?? "—"}% do classificável</small></article>
        <article className="metric-card"><div className="metric-icon purple"><Footprints size={20} /></div><span>Entradas observadas no centro</span><strong>{metrics.validDurationSec > 0 ? metrics.centerEntries : "Não mensurável"}</strong><small>Com dwell mínimo de 0,2 s</small></article>
      </section>

      <div className="results-main-grid">
        <section className="panel trajectory-card">
          <div className="panel-header"><div><h2>Trajetória espacial</h2><p>Segmentos válidos na revisão selecionada.</p></div><Badge>{revision === "reviewed" ? "Revisado" : "Bruto"}</Badge></div>
          <div className="trajectory-canvas">
            <svg viewBox={`0 0 ${experiment.video.width} ${experiment.video.height}`} preserveAspectRatio="xMidYMid meet">
              <rect width={experiment.video.width} height={experiment.video.height} fill="#f1f3ee" />
              <polygon points={pointsToSvg(experiment.arena.cornersPx)} fill="#e7eae3" stroke="#9ca9a2" strokeWidth="5" />
              <polygon points={pointsToSvg(centerPolygon)} fill="#70d6ad" fillOpacity=".11" stroke="#4ca383" strokeWidth="3" strokeDasharray="10 8" />
              {trajectory.map((segment, index) => <polyline key={index} points={pointsToSvg(segment)} fill="none" stroke="#1a5b4a" strokeWidth="4" strokeOpacity=".82" strokeLinecap="round" strokeLinejoin="round" />)}
              {startPoint && <circle cx={startPoint.x} cy={startPoint.y} r="9" fill="#d7f169" stroke="#153c32" strokeWidth="3" />}
              {endPoint && <circle cx={endPoint.x} cy={endPoint.y} r="9" fill="#153c32" />}
            </svg>
            <div className="trajectory-legend"><span><i className="start" /> Início</span><span><i className="end" /> Fim</span><span><i className="center" /> Centro</span></div>
          </div>
        </section>

        <section className="panel zone-card">
          <div className="panel-header compact"><div><h2>Ocupação por zona</h2><p>Percentual do tempo classificável.</p></div></div>
          <div className="zone-donut" style={{ background: `conic-gradient(#1e6a56 0 ${centerPct}%, #dce5df ${centerPct}% 100%)` }}><div><strong>{centerPct.toFixed(1)}%</strong><span>no centro</span></div></div>
          <div className="zone-breakdown">
            <div><span><i className="center" /> Centro</span><strong>{formatDuration(metrics.centerTimeSec)}</strong></div>
            <div><span><i className="periphery" /> Periferia</span><strong>{formatDuration(metrics.peripheralTimeSec)}</strong></div>
            <div><span><i className="unknown" /> Desconhecido</span><strong>{formatDuration(metrics.unknownTimeSec)}</strong></div>
          </div>
        </section>
      </div>

      <section className="panel behavior-results">
        <div className="panel-header"><div><h2>Rearing, grooming e freezing</h2><p>Episódios confirmados no vídeo · independentes da revisão de poses selecionada.</p></div></div>
        <div className="behavior-result-grid">{behaviors.map((item) => <article key={item.label}>
          <h3>{BEHAVIOR_LABELS[item.label]}</h3><strong>{item.count == null ? "Não anotado" : `${item.count} episódio(s)`}</strong>
          <span>{item.durationSec == null ? "Duração não mensurada" : `${item.durationSec.toFixed(2)} s confirmados`}</span>
          <small>{item.reviewed ? "Vídeo inteiro revisado para esta classe" : "Revisão parcial · não é o total da sessão"}</small>
        </article>)}</div>
        <p>Imobilidade operacional não equivale a freezing. Sugestões não confirmadas não são contadas. Sem revisão completa, zero anotações não significa ausência de comportamento.</p>
      </section>

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
        <div className="coverage-warning"><AlertTriangle size={18} /><div><strong>Cobertura abaixo de 90%</strong><span>Resultados são parciais. Revise pontos ausentes antes de comparar grupos.</span></div></div>
      )}
      {experiment.status === "completed" && <div className="completed-toast"><CheckCircle2 size={17} /> Revisão marcada como concluída neste dispositivo.</div>}
    </div>
  );
}

