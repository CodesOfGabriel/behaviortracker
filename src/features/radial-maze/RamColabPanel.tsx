import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Download, Info } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { checkVideoStaging, loadColabJobs, loadColabResult, loadRamArtifacts,
  prepareFstVideo, startRamJob, waitForColabJob, type ColabJob } from "../colab/analysis";
import { COLAB_STATUS_EVENT, emptyColabSummary, isTauriRuntime, loadColabSummary } from "../colab/connection";
import { useAppStore } from "../../store/AppStore";
import type { RadialMazeExperiment } from "../../types";

type RamFrame = { frame: number; timestampSec: number; mouseCenter: { x: number; y: number } | null; likelihood: number | null; qualityFlags: string[] };
type RamTrackingResult = { schemaVersion: "ram-tracking-1"; protocol: "radial_arm_maze";
  engineId: "wistar_ram_hybrid_v1"; analysisStatus: "EXPERIMENTAL_NOT_FOR_METRICS";
  jobId: string; modelBundleId: string; geometry: { revision: number; walkableMaskVersion: string; walkablePolygonPx: { x: number; y: number }[]; sourceWidth: number; sourceHeight: number };
  video: { sha256: string; originalSha256: string; width: number; height: number };
  frameCount: number; fps: number; observedFrames: number; frames: RamFrame[]; behaviorMetrics: null };

function parseRamResult(text: string): RamTrackingResult {
  const value = JSON.parse(text) as RamTrackingResult;
  if (value.schemaVersion !== "ram-tracking-1" || value.protocol !== "radial_arm_maze"
    || value.engineId !== "wistar_ram_hybrid_v1" || value.analysisStatus !== "EXPERIMENTAL_NOT_FOR_METRICS"
    || value.behaviorMetrics !== null || !Array.isArray(value.frames) || value.frames.length !== value.frameCount
    || !Number.isFinite(value.fps) || value.fps <= 0 || !Array.isArray(value.geometry?.walkablePolygonPx)) {
    throw new Error("O resultado RAM não corresponde ao contrato de tracking experimental.");
  }
  return value;
}

export function RamColabPanel({ experiment }: { experiment: RadialMazeExperiment }) {
  const { assets, setAsset, updateRadialMazeExperiment, navigate } = useAppStore();
  const asset = assets[experiment.id];
  const fileRef = useRef<HTMLInputElement>(null);
  const [connected, setConnected] = useState(emptyColabSummary.connected);
  const [history, setHistory] = useState<ColabJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<RamTrackingResult | null>(null);
  const [artifacts, setArtifacts] = useState<{ name: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = history.find(job => job.status === "queued" || job.status === "running");
  const selected = history.find(job => job.jobId === selectedId) ?? history[0];

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let live = true;
    const refresh = () => {
      void loadColabJobs(experiment.id).then(jobs => {
        if (!live) return;
        const ram = jobs.filter(job => job.protocol === "radial_arm_maze");
        setHistory(ram);
        setSelectedId(current => current && ram.some(job => job.jobId === current)
          ? current : (ram.find(job => job.resultsReady) ?? ram[0])?.jobId ?? null);
      }).catch(reason => { if (live) setError(String(reason)); });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [experiment.id]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let live = true;
    const status = (event: Event) => setConnected((event as CustomEvent<{ connected: boolean }>).detail.connected);
    window.addEventListener(COLAB_STATUS_EVENT, status);
    void loadColabSummary().then(summary => { if (live) setConnected(summary.connected); }).catch(() => undefined);
    return () => { live = false; window.removeEventListener(COLAB_STATUS_EVENT, status); };
  }, []);

  useEffect(() => {
    if (!selected?.resultsReady || selected.status === "queued" || selected.status === "running") { setResult(null); setArtifacts([]); return; }
    let live = true;
    setResult(null);
    void Promise.all([loadColabResult(selected.jobId), loadRamArtifacts(selected.jobId)]).then(([raw, files]) => {
      if (!live) return;
      const parsed = parseRamResult(raw);
      if (parsed.jobId !== selected.jobId || (experiment.video.sha256 && parsed.video.originalSha256 !== experiment.video.sha256)) {
        throw new Error("O tracking não corresponde ao vídeo original desta sessão.");
      }
      setResult(parsed); setArtifacts(files);
    }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [selected?.jobId, selected?.resultsReady, selected?.status, experiment.video.sha256]);

  const run = async (file?: File) => {
    if (busy || active) return;
    if (!isTauriRuntime()) { setError("O processamento Colab requer o aplicativo desktop."); return; }
    if (!experiment.geometry.walkablePolygonPx) { setError("Marque a área analisável do labirinto antes da análise."); return; }
    let preparation = experiment.video.preparation;
    if (preparation?.policyVersion !== "fst-adaptive-1") preparation = undefined;
    if (!preparation && !file) {
      file = asset?.file;
      if (!file) { fileRef.current?.click(); return; }
    }
    setBusy(true); setError(null); setMessage("Conferindo vídeo e conexão com o Colab");
    let started = false;
    try {
      if (preparation && !await checkVideoStaging(experiment.id, preparation.uploadId)) preparation = undefined;
      const summary = await loadColabSummary(); setConnected(summary.connected);
      if (!summary.connected) throw new Error("Conecte o Colab antes de iniciar o tracking RAM.");
      if (summary.providerError) throw new Error(summary.providerError);
      if (summary.eligibleGpuCount < 1) throw new Error("Nenhuma GPU elegível está disponível no Colab.");
      if (!preparation) {
        if (!file) { fileRef.current?.click(); return; }
        if (file.name !== experiment.video.filename || file.size !== experiment.video.sizeBytes) {
          throw new Error("Selecione o mesmo arquivo usado para criar o experimento.");
        }
        const prepared = await prepareFstVideo(experiment.id, file, experiment.video,
          (_progress, detail) => setMessage(detail), experiment.video.sha256);
        preparation = prepared.preparation;
        setAsset(experiment.id, { ...asset, file, objectUrl: asset?.objectUrl ?? URL.createObjectURL(file) });
        updateRadialMazeExperiment(experiment.id, current => ({ video: { ...current.video,
          sha256: prepared.originalSha256, preparation } }));
      }
      setMessage("Enviando análise RAM ao Colab");
      const job = await startRamJob(experiment, preparation);
      started = true;
      setSelectedId(job.jobId);
      setHistory(current => [job, ...current.filter(item => item.jobId !== job.jobId)]);
      updateRadialMazeExperiment(experiment.id, { status: "processing" });
      const done = await waitForColabJob(job.jobId, current => {
        setMessage(current.message);
        setHistory(jobs => [current, ...jobs.filter(item => item.jobId !== current.jobId)]);
      });
      if (done.status === "failed" && !done.resultsReady) throw new Error(done.error ?? "Falha no tracking RAM.");
      updateRadialMazeExperiment(experiment.id, { status: "review", trackingSelection: { engine: "colab", jobId: done.jobId } });
      if (done.status === "failed") setError(`Dados preservados; execução interrompida: ${done.error}`);
    } catch (reason) { setError(String(reason)); if (started) updateRadialMazeExperiment(experiment.id, { status: "failed" }); }
    finally { setBusy(false); }
  };
  const attach = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file) void run(file);
  };
  const sampled = result?.frames.filter(row => row.mouseCenter).filter((_, index) => index % Math.max(1, Math.floor(result.frameCount / 800))) ?? [];

  return <section className="panel ram-colab-panel">
    <input ref={fileRef} className="sr-only" type="file" accept="video/*" onChange={attach}/>
    <h2>Tracking no Colab</h2>
    <p>O detector Wistar v2 e a HRNet geram observações por frame dentro da área marcada. Esta execução é experimental e exige revisão humana antes de qualquer métrica de comportamento.</p>
    <div className="results-actions">
      <Button disabled={busy || Boolean(active) || !isTauriRuntime()} onClick={() => void run()}>{busy || active ? "Processando…" : "Executar no Colab"}</Button>
      {!connected && isTauriRuntime() && <Button variant="secondary" onClick={() => navigate({ name: "colab" })}>Conectar Colab</Button>}
    </div>
    {!isTauriRuntime() && <p>O processamento Colab está disponível no aplicativo desktop.</p>}
    {(busy || active) && <p role="status">{active ? `${active.progress}% · ${active.message}` : message}</p>}
    {error && <div role="alert" className="validation-box invalid"><Info size={16}/>{error}</div>}
    {history.length > 0 && <div className="ram-revision-picker"><label>Execução
      <select value={selected?.jobId ?? ""} onChange={event => { const jobId = event.target.value; setSelectedId(jobId);
        if (history.find(job => job.jobId === jobId)?.resultsReady) updateRadialMazeExperiment(experiment.id, { status: "review", trackingSelection: { engine: "colab", jobId } }); }}>
        {history.map(job => <option key={job.jobId} value={job.jobId}>{new Date(job.createdAt).toLocaleString("pt-BR")} · {job.status}</option>)}
      </select></label></div>}
    {selected?.status === "failed" && <p role="alert">{selected.error ?? "Execução interrompida."}</p>}
    {result && <>
      <div className="validation-box"><Info size={17}/><span>Tracking experimental: {result.observedFrames} de {result.frameCount} frames com centro confiável dentro da área analisável. Nenhuma visita, erro de memória ou recompensa foi calculada.</span></div>
      {result.geometry.revision !== experiment.geometry.revision && <p>Esta execução usa a revisão {result.geometry.revision} da geometria. A geometria atual é a revisão {experiment.geometry.revision}.</p>}
      <svg className="ram-geometry-editor ram-geometry-preview" viewBox={`0 0 ${result.video.width} ${result.video.height}`} role="img" aria-label="Centros observados no labirinto">
        {experiment.calibrationThumbnailDataUrl && <image href={experiment.calibrationThumbnailDataUrl} width={result.video.width} height={result.video.height}/>}
        <polygon points={result.geometry.walkablePolygonPx.map(point => `${point.x},${point.y}`).join(" ")} className="ram-center-polygon"/>
        {sampled.map(row => <circle key={row.frame} cx={row.mouseCenter!.x} cy={row.mouseCenter!.y} r={Math.max(2, result.video.width / 350)} fill="#51ddce" opacity="0.65"/>)}
      </svg>
      <div className="fst-exports"><h3>Arquivos da execução</h3><div>{artifacts.map(file => <a key={file.name} href={file.url} download={file.name}><Download size={15}/>{file.name}</a>)}</div></div>
    </>}
  </section>;
}
