import { useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowRight, Check, FileVideo2, Info, LoaderCircle, UploadCloud } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { formatBytes, formatDuration } from "../../lib/format";
import { validateForcedSwim, validateTanks, FST_ENGINE, FST_VERSION } from "../../lib/fst";
import { useAppStore } from "../../store/AppStore";
import type { BoundingBox, ForcedSwimExperiment, TankConfig, VideoAsset, VideoMetadata } from "../../types";
import { prepareFstVideo } from "../colab/analysis";
import { preparedGeometry, scaleTanksToUpload } from "../colab/videoGeometry";
import { isTauriRuntime } from "../colab/connection";
import { captureVideoFrame, openVideo } from "./OpenFieldExperimentWizard";

const steps = ["Experimento", "Vídeo", "Cilindros", "Revisão"];

function initialTanks(subjects: string[]): TankConfig[] {
  return subjects.map((subjectId, i) => ({
    tankId: `tank_${i+1}`, animalId: `animal_${i+1}`, subjectId,
    roiPx: { x: 0, y: 0, width: 0, height: 0 }, revision: 1,
  }));
}

function RoiEditor({ frame, width, height, tanks, activeIndex, onChange, onComplete }: { frame?: string; width: number; height: number; tanks: TankConfig[]; activeIndex: number; onChange: (index: number, roi: BoundingBox) => void; onComplete: (index: number, roi: BoundingBox) => void }) {
  const drag = useRef<{ index: number; x: number; y: number } | null>(null);
  const point = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(width, Math.round((event.clientX-box.left)*width/box.width))),
      y: Math.max(0, Math.min(height, Math.round((event.clientY-box.top)*height/box.height))) };
  };
  const rectangle = (start: { x: number; y: number }, end: { x: number; y: number }): BoundingBox => ({
    x: Math.min(start.x,end.x), y: Math.min(start.y,end.y), width: Math.abs(end.x-start.x), height: Math.abs(end.y-start.y),
  });
  const start = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!tanks[activeIndex]) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const origin=point(event);drag.current={index:activeIndex,...origin};
    onChange(activeIndex,{...origin,width:0,height:0});
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    onChange(drag.current.index,rectangle(drag.current,point(event)));
  };
  const finish = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const state=drag.current;drag.current=null;
    const roi=rectangle(state,point(event));onChange(state.index,roi);onComplete(state.index,roi);
  };
  return <svg className="fst-roi-editor" style={{maxWidth: Math.round(650*width/height)}} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { drag.current = null; }} role="img" aria-label="Arraste no frame para delimitar o cilindro selecionado">
    {frame && <image href={frame} width={width} height={height} preserveAspectRatio="none" />}
    {tanks.map((tank,i) => tank.roiPx.width>0&&tank.roiPx.height>0 && <g key={tank.tankId} pointerEvents="none">
      <rect x={tank.roiPx.x} y={tank.roiPx.y} width={tank.roiPx.width} height={tank.roiPx.height} fill={i ? "#cb9b49" : "#36b7a8"} fillOpacity=".13" stroke={i ? "#e9b85c" : "#51ddce"} strokeWidth={Math.max(2,width/500)} />
      <text x={tank.roiPx.x+8} y={tank.roiPx.y+24} fill="white" stroke="black" strokeWidth="3" paintOrder="stroke" fontSize={Math.max(15,width/75)}>{tank.animalId}</text>
    </g>)}
  </svg>;
}

export function ForcedSwimExperimentWizard({ onBack }: { onBack: () => void }) {
  const { navigate, saveExperiment } = useAppStore();
  const [id] = useState(() => crypto.randomUUID());
  const [step,setStep] = useState(0);
  const [title,setTitle] = useState(""); const [group,setGroup] = useState(""); const [notes,setNotes] = useState("");
  const [subjects,setSubjects] = useState<string[]>([]);
  const [activeTank,setActiveTank] = useState(0);
  const [video,setVideo] = useState<VideoMetadata | null>(null);
  const [asset,setAsset] = useState<VideoAsset>({});
  const [tanks,setTanks] = useState<TankConfig[]>([]);
  const [loading,setLoading] = useState(false); const [message,setMessage] = useState(""); const [error,setError] = useState("");
  const [frameSec,setFrameSec] = useState(0); const fileRef = useRef<HTMLInputElement>(null);
  const titleError = !title.trim() ? "Informe o nome do experimento." : null;
  const subjectError = !subjects.length ? "Selecione a quantidade de animais." : subjects.some(s => !s.trim()) ? "Informe o ID científico de cada animal." : new Set(subjects.map(s => s.trim())).size !== subjects.length ? "Os IDs científicos precisam ser diferentes." : null;
  const tankError = video && subjects.length ? validateTanks(tanks,video.width,video.height)
    || (video.preparation ? (() => { const geometry=preparedGeometry(video,video.preparation);
      return validateTanks(scaleTanksToUpload(tanks,video,video.preparation),geometry.width,geometry.height)
        ? "Os cilindros precisam continuar válidos na resolução do vídeo enviado. Marque regiões maiores." : null; })() : null)
    : "Selecione a quantidade de animais.";
  const chooseCount = (count: number) => {
    if (subjects.length === count) return;
    const next = Array.from({length:count},(_,i)=>subjects[i]??"");
    setSubjects(next);
    setTanks(current=>initialTanks(next.map(s=>s.trim())).map((tank,i)=>current[i]?{...current[i],subjectId:next[i].trim()}:tank));
    setActiveTank(count-1);
  };
  const updateSubject = (index: number, value: string) => {
    setSubjects(current => current.map((s,i) => i === index ? value : s));
    setTanks(current => current.map((t,i) => i === index ? {...t,subjectId:value.trim()} : t));
  };
  const changeVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file || loading) return;
    setLoading(true);setError("");setMessage("Lendo vídeo e capturando frame original…");
    const url = URL.createObjectURL(file);
    try {
      const element = await openVideo(url);
      const at = Number.isFinite(element.duration) ? Math.min(element.duration*.35,Math.max(0,element.duration-.05)) : 0;
      const captured = await captureVideoFrame(element,at);
      const metadata: VideoMetadata = {filename:file.name,sizeBytes:file.size,width:element.videoWidth,height:element.videoHeight,durationSec:element.duration,
        fps:null,timingSource:"browser-estimate",calibrationFrameSec:captured.timeSec,lastModified:file.lastModified};
      if (isTauriRuntime()) {
        const prepared = await prepareFstVideo(id,file,metadata,(_p,m) => setMessage(m));
        metadata.preparation = prepared.preparation;
        metadata.sha256 = prepared.originalSha256;
        if (metadata.preparation.frameCount && Number.isFinite(metadata.durationSec) && metadata.durationSec > 0) metadata.fps = metadata.preparation.frameCount/metadata.durationSec;
      }
      if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
      setVideo(metadata);setAsset({objectUrl:url,file,frameDataUrl:captured.frameDataUrl,thumbnailDataUrl:captured.thumbnailDataUrl,frameTimeSec:captured.timeSec});
      setFrameSec(captured.timeSec);setTanks(initialTanks(subjects.map(s=>s.trim())));
      setMessage("Vídeo pronto para delimitar os cilindros.");
    } catch (reason) { URL.revokeObjectURL(url);setError(String(reason)); }
    finally { setLoading(false);event.target.value=""; }
  };
  const captureFrame = async () => {
    if (!asset.objectUrl) return;setLoading(true);setError("");
    try { const captured=await captureVideoFrame(await openVideo(asset.objectUrl),frameSec);
      setAsset(current=>({...current,frameDataUrl:captured.frameDataUrl,thumbnailDataUrl:captured.thumbnailDataUrl,frameTimeSec:captured.timeSec}));
      setVideo(current=>current?{...current,calibrationFrameSec:captured.timeSec}:current);setFrameSec(captured.timeSec);
    } catch (reason) {setError(String(reason));} finally {setLoading(false);}
  };
  const create = () => {
    if (!video || titleError || subjectError || tankError) return;
    const now=new Date().toISOString();
    const experiment: ForcedSwimExperiment = {id,schemaVersion:"1.0",analysisMethodVersion:FST_VERSION,analysisEngine:FST_ENGINE,
      title:title.trim(),subjectId:subjects[0].trim(),group:group.trim()||undefined,notes:notes.trim()||undefined,testType:"forced_swim",status:"draft",createdAt:now,updatedAt:now,
      video,calibrationThumbnailDataUrl:asset.thumbnailDataUrl,subjects:subjects.map((s,i)=>({animalId:`animal_${i+1}`,subjectId:s.trim()})),tanks,annotations:[]};
    const validation=validateForcedSwim(experiment);if(validation){setError(validation);return;}
    saveExperiment(experiment,asset);navigate({name:"results",experimentId:id});
  };
  return <div className="page wizard-page fst-wizard">
    <button className="back-link" onClick={() => step ? setStep(step-1) : onBack()}><ArrowLeft size={16} /> {step ? "Voltar à etapa anterior" : "Alterar protocolo"}</button>
    <section className="page-heading wizard-heading"><div><div className="eyebrow">Novo experimento · Nado Forçado</div><h1>Configurar Nado Forçado</h1><p>Um vídeo, um ou dois sujeitos e uma região fixa por cilindro.</p></div><Badge tone="info">Rascunho local</Badge></section>
    <ol className="wizard-steps">{steps.map((s,i)=><li key={s} className={i===step?"active":i<step?"done":""}><span>{i+1}</span>{s}</li>)}</ol>
    {step===0 && <section className="wizard-section fst-form"><h2>Experimento</h2><label>Nome do experimento<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Ex.: FST grupo controle" /></label><label>Grupo experimental<input value={group} onChange={e=>setGroup(e.target.value)} /></label><label>Observações<textarea value={notes} onChange={e=>setNotes(e.target.value)} /></label>
      {titleError && <p className="validation-box invalid"><Info size={16}/>{titleError}</p>}</section>}
    {step===1 && <section className="wizard-section"><h2>Vídeo original</h2><input ref={fileRef} type="file" accept="video/*" className="sr-only" onChange={changeVideo}/><Button icon={<UploadCloud size={17}/>} disabled={loading} onClick={()=>fileRef.current?.click()}>{video?"Substituir vídeo":"Selecionar vídeo"}</Button>
      {video&&<div className="fst-video-info"><FileVideo2 size={22}/><div><strong>{video.filename}</strong><p>{video.width} × {video.height} px · {formatDuration(video.durationSec)} · {video.fps?`${video.fps.toFixed(2)} FPS · `:"FPS verificado na execução · "}{formatBytes(video.sizeBytes)}</p></div></div>}
      {video?.preparation&&<p className="video-preparation-note">{video.preparation.message} · Envio: {formatBytes(video.preparation.uploadBytes)}.</p>}
      {asset.objectUrl&&<video className="fst-preview-video" controls src={asset.objectUrl}/>}
      {loading&&message?<div className="video-preparation-note" role="status" aria-live="polite"><LoaderCircle size={18} className="video-preparation-spinner" aria-hidden="true"/><span>{message}</span></div>:message&&<p role="status">{message}</p>}</section>}
    {step===2&&video&&<section className="wizard-section"><h2>Cilindros e animais</h2><p>Selecione a quantidade de animais neste vídeo. Para marcar cada cilindro, clique em um canto do frame e arraste até o canto oposto, incluindo a abertura e o fundo.</p>
      <div className="fst-count" role="group" aria-label="Quantidade de animais"><span>Quantidade de animais</span>{[1,2].map(count=><button type="button" key={count} className={subjects.length===count?"active":""} aria-pressed={subjects.length===count} onClick={()=>chooseCount(count)}>{count} {count===1?"animal":"animais"}</button>)}</div>
      {subjects.length>0&&<><div className="fst-animal-list">{subjects.map((subject,i)=><div className="fst-animal-item" key={i}><label>Animal {i+1} · ID científico<input value={subject} onChange={e=>updateSubject(i,e.target.value)} placeholder="Identificação do animal" /></label><button type="button" className={activeTank===i?"active":""} aria-pressed={activeTank===i} onClick={()=>setActiveTank(i)}>{tanks[i]?.roiPx.width&&tanks[i]?.roiPx.height?"Redesenhar cilindro":"Marcar cilindro"}</button></div>)}</div>
      <RoiEditor frame={asset.frameDataUrl} width={video.width} height={video.height} tanks={tanks} activeIndex={activeTank} onChange={(index,roi)=>setTanks(current=>current.map((t,i)=>i===index?{...t,roiPx:roi}:t))} onComplete={(index,roi)=>{setTanks(current=>current.map((t,i)=>i===index?{...t,revision:t.revision+1}:t));if(roi.width>=80&&roi.height>=video.height*.55&&tanks[index+1]&&!tanks[index+1].roiPx.width)setActiveTank(index+1);}}/></>}
      <div className="fst-frame-control"><label>Frame de referência · segundos<input type="number" min="0" max={video.durationSec} step="0.1" value={frameSec} onChange={e=>setFrameSec(Number(e.target.value))}/></label><Button variant="secondary" disabled={loading} onClick={()=>void captureFrame()}>Capturar frame</Button></div>
      <div className={tankError||subjectError?"validation-box invalid":"validation-box valid"}>{subjectError||tankError||"Cilindros marcados dentro do vídeo e sem sobreposição."}</div></section>}
    {step===3&&video&&<section className="wizard-section"><h2>Revisão</h2><div className="fst-review"><div><span>Vídeo</span><strong>{video.filename}</strong><small>{video.width} × {video.height} · {formatDuration(video.durationSec)}</small></div><div><span>Modelo</span><strong>SuperAnimal Quadruped · HRNet-w32</strong><small>39 pontos · detector Faster R-CNN desativado</small></div>{tanks.map(t=><div key={t.tankId}><span>{t.animalId} · {t.subjectId}</span><strong>{t.tankId}</strong><small>{Object.values(t.roiPx).join(" × ")} px · ROI fixa</small></div>)}</div><p>Atividade visual será exibida como indicador. A classificação comportamental automática permanece NOT_CLASSIFIED.</p></section>}
    {error&&<div className="validation-box invalid" role="alert"><Info size={16}/>{error}</div>}
    <div className="wizard-footer">{step<3?<Button disabled={loading||Boolean(step===0?titleError:step===1?!video:subjectError||tankError)} onClick={()=>setStep(step+1)} icon={<ArrowRight size={17}/>}>Continuar</Button>:<Button disabled={Boolean(subjectError||tankError)} onClick={create} icon={<Check size={17}/>}>Criar e abrir análise FST</Button>}</div>
  </div>;
}
