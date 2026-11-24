import { useEffect, useMemo, useState } from "react";
import { boxCenterTrajectory, boxTrajectoryStyle, detectorTrajectory } from "../../lib/boxes";
import { applyCorrections } from "../../lib/corrections";
import { parseCanonicalPoseCsv } from "../../lib/csv";
import { centerPolygonPx, pointsToSvg } from "../../lib/geometry";
import { metricEligible, originalPose, trajectorySegments } from "../../lib/pose";
import { preferredReference, reviewEvents, trackingSourceKey } from "../../lib/tracking-reviews";
import type { OpenFieldExperiment, PoseSample, TrackingSelection } from "../../types";
import { getColabJobPreparation, loadColabResult } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { scalePoseToOriginal } from "../colab/videoGeometry";
import { loadLocalOpenFieldResult } from "../local/api";

export function RunTrajectory({ experiment, engine, jobId, currentSamples }: {
  experiment: OpenFieldExperiment;
  engine: TrackingSelection["engine"];
  jobId: string | null;
  currentSamples?: PoseSample[];
}) {
  const local = engine === "opencv";
  const [view, setView] = useState<"detector" | "anatomical">("detector");
  const [loaded, setLoaded] = useState<{ samples: PoseSample[]; error?: string } | null>(null);
  const { id, video: { width, height } } = experiment;
  const alreadyLoaded = Boolean(currentSamples);

  useEffect(() => {
    if (alreadyLoaded || !jobId || !isTauriRuntime()) return;
    let live = true;
    async function load(idForRun: string) {
      if (local) return loadLocalOpenFieldResult(idForRun);
      const [csv, preparation] = await Promise.all([
        loadColabResult(idForRun), getColabJobPreparation(id, idForRun),
      ]);
      const samples = parseCanonicalPoseCsv(csv);
      return preparation ? scalePoseToOriginal(samples, { width, height }, preparation) : samples;
    }
    void load(jobId)
      .then(samples => { if (live) setLoaded({ samples }); })
      .catch(reason => { if (live) setLoaded({ samples: [], error: reason instanceof Error ? reason.message : String(reason) }); });
    return () => { live = false; };
  }, [alreadyLoaded, id, jobId, local, width, height]);

  const input = currentSamples ?? loaded?.samples;
  const data = useMemo(() => {
    if (!input?.length) return null;
    const selection = jobId ? { engine, jobId } : undefined;
    const original = input.map(originalPose);
    const saved = experiment.trackingReviews?.[trackingSourceKey(selection)]?.referencePoint;
    const requestedReference = !jobId || trackingSourceKey(experiment.trackingSelection) === trackingSourceKey(selection)
      ? experiment.referencePoint : saved;
    const reference = requestedReference && original.some(sample => sample.keypoint === requestedReference)
      ? requestedReference : preferredReference(original);
    const reviewed = applyCorrections(input, reviewEvents({ ...experiment, trackingSelection: selection }));
    const localBoxes = local ? boxCenterTrajectory(reviewed, width, height) : null;
    const legacyLocal = local && !original.some(sample => sample.keypoint === "mouse_center" && sample.source === "detected");
    const detector = legacyLocal ? null : detectorTrajectory(original, width, height);
    const track = reviewed.filter(sample => sample.keypoint === reference)
      .sort((a, b) => a.frameIndex - b.frameIndex);
    const eligible = legacyLocal
      ? (sample: PoseSample) => sample.status === "valid" && sample.spatialRegion !== "outside"
        && sample.source !== "predicted" && sample.source !== "recovered"
      : metricEligible;
    const segments = trajectorySegments(track.map(sample => eligible(sample) ? sample : { ...sample, status: "missing" }));
    return { detector, segments, legacyLocal, localBoxes };
  }, [engine, experiment, height, input, jobId, local, width]);

  const showLocalBoxes = local && (view === "detector" || data?.legacyLocal);
  const showDetector = !showLocalBoxes && view === "detector" && Boolean(data?.detector?.observedFrames);
  const segments = showLocalBoxes ? data?.localBoxes?.segments.map(segment => segment.points)
    : showDetector ? data?.detector?.segments : data?.segments;
  const first = segments?.[0]?.[0], last = segments?.at(-1)?.at(-1);
  const title = local ? "Trajetória · Máquina local" : "Trajetória · Google Colab";
  const color = showDetector ? "#218381" : local ? "#276b52" : "#644d91";

  return <section className="panel trajectory-card" aria-label={title}>
    <div className="panel-header"><div>
      <h2>{title}</h2>
      {data && <p>{showLocalBoxes ? "Centro da caixa em cada frame. Alertas não interrompem a visualização; perdas reais mantêm lacunas."
        : showDetector ? "Centro geométrico das caixas observadas pelo detector."
        : "Ponto de referência da pose, com correções desta execução quando disponíveis."}</p>}
    </div></div>
    {showLocalBoxes && data?.localBoxes && <p>{data.localBoxes.boxFrames} frames com caixa · {data.localBoxes.uncertainFrames} incertos · {data.localBoxes.predictedFrames} previstos/recuperados. A trajetória visual não aprova métricas.</p>}
    {Boolean(data?.detector?.observedFrames) && <div className="trajectory-source-toggle" role="group" aria-label="Referência da trajetória">
      <button type="button" className={showDetector || showLocalBoxes ? "active" : ""} aria-pressed={showDetector || showLocalBoxes} onClick={() => setView("detector")}>Centro da caixa</button>
      <button type="button" className={!showDetector && !showLocalBoxes ? "active" : ""} aria-pressed={!showDetector && !showLocalBoxes} onClick={() => setView("anatomical")}>Ponto anatômico</button>
    </div>}
    <div className="trajectory-canvas">
      {segments?.length ? <>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={title}>
          <rect width={width} height={height} fill="#f1f3ee" />
          <polygon points={pointsToSvg(experiment.arena.cornersPx)} fill="#e7eae3" stroke="#9ca9a2" strokeWidth="5" />
          <polygon points={pointsToSvg(centerPolygonPx(experiment.arena))} fill="#85ae98" fillOpacity=".11" stroke="#4ca383" strokeWidth="3" strokeDasharray="10 8" />
          {segments.map((segment, index) => {
            const state = showLocalBoxes ? data?.localBoxes?.segments[index]?.state : undefined;
            const style = state ? boxTrajectoryStyle[state] : undefined;
            return segment.length === 1 ? <circle key={index} cx={segment[0].x} cy={segment[0].y} r={Math.max(2, width/500)} fill={style?.color ?? color} />
              : <polyline key={index} points={pointsToSvg(segment)} fill="none" stroke={style?.color ?? color} strokeDasharray={style?.dash}
                strokeWidth={Math.max(3, width / 400)} strokeOpacity=".82" strokeLinecap="round" strokeLinejoin="round" />;
          })}
          {first && <circle cx={first.x} cy={first.y} r={Math.max(9, width / 260)} fill="#a7adb2" stroke="#242628" strokeWidth="3" />}
          {last && <circle cx={last.x} cy={last.y} r={Math.max(9, width / 260)} fill="#242628" />}
        </svg>
        <div className="trajectory-legend"><span><i className="start" /> Início</span><span><i className="end" /> Fim</span><span><i className="center" /> Centro</span></div>
        {showLocalBoxes && <p>Verde: observado · âmbar: caixa incerta · tracejado: previsto ou recuperado.</p>}
      </> : <p className="results-video-message" role={loaded?.error ? "alert" : "status"}>{
        loaded?.error ? `Não foi possível carregar a trajetória. ${loaded.error}`
          : input ? showLocalBoxes ? "Sem caixas disponíveis para exibir." : "Sem observações consecutivas válidas para exibir."
          : jobId ? "Carregando a trajetória desta execução…"
          : "Nenhuma execução concluída neste ambiente."
      }</p>}
    </div>
  </section>;
}
