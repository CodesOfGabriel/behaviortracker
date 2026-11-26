import { useMemo } from "react";
import type { PoseSample } from "../../types";
import { bodyAxisAt } from "../../lib/body-axis";
import { acceptedLocalBody } from "../../lib/local-motion";
import { headTriangle } from "../../lib/oft-layers";

export function LocalBodyOverlay({ sample, samples, width, height }: { sample?: PoseSample;samples?:readonly PoseSample[]; width: number; height: number }) {
  const observation=useMemo(()=>sample?.oftLayers ? sample.bodyAxis : bodyAxisAt(sample,samples),[sample,samples]);
  const path=observation?.points??[];
  if (!path.length) return observation&&observation.state!=="missing"?<g pointerEvents="none" aria-label="Orientação incerta" data-axis-state={observation.state} data-axis-reason={observation.reason}/>:null;
  const uncertain=!sample || !acceptedLocalBody(sample);
  const color=uncertain?"#ffca70":"#6be7ff";
  const orientation=sample?.oftLayers?.orientation;
  return <g pointerEvents="none" aria-label={uncertain?"Silhueta incerta · eixo corporal estimado":"Eixo corporal estimado pela silhueta"} data-axis-state={observation?.state} data-axis-reason={observation?.reason} data-frame-index={sample?.frameIndex}>
    <polyline points={path.map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeDasharray={uncertain?`${width/160} ${width/250}`:undefined} strokeWidth={Math.max(2,width/500)} strokeLinejoin="round" />
    {path.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={Math.max(3,width/400)} fill={color} stroke="#16313a" strokeWidth={Math.max(1,width/1400)} />)}
    {orientation?.state==="estimated"&&orientation.head&&orientation.tailBase&&<g aria-label="Cabeça estimada" data-orientation-source={orientation.source} data-head-region={orientation.headRegion}>
      <polygon data-head-marker="triangle" points={headTriangle(orientation.head,orientation.tailBase,Math.max(4,width/180)).map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke="#ffca70" strokeWidth={1.5} strokeDasharray={orientation.source==="temporal_estimate"?"3 2":undefined}/>
      <circle aria-label="Base da cauda estimada" cx={orientation.tailBase.x} cy={orientation.tailBase.y} r={Math.max(2,width/350)} fill="none" stroke="#ffca70" strokeWidth={1.5}/>
    </g>}
  </g>;
}
