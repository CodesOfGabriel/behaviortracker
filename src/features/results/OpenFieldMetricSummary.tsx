import { Download, Footprints, Gauge, Map, Route, Info } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../components/ui/card";
import { SelectMenu } from "../../components/ui/SelectMenu";
import { Button } from "../../components/ui/Button";
import { formatDuration } from "../../lib/format";
import type { OftMetrics } from "../../types";
import type { ReactNode } from "react";
export type MetricReferenceMode="reviewed"|"floor_box_estimate";
const value=(number:number|null,unit:string,digits=1)=>number==null?"Não mensurável":`${number.toLocaleString("pt-BR",{minimumFractionDigits:digits,maximumFractionDigits:digits})} ${unit}`;
export function OpenFieldMetricSummary({metrics,mode,onModeChange,hasBoxes,hasPendingReference,onExport,behavior}:{
  metrics:OftMetrics;mode:MetricReferenceMode;onModeChange:(mode:MetricReferenceMode)=>void;hasBoxes:boolean;hasPendingReference:boolean;onExport:()=>void;behavior?:ReactNode;
}) {
  const estimated=mode==="floor_box_estimate";
  const classifiable=metrics.validDurationSec>0;
  return <div className="open-field-metric-summary" aria-label="Indicadores da execução selecionada">
    <Card className="metric-reference-card"><CardHeader>
      <div><CardTitle>{estimated?"Estimativas pelo centro da caixa":"Métricas da referência revisada"}</CardTitle>
        <CardDescription>{estimated?"Cálculo geométrico nos trechos observados no piso, com a calibração da arena.":"Referência elegível pelas regras de qualidade e revisão desta execução."}</CardDescription></div>
      <SelectMenu label="Referência dos indicadores" value={mode} onChange={value=>onModeChange(value as MetricReferenceMode)}
        options={[{value:"reviewed",label:"Referência revisada"},...(hasBoxes?[{value:"floor_box_estimate",label:"Centro da caixa · estimativa no piso"}]:[])]}/>
    </CardHeader><CardContent>
    <section className="metric-grid" aria-label={estimated?"Estimativas geométricas no piso":"Métricas revisadas"}>
      <article className="metric-card"><div className="metric-icon distance"><Route size={20}/></div><span>{estimated?"Distância estimada":"Distância válida"}</span><strong>{value(metrics.distanceCm,"cm")}</strong><small>Somente pares consecutivos no piso</small></article>
      <article className="metric-card"><div className="metric-icon speed"><Gauge size={20}/></div><span>{estimated?"Velocidade média estimada":"Velocidade média"}</span><strong>{value(metrics.meanSpeedCmS,"cm/s",2)}</strong><small>Tempo observado dos pares utilizáveis</small></article>
      <article className="metric-card"><div className="metric-icon center-time"><Map size={20}/></div><span>{estimated?"Tempo estimado no centro":"Tempo no centro"}</span><strong>{value(classifiable?metrics.centerTimeSec:null,"s")}</strong><small>{metrics.centerPctClassifiable==null?"Sem tempo classificável":`${metrics.centerPctClassifiable.toFixed(1)}% do tempo classificável`}</small></article>
      <article className="metric-card"><div className="metric-icon entries"><Footprints size={20}/></div><span>{estimated?"Entradas estimadas no centro":"Entradas observadas no centro"}</span><strong>{classifiable?metrics.centerEntries:"Não mensurável"}</strong><small>Permanência mínima de 0,2 s</small></article>
    </section>

      {hasPendingReference&&<p className="metric-reference-note"><Info size={14}/>{estimated?"O centro da caixa ainda não foi aprovado como referência revisada. Estes valores são estimativas, sem aprovação automática das observações.":"Há caixas observadas cuja referência geométrica ainda não foi aprovada. Selecione a estimativa no piso para consultar esses trechos."}</p>}
      <div className="metric-coverage-row"><span><i/>{metrics.coveragePct.toFixed(1)}% do tempo com pares utilizáveis</span><span>{formatDuration(metrics.validDurationSec)} de {formatDuration(metrics.analysisDurationSec)}</span></div>
      <div className="metric-coverage-track" aria-label={`Cobertura dos indicadores: ${metrics.coveragePct.toFixed(1)}%`}><span style={{width:`${Math.min(100,metrics.coveragePct)}%`}}/></div>
      {!classifiable&&<p role="status" className="metric-reference-note">{estimated?"Não há pares consecutivos de caixas aceitas no piso. Confira a calibração e os alertas de rastreamento; posições na parede, previsões e perdas não permitem medir estes indicadores.":"Não há pares consecutivos de posições elegíveis nesta referência. Ausência de dados utilizáveis não significa que o animal ficou parado."}</p>}
      {estimated&&<div className="metric-estimate-actions"><span>Trechos incertos permanecem desconhecidos. Os valores não representam o vídeo inteiro.</span><Button size="sm" variant="secondary" icon={<Download size={14}/>} onClick={onExport}>Exportar estimativas</Button></div>}
    </CardContent></Card>
    {behavior}

  </div>;
}
