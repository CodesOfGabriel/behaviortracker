import { useMemo } from "react";
import { boxCenterTrajectory, boxTrajectoryStyle } from "../../lib/boxes";
import type { PoseSample } from "../../types";

export function BoxTrajectoryView({ tracks, width, height }: {
  tracks: ReadonlyMap<string, readonly PoseSample[]>; width: number; height: number;
}) {
  const data = useMemo(() => [...tracks].map(([id, rows]) => ({id, ...boxCenterTrajectory(rows, width, height)})), [tracks,width,height]);
  return <section className="panel trajectory-card"><div className="panel-header"><div><h2>Trajetória da execução selecionada</h2>
    <p>Centro de cada caixa no vídeo. Perdas mantêm lacunas; previsões e recuperações ficam tracejadas.</p></div></div>
    {data.some(track=>track.boxFrames) ? <div className="trajectory-canvas"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Trajetórias separadas por animal">
      <rect width={width} height={height} fill="#f1f3ee"/>
      {data.map(track=><g key={track.id}>{track.segments.map((segment,index)=>segment.points.length===1
        ? <circle key={index} cx={segment.points[0].x} cy={segment.points[0].y} r={Math.max(2,width/500)} fill={boxTrajectoryStyle[segment.state].color}/>
        : <polyline key={index} points={segment.points.map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke={boxTrajectoryStyle[segment.state].color}
          strokeDasharray={boxTrajectoryStyle[segment.state].dash} strokeWidth={Math.max(2,width/500)}/>)}</g>)}
    </svg></div> : <p>Selecione uma execução concluída com caixas para visualizar a trajetória.</p>}
    <p>Verde: observado · âmbar: incerto · tracejado: previsto/recuperado. Esta visualização não aprova métricas.</p>
  </section>;
}
