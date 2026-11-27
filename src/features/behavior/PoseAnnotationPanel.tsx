import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../components/ui/Button";
import { SelectMenu } from "../../components/ui/SelectMenu";
import { bodyLandmarks, type BehaviorAnnotation, type BodyLandmark, type HumanPose, type LandmarkPosition } from "../../lib/behavior/types";
import { activePoseFrames, suggestedPoseFrames, videoPoint } from "../../lib/behavior/studio";
import type { PoseSample } from "../../types";

const keys=Object.keys(bodyLandmarks) as BodyLandmark[];
type Frame={frameIndex:number;timestampSec:number};
export function PoseAnnotationPanel({zoom,onZoom,stage,width,height,times,samples,annotations,currentFrame,capture,onSeek,onSave,onDirty,saving}: {
 zoom:string;onZoom:(value:string)=>void;stage:HTMLElement|null;width:number;height:number;times:number[];samples:PoseSample[];annotations:BehaviorAnnotation[];
 currentFrame:number|null;capture:()=>Frame|null;onSeek:(time:number)=>void;
 onSave:(frame:Frame,pose:HumanPose)=>Promise<boolean>;onDirty:(value:boolean)=>void;saving:boolean;
}) {
 const [target,setTarget]=useState<Frame|null>(null),[points,setPoints]=useState<Partial<HumanPose>>({});
 const [selected,setSelected]=useState<BodyLandmark>("nose"),[dirty,setDirty]=useState(false),[message,setMessage]=useState("");
 const dragging=useRef<BodyLandmark|null>(null);
 const saved=useMemo(()=>activePoseFrames(annotations),[annotations]);
 const suggestions=useMemo(()=>suggestedPoseFrames(times,annotations,samples),[times,annotations,samples]);
 const pending=suggestions.filter(i=>!saved.some(e=>e.frameIndex===i));
 const onTarget=target!=null&&currentFrame===target.frameIndex;
 useEffect(()=>{onDirty(dirty);},[dirty,onDirty]);
 useEffect(()=>{if(target&&!dirty)setPoints(saved.find(e=>e.frameIndex===target.frameIndex)?.pose??{});},[saved,target,dirty]);
 const choose=(key:BodyLandmark,position:LandmarkPosition,advance=false)=>{
  const next={...points,[key]:position};setPoints(next);if(advance)setSelected(keys.find(k=>!next[k])??key);setDirty(true);setMessage("");
 };
 function start(){
  if(dirty){setMessage("Salve ou descarte os pontos atuais antes de anotar outro quadro.");return;}
  const frame=capture();if(!frame){setMessage("Aguarde o quadro terminar de carregar.");return;}
  const existing=saved.find(e=>e.frameIndex===frame.frameIndex);
  setTarget(frame);setPoints(existing?.pose??{});setSelected("nose");setMessage(existing?"Anotação carregada para revisão. A versão anterior permanece no histórico.":"Clique no nariz e siga a lista de pontos. Marque como oculto aquilo que não está visível.");
 }
 function pointerPosition(event:PointerEvent<SVGSVGElement>,key:BodyLandmark,advance=false){
  if(!onTarget||saving)return;
  const p=videoPoint(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect(),width,height);
  if(p)choose(key,{...p,visibility:"visible"},advance);
 }
 async function save(){
  if(!target||!keys.every(k=>points[k])||!keys.some(k=>points[k]?.visibility==="visible"))return;
  if(await onSave(target,points as HumanPose)){setDirty(false);setMessage("Pontos salvos. Você pode revisar este quadro ou avançar para o próximo.");}
 }
 return <div className="behavior-pose-panel" data-editing={Boolean(target)}>
  {!target&&<strong>Pontos corporais</strong>}
  <SelectMenu label="Ampliação da imagem" value={zoom} onChange={onZoom} options={[{value:"1",label:"1× · imagem inteira"},{value:"2",label:"2×"},{value:"4",label:"4×"}]}/>
  <p className="behavior-help">Amplie para posicionar pontos pequenos. Use as barras de rolagem para navegar na imagem.</p>
  <p className="behavior-pose-progress">{saved.length} {saved.length===1?"quadro anotado":"quadros anotados"} · {pending.length} sugestões pendentes</p>
  {!target&&<><SelectMenu label="Quadros sugeridos para anotação" value={currentFrame!=null&&suggestions.includes(currentFrame)?String(currentFrame):""} disabled={dirty||saving} onChange={value=>onSeek(times[Number(value)])} placeholder="Escolha um quadro para revisar" options={suggestions.map(i=>({value:String(i),label:`${times[i].toFixed(3)} s · quadro ${i+1}${saved.some(e=>e.frameIndex===i)?" · salvo":""}`}))}/>
  <div className="behavior-mark-buttons"><Button size="sm" variant="secondary" disabled={dirty||saving||!pending.length} onClick={()=>{const next=pending.find(i=>i>(currentFrame??-1))??pending[0];onSeek(times[next]);}}>Próximo quadro pendente</Button><Button size="sm" disabled={saving||dirty||currentFrame==null} onClick={start}>Anotar este quadro</Button></div></>}
  {target&&<>
   <strong>Quadro {target.frameIndex+1} · {target.timestampSec.toFixed(3)} s</strong>
   {!onTarget&&<div role="status" className="behavior-pose-frame-warning"><p>Volte ao quadro da anotação para posicionar os pontos.</p><Button size="sm" variant="secondary" onClick={()=>onSeek(target.timestampSec)}>Voltar ao quadro da anotação</Button></div>}
   <div role="group" aria-label="Ponto corporal a marcar" className="behavior-landmark-list">{keys.map((key,i)=><button type="button" key={key} disabled={saving} aria-pressed={selected===key} onClick={()=>setSelected(key)}><span>{i+1}. {bodyLandmarks[key]}</span><small>{points[key]?.visibility==="visible"?"Posicionado":points[key]?.visibility==="occluded"?"Oculto":points[key]?.visibility==="out_of_frame"?"Fora da imagem":"Pendente"}</small></button>)}</div>
   <div className="behavior-mark-buttons"><Button size="sm" variant="secondary" disabled={!onTarget||saving} onClick={()=>choose(selected,{visibility:"occluded",x:null,y:null},true)}>Ponto oculto</Button><Button size="sm" variant="secondary" disabled={!onTarget||saving} onClick={()=>choose(selected,{visibility:"out_of_frame",x:null,y:null},true)}>Fora da imagem</Button></div>
   <p className="behavior-help">Clique para posicionar {bodyLandmarks[selected].toLowerCase()}. Arraste um marcador para corrigir. Com a imagem em foco, use as setas para ajustar um pixel.</p>
   <div className="behavior-mark-buttons"><Button size="sm" loading={saving} disabled={!dirty||!keys.every(k=>points[k])||!keys.some(k=>points[k]?.visibility==="visible")} onClick={()=>void save()}>Salvar pontos corporais</Button>
   <Button size="sm" variant="ghost" disabled={saving} onClick={()=>{setPoints({});setTarget(null);setDirty(false);setMessage("Anotações salvas preservadas. Escolha um quadro para continuar.");}}>{dirty?"Descartar pontos em edição":"Escolher outro quadro"}</Button></div>
  </>}
  <p role="status" className="behavior-notice">{message||(target?"Selecione o ponto e clique no vídeo.":"As sugestões incluem ápices, outros momentos do vídeo e quadros com tracking incerto.")}</p>
  {stage&&createPortal(<svg className="behavior-pose-canvas" viewBox={`0 0 ${width} ${height}`} role="application" aria-label="Imagem para marcar pontos corporais" tabIndex={0}
   onPointerDown={event=>{if(!onTarget||saving)return;event.preventDefault();const key=(event.target as Element).getAttribute("data-landmark") as BodyLandmark|null;if(key&&keys.includes(key)){dragging.current=key;setSelected(key);event.currentTarget.setPointerCapture(event.pointerId);}else pointerPosition(event,selected,true);}}
   onPointerMove={event=>{if(dragging.current)pointerPosition(event,dragging.current);}}
   onPointerUp={()=>{dragging.current=null;}} onPointerCancel={()=>{dragging.current=null;}}
   onKeyDown={event=>{if(!onTarget||saving||!event.key.startsWith("Arrow"))return;event.preventDefault();event.stopPropagation();const p=points[selected];if(p?.visibility!=="visible")return;const delta=event.shiftKey?5:1;choose(selected,{visibility:"visible",x:Math.max(0,Math.min(width-.01,p.x+(event.key==="ArrowRight"?delta:event.key==="ArrowLeft"?-delta:0))),y:Math.max(0,Math.min(height-.01,p.y+(event.key==="ArrowDown"?delta:event.key==="ArrowUp"?-delta:0)))});}}>
   {onTarget&&keys.map(key=>{const p=points[key];return p?.visibility==="visible"?<circle key={key} data-landmark={key} cx={p.x} cy={p.y} r={Math.max(4,width*.007)} fill={selected===key?"#a9d89a":"#f2c979"} stroke="#111b17" strokeWidth={2}/>:null;})}
  </svg>,stage)}
 </div>;
}
