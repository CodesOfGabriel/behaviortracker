import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Experiment, PoseSample } from "../../types";
import { useAppStore } from "../../store/AppStore";
import { boxCenterTrajectory } from "../../lib/boxes";
import { loadColabVideo, loadStagedVideo } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { listLocalJobs, loadLocalAuditVideo, type LocalJob } from "../local/api";
import { LocalBodyOverlay } from "../local/LocalBodyOverlay";
import { AnalysisDetailsLayout, DetailsVideoCard } from "./AnalysisDetailsLayout";
import { ResultMotionChart } from "./ResultMotionChart";
import { useVideoFrameTime } from "../../lib/useVideoFrameTime";
import { trackingFrameAt } from "../../lib/video-frame";

export function useOriginalVideo(experiment:Experiment,job?:LocalJob) {
  const {assets}=useAppStore();
  const assetUrl=assets[experiment.id]?.objectUrl;
  const [staged,setStaged]=useState<{key:string;url:string}|null>(null);
  const key=`${experiment.id}:${job?.jobId??experiment.video.preparation?.uploadId??""}`;
  useEffect(()=>{
    if(assetUrl||!isTauriRuntime())return;
    let live=true;
    const uploadId=job?.uploadId??experiment.video.preparation?.uploadId;
    if(uploadId)void loadStagedVideo(experiment.id,uploadId).then(url=>{if(live)setStaged({key,url});}).catch(()=>undefined);
    return()=>{live=false;};
  },[assetUrl,experiment.id,job?.uploadId,key]);
  return assetUrl??(staged?.key===key?staged.url:undefined);
}
export function TrackingDetails({experiment,samples,reference="box",children}:{experiment:Experiment;samples:PoseSample[];reference?:"box"|"point";children?:ReactNode}) {
  const [job,setJob]=useState<LocalJob>();
  const [artifact,setArtifact]=useState<{key:string;url:string|null;error?:string|null}|null>(null);
  const selection=experiment.trackingSelection;
  const key=`${selection?.engine}:${selection?.jobId}`;
  const originalUrl=useOriginalVideo(experiment,job?.jobId===selection?.jobId?job:undefined);
  const player=useRef<HTMLVideoElement>(null);
  useEffect(()=>{
    if(!selection||!isTauriRuntime())return;
    let live=true;
    if(selection.engine==="opencv")void listLocalJobs(experiment.id).then(jobs=>{if(live)setJob(jobs.find(item=>item.jobId===selection.jobId));}).catch(()=>undefined);
    const load=selection.engine==="opencv"?loadLocalAuditVideo(selection.jobId):loadColabVideo(selection.jobId);
    void load.then(value=>{if(live)setArtifact({key,url:value.videoUrl,error:value.videoError});}).catch(reason=>{if(live)setArtifact({key,url:null,error:String(reason)});});
    return()=>{live=false;};
  },[experiment.id,key]);
  const source=originalUrl??(artifact?.key===key?artifact.url:null);
  const {time}=useVideoFrameTime(player,source);
  const boxes=useMemo(()=>boxCenterTrajectory(samples,experiment.video.width,experiment.video.height).centers,[samples,experiment.video.width,experiment.video.height]);
  const timeline=useMemo(()=>[...new Map(samples.map(row=>[row.frameIndex,{frameIndex:row.frameIndex,timestampSec:row.timestampSec}])).values()]
    .sort((a,b)=>a.timestampSec-b.timestampSec),[samples]);
  const boxByFrame=useMemo(()=>new Map(boxes.map(row=>[row.frameIndex,row])),[boxes]);
  const current=trackingFrameAt(timeline,time,experiment.video.fps??25);
  const sample=current?boxByFrame.get(current.frameIndex):undefined;
  function seek(value:number){if(player.current)player.current.currentTime=value;}
  return <AnalysisDetailsLayout video={<DetailsVideoCard description="Acompanhe o vídeo e consulte os gráficos ao lado.">
    <div className="tracking-details-player">
      {source?<><video ref={player} src={source} controls playsInline preload="metadata"/>
        {originalUrl&&sample?.bbox&&<svg viewBox={`0 0 ${experiment.video.width} ${experiment.video.height}`} aria-label="Caixa e linha corporal sincronizadas">
          <rect {...sample.bbox} data-frame-index={sample.frameIndex} data-timestamp-sec={sample.timestampSec} fill="none" stroke={sample.status==="valid"&&sample.trackingAccepted!==false?"#67d9b8":"#e8b86d"} strokeDasharray={sample.source==="predicted"||sample.source==="recovered"?"8 5":undefined} strokeWidth={3}/><circle cx={sample.xPx!} cy={sample.yPx!} r={5} fill="#67d9b8"/>
          <LocalBodyOverlay sample={sample} samples={boxes} width={experiment.video.width} height={experiment.video.height}/>
        </svg>}</>:<div className="details-video-empty"><span>Vídeo indisponível neste dispositivo</span><p>{artifact?.key===key?artifact.error:"Carregando vídeo salvo…"}</p></div>}
    </div>
    <p className="details-chart-note">{originalUrl?"Vídeo original · observações sincronizadas":"MP4 salvo desta execução"}</p>
  </DetailsVideoCard>}>
    <ResultMotionChart samples={samples} width={experiment.video.width} height={experiment.video.height} time={time??0} onSeek={seek} reference={reference}/>
    {children}
  </AnalysisDetailsLayout>;
}
