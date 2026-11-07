import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { BoundingBox, Point } from "../../types";
import { boxFromPoints, translateBox } from "../../lib/boxes";
import { validBox } from "../../lib/corrections";

type Drag = { pointerId: number; anchor: Point; box?: BoundingBox; opposite?: Point };

/** Coordenadas em pixels do original, inclusive com letterboxing no player. */
export function BoxOverlay({ box, width, height, drawing, editable, predicted, manual, onStart, onCancel, onCommit }: {
  box?: BoundingBox; width: number; height: number; drawing: boolean; editable: boolean; predicted?: boolean; manual?: boolean;
  onStart: () => void; onCancel: () => void; onCommit: (box: BoundingBox) => void;
}) {
  const [preview, setPreview] = useState<BoundingBox | null>(null);
  const drag = useRef<Drag | null>(null);
  const group = useRef<SVGGElement>(null);
  const cancel = () => { drag.current = null; setPreview(null); onCancel(); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && (drawing || drag.current)) cancel(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  });
  const position = (event: PointerEvent<SVGElement>): Point => {
    const matrix = group.current?.ownerSVGElement?.getScreenCTM();
    if (!matrix) throw new Error("Vídeo ainda não disponível");
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: Math.max(0, Math.min(width, point.x)), y: Math.max(0, Math.min(height, point.y)) };
  };
  const begin = (event: PointerEvent<SVGElement>, move?: BoundingBox, opposite?: Point) => {
    if (!editable || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation(); onStart();
    drag.current = { pointerId: event.pointerId, anchor: position(event), box: move, opposite };
    group.current?.setPointerCapture(event.pointerId);
  };
  const nextBox = (event: PointerEvent<SVGElement>, state: Drag) => {
    const point = position(event);
    return state.box ? translateBox(state.box, { x: point.x - state.anchor.x, y: point.y - state.anchor.y }, width, height)
      : boxFromPoints(state.opposite ?? state.anchor, point);
  };
  const visible = preview ?? box;
  const size = Math.max(5, width * .007);
  return <g ref={group} className="tracking-box-layer"
    onPointerMove={event => { const state = drag.current; if (state?.pointerId === event.pointerId) { event.stopPropagation(); setPreview(nextBox(event, state)); } }}
    onPointerUp={event => {
      const state = drag.current; if (state?.pointerId !== event.pointerId) return;
      event.stopPropagation(); const next = nextBox(event, state);
      drag.current = null; setPreview(null); onCancel();
      if (group.current?.hasPointerCapture(event.pointerId)) group.current.releasePointerCapture(event.pointerId);
      if (validBox(next) && next.width >= 3 && next.height >= 3 && (!box || Object.keys(next).some(key => Math.abs(next[key as keyof BoundingBox] - box[key as keyof BoundingBox]) > .01))) onCommit(next);
    }}
    onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }}>
    {visible && validBox(visible) && <g data-tracking-box="animal">
      <rect {...visible} fill={manual ? "#bb9aff12" : "none"} stroke={predicted ? "#f7c96b" : manual ? "#bb9aff" : "#d7f169"}
        strokeWidth={Math.max(2, width * .002)} strokeDasharray={predicted ? "10 7" : undefined}
        style={{ cursor: editable ? "move" : "default", pointerEvents: editable ? "all" : "none" }} onPointerDown={event => begin(event, visible)} />
      <text x={visible.x} y={Math.max(15, visible.y - 8)} fill="#fff" fontSize={Math.max(12, width * .012)}>
        {predicted ? "Previsão · não observada" : manual ? "Caixa manual" : "Animal · caixa observada"}
      </text>
      {editable && !drawing && [
        [visible.x, visible.y, visible.x + visible.width, visible.y + visible.height],
        [visible.x + visible.width, visible.y, visible.x, visible.y + visible.height],
        [visible.x, visible.y + visible.height, visible.x + visible.width, visible.y],
        [visible.x + visible.width, visible.y + visible.height, visible.x, visible.y],
      ].map(([x, y, ox, oy], index) => <rect key={index} data-box-handle={index} x={x-size/2} y={y-size/2} width={size} height={size}
        fill="#bb9aff" stroke="#171821" strokeWidth="1" style={{ cursor: index === 0 || index === 3 ? "nwse-resize" : "nesw-resize" }}
        onPointerDown={event => begin(event, undefined, { x: ox, y: oy })} />)}
    </g>}
    {drawing && editable && <rect data-box-draw="true" width={width} height={height} fill="transparent" style={{ cursor: "crosshair" }} onPointerDown={event => begin(event)} />}
  </g>;
}
