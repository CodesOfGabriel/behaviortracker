import { Clock3, Cpu, Cloud, Film, Layers3, ScanLine } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "../../components/ui/card";
import { Badge } from "../../components/ui/shadcn-badge";
import { SelectMenu } from "../../components/ui/SelectMenu";
import { useEffect, useState } from "react";
import type { Experiment, TrackingSelection } from "../../types";
import { formatDuration, formatElapsedClock } from "../../lib/format";
import { parseCanonicalPoseCsv } from "../../lib/csv";
import { useAppStore } from "../../store/AppStore";
import { loadColabResult } from "../colab/analysis";
import { runLabel, runProcessingSeconds, useExperimentRuns } from "./experiment-runs";

export function ExperimentRunSummary({experiment,onSelect}:{experiment:Experiment;onSelect?:(selection:TrackingSelection)=>Promise<boolean>}) {
  const {updateForcedSwimExperiment,updateRadialMazeExperiment}=useAppStore();
  const {runs,loading,error}=useExperimentRuns(experiment);
  const selected=experiment.trackingSelection;
  const run=selected?runs.find(item=>item.engine===selected.engine&&item.jobId===selected.jobId):runs[0];
  const [counts,setCounts]=useState<{key:string;frames:number|null;error?:string}|null>(null);
  const [selecting,setSelecting]=useState(false);
  const [selectionError,setSelectionError]=useState<string|null>(null);
  useEffect(()=>{
    if(!run?.colab)return;
    let live=true;
    void loadColabResult(run.jobId).then(raw=>{
      const frames=experiment.testType==="open_field"
        ? new Set(parseCanonicalPoseCsv(raw).map(sample=>sample.frameIndex)).size
        : (()=>{const value=JSON.parse(raw);return value.video?.frameCount??value.frameCount??null;})();
      if(live)setCounts({key:run.key,frames:Number.isSafeInteger(frames)&&frames>=0?frames:null});
    }).catch(()=>{if(live)setCounts({key:run.key,frames:null,error:"Não foi possível ler a contagem de quadros desta execução."});});
    return()=>{live=false;};
  },[run?.key,experiment.testType]);
  async function select(key:string){
    const candidate=runs.find(item=>item.key===key);if(!candidate)return;
    const selection={engine:candidate.engine,jobId:candidate.jobId};
    setSelecting(true);setSelectionError(null);
    try {
      if(onSelect){if(!await onSelect(selection))throw new Error("Não foi possível abrir a execução escolhida.");}
      else if(experiment.testType==="forced_swim")updateForcedSwimExperiment(experiment.id,{trackingSelection:selection});
      else if(experiment.testType==="radial_arm_maze")updateRadialMazeExperiment(experiment.id,{trackingSelection:selection});
    }catch(reason){setSelectionError(String(reason));}finally{setSelecting(false);}
  }
  const frames=run?.local?.report.framesProcessed??(counts?.key===run?.key?counts?.frames:null);
  const duration=runProcessingSeconds(run);
  const protocol=experiment.testType==="forced_swim"?"Nado Forçado":experiment.testType==="radial_arm_maze"?"Labirinto Radial":"Campo Aberto";
  const facts=[
    {label:"Tempo do vídeo",value:formatDuration(experiment.video.durationSec),icon:Film},
    {label:"Tempo do processamento",value:duration==null?"Não registrado":formatElapsedClock(duration),icon:Clock3},
    {label:"Quadros processados",value:frames==null?run?.colab&&counts?.key!==run.key?"Carregando…":"Não registrado":frames.toLocaleString("pt-BR"),icon:Layers3},
    {label:"Taxa do vídeo",value:experiment.video.fps==null?"Não registrada":`${experiment.video.fps.toLocaleString("pt-BR",{maximumFractionDigits:3})} FPS`,icon:ScanLine},
  ];
  return <Card className="experiment-run-summary summary-card" aria-label="Informações da análise">
    <CardHeader className="summary-card-heading">
      <div className="summary-card-title"><span className="summary-card-icon">{run?.engine==="colab"?<Cloud size={20}/>:<Cpu size={20}/>}</span>
        <div><CardTitle><h2>Informações da análise</h2></CardTitle><CardDescription>Experimento e dados da execução selecionada.</CardDescription></div>
      </div>
      {runs.length>0&&<div className="summary-run-select"><SelectMenu label="Execução do resumo" disabled={selecting} value={run?.key??""}
        onChange={key=>void select(key)} options={runs.map(item=>({value:item.key,label:runLabel(item)}))}/></div>}
    </CardHeader>
    <CardContent className="summary-card-content">
      {(error||selectionError)&&<p role="alert" className="ui-error">{selectionError??error}</p>}
      {loading&&<p role="status">Carregando dados da análise…</p>}
      <dl className="summary-stat-grid">{facts.map(({label,value,icon:Icon})=><div key={label} className="summary-stat"><dt><Icon size={14}/>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className="summary-meta-heading"><Badge variant="outline">{protocol}</Badge>{run&&<Badge variant="secondary">{run.engine==="opencv"?"Máquina local":"Google Colab"}</Badge>}</div>
      <dl className="summary-meta-grid">
        <div><dt>Nome do experimento</dt><dd>{experiment.title}</dd></div>
        <div><dt>Arquivo de vídeo</dt><dd title={experiment.video.filename}>{experiment.video.filename}</dd></div>
        <div><dt>Resolução do vídeo</dt><dd>{experiment.video.width} × {experiment.video.height}</dd></div>
        <div><dt>Execução iniciada em</dt><dd>{run?new Date(run.createdAt).toLocaleString("pt-BR"):"Nenhuma execução selecionada"}</dd></div>
      </dl>
      {counts?.key===run?.key&&counts?.error&&<p role="alert">{counts.error}</p>}
      {!loading&&!runs.length&&<p>Nenhuma análise concluída neste experimento.</p>}
    </CardContent>
    {run&&<CardFooter className="summary-card-footer"><span className="summary-status-dot"/> {run.colab?"Tempo Colab inclui fila, preparação e transferência.":"Tempo registrado pelo motor local. Atualizações posteriores do MP4 são separadas."}</CardFooter>}
  </Card>;
}
