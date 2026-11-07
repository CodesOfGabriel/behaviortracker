import { useEffect, useMemo, useRef, useState } from "react";
import { ScanSearch } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { downloadText, parseCanonicalPoseCsv } from "../../lib/csv";
import { formatDuration } from "../../lib/format";
import type { Experiment } from "../../types";
import { isTauriRuntime } from "./connection";
import { loadColabJobs, loadDiagnosticResult, resolveDiagnosticUpload, startColabJob, type ColabJob, type DiagnosticReport } from "./analysis";
import { AnalysisWorkflow } from "./AnalysisWorkflow";
import "./diagnostic.css";

const states: Record<string, string> = {
  detector_missing: "Sem caixa do detector", pose_missing: "Caixa sem pontos utilizáveis",
  center_missing: "Pontos sem suporte para o centro", adapter_rejected: "Pontos rejeitados na conversão", partial: "Detecção parcial / baixa confiança", points_available: "Pontos disponíveis",
};
const timings: Record<string, string> = { modelLoadSec: "Carregar modelos", decodeSec: "Decodificar vídeo", detectorSec: "Detector", poseSec: "Estimar pontos", exportSec: "Exportar dados", totalSec: "Total no worker" };
type Result = { report: DiagnosticReport; rawPoseCsv: string; clipUrl: string | null };

export function DiagnosticPanel({ experiment, file, open, disabled, onAttach, onBusy, onVideoRestaged }: {
  experiment: Experiment; file?: File; open: boolean; disabled: boolean; onAttach: () => void; onBusy: (busy: boolean) => void; onVideoRestaged: (uploadId: string) => void;
}) {
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(60, experiment.video.durationSec));
  const [jobs, setJobs] = useState<ColabJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [needsVideo, setNeedsVideo] = useState(false);
  const stagedId = useRef<string | undefined>(experiment.video.preparation?.uploadId);
  const [result, setResult] = useState<Result | null>(null);
  const [time, setTime] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const video = useRef<HTMLVideoElement>(null);
  useEffect(()=>{if(!open)video.current?.pause();},[open]);
  const job = jobs.find((item) => item.jobId === selected) ?? jobs[0];
  const active = starting || jobs.some((item) => ["running", "queued"].includes(item.status));
  useEffect(() => { onBusy(active); }, [active, onBusy]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const refresh = () => {
      setClock(Date.now());
      void loadColabJobs(experiment.id).then((items) => {
        if (!disposed) setJobs(items.filter((item) => item.diagnostic));
      }).catch(() => { /* Uma falha transitória não apaga o último estado confirmado. */ });
    };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [experiment.id]);
  const readyId = job?.status === "succeeded" ? job.jobId : null;
  useEffect(() => {
    setResult(null); setTime(0);
    if (!readyId) return;
    let disposed = false;
    void loadDiagnosticResult(readyId).then((data) => { parseCanonicalPoseCsv(data.rawPoseCsv); if (!disposed) setResult(data); })
      .catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [readyId]);
  const samples = useMemo(() => result ? parseCanonicalPoseCsv(result.rawPoseCsv) : [], [result]);
  const byFrame = useMemo(() => {
    const map = new Map<number, typeof samples>();
    for (const sample of samples) { const points = map.get(sample.frameIndex) ?? []; points.push(sample); map.set(sample.frameIndex, points); }
    return map;
  }, [samples]);
  const index = result ? Math.min(result.report.frames.length - 1, Math.floor(time * result.report.fps + 0.0001)) : 0;
  const frame = result?.report.frames[index];
  const points = byFrame.get(index) ?? [];
  const failedFrames = result?.report.frames.filter((item) => ["detector_missing", "pose_missing", "center_missing", "adapter_rejected"].includes(item.state)) ?? [];
  const validRange = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end - start <= 60 && end <= experiment.video.durationSec;
  const seek = (value: number) => { if (video.current) { video.current.pause(); video.current.currentTime = value; } setTime(value); };
  const run = async () => {
    if (!validRange || active || disabled) return;
    if (!isTauriRuntime()) { setError("Abra a versão desktop para executar o teste no Colab."); return; }
    setStarting(true); setError(null); setNeedsVideo(false); setMessage("Conferindo o vídeo no cache local");
    try {
      const uploadId = await resolveDiagnosticUpload(experiment.id, stagedId.current, file, (_, text) => setMessage(text));
      if (!uploadId) { setNeedsVideo(true); setError("O vídeo não está mais no cache. Selecione o original e clique em testar novamente. Seu experimento e suas correções foram preservados."); onAttach(); return; }
      stagedId.current = uploadId;
      if (uploadId !== experiment.video.preparation?.uploadId) onVideoRestaged(uploadId);
      const started = await startColabJob(experiment.id, uploadId, experiment.video, experiment.arena, { startSec: start, endSec: end });
      setJobs((items) => [started, ...items.filter((item) => item.jobId !== started.jobId)]); setSelected(started.jobId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setStarting(false); }
  };
  return <section className="diagnostic-panel panel" hidden={!open} aria-label="Diagnóstico curto de rastreamento">
    <div className="diagnostic-heading"><div><span className="eyebrow">Antes da análise completa</span><h2>Testar rastreamento</h2>
      <p>Escolha até 60 s com paredes, animal em pé e momentos de perda. O teste não altera poses, correções ou métricas do experimento.</p></div>
      <Button variant="secondary" icon={<ScanSearch size={16} />} disabled={!validRange || active || disabled} loading={starting} onClick={() => void run()}>Testar trecho no Colab</Button></div>
    <div className="diagnostic-range"><label>Início (segundos)<input aria-label="Início do diagnóstico" type="number" min="0" max={experiment.video.durationSec} step="0.1" value={Number.isNaN(start) ? "" : start} disabled={active} onChange={(e) => setStart(e.target.valueAsNumber)} /></label>
      <label>Fim (segundos)<input aria-label="Fim do diagnóstico" type="number" min="0" max={experiment.video.durationSec} step="0.1" value={Number.isNaN(end) ? "" : end} disabled={active} onChange={(e) => setEnd(e.target.valueAsNumber)} /></label>
      <span>{validRange ? `${(end - start).toFixed(1)} s · resolução e pixels preservados` : "Selecione um intervalo de até 60 s dentro do vídeo"}</span></div>
    {error && <p role="alert" className="editor-error">{error}</p>}
    {needsVideo && <Button variant="secondary" onClick={onAttach}>Selecionar vídeo original</Button>}
    {jobs.length > 0 && <label className="diagnostic-history">Teste salvo <select aria-label="Teste diagnóstico salvo" value={job?.jobId ?? ""} onChange={(e) => { setSelected(e.target.value); setError(null); }}>
      {jobs.map((item) => <option key={item.jobId} value={item.jobId}>{item.customModel?"Personalizado":"SuperAnimal"} · {item.diagnostic?.startSec}–{item.diagnostic?.endSec} s · {item.status} · {item.createdAt}</option>)}</select></label>}
    {(job || starting) && <AnalysisWorkflow job={job ?? null} preparing={starting} message={message} localError={error} elapsedSec={job ? Math.max(0, ((["running", "queued"].includes(job.status) ? clock : Date.parse(job.updatedAt)) - Date.parse(job.createdAt)) / 1000) : 0} />}
    {result && <>
      <div className="diagnostic-stats"><div><strong>{result.report.summary.detectorCoveragePct.toFixed(1)}%</strong><span>Frames com caixa</span></div><div><strong>{result.report.summary.centerCoveragePct.toFixed(1)}%</strong><span>Frames com centro estimado</span></div>
        <div><strong>{failedFrames.length} / {result.report.summary.frameCount}</strong><span>Frames sem caixa, pose ou centro</span></div></div>
      <p className="diagnostic-caution">Cobertura não é precisão. Um centro estimado também pode ter baixa confiança; presença não significa elegibilidade para métricas. Confira o vídeo: este teste não mede acurácia nem reconhece rearing/grooming.</p>
      <div className="diagnostic-result-grid"><div>
        {result.clipUrl ? <div className="diagnostic-player" style={{ aspectRatio: `${result.report.geometry.videoWidth} / ${result.report.geometry.videoHeight}` }}>
          <video ref={video} key={readyId} src={result.clipUrl} muted playsInline onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onSeeked={(e) => setTime(e.currentTarget.currentTime)} onError={() => setError("O trecho local não pôde ser reproduzido; os dados diagnósticos continuam disponíveis.")} />
          <svg viewBox={`0 0 ${result.report.geometry.videoWidth} ${result.report.geometry.videoHeight}`} aria-label="Caixa do detector e todos os pontos brutos">
            {frame?.bbox && <rect x={frame.bbox.x} y={frame.bbox.y} width={frame.bbox.width} height={frame.bbox.height} fill="none" stroke="#9d80ff" strokeWidth={3} vectorEffect="non-scaling-stroke"><title>Detector · {(100 * frame.bbox.score).toFixed(1)}%</title></rect>}
            {points.filter((p) => p.xPx != null && p.yPx != null && p.status !== "missing").map((p) => <circle key={p.keypoint} cx={p.xPx!} cy={p.yPx!} r={Math.max(3, result.report.geometry.videoWidth / 250)} fill={p.likelihood >= 0.6 ? "#c7fa60" : "#f6c86f"} stroke="#10151e" strokeWidth="1"><title>{p.keypoint} · {(100 * p.likelihood).toFixed(1)}%</title></circle>)}
          </svg></div> : <p>Trecho local indisponível. O relatório e os pontos foram preservados.</p>}
        <div className="diagnostic-controls"><Button size="sm" variant="secondary" onClick={() => { if (video.current?.paused) void video.current.play().catch(() => setError("Não foi possível reproduzir o trecho")); else video.current?.pause(); }}>Reproduzir / pausar</Button>
          <Button size="sm" variant="secondary" onClick={() => seek(Math.max(0, time - 1 / result.report.fps))}>−1 frame</Button><Button size="sm" variant="secondary" onClick={() => seek(Math.min(result.report.durationSec - 1 / result.report.fps, time + 1 / result.report.fps))}>+1 frame</Button></div>
        <input aria-label="Posição no trecho diagnóstico" className="diagnostic-seek" type="range" min="0" max={Math.max(0, result.report.durationSec - 1 / result.report.fps)} step={1 / result.report.fps} value={time} onChange={(e) => seek(e.target.valueAsNumber)} />
        <p>Frame {index} · trecho {formatDuration(time)} · origem ≈{formatDuration(result.report.selection.startSec + time)} · {states[frame?.state ?? ""]} · {frame?.availablePoints ?? 0}/{frame?.totalPoints ?? 0} pontos</p>
        <small>{result.report.confidencePolicy==="uncalibrated"?"Modelo personalizado experimental: pontos sem confiança anatômica calibrada, todos exigem revisão.":"Caixa roxa: detector. Verde: score ≥ 0,60. Amarelo: 0,10–0,60."} Sem interpolação ou recuperação. Timestamps por índice/FPS, não PTS exatos.</small>
      </div><aside>
        <h3>Onde o rastreamento se perde</h3><dl>{Object.entries(result.report.summary.states).map(([state, count]) => <div key={state}><dt>{states[state] ?? state}</dt><dd>{count} frames</dd></div>)}</dl>
        <Button size="sm" variant="secondary" disabled={!failedFrames.some((f) => f.frameIndex > index)} onClick={() => { const next = failedFrames.find((f) => f.frameIndex > index); if (next) seek(next.timestampSec); }}>Próximo frame sem rastreamento</Button>
        <h3>Tempos medidos no worker</h3><dl>{Object.entries(result.report.timings).map(([key, value]) => <div key={key}><dt>{timings[key] ?? key}</dt><dd>{value.toFixed(2)} s</dd></div>)}</dl><small>Não inclui espera por GPU, preparação local, instalação ou transferência.</small>
        <div className="diagnostic-controls"><Button size="sm" variant="secondary" onClick={() => downloadText(`diagnostic-${job?.jobId}.json`, JSON.stringify(result.report, null, 2), "application/json")}>Exportar relatório</Button><Button size="sm" variant="secondary" onClick={() => downloadText(`raw-points-${job?.jobId}.csv`, result.rawPoseCsv, "text/csv")}>Exportar pontos brutos</Button></div>
      </aside></div>
    </>}
  </section>;
}
