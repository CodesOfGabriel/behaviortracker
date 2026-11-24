import { useMemo } from "react";
import type { PoseSample } from "../../types";
import { boxMotionSeries } from "../../lib/local-motion";

/** SVG child shared by the three local protocol players. */
export function LocalMotionOverlay({ samples, tracks, width, height, time }: {
  samples?: readonly PoseSample[]; tracks?: ReadonlyMap<string, readonly PoseSample[]>;
  width: number; height: number; time: number;
}) {
  const series = useMemo(() => [...(tracks ?? new Map([["animal", samples ?? []]]))].map(([id, rows]) => ({
    id, values: boxMotionSeries(rows, width, height),
  })), [samples, tracks, width, height]);
  const window = series.map(track => ({ ...track, values: track.values.filter(row => row.timestampSec <= time && row.timestampSec >= time-10) }));
  const maximum = Math.max(1, ...window.flatMap(track => track.values.map(row => row.speedPxSec ?? 0)));
  const w = width*.29, h = height*.22, pad = width*.012, left = w*.13, top = h*.36;
  const plotWidth = w-left-pad, plotHeight = h-top-h*.18;
  const colors = ["#51ddce", "#f7c96b", "#c9a8ff"];
  return <g transform={`translate(${width-w-pad},${pad})`} pointerEvents="none" aria-label="Locomoção no canto superior direito, pixels por segundo">
    <rect width={w} height={h} rx={pad*.5} fill="#101a20" fillOpacity={.9} />
    <text x={pad} y={h*.16} fontSize={h*.12} fill="#fff">LOCOMOÇÃO · IMAGEM (px/s)</text>
    <text x={pad} y={h*.30} fontSize={h*.095} fill="#c5d2d8">Centro da caixa · últimos 10 s</text>
    <path d={`M${left},${top}V${top+plotHeight}H${left+plotWidth}`} fill="none" stroke="#647880" strokeWidth={Math.max(1,width/1400)} />
    <text x={pad*.3} y={top+plotHeight} fontSize={h*.085} fill="#c5d2d8">0</text>
    <text x={pad*.3} y={top} fontSize={h*.085} fill="#c5d2d8">{Math.round(maximum)}</text>
    {window.map((track, index) => {
      const paths: string[] = []; let continuous = false, lastFrame = -2;
      for (const row of track.values) {
        if (row.speedPxSec == null) { continuous = false; continue; }
        const x = left+(row.timestampSec-(time-10))/10*plotWidth;
        const y = top+plotHeight-row.speedPxSec/maximum*plotHeight;
        paths.push(`${continuous && row.frameIndex === lastFrame+1 ? "L" : "M"}${x},${y}`);
        continuous = true; lastFrame = row.frameIndex;
      }
      return <g key={track.id}>
        <path d={paths.join(" ")} fill="none" stroke={colors[index%colors.length]} strokeWidth={Math.max(1.5,width/700)} />
        <text x={left+index*plotWidth/window.length} y={h*.95} fill={colors[index%colors.length]} fontSize={h*.09}>
          {window.length > 1 ? `C${index+1}: ` : ""}{track.values.at(-1)?.speedPxSec?.toFixed(0) ?? "—"} px/s
        </text>
      </g>;
    })}
  </g>;
}
