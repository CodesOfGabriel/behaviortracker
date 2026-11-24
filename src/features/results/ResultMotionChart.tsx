import { useMemo } from "react";
import { Activity } from "lucide-react";
import type { PoseSample } from "../../types";
import { boxMotionSeries, pointImageMotionSeries } from "../../lib/local-motion";
import { formatDuration } from "../../lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

const colors=["#66d5b5","#e8b86d","#a99ae8"];
export function ResultMotionChart({samples,tracks,width,height,time=0,onSeek,reference="box"}:{
  samples?:PoseSample[];tracks?:Map<string,PoseSample[]>;width:number;height:number;time?:number;onSeek?:(time:number)=>void;reference?:"box"|"point";
}) {
  const plot=useMemo(()=>{
    const inputs=tracks?[...tracks]:[["Animal",samples??[]] as const];
    const series=inputs.map(([id,rows])=>({id,values:reference==="point"?pointImageMotionSeries(rows):boxMotionSeries(rows,width,height)}));
    const duration=Math.max(.001,...series.map(track=>track.values.at(-1)?.timestampSec??0));
    let maximum=1,pairs=0;
    for(const track of series)for(const row of track.values)if(row.speedPxSec!=null){maximum=Math.max(maximum,row.speedPxSec);pairs++;}
    const paths=series.map(track=>{
      const path:string[]=[];let previous=-2;
      for(const row of track.values){if(row.speedPxSec==null){previous=-2;continue;}
        path.push(`${row.frameIndex===previous+1?"L":"M"}${(46+row.timestampSec/duration*540).toFixed(2)},${(165-row.speedPxSec/maximum*140).toFixed(2)}`);previous=row.frameIndex;
      }
      return {id:track.id,path:path.join(" ")};
    });
    return {paths,duration,maximum,pairs};
  },[samples,tracks,width,height,reference]);
  return <Card className="result-motion-card"><CardHeader><CardTitle className="details-card-title"><Activity size={16}/>Locomoção ao longo do vídeo</CardTitle>
    <CardDescription>{reference==="box"?"Centro da caixa":"Centro observado"} · velocidade na imagem, em px/s</CardDescription></CardHeader>
    <CardContent>
      <div className="motion-chart-legend">{plot.paths.map((track,i)=><span key={track.id}><i style={{background:colors[i%colors.length]}}/>{track.id}</span>)}<span className="motion-chart-time">{formatDuration(time)} / {formatDuration(plot.duration)}</span></div>
      <svg viewBox="0 0 610 205" className="result-motion-chart" role="img" aria-label="Velocidade na imagem com lacunas preservadas"
        onPointerDown={event=>{const bounds=event.currentTarget.getBoundingClientRect();onSeek?.(Math.max(0,Math.min(plot.duration,((event.clientX-bounds.left)/bounds.width*610-46)/540*plot.duration)));}}>
        {[0,.5,1].map(f=><g key={f}><line x1={46} x2={586} y1={165-f*140} y2={165-f*140} stroke="#2a363e" strokeDasharray="3 5"/>
          <text x={35} y={169-f*140} textAnchor="end" fill="#8296a3" fontSize={11}>{(plot.maximum*f).toLocaleString("pt-BR",{maximumFractionDigits:1})}</text></g>)}
        {plot.paths.map((track,i)=><path key={track.id} d={track.path} fill="none" stroke={colors[i%colors.length]} strokeWidth={1.6} strokeLinejoin="round"/>)}
        <line x1={46+Math.min(plot.duration,time)/plot.duration*540} x2={46+Math.min(plot.duration,time)/plot.duration*540} y1={17} y2={170} stroke="#dce9ef" strokeWidth={1} opacity={.6}/>
        {[0,.25,.5,.75,1].map(f=><text key={f} x={46+f*540} y={192} textAnchor="middle" fill="#8296a3" fontSize={11}>{plot.duration<10?`${(plot.duration*f).toFixed(1)} s`:formatDuration(plot.duration*f)}</text>)}
      </svg>
      {onSeek&&<input className="motion-chart-seek" type="range" aria-label="Buscar tempo no gráfico de locomoção" min={0} max={plot.duration} step={.01} value={Math.min(time,plot.duration)} onChange={event=>onSeek(Number(event.target.value))}/>}
      {!plot.pairs&&<p className="details-chart-note">Sem pares consecutivos observados para calcular a curva.</p>}
      <p className="details-chart-note">Lacunas permanecem vazias. Visualização em pixels; não representa distância no piso nem classifica comportamento.</p>
    </CardContent>
  </Card>;
}
