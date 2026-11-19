import { useRef, useState, type ChangeEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowRight, Info, UploadCloud } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { formatBytes, formatDuration } from "../../lib/format";
import { ARM_IDS, newGeometryRevision, validateRadialArea, validateRadialCup, validateRadialCups, validateRadialGeometry, validateRadialRewards, walkableMaskVersion } from "../../lib/radial-maze/geometry";
import { validateVisitPolicy } from "../../lib/radial-maze/events";
import { useAppStore } from "../../store/AppStore";
import type { ArmId, Point, RadialArm, RadialMazeExperiment, RadialMazeGeometry, RamVisitPolicy, VideoAsset, VideoMetadata } from "../../types";
import { captureVideoFrame, openVideo } from "./OpenFieldExperimentWizard";

type Target = "walkable" | `cup-${ArmId}`;
const areaTargets: Target[] = ["walkable"];
const cupTargets: Target[] = ARM_IDS.map(id => `cup-${id}` as Target);
const geometryPhases = ["Área do labirinto", "Potes", "Recompensas"] as const;
const initialArms = (): RadialArm[] => ARM_IDS.map(id => ({ id, polygonPx: [], cupPolygonPx: [], entryGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }], distalGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }], baited: false }));
const initialGeometry = (): RadialMazeGeometry => ({ revision: 1, walkablePolygonPx: [], centerPolygonPx: [], arms: initialArms(), walkableMaskVersion: "ram-walkable-polygon-1", referenceFrameSec: 0 });
const editableGeometry = (existing?: RadialMazeExperiment): RadialMazeGeometry => existing?.geometry.walkablePolygonPx !== undefined
  ? existing.geometry : existing ? { ...existing.geometry, walkablePolygonPx: [], centerPolygonPx: [], arms: existing.geometry.arms.map(arm => ({ ...arm, polygonPx: [], entryGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }], distalGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }] })) }
    : initialGeometry();
const initialPolicy: RamVisitPolicy = { minimumArmDwellSec: 0.25, minimumCenterDwellSec: 0.25, minimumDistalDwellSec: 0.25,
  unknownGapToleranceSec: 0, choiceCriterion: "arm_entry" };
function points(geometry: RadialMazeGeometry, target: Target): Point[] {
  if (target === "walkable") return geometry.walkablePolygonPx ?? [];
  return geometry.arms.find(item => item.id === Number(target.split("-")[1]))!.cupPolygonPx;
}
function setPoints(geometry: RadialMazeGeometry, target: Target, next: Point[]): RadialMazeGeometry {
  if (target === "walkable") return { ...geometry, walkablePolygonPx: next };
  return { ...geometry, arms: geometry.arms.map(arm => arm.id === Number(target.split("-")[1]) ? { ...arm, cupPolygonPx: next } : arm) };
}
function targetComplete(geometry: RadialMazeGeometry, target: Target) {
  return points(geometry, target).length >= 3;
}
function targetLabel(target: Target) {
  return target === "walkable" ? "Toda a área do labirinto" : `Pote P${target.split("-")[1]}`;
}
function cupSide(polygon: Point[], video: VideoMetadata): number {
  if (!polygon.length) return Math.max(8, Math.round(Math.min(video.width, video.height) * 0.04));
  return Math.round(Math.max(
    Math.max(...polygon.map(point => point.x)) - Math.min(...polygon.map(point => point.x)),
    Math.max(...polygon.map(point => point.y)) - Math.min(...polygon.map(point => point.y)),
  ));
}
function squareCup(center: Point, requestedSide: number, video: VideoMetadata): Point[] {
  const side = Math.max(4, Math.min(Math.round(requestedSide), video.width, video.height));
  const x = Math.max(0, Math.min(Math.round(center.x - side / 2), video.width - side));
  const y = Math.max(0, Math.min(Math.round(center.y - side / 2), video.height - side));
  return [{ x, y }, { x: x + side, y }, { x: x + side, y: y + side }, { x, y: y + side }];
}
function cupCenter(polygon: Point[]): Point {
  return {
    x: (Math.min(...polygon.map(point => point.x)) + Math.max(...polygon.map(point => point.x))) / 2,
    y: (Math.min(...polygon.map(point => point.y)) + Math.max(...polygon.map(point => point.y))) / 2,
  };
}
type CupDrag = { pointerId: number; target: Target; mode: "move" | "resize"; side: number; offset: Point; anchor: Point };

export function RadialArmMazeExperimentWizard({ onBack, onComplete = () => {}, existing }: { onBack: () => void; onComplete?: () => void; existing?: RadialMazeExperiment }) {
  const { saveExperiment, navigate, assets } = useAppStore();
  const [id] = useState(() => existing?.id ?? crypto.randomUUID());
  const [step, setStep] = useState(existing ? 2 : 0);
  const [title, setTitle] = useState(existing?.title ?? ""); const [subjectId, setSubjectId] = useState(existing?.subjectId ?? "");
  const [group, setGroup] = useState(existing?.group ?? ""); const [notes, setNotes] = useState(existing?.notes ?? "");
  const [video, setVideo] = useState<VideoMetadata | null>(existing?.video ?? null);
  const [frameSec, setFrameSec] = useState(existing?.geometry.referenceFrameSec ?? 0);
  const [asset, setAsset] = useState<VideoAsset>(assets[existing?.id ?? ""] ?? { frameDataUrl: existing?.calibrationThumbnailDataUrl,
    thumbnailDataUrl: existing?.calibrationThumbnailDataUrl });
  const [geometry, setGeometry] = useState<RadialMazeGeometry>(() => editableGeometry(existing));
  const [policy, setPolicy] = useState<RamVisitPolicy>(existing?.visitPolicy ?? initialPolicy);
  const [geometryPhase, setGeometryPhase] = useState(0);
  const [furthestGeometryPhase, setFurthestGeometryPhase] = useState(0);
  const [target, setTarget] = useState<Target>("walkable");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cupDrag = useRef<CupDrag | null>(null);
  const geometryError = video ? validateRadialGeometry(geometry, video.width, video.height) : "Selecione um vídeo.";
  const policyError = validateVisitPolicy(policy);
  const phaseTargets = geometryPhase === 0 ? areaTargets : geometryPhase === 1 ? cupTargets : [];
  const phaseError = video ? geometryPhase === 0 ? validateRadialArea(geometry, video.width, video.height)
    : geometryPhase === 1 ? validateRadialCups(geometry, video.width, video.height)
    : geometryPhase === 2 ? validateRadialCups(geometry, video.width, video.height) || validateRadialRewards(geometry)
    : geometryError : "Selecione um vídeo.";
  const targetPoints = points(geometry, target);
  const targetDone = targetComplete(geometry, target);
  const selectedCupSide = video ? cupSide(targetPoints, video) : 8;
  const resizeHandleSize = video ? Math.max(5, Math.min(Math.max(12, video.width / 90), selectedCupSide / 2)) : 5;
  const selectedCupError = video && geometryPhase === 1 ? validateRadialCup(geometry, Number(target.split("-")[1]) as ArmId, video.width, video.height) : null;
  const markedTargets = phaseTargets.filter(item => targetComplete(geometry, item)).length;
  const rewardCount = geometry.arms.filter(arm => arm.baited).length;

  const showGeometryPhase = (next: number) => {
    setGeometryPhase(next);
    setFurthestGeometryPhase(current => Math.max(current, next));
    setTarget(current => next === 0 ? "walkable" : current === "walkable" ? cupTargets[0] : current);
  };

  const selectVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true); setError("");
    const url = URL.createObjectURL(file);
    try {
      const element = await openVideo(url);
      const at = Number.isFinite(element.duration) ? Math.min(element.duration * 0.2, Math.max(0, element.duration - 0.05)) : 0;
      const captured = await captureVideoFrame(element, at);
      if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
      setAsset({ objectUrl: url, file, frameDataUrl: captured.frameDataUrl, thumbnailDataUrl: captured.thumbnailDataUrl, frameTimeSec: captured.timeSec });
      setVideo({ filename: file.name, sizeBytes: file.size, width: element.videoWidth, height: element.videoHeight,
        durationSec: element.duration, fps: null, timingSource: "browser-estimate", calibrationFrameSec: captured.timeSec, lastModified: file.lastModified });
      setFrameSec(captured.timeSec);
      setGeometry({ ...initialGeometry(), referenceFrameSec: captured.timeSec });
      setGeometryPhase(0); setFurthestGeometryPhase(0); setTarget("walkable");
    } catch (reason) { URL.revokeObjectURL(url); setError(String(reason)); }
    finally { setBusy(false); event.target.value = ""; }
  };
  const captureFrame = async () => {
    if (!asset.objectUrl || !video) return;
    setBusy(true); setError("");
    try {
      const captured = await captureVideoFrame(await openVideo(asset.objectUrl), frameSec);
      setAsset(current => ({ ...current, frameDataUrl: captured.frameDataUrl, thumbnailDataUrl: captured.thumbnailDataUrl, frameTimeSec: captured.timeSec }));
      setVideo(current => current ? { ...current, calibrationFrameSec: captured.timeSec } : current);
      setGeometry(current => ({ ...current, referenceFrameSec: captured.timeSec, revision: current.revision + 1 }));
      setFrameSec(captured.timeSec);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const framePoint = (clientX: number, clientY: number, clampToFrame = false): Point | null => {
    const svg = svgRef.current; if (!svg || !video) return null;
    const matrix = svg.getScreenCTM(); if (!matrix) return null;
    const position = svg.createSVGPoint(); position.x = clientX; position.y = clientY;
    const raw = position.matrixTransform(matrix.inverse());
    if (!clampToFrame && (raw.x < 0 || raw.y < 0 || raw.x > video.width || raw.y > video.height)) return null;
    return { x: Math.max(0, Math.min(raw.x, video.width)), y: Math.max(0, Math.min(raw.y, video.height)) };
  };
  const handleFrameClick = (event: MouseEvent<SVGSVGElement>) => {
    if (geometryPhase !== 0) return;
    const point = framePoint(event.clientX, event.clientY); if (!point) return;
    setGeometry(current => setPoints(current, "walkable", [...points(current, "walkable"), { x: Math.round(point.x), y: Math.round(point.y) }]));
  };
  const startCupDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (geometryPhase !== 1 || !video || event.button !== 0) return;
    const point = framePoint(event.clientX, event.clientY); if (!point) return;
    const element = event.target as Element;
    const cupId = element.getAttribute("data-cup-id") ?? element.getAttribute("data-resize-cup-id");
    const dragTarget = cupId ? `cup-${cupId}` as Target : target;
    const existingCup = points(geometry, dragTarget);
    const resizing = element.hasAttribute("data-resize-cup-id") && existingCup.length >= 3;
    const center = existingCup.length >= 3 ? cupCenter(existingCup) : point;
    const side = cupSide(existingCup, video);
    if (cupId) setTarget(dragTarget);
    if (!cupId || !existingCup.length) setGeometry(current => setPoints(current, dragTarget, squareCup(point, side, video)));
    cupDrag.current = { pointerId: event.pointerId, target: dragTarget, mode: resizing ? "resize" : "move", side,
      offset: cupId && !resizing ? { x: point.x - center.x, y: point.y - center.y } : { x: 0, y: 0 },
      anchor: existingCup.length >= 3 ? { x: Math.min(...existingCup.map(p => p.x)), y: Math.min(...existingCup.map(p => p.y)) } : point };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveCupDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = cupDrag.current;
    if (!drag || drag.pointerId !== event.pointerId || !video) return;
    const point = framePoint(event.clientX, event.clientY, true); if (!point) return;
    const polygon = drag.mode === "move"
      ? squareCup({ x: point.x - drag.offset.x, y: point.y - drag.offset.y }, drag.side, video)
      : (() => {
        const side = Math.max(4, Math.min(Math.round(Math.max(point.x - drag.anchor.x, point.y - drag.anchor.y)),
          video.width - drag.anchor.x, video.height - drag.anchor.y));
        const x = drag.anchor.x, y = drag.anchor.y;
        return [{ x, y }, { x: x + side, y }, { x: x + side, y: y + side }, { x, y: y + side }];
      })();
    setGeometry(current => setPoints(current, drag.target, polygon));
  };
  const endCupDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (cupDrag.current?.pointerId !== event.pointerId) return;
    cupDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeCup = (side: number) => {
    if (!video || !targetPoints.length || !Number.isFinite(side)) return;
    const center = cupCenter(targetPoints);
    setGeometry(current => setPoints(current, target, squareCup(center, side, video)));
  };
  const nextTarget = () => {
    const following = cupTargets[cupTargets.indexOf(target) + 1];
    if (following) { setTarget(following); return; }
    const missing = cupTargets.find(item => !targetComplete(geometry, item));
    if (missing) { setTarget(missing); return; }
    showGeometryPhase(2);
  };
  const toggleReward = (id: ArmId) => {
    setGeometry(current => {
      const selected = current.arms.filter(arm => arm.baited).length;
      return { ...current, arms: current.arms.map(arm => arm.id === id && (arm.baited || selected < 4) ? { ...arm, baited: !arm.baited } : arm) };
    });
  };
  const create = async () => {
    if (!video || !title.trim() || !subjectId.trim() || geometryError || policyError) return;
    setBusy(true); setError("");
    try {
      const now = new Date().toISOString();
      const version = await walkableMaskVersion(geometry);
      const experiment: RadialMazeExperiment = existing ? { ...existing, title: title.trim(), subjectId: subjectId.trim(), group: group.trim() || undefined,
        notes: notes.trim() || undefined, updatedAt: now, ...newGeometryRevision(existing, { ...geometry, walkableMaskVersion: version }), visitPolicy: policy }
      : { id, schemaVersion: "1.0", analysisMethodVersion: "ram-1.0", analysisEngine: "wistar_ram_hybrid_v1",
        modelBundleId: "wistar_df_v2", testType: "radial_arm_maze", status: "draft", title: title.trim(), subjectId: subjectId.trim(),
        group: group.trim() || undefined, notes: notes.trim() || undefined, createdAt: now, updatedAt: now,
        video, calibrationThumbnailDataUrl: asset.thumbnailDataUrl, geometry: { ...geometry, walkableMaskVersion: version }, visitPolicy: policy, corrections: [] };
      saveExperiment(experiment, existing ? assets[existing.id] : asset); onComplete(); navigate({ name: "results", experimentId: id });
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <div className="page wizard-page fst-wizard ram-wizard">
    <button className="back-link" onClick={() => step === 2 && geometryPhase > 0 ? showGeometryPhase(geometryPhase - 1) : step > (existing ? 2 : 0) ? setStep(step - 1) : onBack()}><ArrowLeft size={16} /> {step === 2 && geometryPhase > 0 || step > (existing ? 2 : 0) ? "Etapa anterior" : existing ? "Voltar ao experimento" : "Alterar protocolo"}</button>
    <section className="page-heading wizard-heading"><div><div className="eyebrow">{existing ? "Revisão de geometria" : "Novo experimento"} · Labirinto Radial</div><h1>{existing ? `Revisar ${existing.title}` : "Configurar labirinto radial"}</h1><p>Contorne uma vez toda a área do labirinto; depois marque os potes e as recompensas.</p></div></section>
    <ol className="wizard-steps">{["Experimento", "Vídeo", "Geometria", "Revisão"].map((name, i) => <li key={name} className={i === step ? "active" : i < step ? "done" : ""}><span>{i + 1}</span>{name}</li>)}</ol>
    {step === 0 && <section className="wizard-section ram-fields"><h2>Identificação da sessão</h2>
      <label>Nome do experimento<input value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>ID científico do animal<input value={subjectId} onChange={e => setSubjectId(e.target.value)} /></label>
      <label>Grupo experimental<input value={group} onChange={e => setGroup(e.target.value)} /></label>
      <label>Observações<textarea value={notes} onChange={e => setNotes(e.target.value)} /></label>
    </section>}
    {step === 1 && <section className="wizard-section"><h2>Vídeo original</h2><p>Use o vídeo da sessão. A geometria será marcada em pixels do frame original.</p>
      <input ref={fileRef} type="file" accept="video/*,.mov" className="sr-only" onChange={selectVideo}/>
      <Button icon={<UploadCloud size={17}/>} disabled={busy} onClick={() => fileRef.current?.click()}>{video ? "Substituir vídeo" : "Selecionar vídeo"}</Button>
      {video && <p><strong>{video.filename}</strong> · {video.width} × {video.height} px · {formatDuration(video.durationSec)} · {formatBytes(video.sizeBytes)}</p>}
      {asset.objectUrl && <video className="fst-preview-video" controls src={asset.objectUrl}/>}
      {video && <div className="ram-frame-picker"><label>Frame de referência (s)<input type="number" min="0" max={Math.max(0, video.durationSec - 0.05)} step="0.1" value={frameSec} onChange={e => setFrameSec(Number(e.target.value))}/></label>
        <Button variant="secondary" disabled={busy || !Number.isFinite(frameSec) || frameSec < 0 || frameSec >= video.durationSec} onClick={() => void captureFrame()}>Capturar frame</Button></div>}
      {error && <p className="validation-box invalid"><Info size={16}/>{error}</p>}
    </section>}
    {step === 2 && video && <section className="wizard-section ram-geometry-section">
      <div className="ram-phase-heading"><div><small>Geometria · fase {geometryPhase + 1} de 3</small><h2>{geometryPhases[geometryPhase]}</h2>
        <p>{geometryPhase === 0 ? "Contorne toda a área transitável, incluindo centro e braços, em uma única marcação. Não é necessário desenhar cada braço separadamente." : geometryPhase === 1 ? "Clique para posicionar cada quadrado. Arraste para mover ou ajustar pelo canto branco. O quadrado pode passar da borda; somente a parte sobre o labirinto será considerada. Avance manualmente após cada pote." : "Marque os quatro potes que tinham recompensa nesta sessão. Os outros quatro serão registrados sem recompensa."}</p></div>
        <strong>{geometryPhase === 2 ? rewardCount : markedTargets} / {geometryPhase === 0 ? 1 : geometryPhase === 1 ? 8 : 4}</strong>
      </div>
      <nav className="ram-phase-nav" aria-label="Fases da geometria">{geometryPhases.map((name, index) => <button key={name} type="button" className={index === geometryPhase ? "active" : index < geometryPhase ? "done" : ""} disabled={index > furthestGeometryPhase} aria-current={index === geometryPhase ? "step" : undefined} onClick={() => showGeometryPhase(index)}><span>{index + 1}</span>{name}</button>)}</nav>
      {geometryPhase !== 2 && <div className="ram-target-controls"><div className="ram-current-target" aria-live="polite"><span>Marque agora</span><strong>{targetLabel(target)}</strong><small>{geometryPhase === 0 ? "Clique nos vértices do contorno, em sequência; use pelo menos três pontos." : "Arraste o quadrado para mover; arraste o canto branco para redimensionar."}</small></div>
        {geometryPhase === 0 && <Button variant="secondary" onClick={() => setGeometry(current => setPoints(current, target, points(current, target).slice(0, -1)))} disabled={!targetPoints.length}>Desfazer ponto</Button>}
        <Button variant="secondary" onClick={() => setGeometry(current => setPoints(current, target, []))} disabled={!targetPoints.length}>{geometryPhase === 0 ? "Refazer região" : "Remover pote"}</Button>
        {geometryPhase === 1 && <Button variant="secondary" onClick={nextTarget} disabled={!targetDone}>{target === cupTargets.at(-1) ? "Próximo: Recompensas" : "Próximo pote"}</Button>}</div>}
      {geometryPhase === 1 && <div className="ram-cup-size"><label htmlFor="ram-cup-side">Lado de {targetLabel(target)}</label><input id="ram-cup-side" type="range" min="4" max={Math.max(Math.round(Math.min(video.width, video.height) * 0.25), selectedCupSide)} step="1" value={selectedCupSide} disabled={!targetDone} onChange={event => resizeCup(Number(event.target.value))}/><output htmlFor="ram-cup-side">{selectedCupSide} px</output></div>}
      {geometryPhase === 1 && targetDone && selectedCupError && <p className="ram-cup-feedback" role="status">{selectedCupError} Arraste-o até sobrepor a área marcada.</p>}
      {geometryPhase === 1 && <div className="ram-region-list" aria-label="Potes">{phaseTargets.map(item => { const complete = targetComplete(geometry, item); const invalid = complete && !!validateRadialCup(geometry, Number(item.split("-")[1]) as ArmId, video.width, video.height); return <button key={item} type="button" className={item === target ? "active" : invalid ? "invalid" : complete ? "done" : ""} aria-pressed={item === target} onClick={() => setTarget(item)}><span>{targetLabel(item)}</span><small>{invalid ? "Ajustar posição/tamanho" : complete ? "Marcado" : "Não marcado"}</small></button>; })}</div>}
      {geometryPhase === 2 && <div className="ram-reward-grid" aria-label="Potes com recompensa">{geometry.arms.map(arm => <button key={arm.id} type="button" className={arm.baited ? "selected" : ""} aria-pressed={arm.baited} disabled={!arm.baited && rewardCount === 4} onClick={() => toggleReward(arm.id)}><strong>P{arm.id}</strong><span>Pote {arm.id} de 8</span><small>{arm.baited ? "Com recompensa" : "Sem recompensa"}</small></button>)}</div>}
      <svg ref={svgRef} className={geometryPhase === 2 ? "ram-geometry-editor ram-geometry-preview" : "ram-geometry-editor"} viewBox={`0 0 ${video.width} ${video.height}`} onClick={handleFrameClick} onPointerDown={startCupDrag} onPointerMove={moveCupDrag} onPointerUp={endCupDrag} onPointerCancel={endCupDrag} onLostPointerCapture={() => { cupDrag.current = null; }} role="img" aria-label={geometryPhase === 2 ? "Prévia do labirinto e dos potes" : `Frame para marcar ${targetLabel(target)}`}>
        {asset.frameDataUrl && <image href={asset.frameDataUrl} width={video.width} height={video.height}/>}
        {(geometry.walkablePolygonPx?.length ?? 0) >= 3 && <polygon points={geometry.walkablePolygonPx!.map(p => `${p.x},${p.y}`).join(" ")} className="ram-center-polygon" pointerEvents="none"/>}
        {geometry.arms.map(arm => <g key={arm.id}>
          {arm.cupPolygonPx.length >= 3 && <polygon data-cup-id={arm.id} pointerEvents={geometryPhase === 1 ? "all" : "none"} points={arm.cupPolygonPx.map(p => `${p.x},${p.y}`).join(" ")} className={`ram-cup-polygon${arm.baited ? " baited" : ""}${geometryPhase === 1 && target === `cup-${arm.id}` ? " active" : ""}`}/>}
          {arm.cupPolygonPx.length >= 3 && <text pointerEvents="none" x={arm.cupPolygonPx[0].x} y={arm.cupPolygonPx[0].y} className="ram-cup-label">P{arm.id}</text>}
        </g>)}
        {geometryPhase === 1 && targetDone && <rect data-resize-cup-id={target.split("-")[1]} x={Math.max(...targetPoints.map(point => point.x)) - resizeHandleSize / 2} y={Math.max(...targetPoints.map(point => point.y)) - resizeHandleSize / 2} width={resizeHandleSize} height={resizeHandleSize} className="ram-cup-resize-handle"/>}
        {geometryPhase === 0 && targetPoints.length > 0 && <g pointerEvents="none"><polyline points={targetPoints.map(p => `${p.x},${p.y}`).join(" ")} className="ram-active-line"/>
          {targetPoints.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={Math.max(4, video.width / 300)} className="ram-active-point"/>)}</g>}
      </svg>
      {phaseError && <p className="validation-box invalid"><Info size={16}/>{phaseError}{geometryPhase === 2 && validateRadialCups(geometry, video.width, video.height) && <Button variant="secondary" size="sm" onClick={() => { showGeometryPhase(1); const invalid = cupTargets.find(item => validateRadialCup(geometry, Number(item.split("-")[1]) as ArmId, video.width, video.height)); if (invalid) setTarget(invalid); }}>Corrigir pote</Button>}</p>}
    </section>}
    {step === 3 && <section className="wizard-section ram-fields"><h2>Critério de visita</h2><p>Estes limiares são configuráveis e precisam de calibração com anotações humanas antes de uso científico.</p>
      <label>Escolha válida<select value={policy.choiceCriterion} onChange={e => setPolicy(current => ({ ...current, choiceCriterion: e.target.value as RamVisitPolicy["choiceCriterion"] }))}><option value="arm_entry">Entrada no braço</option><option value="distal_reached">Alcance distal</option></select></label>
      {([ ["minimumArmDwellSec", "Permanência mínima no braço"], ["minimumCenterDwellSec", "Permanência mínima no centro"], ["minimumDistalDwellSec", "Permanência mínima na região distal"], ["unknownGapToleranceSec", "Tolerância a lacuna desconhecida"] ] as const).map(([key, label]) => <label key={key}>{label} (s)<input type="number" min="0" max="30" step="0.05" value={policy[key]} onChange={e => setPolicy(current => ({ ...current, [key]: Number(e.target.value) }))}/></label>)}
      <p>A área e os potes ficam salvos como preparação. Visitas por braço dependem de uma geometria própria e de tracking RAM validados para esta sessão antes do cálculo.</p>
      {(geometryError || policyError || error) && <p className="validation-box invalid"><Info size={16}/>{geometryError || policyError || error}</p>}
    </section>}
    <div className="wizard-footer">{step < 3 ? <Button disabled={step === 0 ? !title.trim() || !subjectId.trim() : step === 1 ? !video : step === 2 && geometryPhase === 1 ? markedTargets < 8 : !!phaseError} onClick={() => step === 2 && geometryPhase < 2 ? showGeometryPhase(geometryPhase + 1) : setStep(current => current + 1)}>{step === 2 ? geometryPhase < 2 ? `Continuar: ${geometryPhases[geometryPhase + 1]}` : "Continuar para revisão" : "Continuar"} <ArrowRight size={16}/></Button>
      : <Button disabled={busy || !!geometryError || !!policyError} onClick={() => void create()}>{busy ? "Salvando…" : existing ? "Salvar nova revisão" : "Salvar experimento de Labirinto Radial"}</Button>}</div>
  </div>;
}
