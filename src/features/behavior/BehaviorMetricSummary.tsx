import type { BehaviorEvent, BehaviorMetrics } from "../../lib/behavior/types";
import { reviewedSummary } from "../../lib/behavior/metrics";

const number=(value:number|null,digits=0)=>value==null?"Não mensurável":value.toLocaleString("pt-BR",{maximumFractionDigits:digits});
export function BehaviorMetricSummary({metrics,events,compact=false}: {metrics:BehaviorMetrics;events:BehaviorEvent[];compact?:boolean}) {
  const r=metrics.rearing, reviewed=reviewedSummary(events);
  return <section className="behavior-metrics" aria-label="Exploração vertical">
    <h3>Exploração vertical <span className="behavior-experimental">Experimental · automático</span></h3>
    <div className="behavior-metric-grid">{[
      ["Rearing total",number(r.totalCount)],["Tempo em rearing",r.totalDurationSec==null?"Não mensurável":`${number(r.totalDurationSec,2)} s`],
      ["Latência",r.latencyExact?`${number(r.latencySec,2)} s`:"Não exata / não observada"],["Com apoio",number(r.supportedCount)],
      ["Sem apoio",number(r.unsupportedCount)],["Apoio indeterminado",number(r.unspecifiedCount)],
      ...(!compact?[["Duração média / máxima",`${number(r.meanDurationSec,2)} / ${number(r.maxDurationSec,2)} s`],
      ["Episódios / minuto classificável",number(r.perClassifiableMinute,2)],["Tempo classificável em rearing",r.percentClassifiableTime==null?"Não mensurável":`${number(r.percentClassifiableTime,2)}%`]]:[]),
    ].map(([label,value])=><div className="behavior-metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <p>Cobertura comportamental: <strong>{number(metrics.coveragePct,1)}%</strong> · {number(metrics.classifiableDurationSec,2)} s classificáveis · {number(metrics.unknownDurationSec,2)} s desconhecidos.</p>
    {!r.latencyExact&&r.firstObservedRearingSec!=null&&<p>Primeiro rearing observado em {number(r.firstObservedRearingSec,2)} s; o trecho anterior contém incerteza.</p>}
    <p>Revisão humana: <strong>{reviewed.count} episódios confirmados ou corrigidos</strong> · {number(reviewed.durationSec,2)} s · {reviewed.pending} pendentes · {reviewed.rejected} rejeitados. A revisão de episódios não estabelece revisão exaustiva da sessão.</p>
  </section>;
}
