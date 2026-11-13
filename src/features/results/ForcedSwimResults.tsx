import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ArrowLeft, ArrowRight, Download, Info, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EditorTabs } from "../../components/ui/EditorTabs";
import { downloadText } from "../../lib/csv";
import { formatDuration } from "../../lib/format";
import { displayableFstPose, FST_ENGINE, FST_VERSION, validateForcedSwim, type FstResult } from "../../lib/fst";
import { useAppStore } from "../../store/AppStore";
import type { ForcedSwimExperiment, FstAnnotation, FstBehavior } from "../../types";
import { AnalysisWorkflow } from "../colab/AnalysisWorkflow";
import { checkVideoStaging, loadColabJobs, loadColabResult, loadColabVideo,
  loadFstArtifacts, loadFstManifest, loadStagedVideo, prepareFstVideo, startFstJob, waitForColabJob, type ColabJob } from "../colab/analysis";
import { COLAB_STATUS_EVENT, emptyColabSummary, isTauriRuntime, loadColabSummary, type OAuthProfileSummary } from "../colab/connection";

const labels: FstBehavior[] = ["IMMOBILITY","SWIMMING","CLIMBING","MIXED","UNCERTAIN"];
const presenceColor: Record<string,string> = {IN_TANK:"#51d2b0",NOT_IN_TANK:"#888f98",UNCERTAIN:"#d6a74f"};
export function parseFstResult(text: string): FstResult {
  const value = JSON.parse(text) as FstResult;
  if (value.schemaVersion !== "fst-result-1" || value.protocol !== "forced_swim" || value.engineId !== FST_ENGINE ||
      value.analysisVersion !== FST_VERSION || !Array.isArray(value.frames) || !Array.isArray(value.keypointNames) || !value.poseArrays || !Array.isArray(value.tanks) ||
      !Array.isArray(value.subjects) || !Array.isArray(value.reviewShortlist) || !value.insufficientIntervals || !Number.isFinite(value.video?.fps) || value.video.fps <= 0 ||
      !Number.isInteger(value.video.frameCount) || value.video.frameCount < 1 ||
      value.frames.some(frame => !["IN_TANK","NOT_IN_TANK","UNCERTAIN"].includes(frame.presence) || frame.classification !== "NOT_CLASSIFIED" || (frame.presence !== "IN_TANK" && frame.bbox !== null))) {
    throw new Error("Contrato do resultado FST incompatível.");
  }
  return value;
}
function mean(values: (number|null)[]) {
  const valid=values.filter((v):v is number=>v!==null&&Number.isFinite(v));
  return valid.length?valid.reduce((a,b)=>a+b,0)/valid.length:null;
}
function showNumber(value:number|null,digits=3) {return value===null?"Dados insuficientes":value.toFixed(digits);}
function jobStatus(status: ColabJob["status"]) {
  switch (status) {
    case "succeeded": return "Concluída";
    case "failed": return "Interrompida";
    case "running": return "Em andamento";
    case "queued": return "Na fila";
  }
}

export function ForcedSwimResults({experimentId}:{experimentId:string}) {
  const {getExperiment,navigate,assets,setAsset,updateForcedSwimExperiment}=useAppStore();
  const experiment=getExperiment(experimentId) as ForcedSwimExperiment|undefined;
  const asset=assets[experimentId];
  const [summary,setSummary]=useState<OAuthProfileSummary>(emptyColabSummary);
  const [history,setHistory]=useState<ColabJob[]>([]);
  const [selectedJobId,setSelectedJobId]=useState<string|null>(null);
  const [view,setView]=useState<"results"|"runs">("results");
  const [result,setResult]=useState<FstResult|null>(null);
  const [loadingResult,setLoadingResult]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState<string|null>(null);
  const [videoUrl,setVideoUrl]=useState<string|null>(null);
  const [labeledVideo,setLabeledVideo]=useState<string|null>(null);
  const [labeledVideoError,setLabeledVideoError]=useState<string|null>(null);
  const [artifacts,setArtifacts]=useState<{name:string;path:string;url:string}[]>([]);
  const [manifest,setManifest]=useState<Record<string,unknown>|null>(null);
  const [selectedAnimal,setSelectedAnimal]=useState("animal_1");
  const [time,setTime]=useState(0);
  const [showBoxes,setShowBoxes]=useState(true);const [showPoints,setShowPoints]=useState(true);
  const [startSec,setStartSec]=useState(0);const [endSec,setEndSec]=useState(1);const [label,setLabel]=useState<FstBehavior>("UNCERTAIN");
  const [clock,setClock]=useState(Date.now);
  const fileRef=useRef<HTMLInputElement>(null);const playerRef=useRef<HTMLVideoElement>(null);
  const selectedJob=history.find(j=>j.jobId===selectedJobId)??history[0]??null;
  const active=history.find(j=>j.status==="running"||j.status==="queued");
  const visibleView=selectedJob?.resultsReady?view:"runs";
  const frame=result?Math.max(0,Math.min(result.video.frameCount-1,Math.round(time*result.video.fps))):0;
  const frameData=useMemo(()=>result?.frames.filter(f=>f.frame===frame)??[],[result,frame]);
  const framePoses=useMemo(()=>result?.subjects.flatMap(s=>(result.poseArrays[s.animalId]?.[frame]??[]).map(([xPx,yPx,likelihood],i)=>({animalId:s.animalId,keypoint:result.keypointNames[i],xPx,yPx,likelihood})))??[],[result,frame]);
  const annotations=(experiment?.annotations??[]).filter(a=>!result||a.runId===result.runId);
  const elapsedSec=selectedJob?Math.max(0,(clock-new Date(selectedJob.createdAt).getTime())/1000):0;

  useEffect(()=>{
    if(!isTauriRuntime())return;
    let live=true;
    const status=(event:Event)=>setSummary((event as CustomEvent<OAuthProfileSummary>).detail);
    window.addEventListener(COLAB_STATUS_EVENT,status);
    void loadColabSummary().then(s=>{if(live)setSummary(s)}).catch(()=>undefined);
    return()=>{live=false;window.removeEventListener(COLAB_STATUS_EVENT,status)};
  },[]);
  useEffect(()=>{
    if(!isTauriRuntime())return;
    let live=true;
    const refresh=()=>{void loadColabJobs(experimentId).then(jobs=>{
      if(!live)return;
      const fst=jobs.filter(j=>j.protocol==="forced_swim"&& !j.training && !j.diagnostic);
      const preferred=fst.find(j=>j.status==="running"||j.status==="queued")??fst.find(j=>j.resultsReady)??fst[0];
      setHistory(fst);setSelectedJobId(id=>id&&fst.some(j=>j.jobId===id)?id:preferred?.jobId??null);
      setClock(Date.now());
    }).catch(()=>undefined)};
    refresh();const timer=window.setInterval(refresh,2000);
    return()=>{live=false;window.clearInterval(timer)};
  },[experimentId]);
  useEffect(()=>{
    setResult(null);setManifest(null);setArtifacts([]);setLabeledVideo(null);setLabeledVideoError(null);
    if(!selectedJobId || !selectedJob?.resultsReady)return;
    let live=true;setLoadingResult(true);
    void loadColabResult(selectedJobId).then(parseFstResult).then(data=>{if(experiment?.video.sha256 && data.video.originalSha256!==experiment.video.sha256)throw new Error("O resultado não corresponde ao vídeo original do experimento.");return data}).then(data=>{if(live){setResult(data);setTime(0);setSelectedAnimal(data.subjects[0]?.animalId??"animal_1");setError(null)}})
      .catch(reason=>{if(live)setError(`Não foi possível abrir o resultado FST: ${String(reason)}`)})
      .finally(()=>{if(live)setLoadingResult(false)});
    void loadColabVideo(selectedJobId).then(v=>{if(live){setLabeledVideo(v.videoUrl);setLabeledVideoError(v.videoError)}}).catch(reason=>{if(live)setLabeledVideoError(String(reason))});
    void loadFstArtifacts(selectedJobId).then(files=>{if(live)setArtifacts(files)}).catch(()=>undefined);
    void loadFstManifest(selectedJobId).then(value=>{if(live)setManifest(value)}).catch(()=>undefined);
    return()=>{live=false};
  },[selectedJobId,selectedJob?.resultsReady,experiment?.video.sha256]);
  useEffect(()=>{
    if(!experiment?.video.preparation||!isTauriRuntime())return;
    let live=true;
    void loadStagedVideo(experimentId,experiment.video.preparation.uploadId).then(url=>{if(live)setVideoUrl(url)}).catch(()=>undefined);
    return()=>{live=false};
  },[experimentId,experiment?.video.preparation]);
  const originalUrl=asset?.objectUrl??videoUrl;
  const run=async(file?:File)=>{
    if(!experiment||busy||active)return;
    setView("runs");
    if(!isTauriRuntime()){setError("A análise FST requer o aplicativo desktop.");return}
    const validation=validateForcedSwim(experiment);if(validation){setError(validation);return}
    let preparation=file?undefined:experiment.video.preparation;
    if(preparation&&preparation.originalBytes>100_000_000&&preparation.policyVersion!=="quality-upload-2")preparation=undefined;
    if(preparation&&!await checkVideoStaging(experimentId,preparation.uploadId))preparation=undefined;
    if(!preparation&&!file){fileRef.current?.click();return}
    setBusy(true);setError(null);setMessage("Validando conexão com o Colab");
    let started=false;
    try{
      const connection=await loadColabSummary();setSummary(connection);
      if(!connection.connected)throw new Error("Conecte o Colab antes de executar o FST.");
      if(connection.providerError)throw new Error(connection.providerError);
      if(connection.eligibleGpuCount<1)throw new Error("Nenhuma GPU elegível disponível.");
      if(!preparation){
        const prepared=await prepareFstVideo(experimentId,file!,experiment.video,(_p,m)=>setMessage(m),experiment.video.sha256);
        preparation=prepared.preparation;
        const digest=prepared.originalSha256;
        if(experiment.video.sha256&&digest!==experiment.video.sha256)throw new Error("O arquivo selecionado não corresponde ao vídeo original deste experimento.");
        if(asset?.objectUrl)URL.revokeObjectURL(asset.objectUrl);
        setAsset(experimentId,{...asset,file:file!,objectUrl:URL.createObjectURL(file!)});
        updateForcedSwimExperiment(experimentId,current=>({video:{...current.video,preparation,sha256:digest}}));
      }
      const job=await startFstJob(experiment,preparation);
      started=true;
      updateForcedSwimExperiment(experimentId,{status:"processing"});
      setHistory(current=>[job,...current.filter(j=>j.jobId!==job.jobId)]);setSelectedJobId(job.jobId);
      const done=await waitForColabJob(job.jobId,j=>{setHistory(current=>[j,...current.filter(v=>v.jobId!==j.jobId)]);setMessage(j.message)});
      if(done.status==="failed"&&!done.resultsReady)throw new Error(done.error||"Falha no processamento FST.");
      const data=parseFstResult(await loadColabResult(done.jobId));
      if(experiment.video.sha256&&data.video.originalSha256!==experiment.video.sha256)throw new Error("O resultado não corresponde ao vídeo original do experimento.");
      setResult(data);
      setView("results");
      updateForcedSwimExperiment(experimentId,{status:"review",trackingSelection:{engine:"colab",jobId:done.jobId}});
      if(done.status==="failed")setError(`Dados preservados; execução interrompida: ${done.error}`);
    }catch(reason){setError(String(reason));if(started)updateForcedSwimExperiment(experimentId,{status:"failed"})}
    finally{setBusy(false)}
  };
  const attach=(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0];event.target.value="";if(!file||!experiment)return;
    if(file.size!==experiment.video.sizeBytes||file.name!==experiment.video.filename){setError("Selecione o mesmo arquivo de vídeo usado para criar o experimento.");return}
    void run(file);
  };
  const seek=(seconds:number)=>{const next=Math.max(0,Math.min(result?.video.frameCount? (result.video.frameCount-1)/result.video.fps:experiment?.video.durationSec??0,seconds));if(playerRef.current)playerRef.current.currentTime=next;setTime(next)};
  const annotate=()=>{
    if(!experiment||!result||!Number.isFinite(startSec)||!Number.isFinite(endSec)||startSec<0||endSec<=startSec||endSec>result.video.frameCount/result.video.fps){setError("Selecione um intervalo válido dentro do vídeo.");return}
    const event:FstAnnotation={id:crypto.randomUUID(),animalId:selectedAnimal,startSec,endSec,label,source:"manual",analysisVersion:FST_VERSION,createdAt:new Date().toISOString(),runId:result.runId};
    updateForcedSwimExperiment(experimentId,current=>({annotations:[...current.annotations,event]}));setError(null);
  };
  if(!experiment)return <div className="page not-found"><h1>Experimento não encontrado</h1><Button onClick={()=>navigate({name:"dashboard"})}>Voltar</Button></div>;
  const useOriginal=Boolean(originalUrl);
  return <div className="page results-page fst-results">
    <input ref={fileRef} type="file" accept="video/*" className="sr-only" onChange={attach}/>
    <button className="back-link" onClick={()=>navigate({name:"dashboard"})}><ArrowLeft size={16}/> Experimentos</button>
    <section className="page-heading results-heading"><div><div className="eyebrow">Análise Completa · Forced Swim Test</div><h1>{experiment.title}</h1><p>{experiment.subjects.map(s=>`${s.animalId}: ${s.subjectId}`).join(" · ")} · {experiment.video.filename}</p></div>
      <div className="results-actions"><Button disabled={busy||Boolean(active)||!summary.connected} onClick={()=>void run()}>{busy||active?"Processando…":"Analisar no Colab"}</Button></div></section>
    {error&&<div role="alert" className="validation-box invalid"><Info size={16}/>{error}</div>}
    <EditorTabs<"results"|"runs"> id="fst-view" label="Áreas da análise FST" value={visibleView} onChange={setView}
      items={selectedJob?.resultsReady?[{id:"results",label:"Resultados"},{id:"runs",label:"Execuções"}]:[{id:"runs",label:"Execuções"}]}/>
    {visibleView==="runs"&&<div className="fst-runs-content" role="tabpanel" id="fst-view-runs-panel" aria-labelledby="fst-view-runs-tab">
      <section className="fst-history" aria-label="Execuções realizadas">
        {history.length ? history.map((job) => (
          <button type="button" key={job.jobId} className={job.jobId===selectedJobId?"active":""}
            aria-pressed={job.jobId===selectedJobId}
            onClick={()=>{if(job.jobId!==selectedJobId){setResult(null);setSelectedJobId(job.jobId)}}}>
            <strong>{new Date(job.createdAt).toLocaleString("pt-BR")}</strong>
            <span>{jobStatus(job.status)} · {job.jobId.slice(0,8)}</span>
          </button>
        )) : <p>Nenhuma execução registrada.</p>}
      </section>
      {(selectedJob||busy)&&<AnalysisWorkflow job={selectedJob} protocol="forced_swim" logOnly preparing={busy&&!selectedJob} message={message} localError={error} elapsedSec={elapsedSec}/>}
    </div>}
    {visibleView==="results"&&<div className="fst-result-content" role="tabpanel" id="fst-view-results-panel" aria-labelledby="fst-view-results-tab">
    {loadingResult&&<p role="status">Carregando dados FST da execução…</p>}
    {result&&<>
      <section className="fst-player-panel"><div className="panel-header"><div><h2>Vídeo e observações</h2><p>{useOriginal?"Vídeo original com overlays sincronizados":"MP4 anotado da execução"} · {result.video.width} × {result.video.height} · {result.video.fps.toFixed(3)} FPS</p></div></div>
        <div className="fst-player" style={{aspectRatio:`${result.video.width}/${result.video.height}`}}>
          {(originalUrl||labeledVideo)?<video ref={playerRef} src={originalUrl||labeledVideo||undefined} controls onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onSeeked={e=>setTime(e.currentTarget.currentTime)}/>:<div className="fst-player-empty">Vídeo indisponível neste dispositivo. {labeledVideoError||"Os dados por frame permanecem abaixo."}</div>}
          {useOriginal&&<svg className="fst-overlay" viewBox={`0 0 ${result.video.width} ${result.video.height}`} preserveAspectRatio="none" aria-label="Caixas e pontos sincronizados">
            {frameData.map((item,i)=>item.presence==="IN_TANK"?<g key={item.animalId}>
              {showBoxes&&item.bbox&&<rect x={item.bbox.x} y={item.bbox.y} width={item.bbox.width} height={item.bbox.height} fill="none" stroke={i?"#e9b85c":"#51ddce"} strokeWidth={Math.max(2,result.video.width/500)}/>}
              {showPoints&&framePoses.filter(p=>p.animalId===item.animalId&&displayableFstPose(p,result.tanks[i],item.presence)).map((p,k)=><circle key={k} cx={p.xPx!} cy={p.yPx!} r={Math.max(2,result.video.width/350)} fill={i?"#e9b85c":"#51ddce"}/>)}
              <text x={item.bbox?.x??result.tanks[i].roiPx.x} y={Math.max(22,(item.bbox?.y??result.tanks[i].roiPx.y)-8)} fill="#fff" stroke="#111" strokeWidth="3" paintOrder="stroke" fontSize={Math.max(15,result.video.width/75)}>{item.animalId}</text>
            </g>:<text key={item.animalId} x={result.tanks[i].roiPx.x+5} y={result.tanks[i].roiPx.y+22} fill={item.presence==="UNCERTAIN"?"#e9b85c":"#bbb"} stroke="#111" strokeWidth="3" paintOrder="stroke" fontSize={Math.max(15,result.video.width/75)}>{item.animalId}: {item.presence}</text>)}
          </svg>}
        </div>
        <div className="fst-player-controls"><Button variant="secondary" onClick={()=>seek(time-1/result.video.fps)} icon={<SkipBack size={15}/>}>Frame anterior</Button><Button variant="secondary" onClick={()=>{const p=playerRef.current;if(!p)return;if(p.paused)void p.play();else p.pause()}} icon={playerRef.current?.paused?<Play size={15}/>:<Pause size={15}/>}>Pausar / reproduzir</Button><Button variant="secondary" onClick={()=>seek(time+1/result.video.fps)} icon={<SkipForward size={15}/>}>Próximo frame</Button><span>Frame {frame+1}/{result.video.frameCount} · {time.toFixed(2)} s</span></div>
        <input className="fst-seek" type="range" min="0" max={result.video.frameCount-1} step="1" value={frame} aria-label="Buscar frame" onChange={e=>seek(Number(e.target.value)/result.video.fps)}/>
        <div className="fst-visibility"><label><input type="checkbox" checked={showBoxes} onChange={e=>setShowBoxes(e.target.checked)}/> Caixas dinâmicas</label><label><input type="checkbox" checked={showPoints} onChange={e=>setShowPoints(e.target.checked)}/> Pontos anatômicos</label></div>
        {!useOriginal&&<p className="fst-note">A visibilidade das caixas e pontos no MP4 anotado é fixa. Reanexe o vídeo original para controlar os overlays.</p>}
      </section>
      <section className="fst-animals"><h2>Resultados por animal</h2><div className="fst-animal-tabs">{result.subjects.map(s=><button key={s.animalId} className={selectedAnimal===s.animalId?"active":""} onClick={()=>setSelectedAnimal(s.animalId)}>{s.animalId} · {s.subjectId}</button>)}</div>
        {result.subjects.map(s=>{const values=result.frames.filter(f=>f.animalId===s.animalId);const confirmed=values.filter(f=>f.presence==="IN_TANK");const quality=result.quality[s.animalId];const bins=Array.from({length:Math.min(120,values.length)},(_,i)=>values[Math.min(values.length-1,Math.floor(i*values.length/Math.min(120,values.length)))]);
          return <article key={s.animalId} className={`fst-animal-card ${selectedAnimal===s.animalId?"selected":""}`}>
            <h3>{s.animalId} · {s.subjectId}</h3><div className="fst-metrics"><div><span>Tempo de vídeo</span><strong>{formatDuration(result.video.frameCount/result.video.fps)}</strong></div><div><span>Presença confirmada</span><strong>{formatDuration(quality?.presenceSec??0)}</strong></div><div><span>Cobertura anatômica com presença</span><strong>{((quality?.anatomicalCoverage??0)*100).toFixed(1)}%</strong></div><div><span>Movimento corporal relativo</span><strong>{showNumber(mean(confirmed.map(f=>f.relativeMotion)))}</strong><small>diagonais da ROI/s · observado</small></div><div><span>Alteração de silhueta</span><strong>{showNumber(mean(confirmed.map(f=>f.silhouetteChange)))}</strong><small>fração/s · observado</small></div><div><span>Movimento do centro corporal</span><strong>{showNumber(mean(confirmed.map(f=>f.centroidMotion)))}</strong><small>diagonais da ROI/s · observado</small></div><div><span>Dados insuficientes</span><strong>{formatDuration(quality?.insufficientDataSec??0)}</strong></div><div><span>Classificação automática</span><strong>NOT_CLASSIFIED</strong></div></div>
            <div className="fst-timeline-label">Presença</div><div className="fst-timeline" role="img" aria-label={`Presença temporal de ${s.animalId}`}>{bins.map((item,i)=><button key={i} type="button" title={`${item.timestampSec.toFixed(1)} s · ${item.presence}`} style={{background:presenceColor[item.presence]}} onClick={()=>seek(item.timestampSec)}/>)}</div>
            <div className="fst-timeline-label">Atividade visual</div><div className="fst-timeline" role="img" aria-label={`Atividade observada de ${s.animalId}`}>{bins.map((item,i)=><button key={i} type="button" title={`${item.timestampSec.toFixed(1)} s · ${item.presence==="IN_TANK"?(item.relativeMotion===null?"tracking insuficiente":`movimento relativo ${item.relativeMotion.toFixed(3)}`):item.presence}`} style={{background:item.presence!=="IN_TANK"?presenceColor[item.presence]:item.relativeMotion===null?"#87749b":"#27b98f",opacity:item.presence==="IN_TANK"&&item.relativeMotion!==null?Math.min(1,.35+item.relativeMotion*4):1}} onClick={()=>seek(item.timestampSec)}/>)}</div><div className="fst-timeline-legend"><span>● Presente</span><span>● Ausente</span><span>● Incerto</span><span className="tracking-gap">● Tracking insuficiente</span></div>
            {selectedAnimal===s.animalId&&<p className="fst-note">A intensidade da segunda faixa representa atividade visual observada; roxo indica tracking insuficiente. Nenhuma faixa equivale a imobilidade, natação ou escalada classificadas.</p>}
            {selectedAnimal===s.animalId&&(result.insufficientIntervals[s.animalId]?.length??0)>0&&<div className="fst-insufficient-list"><h4>Intervalos de tracking insuficiente</h4>{result.insufficientIntervals[s.animalId].slice(0,20).map((gap,i)=><button key={i} onClick={()=>seek(gap.startSec)}>{gap.startSec.toFixed(1)}–{gap.endSec.toFixed(1)} s</button>)}{result.insufficientIntervals[s.animalId].length>20&&<small>Mais {result.insufficientIntervals[s.animalId].length-20} intervalos no resultado exportado.</small>}</div>}
          </article>})}
      </section>
      <section className="fst-review-panel"><h2>Revisão humana</h2><p>Marque trechos para revisão. Cada evento mantém sujeito, intervalo, autor manual, versão e execução.</p><div className="fst-annotation-form"><label>Início (s)<input type="number" min="0" step="0.1" value={startSec} onChange={e=>setStartSec(Number(e.target.value))}/></label><label>Fim (s)<input type="number" min="0" step="0.1" value={endSec} onChange={e=>setEndSec(Number(e.target.value))}/></label><label>Rótulo<select value={label} onChange={e=>setLabel(e.target.value as FstBehavior)}>{labels.map(v=><option key={v} value={v}>{v}</option>)}</select></label><Button onClick={annotate}>Registrar intervalo</Button></div>
        <div className="fst-review-shortlist"><h3>Trechos sugeridos para revisão</h3>{result.reviewShortlist.filter(item=>item.animalId===selectedAnimal).slice(0,16).map(item=><button key={`${item.animalId}-${item.startSec}`} onClick={()=>{seek(item.startSec);setStartSec(item.startSec);setEndSec(item.endSec)}}>{item.startSec.toFixed(1)}–{item.endSec.toFixed(1)} s · {item.reason==="LOWER_OBSERVED_MOTION"?"Menor movimento observado":item.reason==="HIGHER_OBSERVED_MOTION"?"Maior movimento observado":"Tracking insuficiente"} <ArrowRight size={14}/></button>)}{result.frames.filter(f=>f.animalId===selectedAnimal&&f.presence==="UNCERTAIN").filter((_,i)=>i%Math.max(1,Math.round(result.video.fps))===0).slice(0,5).map(f=><button key={`uncertain-${f.frame}`} onClick={()=>{seek(f.timestampSec);setStartSec(f.timestampSec);setEndSec(Math.min(result.video.frameCount/result.video.fps,f.timestampSec+1))}}>{f.timestampSec.toFixed(1)} s · Presença incerta <ArrowRight size={14}/></button>)}</div>
        <ol className="fst-annotations">{annotations.map(a=><li key={a.id}><strong>{a.animalId} · {a.label}</strong><span>{a.startSec.toFixed(1)}–{a.endSec.toFixed(1)} s · manual · {new Date(a.createdAt).toLocaleString("pt-BR")}</span></li>)}</ol>
      </section>
      <section className="fst-exports"><h2>Exportações FST</h2><p>Arquivos da execução selecionada, separados das métricas de Campo Aberto.</p><div>{artifacts.map(file=><a key={file.name} href={file.url} download={file.name}><Download size={15}/>{file.name}</a>)}{labeledVideo&&<a href={labeledVideo} download="fst_annotated.mp4"><Download size={15}/>MP4 anotado</a>}</div><Button variant="secondary" disabled={!manifest} onClick={()=>downloadText(`fst-${result.runId}-manifest-reviewed.json`,JSON.stringify({...manifest,reviewExportedAt:new Date().toISOString(),manualAnnotations:annotations},null,2),"application/json")}>Exportar manifesto com revisão humana</Button></section>
    </>}
    </div>}
  </div>;
}
