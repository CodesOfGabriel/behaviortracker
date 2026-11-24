import { useOriginalVideo } from "../results/TrackingDetails";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/ui/card";
import type { LocalAnalysisControls } from "../results/AnalysisWorkspace";
import { LocalAuditVideo } from "../local/LocalAuditVideo";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { RamReviewPanel } from "./RamReviewPanel";
import { Cpu, Info } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { boxCenterTrajectory, boxTrajectoryStyle } from "../../lib/boxes";
import { downloadText } from "../../lib/csv";
import { useAppStore } from "../../store/AppStore";
import type { Point, PoseSample, RadialMazeExperiment } from "../../types";
import { getStagedVideoSha256, stageVideo } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { cancelLocalJob, getLocalEnvironment, listLocalJobs, loadLocalResult, setupLocalEnvironment, startLocalJob,
  type LocalEnvironment, type LocalJob } from "../local/api";

function errorText(reason: unknown) { return typeof reason === "string" ? reason : reason instanceof Error ? reason.message : String(reason); }

export function RamLocalPanel({ experiment, children }: {
  experiment: RadialMazeExperiment;
  children: (controls: LocalAnalysisControls) => ReactNode;
}) {
  const { assets, setAsset, updateRadialMazeExperiment, analysisActivity, setAnalysisActivity } = useAppStore();
  const asset = assets[experiment.id];
  const [environment, setEnvironment] = useState<LocalEnvironment | null>(null);
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [samplesJobId, setSamplesJobId] = useState<string | null>(null);
  const [samples, setSamples] = useState<PoseSample[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [useOpenCL, setUseOpenCL] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processingWidth, setProcessingWidth] = useState(640);
  const [strategy, setStrategy] = useState("classical_roi_v1");
  const [ramColor, setRamColor] = useState({ valueMin: 80, saturationMin: 25, labBMin: 135, minAreaPx: 280, maxAreaPx: 72000, minDensity: .12, maxSpeedFraction: .21, reacquireSec: .5, ambiguityMargin: .4 });
  const reviewFileRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = jobs.find(job => job.state === "queued" || job.state === "running");
  const selected = jobs.find(job => job.jobId === selectedId);
  const originalUrl = useOriginalVideo(experiment, selected);
  const resultJobId = experiment.trackingSelection?.engine === "opencv" ? experiment.trackingSelection.jobId : null;
  const resultJobState = jobs.find(job => job.jobId === resultJobId)?.state;
  const busy = settingUp || running || Boolean(active) || Boolean(analysisActivity[experiment.id]?.starting);

  useEffect(() => {
    setSelectedId(experiment.trackingSelection?.engine === "opencv" ? experiment.trackingSelection.jobId : null);
    setSamples([]); setSamplesJobId(null);
  }, [experiment.trackingSelection?.engine, experiment.trackingSelection?.jobId]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let live = true;
    void getLocalEnvironment().then(value => { if (live) setEnvironment(value); }).catch(reason => { if (live) setError(errorText(reason)); });
    const refresh = () => { void listLocalJobs(experiment.id).then(value => { if (live) setJobs(value); }).catch(reason => { if (live) setError(errorText(reason)); }); };
    refresh(); const timer = window.setInterval(refresh, 2_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [experiment.id]);

  useEffect(() => {
    if (!resultJobId || resultJobState !== "succeeded") return;
    let live = true;
    void loadLocalResult(resultJobId).then(value => { if (live) { setSamples(value); setSamplesJobId(resultJobId); setSelectedId(resultJobId); } })
      .catch(reason => { if (live) setError(errorText(reason)); });
    return () => { live = false; };
  }, [resultJobId, resultJobState]);

  async function setup() {
    setSettingUp(true); setError(null);
    try { setEnvironment(await setupLocalEnvironment()); } catch (reason) { setError(errorText(reason)); }
    finally { setSettingUp(false); }
  }

  async function run(file?: File) {
    if (busy) return;
    if (!isTauriRuntime()) { setError("A análise local requer o aplicativo desktop."); return; }
    if (!environment?.ready) { setError("Prepare o ambiente OpenCV local."); return; }
    const original = file ?? asset?.file;
    if (!original) { fileRef.current?.click(); return; }
    if (original.name !== experiment.video.filename || original.size !== experiment.video.sizeBytes) {
      setError("Selecione o vídeo original deste experimento."); return;
    }
    const polygon = experiment.geometry.walkablePolygonPx;
    if (!polygon?.length) { setError("Marque a área analisável antes de executar."); return; }
    const xs = polygon.map(point => point.x), ys = polygon.map(point => point.y);
    const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
    const arena = { cornersPx: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }] };
    setRunning(true); setError(null);
    setAnalysisActivity(experiment.id, { starting: true, engine: "opencv", startedAt: Date.now(), message: "Copiando vídeo", error: null, videoProgress: null });
    let started = false;
    try {
      const uploadId = await stageVideo(experiment.id, original, (_percent, text) => setAnalysisActivity(experiment.id, { message: text }));
      const sha256 = await getStagedVideoSha256(uploadId);
      if (experiment.video.sha256 && experiment.video.sha256 !== sha256) throw new Error("O SHA-256 do vídeo não corresponde ao experimento.");
      if (!experiment.video.sha256) updateRadialMazeExperiment(experiment.id, current => ({ video: { ...current.video, sha256 } }));
      if (file) {
        if (asset?.objectUrl) URL.revokeObjectURL(asset.objectUrl);
        setAsset(experiment.id, { ...asset, file: original, objectUrl: URL.createObjectURL(original) });
      }
      const job = await startLocalJob(experiment.id, uploadId, {
        protocol: "radial_arm_maze", width: experiment.video.width, height: experiment.video.height,
        arena, walkablePolygonPx: polygon, geometryRevision: experiment.geometry.revision,
        walkableMaskVersion: experiment.geometry.walkableMaskVersion,
        mode: "auto", threshold: strategy === "classical_roi_v1" ? 25 : 110, minAreaFraction: 0.0001, maxAreaFraction: 0.2,
        maxWidth: processingWidth, maxPredictionSec: 0.25, referenceApproved: false,
        useOpenCL: useOpenCL && Boolean(environment.openclAvailable), strategy, ramColor,
      });
      started = true;
      setJobs(current => [{ ...job, uploadId, error: null, report: {} }, ...current]);
      updateRadialMazeExperiment(experiment.id, { status: "processing" });
      for (;;) {
        const current = (await listLocalJobs(experiment.id)).find(item => item.jobId === job.jobId);
        if (!current) throw new Error("Execução local não encontrada.");
        setJobs(previous => [current, ...previous.filter(item => item.jobId !== current.jobId)]);
        setAnalysisActivity(experiment.id, { message: `${current.report.framesProcessed ?? 0} frames analisados` });
        if (current.state === "succeeded") {
          setSelectedId(current.jobId);
          updateRadialMazeExperiment(experiment.id, { status: "review", trackingSelection: { engine: "opencv", jobId: current.jobId } });
          break;
        }
        if (["failed", "cancelled"].includes(current.state)) throw new Error(current.error ?? "Análise local interrompida.");
        await new Promise(resolve => window.setTimeout(resolve, 1_500));
      }
    } catch (reason) {
      const failure = errorText(reason);
      setAnalysisActivity(experiment.id, { error: failure, message: failure });
      if (started) updateRadialMazeExperiment(experiment.id, current => ({ status: current.trackingSelection ? "review" : "failed" }));
    } finally {
      setRunning(false); setAnalysisActivity(experiment.id, { starting: false, videoProgress: null });
    }
  }

  function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file) void run(file);
  }

  const observed = samples.filter(sample => sample.status === "valid" && sample.source === "segmented" && sample.xPx != null && sample.yPx != null);
  const trajectory = useMemo(() => boxCenterTrajectory(samples, experiment.video.width, experiment.video.height),
    [samples, experiment.video.width, experiment.video.height]);
  const selectedPolygon = Array.isArray(selected?.config.walkablePolygonPx)
    ? selected.config.walkablePolygonPx as Point[] : experiment.geometry.walkablePolygonPx;
  const selectedRevision = selected?.config.geometryRevision;
  const panel = <section className="panel local-analysis-panel" aria-label="Tracking local RAM">
    <input ref={fileRef} type="file" accept="video/*" className="sr-only" onChange={attach} />
    <input ref={reviewFileRef} type="file" accept="video/*" className="sr-only" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file) return;
      void (async () => {
        try {
          const uploadId = await stageVideo(experiment.id, file, () => {});
          const sha = await getStagedVideoSha256(uploadId);
          if (sha !== selected?.videoSha256) throw new Error("O vídeo não corresponde ao SHA-256 desta execução.");
          if (asset?.objectUrl) URL.revokeObjectURL(asset.objectUrl);
          setAsset(experiment.id, { ...asset, file, objectUrl: URL.createObjectURL(file) });
        } catch (reason) { setError(errorText(reason)); }
      })();
    }} />
    <h2><Cpu size={20} /> Tracking local</h2>
    <p>OpenCV observa o centro da caixa dentro da área marcada. A execução usa CPU por padrão.</p>
    <div className="validation-box"><Info size={16} /><span>O centro da caixa não é o ponto anatômico mouse_center. Visitas exigem referências dos oito braços confirmadas. A proximidade ao pote não confirma retirada de alimento.</span></div>
    {!environment?.ready ? <div className="local-setup"><p>{environment?.message ?? "Verificando OpenCV…"}</p>
      <Button variant="secondary" disabled={settingUp || !isTauriRuntime()} onClick={() => void setup()}>{settingUp ? "Preparando…" : "Preparar análise local"}</Button></div>
      : <p className="local-environment">OpenCV {environment.version} · {environment.openclAvailable ? "GPU OpenCL disponível para teste experimental" : "CPU; GPU OpenCL indisponível"}</p>}
    <div className="local-analysis-settings"><p className="local-auto-note">{strategy === "ram_color_geometry_v2" ? "Os limiares de cor abaixo pertencem a esta sessão. Confira o contraste do animal e revise as observações após o tracking."
      : strategy === "classical_roi_v1" ? "O fundo mediano é estimado com amostras da sessão e permanece fixo. Revise as observações após o tracking."
      : "Contraste e limiar são estimados a partir do vídeo. Revise as observações após o tracking."}</p>
      <label>Estratégia<select value={strategy} disabled={busy} onChange={e=>setStrategy(e.target.value)}><option value="classical_roi_v1">Fundo da sessão + continuidade (experimental, CPU)</option><option value="ram_color_geometry_v2">RAM Color v2 (experimental, CPU)</option><option value="classic">Contraste OpenCV existente</option></select></label>
      <label>Largura de processamento<select value={processingWidth} disabled={busy} onChange={e=>setProcessingWidth(Number(e.target.value))}><option value={480}>480 px</option><option value={640}>640 px</option><option value={960}>960 px</option><option value={1280}>1280 px</option><option value={1920}>1920 px</option></select></label>
      {strategy === "ram_color_geometry_v2" && <details><summary>Cor e associação desta sessão</summary>
        {([ ["valueMin", "Brilho HSV mínimo", 0, 254], ["saturationMin", "Saturação mínima", 0, 254], ["labBMin", "Canal Lab b mínimo", 0, 254], ["minAreaPx", "Área corporal mínima (px²)", 1, 10000000], ["maxAreaPx", "Área corporal máxima (px²)", 2, 10000000], ["minDensity", "Densidade mínima", .01, 1], ["maxSpeedFraction", "Velocidade máxima (diagonal/s)", .001, 10], ["reacquireSec", "Intervalo para readquirir (s)", .01, 2], ["ambiguityMargin", "Margem entre candidatos", 0, 10] ] as const).map(([key,label,min,max])=><label key={key}>{label}<input type="number" min={min} max={max} step="any" value={ramColor[key]} disabled={busy} onChange={e=>setRamColor(current=>({...current,[key]:Number(e.target.value)}))}/></label>)}
      </details>}
      <details className="local-options"><summary>Opções avançadas</summary>
        <label className="local-reference-approval"><input type="checkbox" checked={useOpenCL}
          disabled={busy || !environment?.openclAvailable} onChange={event => setUseOpenCL(event.target.checked)} />
          <span>Solicitar OpenCL nesta execução (experimental; padrão CPU).</span></label>
      </details></div>
    {active && <Button variant="secondary" onClick={() => void cancelLocalJob(active.jobId).catch(reason => setError(errorText(reason)))}>Cancelar</Button>}
    {active && <p role="status">{active.report.phase === "recognition" ? "Reconhecendo contraste do animal" : `${active.report.framesProcessed ?? 0}${active.report.totalFrames ? ` / ${active.report.totalFrames}` : ""} frames · ${active.report.computeBackend ?? "CPU"}`}</p>}
    {selected?.report.segmentationSelection && <p className="local-detection-result">{selected.report.backgroundReference ? "Contraste auxiliar estimado" : "Contraste estimado"}: {selected.report.segmentationSelection.mode === "dark" ? "animal escuro" : "animal claro"} · limiar {selected.report.segmentationSelection.threshold} · {selected.report.segmentationSelection.inspectedFrames ?? selected.report.segmentationSelection.sampledFrames} frames inspecionados.</p>}
    {error && <div role="alert" className="validation-box invalid"><Info size={16} />{error}</div>}
    {selected && (selected.report.cameraUncertainFrames ?? 0) > 0 && <div role="status" className="validation-box invalid"><Info size={16} />
      Foi detectado deslocamento visual em relação à geometria; {selected.report.cameraUncertainFrames} frames ficaram incertos. Os centros continuam no vídeo para revisão.
    </div>}
    {selected?.report.cameraMotionState === "unavailable" && <div role="status" className="validation-box"><Info size={16} />
      Não foi possível verificar a estabilidade da câmera com pontos estáticos na área marcada. Confira visualmente a geometria ao longo do vídeo.
    </div>}
    {jobs.length > 0 && <div className="local-job-history"><h3>Execuções locais</h3>{jobs.map(job => <button key={job.jobId} type="button" disabled={busy || job.state !== "succeeded"} aria-pressed={selected?.jobId === job.jobId}
      onClick={() => { setSelectedId(job.jobId); updateRadialMazeExperiment(experiment.id, { status: "review", trackingSelection: { engine: "opencv", jobId: job.jobId } }); }}>
      <strong>{new Date(job.createdAt).toLocaleString("pt-BR")}</strong><span>{job.state} · {job.report.observationCoveragePct == null ? "cobertura indisponível" : `${(samplesJobId === job.jobId && samples.length ? 100*observed.length/samples.length : job.report.observationCoveragePct).toFixed(1)}% de cobertura`}</span></button>)}</div>}
  </section>;
  const readyResult = selected?.state === "succeeded" && samplesJobId === selected.jobId;
  const empty = <section className="panel protocol-result-panel"><h2>Resultado local</h2><p>Selecione uma execução local concluída na aba Análise.</p></section>;
  const detailsPanel = readyResult ? <><Button variant="secondary" onClick={()=>reviewFileRef.current?.click()}>Abrir vídeo para revisão</Button>
      <RamReviewPanel key={selected.jobId} experiment={experiment} job={selected} raw={samples} videoUrl={originalUrl} /></> : empty;
  const trajectoryPanel = <>
    {selected?.state === "succeeded" && samplesJobId === selected.jobId && <div className="ram-local-result"><p>{trajectory.boxFrames} de {samples.length} frames com caixa para visualização; {trajectory.uncertainFrames} incertos. O trajeto segue o centro da caixa sem aprovar métricas.</p>
      {selectedRevision !== experiment.geometry.revision && <p>Esta execução usa a revisão {String(selectedRevision)} da geometria; a revisão atual é {experiment.geometry.revision}.</p>}
      <svg className="ram-geometry-editor ram-geometry-preview" viewBox={`0 0 ${experiment.video.width} ${experiment.video.height}`} role="img" aria-label="Centros das caixas observados localmente">
        {experiment.calibrationThumbnailDataUrl && <image href={experiment.calibrationThumbnailDataUrl} width={experiment.video.width} height={experiment.video.height} />}
        {selectedPolygon && <polygon points={selectedPolygon.map(point => `${point.x},${point.y}`).join(" ")} className="ram-center-polygon" />}
        {trajectory.segments.map((segment, i) => segment.points.length === 1
          ? <circle key={i} cx={segment.points[0].x} cy={segment.points[0].y} r={Math.max(2, experiment.video.width/500)} fill={boxTrajectoryStyle[segment.state].color} />
          : <polyline key={i} points={segment.points.map(p => `${p.x},${p.y}`).join(" ")}
          fill="none" stroke={boxTrajectoryStyle[segment.state].color} strokeDasharray={boxTrajectoryStyle[segment.state].dash}
          strokeWidth={Math.max(2, experiment.video.width/500)} strokeLinecap="round" strokeLinejoin="round" />)}
      </svg><p>Verde: observado · âmbar: incerto · tracejado: previsto ou recuperado.</p></div>}
  </>;
  return children({ run: () => void run(), busy, ready: Boolean(environment?.ready && experiment.geometry.walkablePolygonPx), job: (active ?? jobs[0] ?? null), panel,
    resultPanels: {
      summary: readyResult ? <Card><CardHeader><CardTitle>Qualidade das observações</CardTitle></CardHeader><CardContent><p>{trajectory.boxFrames.toLocaleString("pt-BR")} de {samples.length.toLocaleString("pt-BR")} quadros com caixa · {trajectory.uncertainFrames.toLocaleString("pt-BR")} incertos.</p><p className="details-chart-note">Visitas e erros de memória dependem da geometria completa e da revisão dos frames.</p></CardContent></Card> : empty,
      video: selected?.state === "succeeded" ? <LocalAuditVideo key={selected.jobId} jobId={selected.jobId} title="Vídeo · Máquina local"/> : empty,
      trajectory: readyResult ? trajectoryPanel : empty,
      details: detailsPanel,
      exports: readyResult ? <section className="panel protocol-result-panel"><h2>Arquivos da execução local</h2><Button variant="secondary" onClick={()=>downloadText(`ram-${selected.jobId}.json`, JSON.stringify({job:selected,samples},null,2),"application/json")}>Exportar tracking RAM</Button></section> : empty,
    } });
}
