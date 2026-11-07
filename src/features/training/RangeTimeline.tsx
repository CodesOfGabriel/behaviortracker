import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CONTEXTS, type Context, type TrainingInterval } from "./schema";
import { editRange, frameStep, snapTime, tickSpacing, timeAtClientX, timelineTime, type RangeEdit, type TimelineSelection } from "./timeline";

type Gesture = {
  mode: RangeEdit | "seek";
  origin: number;
  range: TimelineSelection | null;
  pointerId: number;
};

export function RangeTimeline({ duration, fps, currentTime, selection, intervals, context, disabled, onChange, onSelect, onSeek }: {
  duration: number;
  fps: number;
  currentTime: number;
  selection: TimelineSelection | null;
  intervals: TrainingInterval[];
  context: Context;
  disabled: boolean;
  onChange: (range: TimelineSelection | null) => void;
  onSelect: (interval: TrainingInterval) => void;
  onSeek: (time: number) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointerX = useRef(0);
  const helpId = useId();
  const available = Number.isFinite(duration) && duration > 0;
  const locked = disabled || !available;
  const percent = (time: number) => `${100 * time / (available ? duration : 1)}%`;
  const spacing = tickSpacing((available ? duration : 1) / zoom);
  const ticks = Array.from({ length: Math.floor((available ? duration : 1) / spacing) + 1 }, (_, i) => i * spacing);
  const timeAt = (clientX: number) => {
    const rect = content.current!.getBoundingClientRect();
    return timeAtClientX(clientX, rect.left, rect.width, duration);
  };
  const update = (clientX: number) => {
    pointerX.current = clientX;
    const active = gesture.current;
    if (!active) return;
    const time = timeAt(clientX);
    if (active.mode === "seek") { onSeek(snapTime(time, duration, fps)); return; }
    const range = active.range ?? { startSec: active.origin, endSec: active.origin };
    const next = editRange(range, active.mode, active.origin, time, duration, fps);
    onChange({ ...next, ...(active.mode !== "create" && active.range?.id ? { id: active.range.id } : {}) });
    onSeek(active.mode === "end" ? next.endSec : active.mode === "create" ? snapTime(time, duration, fps) : next.startSec);
  };
  const latestUpdate = useRef(update);
  latestUpdate.current = update;
  useEffect(() => {
    if (!dragging || locked || zoom === 1) return;
    let request: number, previous = 0;
    const pan = (now: number) => {
      const viewport = scroller.current;
      if (viewport && gesture.current) {
        const rect = viewport.getBoundingClientRect();
        const margin = Math.min(40, rect.width / 5);
        const distance = pointerX.current < rect.left + margin ? pointerX.current - rect.left - margin : Math.max(0, pointerX.current - rect.right + margin);
        const speed = Math.max(-1, Math.min(1, distance / margin)) * 600;
        const before = viewport.scrollLeft;
        viewport.scrollLeft += speed * Math.min(now - (previous || now), 32) / 1000;
        if (viewport.scrollLeft !== before) latestUpdate.current(pointerX.current);
      }
      previous = now;
      request = requestAnimationFrame(pan);
    };
    request = requestAnimationFrame(pan);
    return () => cancelAnimationFrame(request);
  }, [dragging, locked, zoom]);
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (locked || event.button !== 0 || !event.isPrimary || gesture.current) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-saved-interval]")) return;
    if (!target.closest("[data-timeline-ruler],.range-draft-track")) return;
    event.preventDefault();
    const mode = target.closest<HTMLElement>("[data-range-edit]")?.dataset.rangeEdit as RangeEdit | undefined;
    gesture.current = { mode: target.closest("[data-timeline-ruler]") ? "seek" : mode ?? "create", origin: timeAt(event.clientX), range: selection, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    setDragging(true);
    update(event.clientX);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    if (cancel) onChange(gesture.current.range); else update(event.clientX);
    gesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>, mode?: "start" | "end") => {
    if (locked) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (gesture.current) { onChange(gesture.current.range); gesture.current = null; setDragging(false); }
      else onChange(null);
      return;
    }
    if (event.target !== event.currentTarget || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!selection) {
      const time = event.key === "Home" ? 0 : event.key === "End" ? duration : currentTime + (event.key === "ArrowLeft" ? -1 : 1) * frameStep(fps) * (event.shiftKey ? 10 : 1);
      onSeek(snapTime(time, duration, fps));
      return;
    }
    const edge = mode ?? "move";
    const origin = edge === "end" ? selection.endSec : selection.startSec;
    const time = event.key === "Home" ? 0 : event.key === "End" ? duration : origin + (event.key === "ArrowLeft" ? -1 : 1) * frameStep(fps) * (event.shiftKey ? 10 : 1);
    const next = editRange(selection, edge, origin, time, duration, fps);
    onChange({ ...selection, ...next });
    onSeek(edge === "end" ? next.endSec : next.startSec);
  };
  const changeZoom = (next: number) => {
    const viewport = scroller.current;
    const center = viewport ? (viewport.scrollLeft + viewport.clientWidth / 2) / (viewport.clientWidth * zoom) : .5;
    setZoom(next);
    requestAnimationFrame(() => { if (viewport) viewport.scrollLeft = center * viewport.clientWidth * next - viewport.clientWidth / 2; });
  };
  return <div className="range-timeline" role="group" aria-label="Timeline de trechos de treino" aria-disabled={locked}>
    <div className="range-timeline-toolbar">
      <div><strong>Timeline de anotações</strong><span className="range-clock">{timelineTime(currentTime)} <span>/ {timelineTime(available ? duration : 0)}</span></span></div>
      <div className="range-zoom"><button type="button" aria-label="Diminuir zoom da timeline" disabled={locked || zoom === 1} onClick={() => changeZoom(zoom / 2)}>−</button><span>{zoom}×</span><button type="button" aria-label="Aumentar zoom da timeline" disabled={locked || zoom === 32} onClick={() => changeZoom(zoom * 2)}>+</button><button type="button" disabled={locked || zoom === 1} onClick={() => changeZoom(1)}>Ajustar</button></div>
    </div>
    <p id={helpId} className="range-help">Arraste na faixa de seleção para marcar um trecho. Ajuste as alças ou arraste o meio para mover. Clique na régua para navegar no vídeo.</p>
    <div className="range-scroll" ref={scroller}>
      <div className={`range-content${dragging ? " is-dragging" : ""}`} ref={content} role="group" style={{ width: `${zoom * 100}%` }} tabIndex={locked ? -1 : 0} aria-label="Selecionar trecho na timeline" aria-describedby={helpId}
        onPointerDown={begin} onPointerMove={(e) => { if (gesture.current?.pointerId === e.pointerId) update(e.clientX); }} onPointerUp={(e) => finish(e)} onPointerCancel={(e) => finish(e, true)} onLostPointerCapture={(e) => { if (gesture.current?.pointerId === e.pointerId) finish(e, true); }} onKeyDown={(e) => keyboard(e)}>
        <div className="range-ruler" data-timeline-ruler="true" aria-label="Régua do vídeo">
          {ticks.map((time) => <span key={time} className="range-tick" style={{ left: percent(time) }}>{timelineTime(time).replace(/\.000$/, "")}</span>)}
        </div>
        <div className="range-draft-track" aria-label="Faixa de seleção">
          {!selection && <span className="range-empty">Arraste aqui para selecionar</span>}
          {selection && <div className="range-selection" data-range-edit="move" data-context={context} style={{ left: percent(selection.startSec), width: percent(selection.endSec - selection.startSec) }}>
            <span className="range-selection-label">{CONTEXTS[context]}</span>
            {(["start", "end"] as const).map((edge) => <button type="button" key={edge} className={`range-handle range-handle-${edge}`} data-range-edit={edge} role="slider" aria-label={edge === "start" ? "Ajustar início do trecho" : "Ajustar fim do trecho"}
              aria-valuemin={edge === "start" ? 0 : selection.startSec + Math.min(frameStep(fps), duration)} aria-valuemax={edge === "start" ? selection.endSec - Math.min(frameStep(fps), duration) : duration}
              aria-valuenow={edge === "start" ? selection.startSec : selection.endSec} aria-valuetext={timelineTime(edge === "start" ? selection.startSec : selection.endSec)} aria-orientation="horizontal" disabled={locked} onKeyDown={(e) => keyboard(e, edge)}><span /></button>)}
          </div>}
        </div>
        {(Object.entries(CONTEXTS) as [Context, string][]).map(([key, label]) => <div className="range-saved-track" data-context={key} key={key} aria-label={`Trechos de ${label}`}>
          <span className="range-track-label">{label}</span>
          {intervals.filter((interval) => interval.context === key).map((interval) => <button type="button" className="range-clip" data-saved-interval={interval.id} key={interval.id} aria-pressed={selection?.id === interval.id} disabled={locked}
            style={{ left: percent(interval.startSec), width: percent(interval.endSec - interval.startSec) }}
            title={`${label} · ${timelineTime(interval.startSec)} – ${timelineTime(interval.endSec)}`} aria-label={`Editar trecho ${label}, ${timelineTime(interval.startSec)} a ${timelineTime(interval.endSec)}`} onClick={() => onSelect(interval)}>{label}</button>)}
        </div>)}
        {available && <div className="range-playhead" style={{ left: percent(Math.max(0, Math.min(duration, currentTime))) }} aria-hidden="true"><span /></div>}
      </div>
    </div>
    <div className="range-readout" aria-live="polite" aria-atomic="true">
      {selection ? <><span>Entrada <strong>{timelineTime(selection.startSec)}</strong></span><span>Saída <strong>{timelineTime(selection.endSec)}</strong></span><span>Duração <strong>{timelineTime(selection.endSec - selection.startSec)}</strong></span></> : <span>Nenhum trecho selecionado</span>}
    </div>
    <small className="range-shortcuts">Alças + ← →: ajuste por frame · Shift: 10 frames · Esc: limpar seleção. Os tempos são referências; a extração confirma o frame pelo PTS do vídeo original.</small>
  </div>;
}
