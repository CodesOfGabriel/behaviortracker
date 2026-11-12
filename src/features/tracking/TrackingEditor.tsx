import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CloudCog,
  Plus,
  Clock3,
  Eye,
  EyeOff,
  Flag,
  Gauge,
  History,
  MousePointer2,
  Pause,
  Play,
  RotateCcw,
  ScanSearch,
  SkipForward,
  Undo2,
} from "lucide-react";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EditorTabs } from "../../components/ui/EditorTabs";
import { SelectMenu } from "../../components/ui/SelectMenu";
import { activeCorrectionEvents, applyCorrections } from "../../lib/corrections";
import { hasUnassignedCorrections, reviewEvents, selectTrackingReview, trackingSourceKey } from "../../lib/tracking-reviews";
import { parseCanonicalPoseCsv } from "../../lib/csv";
import { confidenceLabel, drawablePose, inferredFps, metricEligible, originalPose, poseSourceLabel, qualityTimelineBins, referencePoseSamples, trajectorySegments } from "../../lib/pose";
import { makeDemoPose } from "../../lib/demo-data";
import { centerPolygonPx, pointsToSvg } from "../../lib/geometry";
import { calculateOftMetrics } from "../../lib/metrics";
import { cn, formatDuration } from "../../lib/format";
import { useAppStore } from "../../store/AppStore";
import type { BoundingBox, CorrectionEvent, Point, PoseSample, PoseStatus, TrackingSelection } from "../../types";
import {
  loadColabResult,
  loadColabJobs,
  checkVideoStaging,
  getHybridBundleStatus,
  prepareVideo,
  startColabJob,
  waitForColabJob,
  type ColabJob,
} from "../colab/analysis";
import { AnalysisWorkflow } from "../colab/AnalysisWorkflow";
import { displayAnalysisMessage, preparingNewAnalysis } from "../colab/workflow";
import { loadLocalResult } from "../local/api";
import { BoxOverlay } from "./BoxOverlay";
import {
  COLAB_PROFILE_ID,
  COLAB_STATUS_EVENT,
  emptyColabSummary,
  isTauriRuntime,
  loadColabSummary,
  type OAuthProfileSummary,
} from "../colab/connection";

const statusInfo: Record<PoseStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  valid: { label: "Confiável", tone: "success" },
  low_confidence: { label: "Baixa confiança", tone: "warning" },
  jump: { label: "Salto espacial", tone: "danger" },
  missing: { label: "Não detectado", tone: "danger" },
  out_of_arena: { label: "Fora da arena", tone: "danger" },
};

const keypointLabels: Record<string, string> = {
  box_center: "Centro da caixa · referência 2D",
  silhouette_center: "Centroide da silhueta",
  body_center: "Centro corporal",
  mouse_center: "Centro corporal (HRNet)",
  nose: "Focinho",
  tail_base: "Base da cauda",
  left_ear: "Orelha esquerda",
  right_ear: "Orelha direita",
  left_forepaw: "Pata anterior esquerda",
  right_forepaw: "Pata anterior direita",
  neck: "Nuca", mid_back: "Meio do dorso", hip: "Quadril",
};

type WorkspaceTab = "review" | "runs";
type PointDrag = { keypoint: string; frameIndex: number; timestampSec: number; before: Point | null; current: Point; offset: Point; pointerId: number };

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
    analysisActivity,
    setAnalysisActivity,
  } = useAppStore();
  const experiment = getExperiment(experimentId);
  const asset = assets[experimentId];
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoFileRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const sourceRequestRef = useRef(0);
  useEffect(()=>()=>{++sourceRequestRef.current;},[experimentId]);
  const analysisRequestedRef = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedKeypoint, setSelectedKeypoint] = useState("body_center");
  const [viewMode, setViewMode] = useState<"raw" | "reviewed">("reviewed");
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [analysisJob, setAnalysisJob] = useState<ColabJob | null>(null);
  const analysisStarting = analysisActivity[experimentId]?.starting ?? false;
  const analysisMessage = analysisActivity[experimentId]?.message ?? "";
  const analysisError = analysisActivity[experimentId]?.error ?? null;
  const [colabSummary, setColabSummary] = useState<OAuthProfileSummary>(emptyColabSummary);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("review");
  const [inspectorTab, setInspectorTab] = useState<"points" | "history">("points");
  const [sourceLoading,setSourceLoading]=useState(false);
  const [drawingBox,setDrawingBox]=useState(false);
  const [analysisHistory, setAnalysisHistory] = useState<ColabJob[]>([]);
  const [jobClock, setJobClock] = useState(() => Date.now());
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [drag, setDrag] = useState<PointDrag | null>(null);
  const dragRef = useRef<PointDrag | null>(null);
  const [correctionMessage, setCorrectionMessage] = useState("");
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    let revision = 0;
    const onStatus = (event: Event) => { revision += 1; setColabSummary((event as CustomEvent<OAuthProfileSummary>).detail); };
    window.addEventListener(COLAB_STATUS_EVENT, onStatus);
    const requestRevision = ++revision;
    void loadColabSummary().then((summary) => { if (active && revision === requestRevision) setColabSummary(summary); }).catch(() => {
      if (active && revision === requestRevision) setColabSummary(emptyColabSummary);
    });
    return () => { active = false; window.removeEventListener(COLAB_STATUS_EVENT, onStatus); };
  }, []);
  const latestResultJob = experiment?.trackingSelection?.engine === "opencv" ? undefined
    : experiment?.trackingSelection?.engine === "colab" ? analysisHistory.find(job => job.jobId === experiment.trackingSelection?.jobId)
    : analysisHistory.find((job) => job.resultsReady || job.status === "succeeded");
  const latestSuccessfulJobId = latestResultJob?.jobId;
  const applySource = useCallback((selection:TrackingSelection,samples:PoseSample[]) => {
    if (!samples.length) throw new Error("A execução não contém frames para revisão.");
    videoRef.current?.pause(); setPlaying(false); dragRef.current=null;setDrag(null);setPlacingPoint(false);setDrawingBox(false);
    setTrackingData(experimentId,samples);
    updateExperiment(experimentId,current=>selectTrackingReview(current,selection,samples));
    setCurrentTime(samples[0].timestampSec);setSelectedKeypoint(samples.some(s=>s.keypoint==="box_center")?"box_center":samples.some(s=>s.keypoint==="mouse_center")?"mouse_center":samples.some(s=>s.keypoint==="body_center")?"body_center":samples[0].keypoint);
    setViewMode("reviewed");setCsvError(null);setCorrectionMessage("Fonte carregada. Cada execução mantém suas próprias correções.");
  },[experimentId,setTrackingData,updateExperiment]);

  useEffect(() => {
    if (!experiment || trackingData[experimentId]) return;
    if (experiment.video.timingSource === "synthetic") {
      setTrackingData(experimentId, makeDemoPose(experiment));
    }
  }, [experiment, experimentId, setTrackingData, trackingData]);

  useEffect(() => {
    if (!experiment || trackingData[experimentId] || !isTauriRuntime()) return;
    const selection = experiment.trackingSelection ?? (latestSuccessfulJobId ? {engine:"colab" as const,jobId:latestSuccessfulJobId} : undefined);
    if (!selection) return;
    let cancelled=false;
    const token=++sourceRequestRef.current;setSourceLoading(true);
    const promise=selection.engine==="opencv"?loadLocalResult(selection.jobId):loadColabResult(selection.jobId).then(parseCanonicalPoseCsv);
    void promise.then(samples=>{if(!cancelled&&token===sourceRequestRef.current)applySource(selection,samples);})
      .catch(error=>{if(!cancelled&&token===sourceRequestRef.current)setCsvError(`A fonte salva não pôde ser carregada. Correções preservadas. ${String(error)}`);})
      .finally(()=>{if(!cancelled&&token===sourceRequestRef.current)setSourceLoading(false);});
    return()=>{cancelled=true;};
  }, [experimentId,experiment?.trackingSelection?.engine,experiment?.trackingSelection?.jobId,latestSuccessfulJobId,!!trackingData[experimentId],applySource]);

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
  const sourceEvents = useMemo(() => experiment ? reviewEvents(experiment) : [],[experiment]);
  const correctedSamples = useMemo(
    () => applyCorrections(inputSamples, sourceEvents),
    [sourceEvents, inputSamples],
  );
  const displayedSamples = viewMode === "raw" ? rawSamples : correctedSamples;
  const macroMode = experiment?.referencePoint === "box_center";
  const keypoints = useMemo(() => macroMode ? ["box_center"] : experiment?.trackingSelection?.engine==="opencv" ? [experiment.referencePoint]
    : Array.from(new Set([experiment?.referencePoint??"body_center",...rawSamples.map((sample) => sample.keypoint),"nose","tail_base","left_ear","right_ear"])), [rawSamples, experiment?.referencePoint,experiment?.trackingSelection?.engine,macroMode]);

  useEffect(() => {
    if (keypoints.length && !keypoints.includes(selectedKeypoint)) setSelectedKeypoint(keypoints[0]);
  }, [keypoints, selectedKeypoint]);

  const referenceKeypoint = experiment && keypoints.includes(experiment.referencePoint)
    ? experiment.referencePoint
    : keypoints[0];
  const frameTimeline = useMemo(() => [...new Map(inputSamples.map((sample)=>[sample.frameIndex,sample])).values()].sort((a,b)=>a.timestampSec-b.timestampSec), [inputSamples]);
  const referenceSamples = useMemo(
    () => referencePoseSamples(displayedSamples, referenceKeypoint),
    [displayedSamples, referenceKeypoint],
  );
  const detectedFps = inferredFps(referenceSamples, experiment?.video.fps);
  const duration = experiment?.video.durationSec || referenceSamples.at(-1)?.timestampSec || 0;
  const nearestFrameSample = nearestSample(frameTimeline, currentTime);
  // Não atribuir um clique ao último frame conhecido quando faltam timestamps inteiros.
  const currentFrameSample = nearestFrameSample && Math.abs(nearestFrameSample.timestampSec-currentTime)<=1.1/detectedFps ? nearestFrameSample : undefined;
  const currentFrame = currentFrameSample?.frameIndex ?? Math.max(0,Math.round(currentTime*detectedFps));
  const baseCurrentPoints = useMemo(() => displayedSamples.filter((sample)=>sample.frameIndex===currentFrame),[displayedSamples,currentFrame]);
  const currentPoints = useMemo(() => {
    if(!drag||viewMode==="raw"||drag.frameIndex!==currentFrame)return baseCurrentPoints;
    const existing=baseCurrentPoints.find((sample)=>sample.keypoint===drag.keypoint);
    const preview:PoseSample={...existing,frameIndex:drag.frameIndex,timestampSec:drag.timestampSec,keypoint:drag.keypoint,
      xPx:drag.current.x,yPx:drag.current.y,likelihood:existing?.likelihood??0,status:"valid",source:"manual",spatialRegion:"unknown"};
    return [...baseCurrentPoints.filter((sample)=>sample.keypoint!==drag.keypoint),preview];
  },[baseCurrentPoints,drag,viewMode,currentFrame]);
  const currentReference = currentPoints.find((sample)=>sample.keypoint===referenceKeypoint)??referenceSamples.find((sample)=>sample.frameIndex===currentFrame);
  const rawCurrentPoints = useMemo(() => rawSamples.filter((sample) => sample.frameIndex === currentFrame),[rawSamples,currentFrame]);
  const selectedPoint = currentPoints.find((sample) => sample.keypoint === selectedKeypoint);
  const visiblePointCount = currentPoints.filter(drawablePose).length;
  const bins = useMemo(() => qualityTimelineBins(referenceSamples,duration), [referenceSamples,duration]);
  const reviewedReference = useMemo(() => referencePoseSamples(correctedSamples,referenceKeypoint), [correctedSamples,referenceKeypoint]);
  const reviewedMetrics = useMemo(() => experiment ? calculateOftMetrics(reviewedReference,experiment.arena) : null, [reviewedReference,experiment?.arena]);
  const centerPolygon = useMemo(
    () => experiment ? centerPolygonPx(experiment.arena) : [],
    [experiment],
  );
  const activeEvents = useMemo(
    () => activeCorrectionEvents(sourceEvents),
    [sourceEvents],
  );
  const boxKeyframes = useMemo(() => {
    if (!macroMode) return [];
    const frames = new Set(activeEvents.filter((event) => event.type === "SET_BOX" && event.keypoint === "box_center").map((event) => event.frameIndex));
    return reviewedReference.filter((sample) => (frames.has(sample.frameIndex) || sample.reason === "manual_anchor") && sample.source === "manual" && sample.bbox);
  }, [activeEvents, macroMode, reviewedReference]);
  const keyframePreview = useMemo(() => macroMode && viewMode === "reviewed"
    ? trajectorySegments(reviewedReference.filter((sample) => sample.bbox && (boxKeyframes.some((keyframe) => keyframe.frameIndex === sample.frameIndex) || sample.reason === "manual_keyframe_interpolation"))
      .map((sample) => ({ ...sample, source: "manual" as const, status: "valid" as const }))) : [],
  [macroMode, viewMode, reviewedReference, boxKeyframes]);
  const predictedFrameCount = useMemo(() => reviewedReference.filter((sample) => sample.reason === "manual_keyframe_interpolation").length, [reviewedReference]);

  const trajectory = useMemo(() => {
    const currentIndex = referenceSamples.findIndex((sample) => sample.frameIndex === currentFrame);
    const window=referenceSamples.slice(Math.max(0, currentIndex - 100), currentIndex + 1);
    return trajectorySegments(window.map((sample)=>{
      const current = drag&&viewMode!=="raw"&&drag.keypoint===referenceKeypoint&&sample.frameIndex===drag.frameIndex
        ? {...sample,xPx:drag.current.x,yPx:drag.current.y,status:"valid" as const,source:"manual" as const} : sample;
      return metricEligible(current) ? current : {...current,status:"missing" as const};
    }));
  }, [referenceSamples, currentFrame, drag, viewMode, referenceKeypoint]);

  const setTime = (next: number) => {
    dragRef.current = null; setDrag(null); setPlacingPoint(false);setDrawingBox(false);
    const clamped = Math.max(0, Math.min(duration, next));
    setCurrentTime(clamped);
    if (videoRef.current) videoRef.current.currentTime = clamped;
  };
  const stepFrame = (direction: -1 | 1) => {
    const index = frameTimeline.findIndex((sample) => sample.frameIndex === currentFrame);
    const target = frameTimeline[Math.max(0, Math.min(frameTimeline.length - 1, index + direction))];
    setTime(target?.timestampSec ?? currentTime + direction / detectedFps);
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
  }, [playing, speed, duration, asset?.objectUrl, workspaceTab]);

  // Atualiza a sobreposição quando o frame é apresentado, não só no timeupdate
  // (que pode disparar várias centenas de milissegundos depois).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.requestVideoFrameCallback || workspaceTab !== "review") return;
    let active = true;
    let callbackId = 0;
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (!active) return;
      // Durante uma busca pausada, callbacks atrasados ainda podem se referir
      // ao frame anterior. O seek já posicionou o cursor em setTime().
      if (!video.paused && !video.seeking) {
        setCurrentTime((previous) => Math.abs(previous - metadata.mediaTime) < .0001 ? previous : metadata.mediaTime);
      }
      callbackId = video.requestVideoFrameCallback(onFrame);
    };
    callbackId = video.requestVideoFrameCallback(onFrame);
    return () => { active = false; video.cancelVideoFrameCallback(callbackId); };
  }, [asset?.objectUrl, workspaceTab, rawSamples.length]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (workspaceTab !== "review") return;
      if (event.defaultPrevented || dragRef.current || drawingBox || sourceLoading) return;
      if ((event.target as HTMLElement)?.closest("input, textarea, select, button, [role=tablist]")) return;
      if (event.code === "Space") {
        event.preventDefault();
        setPlaying((current) => !current);
      } else if (event.key === "ArrowRight") stepFrame(1);
      else if (event.key === "ArrowLeft") stepFrame(-1);
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
    const source = trackingSourceKey(experiment.trackingSelection);
    updateExperiment(experiment.id, current=>({ corrections: [...current.corrections,
      {...event, reviewSource: source, runId: experiment.trackingSelection?.jobId,
        algorithmVersion: inputSamples[0]?.processingVersion,
        sourceVideoSha256: experiment.video.sha256}], status: "review" }));
    if(event.type==="REVERT_EVENT")setCorrectionMessage("Correção desfeita. Trajeto e métricas revisados foram recalculados.");
  };

  const switchSource = async (key:string) => {
    const selection = key.startsWith("opencv:") ? {engine:"opencv" as const,jobId:key.slice(7)}
      : key.startsWith("colab:") ? {engine:"colab" as const,jobId:key.slice(6)} : null;
    if(!selection)return;
    const token=++sourceRequestRef.current;setSourceLoading(true);setCsvError(null);
    try {
      const samples=selection.engine==="opencv"?await loadLocalResult(selection.jobId):parseCanonicalPoseCsv(await loadColabResult(selection.jobId));
      if(token===sourceRequestRef.current)applySource(selection,samples);
    }catch(error){if(token===sourceRequestRef.current)setCsvError(`Não foi possível trocar a fonte. O resultado atual e suas correções foram mantidos. ${String(error)}`);}
    finally{if(token===sourceRequestRef.current)setSourceLoading(false);}
  };

  const saveBox = (box:BoundingBox) => {
    if(!currentFrameSample)return;
    appendEvent({id:crypto.randomUUID(),type:"SET_BOX",createdAt:new Date().toISOString(),source:"manual",keypoint:"box_center",
      frameIndex:currentFrame,timestampSec:currentFrameSample.timestampSec,beforeBox:currentReference?.bbox??null,afterBox:box});
    setCorrectionMessage(`Quadro-chave no frame ${currentFrame} salvo. Entre dois quadros-chave, o trajeto é apenas uma previsão para revisão; não entra nas métricas.`);
  };

  const pointFromPointer = (event: ReactPointerEvent<SVGSVGElement | SVGGElement>): Point => {
    const svg = svgRef.current!;
    const matrix = svg.getScreenCTM();
    if (!matrix) throw new Error("O vídeo ainda não está pronto para posicionar pontos.");
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return {
      x: Math.max(0, Math.min(experiment.video.width, point.x)),
      y: Math.max(0, Math.min(experiment.video.height, point.y)),
    };
  };

  const beginDrag = (event: ReactPointerEvent<SVGSVGElement | SVGGElement>, keypoint: string, before: Point | null, relocate = false) => {
    if (viewMode === "raw" || workspaceTab !== "review" || event.button !== 0 || !event.isPrimary || !currentFrameSample) return;
    event.preventDefault(); event.stopPropagation();
    videoRef.current?.pause(); setPlaying(false);
    const pointer = pointFromPointer(event);
    const value: PointDrag = { keypoint, frameIndex:currentFrame, timestampSec:currentFrameSample.timestampSec, before,
      current:relocate?pointer:before??pointer,offset:before&&!relocate?{x:before.x-pointer.x,y:before.y-pointer.y}:{x:0,y:0},pointerId:event.pointerId };
    dragRef.current=value;setDrag(value);setSelectedKeypoint(keypoint);setCorrectionMessage("");
    svgRef.current?.setPointerCapture(event.pointerId);
  };
  const dragPosition = (event: ReactPointerEvent<SVGSVGElement>, value: PointDrag) => {
    const pointer=pointFromPointer(event);
    return {x:Math.max(0,Math.min(experiment.video.width,pointer.x+value.offset.x)),y:Math.max(0,Math.min(experiment.video.height,pointer.y+value.offset.y))};
  };
  const cancelDrag = () => {dragRef.current=null;setDrag(null);setPlacingPoint(false);};
  const finishDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const value=dragRef.current;
    if(!value||value.pointerId!==event.pointerId)return;
    const after=dragPosition(event,value);
    cancelDrag();
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(value.before&&Math.hypot(after.x-value.before.x,after.y-value.before.y)<.01)return;
    appendEvent({
      id: crypto.randomUUID(),
      type: "MOVE_POINT",
      createdAt: new Date().toISOString(),
      frameIndex: value.frameIndex,
      timestampSec: value.timestampSec,
      keypoint: value.keypoint,
      before: value.before,
      after,
      source: "manual",
    });
    setCorrectionMessage(`${keypointLabels[value.keypoint]??value.keypoint} corrigido no frame ${value.frameIndex}. ${value.keypoint===referenceKeypoint?"Trajeto e métricas recalculados.":`O trajeto usa ${keypointLabels[referenceKeypoint]??referenceKeypoint}; corrija esse ponto se necessário.`}`);
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
      timestampSec: selectedPoint.timestampSec,
      keypoint: selectedPoint.keypoint,
      beforeBox: selectedPoint.bbox ?? null,
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
      timestampSec: selectedPoint.timestampSec,
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
    if (analysisStarting) return;
    if (!isTauriRuntime()) {
      setCsvError("A análise Colab só pode ser iniciada no aplicativo desktop Tauri.");
      return;
    }
    if (!colabSummary.connected) {
      setCsvError("Conecte sua conta Google Colab antes de iniciar a análise.");
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
    setAnalysisActivity(experimentId, { starting: true, message: "Verificando a conexão com o Colab", error: null });
    setAnalysisJob(null);
    setSelectedJobId(null);
    setJobClock(Date.now());
    setCsvError(null);
    const sourceAtStart=sourceRequestRef.current;
    try {
      const connection = await loadColabSummary();
      setColabSummary(connection);
      if (!connection.connected) throw new Error("A Conta Google não está conectada. Abra Google Colab na barra lateral.");
      if (connection.providerError) throw new Error(connection.providerError);
      if (connection.eligibleGpuCount < 1) throw new Error("Sua conta não possui um runtime GPU elegível neste momento.");
      const bundleId = experiment.modelBundleId ?? "wistar_df_v1";
      if (bundleId !== "wistar_df_v1" && bundleId !== "wistar_df_v2") {
        throw new Error(`Modelo de análise desconhecido: ${bundleId}`);
      }
      if ((experiment.analysisEngine ?? "wistar_superanimal_hybrid_v1") === "wistar_superanimal_hybrid_v1") {
        const bundle = await getHybridBundleStatus(bundleId);
        if (!bundle.installed) throw new Error(bundle.error || `Bundle ${bundleId} ausente`);
      }
      if (preparation && !await checkVideoStaging(experiment.id, preparation.uploadId)) preparation = undefined;
      if (!preparation && !videoFile) {
        setCsvError("O vídeo não está mais no cache. Selecione novamente o original; o experimento e suas correções foram preservados.");
        analysisRequestedRef.current = true;
        videoFileRef.current?.click();
        return;
      }
      updateExperiment(experiment.id, { status: "processing" });
      if (!preparation) {
        preparation = await prepareVideo(experiment.id, videoFile!, experiment.video, (_progress, message) => setAnalysisActivity(experimentId, { message }));
        updateExperiment(experiment.id, { video: { ...experiment.video, preparation } });
      }
      setAnalysisActivity(experimentId, { message: preparation.message });
      const started = await startColabJob(experiment.id, preparation.uploadId, {
        width: experiment.video.width,
        height: experiment.video.height,
        durationSec: experiment.video.durationSec,
      }, experiment.arena, experiment.analysisEngine ?? "wistar_superanimal_hybrid_v1", bundleId);
      setAnalysisJob(started);
      setAnalysisHistory((jobs) => [started, ...jobs.filter((job) => job.jobId !== started.jobId)]);
      setWorkspaceTab("runs");
      const completed = await waitForColabJob(started.jobId, (job) => {
        setAnalysisJob(job);
        setAnalysisActivity(experimentId, { message: job.message });
        setAnalysisHistory((jobs) => [job, ...jobs.filter((item) => item.jobId !== job.jobId)]);
      });
      if (completed.status === "failed") {
        if (!completed.resultsReady) throw new Error(completed.error || "O job Colab falhou sem detalhes.");
        setCsvError(`Poses preservadas para revisão. A execução parou após a inferência: ${completed.error || completed.message}`);
      }
      const samples = parseCanonicalPoseCsv(await loadColabResult(completed.jobId));
      if(sourceRequestRef.current===sourceAtStart)applySource({engine:"colab",jobId:completed.jobId},samples);
      else setAnalysisActivity(experimentId, { message: "Execução concluída e salva. A fonte que você está revisando não foi alterada; selecione o novo resultado quando quiser." });
      updateExperiment(experiment.id,current=>({video:{...current.video,preparation},status:"review"}));
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Não foi possível executar a análise no Colab.";
      setCsvError(message);
      setAnalysisActivity(experimentId, { error: message, message });
      updateExperiment(experiment.id, { status: "failed" });
    } finally {
      setAnalysisActivity(experimentId, { starting: false });
    }
  };

  const severityCount = referenceSamples.filter((sample) => sample.status !== "valid" || sample.source === "recovered").length;
  const currentStatus = currentReference?.status ?? "missing";
  const qualityInfo = macroMode ? currentReference?.source === "predicted" ? {label:"Previsão · não observada",tone:"warning" as const}
    : currentStatus === "valid" ? {label:"Caixa observada",tone:"success" as const} : currentStatus === "low_confidence" ? {label:"Caixa parcial · revisar",tone:"warning" as const} : statusInfo[currentStatus]
    : currentReference?.source === "recovered" ? { label: "Recuperado · revisar", tone: "warning" as const } : statusInfo[currentStatus];
  const currentJob = analysisJob
    ? analysisHistory.find((job) => job.jobId === analysisJob.jobId) ?? analysisJob
    : analysisHistory[0] ?? null;
  const preparingAnalysis = preparingNewAnalysis(analysisStarting, analysisJob, analysisHistory);
  const visibleJob = preparingAnalysis ? null : selectedJobId
    ? analysisHistory.find((job) => job.jobId === selectedJobId) ?? currentJob
    : currentJob;
  const analysisBusy = analysisStarting || currentJob?.status === "running" || currentJob?.status === "queued";
  const hasExecutionRecord = analysisHistory.length > 0 || Boolean(experiment.trackingSelection);
  const sourceOptions = [
    ...(!experiment.trackingSelection ? [{ value: "legacy", label: "Revisão anterior" }] : []),
    ...(experiment.trackingSelection && !analysisHistory.some((job) => `colab:${job.jobId}` === trackingSourceKey(experiment.trackingSelection))
      ? [{ value: trackingSourceKey(experiment.trackingSelection), label: `Fonte anterior · ${experiment.trackingSelection.engine} · ${experiment.trackingSelection.jobId.slice(0, 8)}` }] : []),
    ...analysisHistory.filter((job) => job.resultsReady || job.status === "succeeded")
      .map((job) => ({ value: `colab:${job.jobId}`, label: `Colab · ${job.modelBundleId || "modelo legado"} · ${new Date(job.createdAt).toLocaleString()} · ${job.jobId.slice(0, 8)}` })),
  ];
  const editorLocked = viewMode === "raw" || sourceLoading;
  const positionLocked = editorLocked || !currentFrameSample;
  const changeWorkspace = (tab: WorkspaceTab) => {videoRef.current?.pause();setPlaying(false);cancelDrag();setDrawingBox(false);setWorkspaceTab(tab);};
  const elapsedSec = visibleJob ? jobElapsedSeconds(visibleJob, jobClock) : 0;

  return (
    <div className="tracking-page">
      <input ref={videoFileRef} type="file" accept="video/*" className="sr-only" onChange={attachVideoFile} />
      <header className="editor-header">
        <button className="editor-home" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16} /><span><strong>Behavior Tracker</strong><small>Experimentos</small></span></button>
        <div className="editor-title"><div><h1>{experiment.title}</h1><p>{experiment.subjectId}{experiment.group ? ` · ${experiment.group}` : ""} · Campo aberto · {experiment.modelBundleId || "modelo legado"}</p></div><Badge tone={rawSamples.length ? "warning" : "neutral"} dot>{rawSamples.length ? "Em revisão" : "Sem tracking"}</Badge></div>
        <div className="editor-context">
          {isTauriRuntime() && <button type="button" className={`editor-colab-status${colabSummary.connected ? " connected" : ""}`} onClick={() => navigate({ name: "colab" })}>
            <CloudCog size={16} />{colabSummary.connected ? "Colab conectado" : "Conectar Colab"}
          </button>}
          <EditorTabs<WorkspaceTab> id="workspace" label="Áreas do experimento" value={workspaceTab} onChange={changeWorkspace} items={[
            {id:"review",label:"Revisar vídeo"},
            ...(hasExecutionRecord ? [{id:"runs" as const,label:"Execuções"}] : []),
          ]}/>
          {sourceOptions.length > 1 && <SelectMenu label="Resultado em revisão" value={trackingSourceKey(experiment.trackingSelection)}
            options={sourceOptions} disabled={sourceLoading} onChange={(value) => void switchSource(value)} />}
        </div>
        <div className="editor-header-actions">
          <Button className="analyze-button header-analyze" disabled={analysisBusy || !colabSummary.connected} icon={<CloudCog size={16} />} onClick={() => void runColabAnalysis()}>{rawSamples.length ? "Reprocessar no Colab" : "Analisar no Colab"}</Button>
          <Button disabled={!rawSamples.length||sourceLoading} icon={<BarChart3 size={16} />} onClick={() => navigate({ name: "results", experimentId })}>Análise Completa</Button>
          <Button variant="secondary" icon={<Plus size={16} />} onClick={() => navigate({ name: "new-experiment" })}>Novo experimento</Button>
        </div>
      </header>
      {experiment.legacyReviewSource&&experiment.legacyReviewSource!=="legacy"&&experiment.corrections.some(event=>!event.reviewSource&&["MOVE_POINT","SET_BOX","CONFIRM_POINT","MARK_MISSING"].includes(event.type))&&<div className="editor-error"><Button size="sm" variant="ghost" disabled={sourceLoading} onClick={()=>updateExperiment(experiment.id,{legacyReviewSource:"legacy"})}>Reassociar correções antigas</Button></div>}
      {hasUnassignedCorrections(experiment)&&<div className="editor-error">
        <span>Há correções antigas preservadas, mas sem identificação da execução. Elas não serão misturadas ao OpenCV. Selecione o resultado Colab que você corrigiu para associá-las.</span>
        {experiment.trackingSelection?.engine==="colab"&&<Button size="sm" variant="secondary" disabled={sourceLoading} onClick={()=>updateExperiment(experiment.id,{legacyReviewSource:trackingSourceKey(experiment.trackingSelection)})}>Associar correções antigas a este Colab</Button>}
      </div>}

      <div>
      {csvError && csvError !== visibleJob?.error && <div className="editor-error"><AlertCircle size={16} /> {csvError}</div>}
      {latestResultJob?.customModel&&<div className="editor-error"><AlertCircle size={16}/>Modelo personalizado experimental: confiança anatômica não calibrada. Os pontos exigem revisão humana e não entram automaticamente nas métricas.</div>}
      {inputSamples[0]?.recoveryState === "unavailable" && <div className="editor-error"><AlertCircle size={16} /> A segunda passagem visual não estava disponível neste runtime. As detecções originais foram preservadas; consulte o diário da execução antes de considerar a recuperação concluída.</div>}
      {inputSamples[0]?.recoveryState === "limited" && <div className="editor-error"><AlertCircle size={16} /> A recuperação atingiu seu limite de tentativas ou tempo. Lacunas restantes foram preservadas para revisão, sem inventar posições.</div>}
      </div>
      <section hidden={workspaceTab!=="runs"} role="tabpanel" id="workspace-runs-panel" aria-labelledby="workspace-runs-tab" className="execution-workspace">
        <h2>Execuções no Colab</h2>
        <AnalysisWorkflow job={visibleJob} preparing={preparingAnalysis} message={analysisMessage} localError={!visibleJob ? analysisError ?? csvError : null} elapsedSec={elapsedSec}/>
        {!analysisHistory.length&&!analysisStarting&&<p>Nenhuma execução registrada. Use “Analisar no Colab” para começar.</p>}
        <div className="analysis-history-list">{analysisHistory.map((job)=><button type="button" className={`analysis-run analysis-run-${job.status}`} key={job.jobId} aria-pressed={visibleJob?.jobId===job.jobId} onClick={()=>setSelectedJobId(job.jobId)}>
          <div className="analysis-run-status">{job.status==="succeeded"?<CheckCircle2 size={16}/>:job.status==="failed"?<AlertCircle size={16}/>:<CloudCog size={16}/>}</div>
          <div><strong>{jobStatusLabel(job)}</strong><span>{displayAnalysisMessage(job.error||job.message)}</span></div><time><Clock3 size={13}/>{formatDuration(jobElapsedSeconds(job,jobClock))}</time>
        </button>)}</div>
      </section>

      {workspaceTab==="review" && (!rawSamples.length ? (
        <section className="tracking-empty tracking-processing panel" role="tabpanel" id={`workspace-${workspaceTab}-panel`} aria-labelledby={`workspace-${workspaceTab}-tab`}>
          <div className="tracking-empty-visual"><ScanSearch size={40} /><span /></div>
          <h2>Processar o vídeo no Google Colab</h2>
          <p>Acompanhe o envio, a GPU alocada e o rastreamento do animal. Cada checkpoint avança após uma confirmação real da execução.</p>
          <AnalysisWorkflow job={visibleJob} preparing={preparingAnalysis}
            message={analysisMessage} localError={!visibleJob ? analysisError ?? csvError : null} elapsedSec={elapsedSec} />
          {!analysisBusy && (
            <div className="tracking-empty-actions">
              <Button className="analyze-button" size="lg" disabled={!colabSummary.connected} icon={<CloudCog size={19} />} onClick={() => void runColabAnalysis()}>
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
        </section>
      ) : (
        <div className="editor-workspace" role="tabpanel" id={`workspace-${workspaceTab}-panel`} aria-labelledby={`workspace-${workspaceTab}-tab`}>
          <section className="video-column">
            <div className="video-toolbar">
              <div className="toolbar-spacer" />
              {!asset?.objectUrl&&<Button variant="secondary" size="sm" onClick={()=>{analysisRequestedRef.current=false;videoFileRef.current?.click();}}>Abrir vídeo original</Button>}
              {macroMode&&<Button variant="secondary" size="sm" disabled={positionLocked} icon={<ScanSearch size={15}/>} onClick={()=>{videoRef.current?.pause();setPlaying(false);setDrawingBox(current=>!current);}}>{drawingBox?"Cancelar caixa":"Marcar caixa neste frame"}</Button>}
              <button className={cn("tool-toggle", showTrajectory && "active")} onClick={() => setShowTrajectory((current) => !current)}>{showTrajectory ? <Eye size={16} /> : <EyeOff size={16} />} Trajetória</button>
              <Button variant="secondary" size="sm" icon={<SkipForward size={15} />} onClick={nextIssue}>Próximo problema</Button>
            </div>
            <div className="video-stage">
              {asset?.objectUrl && (
                <video
                  ref={videoRef}
                  src={asset.objectUrl}
                  muted
                  playsInline
                  onLoadedMetadata={(event) => { event.currentTarget.currentTime = currentTime; }}
                  onTimeUpdate={(event) => {if (!event.currentTarget.requestVideoFrameCallback) setCurrentTime(event.currentTarget.currentTime);}}
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
                aria-label="Vídeo com pontos editáveis"
                onPointerDown={(event) => {
                  if (editorLocked || macroMode || workspaceTab!=="review") return;
                  if (placingPoint || !drawablePose(selectedPoint)) beginDrag(event,selectedKeypoint,drawablePose(selectedPoint)?{x:selectedPoint.xPx,y:selectedPoint.yPx}:null,true);
                }}
                onPointerMove={(event) => {const value=dragRef.current;if(value?.pointerId===event.pointerId){const next={...value,current:dragPosition(event,value)};dragRef.current=next;setDrag(next);}}}
                onPointerUp={finishDrag}
                onPointerCancel={cancelDrag}
                onLostPointerCapture={()=>{if(dragRef.current)cancelDrag();}}
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
                <polygon points={pointsToSvg(experiment.arena.cornersPx)} fill="none" stroke="#a7adb2" strokeOpacity=".75" strokeWidth="3" />
                {experiment.arena.rimCornersPx && <polygon points={pointsToSvg(experiment.arena.rimCornersPx)} fill="none" stroke="#f0f0ed" strokeOpacity=".65" strokeWidth="3" strokeDasharray="12 8" />}
                <polygon points={pointsToSvg(centerPolygon)} fill="#85ae98" fillOpacity=".07" stroke="#85ae98" strokeOpacity=".55" strokeWidth="2" strokeDasharray="10 8" />
                {showTrajectory && trajectory.map((segment, index) => <polyline key={index} points={pointsToSvg(segment)} fill="none" stroke="#a7adb2" strokeWidth="4" strokeOpacity=".75" strokeLinecap="round" strokeLinejoin="round" />)}
                {showTrajectory && keyframePreview.map((segment, index) => <polyline key={`keyframe-${index}`} points={pointsToSvg(segment)} fill="none" stroke="#f0f0ed" strokeWidth="4" strokeDasharray="11 8" strokeOpacity=".9" strokeLinecap="round" strokeLinejoin="round" />)}
                {[["nose", "body_center"], ["body_center", "tail_base"], ["left_ear", "nose"], ["right_ear", "nose"]].map(([a, b]) => {
                  const first = currentPoints.find((sample) => sample.keypoint === a);
                  const second = currentPoints.find((sample) => sample.keypoint === b);
                  if (!drawablePose(first) || !drawablePose(second) ||
                      (first.source !== "manual" && first.likelihood < .5) ||
                      (second.source !== "manual" && second.likelihood < .5)) return null;
                  return <line key={`${a}-${b}`} x1={first.xPx} y1={first.yPx} x2={second.xPx} y2={second.yPx} stroke="#ecfdf5" strokeOpacity=".8" strokeWidth="4" />;
                })}
                {!macroMode&&currentPoints.map((sample) => {
                  if (!drawablePose(sample) || (sample.source !== "manual" && sample.likelihood < .5)) return null;
                  const point = drag?.keypoint === sample.keypoint ? drag.current : { x: sample.xPx, y: sample.yPx };
                  const rawPoint = rawCurrentPoints.find((raw) => raw.keypoint === sample.keypoint);
                  const corrected = sample.source === "manual" && (!rawPoint || rawPoint.xPx !== sample.xPx || rawPoint.yPx !== sample.yPx);
                  const selected = sample.keypoint === selectedKeypoint;
                  return (
                    <g
                      key={sample.keypoint}
                      data-keypoint={sample.keypoint}
                      aria-label={`${keypointLabels[sample.keypoint]??sample.keypoint}${sample.source==="manual"?" · corrigido manualmente":""}`}
                      className="tracking-point"
                      transform={`translate(${point.x} ${point.y})`}
                      onPointerDown={(event) => {
                        if(placingPoint)beginDrag(event,selectedKeypoint,drawablePose(selectedPoint)?{x:selectedPoint.xPx,y:selectedPoint.yPx}:null,true);
                        else beginDrag(event,sample.keypoint,{x:sample.xPx,y:sample.yPx});
                      }}
                    >
                      {corrected && <circle r="19" fill="none" stroke="#f7c96b" strokeWidth="3" strokeDasharray="4 4" />}
                      <circle r={selected ? 12 : 9} fill={sample.source === "recovered" ? "#f0f0ed" : sample.status === "valid" ? "#a7adb2" : "#f7c96b"} stroke="#242628" strokeWidth="3" />
                      {selected && <text y="-19" textAnchor="middle" fontSize="14" fontWeight="700" fill="#fff">{keypointLabels[sample.keypoint] ?? sample.keypoint}</text>}
                    </g>
                  );
                })}
                {!macroMode&&currentPoints.filter(sample=>drawablePose(sample)&&sample.bbox).map(sample=><BoxOverlay key={`legacy-box-${sample.keypoint}`} box={sample.bbox}
                  width={experiment.video.width} height={experiment.video.height} drawing={false} editable={false} predicted={sample.source==="predicted"} manual={sample.source==="manual"}
                  onStart={()=>{}} onCancel={()=>{}} onCommit={()=>{}}/>)}
                {macroMode&&<BoxOverlay key={`${trackingSourceKey(experiment.trackingSelection)}:${currentFrame}`} box={drawablePose(currentReference)?currentReference.bbox:undefined}
                  width={experiment.video.width} height={experiment.video.height} drawing={drawingBox} editable={!positionLocked&&workspaceTab==="review"}
                  predicted={currentReference?.source==="predicted"} manual={currentReference?.source==="manual"}
                  onStart={()=>{videoRef.current?.pause();setPlaying(false);setCorrectionMessage("");}} onCancel={()=>setDrawingBox(false)} onCommit={saveBox}/>}
              </svg>
              <div className="stage-badges"><Badge tone="neutral">Frame {currentFrame}</Badge><Badge tone={qualityInfo.tone}>{qualityInfo.label}</Badge>{currentReference?.source && currentReference.source !== "detected" && currentReference.source !== "recovered" && <Badge tone="warning">{poseSourceLabel(currentReference)}</Badge>}</div>
              {workspaceTab==="review"&&viewMode!=="raw"&&(!asset?.objectUrl&&experiment.video.timingSource!=="synthetic"?<div className="placement-hint">Abra o vídeo original para conferir a posição real do animal</div>:macroMode?(drawingBox&&<div className="placement-hint">Arraste de um canto ao outro ao redor do animal · Esc cancela</div>):(placingPoint||!drawablePose(selectedPoint))&&<div className="placement-hint">{currentFrameSample?`Clique e arraste para posicionar ${keypointLabels[selectedKeypoint] ?? selectedKeypoint}`:"Sem timestamp de origem para este frame · edição bloqueada para não corrigir o frame errado"}</div>)}
              {viewMode === "raw" && <div className="raw-lock"><RotateCcw size={15} /> Visualização bruta · edição bloqueada</div>}
            </div>

            <div className="playback-bar">
              <button className="transport-button" onClick={() => stepFrame(-1)} title="Frame anterior"><ChevronLeft size={19} /></button>
              <button className="play-button" onClick={() => setPlaying((current) => !current)}>{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>
              <button className="transport-button" onClick={() => stepFrame(1)} title="Próximo frame"><ChevronRight size={19} /></button>
              <div className="timecode"><strong>{formatDuration(currentTime)}</strong><span>/ {formatDuration(duration)}</span></div>
              <div className="playback-spacer" />
              <div className="speed-control"><Gauge size={15} /><div className="speed-options" role="group" aria-label="Velocidade de reprodução">
                {([0.25, 0.5, 1, 2] as const).map((value) => <button key={value} type="button" aria-pressed={speed === value}
                  onClick={() => setSpeed(value)}>{String(value).replace(".", ",")}×</button>)}
              </div></div>
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
              {macroMode&&<div className="keyframe-lane">
                <div className="keyframe-lane-heading"><strong>Caixas manuais</strong><span>{boxKeyframes.length} quadros-chave · {predictedFrameCount} frames previstos</span></div>
                <div className="keyframe-lane-track" aria-label="Quadros-chave das caixas do animal">
                  {viewMode==="reviewed"&&boxKeyframes.slice(0,-1).map((start,index)=>{
                    const end=boxKeyframes[index+1];
                    return <span key={`span-${start.frameIndex}`} className="keyframe-span" style={{left:`${duration?start.timestampSec/duration*100:0}%`,width:`${duration?(end.timestampSec-start.timestampSec)/duration*100:0}%`}} title={`Previsão entre frames ${start.frameIndex} e ${end.frameIndex}`}/>;
                  })}
                  {boxKeyframes.map((sample)=><button key={sample.frameIndex} type="button" className="keyframe-marker" style={{left:`${duration?sample.timestampSec/duration*100:0}%`}}
                    title={`Quadro-chave manual · frame ${sample.frameIndex}`} aria-label={`Ir ao quadro-chave do frame ${sample.frameIndex}`}
                    onClick={()=>{setPlaying(false);setTime(sample.timestampSec);setViewMode("reviewed");}}/>)}
                </div>
                <p>{boxKeyframes.length<2?"Marque a caixa no animal em dois frames diferentes. Os frames entre eles serão preenchidos automaticamente.":"Arraste uma caixa prevista para corrigir o caminho e criar outro quadro-chave. A linha roxa tracejada é estimada, não observada."}</p>
              </div>}
            </div>
            <div className="review-feedback">
              <div><span>Trajeto: <strong>{keypointLabels[referenceKeypoint]??referenceKeypoint}</strong></span><span>Distância revisada <strong>{reviewedMetrics?.distanceCm==null?"Não mensurável":`${reviewedMetrics.distanceCm.toFixed(1)} cm`}</strong></span><span>Cobertura válida <strong>{(reviewedMetrics?.coveragePct??0).toFixed(1)}%</strong></span></div>
              {correctionMessage&&<p role="status">{correctionMessage}</p>}
            </div>
          </section>

          <aside className="inspector-panel">
            <div hidden={workspaceTab!=="review"}>
            <EditorTabs id="inspector" label="Inspeção do tracking" value={inspectorTab} onChange={setInspectorTab} items={[{id:"points",label:"Correção"},{id:"history",label:"Histórico"}]}/>
            <div hidden={inspectorTab!=="points"} role="tabpanel" id="inspector-points-panel" aria-labelledby="inspector-points-tab">
            <section className="inspector-section">
              <div className="inspector-label">{macroMode?"Animal inteiro · caixa":"Partes do animal"} · frame {currentFrame}</div>
              <p className="correction-help">{macroMode?"Marque a caixa em dois frames pela timeline. O intervalo é previsto por interpolação; arraste uma caixa intermediária para criar outro quadro-chave e ajustar o caminho. A previsão não detecta partes ocultas nem entra nas métricas.":"Arraste os pontos no vídeo. Para uma parte ausente, selecione abaixo e clique e arraste na posição correta."}</p>
              <div className="keypoint-list">
                {keypoints.map((keypoint) => {
                  const point = currentPoints.find((sample) => sample.keypoint === keypoint);
                  return <button key={keypoint} aria-pressed={keypoint===selectedKeypoint} data-keypoint-option={keypoint} title={poseSourceLabel(point)} className={keypoint === selectedKeypoint ? "active" : ""} onClick={() => {cancelDrag();setSelectedKeypoint(keypoint);setPlaying(false);}}><CircleDot size={16} /><span>{keypointLabels[keypoint] ?? keypoint}{keypoint===referenceKeypoint&&<em>Trajeto e métricas</em>}</span><small>{point?.source==="manual"?"Manual":!drawablePose(point)?"Ausente":latestResultJob?.customModel?"Não calibrada":confidenceLabel(point)}</small></button>;
                })}
              </div>
            </section>
            <section className="inspector-section correction-actions">
              <div className="inspector-label">Ações no frame {currentFrame}</div>
              {macroMode?<Button variant="secondary" icon={<MousePointer2 size={16}/>} disabled={positionLocked} onClick={()=>{videoRef.current?.pause();setPlaying(false);setDrawingBox(current=>!current);}}>{drawingBox?"Cancelar desenho":"Desenhar caixa do animal"}</Button>:
              <Button variant="secondary" icon={<MousePointer2 size={16} />} onClick={() => {videoRef.current?.pause();setPlaying(false);setPlacingPoint((current) => !current);}} disabled={positionLocked}>{placingPoint ? "Cancelar posicionamento" : drawablePose(selectedPoint)?"Reposicionar no vídeo":"Posicionar ponto ausente"}</Button>}
              <Button variant="ghost" icon={<Flag size={16} />} onClick={markMissing} disabled={!drawablePose(selectedPoint) || editorLocked}>Marcar como ausente</Button>
              <Button variant="secondary" onClick={confirmPoint} disabled={editorLocked || !drawablePose(selectedPoint) || selectedPoint?.source === "predicted"}>{macroMode?"Confirmar caixa após revisar":"Confirmar ponto após revisar"}</Button>
              <div className="undo-row"><Button variant="ghost" size="sm" icon={<Undo2 size={15} />} onClick={undo} disabled={!activeEvents.length || editorLocked}>Desfazer</Button></div>
              <small>{macroMode?"Caixas manuais salvas neste dispositivo. Entre dois quadros-chave, as caixas previstas aparecem apenas para revisão; os dados brutos e as métricas científicas não são preenchidos automaticamente.":"Salvo automaticamente neste dispositivo. A correção vale somente para este frame, sem preencher outros trechos."}</small>
            </section>
            <details className="correction-details"><summary>Qualidade e visibilidade</summary>
            <section className="inspector-section frame-quality">
              <div className="inspector-label">Qualidade: {keypointLabels[referenceKeypoint] ?? referenceKeypoint}</div>
              <div className={`quality-card quality-${currentReference?.source === "recovered" ? "low_confidence" : currentStatus}`}>
                {qualityInfo.tone === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                <div><strong>{qualityInfo.label}</strong><span>{macroMode?"Centro geométrico 2D · sem score anatômico":latestResultJob?.customModel&&currentReference?.source!=="manual"?"Confiança anatômica não calibrada":`Score do modelo: ${confidenceLabel(currentReference)}`}</span></div>
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
              <p>Borda e chão ajudam a delimitar a imagem, mas não medem altura nem classificam postura.</p>
            </section>
            </details>
            </div>
            <section hidden={inspectorTab!=="history"} role="tabpanel" id="inspector-history-panel" aria-labelledby="inspector-history-tab" className="inspector-section correction-history">
              <h3>Correções salvas</h3><p>Selecione um registro para voltar ao frame. Os dados brutos permanecem intactos.</p>
              {!activeEvents.length&&<p>Nenhuma correção ativa.</p>}
              {activeEvents.slice().reverse().map((event)=><article key={event.id}>
                <button onClick={()=>{setPlaying(false);setTime(event.timestampSec??frameTimeline.find((sample)=>sample.frameIndex===event.frameIndex)?.timestampSec??event.startSec??0);if(event.keypoint)setSelectedKeypoint(event.keypoint);}}>
                  <strong>{event.type==="SET_BOX"?"Caixa corrigida":event.type==="MOVE_POINT"?"Ponto reposicionado":event.type==="MARK_MISSING"?"Marcado ausente":event.type==="CONFIRM_POINT"?"Ponto confirmado":event.type==="ANNOTATE_BEHAVIOR"?"Comportamento anotado":"Sugestão descartada"}</strong>
                  <span>{event.keypoint?keypointLabels[event.keypoint]??event.keypoint:event.label} {event.frameIndex!=null?`· frame ${event.frameIndex}`:""}</span>
                  {event.after&&<small>x {event.after.x.toFixed(1)} · y {event.after.y.toFixed(1)} px</small>}
                </button>
                <Button size="sm" variant="ghost" disabled={editorLocked} onClick={()=>appendEvent({id:crypto.randomUUID(),type:"REVERT_EVENT",targetEventId:event.id,source:"manual",createdAt:new Date().toISOString()})}>Desfazer correção</Button>
              </article>)}
            </section>
            <section className="inspector-audit">
              <div><History size={16} /><span>{activeEvents.length} intervenções ativas</span></div>
              <small>Dados brutos preservados</small>
            </section>
            </div>
          </aside>
        </div>
      ))}
    </div>
  );
}
