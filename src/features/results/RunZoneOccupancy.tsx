import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../components/ui/card";
import { SelectMenu } from "../../components/ui/SelectMenu";
import { useEffect, useMemo, useRef, useState } from "react";
import { applyCorrections } from "../../lib/corrections";
import { formatDuration } from "../../lib/format";
import { reviewEvents, trackingSourceKey } from "../../lib/tracking-reviews";
import { visualZoneOccupancy } from "../../lib/zone-occupancy";
import type { OpenFieldExperiment, PoseSample, TrackingSelection } from "../../types";
import type { ColabJob } from "../colab/analysis";
import { isTauriRuntime } from "../colab/connection";
import { listLocalJobs, type LocalJob } from "../local/api";

export function RunZoneOccupancy({ experiment, samples, colabJobs, loading, onSelect }: {
  experiment: OpenFieldExperiment; samples: PoseSample[]; colabJobs: ColabJob[]; loading: boolean;
  onSelect: (selection: TrackingSelection)=>Promise<boolean>;
}) {
  const [localJobs,setLocalJobs]=useState<LocalJob[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [pending,setPending]=useState<string|null>(null);
  const request=useRef(0);
  useEffect(()=>{
    if(!isTauriRuntime())return;
    let live=true;
    const refresh=()=>{void listLocalJobs(experiment.id).then(rows=>{if(live){setLocalJobs(rows);}}).catch(reason=>{if(live)setError(String(reason));});};
    refresh();const timer=window.setInterval(refresh,5000);
    return()=>{live=false;window.clearInterval(timer);};
  },[experiment.id]);
  const runs=useMemo(()=>[
    ...localJobs.filter(job=>job.state==="succeeded"&&(!job.config.protocol||job.config.protocol==="open_field"))
      .map(job=>({engine:"opencv" as const,jobId:job.jobId,createdAt:job.createdAt})),
    ...colabJobs.filter(job=>!job.training&&!job.diagnostic&&(job.resultsReady||job.status==="succeeded"))
      .map(job=>({engine:"colab" as const,jobId:job.jobId,createdAt:job.createdAt})),
  ].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)),[localJobs,colabJobs]);
  const current=experiment.trackingSelection?trackingSourceKey(experiment.trackingSelection):"";
  const reviewed=useMemo(()=>applyCorrections(samples,reviewEvents(experiment)),[samples,experiment]);
  const occupancy=useMemo(()=>visualZoneOccupancy(reviewed,experiment.arena,experiment.video.width,experiment.video.height),[reviewed,experiment.arena,experiment.video.width,experiment.video.height]);
  async function select(key:string){
    const run=runs.find(item=>trackingSourceKey(item)===key);if(!run)return;
    const revision=++request.current;setPending(key);setError(null);
    const success=await onSelect({engine:run.engine,jobId:run.jobId});
    if(revision!==request.current)return;
    setPending(null);if(!success)setError("Não foi possível abrir a execução escolhida. A seleção anterior foi mantida.");
  }
  const busy=loading||pending!==null;
  return <Card className="zone-card results-trajectory-zones" aria-label="Ocupação por zona da execução selecionada">
    <CardHeader><CardTitle>Ocupação por zona</CardTitle><CardDescription>Distribuição das posições observadas nesta execução.</CardDescription></CardHeader>
    <CardContent className="zone-occupancy-content">
    <SelectMenu label="Análise para ocupação por zona" value={pending??current} disabled={busy} onChange={key=>void select(key)}
      options={[
        ...(experiment.trackingSelection&&!runs.some(run=>trackingSourceKey(run)===current)?[{value:current,label:`Execução selecionada · ${experiment.trackingSelection.engine==="opencv"?"Máquina local":"Google Colab"}`}]:[]),
        ...runs.map(run=>({value:trackingSourceKey(run),label:`${run.engine==="opencv"?"Máquina local":"Google Colab"} · ${new Date(run.createdAt).toLocaleString("pt-BR")} · ${run.jobId.slice(0,8)}`})),
      ]}/>
    {error&&<p role="alert">{error}</p>}
    {busy ? <p role="status">Carregando ocupação da execução selecionada…</p> : <>
      <div className="zone-donut" style={{background:occupancy.centerPct==null?"#637069":`conic-gradient(#00d9a0 0 ${occupancy.centerPct}%, #34594e ${occupancy.centerPct}% 100%)`}}>
        <div><strong>{occupancy.centerPct==null?"—":`${occupancy.centerPct.toFixed(1)}%`}</strong><span>no centro</span></div>
      </div>
      {occupancy.centerPct==null&&<p>Não há intervalos consecutivos observados para classificar. Isso não significa 0% no centro.</p>}
      <div className="zone-breakdown">
        <div><span><i className="center"/> Centro</span><strong>{formatDuration(occupancy.centerSec)}</strong></div>
        <div><span><i className="periphery"/> Periferia</span><strong>{formatDuration(occupancy.peripherySec)}</strong></div>
        <div><span><i className="unknown"/> Desconhecido</span><strong>{formatDuration(occupancy.unknownSec)}</strong></div>
      </div>
      <p>{occupancy.observedPct.toFixed(1)}% do tempo com posições observadas. O percentual central usa esse tempo; perdas e previsões ficam desconhecidas.</p>
      <p>Estimativa visual pelo centro da caixa ou referência disponível. Não aprova métricas científicas de piso ou comportamento.</p>
    </>}
    </CardContent>
  </Card>;
}
