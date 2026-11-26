import type { PoseSample } from "../../types";
import type { BehaviorPrediction } from "../../lib/behavior/types";
import { postureLabels } from "../../lib/behavior/types";
import { LocalBodyOverlay } from "../local/LocalBodyOverlay";

export function BehaviorVideoOverlay({sample,samples,prediction,width,height}: {sample?:PoseSample;samples?:readonly PoseSample[];prediction?:BehaviorPrediction;width:number;height:number}) {
  const box=sample?.bbox;
  const rearing=prediction?.classification.startsWith("REARING_");
  const color=rearing?"#a56be0":sample?.behaviorObservation==="OBSERVED"?"#78b96a":"#e5b85c";
  return <svg className="behavior-video-overlay" viewBox={`0 0 ${width} ${height}`} aria-label="Caixa e eixo geométrico da silhueta">
    {box&&sample?.source!=="predicted"&&sample?.status!=="missing"&&<rect x={box.x} y={box.y} width={box.width} height={box.height} stroke={color} strokeWidth={2} fill="none"/>}
    <LocalBodyOverlay sample={sample} samples={samples} width={width} height={height}/>
    {prediction&&<text x={12} y={30} fill={color} stroke="#17251b" paintOrder="stroke" strokeWidth={3} fontSize={20}>{postureLabels[prediction.classification]}{prediction.pRearing!=null?` · ${prediction.scoreKind==="probability"?"confiança":"score"} ${(100*prediction.pRearing).toFixed(0)}%`:""}</text>}
  </svg>;
}
