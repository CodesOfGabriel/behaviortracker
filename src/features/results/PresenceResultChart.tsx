import { useMemo } from "react";
import { ChartNoAxesColumnIncreasing } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../components/ui/card";

export function PresenceResultChart({subjects,frames}:{subjects:{animalId:string;subjectId:string}[];frames:{animalId:string;presence:string}[]}) {
  const rows=useMemo(()=>subjects.map(subject=>{
    const counts={IN_TANK:0,UNCERTAIN:0,NOT_IN_TANK:0};
    for(const frame of frames)if(frame.animalId===subject.animalId&&frame.presence in counts)counts[frame.presence as keyof typeof counts]++;
    return {...subject,counts,total:counts.IN_TANK+counts.UNCERTAIN+counts.NOT_IN_TANK};
  }),[subjects,frames]);
  return <Card><CardHeader><CardTitle className="details-card-title"><ChartNoAxesColumnIncreasing size={16}/>Presença por cilindro</CardTitle><CardDescription>Distribuição dos quadros observados por animal.</CardDescription></CardHeader>
    <CardContent><div className="presence-chart-legend"><span><i className="presence-in"/>Presença</span><span><i className="presence-uncertain"/>Incerto</span><span><i className="presence-out"/>Ausência</span></div>
      <div className="presence-result-rows">{rows.map(row=><div key={row.animalId}><div className="presence-result-label"><strong>{row.subjectId}</strong><span>{row.total.toLocaleString("pt-BR")} quadros</span></div>
        <div className="presence-result-bar" role="img" aria-label={`${row.subjectId}: ${row.counts.IN_TANK} presença, ${row.counts.UNCERTAIN} incertos, ${row.counts.NOT_IN_TANK} ausência`}>
          {(["IN_TANK","UNCERTAIN","NOT_IN_TANK"] as const).map((key,i)=><span key={key} className={["presence-in","presence-uncertain","presence-out"][i]} style={{width:`${row.total?row.counts[key]/row.total*100:0}%`}}/>)}</div>
        <p>{row.total?(100*row.counts.IN_TANK/row.total).toFixed(1):"—"}% com presença · {row.counts.UNCERTAIN.toLocaleString("pt-BR")} incertos</p>
      </div>)}</div><p className="details-chart-note">Presença visual. Imobilidade, natação e escalada não são classificadas automaticamente.</p></CardContent>
  </Card>;
}
