export type TimeRange = { startSec: number; endSec: number };
export type TimelineSelection = TimeRange & { id?: string };
export type RangeEdit = "create" | "move" | "start" | "end";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const frameStep = (fps: number) => 1 / (Number.isFinite(fps) && fps > 0 ? fps : 30);

export function timeAtClientX(clientX: number, left: number, width: number, duration: number) {
  if (![clientX, left, width, duration].every(Number.isFinite) || width <= 0 || duration <= 0) return 0;
  return clamp((clientX - left) / width, 0, 1) * duration;
}

export function snapTime(time: number, duration: number, fps: number) {
  const step = frameStep(fps);
  return clamp(Math.round(time / step) * step, 0, duration);
}

export function editRange(range: TimeRange, mode: RangeEdit, origin: number, time: number, duration: number, fps: number): TimeRange {
  const step = Math.min(frameStep(fps), duration);
  const target = snapTime(time, duration, fps);
  if (mode === "move") {
    const delta = clamp(Math.round((time - origin) / step) * step, -range.startSec, duration - range.endSec);
    return { startSec: range.startSec + delta, endSec: range.endSec + delta };
  }
  if (mode === "start") return { startSec: clamp(target, 0, range.endSec - step), endSec: range.endSec };
  if (mode === "end") return { startSec: range.startSec, endSec: clamp(target, range.startSec + step, duration) };
  const anchor = snapTime(origin, duration, fps);
  const startSec = Math.min(Math.min(anchor, target), Math.max(0, duration - step));
  return { startSec, endSec: Math.min(duration, Math.max(anchor, target, startSec + step)) };
}

export function timelineTime(time: number) {
  const ms = Math.round(Math.max(0, time) * 1000);
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export function tickSpacing(visibleDuration: number) {
  const target = Math.max(.001, visibleDuration / 6);
  const scale = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].find((n) => n * scale >= target)! * scale;
}
