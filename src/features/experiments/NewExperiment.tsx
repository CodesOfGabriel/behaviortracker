import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  FileVideo2,
  FlaskConical,
  Info,
  MousePointer2,
  Play,
  Ruler,
  UploadCloud,
  Video,
  Waves,
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { defaultArena, DEMO_VIDEO_HEIGHT, DEMO_VIDEO_WIDTH } from "../../lib/demo-data";
import { centerPolygonPx, pointsToSvg, validateArenaRegions } from "../../lib/geometry";
import { formatBytes, formatDuration } from "../../lib/format";
import { useAppStore } from "../../store/AppStore";
import type { ArenaConfig, Experiment, Point, VideoAsset, VideoMetadata } from "../../types";
import { getHybridBundleAvailability, importHybridBundle, LATEST_HYBRID_BUNDLE_ID, prepareVideo } from "../colab/analysis";
import type { HybridBundleStatus } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";

const STEPS = [
  { label: "Experimento", helper: "Protocolo e sujeito" },
  { label: "Vídeo", helper: "Arquivo e metadados" },
  { label: "Arena", helper: "Calibração espacial" },
  { label: "Revisão", helper: "Conferência final" },
];

type ArenaLayer = "rim" | "floor";

function initialCorners(width: number, height: number): ArenaConfig["cornersPx"] {
  return [
    { x: width * 0.16, y: height * 0.14 },
    { x: width * 0.84, y: height * 0.14 },
    { x: width * 0.88, y: height * 0.86 },
    { x: width * 0.12, y: height * 0.86 },
  ];
}

function waitForMediaEvent(
  element: HTMLVideoElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked",
) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("O vídeo demorou demais para disponibilizar o frame."));
    }, 10_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("O navegador não conseguiu ler esse codec."));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      element.removeEventListener(eventName, onReady);
      element.removeEventListener("error", onError);
    };
    element.addEventListener(eventName, onReady, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
}

async function openVideo(objectUrl: string) {
  const element = document.createElement("video");
  element.preload = "auto";
  element.muted = true;
  element.playsInline = true;
  const metadataReady = waitForMediaEvent(element, "loadedmetadata");
  element.src = objectUrl;
  element.load();
  await metadataReady;
  return element;
}

async function captureVideoFrame(element: HTMLVideoElement, requestedTimeSec: number) {
  if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForMediaEvent(element, "loadeddata");
  }
  const duration = Number.isFinite(element.duration) ? element.duration : 0;
  const latestFrame = Math.max(0, duration - 0.05);
  const timeSec = Math.max(0, Math.min(requestedTimeSec, latestFrame));
  if (Math.abs(element.currentTime - timeSec) > 0.01) {
    const frameReady = waitForMediaEvent(element, "seeked");
    element.currentTime = timeSec;
    await frameReady;
  }
  if (!element.videoWidth || !element.videoHeight) {
    throw new Error("O vídeo não informou uma resolução válida.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = element.videoWidth;
  canvas.height = element.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Não foi possível preparar a captura do frame.");
  context.drawImage(element, 0, 0, canvas.width, canvas.height);
  const thumbnail = document.createElement("canvas");
  const scale = Math.min(1, 480 / canvas.width);
  thumbnail.width = Math.max(1, Math.round(canvas.width * scale));
  thumbnail.height = Math.max(1, Math.round(canvas.height * scale));
  thumbnail.getContext("2d")?.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
  return { frameDataUrl: canvas.toDataURL("image/jpeg", 0.9), thumbnailDataUrl: thumbnail.toDataURL("image/jpeg", 0.72), timeSec };
}

function ArenaPreview({
  metadata,
  frameDataUrl,
  arena,
  layer,
  onChange,
}: {
  metadata: VideoMetadata;
  frameDataUrl?: string;
  arena: ArenaConfig;
  layer: ArenaLayer;
  onChange: (layer: ArenaLayer, corners: ArenaConfig["cornersPx"]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const activeCorners = layer === "rim" ? arena.rimCornersPx ?? arena.cornersPx : arena.cornersPx;
  const color = layer === "rim" ? "#f1f1ed" : "#a7adb2";
  const center = useMemo(() => {
    try {
      return centerPolygonPx(arena);
    } catch {
      return [];
    }
  }, [arena]);

  const pointFromEvent = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const svg = svgRef.current!;
    const matrix = svg.getScreenCTM();
    if (!matrix) return activeCorners[dragging ?? 0];
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return {
      x: Math.max(0, Math.min(metadata.width, point.x)),
      y: Math.max(0, Math.min(metadata.height, point.y)),
    };
  };

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragging == null) return;
    const next = [...activeCorners] as ArenaConfig["cornersPx"];
    next[dragging] = pointFromEvent(event);
    onChange(layer, next);
  };

  return (
    <div className="arena-editor-frame">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${metadata.width} ${metadata.height}`}
        style={{ aspectRatio: `${metadata.width}/${metadata.height}`, maxHeight: "65vh" }}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={move}
        onPointerUp={(event) => {
          if (dragging != null) event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(null);
        }}
        onPointerCancel={() => setDragging(null)}
        aria-label={`Editor dos quatro vértices ${layer === "rim" ? "da borda superior" : "do chão"}`}
      >
        {frameDataUrl ? (
          <image href={frameDataUrl} width={metadata.width} height={metadata.height} preserveAspectRatio="none" />
        ) : metadata.timingSource === "synthetic" ? (
          <>
            <defs>
              <linearGradient id="floor" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#d8d9d2" />
                <stop offset="1" stopColor="#bfc4bb" />
              </linearGradient>
              <filter id="shadow"><feDropShadow dx="0" dy="12" stdDeviation="18" floodOpacity=".22" /></filter>
            </defs>
            <rect width={metadata.width} height={metadata.height} fill="#1e2422" />
            <polygon points={pointsToSvg(arena.cornersPx)} fill="url(#floor)" stroke="#58645f" strokeWidth="12" filter="url(#shadow)" />
            <ellipse cx={metadata.width * 0.52} cy={metadata.height * 0.56} rx="32" ry="19" fill="#4a4c47" opacity=".86" />
            <circle cx={metadata.width * 0.545} cy={metadata.height * 0.55} r="8" fill="#3a3b37" />
            <path d={`M ${metadata.width * 0.49} ${metadata.height * 0.565} q -45 10 -75 -20`} fill="none" stroke="#4a4c47" strokeWidth="7" strokeLinecap="round" />
          </>
        ) : (
          <>
            <rect width={metadata.width} height={metadata.height} fill="#202624" />
            <text x="50%" y="50%" textAnchor="middle" fill="#dfe6e1" fontSize={Math.max(16, metadata.width / 45)}>
              Selecione novamente um frame do vídeo
            </text>
          </>
        )}
        <polygon points={pointsToSvg(arena.cornersPx)} fill="#a7adb2" fillOpacity=".08" stroke="#a7adb2" strokeWidth={Math.max(3, metadata.width / 420)} />
        {arena.rimCornersPx && <>
          {arena.rimCornersPx.map((point, index) => <line key={index} x1={point.x} y1={point.y} x2={arena.cornersPx[index].x} y2={arena.cornersPx[index].y} stroke="#f0f0ed" strokeOpacity=".45" strokeDasharray="8 6" strokeWidth={Math.max(2, metadata.width / 650)} />)}
          <polygon points={pointsToSvg(arena.rimCornersPx)} fill="#f0f0ed" fillOpacity=".04" stroke="#f0f0ed" strokeWidth={Math.max(3, metadata.width / 420)} />
        </>}
        {center.length === 4 && (
          <polygon points={pointsToSvg(center)} fill="#85ae98" fillOpacity=".16" stroke="#85ae98" strokeWidth={Math.max(2, metadata.width / 650)} strokeDasharray="12 8" />
        )}
        {activeCorners.map((point, index) => (
          <g
            key={index}
            className="arena-handle"
            role="button"
            tabIndex={0}
            aria-label={`${layer === "rim" ? "Borda" : "Chão"}, vértice ${index + 1}; use as setas para ajustar`}
            onKeyDown={(event) => {
              const offset = event.shiftKey ? 10 : 1;
              const delta: Record<string, Point> = { ArrowLeft: { x: -offset, y: 0 }, ArrowRight: { x: offset, y: 0 }, ArrowUp: { x: 0, y: -offset }, ArrowDown: { x: 0, y: offset } };
              if (!delta[event.key]) return;
              event.preventDefault();
              const next = [...activeCorners] as ArenaConfig["cornersPx"];
              next[index] = { x: Math.max(0, Math.min(metadata.width, point.x + delta[event.key].x)), y: Math.max(0, Math.min(metadata.height, point.y + delta[event.key].y)) };
              onChange(layer, next);
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
              setDragging(index);
            }}
            transform={`translate(${point.x} ${point.y})`}
          >
            <circle r={metadata.width / 90} fill="#1a211b" stroke={color} strokeWidth={metadata.width / 360} />
            <circle r={metadata.width / 220} fill={color} />
            <text y={-metadata.width / 55} textAnchor="middle" fontSize={metadata.width / 58} fontWeight="700" fill="#fff">
              {layer === "rim" ? "B" : "P"}{index + 1}
            </text>
          </g>
        ))}
      </svg>
      <div className="arena-legend">
        <span><i className="legend-arena" /> Piso da arena</span>
        <span><i className="legend-rim" /> Borda superior</span>
        <span><i className="legend-center" /> Centro ({Math.round(arena.centerAreaFraction * 100)}% da área)</span>
      </div>
    </div>
  );
}

export function NewExperiment() {
  const { navigate, saveExperiment } = useAppStore();
  const [draftId] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState(0);
  const [protocolSelected, setProtocolSelected] = useState(false);
  const [title, setTitle] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [group, setGroup] = useState("");
  const [notes, setNotes] = useState("");
  const modelBundleId = LATEST_HYBRID_BUNDLE_ID;
  const [bundleStatus, setBundleStatus] = useState<HybridBundleStatus | null>(null);
  const [bundleDirectory, setBundleDirectory] = useState("");
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [importingBundle, setImportingBundle] = useState(false);
  const [checkingBundle, setCheckingBundle] = useState(false);
  const [video, setVideo] = useState<VideoMetadata | null>(null);
  const [asset, setAsset] = useState<VideoAsset>({});
  const [arena, setArena] = useState<ArenaConfig>(defaultArena);
  const [arenaLayer, setArenaLayer] = useState<ArenaLayer>("rim");
  const [confirmedRegions, setConfirmedRegions] = useState({ rim: false, floor: false });
  const [videoError, setVideoError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [preparationMessage, setPreparationMessage] = useState("");
  const [capturingFrame, setCapturingFrame] = useState(false);
  const [frameCandidateSec, setFrameCandidateSec] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const arenaError = useMemo(
    () => video ? validateArenaRegions(arena, video.width, video.height, true) : null,
    [arena, video],
  );

  const regionsConfirmed = confirmedRegions.rim && confirmedRegions.floor;
  const canContinue = !loadingVideo && !checkingBundle && [Boolean(subjectId.trim()), Boolean(video), !arenaError && regionsConfirmed, true][step];

  const verifyBundle = async () => {
    if (!isTauriRuntime()) return true;
    setCheckingBundle(true);
    setBundleError(null);
    try {
      const status = await getHybridBundleAvailability(modelBundleId);
      setBundleStatus(status);
      return status.installed;
    } catch (error) {
      setBundleError(String(error));
      return false;
    } finally {
      setCheckingBundle(false);
    }
  };

  const continueWizard = async () => {
    if (step === 0 && !(await verifyBundle())) return;
    setStep((current) => current + 1);
  };

  const changeRegion = (layer: ArenaLayer, corners: ArenaConfig["cornersPx"]) => {
    setArena((current) => ({ ...current, [layer === "rim" ? "rimCornersPx" : "cornersPx"]: corners }));
    setConfirmedRegions((current) => ({ ...current, [layer]: false }));
  };

  const loadDemo = () => {
    if (loadingVideo) return;
    setPreparationMessage("");
    setVideo({
      filename: "arena_demo_sintetica.mp4",
      sizeBytes: 0,
      width: DEMO_VIDEO_WIDTH,
      height: DEMO_VIDEO_HEIGHT,
      durationSec: 120,
      fps: 30,
      timingSource: "synthetic",
    });
    setAsset({});
    setFrameCandidateSec(0);
    setFrameError(null);
    setArena(defaultArena);
    setArenaLayer("rim");
    setConfirmedRegions({ rim: false, floor: false });
    setVideoError(null);
  };

  const handleVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || loadingVideo) return;
    setLoadingVideo(true);
    setPreparationMessage("Lendo vídeo e capturando o frame de calibração…");
    setVideoError(null);
    setFrameError(null);
    const objectUrl = URL.createObjectURL(file);
    try {
      const element = await openVideo(objectUrl);
      const initialFrameSec = Number.isFinite(element.duration) && element.duration > 0
        ? Math.min(element.duration * 0.35, Math.max(0, element.duration - 0.05))
        : 0;
      const captured = await captureVideoFrame(element, initialFrameSec);
      const metadata: VideoMetadata = {
        filename: file.name,
        sizeBytes: file.size,
        width: element.videoWidth,
        height: element.videoHeight,
        durationSec: element.duration,
        fps: null,
        timingSource: "browser-estimate",
        calibrationFrameSec: captured.timeSec,
        lastModified: file.lastModified,
      };
      if (isTauriRuntime()) {
        metadata.preparation = await prepareVideo(draftId, file, metadata, (_progress, message) => setPreparationMessage(message));
      } else setPreparationMessage("A compactação local está disponível no aplicativo desktop. A prévia web mantém o original.");
      if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
      setVideo(metadata);
      setAsset({ objectUrl, frameDataUrl: captured.frameDataUrl, thumbnailDataUrl: captured.thumbnailDataUrl, frameTimeSec: captured.timeSec, file });
      setFrameCandidateSec(captured.timeSec);
      setArena((current) => ({ ...current, cornersPx: initialCorners(metadata.width, metadata.height), rimCornersPx: [
        { x: metadata.width * .08, y: metadata.height * .05 }, { x: metadata.width * .92, y: metadata.height * .05 },
        { x: metadata.width * .95, y: metadata.height * .95 }, { x: metadata.width * .05, y: metadata.height * .95 },
      ] }));
      setArenaLayer("rim");
      setConfirmedRegions({ rim: false, floor: false });
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      setVideoError(error instanceof Error ? error.message : "Não foi possível abrir o vídeo.");
    } finally {
      setLoadingVideo(false);
    }
  };

  const captureSelectedFrame = async () => {
    if (!video || !asset.objectUrl) return;
    setCapturingFrame(true);
    setFrameError(null);
    try {
      const element = await openVideo(asset.objectUrl);
      const captured = await captureVideoFrame(element, frameCandidateSec);
      setAsset((current) => ({ ...current, frameDataUrl: captured.frameDataUrl, thumbnailDataUrl: captured.thumbnailDataUrl, frameTimeSec: captured.timeSec }));
      setVideo((current) => current ? { ...current, calibrationFrameSec: captured.timeSec } : current);
      setFrameCandidateSec(captured.timeSec);
    } catch (error) {
      setFrameError(error instanceof Error ? error.message : "Não foi possível capturar esse frame.");
    } finally {
      setCapturingFrame(false);
    }
  };

  const createExperiment = () => {
    if (!video || arenaError || !regionsConfirmed) return;
    const now = new Date().toISOString();
    const id = draftId;
    const experiment: Experiment = {
      id,
      schemaVersion: "1.0",
      analysisMethodVersion: "oft-0.2",
      analysisEngine: "wistar_superanimal_hybrid_v1",
      modelBundleId,
      title: title.trim() || `Campo aberto · ${subjectId.trim()}`,
      subjectId: subjectId.trim(),
      group: group.trim() || undefined,
      notes: notes.trim() || undefined,
      testType: "open_field",
      status: "draft",
      createdAt: now,
      updatedAt: now,
      video,
      calibrationThumbnailDataUrl: asset.thumbnailDataUrl,
      arena,
      referencePoint: "mouse_center",
      corrections: [],
    };
    saveExperiment(experiment, asset);
    navigate({ name: "editor", experimentId: id });
  };

  if (!protocolSelected) {
    return (
      <div className="page wizard-page protocol-page">
        <button className="back-link" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16} /> Voltar aos experimentos</button>
        <section className="page-heading protocol-heading">
          <div>
            <div className="eyebrow">Novo experimento</div>
            <h1>Selecione o protocolo</h1>
            <p>Escolha o tipo de experimento para configurar os dados e o vídeo da sessão.</p>
          </div>
        </section>
        <div className="protocol-options" aria-label="Tipos de experimento">
          <button type="button" className="protocol-option protocol-option-open-field" onClick={() => setProtocolSelected(true)}>
            <span className="protocol-option-icon"><FlaskConical size={25} strokeWidth={1.7} /></span>
            <span className="protocol-option-body"><small>Disponível</small><strong>Campo Aberto</strong><span>Rastreamento do animal, trajetória e ocupação das zonas da arena.</span></span>
            <ArrowRight size={20} className="protocol-option-arrow" />
          </button>
          <button type="button" className="protocol-option protocol-option-forced-swim protocol-option-disabled" disabled aria-describedby="forced-swim-description">
            <span className="protocol-option-icon"><Waves size={25} strokeWidth={1.7} /></span>
            <span className="protocol-option-body"><small>Em desenvolvimento</small><strong>Nado Forçado</strong><span id="forced-swim-description">Análise deste protocolo estará disponível em uma versão futura.</span></span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page wizard-page">
      <button className="back-link" onClick={() => step === 0 ? setProtocolSelected(false) : setStep(step - 1)}><ArrowLeft size={16} /> {step === 0 ? "Alterar protocolo" : "Voltar à etapa anterior"}</button>
      <section className="page-heading wizard-heading">
        <div>
          <div className="eyebrow">Novo experimento</div>
          <h1>Configurar campo aberto</h1>
          <p>Registre o protocolo, o vídeo e a geometria antes de analisar o rastreamento.</p>
        </div>
        <Badge tone="info">Rascunho local</Badge>
      </section>

      <div className="wizard-layout">
        <aside className="wizard-steps">
          {STEPS.map((item, index) => (
            <button key={item.label} className={index === step ? "active" : index < step ? "complete" : ""} onClick={() => index < step && setStep(index)}>
              <span>{index < step ? <Check size={15} /> : index + 1}</span>
              <div><strong>{item.label}</strong><small>{item.helper}</small></div>
            </button>
          ))}
          <div className="wizard-note"><Info size={16} /><p>O vídeo original não é modificado. A calibração é salva em pixels da resolução original.</p></div>
        </aside>

        <section className="panel wizard-panel">
          {step === 0 && (
            <div className="wizard-section">
              <div className="wizard-section-heading"><div className="section-icon"><FlaskConical size={21} /></div><div><h2>Dados do experimento</h2><p>Identifique a unidade científica e o protocolo.</p></div></div>
              <div className="form-grid">
                {isTauriRuntime() && <div className="full">
                  <p role="status">{checkingBundle ? "Localizando arquivos do modelo…" : bundleStatus?.installed ? "Arquivos do modelo atual encontrados" : bundleStatus?.error || "O modelo mais recente será localizado ao continuar."}</p>
                  {bundleStatus?.installed === false && <label><span>Pasta com os três arquivos do bundle</span><input value={bundleDirectory} onChange={(event) => setBundleDirectory(event.target.value)} placeholder="Caminho completo da pasta" /></label>}
                  {bundleStatus?.installed === false && <Button type="button" variant="secondary" disabled={!bundleDirectory.trim()} loading={importingBundle} onClick={() => {
                    setImportingBundle(true); setBundleError(null);
                    void importHybridBundle(modelBundleId, bundleDirectory.trim()).then(setBundleStatus).catch((error) => setBundleError(String(error))).finally(() => setImportingBundle(false));
                  }}>Instalar modelo</Button>}
                  {bundleError && <p className="form-error">{bundleError}</p>}
                </div>}
                <label><span>ID do sujeito <b>*</b></span><input autoFocus value={subjectId} onChange={(event) => setSubjectId(event.target.value)} placeholder="Ex.: RAT_001" /></label>
                <label><span>Grupo experimental</span><input value={group} onChange={(event) => setGroup(event.target.value)} placeholder="Ex.: Controle" /></label>
                <label className="full"><span>Nome do experimento</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Gerado automaticamente se ficar vazio" /></label>
                <label className="full"><span>Observações</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Condições de iluminação, protocolo, horário ou observações relevantes" rows={3} /></label>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="wizard-section">
              <div className="wizard-section-heading"><div className="section-icon"><Video size={21} /></div><div><h2>Vídeo da sessão</h2><p>Selecione o arquivo original. Nenhum upload será iniciado.</p></div></div>
              <input ref={fileRef} className="sr-only" type="file" accept="video/mp4,video/quicktime,video/x-msvideo,video/*" onChange={handleVideo} />
              {!video ? (
                <div className="video-dropzone" onClick={() => fileRef.current?.click()}>
                  <div className="upload-icon"><UploadCloud size={27} /></div>
                  <h3>{loadingVideo ? "Preparando vídeo…" : "Selecione um vídeo"}</h3>
                  <p>MP4, MOV ou AVI · o arquivo permanece no dispositivo</p>
                  <Button type="button" variant="secondary" loading={loadingVideo} icon={<FileVideo2 size={17} />}>Escolher arquivo</Button>
                  <button className="demo-link" type="button" onClick={(event) => { event.stopPropagation(); loadDemo(); }}>ou usar uma arena sintética</button>
                </div>
              ) : (
                <div className="video-selected">
                  <div className="video-preview-small">
                    {asset.frameDataUrl ? <img src={asset.frameDataUrl} alt="Frame extraído do vídeo" /> : <div className="synthetic-preview"><span /></div>}
                    <div className="video-play-badge"><Play size={16} fill="currentColor" /></div>
                  </div>
                  <div className="video-file-info"><Badge tone="success" dot>Arquivo lido</Badge><h3>{video.filename}</h3><p>{formatBytes(video.sizeBytes)} · {formatDuration(video.durationSec)} · {video.width} × {video.height}</p><small>Resolução e frames preservados; não reduzimos automaticamente a imagem do animal.</small></div>
                  <Button variant="secondary" size="sm" disabled={loadingVideo} onClick={() => fileRef.current?.click()}>Trocar</Button>
                </div>
              )}
              {preparationMessage && <div className="video-preparation-note" role="status"><Info size={16} /><div><strong>{loadingVideo ? "Preparação local em andamento" : video?.preparation?.status === "optimized" ? "Vídeo otimizado sem perda" : "Qualidade original preservada"}</strong><p>{preparationMessage}</p>{video?.preparation && <small>Original: {formatBytes(video.preparation.originalBytes)} · envio: {formatBytes(video.preparation.uploadBytes)} · sem reduzir resolução/FPS</small>}</div></div>}
              {videoError && <div className="form-error">{videoError}</div>}
              <div className="privacy-note"><Info size={16} /><span>O frame foi extraído apenas para a calibração. Ao reabrir o projeto, o app solicitará o arquivo se o caminho não estiver mais disponível.</span></div>
            </div>
          )}

          {step === 2 && video && (
            <div className="wizard-section arena-step">
              <div className="wizard-section-heading"><div className="section-icon"><MousePointer2 size={21} /></div><div><h2>Marque a borda e o chão da caixa</h2><p>Marque quatro cantos de cada área: superior esquerdo, superior direito, inferior direito e inferior esquerdo. B1 e P1 devem corresponder ao mesmo canto físico.</p></div></div>
              <div className="arena-layer-selector" role="group" aria-label="Área em edição">
                {(["rim", "floor"] as const).map((layer, index) => <button type="button" key={layer} aria-pressed={arenaLayer === layer} className={arenaLayer === layer ? "active" : ""} onClick={() => setArenaLayer(layer)}>
                  <span className={`arena-layer-dot ${layer}`} />
                  <span><strong>{index + 1}. {layer === "rim" ? "Borda superior da caixa" : "Chão da caixa"}</strong><small>{confirmedRegions[layer] ? "Confirmado" : "Ajuste os quatro vértices e confirme"}</small></span>
                  {confirmedRegions[layer] && <CheckCircle2 size={17} />}
                </button>)}
              </div>
              <div className="arena-layout">
                <div className="arena-frame-column">
                  <ArenaPreview metadata={video} frameDataUrl={asset.frameDataUrl} arena={arena} layer={arenaLayer} onChange={changeRegion} />
                  <div className="arena-region-confirm">
                    <p>{arenaLayer === "rim" ? "Borda: siga o aro superior da caixa. O recorte enviado ao modelo incluirá a borda, o chão e uma margem para as paredes." : "Chão: siga a junção das paredes com o piso. Apenas esta área será usada para calcular distâncias e zonas em centímetros."}</p>
                    <Button type="button" variant="secondary" disabled={Boolean(arenaError)} icon={<Check size={16} />} onClick={() => {
                      setConfirmedRegions((current) => ({ ...current, [arenaLayer]: true }));
                      if (arenaLayer === "rim") setArenaLayer("floor");
                    }}>{confirmedRegions[arenaLayer] ? "Confirmar novamente" : `Confirmar ${arenaLayer === "rim" ? "borda" : "chão"}`}</Button>
                  </div>
                  {asset.objectUrl && (
                    <div className="arena-frame-picker">
                      <div className="arena-frame-picker-title">
                        <Camera size={16} />
                        <div><strong>Frame de referência</strong><span>Escolha um momento em que a borda e o chão estejam visíveis.</span></div>
                      </div>
                      <div className="arena-frame-picker-control">
                        <input
                          aria-label="Momento do frame de referência"
                          type="range"
                          min="0"
                          max={Math.max(0, video.durationSec - 0.05)}
                          step="0.1"
                          value={frameCandidateSec}
                          onChange={(event) => setFrameCandidateSec(Number(event.target.value))}
                        />
                        <output>{frameCandidateSec.toFixed(1)} s</output>
                      </div>
                      <Button type="button" size="sm" variant="secondary" loading={capturingFrame} onClick={() => void captureSelectedFrame()}>
                        Usar este frame
                      </Button>
                    </div>
                  )}
                  {frameError && <div className="form-error">{frameError}</div>}
                </div>
                <aside className="arena-settings">
                  <div className="settings-heading"><Ruler size={17} /><div><strong>Dimensões reais</strong><small>Medidas do piso, em cm</small></div></div>
                  <div className="two-inputs">
                    <label><span>Largura</span><div className="input-suffix"><input type="number" min="1" value={arena.widthCm} onChange={(event) => setArena((current) => ({ ...current, widthCm: Number(event.target.value) }))} /><i>cm</i></div></label>
                    <label><span>Altura</span><div className="input-suffix"><input type="number" min="1" value={arena.heightCm} onChange={(event) => setArena((current) => ({ ...current, heightCm: Number(event.target.value) }))} /><i>cm</i></div></label>
                  </div>
                  <div className="center-area-field">
                    <span id="center-area-label">Área central</span>
                    <div className="center-area-options" role="group" aria-labelledby="center-area-label">
                      {([0.25, 0.36, 0.49] as const).map((fraction) => (
                        <button key={fraction} type="button" aria-pressed={arena.centerAreaFraction === fraction}
                          onClick={() => setArena((current) => ({ ...current, centerAreaFraction: fraction }))}>
                          <strong>{Math.round(fraction * 100)}%</strong>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="center-explanation"><strong>Centro geométrico</strong><p>A fração é aplicada à área. Em uma arena 60 × 60 cm, 25% resulta em centro 30 × 30 cm.</p></div>
                  <div className="center-explanation"><strong>Animal em pé ou parcialmente visível</strong><p>As paredes ficam dentro do enquadramento do modelo. Cada ponto visível é preservado separadamente; partes ocultas não são inventadas. Estas áreas 2D não confirmam rearing nem recuperam profundidade.</p></div>
                  <div className={arenaError || !regionsConfirmed ? "validation-box invalid" : "validation-box valid"}>{arenaError || !regionsConfirmed ? <Info size={16} /> : <CheckCircle2 size={16} />}<span>{arenaError || (!regionsConfirmed ? "Confirme a borda e o chão antes de continuar." : "Borda e chão confirmados. Medidas calibradas pelo piso.")}</span></div>
                </aside>
              </div>
            </div>
          )}

          {step === 3 && video && (
            <div className="wizard-section review-step">
              <div className="wizard-section-heading"><div className="section-icon"><CheckCircle2 size={21} /></div><div><h2>Revise antes de criar</h2><p>Você poderá alterar estes parâmetros em uma nova revisão.</p></div></div>
              <div className="review-summary">
                <div><span>Protocolo</span><strong>Campo aberto</strong><small>Um animal · câmera fixa</small></div>
                <div><span>Sujeito</span><strong>{subjectId}</strong><small>{group || "Sem grupo informado"}</small></div>
                <div><span>Vídeo</span><strong>{video.filename}</strong><small>{formatDuration(video.durationSec)} · {video.width} × {video.height}</small></div>
                <div><span>Arena</span><strong>{arena.widthCm} × {arena.heightCm} cm</strong><small>Borda + chão confirmados · centro: {Math.round(arena.centerAreaFraction * 100)}% do piso</small></div>
                <div><span>Modelo de análise</span><strong>Wistar D+F · versão atual</strong><small>Referência anatômica: mouse_center</small></div>
              </div>
              <div className="review-contract"><div><Badge tone="info">Geometria 2D</Badge><h3>Dados que serão preservados</h3></div><ul><li><Check size={15} /> Metadados do vídeo e sistema de coordenadas</li><li><Check size={15} /> Oito vértices: borda e chão na resolução original</li><li><Check size={15} /> Recorte com paredes para o modelo; medidas físicas apenas no chão</li><li><Check size={15} /> Dados brutos e pontos visíveis, sem preenchimento de partes ocultas</li></ul></div>
            </div>
          )}

          <footer className="wizard-footer">
            <Button variant="ghost" onClick={() => step === 0 ? setProtocolSelected(false) : setStep(step - 1)} icon={<ArrowLeft size={17} />}>{step === 0 ? "Alterar protocolo" : "Voltar"}</Button>
            {step < 3 ? (
              <Button disabled={!canContinue} loading={checkingBundle} onClick={() => void continueWizard()}>Continuar <ArrowRight size={17} /></Button>
            ) : (
              <Button disabled={Boolean(arenaError) || !regionsConfirmed} onClick={createExperiment} icon={<Check size={17} />}>Criar e abrir editor</Button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}
