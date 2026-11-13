import { useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowRight, Check, FileVideo2, Info, UploadCloud } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { formatBytes, formatDuration } from "../../lib/format";
import { validateForcedSwim, validateTanks, FST_ENGINE, FST_VERSION } from "../../lib/fst";
import { useAppStore } from "../../store/AppStore";
import type { BoundingBox, ForcedSwimExperiment, TankConfig, VideoAsset, VideoMetadata } from "../../types";
import { prepareFstVideo } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { captureVideoFrame, openVideo } from "./OpenFieldExperimentWizard";

const steps = ["Experimento", "Vídeo", "Cilindros", "Revisão"];

function initialTanks(width: number, height: number, subjects: string[]): TankConfig[] {
  return subjects.map((subjectId, i) => ({
    tankId: `tank_${i+1}`, animalId: `animal_${i+1}`, subjectId,
    roiPx: { x: Math.round(width * (subjects.length === 1 ? .2 : i ? .55 : .05)), y: Math.round(height*.05),
      width: Math.round(width*(subjects.length === 1 ? .6 : .4)), height: Math.round(height*.9) }, revision: 1,
  }));
}

function RoiEditor({ frame, width, height, tanks, onChange }: { frame?: string; width: number; height: number; tanks: TankConfig[]; onChange: (index: number, roi: BoundingBox) => void }) {
  const drag = useRef<{ index: number; mode: "move" | "resize"; x: number; y: number; roi: BoundingBox } | null>(null);
  const start = (event: ReactPointerEvent<SVGElement>, index: number, mode: "move" | "resize") => {
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { index, mode, x: event.clientX, y: event.clientY, roi: tanks[index].roiPx };
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const state = drag.current; if (!state) return;
    const box = event.currentTarget.getBoundingClientRect();
    const dx = Math.round((event.clientX-state.x)*width/box.width);
    const dy = Math.round((event.clientY-state.y)*height/box.height);
    const roi = state.mode === "move"
      ? { ...state.roi, x: Math.max(0,Math.min(width-state.roi.width,state.roi.x+dx)), y: Math.max(0,Math.min(height-state.roi.height,state.roi.y+dy)) }
      : { ...state.roi, width: Math.max(80,Math.min(width-state.roi.x,state.roi.width+dx)), height: Math.max(80,Math.min(height-state.roi.y,state.roi.height+dy)) };
    onChange(state.index,roi);
  };
  return <svg className="fst-roi-editor" viewBox={`0 0 ${width} ${height}`} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} role="img" aria-label="Frame original com regiões fixas dos cilindros">
    {frame && <image href={frame} width={width} height={height} preserveAspectRatio="none" />}
    {tanks.map((tank,i) => <g key={tank.tankId}>
      <rect x={tank.roiPx.x} y={tank.roiPx.y} width={tank.roiPx.width} height={tank.roiPx.height} fill={i ? "#cb9b49" : "#36b7a8"} fillOpacity=".13" stroke={i ? "#e9b85c" : "#51ddce"} strokeWidth={Math.max(2,width/500)} onPointerDown={e => start(e,i,"move")} style={{cursor:"move"}} />
      <text x={tank.roiPx.x+8} y={tank.roiPx.y+24} fill="white" stroke="black" strokeWidth="3" paintOrder="stroke" fontSize={Math.max(15,width/75)}>{tank.animalId}</text>
      <circle cx={tank.roiPx.x+tank.roiPx.width} cy={tank.roiPx.y+tank.roiPx.height} r={Math.max(8,width/90)} fill={i ? "#e9b85c" : "#51ddce"} stroke="#fff" strokeWidth="2" onPointerDown={e => start(e,i,"resize")} style={{cursor:"nwse-resize"}} />
    </g>)}
  </svg>;
}

export function ForcedSwimExperimentWizard({ onBack }: { onBack: () => void }) {
  const { navigate, saveExperiment } = useAppStore();
  const [id] = useState(() => crypto.randomUUID());
  const [step,setStep] = useState(0);
  const [title,setTitle] = useState(""); const [group,setGroup] = useState(""); const [notes,setNotes] = useState("");
  const [subjects,setSubjects] = useState([""]);
  const [video,setVideo] = useState<VideoMetadata | null>(null);
  const [asset,setAsset] = useState<VideoAsset>({});
  const [tanks,setTanks] = useState<TankConfig[]>([]);
  const [confirmed,setConfirmed] = useState(false);
  const [loading,setLoading] = useState(false); const [message,setMessage] = useState(""); const [error,setError] = useState("");
  const [frameSec,setFrameSec] = useState(0); const fileRef = useRef<HTMLInputElement>(null);
  const subjectError = !title.trim() ? "Informe o nome do experimento." : subjects.some(s => !s.trim()) ? "Informe o ID científico de cada animal." : new Set(subjects.map(s => s.trim())).size !== subjects.length ? "Os IDs científicos precisam ser diferentes." : null;
  const tankError = video ? validateTanks(tanks,video.width,video.height) : "Selecione um vídeo.";
  const updateSubject = (index: number, value: string) => {
    setSubjects(current => current.map((s,i) => i === index ? value : s));
    setTanks(current => current.map((t,i) => i === index ? {...t,subjectId:value.trim()} : t));
    setConfirmed(false);
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
      setFrameSec(captured.timeSec);setTanks(initialTanks(metadata.width,metadata.height,subjects.map(s=>s.trim())));setConfirmed(false);
      setMessage("Vídeo pronto para delimitar os cilindros.");
    } catch (reason) { URL.revokeObjectURL(url);setError(String(reason)); }
    finally { setLoading(false);event.target.value=""; }
  };
  const captureFrame = async () => {
    if (!asset.objectUrl) return;setLoading(true);setError("");
    try { const captured=await captureVideoFrame(await openVideo(asset.objectUrl),frameSec);
      setAsset(current=>({...current,frameDataUrl:captured.frameDataUrl,thumbnailDataUrl:captured.thumbnailDataUrl,frameTimeSec:captured.timeSec}));
      setVideo(current=>current?{...current,calibrationFrameSec:captured.timeSec}:current);setFrameSec(captured.timeSec);setConfirmed(false);
    } catch (reason) {setError(String(reason));} finally {setLoading(false);}
  };
  const create = () => {
    if (!video || subjectError || tankError || !confirmed) return;
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
    {step===0 && <section className="wizard-section fst-form"><h2>Experimento e sujeitos</h2><label>Nome do experimento<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Ex.: FST grupo controle" /></label><label>Grupo experimental<input value={group} onChange={e=>setGroup(e.target.value)} /></label><label>Observações<textarea value={notes} onChange={e=>setNotes(e.target.value)} /></label>
      <fieldset><legend>Sujeitos no mesmo vídeo</legend>{subjects.map((s,i)=><label key={i}>{`Animal ${i+1} · animal_${i+1}`}<input value={s} onChange={e=>updateSubject(i,e.target.value)} placeholder="ID científico do sujeito" /></label>)}
        <div className="fst-subject-actions">{subjects.length===1?<Button type="button" variant="secondary" onClick={()=>{setSubjects(v=>[...v,""]);if(video)setTanks(initialTanks(video.width,video.height,[subjects[0].trim(),""]));setConfirmed(false);}}>Adicionar segundo animal</Button>:<Button type="button" variant="secondary" onClick={()=>{setSubjects(v=>v.slice(0,1));setTanks(v=>v.slice(0,1));setConfirmed(false);}}>Usar um animal</Button>}</div></fieldset>
      {subjectError && <p className="validation-box invalid"><Info size={16}/>{subjectError}</p>}</section>}
    {step===1 && <section className="wizard-section"><h2>Vídeo original</h2><input ref={fileRef} type="file" accept="video/*" className="sr-only" onChange={changeVideo}/><Button icon={<UploadCloud size={17}/>} disabled={loading} onClick={()=>fileRef.current?.click()}>{video?"Substituir vídeo":"Selecionar vídeo"}</Button>
      {video&&<div className="fst-video-info"><FileVideo2 size={22}/><div><strong>{video.filename}</strong><p>{video.width} × {video.height} px · {formatDuration(video.durationSec)} · {video.fps?`${video.fps.toFixed(2)} FPS · `:"FPS verificado na execução · "}{formatBytes(video.sizeBytes)}</p></div></div>}
      {asset.objectUrl&&<video className="fst-preview-video" controls src={asset.objectUrl}/>}{message&&<p role="status">{message}</p>}</section>}
    {step===2&&video&&<section className="wizard-section"><h2>Regiões fixas dos cilindros</h2><p>Delimite cada cilindro da abertura superior ao fundo. Arraste a região para mover; use o círculo inferior para redimensionar. A caixa do animal será calculada depois.</p>
      <RoiEditor frame={asset.frameDataUrl} width={video.width} height={video.height} tanks={tanks} onChange={(index,roi)=>{setTanks(current=>current.map((t,i)=>i===index?{...t,roiPx:roi,revision:t.revision+1}:t));setConfirmed(false);}}/>
      <div className="fst-frame-control"><label>Frame de referência · segundos<input type="number" min="0" max={video.durationSec} step="0.1" value={frameSec} onChange={e=>setFrameSec(Number(e.target.value))}/></label><Button variant="secondary" disabled={loading} onClick={()=>void captureFrame()}>Capturar frame</Button></div>
      <div className="fst-tanks">{tanks.map((t,i)=><fieldset key={t.tankId}><legend>{t.animalId} · {t.subjectId}</legend>{(["x","y","width","height"] as const).map(key=><label key={key}>{key}<input type="number" min="0" value={t.roiPx[key]} onChange={e=>{const value=Number(e.target.value);setTanks(current=>current.map((item,j)=>j===i?{...item,roiPx:{...item.roiPx,[key]:value},revision:item.revision+1}:item));setConfirmed(false);}}/></label>)}</fieldset>)}</div>
      <div className={tankError?"validation-box invalid":"validation-box valid"}>{tankError||"Regiões dentro do vídeo e sem sobreposição."}</div><Button variant="secondary" disabled={Boolean(tankError)} icon={<Check size={16}/>} onClick={()=>setConfirmed(true)}>{confirmed?"Cilindros confirmados":"Confirmar cilindros"}</Button></section>}
    {step===3&&video&&<section className="wizard-section"><h2>Revisão</h2><div className="fst-review"><div><span>Vídeo</span><strong>{video.filename}</strong><small>{video.width} × {video.height} · {formatDuration(video.durationSec)}</small></div><div><span>Modelo</span><strong>SuperAnimal Quadruped · HRNet-w32</strong><small>39 pontos · detector Faster R-CNN desativado</small></div>{tanks.map(t=><div key={t.tankId}><span>{t.animalId} · {t.subjectId}</span><strong>{t.tankId}</strong><small>{Object.values(t.roiPx).join(" × ")} px · ROI fixa</small></div>)}</div><p>Atividade visual será exibida como indicador. A classificação comportamental automática permanece NOT_CLASSIFIED.</p></section>}
    {error&&<div className="validation-box invalid" role="alert"><Info size={16}/>{error}</div>}
    <div className="wizard-footer">{step<3?<Button disabled={loading||Boolean(step===0?subjectError:step===1?!video:tankError||!confirmed)} onClick={()=>setStep(step+1)} icon={<ArrowRight size={17}/>}>Continuar</Button>:<Button disabled={!confirmed||Boolean(tankError)} onClick={create} icon={<Check size={17}/>}>Criar e abrir análise FST</Button>}</div>
  </div>;
}
