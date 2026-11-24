import { useEffect, useMemo, useRef } from "react";
import type { Point, PoseSample } from "../../types";
import { drawableSilhouette, estimatedBodyAxis } from "../../lib/body-axis";
import { acceptedLocalBody } from "../../lib/local-motion";

export function LocalBodyOverlay({ sample, width, height }: { sample?: PoseSample; width: number; height: number }) {
  const last=useRef<{sample:PoseSample;path:Point[]}|null>(null);
  const path = useMemo(() => {
    if(!sample || !drawableSilhouette(sample))return [];
    const old=last.current;
    const dt=old?sample.timestampSec-old.sample.timestampSec:0;
    const box=sample.bbox,previous=old?.sample.bbox;
    const sameBody=old&&box&&previous&&sample.frameIndex===old.sample.frameIndex+1&&dt>0&&dt<=.25
      && Math.hypot(box.x+box.width/2-previous.x-previous.width/2,box.y+box.height/2-previous.y-previous.height/2)<=Math.hypot(previous.width,previous.height);
    const first=old?.path[0],end=old?.path.at(-1);
    return estimatedBodyAxis(sample.contour,sameBody&&first&&end?{x:end.x-first.x,y:end.y-first.y}:undefined);
  }, [sample]);
  useEffect(()=>{last.current=sample&&path.length?{sample,path}:null;},[sample,path]);
  if (!path.length) return null;
  const uncertain=!sample || !acceptedLocalBody(sample);
  const color=uncertain?"#ffca70":"#6be7ff";
  return <g pointerEvents="none" aria-label="Esqueleto corporal estimado pela silhueta, sem pontos anatômicos nomeados">
    <polyline points={path.map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeDasharray={uncertain?`${width/160} ${width/250}`:undefined} strokeWidth={Math.max(2,width/500)} strokeLinejoin="round" />
    {path.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={Math.max(3,width/400)} fill={color} stroke="#16313a" strokeWidth={Math.max(1,width/1400)} />)}
    <text x={width*.012} y={height*.975} fontSize={height*.021} fill={color} stroke="#101a20" strokeWidth={Math.max(1,width/1000)} paintOrder="stroke">{uncertain?"Silhueta incerta · ":""}Esqueleto por silhueta · sem identidade anatômica</text>
  </g>;
}
