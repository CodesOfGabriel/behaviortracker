import { SelectMenu } from "../../components/ui/SelectMenu";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Pause, Play, SkipBack, SkipForward, Undo2, Download, Plus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { activeAnnotations, activePeaks, annotationOverlap, frameAt, intervalError } from "../../lib/behavior/validation";
import { postureLabels, type BehaviorAnnotation, type OftPosture } from "../../lib/behavior/types";
import { BehaviorEthogram } from "./BehaviorEthogram";
import { BehaviorVideoOverlay } from "./BehaviorVideoOverlay";
import { loadLocalResult } from "../local/api";
import type { PoseSample } from "../../types";
import { useVideoFrameTime } from "../../lib/useVideoFrameTime";
import { trackingFrameAt } from "../../lib/video-frame";
import { annotationContext, appendAnnotation, exportBehaviorAnnotations, exportBehaviorDataset, listAnnotations, revealBehaviorExport } from "./api";

const ANNOTATOR_SESSION_KEY="behavetracker.rearing.annotator.v1";
const ANNOTATOR_REQUIRED="Informe seu identificador de anotador para salvar.";

export function BehaviorAnnotationEditor({experimentId, trackingJobId, videoSha256, videoId, width, height, animalId, active, focusTime}: {
  experimentId: string; trackingJobId: string; videoSha256: string; videoId: string; width: number; height: number; animalId:string; active:boolean;focusTime?:number;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playbackRate,setPlaybackRate]=useState("1");
  const studio = useRef<HTMLElement>(null);
  const [context,setContext]=useState<Awaited<ReturnType<typeof annotationContext>> | null>(null);
  const [annotations,setAnnotations]=useState<BehaviorAnnotation[]>([]);
  const [samples,setSamples]=useState<PoseSample[]>([]);
  const {time:presentedTime,readPresentedTime}=useVideoFrameTime(video,context?.videoUrl);
  const time=presentedTime??0;
  const [mode,setMode]=useState<"peak"|"interval">("peak");
  const [draft,setDraft]=useState<BehaviorAnnotation|null>(null);
  const [selectedId,setSelectedId]=useState<string>();
  const [start,setStart]=useState<number | null>(null), [end,setEnd]=useState<number | null>(null);
  const [label,setLabel]=useState<OftPosture>("REARING_UNSPECIFIED");
  const [annotator,setAnnotator]=useState(()=>{
    try{return sessionStorage.getItem(ANNOTATOR_SESSION_KEY)?.slice(0,200)??"";}catch{return "";}
  });
  const [note,setNote]=useState("");
  const [error,setError]=useState<string | null>(null), [saving,setSaving]=useState(false), [playing,setPlaying]=useState(false);
  const [notice,setNotice]=useState("");
  const [sessionId,setSessionId]=useState(experimentId),[arenaId,setArenaId]=useState("");
  const [includeVideo,setIncludeVideo]=useState(false),[exportUrl,setExportUrl]=useState<string|null>(null);
  const [exportPath,setExportPath]=useState<string|null>(null);
  useEffect(()=>{
    // The operator belongs to this session, not to the selected historical mark.
    try{sessionStorage.setItem(ANNOTATOR_SESSION_KEY,annotator);}catch{/* Editing remains available when storage is restricted. */}
  },[annotator]);
  const intervals=useMemo(()=>activeAnnotations(annotations),[annotations]);
  const peaks=useMemo(()=>activePeaks(annotations),[annotations]);
  const selected=draft??peaks.find(p=>p.id===selectedId);
  const timelinePeaks=draft?[...peaks,{...draft,label}]:peaks;
  function selectPeak(peak:BehaviorAnnotation){
    if(saving)return false;
    if(draft&&peak.id!==draft.id){setError("Salve ou descarte a marcação atual antes de selecionar outra.");return false;}
    if(draft){setMode("peak");return true;}
    setMode("peak");setSelectedId(peak.id);setLabel(peak.label!);setNote(peak.note??"");setError(null);return true;
  }
  function markPeak(){
    if(!context||saving)return;
    if(draft){setError("Salve ou descarte a marcação atual antes de marcar outro ápice.");return;}
    const current=readPresentedTime();
    if(current==null){setError("Aguarde o vídeo apresentar o frame antes de marcar.");return;}
    video.current?.pause();
    const index=frameAt(context.frameTimes,current), timestamp=context.frameTimes[index];
    seek(timestamp);
    const existing=peaks.find(p=>p.frameIndex===index);
    if(existing){selectPeak(existing);setNotice("Este frame já está marcado. Você pode alterar o tipo à direita.");return;}
    const entry:BehaviorAnnotation={schemaVersion:1,id:crypto.randomUUID(),type:"PEAK",source:"human",experimentId,trackingJobId,videoSha256,
      createdAt:new Date().toISOString(),timestampSec:timestamp,frameIndex:index,label:label==="NON_REARING"?"REARING_UNSPECIFIED":label};
    setDraft(entry);setSelectedId(entry.id);setLabel(entry.label!);setNote("");setError(null);setNotice("Ápice marcado na timeline. Escolha o tipo à direita e salve.");
  }
  function changeMode(next:"peak"|"interval"){
    if(saving)return;
    if(draft){setError("Salve ou descarte a marcação atual antes de trocar de modo.");return;}
    setMode(next);setError(null);if(next==="peak"&&label==="NON_REARING")setLabel("REARING_UNSPECIFIED");
  }
  useEffect(()=>{
    let live=true;
    void Promise.all([annotationContext(experimentId,trackingJobId,videoSha256),listAnnotations(trackingJobId),loadLocalResult(trackingJobId)])
      .then(([ctx,events,poses])=>{if(live){setContext(ctx);setAnnotations(events);setSamples(poses);}}).catch(reason=>{if(live)setError(String(reason));});
    return()=>{live=false;};
  },[experimentId,trackingJobId,videoSha256]);
  useEffect(()=>{if(!active)video.current?.pause();else studio.current?.focus({preventScroll:true});},[active]);
  useEffect(()=>{if(active&&context&&focusTime!=null&&video.current){video.current.pause();video.current.currentTime=focusTime;}},[active,context,focusTime]);
  async function exportPackage(){
    if(!arenaId.trim()){setError("Identifique a arena antes de exportar o pacote.");return;}
    setSaving(true);setError(null);setExportUrl(null);
    try{const result=await exportBehaviorDataset(experimentId,trackingJobId,videoSha256,{animalId,sessionId:sessionId.trim(),arenaId:arenaId.trim(),condition:"unspecified"},includeVideo);setExportUrl(result.url);setExportPath(result.path);}
    catch(reason){setError(String(reason));}finally{setSaving(false);}
  }
  async function exportMarks(kind:"peaks"|"intervals"|"history"){
    setSaving(true);setError(null);setExportPath(null);
    try{
      const result=await exportBehaviorAnnotations(experimentId,trackingJobId,videoSha256,kind);
      setExportPath(result.path);setNotice("Exportação salva neste computador. Use “Mostrar arquivo” para abrir a pasta.");
    }catch(reason){setError(String(reason));}finally{setSaving(false);}
  }
  function seek(value:number) {if(video.current){video.current.pause();video.current.currentTime=value;}}
  function step(direction:number) {
    if(!context)return;
    const index=frameAt(context.frameTimes,video.current?.currentTime??time);
    seek(context.frameTimes[Math.min(context.frameTimes.length-1,Math.max(0,index+direction))]);
  }
  function toggle() {const el=video.current;if(el){if(el.paused)void el.play().catch(reason=>setError(String(reason)));else el.pause();}}
  function mark() {
    if(mode==="peak"){markPeak();return;}
    const current=video.current?.currentTime??time;
    if(start==null || end!=null){setStart(current);setEnd(null);setNotice("Início marcado. Continue até o retorno à postura quadrúpede e pressione R.");}
    else{video.current?.pause();setEnd(current);setNotice("Fim marcado. Confira o intervalo e salve a anotação.");}
  }
  async function save() {
    if(!context||saving)return;
    if(mode==="peak"){
      if(!selected)return;
      if(!annotator.trim()){setError(ANNOTATOR_REQUIRED);return;}
      const entry:BehaviorAnnotation=draft?{...draft,label,annotatorId:annotator.trim(),note:note.trim()}:
        {schemaVersion:1,id:crypto.randomUUID(),type:"LABEL_PEAK",source:"human",experimentId,trackingJobId,videoSha256,
          createdAt:new Date().toISOString(),targetId:selected.id,label,annotatorId:annotator.trim(),note:note.trim()};
      setSaving(true);setError(null);
      try{await appendAnnotation(entry);setAnnotations(old=>[...old,entry]);setDraft(null);setNotice("Marcação salva neste computador.");}
      catch(reason){setError(String(reason));}finally{setSaving(false);}
      return;
    }
    if(start==null||end==null)return;
    const problem=intervalError(start,end,context.durationSec);
    if(problem){setError(problem);return;}
    if(!annotator.trim()){setError(ANNOTATOR_REQUIRED);return;}
    if(annotationOverlap(annotations,start,end)){setError("Este trecho já tem uma anotação. Desfaça o intervalo anterior antes de substituí-lo.");return;}
    const entry:BehaviorAnnotation={schemaVersion:1,id:crypto.randomUUID(),type:"INTERVAL",source:"human",experimentId,trackingJobId,videoSha256,
      createdAt:new Date().toISOString(),startSec:start,endSec:end,label,annotatorId:annotator.trim(),note:note.trim()};
    setSaving(true);setError(null);
    try{await appendAnnotation(entry);setAnnotations(old=>[...old,entry]);setStart(null);setEnd(null);setNote("");setNotice("Anotação salva neste computador.");}
    catch(reason){setError(String(reason));}finally{setSaving(false);}
  }
  async function undo(id?:string) {
    const target=id??annotations.filter(e=>(e.type==="PEAK"&&peaks.some(p=>p.id===e.id))||(e.type==="INTERVAL"&&intervals.some(p=>p.id===e.id))).at(-1)?.id;if(!target || saving)return;
    const entry:BehaviorAnnotation={schemaVersion:1,id:crypto.randomUUID(),type:"UNDO",source:"human",experimentId,trackingJobId,videoSha256,
      createdAt:new Date().toISOString(),targetId:target};
    setSaving(true);setError(null);
    try{await appendAnnotation(entry);setAnnotations(old=>[...old,entry]);setSelectedId(undefined);setNotice("Marcação desfeita. O histórico foi preservado.");}
    catch(reason){setError(String(reason));}finally{setSaving(false);}
  }
  function keyboard(event:KeyboardEvent) {
    if((event.target as HTMLElement).closest("input,textarea,select,[role=combobox],[role=listbox],[role=option]"))return;
    if(event.key===" "&&(event.target as HTMLElement).closest("button"))return;
    if(event.repeat)return;
    const key=event.key.toLowerCase();
    if(key===" "){event.preventDefault();toggle();}
    else if(key==="arrowleft"){event.preventDefault();step(-1);}
    else if(key==="arrowright"){event.preventDefault();step(1);}
    else if(key==="r"){event.preventDefault();mark();}
    else if(key==="1")setLabel("REARING_SUPPORTED");
    else if(key==="2")setLabel("REARING_UNSUPPORTED");
    else if(key==="3")setLabel("REARING_UNSPECIFIED");
    else if(key==="u"){setLabel("UNKNOWN");mark();}
    else if(key==="z"&&(event.ctrlKey||event.metaKey)){event.preventDefault();void undo();}
  }
  const reviewedSeconds=intervals.reduce((sum,e)=>sum+e.endSec!-e.startSec!,0);
  return <section ref={studio} className="behavior-studio" aria-label="Estúdio de anotação de rearing" onKeyDown={keyboard} tabIndex={0}>
    <div className="behavior-intro"><h3>Anote o comportamento no vídeo</h3><p>Assista ao vídeo e pressione R no ápice do rearing. Escolha o tipo no painel à direita e salve. Se a imagem não permitir decidir, use “Incerto”.</p></div>
    {error&&<p className="validation-box invalid" role="alert">{error}</p>}
    {!context&&!error&&<p role="status">Verificando o vídeo original e seus timestamps…</p>}
    {context&&<>
      <div className="behavior-studio-grid"><div className="behavior-video-column">
        <div className="behavior-video-stage" style={{aspectRatio:`${width}/${height}`}}><video ref={video} src={context.videoUrl} controls preload="auto" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}/>
          <BehaviorVideoOverlay sample={trackingFrameAt(samples,presentedTime,1/((context.frameTimes[1]??.04)-(context.frameTimes[0]??0)))} samples={samples} width={width} height={height}/></div>
        <div className="behavior-transport"><Button size="sm" variant="secondary" icon={<SkipBack size={16}/>} onClick={()=>step(-1)} aria-label="Voltar um frame">Frame</Button>
          <Button size="sm" variant="secondary" icon={playing?<Pause size={16}/>:<Play size={16}/>} onClick={toggle}>{playing?"Pausar":"Reproduzir"}</Button>
          <Button size="sm" variant="secondary" icon={<SkipForward size={16}/>} onClick={()=>step(1)} aria-label="Avançar um frame">Frame</Button>
          <output>{time.toFixed(3)} s · frame {frameAt(context.frameTimes,time)+1}</output>
          <SelectMenu label="Velocidade de reprodução" value={playbackRate} onChange={value=>{setPlaybackRate(value);if(video.current)video.current.playbackRate=Number(value);}} options={[{value:".25",label:"0,25×"},{value:".5",label:"0,5×"},{value:"1",label:"1×"}]}/>
        </div>
        <div className="behavior-mark-buttons"><Button size="sm" variant={mode==="peak"?"primary":"secondary"} aria-pressed={mode==="peak"} onClick={()=>changeMode("peak")}>Marcar ápice</Button>
          <Button size="sm" variant={mode==="interval"?"primary":"secondary"} aria-pressed={mode==="interval"} onClick={()=>changeMode("interval")}>Anotar intervalo</Button>
          {mode==="peak"&&<Button size="sm" onClick={markPeak} disabled={saving||!!draft||presentedTime==null}>Marcar ápice agora (R)</Button>}</div>
        <BehaviorEthogram peaks={timelinePeaks} selectedPeakId={selectedId} onSelectPeak={selectPeak} intervals={intervals} duration={context.durationSec} time={time} onSeek={seek}/>
        <p className="behavior-shortcuts">Espaço: play/pausa · ← / →: um frame · R: {mode==="peak"?"marcar ápice":"início/fim"} · 1/2/3: subtipo · U: incerto · Ctrl/⌘ Z: desfazer. Clique nesta área para usar os atalhos.</p>
      </div>
      <form className="behavior-annotation-form" onSubmit={e=>{e.preventDefault();void save();}}>
        {mode==="peak"&&<div className="behavior-selected-peak"><strong>{selected?`Ápice em ${selected.timestampSec!.toFixed(3)} s · frame ${selected.frameIndex!+1}`:"Nenhum ápice selecionado"}</strong><p>{draft?"Marcação ainda não salva":selected?"Selecione o tipo e salve a alteração.":"Reproduza o vídeo e pressione R para marcar."}</p></div>}
        <label>Anotador<input value={annotator} disabled={saving} maxLength={200} onChange={e=>{setAnnotator(e.target.value);if(e.target.value.trim())setError(previous=>previous===ANNOTATOR_REQUIRED?null:previous);}} placeholder="Seu identificador" autoComplete="off"/></label>
        <fieldset disabled={saving}><legend>O que você observou?</legend>{(Object.keys(postureLabels) as OftPosture[]).filter(value=>mode==="interval"||value!=="NON_REARING").map(value=><label className="behavior-label-option" key={value}>
          <input type="radio" name="behavior-label" value={value} checked={label===value} onChange={()=>setLabel(value)}/><span>{postureLabels[value]}</span></label>)}</fieldset>
        {mode==="interval"&&<><div className="behavior-mark-buttons"><Button type="button" variant="secondary" size="sm" onClick={()=>{setStart(video.current?.currentTime??time);setEnd(null);}}>Marcar início</Button>
          <Button type="button" variant="secondary" size="sm" disabled={start==null} onClick={()=>{video.current?.pause();setEnd(video.current?.currentTime??time);}}>Marcar fim</Button></div>
        <div className="behavior-interval-inputs"><label>Início (s)<input type="number" min="0" max={context.durationSec} step="0.001" value={start??""} onChange={e=>setStart(e.target.value===""?null:Number(e.target.value))}/></label>
          <label>Fim (s)<input type="number" min="0" max={context.durationSec} step="0.001" value={end??""} onChange={e=>setEnd(e.target.value===""?null:Number(e.target.value))}/></label></div></>}
        <details className="behavior-note"><summary>Adicionar observação (opcional)</summary><label>Observação<input value={note} disabled={saving} maxLength={1000} onChange={e=>setNote(e.target.value)} placeholder="Ex.: grooming, rotação ou reflexo"/></label></details>
        <Button type="submit" loading={saving} disabled={mode==="peak"?!selected:start==null||end==null} icon={<Plus size={16}/>}>{mode==="peak"?"Salvar marcação":"Salvar intervalo"}</Button>
        {draft&&<Button type="button" variant="ghost" disabled={saving} onClick={()=>{setDraft(null);setSelectedId(undefined);setError(null);setNotice("Marcação descartada.");}}>Descartar marcação</Button>}
        {mode==="peak"&&selected&&!draft&&<Button type="button" variant="ghost" disabled={saving} onClick={()=>void undo(selected.id)}>Desfazer marcação selecionada</Button>}
        <p role="status" className="behavior-notice">{notice||(mode==="peak"?"Use R para marcar o ápice observado.":"Use R duas vezes para marcar um episódio.")}</p>
      </form></div>
      <div className="behavior-annotation-footer"><strong>{peaks.length} ápices · {intervals.length} intervalos · {reviewedSeconds.toFixed(2)} s anotados de {context.durationSec.toFixed(2)} s</strong>
        <Button size="sm" variant="secondary" disabled={(!intervals.length&&!peaks.length)||saving} icon={<Undo2 size={15}/>} onClick={()=>void undo()}>Desfazer último</Button>
        <Button size="sm" variant="secondary" disabled={(!intervals.length&&!peaks.length)||saving} icon={<Download size={15}/>} onClick={()=>void exportMarks(peaks.length?"peaks":"intervals")}>Exportar para treinamento</Button>
        {!!peaks.length&&!!intervals.length&&<Button size="sm" variant="secondary" disabled={saving} onClick={()=>void exportMarks("intervals")}>Exportar intervalos CSV</Button>}
        <Button size="sm" variant="secondary" disabled={!peaks.length||saving} onClick={()=>void exportMarks("peaks")}>Exportar ápices CSV</Button>
        <Button size="sm" variant="ghost" disabled={!annotations.length||saving} onClick={()=>void exportMarks("history")}>Histórico JSONL</Button>
      </div>
      {exportPath&&<p role="status">Arquivo salvo: {exportPath} <Button size="sm" variant="secondary" onClick={()=>void revealBehaviorExport(exportPath).catch(reason=>setError(String(reason)))}>Mostrar arquivo</Button></p>}
      <p className="behavior-help">Cada barra estreita identifica o ápice observado, sem duração atribuída. Para anotar a duração e trechos “Não rearing” para treinamento, use “Anotar intervalo”. Trechos vazios permanecem sem rótulo.</p>
      <details className="behavior-dataset-export"><summary>Preparar pacote completo para treinamento</summary><p>O ZIP reúne anotações humanas, observações do OpenCV, configuração e identificação do animal. Combine pacotes de animais independentes para treinar e avaliar.</p>
        <div className="behavior-interval-inputs"><label>Sessão<input value={sessionId} onChange={e=>setSessionId(e.target.value)} maxLength={200}/></label><label>Arena<input value={arenaId} onChange={e=>setArenaId(e.target.value)} placeholder="Identificador da arena" maxLength={200}/></label></div>
        <label className="behavior-label-option"><input type="checkbox" checked={includeVideo} onChange={e=>setIncludeVideo(e.target.checked)}/>Incluir o vídeo original no ZIP</label>
        <Button variant="secondary" loading={saving} disabled={(!intervals.length&&!peaks.length)||!sessionId.trim()||!arenaId.trim()} onClick={()=>void exportPackage()}>Preparar ZIP</Button>
        {exportUrl&&<a className="button button-secondary button-sm" href={exportUrl} download={`${videoId}-oft-training.zip`}>Baixar pacote de treinamento</a>}
      </details>
      <div className="behavior-interval-list">{[...intervals].sort((a,b)=>a.startSec!-b.startSec!).map(entry=><div key={entry.id} className={`behavior-interval behavior-${entry.label}`}>
        <button type="button" onClick={()=>seek(entry.startSec!)}><strong>{entry.startSec!.toFixed(3)} – {entry.endSec!.toFixed(3)} s</strong><span>{postureLabels[entry.label!]}</span></button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={()=>void undo(entry.id)} aria-label={`Desfazer intervalo ${entry.startSec!.toFixed(3)}`}>Desfazer</Button>
      </div>)}</div>
    </>}
  </section>;
}
