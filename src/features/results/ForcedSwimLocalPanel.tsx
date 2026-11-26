import { AnalysisDetailsLayout, DetailsVideoCard } from "./AnalysisDetailsLayout";
import { ResultMotionChart } from "./ResultMotionChart";
import { PresenceResultChart } from "./PresenceResultChart";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/ui/card";
import type { LocalAnalysisControls } from "./AnalysisWorkspace";
import { BoxTrajectoryView } from "./BoxTrajectoryView";
import { LocalAuditVideo } from "../local/LocalAuditVideo";
import { LocalMotionOverlay } from "../local/LocalMotionOverlay";
import { LocalBodyOverlay } from "../local/LocalBodyOverlay";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Cpu, Download, Info } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { downloadText } from "../../lib/csv";
import { boxCenterTrajectory, boxTrajectoryStyle } from "../../lib/boxes";
import { validateForcedSwim } from "../../lib/fst";
import { useAppStore } from "../../store/AppStore";
import type { ForcedSwimExperiment, PoseSample } from "../../types";
import { getStagedVideoSha256, loadStagedVideo, stageVideo } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { cancelLocalJob, getLocalEnvironment, listLocalJobs, loadLocalFstResult, setupLocalEnvironment, startLocalFst,
  type LocalEnvironment, type LocalFstResult, type LocalJob } from "../local/api";

function errorText(reason: unknown) { return typeof reason === "string" ? reason : reason instanceof Error ? reason.message : String(reason); }
export function nearestFrame(times: number[], second: number) {
  if (!times.length) return 0;
  let low = 0, high = times.length;
  while (low < high) { const middle = (low + high) >>> 1; if (times[middle] < second) low = middle + 1; else high = middle; }
  if (low === 0) return 0;
  if (low === times.length) return times.length - 1;
  return second - times[low - 1] <= times[low] - second ? low - 1 : low;
}

export function ForcedSwimLocalPanel({ experiment, children }: {
  experiment: ForcedSwimExperiment;
  children: (controls: LocalAnalysisControls) => ReactNode;
}) {
  const { assets, setAsset, updateForcedSwimExperiment, analysisActivity, setAnalysisActivity } = useAppStore();
  const asset = assets[experiment.id];
  const [environment, setEnvironment] = useState<LocalEnvironment | null>(null);
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<LocalFstResult | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [settingUp, setSettingUp] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const active = jobs.find(job => job.state === "queued" || job.state === "running");
  const selected = jobs.find(job => job.jobId === selectedId);
  const busy = settingUp || running || Boolean(active) || Boolean(analysisActivity[experiment.id]?.starting);

  useEffect(() => {
    const video = videoRef.current;
    if (!video?.requestVideoFrameCallback) return;
    let callback = 0, live = true;
    const update: VideoFrameRequestCallback = (_now, metadata) => {
      if (!live) return;
      setTime(metadata.mediaTime);
      callback = video.requestVideoFrameCallback(update);
    };
    callback = video.requestVideoFrameCallback(update);
    return () => { live = false; video.cancelVideoFrameCallback(callback); };
  }, [videoUrl, result?.runId]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let live = true;
    void getLocalEnvironment().then(value => { if (live) setEnvironment(value); }).catch(reason => { if (live) setError(errorText(reason)); });
    const refresh = () => { void listLocalJobs(experiment.id).then(value => { if (live) {
      const fst = value.filter(job => job.config.protocol === "forced_swim");
      setJobs(fst);
      setSelectedId(experiment.trackingSelection?.engine === "opencv"
        && fst.some(job => job.jobId === experiment.trackingSelection?.jobId)
        ? experiment.trackingSelection.jobId : null);
    }}).catch(reason => { if (live) setError(errorText(reason)); }); };
    refresh(); const timer = window.setInterval(refresh, 2_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [experiment.id, experiment.trackingSelection?.engine, experiment.trackingSelection?.jobId]);

  useEffect(() => {
    if (!selected || selected.state !== "succeeded") { setResult(null); setVideoUrl(null); return; }
    let live = true;
    setResult(null); setVideoUrl(null);
    void loadLocalFstResult(selected.jobId)
      .then(data => {
        if (!live) return;
        if (data.runId !== selected.jobId || data.video.sha256 !== selected.videoSha256
          || (experiment.video.sha256 && data.video.sha256 !== experiment.video.sha256) || data.behaviorMetrics !== null
          || data.frames.some(frame => frame.classification !== "NOT_CLASSIFIED")) throw new Error("Resultado FST local incompatível.");
        setResult(data); setError(null);
      }).catch(reason => { if (live) setError(errorText(reason)); });
    void loadStagedVideo(experiment.id, selected.uploadId).then(url => { if (live) setVideoUrl(url); }).catch(() => undefined);
    return () => { live = false; };
  }, [selected?.jobId, selected?.state, selected?.uploadId, selected?.videoSha256, experiment.id, experiment.video.sha256]);

  async function setup() {
    setSettingUp(true); setError(null);
    try { setEnvironment(await setupLocalEnvironment()); } catch (reason) { setError(errorText(reason)); }
    finally { setSettingUp(false); }
  }

  async function run(file?: File) {
    if (busy) return;
    if (!isTauriRuntime()) { setError("A análise local requer o aplicativo desktop."); return; }
    if (!environment?.ready) { setError("Prepare o ambiente OpenCV local."); return; }
    const validation = validateForcedSwim(experiment);
    if (validation) { setError(validation); return; }
    const original = file ?? asset?.file;
    if (!original) { fileRef.current?.click(); return; }
    if (original.name !== experiment.video.filename || original.size !== experiment.video.sizeBytes) {
      setError("Selecione o vídeo original deste experimento."); return;
    }
    setRunning(true); setError(null);
    setAnalysisActivity(experiment.id, { starting: true, engine: "opencv", startedAt: Date.now(), message: "Copiando vídeo", error: null, videoProgress: null });
    let started = false;
    try {
      const uploadId = await stageVideo(experiment.id, original, (_percent, text) => setAnalysisActivity(experiment.id, { message: text }));
      const sha256 = await getStagedVideoSha256(uploadId);
      if (experiment.video.sha256 && experiment.video.sha256 !== sha256) throw new Error("O SHA-256 do vídeo não corresponde ao experimento.");
      if (!experiment.video.sha256) updateForcedSwimExperiment(experiment.id, current => ({ video: { ...current.video, sha256 } }));
      if (file) {
        if (asset?.objectUrl) URL.revokeObjectURL(asset.objectUrl);
        setAsset(experiment.id, { ...asset, file: original, objectUrl: URL.createObjectURL(original) });
      }
      const job = await startLocalFst(experiment.id, uploadId, {
        protocol: "forced_swim", width: experiment.video.width, height: experiment.video.height,
        subjects: experiment.subjects, tanks: experiment.tanks,
      });
      started = true;
      setJobs(current => [{ ...job, uploadId, error: null, report: {} }, ...current]);
      updateForcedSwimExperiment(experiment.id, { status: "processing" });
      for (;;) {
        const current = (await listLocalJobs(experiment.id)).find(item => item.jobId === job.jobId);
        if (!current) throw new Error("Execução local FST não encontrada.");
        setJobs(previous => [current, ...previous.filter(item => item.jobId !== current.jobId)]);
        setAnalysisActivity(experiment.id, { message: `${current.report.framesProcessed ?? 0} frames analisados` });
        if (current.state === "succeeded") {
          setSelectedId(current.jobId);
          updateForcedSwimExperiment(experiment.id, { status: "review", trackingSelection: { engine: "opencv", jobId: current.jobId } });
          break;
        }
        if (["failed", "cancelled"].includes(current.state)) throw new Error(current.error ?? "FST local interrompido.");
        await new Promise(resolve => window.setTimeout(resolve, 1_500));
      }
    } catch (reason) {
      const failure = errorText(reason);
      setAnalysisActivity(experiment.id, { error: failure, message: failure });
      if (started) updateForcedSwimExperiment(experiment.id, current => ({ status: current.trackingSelection ? "review" : "failed" }));
    } finally {
      setRunning(false); setAnalysisActivity(experiment.id, { starting: false, videoProgress: null });
    }
  }

  function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file) void run(file);
  }

  const frameTimes = useMemo(() => result?.frames.filter(row => row.animalId === result.subjects[0]?.animalId).map(row => row.timestampSec) ?? [], [result]);
  const rowsByFrame = useMemo(() => {
    const rows = new Map<number, LocalFstResult["frames"]>();
    for (const row of result?.frames ?? []) rows.set(row.frame, [...(rows.get(row.frame) ?? []), row]);
    return rows;
  }, [result]);
  const frame = nearestFrame(frameTimes, time);
  const frameRows = rowsByFrame.get(frame) ?? [];
  const boxSamples = useMemo(() => {
    const animals = new Map<string, PoseSample[]>();
    for (const row of result?.frames ?? []) {
      const samples = animals.get(row.animalId) ?? [];
      samples.push({ frameIndex: row.frame, timestampSec: row.timestampSec, keypoint: "box_center",
        xPx: null, yPx: null, likelihood: 0, source: "segmented", referenceApproved: false,
        status: row.presence === "IN_TANK" && row.bbox ? "valid" : "missing",
        bbox: row.presence === "IN_TANK" ? row.bbox ?? undefined : undefined,
        contour: row.presence === "IN_TANK" ? row.contour ?? undefined : undefined });
      animals.set(row.animalId, samples);
    }
    return animals;
  }, [result]);
  const trajectories = useMemo(() => new Map([...boxSamples].map(([animal, samples]) => [animal,
    boxCenterTrajectory(samples.slice(Math.max(0, frame-150), frame+1), result?.video.width ?? 0, result?.video.height ?? 0),
  ])), [boxSamples, frame, result]);
  const panel = <section className="panel local-analysis-panel fst-local-panel" aria-label="Análise local FST">
    <input ref={fileRef} type="file" accept="video/*" className="sr-only" onChange={attach} />
    <h2><Cpu size={20} /> Configuração local</h2>
    <p>OpenCV examina cada cilindro no vídeo original usando a CPU.</p>
    <div className="validation-box"><Info size={16} /><span>Presença visual experimental. Nenhuma pose anatômica ou imobilidade, natação e escalada é classificada automaticamente. Revise reflexos e intervalos incertos.</span></div>
    {!environment?.ready ? <div className="local-setup"><p>{environment?.message ?? "Verificando OpenCV…"}</p>
      <Button variant="secondary" disabled={settingUp || !isTauriRuntime()} onClick={() => void setup()}>{settingUp ? "Preparando…" : "Preparar análise local"}</Button></div>
      : <p className="local-environment">OpenCV {environment.version} · CPU</p>}
    {active && <Button variant="secondary" onClick={() => void cancelLocalJob(active.jobId).catch(reason => setError(errorText(reason)))}>Cancelar</Button>}
    {active && <p role="status">{active.report.phase === "reference" ? "Montando referência visual · " : "Presença · "}{active.report.phase === "reference" ? active.report.referenceFrames ?? 0 : active.report.framesProcessed ?? 0}{active.report.totalFrames ? ` / ${active.report.totalFrames}` : ""} frames · {active.report.computeBackend ?? "CPU"}</p>}
    {error && <div role="alert" className="validation-box invalid"><Info size={16} />{error}</div>}
    {jobs.length > 0 && <div className="local-job-history"><h3>Execuções locais</h3>{jobs.map(job => <button key={job.jobId} type="button" disabled={busy || job.state !== "succeeded"} aria-pressed={selected?.jobId === job.jobId}
      onClick={() => { setSelectedId(job.jobId); updateForcedSwimExperiment(experiment.id, { trackingSelection: { engine: "opencv", jobId: job.jobId }, status: "review" }); }}>
      <strong>{new Date(job.createdAt).toLocaleString("pt-BR")}</strong><span>{job.state} · {job.report.computeBackend ?? "CPU"}</span></button>)}</div>}
  </section>;
  const detailsPanel = result && <AnalysisDetailsLayout video={<DetailsVideoCard description={`${result.video.frameCount.toLocaleString("pt-BR")} quadros · ${result.video.fps.toFixed(3)} FPS · presença visual`}>
      {videoUrl ? <div className="fst-local-player"><video ref={videoRef} src={videoUrl} preload="metadata" controls onTimeUpdate={event => setTime(event.currentTarget.currentTime)} />
        <svg viewBox={`0 0 ${result.video.width} ${result.video.height}`} preserveAspectRatio="none" aria-label="Presença local sincronizada" role="img">
          {frameRows.map(row => { const tank = result.tanks.find(item => item.animalId === row.animalId);
            return <g key={row.animalId}>
              {trajectories.get(row.animalId)?.segments.map((segment, i) => segment.points.length === 1
                ? <circle key={i} cx={segment.points[0].x} cy={segment.points[0].y} r={3} fill={boxTrajectoryStyle[segment.state].color} />
                : <polyline key={i} points={segment.points.map(p => `${p.x},${p.y}`).join(" ")} fill="none"
                  stroke={boxTrajectoryStyle[segment.state].color} strokeWidth={Math.max(2, result.video.width/500)} strokeLinejoin="round" strokeLinecap="round" />)}
              {row.presence === "IN_TANK" && row.bbox && <>
                <rect {...row.bbox} fill="none" stroke="#51ddce" strokeWidth={Math.max(2, result.video.width / 500)} />
                <circle cx={row.bbox.x+row.bbox.width/2} cy={row.bbox.y+row.bbox.height/2} r={Math.max(4, result.video.width/350)} fill="#51ddce" />
              </>}
              <LocalBodyOverlay sample={boxSamples.get(row.animalId)?.[frame]} samples={boxSamples.get(row.animalId)} width={result.video.width} height={result.video.height} />
              <text x={tank?.roiPx.x ?? 0} y={(tank?.roiPx.y ?? 0) + 24} fill={row.presence === "UNCERTAIN" ? "#e9b85c" : "#51ddce"} stroke="#111" strokeWidth="3" paintOrder="stroke" fontSize={Math.max(15, result.video.width / 75)}>{row.animalId}: {row.presence}</text></g>; })}
          <LocalMotionOverlay tracks={boxSamples} width={result.video.width} height={result.video.height} time={time} />
        </svg></div> : <div className="details-video-empty">O vídeo original não está disponível neste dispositivo.</div>}
      {!result.frames.some(row=>row.contour?.length)&&<p className="details-chart-note">Esta execução não contém silhuetas. Refaça a análise para exibir a linha corporal estimada.</p>}
      <div className="details-video-actions"><Button variant="secondary" icon={<Download size={15}/>} onClick={()=>downloadText(`fst-local-${result.runId}.json`,JSON.stringify(result,null,2),"application/json")}>Exportar dados</Button></div>
    </DetailsVideoCard>}>
      <ResultMotionChart tracks={boxSamples} width={result.video.width} height={result.video.height} time={time} onSeek={value=>{if(videoRef.current)videoRef.current.currentTime=value;setTime(value);}}/>
      <PresenceResultChart subjects={result.subjects} frames={result.frames}/>
    </AnalysisDetailsLayout>;
  const summaryPanel = result ? <PresenceResultChart subjects={result.subjects} frames={result.frames}/> : <Card><CardHeader><CardTitle>Resumo da execução local</CardTitle></CardHeader><CardContent>Selecione uma execução local concluída no Resumo.</CardContent></Card>;
  return children({ run: () => void run(), busy, ready: Boolean(environment?.ready), job: (active ?? jobs[0] ?? null), panel,
    resultPanels: {
      summary: summaryPanel,
      video: result ? <LocalAuditVideo key={result.runId} jobId={result.runId} protocol="presence" title="Vídeo · Máquina local" /> : summaryPanel,
      trajectory: result ? <BoxTrajectoryView tracks={boxSamples} width={result.video.width} height={result.video.height}/> : summaryPanel,
      details: result ? detailsPanel : summaryPanel,
      exports: <section className="panel protocol-result-panel"><h2>Arquivos da execução local</h2>{result ? <Button variant="secondary" icon={<Download size={15}/>}
        onClick={() => downloadText(`fst-local-${result.runId}.json`, JSON.stringify(result, null, 2), "application/json")}>Exportar dados FST</Button> : <p>Selecione uma execução local concluída.</p>}</section>,
    } });
}
