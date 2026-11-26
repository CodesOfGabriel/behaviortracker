import type { BehaviorAnnotation, BehaviorEvent } from "../../lib/behavior/types";
import { postureLabels } from "../../lib/behavior/types";

export function BehaviorEthogram({intervals, duration, time, onSeek, peaks=[], selectedPeakId, onSelectPeak}: {
  intervals: (BehaviorAnnotation | BehaviorEvent)[]; duration: number; time: number; onSeek: (time: number) => void;
  peaks?: BehaviorAnnotation[]; selectedPeakId?:string; onSelectPeak?:(peak:BehaviorAnnotation)=>boolean|void;
}) {
  return <div className="behavior-ethogram" aria-label="Linha do tempo comportamental">
    <div className="behavior-ethogram-track">
      {intervals.map(item => {
        const label = "behavior" in item ? item.behavior : item.label!;
        const start = item.startSec!, end = item.endSec!;
        return <button type="button" key={"eventId" in item ? item.eventId : item.id} className={`behavior-segment behavior-${label}`}
          style={{left: `${100*start/duration}%`, width: `${Math.max(.15,100*(end-start)/duration)}%`}}
          title={`${postureLabels[label]} · ${start.toFixed(3)}–${end.toFixed(3)} s`}
          aria-label={`${postureLabels[label]}, início ${start.toFixed(3)} segundos`} onClick={() => onSeek(start)}/>;
      })}
      {peaks.map(peak=><button key={peak.id} type="button" className={`behavior-peak behavior-${peak.label}`}
        style={{left:`${Math.min(100,Math.max(0,100*peak.timestampSec!/duration))}%`}}
        aria-label={`Ápice em ${peak.timestampSec!.toFixed(3)} segundos · ${postureLabels[peak.label!]}`}
        aria-pressed={selectedPeakId===peak.id} title={`Ápice · ${peak.timestampSec!.toFixed(3)} s · ${postureLabels[peak.label!]}`}
        onClick={()=>{if(onSelectPeak?.(peak)!==false)onSeek(peak.timestampSec!);}}/>)}
      <span className="behavior-playhead" style={{left:`${Math.min(100, Math.max(0,100*time/duration))}%`}}/>
    </div>
    <input type="range" min={0} max={duration} step="0.001" value={Math.min(time,duration)} aria-label="Posição no vídeo para anotação" onChange={e=>onSeek(Number(e.target.value))}/>
    <div className="behavior-timeline-labels"><span>0 s</span><span>Áreas vazias: ainda não anotadas</span><span>{duration.toFixed(2)} s</span></div>
  </div>;
}
