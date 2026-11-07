import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "../../components/ui/Button";
import { downloadText } from "../../lib/csv";
import type { Experiment, Point } from "../../types";
import { resolveDiagnosticUpload, type ColabJob } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { AnalysisWorkflow } from "../colab/AnalysisWorkflow";
import { annotationErrors, CONTEXTS, emptyKeypoints, LANDMARKS, sampleInterval, type Context, type Landmark, type TrainingFrame, type TrainingInterval } from "./schema";
import { extractTrainingFrame, loadTraining, loadTrainingImage, saveTrainingFrame, saveTrainingIntervals, selectCustomModel, trainOnColab, type TrainingState } from "./api";
import { RangeTimeline } from "./RangeTimeline";
import { timelineTime, type TimelineSelection } from "./timeline";
import "./training.css";

export function TrainingPanel({experiment,file,videoUrl,currentTime,fps,open,onAttach,onSeek,onBusy,onRestaged}: {
  experiment:Experiment; file?:File; videoUrl?:string; currentTime:number; fps:number; open:boolean; onAttach:()=>void; onSeek:(time:number)=>void;
  onBusy:(busy:boolean)=>void; onRestaged:(id:string)=>void;
}) {
  const [state,setState] = useState<TrainingState>({frames:[],intervals:[],runs:[],activeModelId:null});
  const [frame,setFrame] = useState<TrainingFrame|null>(null), [image,setImage] = useState<string|null>(null);
  const [context,setContext] = useState<Context>("walking"), [selection,setSelection] = useState<TimelineSelection|null>(null), [step,setStep] = useState(2);
  const start=selection?.startSec??0,end=selection?.endSec??0;
  const [selected,setSelected] = useState<Landmark>("nose"), [tool,setTool] = useState<"box"|"point">("box");
  const [anchor,setAnchor] = useState<Point|null>(null), [busy,setBusy] = useState(false), [message,setMessage] = useState("");
  const [error,setError] = useState(""), [epochs,setEpochs] = useState(5), [consent,setConsent] = useState(false), [dirty,setDirty] = useState(false);
  const [loadError,setLoadError]=useState("");
  const [clock,setClock] = useState(Date.now());
  const staged = useRef(experiment.video.preparation?.uploadId), svg = useRef<SVGSVGElement>(null);
  const preview=useRef<HTMLVideoElement>(null);
  const seek=(time:number)=>{onSeek(time);if(preview.current){preview.current.pause();preview.current.currentTime=time;}};
  const selectInterval=(interval:TrainingInterval)=>{setSelection({id:interval.id,startSec:interval.startSec,endSec:interval.endSec});setContext(interval.context);setMessage("");seek(interval.startSec);};
  const savedSelection=state.intervals.find((interval)=>interval.id===selection?.id);
  const selectionChanged=!!selection&&(!savedSelection||savedSelection.startSec!==start||savedSelection.endSec!==end||savedSelection.context!==context);
  const trainingJob = state.runs[0]?.job;
  const trainingActive = state.runs.some((r)=>["queued","running"].includes(r.job.status));
  useEffect(()=>{onBusy(trainingActive||busy);},[trainingActive,busy,onBusy]);
  const refresh = async()=>setState(await loadTraining(experiment.id));
  useEffect(()=>{
    if (!isTauriRuntime()) return;
    let stopped=false;
    const poll=()=>void loadTraining(experiment.id).then((s)=>{if(!stopped){setState(s);setClock(Date.now());setLoadError("");}}).catch((e)=>{if(!stopped)setLoadError(`Não foi possível carregar os exemplos salvos: ${String(e)}. Reinicie a versão desktop atualizada.`);});
    poll(); const timer=window.setInterval(poll,3000); return()=>{stopped=true;window.clearInterval(timer);};
  },[experiment.id]);
  const action = async(work:()=>Promise<void>)=>{setBusy(true);setError("");try{await work();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const needDesktop=()=>{if(!isTauriRuntime())throw new Error("Abra o app desktop para salvar imagens e treinar no Colab.");};
  const upload = async()=>{
    needDesktop();const id=await resolveDiagnosticUpload(experiment.id,staged.current,file,(_,m)=>setMessage(m));
    if(!id){onAttach();throw new Error("Selecione o vídeo original e tente novamente. As anotações existentes foram preservadas.");}
    staged.current=id;if(id!==experiment.video.preparation?.uploadId)onRestaged(id);return id;
  };
  const extract = async(time:number)=>{
    const id=await upload();const result=await extractTrainingFrame(experiment.id,id,Math.max(0,Math.round(time*fps)),experiment.subjectId,time);
    setFrame(result.frame.reviewed?result.frame:{...result.frame,context});setImage(result.imageUrl);setDirty(!result.frame.reviewed);setTool("box");await refresh();
  };
  const save = async(reviewed:boolean)=>{
    if(!frame)return;
    if(reviewed){const errors=annotationErrors(frame);if(errors.length)throw new Error(errors[0]);}
    const value={...frame,reviewed,updatedAt:new Date().toISOString()};await saveTrainingFrame(value);setFrame(value);setDirty(false);await refresh();
    setMessage(reviewed?"Exemplo revisado e incluído no conjunto de treino. Só este frame foi rotulado.":"Rascunho salvo; ainda não será enviado ao treinamento.");
  };
  const change=(patch:Partial<TrainingFrame>)=>{if(frame&&!busy){setFrame({...frame,...patch,reviewed:false});setDirty(true);}};
  const pointer=(e:PointerEvent<SVGSVGElement>):Point=>{
    const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return{x:Math.max(0,Math.min(frame!.width,p.x)),y:Math.max(0,Math.min(frame!.height,p.y))};
  };
  const selectFrame=async(value:TrainingFrame)=>{
    if(dirty)throw new Error("Salve o rascunho antes de trocar de frame.");
    setImage(await loadTrainingImage(value.id));setFrame(value);setDirty(false);seek(value.timestampSec);
  };
  const reviewed=state.frames.filter((f)=>f.reviewed).length;
  const elapsed=trainingJob?Math.max(0,((["running","queued"].includes(trainingJob.status)?clock:Date.parse(trainingJob.updatedAt))-Date.parse(trainingJob.createdAt))/1000):0;
  return <section hidden={!open} className="training-panel panel" aria-label="Treinamento personalizado">
    <div className="training-heading"><div><span className="eyebrow">Dataset humano · versões independentes</span><h2>Ensinar o modelo</h2>
      <p>Marque trechos, extraia frames e revise a caixa e cada parte visível. Um ponto marcado em um frame não é copiado para o trecho inteiro.</p></div>
      <strong>{reviewed} exemplos revisados · {state.frames.length-reviewed} rascunhos</strong></div>
    {error&&<p role="alert" className="editor-error">{error}</p>}{message&&<p role="status">{message}</p>}
    {loadError&&<p role="alert" className="editor-error">{loadError}</p>}
    <section className="training-selection-workspace"><h3>1. Selecionar trechos</h3>
      <div className="training-source-row">
        {videoUrl?<video className="training-preview" ref={preview} src={videoUrl} controls muted playsInline onTimeUpdate={(e)=>onSeek(e.currentTarget.currentTime)}/>:<Button variant="secondary" onClick={onAttach}>Selecionar original para reproduzir e anotar</Button>}
        <div><h4>O que o animal está fazendo?</h4><div className="training-contexts">{Object.entries(CONTEXTS).map(([key,label])=><button key={key} disabled={busy} aria-pressed={context===key} onClick={()=>{setContext(key as Context);setMessage("");}}>{label}</button>)}</div>
          <p>Escolha o comportamento e selecione o trecho na timeline abaixo. Os trechos salvos ficam nas faixas coloridas; clique em um para editar.</p>
          <small>Selecionar o trecho apenas organiza os exemplos. O treinamento só começa quando você autorizar e enviar.</small>
        </div>
      </div>
      <RangeTimeline duration={experiment.video.durationSec} fps={fps} currentTime={currentTime} selection={selection} intervals={state.intervals} context={context} disabled={busy} onChange={(value)=>{setSelection(value);setMessage("");}} onSelect={selectInterval} onSeek={seek}/>
      {selectionChanged&&<small className="training-dirty">{selection?.id?"Trecho em edição":"Novo trecho selecionado"} · clique em salvar para manter estas alterações.</small>}
      <div className="training-actions"><Button size="sm" disabled={busy||!selection} onClick={()=>void action(async()=>{
        needDesktop();sampleInterval(start,end,Math.max(.25,end-start),experiment.video.durationSec);
        const interval={id:selection?.id??crypto.randomUUID(),startSec:start,endSec:end,context};
        const intervals=selection?.id?state.intervals.map((i)=>i.id===selection.id?interval:i):[...state.intervals,interval];
        await saveTrainingIntervals(experiment.id,intervals);setSelection({id:interval.id,startSec:start,endSec:end});await refresh();setMessage("Trecho salvo. Os frames ainda precisam ser extraídos e revisados.");
      })}>{selection?.id?"Salvar alterações do trecho":"Salvar trecho"}</Button>
        <Button size="sm" variant="secondary" disabled={busy||!selection} onClick={()=>setSelection(null)}>Novo trecho</Button>
        {selection?.id&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void action(async()=>{await saveTrainingIntervals(experiment.id,state.intervals.filter((i)=>i.id!==selection.id));setSelection(null);await refresh();})}>Remover trecho selecionado</Button>}
      </div>
    </section>
    <div className="training-sections"><section><h4>Preparar os exemplos</h4>
      <div className="training-contexts" role="group" aria-label="Frequência dos exemplos"><span>Um exemplo a cada</span>{[.5,1,2,5].map((seconds)=><button key={seconds} disabled={busy} aria-pressed={step===seconds} onClick={()=>setStep(seconds)}>{seconds.toLocaleString("pt-BR")} s</button>)}</div>
      <div className="training-actions"><Button variant="secondary" disabled={busy||dirty} onClick={()=>void action(async()=>{await extract(currentTime);})}>Anotar frame atual</Button>
        <Button variant="secondary" disabled={busy||dirty||!selection} onClick={()=>void action(async()=>{const times=sampleInterval(start,end,step,experiment.video.durationSec);const id=await upload();for(const [i,time] of times.entries()){setMessage(`Extraindo exemplo ${i+1}/${times.length}`);const result=await extractTrainingFrame(experiment.id,id,Math.max(0,Math.round(time*fps)),experiment.subjectId,time);if(!result.frame.reviewed)await saveTrainingFrame({...result.frame,context,updatedAt:new Date().toISOString()});}await refresh();setMessage("Frames extraídos como rascunhos. Revise cada imagem antes de treinar.");})}>Extrair exemplos do trecho</Button></div>
      <small>Os rótulos de comportamento são contexto; este treino aprende caixa e pontos, não classifica comportamentos automaticamente. Comece com frames variados, não só vizinhos. A extração local pode demorar em vídeos longos.</small>
      <h4>Trechos salvos · {state.intervals.length}</h4>
      {state.intervals.map((interval)=><div className="training-interval" key={interval.id}><button disabled={busy} aria-pressed={selection?.id===interval.id} onClick={()=>selectInterval(interval)}>{CONTEXTS[interval.context]} · {timelineTime(interval.startSec)}–{timelineTime(interval.endSec)}</button></div>)}
    </section><section><h3>2. Revisar exemplos, inclusive frames sem detecção</h3>
      <div className="training-frame-list">{state.frames.map((f)=><button key={f.id} aria-pressed={frame?.id===f.id} disabled={busy} onClick={()=>void action(()=>selectFrame(f))}>Frame {f.frameIndex} · {f.reviewed?"Revisado":"Rascunho"}</button>)}</div>
      {!frame&&<p>Não é necessário ter tracking. Use “Anotar frame atual” para criar pontos mesmo quando nenhum foi detectado.</p>}
      {frame&&image&&<><div className="training-actions"><Button size="sm" variant={tool==="box"?"primary":"secondary"} onClick={()=>setTool("box")}>Desenhar caixa do animal</Button><Button size="sm" variant={tool==="point"?"primary":"secondary"} onClick={()=>setTool("point")}>Posicionar parte selecionada</Button></div>
        {dirty&&<p className="training-dirty">Alterações não salvas · salve o rascunho ou confirme o exemplo antes de trocar de frame.</p>}
        <div className="training-image" style={{aspectRatio:`${frame.width}/${frame.height}`}}><img src={image} alt={`Frame exato ${frame.frameIndex} para anotação`}/>
          <svg ref={svg} viewBox={`0 0 ${frame.width} ${frame.height}`} onPointerDown={(e)=>{if(busy)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const p=pointer(e);setAnchor(p);if(tool==="box"){change({bbox:{...p,width:0,height:0}});}else change({keypoints:{...frame.keypoints,[selected]:{state:"visible",...p}}});}}
            onPointerMove={(e)=>{if(anchor){const p=pointer(e);if(tool==="box")change({bbox:{x:Math.min(anchor.x,p.x),y:Math.min(anchor.y,p.y),width:Math.abs(anchor.x-p.x),height:Math.abs(anchor.y-p.y)}});else change({keypoints:{...frame.keypoints,[selected]:{state:"visible",...p}}});}}} onPointerUp={()=>setAnchor(null)} onPointerCancel={()=>setAnchor(null)}>
            {frame.bbox&&<rect {...frame.bbox} fill="none" stroke="#ac8bff" strokeWidth={3} vectorEffect="non-scaling-stroke"/>}
            {Object.entries(frame.keypoints).filter(([,p])=>p.state==="visible").map(([name,p])=><g key={name}><circle cx={p.x!} cy={p.y!} r={Math.max(4,frame.width/160)} fill={name===selected?"#c7fa60":"#ffca73"} stroke="#111827" strokeWidth="2"/><text x={p.x!+10} y={p.y!-10} fontSize={Math.max(12,frame.width/65)} fill="white">{LANDMARKS[name as Landmark]}</text></g>)}
          </svg></div>
        <p>Frame {frame.frameIndex} · PTS {frame.timestampSec.toFixed(6)} s · {frame.width}×{frame.height}. Caixa: extensão visível do animal. Esquerda/direita são as do animal, não da tela.</p>
        <div className="training-parts">{(Object.keys(LANDMARKS) as Landmark[]).map((name)=><div key={name}><button aria-pressed={selected===name} onClick={()=>{setSelected(name);setTool("point");}}>{LANDMARKS[name]} · {frame.keypoints[name].state==="visible"?"Posicionado":frame.keypoints[name].state==="occluded"?"Não visível":"Não revisado"}</button><button onClick={()=>change({keypoints:{...frame.keypoints,[name]:{state:"occluded",x:null,y:null}}})}>Não visível</button></div>)}</div>
        <p>Não adivinhe posições atrás da parede. “Não visível” ignora a localização no treino. Salvar rascunho não inclui o exemplo no treinamento.</p>
        <div className="training-fields"><label>Contexto<select value={frame.context} onChange={(e)=>change({context:e.target.value as Context})}>{Object.entries(CONTEXTS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>Grupo do vídeo<select value={frame.split} onChange={(e)=>change({split:e.target.value as TrainingFrame["split"]})}><option value="train">Treino</option><option value="validation">Validação independente</option></select></label></div>
        <small>Todos os frames do mesmo vídeo devem usar o mesmo grupo. Para avaliar generalização, reserve também animais independentes.</small>
        <div className="training-actions"><Button variant="secondary" disabled={busy} onClick={()=>void action(()=>save(false))}>Salvar rascunho</Button><Button disabled={busy} onClick={()=>void action(()=>save(true))}>Confirmar exemplo revisado</Button><Button variant="ghost" disabled={busy} onClick={()=>{change({keypoints:emptyKeypoints(),bbox:null});}}>Limpar rótulos deste frame</Button></div>
      </>}
    </section></div>
    <section><h3>3. Treinar uma nova versão no Colab</h3><p>Serão enviados os frames revisados e seus rótulos de todos os experimentos deste dispositivo, acumulando seus exemplos. Cada execução usa um snapshot imutável do dataset. Alterações posteriores ficam para o próximo treino. Não há promessa de melhora automática.</p>
      <p>Dois exemplos permitem testar o fluxo, não demonstram precisão. O treinamento pode demorar; mantenha o app aberto. Separe vídeos e animais para uma avaliação independente.</p>
      <div className="training-fields"><label>Épocas (1–20)<input aria-label="Épocas de treinamento" type="number" min="1" max="20" value={epochs} onChange={(e)=>setEpochs(Number(e.target.value))}/></label></div>
      <label className="training-consent"><input type="checkbox" checked={consent} onChange={(e)=>setConsent(e.target.checked)}/> Autorizo enviar os exemplos revisados de todos os experimentos ao meu Colab e usar GPU para este treinamento experimental.</label>
      <div className="training-actions"><Button disabled={busy||trainingActive||!consent||reviewed<2} onClick={()=>void action(async()=>{needDesktop();await trainOnColab(experiment.id,epochs);await refresh();})}>Enviar exemplos e treinar no Colab</Button>
        <Button variant="secondary" onClick={()=>downloadText(`training-labels-${experiment.id}.json`,JSON.stringify({schemaVersion:1,frames:state.frames,intervals:state.intervals},null,2),"application/json")}>Exportar rótulos JSON</Button></div>
      {trainingJob&&<AnalysisWorkflow job={trainingJob as ColabJob} preparing={false} message="" localError={null} elapsedSec={elapsed}/>}
      {state.runs.map((run)=><article className="training-run" key={run.job.jobId}><strong>{run.job.jobId.slice(0,8)} · {run.job.status} {run.active?"· modelo experimental selecionado":""}</strong><p>{run.job.error||run.job.message}</p>
        {run.report&&<details><summary>Relatório e limitações da avaliação</summary><pre>{JSON.stringify(run.report,null,2)}</pre></details>}
        {run.modelAvailable&&<Button size="sm" variant="secondary" disabled={busy||trainingActive} onClick={()=>void action(async()=>{await selectCustomModel(run.job.jobId);await refresh();})}>Selecionar para teste experimental</Button>}</article>)}
      {state.activeModelId&&<Button variant="ghost" disabled={busy||trainingActive} onClick={()=>void action(async()=>{await selectCustomModel(null);await refresh();})}>Voltar ao SuperAnimal original</Button>}
      <small>Modelo selecionado só altera novas análises. Resultados anteriores não são recalculados. Revise vídeos independentes antes de usar métricas em pesquisa.</small>
    </section>
  </section>;
}
