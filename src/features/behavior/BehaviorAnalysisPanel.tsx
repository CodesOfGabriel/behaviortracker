import { SelectMenu } from "../../components/ui/SelectMenu";
import { useEffect, useRef, useState } from "react";
import type { OpenFieldExperiment, TrackingSelection } from "../../types";
import { Button } from "../../components/ui/Button";
import { downloadText } from "../../lib/csv";
import { reviewedEvents } from "../../lib/behavior/events";
import type { BehaviorJob, BehaviorModelStatus, BehaviorResult, BehaviorReview } from "../../lib/behavior/types";
import { isTauriRuntime } from "../colab/connection";
import { listLocalJobs, type LocalJob } from "../local/api";
import { BehaviorAnnotationEditor } from "./BehaviorAnnotationEditor";
import { BehaviorMetricSummary } from "./BehaviorMetricSummary";
import { BehaviorEthogram } from "./BehaviorEthogram";
import { BehaviorEventReview } from "./BehaviorEventReview";
import { annotationContext, appendBehaviorReview, cancelBehavior, cancelBehaviorModelDownload, downloadBehaviorModel, exportBehaviorResults, getBehaviorModelStatus, listBehaviorJobs, listBehaviorReviews, loadBehaviorResult, previewLocalRearingPeaks, renderBehaviorVideo, revealBehaviorExport, setupBehaviorEnvironment, startBehavior, type ApexPreview } from "./api";
import { csvCell } from "../../lib/behavior/validation";
import { useAppStore } from "../../store/AppStore";
import { assertBehaviorSource, selectedBehaviorRun } from "../../lib/behavior/selection";
import { installLocalRearingApexModel } from "./api";

const stateLabels:Record<BehaviorJob["state"],string>={queued:"Na fila",preparing:"Preparando",extracting:"Extraindo imagem e movimento",classifying:"Classificando",decoding:"Organizando episódios",succeeded:"Concluída",cancelled:"Cancelada",failed:"Falhou"};
const terminal=(state:BehaviorJob["state"])=>["succeeded","cancelled","failed"].includes(state);

function BehaviorRun({experiment,jobId}: {experiment:OpenFieldExperiment;jobId:string}) {
  const {updateExperiment}=useAppStore();
  const [tab,setTab]=useState("annotate"), [model,setModel]=useState<BehaviorModelStatus|null>(null), [jobs,setJobs]=useState<BehaviorJob[]>([]);
  const [loadedResult,setResult]=useState<{jobId:string;value:BehaviorResult}|null>(null), [reviews,setReviews]=useState<BehaviorReview[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[modelError,setModelError]=useState<string|null>(null),[modelPath,setModelPath]=useState("");
  const [context,setContext]=useState<Awaited<ReturnType<typeof annotationContext>>|null>(null),[time,setTime]=useState(0);
  const [auditVideo,setAuditVideo]=useState<string|null>(null);
  const [exportUrl,setExportUrl]=useState<string|null>(null);
  const [exportPath,setExportPath]=useState<string|null>(null);
  const [installingModel,setInstallingModel]=useState(false);
  const video=useRef<HTMLVideoElement>(null);
  const studioDialog=useRef<HTMLDialogElement>(null);
  const [studioOpen,setStudioOpen]=useState(false);
  const [apexModelPath,setApexModelPath]=useState("");
  const [apexInstalled,setApexInstalled]=useState(false);
  const [apexPreview,setApexPreview]=useState<ApexPreview|null>(null);
  const [apexFocus,setApexFocus]=useState<number>();
  useEffect(()=>{if(studioOpen&&tab==="annotate"&&!studioDialog.current?.open)studioDialog.current?.showModal();},[studioOpen,tab]);
  const active=jobs.find(job=>!terminal(job.state));
  const digest=experiment.video.sha256!;
  const shown=selectedBehaviorRun(jobs,digest,experiment.behaviorSelections?.[jobId]);
  const result=loadedResult?.jobId===shown?loadedResult.value:null;
  const current=jobs.find(job=>job.jobId===shown);
  function selectRun(id:string) {
    updateExperiment(experiment.id,current=>{
      const selections={...current.behaviorSelections};
      if(id)selections[jobId]={jobId:id,videoSha256:digest};else delete selections[jobId];
      return {behaviorSelections:selections};
    });
  }
  useEffect(()=>{let live=true;void getBehaviorModelStatus().then(value=>{if(live)setModel(value);}).catch(reason=>{if(live)setModelError(String(reason));});return()=>{live=false;};},[]);
  useEffect(()=>{
    let live=true;
    const refresh=()=>void listBehaviorJobs(experiment.id,jobId).then(value=>{if(live)setJobs(value.filter(job=>job.videoSha256===digest));}).catch(reason=>{if(live)setError(String(reason));});
    refresh();const timer=window.setInterval(refresh,2000);return()=>{live=false;clearInterval(timer);};
  },[experiment.id,jobId,digest]);
  useEffect(()=>{
    let live=true;setResult(null);setReviews([]);setAuditVideo(null);setExportUrl(null);setExportPath(null);
    if(!shown||jobs.find(job=>job.jobId===shown)?.state!=="succeeded")return;
    void Promise.all([loadBehaviorResult(shown),listBehaviorReviews(shown),annotationContext(experiment.id,jobId,digest)])
      .then(([value,history,ctx])=>{if(live){assertBehaviorSource(value,experiment.id,jobId,digest);setResult({jobId:shown,value});setReviews(history);setContext(ctx);}})
      .catch(reason=>{if(live)setError(String(reason));});
    return()=>{live=false;};
  },[shown,jobs.find(job=>job.jobId===shown)?.state,experiment.id,jobId,digest]);
  async function operation(action:()=>Promise<void>){setBusy(true);setError(null);try{await action();}catch(reason){setError(String(reason));}finally{setBusy(false);}}
  function seek(value:number){if(video.current){video.current.pause();video.current.currentTime=value;setTime(value);}}
  const events=result?reviewedEvents(result.events,reviews):[];
  async function review(event:BehaviorReview){await appendBehaviorReview(shown,event);setReviews(old=>[...old,event]);}
  useEffect(()=>{if(tab!=="review")video.current?.pause();},[tab]);
  return <>
    <div className="behavior-subtabs" role="tablist" aria-label="Trabalho com rearing">{[["annotate","1. Anotar vídeo"],["detect","2. Detecção automática"],["review","3. Resultados e revisão"]].map(([value,label])=><button key={value} type="button" id={`behavior-${value}-tab`} role="tab" aria-selected={tab===value} aria-controls={`behavior-${value}-panel`} onClick={()=>setTab(value)}>{label}</button>)}</div>
    {error&&<p role="alert" className="validation-box invalid">{error}</p>}
    <div role="tabpanel" id="behavior-annotate-panel" aria-labelledby="behavior-annotate-tab" hidden={tab!=="annotate"} className="behavior-studio-entry">
      <h3>Marque os episódios diretamente no vídeo</h3><p>Pressione R no ápice do rearing, escolha o tipo à direita e salve. Você também pode avançar por frame ou anotar intervalos completos. O estúdio abre em uma área ampla para manter vídeo e controles juntos.</p>
      <Button onClick={()=>{studioDialog.current?.showModal();setStudioOpen(true);}}>Abrir estúdio de anotação</Button>
      <p className="behavior-help">As anotações são salvas neste computador e podem ser exportadas para treinamento. Você pode começar sem instalar um modelo de rearing.</p>
      <dialog ref={studioDialog} className="behavior-studio-modal" aria-labelledby="behavior-studio-title" onClose={()=>setStudioOpen(false)}>
        <header><div><div className="eyebrow">Campo aberto · anotação humana</div><h2 id="behavior-studio-title">Estúdio de rearing</h2></div><Button variant="secondary" size="sm" onClick={()=>studioDialog.current?.close()}>Fechar estúdio</Button></header>
        <BehaviorAnnotationEditor key={`${experiment.id}:${jobId}:${digest}`} experimentId={experiment.id} trackingJobId={jobId} videoSha256={digest} videoId={experiment.id} width={experiment.video.width} height={experiment.video.height} animalId={experiment.subjectId} active={studioOpen} focusTime={apexFocus}/>
      </dialog>
    </div>
    {tab==="detect"&&<div role="tabpanel" id="behavior-detect-panel" aria-labelledby="behavior-detect-tab" className="behavior-detection">
      <section aria-label="Detecção local de ápices"><h3>Localizar ápices com o modelo local</h3>
        <p>Modelo experimental treinado com ápices humanos. As propostas exigem revisão e preservam a incerteza do tracking. A entrada do pesquisador encerra as propostas.</p>
        <label>Pasta do modelo de ápices<input value={apexModelPath} onChange={e=>{setApexModelPath(e.target.value);setApexInstalled(false);}} placeholder="Pasta model com manifest.json e peak_model.json"/></label>
        <Button variant="secondary" loading={busy} disabled={Boolean(active)||!apexModelPath.trim()} onClick={()=>void operation(async()=>{setApexPreview(null);setApexPreview(await previewLocalRearingPeaks(experiment.id,jobId,digest,apexModelPath));})}>Detectar ápices com modelo local</Button>
        <Button variant="secondary" loading={busy} disabled={Boolean(active)||!apexModelPath.trim()} onClick={()=>void operation(async()=>{await installLocalRearingApexModel(apexModelPath);setApexInstalled(true);})}>Usar nas próximas análises locais e Colab</Button>
        {apexInstalled&&<p role="status">Modelo selecionado para novas análises de Campo Aberto. As propostas de rearing continuam pendentes de revisão.</p>}
        {apexPreview&&<><p role="status">{apexPreview.candidates.length} propostas · {apexPreview.message}</p>
          {apexPreview.sameTrainingVideo&&<p>Este vídeo participou do treinamento. As propostas abaixo não medem precisão em um vídeo independente.</p>}
          {apexPreview.trackingTermination&&<p>Propostas encerradas em {apexPreview.trackingTermination.timestampSec.toFixed(2)} s: entrada do pesquisador.</p>}
          <details><summary>Revisar propostas de ápices</summary><div className="behavior-interval-list">{apexPreview.candidates.map(candidate=><Button variant="secondary" size="sm" key={candidate.frameIndex} onClick={()=>{setApexFocus(candidate.timestampSec);setTab("annotate");setStudioOpen(true);}}>{candidate.timestampSec.toFixed(3)} s · score {(candidate.score*100).toFixed(0)}%{candidate.observation!=="OBSERVED"?" · tracking incerto":""}</Button>)}</div></details>
        </>}
      </section>
      <details><summary>Classificador de episódios completos e duração</summary>
      <h3>Classificar rearing neste computador</h3><p>O classificador reutiliza o tracking selecionado e analisa imagem, geometria e movimento ao longo do tempo. O resultado é independente dos indicadores de locomoção.</p>
      {modelError&&<p role="alert">{modelError}</p>}
      <div className="behavior-model-status"><strong>{model?.installed?`Modelo instalado · ${model.manifest.modelVersion}`:"Modelo supervisionado ainda não disponível"}</strong><p>{model?.installed?`${model.manifest.sampleRateHz} Hz · CPU · ${model.manifest.architecture}`:"Comece anotando o vídeo na primeira aba. As anotações serão usadas para treinar e validar o modelo."}</p></div>
      <details><summary>Preparar ambiente e instalar modelo</summary><p>O ambiente CPU é separado do rastreador. A primeira preparação baixa ONNX Runtime e OpenCV.</p>
        <Button variant="secondary" loading={busy} disabled={Boolean(active)} onClick={()=>void operation(async()=>{await setupBehaviorEnvironment();setModel(await getBehaviorModelStatus());setModelError(null);})}>Preparar ambiente CPU</Button>
        <label>Pasta do modelo exportado<input value={modelPath} onChange={e=>setModelPath(e.target.value)} placeholder="Caminho local com manifest.json e arquivos ONNX"/></label>
        <Button variant="secondary" loading={busy} disabled={!model?.environmentReady||Boolean(active)||(!modelPath.trim()&&!model.remoteAvailable)} onClick={()=>void operation(async()=>{setInstallingModel(true);try{setModel(await downloadBehaviorModel(modelPath.trim()||undefined));setModelError(null);}finally{setInstallingModel(false);}})}>Instalar modelo verificado</Button>
        {installingModel&&<Button variant="secondary" onClick={()=>void cancelBehaviorModelDownload().catch(reason=>setError(String(reason)))}>Cancelar instalação do modelo</Button>}
      </details>
      <Button loading={busy} disabled={!model?.installed||!model.environmentReady||Boolean(active)} onClick={()=>void operation(async()=>{const job=await startBehavior(experiment.id,jobId,digest);setJobs(await listBehaviorJobs(experiment.id,jobId));selectRun(job.jobId);})}>Detectar rearing</Button>
      {active&&<div role="status"><p>{stateLabels[active.state]} · {active.report.framesProcessed??0} frames processados</p><Button variant="secondary" onClick={()=>void operation(()=>cancelBehavior(active.jobId))}>Cancelar classificação</Button></div>}
      <p className="behavior-help">Os pesos precisam ser treinados com anotações humanas. O estado experimental permanece visível até que a validação em vídeos independentes seja documentada.</p>
      </details>
    </div>}
    {tab==="review"&&<div role="tabpanel" id="behavior-review-panel" aria-labelledby="behavior-review-tab">
      <SelectMenu label="Execução comportamental" value={shown} onChange={selectRun} options={[{value:"",label:"Execução concluída mais recente"},...jobs.map(job=>({value:job.jobId,label:`${new Date(job.createdAt).toLocaleString("pt-BR")} · ${job.modelVersion} · ${stateLabels[job.state]}`}))]}/>
      {experiment.behaviorSelections?.[jobId]&&!shown&&<div role="status"><p>A execução salva não está disponível para este vídeo. Selecione uma execução do histórico.</p><Button size="sm" variant="secondary" onClick={()=>selectRun("")}>Usar execução concluída mais recente</Button></div>}
      {current?.error&&<p role="alert">{current.error}</p>}
      {!result&&<p>{shown?"Resultado disponível após a conclusão da classificação.":"Nenhuma classificação concluída para este tracking."}</p>}
      {result&&<><BehaviorMetricSummary metrics={result.metrics} events={events}/>
        {context&&<><video ref={video} src={context.videoUrl} controls preload="metadata" onTimeUpdate={e=>setTime(e.currentTarget.currentTime)}/><BehaviorEthogram intervals={events.filter(e=>e.reviewStatus!=="rejected")} duration={context.durationSec} time={time} onSeek={seek}/></>}
        <BehaviorEventReview events={events} duration={result.metrics.analysisDurationSec} onReview={review} onSeek={seek}/>
        <Button variant="secondary" loading={busy} onClick={()=>void operation(async()=>setAuditVideo(await renderBehaviorVideo(shown)))}>Gerar vídeo com rearing automático</Button>
        {auditVideo&&<><p>Overlay da classificação automática desta execução, antes da revisão humana.</p><video src={auditVideo} controls preload="metadata"/></>}
        <div className="behavior-export-buttons">{[["behavior_metrics.json",result.metrics],["behavior_events_reviewed.json",events],["behavior_reviews.json",reviews],["run_manifest.json",result.manifest],["quality_report.json",result.quality]].map(([name,value])=><Button key={name as string} variant="secondary" size="sm" onClick={()=>downloadText(name as string,JSON.stringify(value,null,2),"application/json")}>{name as string}</Button>)}
          <Button size="sm" variant="secondary" onClick={()=>downloadText("behavior_events.csv",["event_id,start_sec,end_sec,duration_sec,behavior,model_score,review_status",...events.map(e=>[e.eventId,e.startSec,e.endSec,e.durationSec,e.behavior,e.score,e.reviewStatus].map(csvCell).join(","))].join("\n")+"\n","text/csv")}>behavior_events.csv</Button>
          <Button size="sm" variant="secondary" onClick={()=>downloadText("frame_predictions.jsonl",result.predictions.map(p=>JSON.stringify(p)).join("\n")+"\n","application/x-ndjson")}>frame_predictions.jsonl</Button>
          <Button size="sm" variant="secondary" loading={busy} onClick={()=>void operation(async()=>{const result=await exportBehaviorResults(shown);setExportUrl(result.url);setExportPath(result.path);})}>Exportar execução completa</Button>
          {exportUrl&&<a className="button button-secondary button-sm" href={exportUrl} download={`${shown}-behavior-run.zip`}>Baixar ZIP da execução</a>}
          {exportPath&&<Button size="sm" variant="secondary" onClick={()=>void operation(()=>revealBehaviorExport(exportPath))}>Mostrar ZIP na pasta</Button>}
        </div>
      </>}
    </div>}
  </>;
}

export function BehaviorAnalysisPanel({experiment,onSelect}: {experiment:OpenFieldExperiment;onSelect:(selection:TrackingSelection)=>Promise<boolean>}) {
  const [jobs,setJobs]=useState<LocalJob[]>([]),[error,setError]=useState<string|null>(null);
  const selected=experiment.trackingSelection?.engine==="opencv"?experiment.trackingSelection.jobId:"";
  useEffect(()=>{if(!isTauriRuntime())return;let live=true;void listLocalJobs(experiment.id).then(value=>{if(live)setJobs(value.filter(job=>job.state==="succeeded"&&job.config.protocol==="open_field"&&job.videoSha256===experiment.video.sha256&&job.config.strategy!=="wistar_hrnet"));}).catch(reason=>{if(live)setError(String(reason));});return()=>{live=false;};},[experiment.id,selected,experiment.video.sha256]);
  return <section className="panel behavior-panel" aria-label="Rearing no campo aberto"><div className="behavior-heading"><div className="eyebrow">Campo aberto · câmera superior</div><h2>Rearing e exploração vertical</h2><p>Prepare as anotações, execute o modelo treinado e revise cada episódio.</p></div>
    {!isTauriRuntime()?<p>Abra o aplicativo desktop para anotar o vídeo original e executar a classificação local.</p>:<>
      {error&&<p role="alert">{error}</p>}
      <SelectMenu label="Tracking usado na análise comportamental" value={jobs.some(j=>j.jobId===selected)?selected:""} onChange={jobId=>void onSelect({engine:"opencv",jobId})} placeholder="Selecione um tracking OpenCV concluído" options={jobs.map(job=>({value:job.jobId,label:`${new Date(job.createdAt).toLocaleString("pt-BR")} · OpenCV · ${job.jobId.slice(0,8)}`}))}/>
      {!jobs.length&&<p>Execute primeiro o OpenCV rápido na aba Análise para este vídeo.</p>}
      {selected&&jobs.some(j=>j.jobId===selected)&&experiment.video.sha256&&<BehaviorRun key={`${experiment.id}:${selected}:${experiment.video.sha256}`} experiment={experiment} jobId={selected}/>}
    </>}
  </section>;
}
