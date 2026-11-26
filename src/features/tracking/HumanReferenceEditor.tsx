import { SelectMenu } from "../../components/ui/SelectMenu";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent } from "react";
import { Button } from "../../components/ui/Button";
import { downloadText } from "../../lib/csv";
import { humanReferenceCsv, parseValidationPilot, type HumanAnnotation, type HumanAnnotationRevision, type ValidationPilot } from "../../lib/validation";
import { useAppStore } from "../../store/AppStore";
import { isTauriRuntime } from "../colab/connection";

const visibilityLabels = {
  visible: "Visível",
  occluded: "Ocluso",
  not_visible: "Fora de vista",
  uncertain: "Incerto",
} as const;
type Visibility = keyof typeof visibilityLabels;

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function HumanReferenceEditor({ experimentId }: { experimentId: string }) {
  const { getExperiment, assets, navigate } = useAppStore();
  const experiment = getExperiment(experimentId);
  const asset = assets[experimentId];
  const [pilot, setPilot] = useState<ValidationPilot | null>(null);
  const [file, setFile] = useState<File | null>(asset?.file ?? null);
  const [videoUrl, setVideoUrl] = useState<string | null>(asset?.objectUrl ?? null);
  const [videoSha, setVideoSha] = useState<string | null>(null);
  const [hashing, setHashing] = useState(false);
  const [rows, setRows] = useState<HumanAnnotation[]>([]);
  const [mode, setMode] = useState("frames");
  const [framePosition, setFramePosition] = useState(0);
  const [frameConfirmed, setFrameConfirmed] = useState(false);
  const [animalId, setAnimalId] = useState("animal_1");
  const [keypoint, setKeypoint] = useState("mouse_center");
  const [customKeypoint, setCustomKeypoint] = useState(false);
  const keypoints = ["body_center", "mouse_center", "box_center", "nose", "tail_base", "left_ear", "right_ear"];
  const [annotatorId, setAnnotatorId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("visible");
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const seekRevision = useRef(0);

  useEffect(() => {
    if (!file || file === asset?.file) { setVideoUrl(asset?.objectUrl ?? null); return; }
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, asset?.file, asset?.objectUrl]);

  useEffect(() => {
    if (!file) { setVideoSha(null); return; }
    let active = true;
    setHashing(true); setVideoSha(null);
    void file.arrayBuffer().then(buffer => crypto.subtle.digest("SHA-256", buffer)).then(digest => {
      if (!active) return;
      const actual = hex(digest);
      if (experiment?.video.sha256 && actual !== experiment.video.sha256.toLowerCase()) {
        setMessage("O SHA-256 do vídeo selecionado difere do original deste experimento.");
      } else { setVideoSha(actual); setMessage("Vídeo identificado por SHA-256."); }
    }).catch(() => { if (active) setMessage("Não foi possível verificar o vídeo."); })
      .finally(() => { if (active) setHashing(false); });
    return () => { active = false; };
  }, [file, experiment?.video.sha256]);

  const recording = useMemo(() => !experiment || !file || !videoSha
    || (experiment.video.sha256 ? experiment.video.sha256.toLowerCase() !== videoSha
      : file.name !== experiment.video.filename || file.size !== experiment.video.sizeBytes)
    ? null : pilot?.recordings.find(item => item.videoSha256.toLowerCase() === videoSha
    && item.protocol === experiment.testType && item.width === experiment.video.width
    && item.height === experiment.video.height) ?? null,
    [pilot, videoSha, file, experiment?.testType, experiment?.video.width, experiment?.video.height,
      experiment?.video.filename, experiment?.video.sizeBytes]);
  const clip = mode === "frames" ? null : recording?.clips.find(item => String(item.clipIndex) === mode);
  const frames = clip?.frames ?? recording?.frames ?? [];
  const current = frames[framePosition];
  const timestampTolerance = experiment?.video.fps ? Math.max(.025, .55 / experiment.video.fps) : .05;

  useEffect(() => { setFramePosition(0); setFrameConfirmed(false); }, [mode, recording?.videoSha256]);
  useEffect(() => {
    if (!current || !videoRef.current) return;
    seekRevision.current += 1;
    setFrameConfirmed(false);
    videoRef.current.pause();
    videoRef.current.currentTime = current.timestampSec;
  }, [current?.frameIndex, current?.timestampSec, videoUrl]);

  useEffect(() => {
    if (!recording || !isTauriRuntime()) { setRows([]); return; }
    let active = true;
    void invoke<HumanAnnotation[]>("list_validation_annotations", {
      experimentId, videoSha256: recording.videoSha256,
    }).then(items => { if (active) setRows(items); })
      .catch(error => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, [experimentId, recording?.videoSha256]);

  const selected = rows.find(row => row.frameIndex === current?.frameIndex && row.animalId === animalId
    && row.keypoint === keypoint && row.annotatorId === annotatorId.trim());
  useEffect(() => {
    setPoint(selected?.visibility === "visible" && selected.xPx != null && selected.yPx != null
      ? { x: selected.xPx, y: selected.yPx } : null);
    setVisibility(selected?.visibility ?? "visible");
  }, [selected?.id, selected?.revision, current?.frameIndex, animalId, keypoint, annotatorId]);

  async function refresh() {
    if (!recording) return;
    setRows(await invoke<HumanAnnotation[]>("list_validation_annotations", {
      experimentId, videoSha256: recording.videoSha256,
    }));
  }

  async function importPilot(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    try { setPilot(parseValidationPilot(await selectedFile.text())); setMessage("Plano de amostragem carregado."); }
    catch (error) { setPilot(null); setMessage(String(error)); }
    event.target.value = "";
  }

  function confirmPresentedFrame() {
    const video = videoRef.current;
    if (!video || !current) return;
    const revision = seekRevision.current;
    if (video.videoWidth !== recording?.width || video.videoHeight !== recording?.height) {
      setFrameConfirmed(false); setMessage("Dimensões do vídeo não correspondem ao manifesto."); return;
    }
    if (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && Math.abs(video.currentTime - current.timestampSec) <= timestampTolerance) {
      setFrameConfirmed(true);
    } else if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback((_now, metadata) => {
        if (revision === seekRevision.current) setFrameConfirmed(Math.abs(metadata.mediaTime - current.timestampSec) <= timestampTolerance);
      });
    } else if (revision === seekRevision.current) setFrameConfirmed(Math.abs(video.currentTime - current.timestampSec) <= timestampTolerance);
  }

  function placePoint(event: PointerEvent<SVGSVGElement>) {
    if (!recording || !frameConfirmed || visibility !== "visible") return;
    const matrix = overlayRef.current?.getScreenCTM();
    if (!matrix) return;
    const pixel = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    setPoint({ x: Math.max(0, Math.min(recording.width, pixel.x)),
      y: Math.max(0, Math.min(recording.height, pixel.y)) });
  }

  async function save(submitForReview: boolean) {
    if (!recording || !current || !frameConfirmed || !annotatorId.trim() || !animalId.trim() || !keypoint.trim()) return;
    if (visibility === "visible" && !point) { setMessage("Marque o ponto no vídeo antes de salvar."); return; }
    setBusy(true);
    try {
      await invoke("save_validation_annotation", { annotation: {
        id: selected?.id ?? crypto.randomUUID(), experimentId, videoSha256: recording.videoSha256,
        frameIndex: current.frameIndex, timestampSec: current.timestampSec, animalId: animalId.trim(),
        keypoint: keypoint.trim(), xPx: visibility === "visible" ? point?.x : null,
        yPx: visibility === "visible" ? point?.y : null, visibility,
        annotatorId: annotatorId.trim(), submitForReview, expectedRevision: selected?.revision ?? null,
      } });
      await refresh();
      setMessage(submitForReview ? "Anotação enviada para revisão." : "Rascunho salvo. Resultado original preservado.");
    } catch (error) { try { await refresh(); } catch { /* A mensagem original é prioritária. */ } setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function review(approved: boolean) {
    if (!selected || !reviewerId.trim() || !frameConfirmed) return;
    setBusy(true);
    try {
      await invoke("review_validation_annotation", { id: selected.id, reviewerId: reviewerId.trim(),
        approved, expectedRevision: selected.revision });
      await refresh();
      setMessage(approved ? "Referência humana aprovada." : "Anotação rejeitada.");
    } catch (error) { try { await refresh(); } catch { /* A mensagem original é prioritária. */ } setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function exportHistory() {
    if (!recording) return;
    try {
      const revisions = await invoke<HumanAnnotationRevision[]>("list_validation_annotation_history", {
        experimentId, videoSha256: recording.videoSha256,
      });
      downloadText(`human-reference-history-${recording.videoId}.json`,
        JSON.stringify({ schemaVersion: 1, videoSha256: recording.videoSha256, revisions }, null, 2), "application/json");
    } catch (error) { setMessage(String(error)); }
  }

  if (!experiment) return <div className="page not-found"><h1>Experimento não encontrado</h1></div>;
  return <div className="page validation-page">
    <button className="back-link" onClick={() => navigate({ name: "results", experimentId })}>← Resultados</button>
    <section className="page-heading"><div><div className="eyebrow">Validação científica · referência humana</div>
      <h1>{experiment.title}</h1><p>Anote o vídeo sem sobreposição das previsões automáticas. As correções e métricas existentes ficam separadas.</p></div></section>
    <section className="panel validation-setup">
      <label>Plano de amostragem JSON <input type="file" accept=".json,application/json" onChange={event => void importPilot(event)} /></label>
      <label>Vídeo original <input type="file" accept="video/*" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
      {hashing && <span>Verificando SHA-256 do vídeo…</span>}
      {videoSha && <small>SHA-256: {videoSha}</small>}
      {pilot && !recording && videoSha && <p>O nome, tamanho, hash, protocolo ou dimensões do vídeo não correspondem ao experimento e ao plano importado.</p>}
      {recording && <p>{recording.videoId} · {recording.protocol} · {recording.partition === "holdout" ? "teste independente" : "desenvolvimento"} · PTS obtido por FFprobe</p>}
    </section>
    {recording && <div className="validation-layout">
      <section className="panel">
        <div className="validation-controls">
          <SelectMenu label="Trecho" value={mode} onChange={setMode} options={[{value:"frames",label:`Frames do piloto (${recording.frames.length})`},...recording.clips.map(item=>({value:String(item.clipIndex),label:`Clipe ${item.clipIndex+1} · ${item.startSec.toFixed(1)}–${item.endSec.toFixed(1)} s`}))]}/>
          <Button variant="secondary" disabled={framePosition === 0} onClick={() => setFramePosition(index => index - 1)}>Frame anterior</Button>
          <Button variant="secondary" disabled={framePosition >= frames.length - 1} onClick={() => setFramePosition(index => index + 1)}>Próximo frame</Button>
          <span>Frame {current?.frameIndex ?? "—"} · {current?.timestampSec.toFixed(3) ?? "—"} s · {framePosition + 1}/{frames.length}</span>
        </div>
        <div className="validation-video-stage" style={{ aspectRatio: `${recording.width} / ${recording.height}` }}>
          {videoUrl && <video ref={videoRef} src={videoUrl} playsInline muted
            onLoadedMetadata={event => { event.currentTarget.currentTime = current?.timestampSec ?? 0; }}
            onLoadedData={confirmPresentedFrame} onSeeked={confirmPresentedFrame} />}
          <svg ref={overlayRef} viewBox={`0 0 ${recording.width} ${recording.height}`}
            preserveAspectRatio="xMidYMid meet" onPointerDown={placePoint} aria-label="Marcar ponto de referência humana">
            {point && visibility === "visible" && <circle cx={point.x} cy={point.y} r={Math.max(4, recording.width / 160)} fill="#f5c64d" stroke="#141a17" strokeWidth="2" />}
          </svg>
        </div>
        <p>{frameConfirmed ? "Frame apresentado confirmado no tempo PTS selecionado." : "Aguardando apresentação do frame selecionado. Anotação bloqueada."}</p>
      </section>
      <aside className="panel validation-form">
        <h2>Anotação independente</h2>
        <label>Identificador do anotador <input value={annotatorId} onChange={event => setAnnotatorId(event.target.value)} placeholder="observador_1" /></label>
        <label>Animal <input value={animalId} onChange={event => setAnimalId(event.target.value)} /></label>
        <SelectMenu label="Ponto" value={customKeypoint || !keypoints.includes(keypoint) ? "custom" : keypoint}
          onChange={value=>{setCustomKeypoint(value === "custom");if(value !== "custom")setKeypoint(value);}}
          options={[...keypoints.map(value=>({value,label:value})),{value:"custom",label:"Outro ponto…"}]}/>
        {(customKeypoint || !keypoints.includes(keypoint)) && <label>Nome do ponto <input value={keypoint} onChange={event=>setKeypoint(event.target.value)}/></label>}
        <small>Use uma definição fixa por protocolo. <code>box_center</code> é o centro geométrico de uma caixa; <code>body_center</code> é anatômico.</small>
        <SelectMenu label="Visibilidade" value={visibility} onChange={value=>{setVisibility(value as Visibility);setPoint(null);}} options={Object.entries(visibilityLabels).map(([value,label])=>({value,label}))}/>
        {visibility === "visible" ? <p>{point ? `x ${point.x.toFixed(1)} · y ${point.y.toFixed(1)} px` : "Clique no vídeo para marcar o ponto."}</p>
          : <p>Sem coordenada: a visibilidade ficará registrada sem inventar uma posição.</p>}
        <p>Status: <strong>{selected?.status ?? "não anotado"}</strong>{selected && ` · revisão ${selected.revision}`}</p>
        {rows.some(row => row.frameIndex === current?.frameIndex) && <div className="validation-observers"><strong>Anotações neste frame</strong>
          {rows.filter(row => row.frameIndex === current?.frameIndex).map(row => <button type="button" key={row.id}
            onClick={() => { setAnnotatorId(row.annotatorId); setAnimalId(row.animalId); setKeypoint(row.keypoint); }}>
            {row.annotatorId} · {row.animalId} · {row.keypoint} · {row.status}
          </button>)}</div>}
        <div className="validation-actions"><Button disabled={busy || !frameConfirmed || !annotatorId.trim()} onClick={() => void save(false)}>Salvar rascunho</Button>
          <Button disabled={busy || !frameConfirmed || !annotatorId.trim()} onClick={() => void save(true)}>Enviar para revisão</Button></div>
        <label>Identificador do revisor <input value={reviewerId} onChange={event => setReviewerId(event.target.value)} placeholder="revisor_1" /></label>
        <div className="validation-actions"><Button disabled={busy || !frameConfirmed || !reviewerId.trim() || reviewerId.trim() === selected?.annotatorId || selected?.status !== "submitted"} onClick={() => void review(true)}>Aprovar</Button>
          <Button variant="secondary" disabled={busy || !frameConfirmed || !reviewerId.trim() || reviewerId.trim() === selected?.annotatorId || selected?.status !== "submitted"} onClick={() => void review(false)}>Rejeitar</Button></div>
        <p>{rows.length} anotações neste vídeo · {rows.filter(row => row.status === "approved").length} aprovadas. Dois observadores podem anotar o mesmo frame; o comparador exigirá escolha explícita quando houver duplicatas.</p>
        <div className="validation-actions"><Button variant="secondary" disabled={!rows.length} onClick={() => downloadText(`human-reference-${recording.videoId}.csv`, humanReferenceCsv(rows), "text/csv;charset=utf-8")}>Exportar CSV</Button>
          <Button variant="secondary" disabled={!rows.length} onClick={() => downloadText(`human-reference-${recording.videoId}.json`, JSON.stringify({ schemaVersion: 1, recording, annotations: rows }, null, 2), "application/json")}>Exportar JSON</Button>
          <Button variant="secondary" onClick={() => void exportHistory()}>Exportar histórico</Button></div>
      </aside>
    </div>}
    {message && <p role="status" className="validation-message">{message}</p>}
    {!isTauriRuntime() && <p>Salvamento de referências humanas disponível no aplicativo desktop.</p>}
  </div>;
}
