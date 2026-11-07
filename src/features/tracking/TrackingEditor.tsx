import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CloudCog,
  Clock3,
  Eye,
  EyeOff,
  Flag,
  Gauge,
  History,
  MousePointer2,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  ScanSearch,
  SkipForward,
  Undo2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { activeCorrectionEvents, applyCorrections } from "../../lib/corrections";
import { parseCanonicalPoseCsv } from "../../lib/csv";
import { confidenceLabel, drawablePose, inferredFps, originalPose, poseSourceLabel, trajectorySegments } from "../../lib/pose";
import { makeDemoPose } from "../../lib/demo-data";
import { centerPolygonPx, pointsToSvg } from "../../lib/geometry";
import { cn, formatDuration } from "../../lib/format";
import { useAppStore } from "../../store/AppStore";
import type { CorrectionEvent, Point, PoseSample, PoseStatus } from "../../types";
import {
  loadColabResult,
  loadColabVideo,
  loadColabJobs,
  checkVideoStaging,
  prepareVideo,
  startColabJob,
  waitForColabJob,
  type ColabJob,
} from "../colab/analysis";
import { AnalysisWorkflow } from "../colab/AnalysisWorkflow";
import { DiagnosticPanel } from "../colab/DiagnosticPanel";
import { TrainingPanel } from "../training/TrainingPanel";
import { BehaviorReview } from "./BehaviorReview";
import {
  COLAB_PROFILE_ID,
  isTauriRuntime,
  loadColabSummary,
} from "../colab/connection";

const statusInfo: Record<PoseStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  valid: { label: "Confiável", tone: "success" },
  low_confidence: { label: "Baixa confiança", tone: "warning" },
  jump: { label: "Salto espacial", tone: "danger" },
  missing: { label: "Não detectado", tone: "danger" },
  out_of_arena: { label: "Fora da arena", tone: "danger" },
};

const keypointLabels: Record<string, string> = {
  body_center: "Centro corporal",
  nose: "Focinho",
  tail_base: "Base da cauda",
  left_ear: "Orelha esquerda",
  right_ear: "Orelha direita",
  left_forepaw: "Pata anterior esquerda",
  right_forepaw: "Pata anterior direita",
  neck: "Nuca", mid_back: "Meio do dorso", hip: "Quadril",
};

function nearestSample(samples: PoseSample[], time: number) {
  if (!samples.length) return undefined;
  let nearest = samples[0];
  let delta = Math.abs(nearest.timestampSec - time);
  for (const sample of samples) {
    const nextDelta = Math.abs(sample.timestampSec - time);
    if (nextDelta < delta) {
      nearest = sample;
      delta = nextDelta;
    }
    if (sample.timestampSec > time && nextDelta > delta) break;
  }
  return nearest;
}

function timelineBins(samples: PoseSample[], count = 120) {
  if (!samples.length) return [];
  const maxTime = samples.at(-1)?.timestampSec || 1;
  const severity: Record<PoseStatus, number> = { valid: 0, low_confidence: 1, jump: 2, missing: 3, out_of_arena: 3 };
  return Array.from({ length: count }, (_, index) => {
    const start = (index / count) * maxTime;
    const end = ((index + 1) / count) * maxTime;
    const inBin = samples.filter((sample) => sample.timestampSec >= start && sample.timestampSec < end);
    return inBin.reduce<PoseStatus>((worst, sample) => {
      const status = sample.source === "recovered" && sample.status === "valid" ? "low_confidence" : sample.status;
      return severity[status] > severity[worst] ? status : worst;
    }, "valid");
  });
}

function jobElapsedSeconds(job: ColabJob, now: number) {
  const startedAt = Date.parse(job.createdAt);
  const endedAt = job.status === "queued" || job.status === "running" ? now : Date.parse(job.updatedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, (endedAt - startedAt) / 1000);
}

function jobStatusLabel(job: ColabJob) {
  if (job.status === "succeeded") return "Concluída";
  if (job.status === "failed") return "Falhou";
  if (job.status === "queued") return "Na fila";
  return "Processando";
}

export function TrackingEditor({ experimentId }: { experimentId: string }) {
  const {
    getExperiment,
    navigate,
    updateExperiment,
    assets,
    setAsset,
    trackingData,
    setTrackingData,
  } = useAppStore();
  const experiment = getExperiment(experimentId);
  const asset = assets[experimentId];
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoFileRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const importedJobRef = useRef<string | null>(null);
  const analysisRequestedRef = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedKeypoint, setSelectedKeypoint] = useState("body_center");
  const [viewMode, setViewMode] = useState<"raw" | "reviewed">("reviewed");
  const [videoView, setVideoView] = useState<"editor" | "deeplabcut">("editor");
  const [dlcVideo, setDlcVideo] = useState<{ jobId: string; videoUrl: string | null; videoError: string | null } | null>(null);
  const [dlcVideoLoading, setDlcVideoLoading] = useState(false);
  const [dlcPlaybackError, setDlcPlaybackError] = useState(false);
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [analysisJob, setAnalysisJob] = useState<ColabJob | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [analysisStarting, setAnalysisStarting] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [trainingOpen, setTrainingOpen] = useState(false);
  const [trainingBusy, setTrainingBusy] = useState(false);
  const [analysisHistory, setAnalysisHistory] = useState<ColabJob[]>([]);
  const [jobClock, setJobClock] = useState(() => Date.now());
  const [localStartedAt, setLocalStartedAt] = useState<number | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ keypoint: string; before: Point; current: Point } | null>(null);
  const latestResultJob = analysisHistory.find((job) => job.resultsReady || job.status === "succeeded");
  const latestSuccessfulJobId = latestResultJob?.jobId;
  const latestResultStage = `${latestResultJob?.stage}:${latestResultJob?.status}`;

  useEffect(() => {
    if (!latestSuccessfulJobId || !isTauriRuntime()) return;
    let cancelled = false;
    setDlcVideo(null); setDlcVideoLoading(true); setDlcPlaybackError(false);
    void loadColabVideo(latestSuccessfulJobId).then((video) => { if (!cancelled) setDlcVideo(video); })
      .catch((error) => { if (!cancelled) setDlcVideo({ jobId: latestSuccessfulJobId, videoUrl: null, videoError: typeof error === "string" ? error : "Não foi possível abrir o vídeo do DeepLabCut." }); })
      .finally(() => { if (!cancelled) setDlcVideoLoading(false); });
    return () => { cancelled = true; };
  }, [latestSuccessfulJobId, latestResultStage]);

  useEffect(() => {
    if (!experiment || trackingData[experimentId]) return;
    if (experiment.video.timingSource === "synthetic") {
      setTrackingData(experimentId, makeDemoPose(experiment));
    }
  }, [experiment, experimentId, setTrackingData, trackingData]);

  useEffect(() => {
    const job = analysisHistory[0];
    if (!experiment || !job || !isTauriRuntime()) return;
    if ((job.resultsReady || job.status === "succeeded") && !trackingData[experimentId] && importedJobRef.current !== job.jobId) {
      importedJobRef.current = job.jobId;
      void loadColabResult(job.jobId).then((csv) => {
        const samples = parseCanonicalPoseCsv(csv);
        setTrackingData(experimentId, samples);
        updateExperiment(experimentId, {
          status: "review",
          analysisMethodVersion: "oft-0.2",
          referencePoint: samples.some((sample) => sample.keypoint === "body_center")
            ? "body_center"
            : samples[0].keypoint,
        });
      }).catch((error) => { importedJobRef.current = null; setCsvError(typeof error === "string" ? error : "Não foi possível carregar o resultado da análise."); });
    } else if (job.status === "failed" && experiment.status === "processing") {
      updateExperiment(experimentId, { status: "failed" });
      setCsvError(job.error);
    }
  }, [analysisHistory, analysisStarting, experiment, experimentId, setTrackingData, trackingData, updateExperiment]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const refreshHistory = () => {
      void loadColabJobs(experimentId)
        .then((jobs) => {
          if (!cancelled) setAnalysisHistory(jobs.filter((job) => !job.diagnostic && !job.training));
        })
        .catch(() => undefined);
    };
    refreshHistory();
    const timer = window.setInterval(() => {
      setJobClock(Date.now());
      refreshHistory();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [experimentId]);

  const inputSamples = trackingData[experimentId] ?? [];
  const rawSamples = useMemo(() => inputSamples.map(originalPose), [inputSamples]);
  const [placingPoint, setPlacingPoint] = useState(false);
  const correctedSamples = useMemo(
    () => experiment ? applyCorrections(inputSamples, experiment.corrections) : inputSamples,
    [experiment, inputSamples],
  );
  const displayedSamples = viewMode === "raw" ? rawSamples : correctedSamples;
  const keypoints = useMemo(() => Array.from(new Set(rawSamples.map((sample) => sample.keypoint))), [rawSamples]);

  useEffect(() => {
    if (keypoints.length && !keypoints.includes(selectedKeypoint)) setSelectedKeypoint(keypoints[0]);
  }, [keypoints, selectedKeypoint]);

  const referenceKeypoint = experiment && keypoints.includes(experiment.referencePoint)
    ? experiment.referencePoint
    : keypoints[0];
  const referenceSamples = useMemo(
    () => displayedSamples.filter((sample) => sample.keypoint === referenceKeypoint),
    [displayedSamples, referenceKeypoint],
  );
  const detectedFps = inferredFps(referenceSamples, experiment?.video.fps);
  const duration = referenceSamples.at(-1)?.timestampSec || experiment?.video.durationSec || 0;
  const currentReference = nearestSample(referenceSamples, currentTime);
  const currentFrame = currentReference?.frameIndex ?? 0;
  const currentPoints = displayedSamples.filter((sample) => sample.frameIndex === currentFrame);
  const rawCurrentPoints = rawSamples.filter((sample) => sample.frameIndex === currentFrame);
  const selectedPoint = currentPoints.find((sample) => sample.keypoint === selectedKeypoint);
  const visiblePointCount = currentPoints.filter(drawablePose).length;
  const bins = useMemo(() => timelineBins(referenceSamples), [referenceSamples]);
  const centerPolygon = useMemo(
    () => experiment ? centerPolygonPx(experiment.arena) : [],
    [experiment],
  );
  const activeEvents = useMemo(
    () => activeCorrectionEvents(experiment?.corrections ?? []),
    [experiment?.corrections],
  );

  const trajectory = useMemo(() => {
    const currentIndex = referenceSamples.findIndex((sample) => sample.frameIndex === currentFrame);
    return trajectorySegments(referenceSamples.slice(Math.max(0, currentIndex - 100), currentIndex + 1));
  }, [referenceSamples, currentFrame]);

  const setTime = (next: number) => {
    const clamped = Math.max(0, Math.min(duration, next));
    setCurrentTime(clamped);
    if (videoRef.current) videoRef.current.currentTime = clamped;
  };

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = speed;
      if (playing) void video.play();
      else video.pause();
      return;
    }
    if (!playing || duration <= 0) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = ((now - last) / 1000) * speed;
      last = now;
      setCurrentTime((current) => {
        const next = current + delta;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, duration, asset?.objectUrl]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest(".diagnostic-panel, .training-panel")) return;
      if (videoView === "deeplabcut") return;
      if ((event.target as HTMLElement)?.matches("input, textarea, select")) return;
      if (event.code === "Space") {
        event.preventDefault();
        setPlaying((current) => !current);
      } else if (event.key === "ArrowRight") setTime(currentTime + 1 / detectedFps);
      else if (event.key === "ArrowLeft") setTime(currentTime - 1 / detectedFps);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  if (!experiment) {
    return (
      <div className="page not-found"><h1>Experimento não encontrado</h1><Button onClick={() => navigate({ name: "dashboard" })}>Voltar</Button></div>
    );
  }

  const appendEvent = (event: CorrectionEvent) => {
    updateExperiment(experiment.id, { corrections: [...experiment.corrections, event], status: "review" });
  };

  const pointFromPointer = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const svg = svgRef.current!;
    const matrix = svg.getScreenCTM();
    if (!matrix) throw new Error("O vídeo ainda não está pronto para posicionar pontos.");
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return {
      x: Math.max(0, Math.min(experiment.video.width, point.x)),
      y: Math.max(0, Math.min(experiment.video.height, point.y)),
    };
  };

  const finishDrag = () => {
    if (!drag || !currentReference) return;
    appendEvent({
      id: crypto.randomUUID(),
      type: "MOVE_POINT",
      createdAt: new Date().toISOString(),
      frameIndex: currentFrame,
      keypoint: drag.keypoint,
      before: drag.before,
      after: drag.current,
      source: "manual",
    });
    setDrag(null);
  };

  const undo = () => {
    const last = activeEvents.at(-1);
    if (!last) return;
    appendEvent({
      id: crypto.randomUUID(),
      type: "REVERT_EVENT",
      targetEventId: last.id,
      createdAt: new Date().toISOString(),
      source: "manual",
    });
  };

  const markMissing = () => {
    if (!selectedPoint) return;
    appendEvent({
      id: crypto.randomUUID(),
      type: "MARK_MISSING",
      createdAt: new Date().toISOString(),
      frameIndex: currentFrame,
      keypoint: selectedPoint.keypoint,
      before: selectedPoint.xPx != null && selectedPoint.yPx != null ? { x: selectedPoint.xPx, y: selectedPoint.yPx } : null,
      after: null,
      source: "manual",
    });
  };

  const confirmPoint = () => {
    if (!selectedPoint || !drawablePose(selectedPoint) || selectedPoint.source === "predicted") return;
    appendEvent({
      id: crypto.randomUUID(),
      type: "CONFIRM_POINT",
      createdAt: new Date().toISOString(),
      frameIndex: currentFrame,
      keypoint: selectedPoint.keypoint,
      before: { x: selectedPoint.xPx, y: selectedPoint.yPx },
      source: "manual",
    });
  };

  const nextIssue = () => {
    const issues = referenceSamples.filter((sample) => sample.status !== "valid" || sample.source === "recovered");
    const next = issues.find((sample) => sample.timestampSec > currentTime + 0.05) ?? issues[0];
    if (next) {
      setTime(next.timestampSec);
      setPlaying(false);
    }
  };

  const attachVideoFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size !== experiment.video.sizeBytes) {
      setCsvError(
        `O arquivo selecionado tem ${file.size} bytes, mas o vídeo do experimento tem ${experiment.video.sizeBytes} bytes.`,
      );
      event.target.value = "";
      return;
    }
    if (asset?.objectUrl) URL.revokeObjectURL(asset.objectUrl);
    setAsset(experiment.id, {
      ...asset,
      objectUrl: URL.createObjectURL(file),
      file,
    });
    setCsvError(null);
    event.target.value = "";
    if (analysisRequestedRef.current) {
      analysisRequestedRef.current = false;
      void runColabAnalysis(file);
    }
  };

  const runColabAnalysis = async (selectedFile?: File) => {
    if (!isTauriRuntime()) {
      setCsvError("A análise Colab só pode ser iniciada no aplicativo desktop Tauri.");
      return;
    }
    const videoFile = selectedFile ?? asset?.file;
    let preparation = selectedFile ? undefined : experiment.video.preparation;
    if (!videoFile && !preparation) {
      setCsvError("Selecione novamente o vídeo original para iniciar o processamento.");
      analysisRequestedRef.current = true;
      videoFileRef.current?.click();
      return;
    }
    setAnalysisStarting(true);
    setAnalysisJob(null);
    setSelectedJobId(null);
    setLocalStartedAt(Date.now());
    setJobClock(Date.now());
    setAnalysisMessage("Verificando a conexão com o Colab");
    setCsvError(null);
    try {
      if (preparation && !await checkVideoStaging(experiment.id, preparation.uploadId)) preparation = undefined;
      if (!preparation && !videoFile) {
        setCsvError("O vídeo não está mais no cache. Selecione novamente o original; o experimento e suas correções foram preservados.");
        analysisRequestedRef.current = true;
        videoFileRef.current?.click();
        return;
      }
      const connection = await loadColabSummary();
      if (!connection.connected) {
        throw new Error("A Conta Google não está conectada. Abra Google Colab na barra lateral.");
      }
      if (connection.providerError) throw new Error(connection.providerError);
      if (connection.eligibleGpuCount < 1) {
        throw new Error("Sua conta não possui um runtime GPU elegível neste momento.");
      }
      updateExperiment(experiment.id, { status: "processing" });
      if (!preparation) {
        preparation = await prepareVideo(experiment.id, videoFile!, experiment.video, (_progress, message) => setAnalysisMessage(message));
        updateExperiment(experiment.id, { video: { ...experiment.video, preparation } });
      }
      setAnalysisMessage(preparation.message);
      const started = await startColabJob(experiment.id, preparation.uploadId, {
        width: experiment.video.width,
        height: experiment.video.height,
        durationSec: experiment.video.durationSec,
      }, experiment.arena);
      setAnalysisJob(started);
      setAnalysisHistory((jobs) => [started, ...jobs.filter((job) => job.jobId !== started.jobId)]);
      const completed = await waitForColabJob(started.jobId, (job) => {
        setAnalysisJob(job);
        setAnalysisMessage(job.message);
        setAnalysisHistory((jobs) => [job, ...jobs.filter((item) => item.jobId !== job.jobId)]);
      });
      if (completed.status === "failed") {
        if (!completed.resultsReady) throw new Error(completed.error || "O job Colab falhou sem detalhes.");
        setCsvError(`Poses preservadas para revisão. A execução parou após a inferência: ${completed.error || completed.message}`);
      }
      const samples = parseCanonicalPoseCsv(await loadColabResult(completed.jobId));
      setTrackingData(experiment.id, samples);
      updateExperiment(experiment.id, {
        status: "review",
        analysisMethodVersion: "oft-0.2",
        video: { ...experiment.video, preparation },
        referencePoint: samples.some((sample) => sample.keypoint === "body_center")
          ? "body_center"
          : samples[0].keypoint,
      });
      setCurrentTime(samples[0].timestampSec);
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Não foi possível executar a análise no Colab.";
      setCsvError(message);
      updateExperiment(experiment.id, { status: "failed" });
    } finally {
      setAnalysisStarting(false);
    }
  };

  const severityCount = referenceSamples.filter((sample) => sample.status !== "valid" || sample.source === "recovered").length;
  const currentStatus = currentReference?.status ?? "missing";
  const qualityInfo = currentReference?.source === "recovered" ? { label: "Recuperado · revisar", tone: "warning" as const } : statusInfo[currentStatus];
  const fps = detectedFps;
  const currentJob = analysisJob
    ? analysisHistory.find((job) => job.jobId === analysisJob.jobId) ?? analysisJob
    : localStartedAt !== null ? null : analysisHistory[0] ?? null;
  const visibleJob = selectedJobId
    ? analysisHistory.find((job) => job.jobId === selectedJobId) ?? currentJob
    : currentJob;
  const analysisBusy = analysisStarting || currentJob?.status === "running" || currentJob?.status === "queued";
  const editorLocked = viewMode === "raw" || videoView === "deeplabcut";
  const elapsedSec = visibleJob ? jobElapsedSeconds(visibleJob, jobClock)
    : localStartedAt ? Math.max(0, (jobClock - localStartedAt) / 1000) : 0;

  return (
    <div className="tracking-page">
      <input ref={videoFileRef} type="file" accept="video/*" className="sr-only" onChange={attachVideoFile} />
      <header className="editor-header">
        <button className="back-link" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16} /> Experimentos</button>
        <div className="editor-title"><div><h1>{experiment.title}</h1><p>{experiment.subjectId}{experiment.group ? ` · ${experiment.group}` : ""} · Campo aberto</p></div><Badge tone={rawSamples.length ? "warning" : "neutral"} dot>{rawSamples.length ? "Em revisão" : "Sem tracking"}</Badge></div>
        <div className="editor-header-actions">
          <Button variant="secondary" onClick={() => { setPlaying(false); setDiagnosticOpen(false); setTrainingOpen((value)=>!value); }}>{trainingOpen?"Voltar ao editor":"Ensinar o modelo"}</Button>
          <Button variant="secondary" icon={<ScanSearch size={16} />} onClick={() => setDiagnosticOpen((value) => !value)}>Testar rastreamento</Button>
          <Button className="analyze-button header-analyze" disabled={analysisBusy || diagnosticBusy || trainingBusy} icon={<CloudCog size={16} />} onClick={() => void runColabAnalysis()}>{rawSamples.length ? "Reprocessar no Colab" : "Analisar no Colab"}</Button>
          <Button disabled={!rawSamples.length} icon={<BarChart3 size={16} />} onClick={() => navigate({ name: "results", experimentId })}>Ver resultados</Button>
        </div>
      </header>
      <TrainingPanel key={`training-${experiment.id}`} experiment={experiment} file={asset?.file} videoUrl={asset?.objectUrl} currentTime={currentTime} fps={detectedFps} open={trainingOpen} onSeek={(time)=>setCurrentTime(Math.max(0,Math.min(experiment.video.durationSec,time)))}
        onAttach={()=>{analysisRequestedRef.current=false;videoFileRef.current?.click();}} onBusy={setTrainingBusy} onRestaged={(uploadId)=>{if(asset?.file)updateExperiment(experiment.id,{video:{...experiment.video,preparation:{uploadId,originalBytes:asset.file.size,uploadBytes:asset.file.size,status:"original",policyVersion:"lossless-upload-1",message:"Vídeo original no cache local",pixelVerified:false,frameCount:null}}});}} />
      <DiagnosticPanel key={experiment.id} experiment={experiment} file={asset?.file} open={diagnosticOpen} disabled={analysisBusy||trainingBusy} onAttach={() => { analysisRequestedRef.current = false; videoFileRef.current?.click(); }} onBusy={setDiagnosticBusy}
        onVideoRestaged={(uploadId) => { if (asset?.file) updateExperiment(experiment.id, { video: { ...experiment.video, preparation: {
          uploadId, originalBytes: asset.file.size, uploadBytes: asset.file.size, status: "original", policyVersion: "lossless-upload-1",
          message: "Vídeo original restaurado no cache local. Compactação será verificada na análise completa.", pixelVerified: false, frameCount: null,
        } } }); }} />

      {csvError && csvError !== visibleJob?.error && <div className="editor-error"><AlertCircle size={16} /> {csvError}</div>}
      {latestResultJob?.customModel&&<div className="editor-error"><AlertCircle size={16}/>Modelo personalizado experimental: confiança anatômica não calibrada. Os pontos exigem revisão humana e não entram automaticamente nas métricas.</div>}
      {inputSamples[0]?.recoveryState === "unavailable" && <div className="editor-error"><AlertCircle size={16} /> A segunda passagem visual não estava disponível neste runtime. As detecções originais foram preservadas; consulte o diário da execução antes de considerar a recuperação concluída.</div>}
      {inputSamples[0]?.recoveryState === "limited" && <div className="editor-error"><AlertCircle size={16} /> A recuperação atingiu seu limite de tentativas ou tempo. Lacunas restantes foram preservadas para revisão, sem inventar posições.</div>}
      {!trainingOpen && rawSamples.length > 0 && analysisBusy && <AnalysisWorkflow job={visibleJob} preparing={analysisStarting && !currentJob}
        message={analysisMessage} localError={null} elapsedSec={elapsedSec} />}

      {!trainingOpen && (!rawSamples.length ? (
        <section className="tracking-empty tracking-processing panel">
          <div className="tracking-empty-visual"><ScanSearch size={40} /><span /></div>
          <h2>Processar o vídeo no Google Colab</h2>
          <p>Acompanhe o envio, a GPU alocada e o rastreamento do animal. Cada checkpoint avança após uma confirmação real da execução.</p>
          <AnalysisWorkflow job={visibleJob} preparing={analysisStarting && !currentJob}
            message={analysisMessage} localError={!visibleJob ? csvError : null} elapsedSec={elapsedSec} />
          {!analysisBusy && (
            <div className="tracking-empty-actions">
              <Button className="analyze-button" size="lg" disabled={diagnosticBusy||trainingBusy} icon={<CloudCog size={19} />} onClick={() => void runColabAnalysis()}>
                Analisar no Colab
              </Button>
            </div>
          )}
          <small>
            {asset?.file
              ? `${asset.file.name} pronto para envio · perfil ${COLAB_PROFILE_ID}`
              : "Ao reabrir o projeto, selecione novamente o vídeo original antes de analisar."}
          </small>
          <small>O SuperAnimal TopViewMouse foi desenvolvido para camundongos; resultados em ratos exigem validação manual.</small>
          {analysisHistory.length > 0 && (
            <section className="analysis-history" aria-label="Execuções do Colab">
              <div className="analysis-history-heading"><span>Execuções no Colab</span><small>{analysisHistory.length} registro{analysisHistory.length === 1 ? "" : "s"}</small></div>
              <div className="analysis-history-list">
                {analysisHistory.slice(0, 4).map((job) => (
                  <button type="button" className={`analysis-run analysis-run-${job.status}`} key={job.jobId}
                    aria-pressed={visibleJob?.jobId === job.jobId} onClick={() => setSelectedJobId(job.jobId)}>
                    <div className="analysis-run-status">{job.status === "succeeded" ? <CheckCircle2 size={16} /> : job.status === "failed" ? <AlertCircle size={16} /> : <CloudCog size={16} />}</div>
                    <div><strong>{jobStatusLabel(job)}</strong><span>{job.error || job.message}</span></div>
                    <time><Clock3 size={13} /> {formatDuration(jobElapsedSeconds(job, jobClock))}</time>
                  </button>
                ))}
              </div>
            </section>
          )}
        </section>
      ) : (
        <div className="editor-workspace">
          <section className="video-column">
            <div className="video-toolbar">
              <div className="segmented-control video-source-tabs" aria-label="Fonte do vídeo">
                <button className={videoView === "editor" ? "active" : ""} onClick={() => { setPlaying(false); setVideoView("editor"); }}>Editor</button>
                <button className={videoView === "deeplabcut" ? "active" : ""} onClick={() => { setPlaying(false); setVideoView("deeplabcut"); }}>{latestResultJob?.customModel?"Vídeo do modelo":"Vídeo do DeepLabCut"}</button>
              </div>
              {videoView === "editor" && <>
              <div className="segmented-control">
                <button className={viewMode === "reviewed" ? "active" : ""} onClick={() => setViewMode("reviewed")}>Revisado</button>
                <button className={viewMode === "raw" ? "active" : ""} onClick={() => setViewMode("raw")}>Bruto</button>
              </div>
              <div className="toolbar-spacer" />
              <button className={cn("tool-toggle", showTrajectory && "active")} onClick={() => setShowTrajectory((current) => !current)}>{showTrajectory ? <Eye size={16} /> : <EyeOff size={16} />} Trajetória</button>
              <Button variant="secondary" size="sm" icon={<SkipForward size={15} />} onClick={nextIssue}>Próximo problema</Button>
              </>}
            </div>

            {videoView === "deeplabcut" ? <section className="dlc-video-panel" aria-label="Vídeo rotulado pelo DeepLabCut">
              <div className="dlc-video-description"><strong>{latestResultJob?.customModel?"Saída do modelo personalizado experimental":"Saída bruta do DeepLabCut"} · sem correções do editor</strong><p>{latestResultJob?.customModel?"Pontos experimentais com confiança anatômica não calibrada; não são prova de posição nem visibilidade.":"Todos os pontos do modelo com score ≥ 0,10. Não inclui a recuperação visual nem suas intervenções manuais."} A compressão desta prévia é apenas para reprodução e não altera as poses.</p></div>
              {dlcVideoLoading ? <p role="status">Carregando vídeo salvo no dispositivo…</p> : dlcVideo?.videoUrl ? <>
                <video key={dlcVideo.jobId} src={dlcVideo.videoUrl} controls playsInline preload="metadata" onError={() => setDlcPlaybackError(true)} />
                {dlcPlaybackError && <p role="alert">O player não conseguiu reproduzir este MP4. O arquivo continua salvo no dispositivo.</p>}
              </> : <div className="dlc-video-unavailable"><p>{dlcVideo?.videoError ?? "Este experimento ainda não possui vídeo do DeepLabCut. Faça uma análise no Colab para gerá-lo."}</p><Button className="analyze-button" disabled={analysisBusy} onClick={() => void runColabAnalysis()}>Gerar vídeo no Colab</Button></div>}
            </section> : <>
            <div className="video-stage">
              {asset?.objectUrl && (
                <video
                  ref={videoRef}
                  src={asset.objectUrl}
                  muted
                  playsInline
                  onLoadedMetadata={(event) => { event.currentTarget.currentTime = currentTime; }}
                  onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                />
              )}
              <svg
                ref={svgRef}
                className="tracking-overlay"
                viewBox={`0 0 ${experiment.video.width} ${experiment.video.height}`}
                preserveAspectRatio="xMidYMid meet"
                onPointerDown={(event) => {
                  if (!placingPoint || viewMode === "raw") return;
                  appendEvent({ id: crypto.randomUUID(), type: "MOVE_POINT", createdAt: new Date().toISOString(),
                    frameIndex: currentFrame, keypoint: selectedKeypoint, before: drawablePose(selectedPoint) ? { x: selectedPoint.xPx, y: selectedPoint.yPx } : null, after: pointFromPointer(event), source: "manual" });
                  setPlacingPoint(false);
                }}
                onPointerMove={(event) => drag && setDrag({ ...drag, current: pointFromPointer(event) })}
                onPointerUp={finishDrag}
                onPointerCancel={() => setDrag(null)}
              >
                {!asset?.objectUrl && (
                  <>
                    <defs>
                      <linearGradient id="stage-floor" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#cfd2ca" /><stop offset="1" stopColor="#aeb6ad" /></linearGradient>
                    </defs>
                    <rect width={experiment.video.width} height={experiment.video.height} fill="#202624" />
                    <polygon points={pointsToSvg(experiment.arena.cornersPx)} fill="url(#stage-floor)" stroke="#59645f" strokeWidth="10" />
                  </>
                )}
                <polygon points={pointsToSvg(experiment.arena.cornersPx)} fill="none" stroke="#d7f169" strokeOpacity=".75" strokeWidth="3" />
                {experiment.arena.rimCornersPx && <polygon points={pointsToSvg(experiment.arena.rimCornersPx)} fill="none" stroke="#bb9aff" strokeOpacity=".65" strokeWidth="3" strokeDasharray="12 8" />}
                <polygon points={pointsToSvg(centerPolygon)} fill="#70d6ad" fillOpacity=".07" stroke="#70d6ad" strokeOpacity=".55" strokeWidth="2" strokeDasharray="10 8" />
                {showTrajectory && trajectory.map((segment, index) => <polyline key={index} points={pointsToSvg(segment)} fill="none" stroke="#d7f169" strokeWidth="4" strokeOpacity=".75" strokeLinecap="round" strokeLinejoin="round" />)}
                {[["nose", "body_center"], ["body_center", "tail_base"], ["left_ear", "nose"], ["right_ear", "nose"]].map(([a, b]) => {
                  const first = currentPoints.find((sample) => sample.keypoint === a);
                  const second = currentPoints.find((sample) => sample.keypoint === b);
                  if (!drawablePose(first) || !drawablePose(second)) return null;
                  return <line key={`${a}-${b}`} x1={first.xPx} y1={first.yPx} x2={second.xPx} y2={second.yPx} stroke="#ecfdf5" strokeOpacity=".8" strokeWidth="4" />;
                })}
                {currentPoints.map((sample) => {
                  if (!drawablePose(sample)) return null;
                  const point = drag?.keypoint === sample.keypoint ? drag.current : { x: sample.xPx, y: sample.yPx };
                  const rawPoint = rawCurrentPoints.find((raw) => raw.keypoint === sample.keypoint);
                  const corrected = rawPoint && (rawPoint.xPx !== sample.xPx || rawPoint.yPx !== sample.yPx);
                  const selected = sample.keypoint === selectedKeypoint;
                  return (
                    <g
                      key={sample.keypoint}
                      className="tracking-point"
                      transform={`translate(${point.x} ${point.y})`}
                      onPointerDown={(event) => {
                        if (viewMode === "raw") return;
                        event.stopPropagation();
                        setPlaying(false);
                        event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                        setSelectedKeypoint(sample.keypoint);
                        setDrag({ keypoint: sample.keypoint, before: { x: sample.xPx!, y: sample.yPx! }, current: point });
                      }}
                    >
                      {corrected && <circle r="19" fill="none" stroke="#f7c96b" strokeWidth="3" strokeDasharray="4 4" />}
                      <circle r={selected ? 12 : 9} fill={sample.source === "recovered" ? "#bb9aff" : sample.status === "valid" ? "#d7f169" : "#f7c96b"} stroke="#153c32" strokeWidth="3" />
                      {selected && <text y="-19" textAnchor="middle" fontSize="14" fontWeight="700" fill="#fff">{keypointLabels[sample.keypoint] ?? sample.keypoint}</text>}
                    </g>
                  );
                })}
              </svg>
              <div className="stage-badges"><Badge tone="neutral">Frame {currentFrame}</Badge><Badge tone={qualityInfo.tone}>{qualityInfo.label}</Badge>{currentReference?.source && currentReference.source !== "detected" && currentReference.source !== "recovered" && <Badge tone="warning">{poseSourceLabel(currentReference)}</Badge>}</div>
              {placingPoint && viewMode !== "raw" && <div className="raw-lock">Clique na posição de {keypointLabels[selectedKeypoint] ?? selectedKeypoint} · não estime partes invisíveis</div>}
              {viewMode === "raw" && <div className="raw-lock"><RotateCcw size={15} /> Visualização bruta · edição bloqueada</div>}
            </div>

            <div className="playback-bar">
              <button className="transport-button" onClick={() => setTime(currentTime - 1 / fps)} title="Frame anterior"><ChevronLeft size={19} /></button>
              <button className="play-button" onClick={() => setPlaying((current) => !current)}>{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>
              <button className="transport-button" onClick={() => setTime(currentTime + 1 / fps)} title="Próximo frame"><ChevronRight size={19} /></button>
              <div className="timecode"><strong>{formatDuration(currentTime)}</strong><span>/ {formatDuration(duration)}</span></div>
              <div className="playback-spacer" />
              <label className="speed-control"><Gauge size={15} /><select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value={0.25}>0,25×</option><option value={0.5}>0,5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label>
            </div>

            <div className="timeline-panel">
              <div className="timeline-header"><div><strong>Timeline de qualidade</strong><span>{severityCount} amostras sinalizadas</span></div><div className="timeline-legend"><span className="ok">Confiável</span><span className="warn">Suspeito</span><span className="bad">Erro provável</span></div></div>
              <div
                className="timeline-track"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTime(((event.clientX - rect.left) / rect.width) * duration);
                }}
              >
                {bins.map((status, index) => <i key={index} className={`timeline-${status}`} />)}
                <b style={{ left: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
              </div>
              <div className="timeline-times"><span>0:00</span><span>{formatDuration(duration * 0.25)}</span><span>{formatDuration(duration * 0.5)}</span><span>{formatDuration(duration * 0.75)}</span><span>{formatDuration(duration)}</span></div>
            </div>
            </>}
          </section>

          <aside className="inspector-panel" data-mode={videoView}>
            {videoView === "deeplabcut" && <section className="inspector-section dlc-inspector-note">
              <div className="inspector-label">Inspeção da saída do Colab</div>
              <p>Este player mostra os pontos do H5 bruto desenhados pelo DeepLabCut. Use os controles do vídeo para reproduzir, pausar e ampliar.</p>
              <p>As métricas e correções pertencem ao editor. Nenhuma correção manual é aplicada a este MP4.</p>
              <Button variant="secondary" size="sm" onClick={() => setVideoView("editor")}>Voltar para edição</Button>
            </section>}
            <div className="inspector-tabs"><button className="active"><MousePointer2 size={15} /> Correção</button><button><History size={15} /> Histórico</button></div>
            <section className="inspector-section">
              <div className="inspector-label">Ponto selecionado</div>
              <div className="keypoint-list">
                {keypoints.map((keypoint) => {
                  const point = currentPoints.find((sample) => sample.keypoint === keypoint);
                  return <button key={keypoint} title={poseSourceLabel(point)} className={keypoint === selectedKeypoint ? "active" : ""} onClick={() => setSelectedKeypoint(keypoint)}><CircleDot size={16} /><span>{keypointLabels[keypoint] ?? keypoint}{point?.source === "recovered" ? " · recuperado/revisar" : ""}</span><small>{latestResultJob?.customModel&&point?.source!=="manual"&&drawablePose(point)?"Não calibrada":confidenceLabel(point)}</small></button>;
                })}
              </div>
            </section>
            <section className="inspector-section correction-actions">
              <div className="inspector-label">Ações no frame {currentFrame}</div>
              <Button variant="secondary" icon={<MousePointer2 size={16} />} disabled={editorLocked}>Arraste o ponto no vídeo</Button>
              <Button variant="secondary" icon={<Flag size={16} />} onClick={markMissing} disabled={!selectedPoint || editorLocked}>Marcar como ausente</Button>
              <Button variant="secondary" onClick={() => { setPlaying(false); setPlacingPoint((current) => !current); }} disabled={editorLocked}>{placingPoint ? "Cancelar posicionamento" : "Posicionar ponto ausente"}</Button>
              <Button variant="secondary" onClick={confirmPoint} disabled={editorLocked || !drawablePose(selectedPoint) || selectedPoint?.source === "predicted"}>Confirmar ponto após revisar</Button>
              <div className="undo-row"><Button variant="ghost" size="sm" icon={<Undo2 size={15} />} onClick={undo} disabled={!activeEvents.length || editorLocked}>Desfazer</Button><Button variant="ghost" size="sm" icon={<Redo2 size={15} />} disabled>Refazer</Button></div>
            </section>
            <BehaviorReview experiment={experiment} samples={correctedSamples} currentTime={currentTime} duration={duration}
              disabled={editorLocked} onSeek={(time) => { setVideoView("editor"); setPlaying(false); setTime(time); }}
              onChange={(patch) => updateExperiment(experiment.id, patch)} />
            <section className="inspector-section frame-quality">
              <div className="inspector-label">Qualidade: {keypointLabels[referenceKeypoint] ?? referenceKeypoint}</div>
              <div className={`quality-card quality-${currentReference?.source === "recovered" ? "low_confidence" : currentStatus}`}>
                {qualityInfo.tone === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                <div><strong>{qualityInfo.label}</strong><span>{latestResultJob?.customModel&&currentReference?.source!=="manual"?"Confiança anatômica não calibrada":`Score do modelo: ${confidenceLabel(currentReference)}`}</span></div>
              </div>
              <p>Flags indicam trechos para revisão; não provam que a estimativa esteja errada.</p>
              <p>{poseSourceLabel(selectedPoint)}. Score não é probabilidade calibrada de acerto. Pontos recuperados e de baixa confiança só entram nas métricas depois de confirmados.</p>
              {currentReference?.supportCount != null && currentReference.supportTotal != null && currentReference.supportTotal > 0 && currentReference.supportCount < currentReference.supportTotal && <p>Centro com suporte parcial: {currentReference.supportCount}/{currentReference.supportTotal} pontos do tronco. A posição pode variar com as partes visíveis; revise antes de usar métricas.</p>}
            </section>
            <section className="inspector-section detection-context">
              <div className="inspector-label">Visibilidade e contexto 2D</div>
              <strong>{visiblePointCount}/{currentPoints.length} pontos disponíveis</strong>
              {visiblePointCount > 0 && visiblePointCount < currentPoints.length && <p>Detecção parcial: os pontos disponíveis foram mantidos. Partes não detectadas não foram preenchidas.</p>}
              <p>Ponto selecionado: {selectedPoint?.spatialRegion === "floor" ? "projeção do chão" : selectedPoint?.spatialRegion === "wall_projection" ? "projeção da parede/borda" : selectedPoint?.spatialRegion === "outside" ? "fora da projeção da caixa" : "contexto não disponível"}.</p>
              <p>Borda e chão ajudam a delimitar a imagem, mas não medem altura. Confirme os comportamentos no vídeo.</p>
            </section>
            <section className="inspector-audit">
              <div><History size={16} /><span>{activeEvents.length} intervenções ativas</span></div>
              <small>Dados brutos preservados</small>
            </section>
            {analysisHistory.length > 0 && (
              <section className="inspector-section editor-run-summary">
                <div className="inspector-label">Última execução Colab</div>
                {analysisHistory.slice(0, 2).map((job) => (
                  <div className={`editor-run-item editor-run-${job.status}`} key={job.jobId}>
                    <strong>{jobStatusLabel(job)}</strong>
                    <span>{job.error || job.message}</span>
                    <small>{formatDuration(jobElapsedSeconds(job, jobClock))} · {job.progress}%</small>
                  </div>
                ))}
              </section>
            )}
          </aside>
        </div>
      ))}
    </div>
  );
}

