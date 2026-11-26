import { useEffect, useState } from "react";
import type { OpenFieldExperiment } from "../../types";
import type { BehaviorJob, BehaviorResult, BehaviorReview } from "../../lib/behavior/types";
import { assertBehaviorSource, selectedBehaviorRun } from "../../lib/behavior/selection";
import { reviewedEvents } from "../../lib/behavior/events";
import { Button } from "../../components/ui/Button";
import { isTauriRuntime } from "../colab/connection";
import { listBehaviorJobs, listBehaviorReviews, loadBehaviorResult } from "./api";
import { BehaviorMetricSummary } from "./BehaviorMetricSummary";

export function BehaviorExperimentSummary({experiment,onOpen}: {experiment:OpenFieldExperiment;onOpen:()=>void}) {
  const trackingId=experiment.trackingSelection?.engine==="opencv"?experiment.trackingSelection.jobId:"";
  const digest=experiment.video.sha256??"";
  const [jobs,setJobs]=useState<BehaviorJob[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [loaded,setLoaded]=useState<{jobId:string;result:BehaviorResult;reviews:BehaviorReview[]}|null>(null);
  const selected=selectedBehaviorRun(jobs,digest,experiment.behaviorSelections?.[trackingId]);
  const state=jobs.find(job=>job.jobId===selected)?.state;
  useEffect(()=>{
    if(!isTauriRuntime()||!trackingId||!digest)return;
    let live=true;
    const refresh=()=>void listBehaviorJobs(experiment.id,trackingId).then(value=>{if(live)setJobs(value.filter(job=>job.videoSha256===digest));}).catch(reason=>{if(live)setError(String(reason));});
    refresh();const timer=window.setInterval(refresh,2000);
    return()=>{live=false;window.clearInterval(timer);};
  },[experiment.id,trackingId,digest]);
  useEffect(()=>{
    setLoaded(null);setError(null);
    if(!selected||state!=="succeeded")return;
    let live=true;
    void Promise.all([loadBehaviorResult(selected),listBehaviorReviews(selected)]).then(([result,reviews])=>{
      assertBehaviorSource(result,experiment.id,trackingId,digest);
      if(live)setLoaded({jobId:selected,result,reviews});
    }).catch(reason=>{if(live)setError(String(reason));});
    return()=>{live=false;};
  },[selected,state,experiment.id,trackingId,digest]);
  if(!isTauriRuntime()||!trackingId||!digest)return null;
  const data=loaded?.jobId===selected?loaded:null;
  return <section className="panel behavior-summary" aria-label="Resumo de rearing da execução selecionada">
    {error&&<p role="alert">{error}</p>}
    {data?<><BehaviorMetricSummary metrics={data.result.metrics} events={reviewedEvents(data.result.events,data.reviews)} compact/>
      <p className="behavior-help">Modelo {data.result.manifest.model.modelVersion} · execução {selected.slice(0,8)} · mesmo vídeo e tracking dos indicadores acima.</p></>:<><h3>Exploração vertical</h3><p>{state&&state!=="succeeded"?"A execução comportamental selecionada ainda não possui resultado concluído.":"Rearing ainda não mensurado neste tracking. Anote os episódios ou selecione uma classificação na aba Rearing."}</p></>}
    <Button variant="secondary" size="sm" onClick={onOpen}>{data?"Revisar episódios de rearing":"Abrir rearing"}</Button>
  </section>;
}
