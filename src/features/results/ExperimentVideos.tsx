import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import type { Experiment } from "../../types";
import { loadColabVideo, loadRamArtifacts, rebuildColabActivityVideo } from "../colab/analysis";
import { LocalAuditVideo } from "../local/LocalAuditVideo";
import { runLabel, useExperimentRuns, type ExperimentRun } from "./experiment-runs";

function ColabRunVideo({experiment,run}:{experiment:Experiment;run:ExperimentRun}) {
  const [videos,setVideos]=useState<{url:string;name:string}[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [needsRebuild,setNeedsRebuild]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [working,setWorking]=useState(false);
  const [actionError,setActionError]=useState<string|null>(null);
  useEffect(()=>{
    let live=true;setLoading(true);setError(null);
    const load=async()=>{
      if(experiment.testType==="radial_arm_maze"){
        const files=await loadRamArtifacts(run.jobId);
        return {videos:files.filter(file=>/\.mp4$/i.test(file.name)),needsRebuild:false,error:null};
      }
      const artifact=await loadColabVideo(run.jobId);
      return {videos:artifact.videoUrl?[{url:artifact.videoUrl,name:`${run.jobId}-anotado.mp4`}]:[],needsRebuild:artifact.needsActivityRebuild??false,error:artifact.videoError};
    };
    void load().then(result=>{if(live){setVideos(result.videos);setNeedsRebuild(result.needsRebuild);setError(result.error);}})
      .catch(reason=>{if(live){setVideos([]);setError(String(reason));}}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[experiment.testType,run.jobId,refresh]);
  async function rebuild(){
    if(experiment.testType!=="open_field")return;
    setWorking(true);setActionError(null);
    try{await rebuildColabActivityVideo(experiment.id,run.jobId,experiment.arena,experiment.video);setRefresh(value=>value+1);}
    catch(reason){setActionError(String(reason));}finally{setWorking(false);}
  }
  async function download(video:{url:string;name:string}){
    setWorking(true);setActionError(null);
    try{const response=await fetch(video.url);if(!response.ok)throw new Error("O MP4 salvo não pôde ser lido.");
      const url=URL.createObjectURL(await response.blob());const link=document.createElement("a");link.href=url;link.download=video.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(reason){setActionError(String(reason));}finally{setWorking(false);}
  }
  return <section className="results-video-section" aria-label={`Vídeo ${runLabel(run)}`}>
    <div className="results-video-heading"><div><h2>{runLabel(run)}</h2><p>MP4 desta execução do experimento.</p></div>
      <Button variant="secondary" size="sm" disabled={loading||working} onClick={()=>setRefresh(value=>value+1)}>Recarregar</Button>
      {needsRebuild&&experiment.testType==="open_field"&&<Button variant="secondary" size="sm" loading={working} onClick={()=>void rebuild()}>Atualizar gráfico</Button>}
    </div>
    {loading?<p role="status">Carregando vídeo…</p>:videos.length? videos.map(video=><div key={video.name} className="rendered-run-video">
      <div className="results-video-player"><video src={video.url} controls playsInline preload="none" aria-label={`MP4 ${runLabel(run)}`}
        onError={()=>setActionError("O player não conseguiu reproduzir este MP4.")}/></div>
      <Button variant="secondary" size="sm" disabled={working} onClick={()=>void download(video)}>Baixar MP4</Button>
    </div>):<p>{error??"Esta execução não contém MP4 renderizado. Os dados permanecem disponíveis na aba Arquivos."}</p>}
    {actionError&&<p role="alert">{actionError}</p>}
  </section>;
}

export function ExperimentVideos({experiment}:{experiment:Experiment}) {
  const {runs,loading,error}=useExperimentRuns(experiment);
  return <div className="experiment-videos" aria-label="Vídeos das análises do experimento">
    <div className="results-video-heading"><div><h2>Vídeos do experimento</h2><p>{experiment.title} · {runs.length} {runs.length===1?"execução disponível":"execuções disponíveis"}. Cada vídeo conserva as anotações da sua execução.</p></div></div>
    {loading&&<p role="status">Carregando histórico de vídeos…</p>}
    {error&&<p role="alert">{error}</p>}
    {!loading&&!runs.length&&<section className="panel protocol-result-panel"><p>Nenhuma análise concluída neste experimento.</p></section>}
    {runs.map(run=>run.engine==="opencv"?<LocalAuditVideo key={run.key} jobId={run.jobId} protocol={experiment.testType==="forced_swim"?"presence":"tracking"} title={runLabel(run)}/>:<ColabRunVideo key={run.key} experiment={experiment} run={run}/>)}
  </div>;
}
