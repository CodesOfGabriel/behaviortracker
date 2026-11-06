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
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { defaultArena, DEMO_VIDEO_HEIGHT, DEMO_VIDEO_WIDTH } from "../../lib/demo-data";
import { centerPolygonPx, pointsToSvg, validateArenaCorners } from "../../lib/geometry";
import { formatBytes, formatDuration } from "../../lib/format";
import { useAppStore } from "../../store/AppStore";
import type { ArenaConfig, Experiment, Point, VideoAsset, VideoMetadata } from "../../types";

const STEPS = [
  { label: "Experimento", helper: "Protocolo e sujeito" },
  { label: "Vídeo", helper: "Arquivo e metadados" },
  { label: "Arena", helper: "Calibração espacial" },
  { label: "Revisão", helper: "Conferência final" },
];

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
  return { frameDataUrl: canvas.toDataURL("image/jpeg", 0.9), timeSec };
}

function ArenaPreview({
  metadata,
  frameDataUrl,
  arena,
  onChange,
}: {
  metadata: VideoMetadata;
  frameDataUrl?: string;
  arena: ArenaConfig;
  onChange: (corners: ArenaConfig["cornersPx"]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const center = useMemo(() => {
    try {
      return centerPolygonPx(arena);
    } catch {
      return [];
    }
  }, [arena]);

  const pointFromEvent = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(metadata.width, ((event.clientX - rect.left) / rect.width) * metadata.width)),
      y: Math.max(0, Math.min(metadata.height, ((event.clientY - rect.top) / rect.height) * metadata.height)),
    };
  };

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragging == null) return;
    const next = [...arena.cornersPx] as ArenaConfig["cornersPx"];
    next[dragging] = pointFromEvent(event);
    onChange(next);
  };

  return (
    <div className="arena-editor-frame">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${metadata.width} ${metadata.height}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={move}
        onPointerUp={(event) => {
          if (dragging != null) event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(null);
        }}
        onPointerCancel={() => setDragging(null)}
        aria-label="Editor dos vértices da arena"
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
        <polygon points={pointsToSvg(arena.cornersPx)} fill="#d7f169" fillOpacity=".08" stroke="#d7f169" strokeWidth={Math.max(3, metadata.width / 420)} />
        {center.length === 4 && (
          <polygon points={pointsToSvg(center)} fill="#70d6ad" fillOpacity=".16" stroke="#70d6ad" strokeWidth={Math.max(2, metadata.width / 650)} strokeDasharray="12 8" />
        )}
        {arena.cornersPx.map((point, index) => (
          <g
            key={index}
            className="arena-handle"
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
              setDragging(index);
            }}
            transform={`translate(${point.x} ${point.y})`}
          >
            <circle r={metadata.width / 90} fill="#fff" stroke="#153c32" strokeWidth={metadata.width / 360} />
            <circle r={metadata.width / 220} fill="#153c32" />
            <text y={-metadata.width / 55} textAnchor="middle" fontSize={metadata.width / 58} fontWeight="700" fill="#fff">
              {index + 1}
            </text>
          </g>
        ))}
      </svg>
      <div className="arena-legend">
        <span><i className="legend-arena" /> Piso da arena</span>
        <span><i className="legend-center" /> Centro ({Math.round(arena.centerAreaFraction * 100)}% da área)</span>
      </div>
    </div>
  );
}

export function NewExperiment() {
  const { navigate, saveExperiment } = useAppStore();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [group, setGroup] = useState("");
  const [notes, setNotes] = useState("");
  const [video, setVideo] = useState<VideoMetadata | null>(null);
  const [asset, setAsset] = useState<VideoAsset>({});
  const [arena, setArena] = useState<ArenaConfig>(defaultArena);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [capturingFrame, setCapturingFrame] = useState(false);
  const [frameCandidateSec, setFrameCandidateSec] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const arenaError = useMemo(
    () => validateArenaCorners(arena.cornersPx) || (arena.widthCm <= 0 || arena.heightCm <= 0 ? "Informe dimensões físicas positivas." : null),
    [arena],
  );

  const canContinue = [Boolean(subjectId.trim()), Boolean(video), !arenaError, true][step];

  const loadDemo = () => {
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
    setVideoError(null);
  };

  const handleVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setLoadingVideo(true);
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
      if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
      setVideo(metadata);
      setAsset({ objectUrl, frameDataUrl: captured.frameDataUrl, frameTimeSec: captured.timeSec, file });
      setFrameCandidateSec(captured.timeSec);
      setArena((current) => ({ ...current, cornersPx: initialCorners(metadata.width, metadata.height) }));
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
      setAsset((current) => ({ ...current, frameDataUrl: captured.frameDataUrl, frameTimeSec: captured.timeSec }));
      setVideo((current) => current ? { ...current, calibrationFrameSec: captured.timeSec } : current);
      setFrameCandidateSec(captured.timeSec);
    } catch (error) {
      setFrameError(error instanceof Error ? error.message : "Não foi possível capturar esse frame.");
    } finally {
      setCapturingFrame(false);
    }
  };

  const createExperiment = () => {
    if (!video || arenaError) return;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const experiment: Experiment = {
      id,
      schemaVersion: "1.0",
      analysisMethodVersion: "oft-0.1",
      title: title.trim() || `Campo aberto · ${subjectId.trim()}`,
      subjectId: subjectId.trim(),
      group: group.trim() || undefined,
      notes: notes.trim() || undefined,
      testType: "open_field",
      status: "draft",
      createdAt: now,
      updatedAt: now,
      video,
      arena,
      referencePoint: "body_center",
      corrections: [],
    };
    saveExperiment(experiment, asset);
    navigate({ name: "editor", experimentId: id });
  };

  return (
    <div className="page wizard-page">
      <button className="back-link" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16} /> Voltar aos experimentos</button>
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
              <div className="protocol-card selected">
                <div className="protocol-visual"><span className="protocol-mouse" /></div>
                <div><Badge tone="success">MVP</Badge><h3>Teste de campo aberto</h3><p>Um rato, câmera fixa e uma única arena.</p></div>
                <CheckCircle2 size={21} />
              </div>
              <div className="form-grid">
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
                  <h3>{loadingVideo ? "Lendo metadados…" : "Selecione um vídeo"}</h3>
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
                  <div className="video-file-info"><Badge tone="success" dot>Arquivo lido</Badge><h3>{video.filename}</h3><p>{formatBytes(video.sizeBytes)} · {formatDuration(video.durationSec)} · {video.width} × {video.height}</p><small>FPS e timestamps precisos serão confirmados pelo ffprobe no backend desktop.</small></div>
                  <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>Trocar</Button>
                </div>
              )}
              {videoError && <div className="form-error">{videoError}</div>}
              <div className="privacy-note"><Info size={16} /><span>O frame foi extraído apenas para a calibração. Ao reabrir o projeto, o app solicitará o arquivo se o caminho não estiver mais disponível.</span></div>
            </div>
          )}

          {step === 2 && video && (
            <div className="wizard-section arena-step">
              <div className="wizard-section-heading"><div className="section-icon"><MousePointer2 size={21} /></div><div><h2>Delimite o piso da arena</h2><p>Arraste os marcadores na ordem: superior esquerdo, superior direito, inferior direito e inferior esquerdo.</p></div></div>
              <div className="arena-layout">
                <div className="arena-frame-column">
                  <ArenaPreview metadata={video} frameDataUrl={asset.frameDataUrl} arena={arena} onChange={(cornersPx) => setArena((current) => ({ ...current, cornersPx }))} />
                  {asset.objectUrl && (
                    <div className="arena-frame-picker">
                      <div className="arena-frame-picker-title">
                        <Camera size={16} />
                        <div><strong>Frame de referência</strong><span>Escolha um momento em que os limites do piso estejam visíveis.</span></div>
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
                  <label><span>Área central</span><select value={arena.centerAreaFraction} onChange={(event) => setArena((current) => ({ ...current, centerAreaFraction: Number(event.target.value) }))}><option value={0.25}>25% da área</option><option value={0.36}>36% da área</option><option value={0.49}>49% da área</option></select></label>
                  <div className="center-explanation"><strong>Centro geométrico</strong><p>A fração é aplicada à área. Em uma arena 60 × 60 cm, 25% resulta em centro 30 × 30 cm.</p></div>
                  <div className={arenaError ? "validation-box invalid" : "validation-box valid"}>{arenaError ? <Info size={16} /> : <CheckCircle2 size={16} />}<span>{arenaError || "Geometria válida e pronta para salvar."}</span></div>
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
                <div><span>Arena</span><strong>{arena.widthCm} × {arena.heightCm} cm</strong><small>Centro: {Math.round(arena.centerAreaFraction * 100)}% da área</small></div>
              </div>
              <div className="review-contract"><div><Badge tone="info">Contrato v1.0</Badge><h3>Dados que serão preservados</h3></div><ul><li><Check size={15} /> Metadados do vídeo e sistema de coordenadas</li><li><Check size={15} /> Quatro vértices na resolução original</li><li><Check size={15} /> Definição explícita de centro e unidades</li><li><Check size={15} /> Revisões futuras sem sobrescrever dados brutos</li></ul></div>
            </div>
          )}

          <footer className="wizard-footer">
            <Button variant="ghost" onClick={() => step === 0 ? navigate({ name: "dashboard" }) : setStep(step - 1)} icon={<ArrowLeft size={17} />}>{step === 0 ? "Cancelar" : "Voltar"}</Button>
            {step < 3 ? (
              <Button disabled={!canContinue} onClick={() => setStep(step + 1)}>Continuar <ArrowRight size={17} /></Button>
            ) : (
              <Button onClick={createExperiment} icon={<Check size={17} />}>Criar e abrir editor</Button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}

