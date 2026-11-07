import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { provisionalBoxAt } from "../../lib/boxes";
import { downloadText, poseToCsv } from "../../lib/csv";
import { pointsToSvg } from "../../lib/geometry";
import { localGuidance, usableLocalGuidance } from "../../lib/manual-guidance";
import { trajectorySegments } from "../../lib/pose";
import type { BoundingBox, Experiment, PoseSample } from "../../types";
import { BoxOverlay } from "../tracking/BoxOverlay";
import { resolveDiagnosticUpload } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { cancelLocalTracking, listLocalJobs, loadLocalResult, localEnvironment, localFrameIndex, localUpdates, setupLocalEnvironment, startLocalTracking, type LocalConfig, type LocalJob } from "./api";
import "./local.css";

export function LocalTrackingPanel({experiment,file,videoUrl,open,onAttach,onBusy,onUse,variant="classic"}: {
  experiment:Experiment;file?:File;videoUrl?:string;open:boolean;onAttach:()=>void;onBusy:(busy:boolean)=>void;onUse:(job:LocalJob,samples:PoseSample[])=>void;variant?:"classic"|"hybrid";
}) {
  const hybrid=variant==="hybrid";
  const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const [jobs,setJobs]=useState<LocalJob[]>([]),[selected,setSelected]=useState<string|null>(null),[samples,setSamples]=useState<PoseSample[]>([]);
  const [mode,setMode]=useState<"light"|"dark"|"background">(hybrid?"background":"light"),[threshold,setThreshold]=useState(hybrid?25:190),[approved,setApproved]=useState(false);
  const [initialBox,setInitialBox]=useState<BoundingBox|null>(null),[drawing,setDrawing]=useState(false),[background,setBackground]=useState<number|null>(null),[time,setTime]=useState(0),[playing,setPlaying]=useState(false);
  const [minArea,setMinArea]=useState(.001),[maxArea,setMaxArea]=useState(.12),[maxWidth,setMaxWidth]=useState(hybrid?640:1280);
  const video=useRef<HTMLVideoElement>(null),svg=useRef<SVGSVGElement>(null),cursor=useRef(0),loaded=useRef<string|null>(null),staged=useRef(experiment.video.preparation?.uploadId);
  const visibleJobs=jobs.filter(item=>hybrid?item.config.strategy==="hybrid_kalman_v1":item.config.strategy!=="hybrid_kalman_v1");
  const job=visibleJobs.find(j=>j.jobId===selected)??visibleJobs[0];
  const active=jobs.some(j=>["running","queued"].includes(j.state));
  const jobActive=!!job&&["running","queued"].includes(job.state);
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
        const matching=items.filter(item=>hybrid?item.config.strategy==="hybrid_kalman_v1":item.config.strategy!=="hybrid_kalman_v1");
        const current=matching.find(j=>j.jobId===selected)??matching[0];if(!current)return;
        if(loaded.current!==current.jobId){loaded.current=current.jobId;cursor.current=0;setSamples([]);}
        const added:PoseSample[]=[];
        for(let i=0;i<16;i++){const update=await localUpdates(current.jobId,cursor.current);if(stopped)return;cursor.current=update.offset;added.push(...update.samples);if(update.samples.length<256)break;}
        if(added.length)setSamples(old=>[...old,...added]);
      }catch(e){if(!stopped)setError(String(e));}finally{inFlight=false;}
    };
    void poll();const timer=window.setInterval(()=>void poll(),750);return()=>{stopped=true;window.clearInterval(timer);};
  },[open,active,experiment.id,selected,hybrid]);
  const action=async(work:()=>Promise<void>)=>{setBusy(true);setError("");try{await work();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const current=samples.reduce<PoseSample|undefined>((best,sample)=>Math.abs(sample.timestampSec-time)<Math.abs((best?.timestampSec??Infinity)-time)?sample:best,undefined);
  const visible=current&&Math.abs(current.timestampSec-time)<.1&&current.xPx!=null&&current.yPx!=null;
  const trajectory=trajectorySegments(samples.filter(s=>s.timestampSec<=time).slice(-150));
  const guidance=localGuidance(experiment);
  const canContinue=usableLocalGuidance(guidance);
  const continueSpan=guidance?.anchors.length ? guidance.anchors.at(-1)!.timestampSec-guidance.anchors[0].timestampSec : 0;
  const saveInitialBox=(box:BoundingBox,provisional=false)=>{
    setInitialBox(box);
    setDrawing(false);
    setMessage(provisional
      ? "Caixa provisória posicionada. Arraste a caixa e seus cantos para ajustar ao animal antes de analisar. O clique não detecta automaticamente a silhueta."
      : "Caixa inicial definida. Confira se ela acompanha somente o animal no primeiro frame antes de analisar.");
  };
  const startAnalysis=(guided:boolean)=>void action(async()=>{
    if(hybrid&&(background==null||!initialBox))throw new Error("Para o teste híbrido, marque a caixa inicial do animal e um frame com a arena realmente vazia.");
    if(guided&&!usableLocalGuidance(guidance))throw new Error("Marque pelo menos duas caixas manuais em frames separados por 1 segundo na revisão OpenCV selecionada.");
    const upload=await resolveDiagnosticUpload(experiment.id,staged.current,file,(_,m)=>setMessage(m));
    if(!upload){onAttach();throw new Error("Selecione o original e inicie novamente");}
    staged.current=upload;
    const sourceJob=guided?jobs.find(item=>item.jobId===guidance!.sourceJobId):undefined;
    const config:LocalConfig={width:experiment.video.width,height:experiment.video.height,arena:experiment.arena,mode:hybrid?"background":mode,threshold,
      minAreaFraction:minArea,maxAreaFraction:maxArea,maxWidth,maxPredictionSec:hybrid ? 0.35 : 0.25,
      strategy:hybrid?"hybrid_kalman_v1":"classic",referenceApproved:hybrid||guided?false:approved,
      initialBox:guided?(sourceJob?.config.initialBox??(guidance!.anchors[0].frameIndex===0?guidance!.anchors[0].box:null)):initialBox,
      backgroundFrameIndex:background,
      ...(guided?{guidance:guidance!}:{}),
    };
    const started=await startLocalTracking(experiment.id,upload,config);
    setJobs(old=>[started,...old]);setSelected(started.jobId);
    setMessage(hybrid?"Teste híbrido iniciado no dispositivo. O resultado permanece separado até você abri-lo para revisão.":guided?"Continuação guiada iniciada. Caixas humanas preservadas; posições automáticas exigem revisão no editor.":"Processando somente neste dispositivo. Resultado anterior preservado até sua seleção.");
  });
  return <section hidden={!open} className="local-tracking-panel panel" aria-label={hybrid?"Teste híbrido OpenCV e Kalman":"Análise local OpenCV"}>
    <div className="local-heading"><div><span className="eyebrow">{hybrid?"Experimento local · CPU · sem modelo neural":"CPU local · sem conta Google"}</span><h2>{hybrid?"Teste híbrido de rastreamento":"Rastrear o animal inteiro"}</h2><p>{hybrid?"Compare o vídeo com um frame da arena vazia. O OpenCV observa a silhueta; o Kalman prevê apenas lacunas curtas. Este teste processa um arquivo, não captura câmera ao vivo.":"Uma caixa ao redor da região visível, sem depender de focinho ou orelhas. Não classifica comportamentos automaticamente."}</p></div>
      {!ready&&<Button disabled={busy||!isTauriRuntime()} onClick={()=>void action(async()=>{setMessage("Preparando ambiente isolado: download de OpenCV, sem modelos de IA. Isso pode levar alguns minutos.");setReady((await setupLocalEnvironment()).ready);setMessage("OpenCV pronto para uso local.");})}>Preparar OpenCV local</Button>}
    </div>
    {!isTauriRuntime()&&<p>Abra o aplicativo desktop com npm run tauri dev para usar o processamento local; a prévia do navegador não executa Python.</p>}
    {hybrid&&<div className="local-hybrid-notice"><strong>O que esta versão testa</strong><span>Fundo fixo + OpenCV + Kalman. Previsões e silhuetas suspeitas não entram nas métricas. A etapa de detector neural/ONNX ainda não está disponível; nenhuma precisão foi validada com os seus vídeos.</span></div>}
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
      {hybrid?<p>Detecção: comparação com arena vazia</p>:<label>Separar animal e fundo<select value={mode} disabled={active} onChange={e=>{const value=e.target.value as typeof mode;setMode(value);setThreshold(value==="background"?25:value==="light"?190:70);}}><option value="light">Animal claro / fundo escuro</option><option value="dark">Animal escuro / fundo claro</option><option value="background">Comparar com caixa vazia</option></select></label>}
      <label>Limiar de contraste · {threshold}<input aria-label="Limiar OpenCV" type="range" min="1" max="254" value={threshold} disabled={active} onChange={e=>setThreshold(e.target.valueAsNumber)}/></label>
      <label>Área mínima · {(minArea*100).toFixed(2)}% da arena<input type="range" min=".0001" max=".02" step=".0001" value={minArea} disabled={active} onChange={e=>setMinArea(e.target.valueAsNumber)}/></label>
      <label>Área máxima · {Math.round(maxArea*100)}% da arena<input type="range" min=".03" max=".4" step=".01" value={maxArea} disabled={active} onChange={e=>setMaxArea(e.target.valueAsNumber)}/></label>
      <label>Resolução de processamento<select value={maxWidth} disabled={active} onChange={e=>setMaxWidth(Number(e.target.value))}><option value={1280}>Até 1280 px de largura</option><option value={4096}>Resolução original (até 4096 px)</option><option value={640}>Até 640 px · teste de velocidade</option></select></label>
      {mode==="background"&&<><Button variant="secondary" disabled={active||!file} onClick={()=>void action(async()=>{const upload=await resolveDiagnosticUpload(experiment.id,staged.current,file,(_,m)=>setMessage(m));if(!upload)throw new Error("Selecione o original");staged.current=upload;setBackground(await localFrameIndex(experiment.id,upload,time));setMessage("Frame de fundo selecionado. Confirme que a caixa estava realmente vazia.");})}>Usar frame atual como fundo vazio</Button><small>{background==null?"Escolha um frame sem animal. Um fundo com o rato gera erros.":`Frame ${background} · fundo fixo`}</small></>}
      {!hybrid&&<><label className="local-consent"><input type="checkbox" checked={approved} disabled={active} onChange={e=>setApproved(e.target.checked)}/> Usar o centro da caixa como referência locomotora 2D experimental. Conferi câmera, contraste e chão; não representa centro anatômico nem altura.</label>
      <small>Sem essa opção, as coordenadas ficam para revisão. Previsões, silhuetas parciais e pontos na parede não entram automaticamente nas métricas, mesmo com a opção marcada.</small></>}
      <Button disabled={!ready||active||busy||hybrid&&(background==null||!initialBox)} onClick={()=>startAnalysis(false)}>{hybrid?"Executar teste híbrido":"Analisar localmente"}</Button>
      {!hybrid&&experiment.trackingSelection?.engine==="opencv"&&<div className="local-guidance">
        <strong>Continuar da revisão manual</strong>
        <p>{guidance?.anchors.length??0} caixas humanas desta execução · {continueSpan.toFixed(1)} s entre a primeira e a última. Caixas interpoladas não contam como exemplos.</p>
        <Button variant="secondary" disabled={!ready||active||busy||!canContinue} onClick={()=>startAnalysis(true)}>Continuar vídeo com caixas manuais</Button>
        <small>Gera uma nova execução sem alterar a anterior. Use ao menos duas caixas marcadas em frames separados por 1 s. O restante é estimativa visual, não resultado validado.</small>
      </div>}
      {jobActive&&<Button variant="secondary" onClick={()=>void action(()=>cancelLocalTracking(job.jobId))}>Cancelar análise local</Button>}
    </section></div>
    {job&&<section className="local-run"><h3>Execução · {job.state}</h3><p>{job.error}</p><progress aria-label="Progresso OpenCV" max={job.report?.totalFrames||1} value={job.state==="succeeded"?(job.report?.totalFrames||1):job.report?.totalFrames?job.report.framesProcessed||0:undefined}/>
      <div className="local-stats"><span>{job.report?.framesProcessed??0} frames</span><span>{(job.report?.elapsedSec??0).toFixed(1)} s decorridos</span><span>{(job.report?.processingFps??0).toFixed(1)} FPS medidos</span><span>{(job.report?.observationCoveragePct??0).toFixed(1)}% com silhueta (não acurácia)</span></div>
      {hybrid&&<p className="local-assisted-stats">Observados: {job.report?.counts?.observed??0} · Previstos: {job.report?.counts?.predicted??0} · Sem rastreamento: {job.report?.counts?.missing??0}. {experiment.video.fps?`Velocidade de processamento ${job.report?.processingFps&&job.report.processingFps>=experiment.video.fps?"acima":"abaixo"} dos ${experiment.video.fps.toFixed(1)} FPS do vídeo (não é latência de câmera ao vivo).`:"FPS original indisponível para comparação."}</p>}
      {job.config.guidance&&<p className="local-assisted-stats">Guiada por {job.report?.manualAnchorCount??job.config.guidance.anchors.length} caixas humanas · {job.report?.counts?.visual??0} correspondências visuais · {job.report?.counts?.missing??0} lacunas. Estimativas exigem revisão.</p>}
      <div className="training-actions"><Button disabled={job.state!=="succeeded"||busy} onClick={()=>void action(async()=>onUse(job,await loadLocalResult(job.jobId)))}>{hybrid?"Abrir resultado para revisão":"Usar resultado local no editor"}</Button><Button variant="secondary" disabled={!samples.length} onClick={()=>downloadText(`opencv-${job.jobId}.csv`,poseToCsv(samples),"text/csv")}>Exportar coordenadas</Button><Button variant="secondary" onClick={()=>downloadText(`opencv-${job.jobId}.json`,JSON.stringify(job,null,2),"application/json")}>Exportar relatório</Button></div>
    </section>}
    {visibleJobs.length>0&&<label className="local-history">{hybrid?"Testes híbridos salvos":"Execuções locais salvas"}<select aria-label={hybrid?"Teste híbrido salvo":"Execução OpenCV salva"} value={job?.jobId??""} onChange={e=>setSelected(e.target.value)}>{visibleJobs.map(j=><option key={j.jobId} value={j.jobId}>{j.createdAt} · {j.state} · {j.config.mode}</option>)}</select></label>}
  </section>;
}
