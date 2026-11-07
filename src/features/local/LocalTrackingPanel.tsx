import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { provisionalBoxAt } from "../../lib/boxes";
import { downloadText, poseToCsv } from "../../lib/csv";
import { pointsToSvg } from "../../lib/geometry";
import { trajectorySegments } from "../../lib/pose";
import type { BoundingBox, Experiment, PoseSample } from "../../types";
import { BoxOverlay } from "../tracking/BoxOverlay";
import { resolveDiagnosticUpload } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { cancelLocalTracking, listLocalJobs, loadLocalResult, localEnvironment, localFrameIndex, localUpdates, setupLocalEnvironment, startLocalTracking, type LocalJob } from "./api";
import "./local.css";

export function LocalTrackingPanel({experiment,file,videoUrl,open,onAttach,onBusy,onUse}: {
  experiment:Experiment;file?:File;videoUrl?:string;open:boolean;onAttach:()=>void;onBusy:(busy:boolean)=>void;onUse:(job:LocalJob,samples:PoseSample[])=>void;
}) {
  const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const [jobs,setJobs]=useState<LocalJob[]>([]),[selected,setSelected]=useState<string|null>(null),[samples,setSamples]=useState<PoseSample[]>([]);
  const [mode,setMode]=useState<"light"|"dark"|"background">("light"),[threshold,setThreshold]=useState(190),[approved,setApproved]=useState(false);
  const [initialBox,setInitialBox]=useState<BoundingBox|null>(null),[drawing,setDrawing]=useState(false),[background,setBackground]=useState<number|null>(null),[time,setTime]=useState(0),[playing,setPlaying]=useState(false);
  const [minArea,setMinArea]=useState(.001),[maxArea,setMaxArea]=useState(.12),[maxWidth,setMaxWidth]=useState(1280);
  const video=useRef<HTMLVideoElement>(null),svg=useRef<SVGSVGElement>(null),cursor=useRef(0),loaded=useRef<string|null>(null),staged=useRef(experiment.video.preparation?.uploadId);
  const job=jobs.find(j=>j.jobId===selected)??jobs[0];
  const active=jobs.some(j=>["running","queued"].includes(j.state));
  useEffect(()=>onBusy(active||busy),[active,busy,onBusy]);
  useEffect(()=>{if(!open)video.current?.pause();},[open]);
  useEffect(()=>{
    const player=video.current;if(!open||!player||!player.requestVideoFrameCallback)return;
    let callback=0,active=true;
    const tick=(_:number,metadata:VideoFrameCallbackMetadata)=>{
      if(!active)return;
      // Uma busca pausada não deve ser revertida pelo frame anterior ainda na fila.
      if(!player.paused&&!player.seeking)setTime(metadata.mediaTime);
      callback=player.requestVideoFrameCallback(tick);
    };
    callback=player.requestVideoFrameCallback(tick);
    return()=>{active=false;player.cancelVideoFrameCallback(callback);};
  },[open,videoUrl]);
  useEffect(()=>{
    if(!open||!isTauriRuntime())return;
    void localEnvironment().then(e=>setReady(e.ready)).catch(e=>setError(String(e)));
  },[open]);
  useEffect(()=>{
    if((!open&&!active)||!isTauriRuntime())return;
    let stopped=false,inFlight=false;
    const poll=async()=>{
      if(inFlight)return;inFlight=true;
      try {
        const items=await listLocalJobs(experiment.id);if(stopped)return;setJobs(items);
        const current=items.find(j=>j.jobId===selected)??items[0];if(!current)return;
        if(loaded.current!==current.jobId){loaded.current=current.jobId;cursor.current=0;setSamples([]);}
        const added:PoseSample[]=[];
        for(let i=0;i<16;i++){const update=await localUpdates(current.jobId,cursor.current);if(stopped)return;cursor.current=update.offset;added.push(...update.samples);if(update.samples.length<256)break;}
        if(added.length)setSamples(old=>[...old,...added]);
      }catch(e){if(!stopped)setError(String(e));}finally{inFlight=false;}
    };
    void poll();const timer=window.setInterval(()=>void poll(),750);return()=>{stopped=true;window.clearInterval(timer);};
  },[open,active,experiment.id,selected]);
  const action=async(work:()=>Promise<void>)=>{setBusy(true);setError("");try{await work();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const current=samples.reduce<PoseSample|undefined>((best,sample)=>Math.abs(sample.timestampSec-time)<Math.abs((best?.timestampSec??Infinity)-time)?sample:best,undefined);
  const visible=current&&Math.abs(current.timestampSec-time)<.1&&current.xPx!=null&&current.yPx!=null;
  const trajectory=trajectorySegments(samples.filter(s=>s.timestampSec<=time).slice(-150));
  const saveInitialBox=(box:BoundingBox,provisional=false)=>{
    setInitialBox(box);
    setDrawing(false);
    setMessage(provisional
      ? "Caixa provisória posicionada. Arraste a caixa e seus cantos para ajustar ao animal antes de analisar. O clique não detecta automaticamente a silhueta."
      : "Caixa inicial definida. Confira se ela acompanha somente o animal no primeiro frame antes de analisar.");
  };
  return <section hidden={!open} className="local-tracking-panel panel" aria-label="Análise local OpenCV">
    <div className="local-heading"><div><span className="eyebrow">CPU local · sem conta Google</span><h2>Rastrear o animal inteiro</h2><p>Uma caixa ao redor da região visível, sem depender de focinho ou orelhas. Não classifica comportamentos automaticamente.</p></div>
      {!ready&&<Button disabled={busy||!isTauriRuntime()} onClick={()=>void action(async()=>{setMessage("Preparando ambiente isolado: download de OpenCV, sem modelos de IA. Isso pode levar alguns minutos.");setReady((await setupLocalEnvironment()).ready);setMessage("OpenCV pronto para uso local.");})}>Preparar OpenCV local</Button>}
    </div>
    {!isTauriRuntime()&&<p>Abra o aplicativo desktop com npm run tauri dev para usar o processamento local; a prévia do navegador não executa Python.</p>}
    {error&&<p role="alert" className="editor-error">{error}</p>}{message&&<p role="status">{message}</p>}
    <div className="local-layout"><div>
      {videoUrl?<div className="local-video-stage" style={{aspectRatio:`${experiment.video.width}/${experiment.video.height}`}}>
        <video ref={video} src={videoUrl} muted playsInline onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}/>
        <svg ref={svg} style={{height:"100%",clipPath:"none"}} viewBox={`0 0 ${experiment.video.width} ${experiment.video.height}`}>
          <polygon points={pointsToSvg(experiment.arena.cornersPx)} fill="none" stroke="#a2b3a5" strokeWidth="2"/>
          {trajectory.map((segment,i)=><polyline key={i} points={pointsToSvg(segment)} fill="none" stroke="#bb9aff" strokeWidth="3"/>)}
          {visible&&!(time<.05&&initialBox)&&<BoxOverlay box={current.bbox} width={experiment.video.width} height={experiment.video.height} drawing={false} editable={false} predicted={current.source==="predicted"} onStart={()=>{}} onCancel={()=>{}} onCommit={()=>{}}/>}
          {time<.05&&<BoxOverlay box={initialBox??undefined} width={experiment.video.width} height={experiment.video.height}
            drawing={!active&&(drawing||!initialBox)} editable={!active} manual
            onStart={()=>video.current?.pause()} onCancel={()=>setDrawing(false)} onCommit={box=>saveInitialBox(box)}
            onPlace={point=>saveInitialBox(provisionalBoxAt(point,experiment.video.width,experiment.video.height),true)}/>}
        </svg>
      </div>:<Button variant="secondary" onClick={onAttach}>Abrir vídeo original para calibrar</Button>}
      {videoUrl&&<div className="local-transport"><Button variant="secondary" size="sm" onClick={()=>{setDrawing(false);if(playing)video.current?.pause();else void video.current?.play().catch(error=>setError(String(error)));}}>{playing?"Pausar":"Reproduzir"}</Button>
        <input aria-label="Percorrer vídeo local" type="range" min="0" max={experiment.video.durationSec} step="0.001" value={time} onChange={event=>{setDrawing(false);const value=event.target.valueAsNumber;if(video.current){video.current.pause();video.current.currentTime=value;}setTime(value);}}/>
        <span>{time.toFixed(2)} s</span></div>}
      <Button variant="secondary" disabled={active||!videoUrl} onClick={()=>{if(video.current){video.current.pause();video.current.currentTime=0;}setTime(0);setDrawing(true);}}>Selecionar caixa inicial do animal</Button>
      <p className="local-note">No primeiro frame, clique no animal para posicionar uma caixa ajustável ou arraste para desenhá-la. Se estiver em outro frame, use “Selecionar caixa inicial” para voltar ao começo. O clique não reconhece automaticamente o contorno.</p>
      {current&&<p>Frame {current.frameIndex} · {current.source==="predicted"?"Previsão incerta, excluída das métricas":current.status==="missing"?"Sem observação":current.status==="low_confidence"?"Silhueta parcial / próxima da parede: revisar":"Silhueta observada"}</p>}
    </div><section className="local-settings">
      <label>Separar animal e fundo<select value={mode} disabled={active} onChange={e=>{const value=e.target.value as typeof mode;setMode(value);setThreshold(value==="background"?25:value==="light"?190:70);}}><option value="light">Animal claro / fundo escuro</option><option value="dark">Animal escuro / fundo claro</option><option value="background">Comparar com caixa vazia</option></select></label>
      <label>Limiar de contraste · {threshold}<input aria-label="Limiar OpenCV" type="range" min="1" max="254" value={threshold} disabled={active} onChange={e=>setThreshold(e.target.valueAsNumber)}/></label>
      <label>Área mínima · {(minArea*100).toFixed(2)}% da arena<input type="range" min=".0001" max=".02" step=".0001" value={minArea} disabled={active} onChange={e=>setMinArea(e.target.valueAsNumber)}/></label>
      <label>Área máxima · {Math.round(maxArea*100)}% da arena<input type="range" min=".03" max=".4" step=".01" value={maxArea} disabled={active} onChange={e=>setMaxArea(e.target.valueAsNumber)}/></label>
      <label>Resolução de processamento<select value={maxWidth} disabled={active} onChange={e=>setMaxWidth(Number(e.target.value))}><option value={1280}>Até 1280 px de largura</option><option value={4096}>Resolução original (até 4096 px)</option><option value={640}>Até 640 px · teste de velocidade</option></select></label>
      {mode==="background"&&<><Button variant="secondary" disabled={active||!file} onClick={()=>void action(async()=>{const upload=await resolveDiagnosticUpload(experiment.id,staged.current,file,(_,m)=>setMessage(m));if(!upload)throw new Error("Selecione o original");staged.current=upload;setBackground(await localFrameIndex(experiment.id,upload,time));setMessage("Frame de fundo selecionado. Confirme que a caixa estava realmente vazia.");})}>Usar frame atual como fundo vazio</Button><small>{background==null?"Escolha um frame sem animal. Um fundo com o rato gera erros.":`Frame ${background} · fundo fixo`}</small></>}
      <label className="local-consent"><input type="checkbox" checked={approved} disabled={active} onChange={e=>setApproved(e.target.checked)}/> Usar o centro da caixa como referência locomotora 2D experimental. Conferi câmera, contraste e chão; não representa centro anatômico nem altura.</label>
      <small>Sem essa opção, as coordenadas ficam para revisão. Previsões, silhuetas parciais e pontos na parede não entram automaticamente nas métricas, mesmo com a opção marcada.</small>
      <Button disabled={!ready||active||busy} onClick={()=>void action(async()=>{
        const upload=await resolveDiagnosticUpload(experiment.id,staged.current,file,(_,m)=>setMessage(m));if(!upload){onAttach();throw new Error("Selecione o original e inicie novamente");}staged.current=upload;
        const started=await startLocalTracking(experiment.id,upload,{width:experiment.video.width,height:experiment.video.height,arena:experiment.arena,mode,threshold,minAreaFraction:minArea,maxAreaFraction:maxArea,maxWidth,maxPredictionSec:.25,referenceApproved:approved,initialBox,backgroundFrameIndex:background});setJobs(old=>[started,...old]);setSelected(started.jobId);setMessage("Processando somente neste dispositivo. Resultado anterior preservado até sua seleção.");
      })}>Analisar localmente</Button>
      {active&&job&&<Button variant="secondary" onClick={()=>void action(()=>cancelLocalTracking(job.jobId))}>Cancelar análise local</Button>}
    </section></div>
    {job&&<section className="local-run"><h3>Execução · {job.state}</h3><p>{job.error}</p><progress aria-label="Progresso OpenCV" max={job.report?.totalFrames||1} value={job.state==="succeeded"?(job.report?.totalFrames||1):job.report?.totalFrames?job.report.framesProcessed||0:undefined}/>
      <div className="local-stats"><span>{job.report?.framesProcessed??0} frames</span><span>{(job.report?.elapsedSec??0).toFixed(1)} s decorridos</span><span>{(job.report?.processingFps??0).toFixed(1)} FPS medidos</span><span>{(job.report?.observationCoveragePct??0).toFixed(1)}% com silhueta (não acurácia)</span></div>
      <div className="training-actions"><Button disabled={job.state!=="succeeded"||busy} onClick={()=>void action(async()=>onUse(job,await loadLocalResult(job.jobId)))}>Usar resultado local no editor</Button><Button variant="secondary" disabled={!samples.length} onClick={()=>downloadText(`opencv-${job.jobId}.csv`,poseToCsv(samples),"text/csv")}>Exportar coordenadas</Button><Button variant="secondary" onClick={()=>downloadText(`opencv-${job.jobId}.json`,JSON.stringify(job,null,2),"application/json")}>Exportar relatório</Button></div>
    </section>}
    {jobs.length>0&&<label className="local-history">Execuções locais salvas<select aria-label="Execução OpenCV salva" value={job?.jobId??""} onChange={e=>setSelected(e.target.value)}>{jobs.map(j=><option key={j.jobId} value={j.jobId}>{j.createdAt} · {j.state} · {j.config.mode}</option>)}</select></label>}
  </section>;
}
