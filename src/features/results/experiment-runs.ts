import { useEffect, useState } from "react";
import type { Experiment, TrackingSelection } from "../../types";
import { loadColabJobs, type ColabJob } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { listLocalJobs, type LocalJob } from "../local/api";

export type ExperimentRun = { key: string; engine: TrackingSelection["engine"]; jobId: string; createdAt: string;
  local?: LocalJob; colab?: ColabJob };
export function experimentRuns(experiment: Experiment, local: LocalJob[], colab: ColabJob[]): ExperimentRun[] {
  const protocol=experiment.testType ?? "open_field";
  return [
    ...local.filter(job=>job.experimentId===experiment.id && job.state==="succeeded" && (job.config.protocol??"open_field")===protocol)
      .map(job=>({key:`opencv:${job.jobId}`,engine:"opencv" as const,jobId:job.jobId,createdAt:job.createdAt,local:job})),
    ...colab.filter(job=>job.experimentId===experiment.id && !job.training && !job.diagnostic && (job.resultsReady||job.status==="succeeded") && (job.protocol??"open_field")===protocol)
      .map(job=>({key:`colab:${job.jobId}`,engine:"colab" as const,jobId:job.jobId,createdAt:job.createdAt,colab:job})),
  ].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||a.key.localeCompare(b.key));
}
export function useExperimentRuns(experiment: Experiment) {
  const [runs,setRuns]=useState<ExperimentRun[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{
    if(!isTauriRuntime()){setLoading(false);return;}
    let live=true;
    const refresh=async()=>{
      const [local,colab]=await Promise.allSettled([listLocalJobs(experiment.id),loadColabJobs(experiment.id)]);
      if(!live)return;
      setRuns(previous=>experimentRuns(experiment,local.status==="fulfilled"?local.value:previous.flatMap(run=>run.local?[run.local]:[]),colab.status==="fulfilled"?colab.value:previous.flatMap(run=>run.colab?[run.colab]:[])));
      setError([local,colab].some(result=>result.status==="rejected")?"Não foi possível consultar parte do histórico. Tente abrir esta aba novamente.":null);
      setLoading(false);
    };
    void refresh();const timer=window.setInterval(()=>void refresh(),5000);
    return()=>{live=false;window.clearInterval(timer);};
  },[experiment.id,experiment.testType]);
  return {runs:runs.filter(run=>(run.local??run.colab)?.experimentId===experiment.id),loading,error};
}
export const runLabel=(run:ExperimentRun)=>`${run.engine==="opencv"?"Máquina local":"Google Colab"} · ${new Date(run.createdAt).toLocaleString("pt-BR")} · ${run.jobId.slice(0,8)}`;

export function runProcessingSeconds(run?: ExperimentRun): number | null {
  if(run?.local){const value=run.local.report.elapsedSec;return value!=null&&Number.isFinite(value)&&value>=0?value:null;}
  if(!run?.colab)return null;
  const duration=(Date.parse(run.colab.updatedAt)-Date.parse(run.colab.createdAt))/1000;
  return Number.isFinite(duration)&&duration>=0?duration:null;
}
