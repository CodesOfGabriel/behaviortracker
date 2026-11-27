import { SelectMenu } from "../../components/ui/SelectMenu";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Pause, Play, SkipBack, SkipForward, Undo2, Download, Plus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { activeAnnotations, activePeaks, annotationOverlap, frameAt, intervalError, proposalReviews } from "../../lib/behavior/validation";
import { postureLabels, exampleLabels, type BehaviorAnnotation, type BehaviorExample, type HumanPose, type OftPosture, type ProposalReviewInput, type ProposalReviewState } from "../../lib/behavior/types";
import { BehaviorEthogram } from "./BehaviorEthogram";
import { BehaviorVideoOverlay } from "./BehaviorVideoOverlay";
import { cachedLocalResult, loadLocalResult } from "../local/api";
import type { PoseSample } from "../../types";
import { useVideoFrameTime } from "../../lib/useVideoFrameTime";
import { trackingFrameAt } from "../../lib/video-frame";
import { annotationContext, appendAnnotation, cachedAnnotationContext, cachedAnnotations, exportBehaviorAnnotations, exportBehaviorDataset, listAnnotations, revealBehaviorExport, reviewBehaviorProposal } from "./api";

import { activePoseFrames, episodeForPeak, pendingEpisodes } from "../../lib/behavior/studio";
import { PoseAnnotationPanel } from "./PoseAnnotationPanel";

const ANNOTATOR_SESSION_KEY="behavetracker.rearing.annotator.v1";
const ANNOTATOR_REQUIRED="Informe seu identificador de anotador para salvar.";
const compactPostureLabels:Record<OftPosture,string>={NON_REARING:"Não rearing",REARING_SUPPORTED:"Com apoio",REARING_UNSUPPORTED:"Sem apoio",REARING_UNSPECIFIED:"Apoio indeterminado",UNKNOWN:"Incerto / não observável"};

export function BehaviorAnnotationEditor({experimentId, trackingJobId, videoSha256, videoId, width, height, animalId, active, renderDetection}: {
  experimentId: string; trackingJobId: string; videoSha256: string; videoId: string; width: number; height: number; animalId:string; active:boolean;
  renderDetection?:(controls:{onSeek:(time:number)=>boolean;disabled:boolean;reviews:Record<number,ProposalReviewState>;
    onReview:(review:Omit<ProposalReviewInput,"annotatorId">)=>Promise<boolean>})=>ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playbackRate,setPlaybackRate]=useState("1");
  const studio = useRef<HTMLElement>(null);
  const exportPanel=useRef<HTMLDetailsElement>(null);
  const dataDialog=useRef<HTMLDialogElement>(null);
  const exportMenu=useRef<HTMLDetailsElement>(null);
  const [context,setContext]=useState<Awaited<ReturnType<typeof annotationContext>> | null>(()=>cachedAnnotationContext(experimentId,trackingJobId,videoSha256)??null);
  const [annotations,setAnnotations]=useState<BehaviorAnnotation[]>(()=>cachedAnnotations(trackingJobId)??[]);
  const [samples,setSamples]=useState<PoseSample[]>(()=>cachedLocalResult(trackingJobId)??[]);
  const [loaded,setLoaded]=useState(()=>Boolean(cachedAnnotationContext(experimentId,trackingJobId,videoSha256)&&cachedAnnotations(trackingJobId)&&cachedLocalResult(trackingJobId)));
  const [loadAttempt,setLoadAttempt]=useState(0);
  const {time:presentedTime,readPresentedTime}=useVideoFrameTime(video,loaded?context?.videoUrl:undefined);
  const [seekTarget,setSeekTarget]=useState<number|null>(null);
  const time=seekTarget??presentedTime??0;
  const [sidebar,setSidebar]=useState(renderDetection?"detect":"annotate");
  const sidebarId=useId();
  const [mode,setMode]=useState<"peak"|"interval"|"pose">("peak");
  const [episodePeakId,setEpisodePeakId]=useState<string>();
  const [exampleKind,setExampleKind]=useState<BehaviorExample>("walking");
  const [poseDirty,setPoseDirty]=useState(false);
  const [poseStage,setPoseStage]=useState<HTMLDivElement|null>(null);
  const poseViewport=useRef<HTMLDivElement>(null);
  const [poseZoom,setPoseZoom]=useState("1");
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
  const reviewSaving=useRef(false);
  const [sessionId,setSessionId]=useState(experimentId),[arenaId,setArenaId]=useState("");
  const [includeVideo,setIncludeVideo]=useState(false),[exportUrl,setExportUrl]=useState<string|null>(null);
  const [exportPath,setExportPath]=useState<string|null>(null);
  useEffect(()=>{
    // The operator belongs to this session, not to the selected historical mark.
    try{sessionStorage.setItem(ANNOTATOR_SESSION_KEY,annotator);}catch{/* Editing remains available when storage is restricted. */}
  },[annotator]);
  const intervals=useMemo(()=>activeAnnotations(annotations),[annotations]);
  const peaks=useMemo(()=>activePeaks(annotations),[annotations]);
  const reviews=useMemo(()=>proposalReviews(annotations),[annotations]);
  const pending=useMemo(()=>pendingEpisodes(annotations),[annotations]);
  const poseFrames=useMemo(()=>activePoseFrames(annotations),[annotations]);
  const episodePeak=peaks.find(p=>p.id===episodePeakId);
  const selected=draft??peaks.find(p=>p.id===selectedId);
  const timelinePeaks=draft?[...peaks,{...draft,label}]:peaks;
  function selectPeak(peak:BehaviorAnnotation){
    if(saving)return false;
    if(poseDirty||start!=null){setError("Salve ou descarte a anotação atual antes de selecionar outra.");return false;}
    if(draft&&peak.id!==draft.id){setError("Salve ou descarte a marcação atual antes de selecionar outra.");return false;}
    if(draft){setMode("peak");return true;}
    setSidebar("annotate");setMode("peak");setEpisodePeakId(undefined);setSelectedId(peak.id);setLabel(peak.label!);setNote(peak.note??"");setError(null);return true;
  }
  function markPeak(forcedLabel:OftPosture=label){
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
      createdAt:new Date().toISOString(),timestampSec:timestamp,frameIndex:index,label:forcedLabel==="NON_REARING"?"REARING_UNSPECIFIED":forcedLabel};
    setSidebar("annotate");setDraft(entry);setSelectedId(entry.id);setLabel(entry.label!);setNote("");setError(null);setNotice("Ápice marcado na timeline. Escolha o tipo à direita e salve.");
  }
  function beginEpisode(peak:BehaviorAnnotation){
    dataDialog.current?.close();setSidebar("annotate");setMode("interval");setEpisodePeakId(peak.id);setSelectedId(peak.id);setStart(null);setEnd(null);setLabel(peak.label?.startsWith("REARING_")?peak.label:"REARING_UNSPECIFIED");setNote("");setError(null);seek(Math.max(0,peak.timestampSec!-.8));
    setNotice("Marque o início antes do ápice e o fim no primeiro quadro sem rearing. Depois salve para avançar.");
  }
  function completeEpisode(peak?:BehaviorAnnotation){
    if(saving)return;
    if(draft||poseDirty||start!=null){setError("Salve ou descarte a anotação atual antes de abrir outro episódio.");return;}
    const next=peak??pending[0];if(next)beginEpisode(next);
  }
  function beginExamples(){
    if(saving)return;
    if(draft||poseDirty||start!=null){setError("Salve ou descarte a anotação atual antes de anotar outro exemplo.");return;}
    setSidebar("annotate");setMode("interval");setEpisodePeakId(undefined);setLabel("NON_REARING");setNote("");setError(null);setNotice("Selecione o tipo de exemplo, marque início e fim e salve. Use Incerto se não for possível decidir.");
  }
  function changeMode(next:"peak"|"interval"|"pose"){
    if(saving)return;
    if(next===mode){setSidebar("annotate");return;}
    if(draft||poseDirty||start!=null){setError("Salve ou descarte a anotação atual antes de trocar de modo.");return;}
    setEpisodePeakId(undefined);
    setSidebar("annotate");setMode(next);setError(null);if(next==="peak"&&label==="NON_REARING")setLabel("REARING_UNSPECIFIED");
  }
  useEffect(()=>{
    let live=true;
    void Promise.all([annotationContext(experimentId,trackingJobId,videoSha256),listAnnotations(trackingJobId),loadLocalResult(trackingJobId)])
      .then(([ctx,events,poses])=>{if(live){setContext(ctx);setAnnotations(events);setSamples(poses);setLoaded(true);}}).catch(reason=>{if(live)setError(String(reason));});
    return()=>{live=false;};
  },[experimentId,trackingJobId,videoSha256,loadAttempt]);
  useEffect(()=>{if(!active)video.current?.pause();else studio.current?.focus({preventScroll:true});},[active]);
  async function exportPackage(){
    if(!arenaId.trim()){setError("Identifique a arena antes de exportar o pacote.");return;}
    setSaving(true);setError(null);setExportUrl(null);
    try{const result=await exportBehaviorDataset(experimentId,trackingJobId,videoSha256,{animalId,sessionId:sessionId.trim(),arenaId:arenaId.trim(),condition:"unspecified"},includeVideo);setExportUrl(result.url);setExportPath(result.path);}
    catch(reason){setError(String(reason));}finally{setSaving(false);}
  }
  async function exportMarks(kind:"peaks"|"intervals"|"history"|"poses"){
    if(exportMenu.current)exportMenu.current.open=false;
    setSaving(true);setError(null);setExportPath(null);
    try{
      const result=await exportBehaviorAnnotations(experimentId,trackingJobId,videoSha256,kind);
      setExportPath(result.path);setNotice("Exportação salva neste computador. Use “Mostrar arquivo” para abrir a pasta.");
    }catch(reason){setError(String(reason));}finally{setSaving(false);}
  }
  function seek(value:number) {
    if(video.current&&context&&Number.isFinite(value)){
      const target=Math.max(0,Math.min(value,context.frameTimes.at(-1)??context.durationSec));
      video.current.pause();video.current.currentTime=target;setSeekTarget(target);
    }
  }
  function seekProposal(value:number) {
    const editedPeak=selected&&(label!==selected.label||note!==(selected.note??""));
    if(saving||draft||editedPeak||poseDirty||start!=null){setError("Salve ou descarte a anotação em edição antes de revisar uma proposta.");return false;}
    if(!context||!video.current||!Number.isFinite(value))return false;
    setMode("peak");setSelectedId(undefined);setEpisodePeakId(undefined);setNote("");setError(null);
    seek(context.frameTimes[frameAt(context.frameTimes,value)]);
    setNotice("Proposta automática selecionada. Confira o vídeo antes de marcar o comportamento.");
    return true;
  }
  async function reviewProposal(review:Omit<ProposalReviewInput,"annotatorId">) {
    if(reviewSaving.current||saving||!context)return false;
    if(!annotator.trim()){setError(ANNOTATOR_REQUIRED);return false;}
    if(!seekProposal(review.timestampSec))return false;
    reviewSaving.current=true;setSaving(true);setError(null);
    try{
      const entries=await reviewBehaviorProposal(experimentId,trackingJobId,videoSha256,{...review,annotatorId:annotator.trim()});
      setAnnotations(old=>[...old,...entries]);
      setNotice(review.decision==="accept"?"Rearing confirmado e ápice salvo.":"Proposta rejeitada. Revisão salva.");
      return true;
    }catch(reason){setError(String(reason));return false;}
    finally{reviewSaving.current=false;setSaving(false);}
  }
  function step(direction:number) {
    if(!context)return;
    const index=frameAt(context.frameTimes,video.current?.currentTime??time);
    seek(context.frameTimes[Math.min(context.frameTimes.length-1,Math.max(0,index+direction))]);
  }
  function toggle() {const el=video.current;if(el){if(el.paused)void el.play().catch(reason=>setError(String(reason)));else el.pause();}}
  function presentedFrame(){
    const current=readPresentedTime();
    if(!context||current==null){setError("Aguarde o vídeo apresentar o frame antes de marcar.");return null;}
    const frameIndex=frameAt(context.frameTimes,current);video.current?.pause();
    return {frameIndex,timestampSec:context.frameTimes[frameIndex]};
  }
  function markBoundary(which:"start"|"end"){
    if(saving)return;const frame=presentedFrame();if(!frame)return;
    if(which==="start"){setStart(frame.timestampSec);setEnd(null);setNotice("Início marcado. Avance até o primeiro quadro sem o comportamento e marque o fim.");}
    else{setEnd(frame.timestampSec);setNotice("Fim marcado. Confira o intervalo e salve.");}
  }
  async function savePose(frame:{frameIndex:number;timestampSec:number},pose:HumanPose){
    if(saving)return false;
    if(!annotator.trim()){setError(ANNOTATOR_REQUIRED);return false;}
    const entry:BehaviorAnnotation={schemaVersion:1,id:crypto.randomUUID(),type:"POSE_FRAME",source:"human",experimentId,trackingJobId,videoSha256,createdAt:new Date().toISOString(),...frame,pose,imageWidth:width,imageHeight:height,annotatorId:annotator.trim()};
    setSaving(true);setError(null);
    try{await appendAnnotation(entry);setAnnotations(old=>[...old,entry]);setNotice("Pontos corporais salvos neste computador.");return true;}
    catch(reason){setError(String(reason));return false;}finally{setSaving(false);}
  }
  function mark() {
    if(mode==="peak"){markPeak();return;}
    if(mode==="pose")return;
    markBoundary(start==null||end!=null?"start":"end");
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
    if(mode==="pose"||start==null||end==null)return;
    const problem=intervalError(start,end,context.durationSec);
    if(problem){setError(problem);return;}
    if(episodePeak&&(!label.startsWith("REARING_")||start>episodePeak.timestampSec!||end<=episodePeak.timestampSec!)){setError("O episódio deve conter o ápice selecionado e ter um tipo de rearing. Para outro exemplo, use Anotar intervalo.");return;}
    if(!annotator.trim()){setError(ANNOTATOR_REQUIRED);return;}
    if(annotationOverlap(annotations,start,end)){setError("Este trecho já tem uma anotação. Desfaça o intervalo anterior antes de substituí-lo.");return;}
    const entry:BehaviorAnnotation={schemaVersion:1,id:crypto.randomUUID(),type:"INTERVAL",source:"human",experimentId,trackingJobId,videoSha256,
      createdAt:new Date().toISOString(),startSec:start,endSec:end,label,annotatorId:annotator.trim(),note:note.trim(),...(episodePeak?{peakId:episodePeak.id}:{}),...((label==="NON_REARING"||label==="UNKNOWN")?{exampleKind}: {})};
    setSaving(true);setError(null);
    try{await appendAnnotation(entry);const updated=[...annotations,entry];setAnnotations(updated);setStart(null);setEnd(null);setNote("");
      const next=episodePeak?pendingEpisodes(updated)[0]:undefined;
      if(next){beginEpisode(next);setNotice("Episódio salvo. Próximo ápice carregado; marque seu início e fim.");}
      else{setEpisodePeakId(undefined);setNotice(episodePeak?"Episódio salvo. Todos os ápices de rearing têm um intervalo.":"Anotação salva neste computador.");}
    }
    catch(reason){setError(String(reason));}finally{setSaving(false);}
  }
  async function undo(id?:string) {
    if(poseDirty){setError("Salve ou descarte os pontos em edição antes de desfazer uma anotação salva.");return;}
    const target=id??annotations.filter(e=>(e.type==="PEAK"&&peaks.some(p=>p.id===e.id))||(e.type==="INTERVAL"&&intervals.some(p=>p.id===e.id))||(e.type==="POSE_FRAME"&&poseFrames.some(p=>p.id===e.id))).at(-1)?.id;if(!target || saving)return;
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
    else if(key==="i"&&mode==="interval"){event.preventDefault();markBoundary("start");}
    else if(key==="f"&&mode==="interval"&&start!=null){event.preventDefault();markBoundary("end");}
    else if(key==="1")setLabel("REARING_SUPPORTED");
    else if(key==="2")setLabel("REARING_UNSUPPORTED");
    else if(key==="3")setLabel("REARING_UNSPECIFIED");
    else if(key==="u"&&mode!=="pose"){event.preventDefault();setLabel("UNKNOWN");setEpisodePeakId(undefined);if(mode==="interval")mark();else markPeak("UNKNOWN");}
    else if(key==="z"&&(event.ctrlKey||event.metaKey)){event.preventDefault();void undo();}
  }
  useLayoutEffect(()=>{
    if(mode!=="pose"||!poseViewport.current||!poseStage)return;
    const viewport=poseViewport.current;
    const sample=trackingFrameAt(samples,presentedTime,1/((context?.frameTimes[1]??.04)-(context?.frameTimes[0]??0)));
    const box=sample?.bbox;
    const x=box?box.x+box.width/2:width/2,y=box?box.y+box.height/2:height/2;
    const center=()=>{
      const scale=Math.min(poseStage.clientWidth/width,poseStage.clientHeight/height);
      viewport.scrollLeft=(poseStage.clientWidth-width*scale)/2+x*scale-viewport.clientWidth/2;
      viewport.scrollTop=(poseStage.clientHeight-height*scale)/2+y*scale-viewport.clientHeight/2;
    };
    // The select restores modal scrolling after its portal closes. Center once
    // the final content dimensions have settled; leave later panning untouched.
    const frame=requestAnimationFrame(center);
    const resize=new ResizeObserver(center);resize.observe(poseStage);resize.observe(viewport);
    return()=>{cancelAnimationFrame(frame);resize.disconnect();};
  },[mode,poseZoom,poseStage,width,height]);
  function prepareExport(){
    setError(null);video.current?.pause();dataDialog.current?.showModal();if(exportPanel.current)exportPanel.current.open=true;
    setNotice("Confira a identificação da sessão e da arena e clique em Preparar ZIP. O pacote inclui todas as anotações salvas.");
  }
  const reviewedSeconds=intervals.reduce((sum,e)=>sum+e.endSec!-e.startSec!,0);
  return <section ref={studio} className="behavior-studio" data-mode={mode} aria-label="Estúdio de anotação de rearing" onKeyDown={keyboard} tabIndex={0}>
    <div className="behavior-intro"><h3>Anote o comportamento no vídeo</h3><p>Marque os ápices, complete os episódios e anote exemplos difíceis. Para ensinar as posições do corpo, use Pontos corporais.</p></div>
    {error&&<p className="validation-box invalid" role="alert">{error}</p>}
    {!loaded&&!error&&<p role="status">Carregando vídeo, tracking e anotações…</p>}
    {!loaded&&error&&<Button variant="secondary" onClick={()=>{setError(null);setLoadAttempt(old=>old+1);}}>Tentar carregar novamente</Button>}
    {loaded&&context&&<>
      <div className="behavior-learning-path" aria-label="Preparação dos dados de treinamento">
        <Button size="sm" variant={mode==="peak"?"primary":"secondary"} onClick={()=>changeMode("peak")}>1. Ápices · {peaks.length}</Button>
        <Button size="sm" aria-label={`2. Completar episódios · ${pending.length} ${pending.length===1?"pendente":"pendentes"}`} variant={episodePeak?"primary":"secondary"} disabled={!pending.length||saving} onClick={()=>completeEpisode()}>2. Episódios · {pending.length} {pending.length===1?"pendente":"pendentes"}</Button>
        <Button size="sm" variant={mode==="interval"&&!episodePeak&&(label==="NON_REARING"||label==="UNKNOWN")?"primary":"secondary"} onClick={beginExamples}>3. Exemplos e incertezas</Button>
        <Button size="sm" aria-label={`4. Pontos corporais · ${poseFrames.length} ${poseFrames.length===1?"quadro":"quadros"}`} variant={mode==="pose"?"primary":"secondary"} onClick={()=>changeMode("pose")}>4. Pontos · {poseFrames.length}</Button>
      </div>
      <div className="behavior-studio-grid"><div className="behavior-video-column">
        <div ref={poseViewport} className={`behavior-video-stage${mode==="pose"?" behavior-pose-stage":""}`} style={{aspectRatio:`${width}/${height}`}}><div ref={setPoseStage} className="behavior-video-content" style={mode==="pose"?{width:`${Number(poseZoom)*100}%`,height:`${Number(poseZoom)*100}%`}:undefined}><video ref={video} src={context.videoUrl} controls={mode!=="pose"} preload="auto" onSeeking={event=>setSeekTarget(event.currentTarget.currentTime)} onSeeked={()=>setSeekTarget(null)} onPlay={()=>{setSeekTarget(null);setPlaying(true);}} onPause={()=>setPlaying(false)}/>
          {mode!=="pose"&&<BehaviorVideoOverlay sample={trackingFrameAt(samples,presentedTime,1/((context.frameTimes[1]??.04)-(context.frameTimes[0]??0)))} samples={samples} width={width} height={height}/>}</div></div>
        <div className="behavior-transport"><Button size="sm" variant="secondary" icon={<SkipBack size={16}/>} onClick={()=>step(-1)} aria-label="Voltar um frame"><span className="sr-only">Frame</span></Button>
          <Button size="sm" variant="secondary" icon={playing?<Pause size={16}/>:<Play size={16}/>} onClick={toggle}>{playing?"Pausar":"Reproduzir"}</Button>
          <Button size="sm" variant="secondary" icon={<SkipForward size={16}/>} onClick={()=>step(1)} aria-label="Avançar um frame"><span className="sr-only">Frame</span></Button>
          <output>{time.toFixed(3)} s · frame {frameAt(context.frameTimes,time)+1}</output>
          <SelectMenu label="Velocidade de reprodução" value={playbackRate} onChange={value=>{setPlaybackRate(value);if(video.current)video.current.playbackRate=Number(value);}} options={[{value:".25",label:"0,25×"},{value:".5",label:"0,5×"},{value:"1",label:"1×"}]}/>
        </div>
        <div className="behavior-mark-buttons"><Button size="sm" variant={mode==="peak"?"primary":"secondary"} aria-pressed={mode==="peak"} onClick={()=>changeMode("peak")}>Marcar ápice</Button>
          <Button size="sm" variant={mode==="interval"?"primary":"secondary"} aria-pressed={mode==="interval"} onClick={()=>changeMode("interval")}>Anotar intervalo</Button>
          {mode==="peak"&&<Button size="sm" onClick={()=>markPeak()} disabled={saving||!!draft||presentedTime==null}>Marcar ápice agora (R)</Button>}</div>
        <BehaviorEthogram peaks={timelinePeaks} selectedPeakId={selectedId} onSelectPeak={selectPeak} intervals={intervals} duration={context.durationSec} time={time} onSeek={seek}/>
        <p className="behavior-shortcuts">I / F: início / fim · Espaço: play/pausa · ← / →: um frame · R: {mode==="peak"?"marcar ápice":"início/fim"} · 1/2/3: subtipo · U: incerto · Ctrl/⌘ Z: desfazer. Clique nesta área para usar os atalhos.</p>
      </div>
      <aside className="behavior-studio-sidebar" aria-label="Painel de anotação e detecção">
      {renderDetection&&<div className="behavior-sidebar-tabs" role="tablist" aria-label="Painel do estúdio">{[["annotate","Anotação"],["detect","Detecção automática"]].map(([value,label])=><button key={value} type="button"
        id={`${sidebarId}-${value}-tab`} role="tab" aria-selected={sidebar===value} aria-controls={`${sidebarId}-${value}-panel`} onClick={()=>setSidebar(value)}>{label}</button>)}</div>}
      <label className="behavior-studio-annotator">Anotador<input value={annotator} disabled={saving} maxLength={200} onChange={e=>{setAnnotator(e.target.value);if(e.target.value.trim())setError(previous=>previous===ANNOTATOR_REQUIRED?null:previous);}} placeholder="Seu identificador" autoComplete="off"/></label>
      <div hidden={sidebar!=="annotate"} {...(renderDetection?{role:"tabpanel",id:`${sidebarId}-annotate-panel`,"aria-labelledby":`${sidebarId}-annotate-tab`}:{})}>
      {mode==="pose"?<div className="behavior-annotation-form">
        <PoseAnnotationPanel zoom={poseZoom} onZoom={setPoseZoom} stage={poseStage} width={width} height={height} times={context.frameTimes} samples={samples} annotations={annotations} currentFrame={presentedTime==null?null:frameAt(context.frameTimes,presentedTime)} capture={presentedFrame} onSeek={seek} onSave={savePose} onDirty={setPoseDirty} saving={saving}/>
      </div>:<form className="behavior-annotation-form" onSubmit={e=>{e.preventDefault();void save();}}>
        {episodePeak&&<div className="behavior-selected-peak"><strong>Completar episódio · ápice {episodePeak.timestampSec!.toFixed(3)} s</strong><p>1. Marque o início · 2. Marque o fim · 3. Salve para avançar</p><Button type="button" variant="ghost" size="sm" onClick={()=>seek(episodePeak.timestampSec!)}>Ver ápice selecionado</Button></div>}
        {mode==="peak"&&<div className="behavior-selected-peak"><strong>{selected?`Ápice em ${selected.timestampSec!.toFixed(3)} s · frame ${selected.frameIndex!+1}`:"Nenhum ápice selecionado"}</strong><p>{draft?"Marcação ainda não salva":selected?"Selecione o tipo e salve a alteração.":"Reproduza o vídeo e pressione R para marcar."}</p></div>}
        <fieldset disabled={saving}><legend>O que você observou?</legend>{(Object.keys(postureLabels) as OftPosture[]).filter(value=>mode==="interval"||value!=="NON_REARING").map(value=><label className="behavior-label-option" key={value}>
          <input type="radio" aria-label={postureLabels[value]} name="behavior-label" value={value} checked={label===value} onChange={()=>setLabel(value)}/><span>{compactPostureLabels[value]}</span></label>)}</fieldset>
        {mode==="interval"&&<><div className="behavior-mark-buttons"><Button type="button" variant="secondary" size="sm" disabled={saving||presentedTime==null} onClick={()=>markBoundary("start")}>Marcar início</Button>
          <Button type="button" variant="secondary" size="sm" disabled={saving||start==null||presentedTime==null} onClick={()=>markBoundary("end")}>Marcar fim</Button></div>
        <div className="behavior-interval-inputs"><label>Início (s)<input type="number" min="0" max={context.durationSec} step="0.001" value={start??""} onChange={e=>setStart(e.target.value===""?null:Number(e.target.value))}/></label>
          <label>Fim (s)<input type="number" min="0" max={context.durationSec} step="0.001" value={end??""} onChange={e=>setEnd(e.target.value===""?null:Number(e.target.value))}/></label></div></>}
        {mode==="interval"&&(label==="NON_REARING"||label==="UNKNOWN")&&<SelectMenu label="Tipo de exemplo" value={exampleKind} onChange={value=>setExampleKind(value as BehaviorExample)} options={Object.entries(exampleLabels).map(([value,label])=>({value,label}))}/>}
        <details className="behavior-note"><summary>Adicionar observação (opcional)</summary><label>Observação<input value={note} disabled={saving} maxLength={1000} onChange={e=>setNote(e.target.value)} placeholder="Ex.: grooming, rotação ou reflexo"/></label></details>
        <Button type="submit" loading={saving} disabled={mode==="peak"?!selected:start==null||end==null} icon={<Plus size={16}/>}>{mode==="peak"?"Salvar marcação":episodePeak?"Salvar episódio e próximo":"Salvar intervalo"}</Button>
        {mode==="interval"&&(start!=null||episodePeak)&&<Button type="button" variant="ghost" disabled={saving} onClick={()=>{setStart(null);setEnd(null);setEpisodePeakId(undefined);setError(null);setNotice("Intervalo em edição descartado. As marcações salvas foram preservadas.");}}>Descartar intervalo em edição</Button>}
        {draft&&<Button type="button" variant="ghost" disabled={saving} onClick={()=>{setDraft(null);setSelectedId(undefined);setError(null);setNotice("Marcação descartada.");}}>Descartar marcação</Button>}
        {mode==="peak"&&selected&&!draft&&<Button type="button" variant="ghost" disabled={saving} onClick={()=>void undo(selected.id)}>Desfazer marcação selecionada</Button>}
      </form>}</div>
      {renderDetection&&<div hidden={sidebar!=="detect"} role="tabpanel" id={`${sidebarId}-detect-panel`} aria-labelledby={`${sidebarId}-detect-tab`}>
        {renderDetection({onSeek:seekProposal,disabled:saving,reviews,onReview:reviewProposal})}
      </div>}
      {(mode!=="pose"||sidebar==="detect")&&<p role="status" className="behavior-notice">{notice||(sidebar==="detect"?"Confira cada sugestão antes de confirmar.":mode==="peak"?"Use R para marcar o ápice observado.":"Use R duas vezes para marcar um episódio.")}</p>}
      </aside></div>
      <div className="behavior-annotation-footer"><strong title={`${reviewedSeconds.toFixed(2)} s anotados de ${context.durationSec.toFixed(2)} s`}>{peaks.length} ápices · {intervals.length} intervalos · {poseFrames.length} quadros corporais</strong>
        <Button size="sm" variant="secondary" disabled={(!intervals.length&&!peaks.length&&!poseFrames.length)||saving||poseDirty} icon={<Undo2 size={15}/>} onClick={()=>void undo()}>Desfazer último</Button>
        <Button size="sm" variant="secondary" disabled={(!intervals.length&&!peaks.length&&!poseFrames.length)||saving} icon={<Download size={15}/>} onClick={prepareExport}>Exportar para treinamento</Button>
        <details ref={exportMenu} className="behavior-export-menu" open={!renderDetection||undefined}><summary>Mais opções</summary><div>
        {!!peaks.length&&!!intervals.length&&<Button size="sm" variant="secondary" disabled={saving} onClick={()=>void exportMarks("intervals")}>Exportar intervalos CSV</Button>}
        <Button size="sm" variant="secondary" disabled={!peaks.length||saving} onClick={()=>void exportMarks("peaks")}>Exportar ápices CSV</Button>
        <Button size="sm" variant="secondary" disabled={!poseFrames.length||saving} onClick={()=>void exportMarks("poses")}>Exportar pontos CSV</Button>
        <Button size="sm" variant="ghost" disabled={!annotations.length||saving} onClick={()=>void exportMarks("history")}>Histórico JSONL</Button>
        <Button size="sm" variant="ghost" onClick={()=>{if(exportMenu.current)exportMenu.current.open=false;video.current?.pause();dataDialog.current?.showModal();}}>Ver anotações salvas</Button>
        </div></details>
      </div>
      {exportPath&&<p role="status">Arquivo salvo: {exportPath} <Button size="sm" variant="secondary" onClick={()=>void revealBehaviorExport(exportPath).catch(reason=>setError(String(reason)))}>Mostrar arquivo</Button></p>}
      <dialog ref={dataDialog} className="behavior-data-dialog" aria-label="Anotações e exportação"><header><h3>Anotações e exportação</h3><Button type="button" variant="secondary" size="sm" onClick={()=>dataDialog.current?.close()}>Voltar ao vídeo</Button></header>
      <p className="behavior-help">Ápices registram instantes. Para duração e exemplos negativos, anote início e fim no vídeo.</p>
      <details ref={exportPanel} className="behavior-dataset-export"><summary>Preparar pacote completo para treinamento</summary><p>O ZIP reúne anotações humanas, observações do OpenCV, configuração, identificação do animal e imagens dos quadros com pontos corporais. O vídeo completo é opcional. Combine pacotes de animais independentes para treinar e avaliar.</p>
        <div className="behavior-training-counts" aria-label="Conteúdo do pacote"><span>{intervals.filter(e=>e.label?.startsWith("REARING_")).length} episódios de rearing</span><span>{intervals.filter(e=>e.label==="NON_REARING").length} exemplos negativos</span><span>{intervals.filter(e=>e.label==="UNKNOWN").length} trechos incertos</span><span>{poseFrames.length} quadros com pontos</span></div><p>Trechos sem anotação continuam desconhecidos. Este pacote contém um vídeo; a avaliação deve reservar outros animais ou sessões.</p>
        <div className="behavior-interval-inputs"><label>Sessão<input value={sessionId} onChange={e=>setSessionId(e.target.value)} maxLength={200}/></label><label>Arena<input value={arenaId} onChange={e=>setArenaId(e.target.value)} placeholder="Identificador da arena" maxLength={200}/></label></div>
        <label className="behavior-label-option"><input type="checkbox" checked={includeVideo} onChange={e=>setIncludeVideo(e.target.checked)}/>Incluir o vídeo original no ZIP</label><p>Inclua o vídeo para treinar comportamento em outro computador ou no Colab. Os quadros com pontos corporais são incluídos mesmo sem o vídeo completo.</p>
        <Button variant="secondary" loading={saving} disabled={(!intervals.length&&!peaks.length&&!poseFrames.length)||!sessionId.trim()||!arenaId.trim()} onClick={()=>void exportPackage()}>Preparar ZIP</Button>
        {exportUrl&&<a className="button button-secondary button-sm" href={exportUrl} download={`${videoId}-oft-training.zip`}>Baixar pacote de treinamento</a>}
      </details>
      <details className="behavior-episode-queue" open={!!episodePeak}><summary>Ápices e episódios · {peaks.filter(p=>episodeForPeak(annotations,p)).length} de {peaks.length} com intervalo</summary><div className="behavior-interval-list">{peaks.map(p=><Button key={p.id} size="sm" variant="secondary" disabled={saving||!!episodeForPeak(annotations,p)||!p.label?.startsWith("REARING_")} onClick={()=>completeEpisode(p)}>{p.timestampSec!.toFixed(3)} s · {episodeForPeak(annotations,p)?"Episódio completo":p.label==="UNKNOWN"?"Ápice incerto":"Completar início e fim"}</Button>)}</div></details>
      <div className="behavior-interval-list">{[...intervals].sort((a,b)=>a.startSec!-b.startSec!).map(entry=><div key={entry.id} className={`behavior-interval behavior-${entry.label}`}>
        <button type="button" onClick={()=>seek(entry.startSec!)}><strong>{entry.startSec!.toFixed(3)} – {entry.endSec!.toFixed(3)} s</strong><span>{postureLabels[entry.label!]}</span></button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={()=>void undo(entry.id)} aria-label={`Desfazer intervalo ${entry.startSec!.toFixed(3)}`}>Desfazer</Button>
      </div>)}</div>
      </dialog>
    </>}
  </section>;
}
