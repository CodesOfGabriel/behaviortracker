import { SelectMenu } from "../../components/ui/SelectMenu";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { postureLabels, type BehaviorEvent, type BehaviorReview, type OftPosture } from "../../lib/behavior/types";
import { intervalError } from "../../lib/behavior/validation";

function EventRow({event,duration,reviewer,onReview,onSeek}: {event:BehaviorEvent;duration:number;reviewer:string;onReview:(event:BehaviorReview)=>Promise<void>;onSeek:(time:number)=>void}) {
  const [editing,setEditing]=useState(false), [start,setStart]=useState(event.startSec), [end,setEnd]=useState(event.endSec), [label,setLabel]=useState(event.behavior);
  const [busy,setBusy]=useState(false), [error,setError]=useState<string|null>(null);
  async function review(type:BehaviorReview["type"]) {
    const problem=type==="CORRECT"?intervalError(start,end,duration):null;
    if(problem||!reviewer.trim()){setError(problem||"Informe o identificador do revisor.");return;}
    setBusy(true);setError(null);
    try{await onReview({id:crypto.randomUUID(),type,eventId:event.eventId,reviewerId:reviewer.trim(),createdAt:new Date().toISOString(),
      ...(type==="CORRECT"?{startSec:start,endSec:end,label}: {})});setEditing(false);}
    catch(reason){setError(String(reason));}finally{setBusy(false);}
  }
  const statuses={pending:"Pendente",confirmed:"Confirmado",rejected:"Rejeitado",corrected:"Corrigido"};
  return <div className="behavior-event-row"><div><button type="button" className="behavior-event-seek" onClick={()=>onSeek(event.startSec)}><strong>{event.startSec.toFixed(3)} – {event.endSec.toFixed(3)} s</strong></button><span>{postureLabels[event.behavior]} · {statuses[event.reviewStatus]}{event.censored?" · contém intervalo desconhecido":""}</span></div>
    <div className="behavior-review-actions"><Button size="sm" variant="secondary" disabled={busy} onClick={()=>void review("CONFIRM")}>Confirmar</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void review("REJECT")}>Rejeitar</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setEditing(!editing)}>Corrigir</Button></div>
    {editing&&<div className="behavior-correct-form"><label>Início (s)<input type="number" step=".001" value={start} onChange={e=>setStart(Number(e.target.value))}/></label><label>Fim (s)<input type="number" step=".001" value={end} onChange={e=>setEnd(Number(e.target.value))}/></label>
      <SelectMenu label="Comportamento" value={label} onChange={value=>setLabel(value as OftPosture)} options={Object.entries(postureLabels).map(([value,label])=>({value,label}))}/><Button size="sm" loading={busy} onClick={()=>void review("CORRECT")}>Salvar correção</Button></div>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
export function BehaviorEventReview({events,duration,onReview,onSeek}: {events:BehaviorEvent[];duration:number;onReview:(event:BehaviorReview)=>Promise<void>;onSeek:(time:number)=>void}) {
  const [reviewer,setReviewer]=useState("");
  return <section className="behavior-event-review"><h3>Revisar episódios</h3><label>Revisor<input value={reviewer} onChange={e=>setReviewer(e.target.value)} placeholder="Seu identificador" maxLength={200}/></label>
    {events.length?events.map(event=><EventRow key={`${event.eventId}:${event.reviewStatus}`} event={event} duration={duration} reviewer={reviewer} onReview={onReview} onSeek={onSeek}/>):<p>Nenhum episódio automático nesta execução. Confira a cobertura antes de interpretar a contagem.</p>}
  </section>;
}
