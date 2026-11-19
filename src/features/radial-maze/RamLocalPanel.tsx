import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Cpu, Info } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { useAppStore } from "../../store/AppStore";
import type { Point, PoseSample, RadialMazeExperiment } from "../../types";
import { getStagedVideoSha256, stageVideo } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { cancelLocalJob, getLocalEnvironment, listLocalJobs, loadLocalResult, setupLocalEnvironment, startLocalJob,
  type LocalEnvironment, type LocalJob } from "../local/api";

function errorText(reason: unknown) { return typeof reason === "string" ? reason : reason instanceof Error ? reason.message : String(reason); }

export function RamLocalPanel({ experiment }: { experiment: RadialMazeExperiment }) {
  const { assets, setAsset, updateRadialMazeExperiment, analysisActivity, setAnalysisActivity } = useAppStore();
  const asset = assets[experiment.id];
  const [environment, setEnvironment] = useState<LocalEnvironment | null>(null);
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [samples, setSamples] = useState<PoseSample[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"dark" | "light">("dark");
  const [threshold, setThreshold] = useState(110);
  const [useOpenCL, setUseOpenCL] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = jobs.find(job => job.state === "queued" || job.state === "running");
  const selected = jobs.find(job => job.jobId === selectedId);
  const resultJobId = selectedId ?? (experiment.trackingSelection?.engine === "opencv" ? experiment.trackingSelection.jobId : null);
  const resultJobState = jobs.find(job => job.jobId === resultJobId)?.state;
  const busy = settingUp || running || Boolean(active) || Boolean(analysisActivity[experiment.id]?.starting);

  useEffect(() => {
    if (experiment.trackingSelection?.engine === "colab") { setSelectedId(null); setSamples([]); }
  }, [experiment.trackingSelection?.engine]);

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
    void loadLocalResult(resultJobId).then(value => { if (live) { setSamples(value); setSelectedId(resultJobId); } })
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
    setAnalysisActivity(experiment.id, { starting: true, engine: "opencv", startedAt: Date.now(), message: "Copiando vídeo", error: null });
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
        mode, threshold, minAreaFraction: 0.0001, maxAreaFraction: 0.2,
        maxWidth: 1280, maxPredictionSec: 0.25, referenceApproved: false,
        useOpenCL: useOpenCL && Boolean(environment.openclAvailable), strategy: "classic",
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
      setError(errorText(reason));
      if (started) updateRadialMazeExperiment(experiment.id, current => ({ status: current.trackingSelection ? "review" : "failed" }));
    } finally {
      setRunning(false); setAnalysisActivity(experiment.id, { starting: false });
    }
  }

  function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file) void run(file);
  }

  const observed = samples.filter(sample => sample.status === "valid" && sample.source === "segmented" && sample.xPx != null && sample.yPx != null);
  const stride = Math.max(1, Math.ceil(observed.length / 800));
  const selectedPolygon = Array.isArray(selected?.config.walkablePolygonPx)
    ? selected.config.walkablePolygonPx as Point[] : experiment.geometry.walkablePolygonPx;
  const selectedRevision = selected?.config.geometryRevision;
  return <section className="panel local-analysis-panel" aria-label="Tracking local RAM">
    <input ref={fileRef} type="file" accept="video/*" className="sr-only" onChange={attach} />
    <h2><Cpu size={20} /> Tracking local</h2>
    <p>OpenCV observa o centro da caixa dentro da área marcada. A execução usa CPU por padrão.</p>
    <div className="validation-box"><Info size={16} /><span>O centro da caixa não é o ponto anatômico mouse_center. Nenhuma visita, erro de memória ou recompensa é calculada nesta execução.</span></div>
    {!environment?.ready ? <div className="local-setup"><p>{environment?.message ?? "Verificando OpenCV…"}</p>
      <Button variant="secondary" disabled={settingUp || !isTauriRuntime()} onClick={() => void setup()}>{settingUp ? "Preparando…" : "Preparar análise local"}</Button></div>
      : <p className="local-environment">OpenCV {environment.version} · {environment.openclAvailable ? "GPU OpenCL disponível para teste experimental" : "CPU; GPU OpenCL indisponível"}</p>}
    <div className="local-analysis-settings"><label>Animal no vídeo<select disabled={busy} value={mode} onChange={event => setMode(event.target.value as "dark" | "light")}>
      <option value="dark">Escuro sobre fundo claro</option><option value="light">Claro sobre fundo escuro</option></select></label>
      <label>Limiar<input type="number" min={1} max={254} disabled={busy} value={threshold} onChange={event => setThreshold(Number(event.target.value))} /></label>
      <label className="local-reference-approval"><input type="checkbox" checked={useOpenCL}
        disabled={busy || !environment?.openclAvailable} onChange={event => setUseOpenCL(event.target.checked)} />
        <span>Solicitar OpenCL nesta execução (experimental; padrão CPU).</span></label></div>
    <div className="results-actions"><Button disabled={busy || !environment?.ready || !experiment.geometry.walkablePolygonPx || !Number.isInteger(threshold) || threshold < 1 || threshold > 254} onClick={() => void run()}>{active || running ? "Processando…" : "Analisar localmente"}</Button>
      {active && <Button variant="secondary" onClick={() => void cancelLocalJob(active.jobId).catch(reason => setError(errorText(reason)))}>Cancelar</Button>}</div>
    {active && <p role="status">{active.report.framesProcessed ?? 0}{active.report.totalFrames ? ` / ${active.report.totalFrames}` : ""} frames · {active.report.computeBackend ?? "CPU"}</p>}
    {error && <div role="alert" className="validation-box invalid"><Info size={16} />{error}</div>}
    {selected && (selected.report.cameraUncertainFrames ?? 0) > 0 && <div role="status" className="validation-box invalid"><Info size={16} />
      Foi detectado deslocamento visual em relação à geometria; {selected.report.cameraUncertainFrames} frames ficaram incertos. Os centros continuam no vídeo para revisão.
    </div>}
    {selected?.report.cameraMotionState === "unavailable" && <div role="status" className="validation-box"><Info size={16} />
      Não foi possível verificar a estabilidade da câmera com pontos estáticos na área marcada. Confira visualmente a geometria ao longo do vídeo.
    </div>}
    {jobs.length > 0 && <div className="local-job-history"><h3>Execuções locais</h3>{jobs.map(job => <button key={job.jobId} type="button" disabled={job.state !== "succeeded"} aria-pressed={selected?.jobId === job.jobId}
      onClick={() => { setSelectedId(job.jobId); updateRadialMazeExperiment(experiment.id, { status: "review", trackingSelection: { engine: "opencv", jobId: job.jobId } }); }}>
      <strong>{new Date(job.createdAt).toLocaleString("pt-BR")}</strong><span>{job.state} · {job.report.observationCoveragePct == null ? "cobertura indisponível" : `${job.report.observationCoveragePct.toFixed(1)}% de cobertura`}</span></button>)}</div>}
    {selected?.state === "succeeded" && <div className="ram-local-result"><p>{observed.length} de {samples.length} frames observados dentro da área analisável. Revise visualmente os pontos.</p>
      {selectedRevision !== experiment.geometry.revision && <p>Esta execução usa a revisão {String(selectedRevision)} da geometria; a revisão atual é {experiment.geometry.revision}.</p>}
      <svg className="ram-geometry-editor ram-geometry-preview" viewBox={`0 0 ${experiment.video.width} ${experiment.video.height}`} role="img" aria-label="Centros das caixas observados localmente">
        {experiment.calibrationThumbnailDataUrl && <image href={experiment.calibrationThumbnailDataUrl} width={experiment.video.width} height={experiment.video.height} />}
        {selectedPolygon && <polygon points={selectedPolygon.map(point => `${point.x},${point.y}`).join(" ")} className="ram-center-polygon" />}
        {observed.filter((_, index) => index % stride === 0).map(sample => <circle key={sample.frameIndex} cx={sample.xPx!} cy={sample.yPx!} r={Math.max(2, experiment.video.width / 350)} fill="#51ddce" opacity=".6" />)}
      </svg></div>}
  </section>;
}
