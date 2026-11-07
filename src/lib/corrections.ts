import type { BoundingBox, CorrectionEvent, PoseSample } from "../types";

export function validBox(box: BoundingBox | undefined | null): box is BoundingBox {
  return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0;
}

export function activeCorrectionEvents(events: CorrectionEvent[]) {
  const reverted = new Set(
    events.filter((event) => event.type === "REVERT_EVENT").map((event) => event.targetEventId),
  );
  return events.filter((event) => event.type !== "REVERT_EVENT" && !reverted.has(event.id));
}

export function applyCorrections(samples: PoseSample[], events: CorrectionEvent[]) {
  const overrides = new Map<string, CorrectionEvent[]>();
  const active = activeCorrectionEvents(events);
  active.forEach((event) => {
    if (event.frameIndex == null || !event.keypoint) return;
    if (event.type === "MOVE_POINT" || event.type === "SET_BOX" || event.type === "MARK_MISSING" || event.type === "CONFIRM_POINT") {
      const key = `${event.frameIndex}:${event.keypoint}`;
      overrides.set(key, [...(overrides.get(key) ?? []), event]);
    }
  });
  // Algumas saídas omitem a linha inteira de uma parte não detectada.
  // Uma posição humana pode criá-la; confirmação sozinha nunca cria observação.
  const existing = new Set(samples.map((sample) => `${sample.frameIndex}:${sample.keypoint}`));
  const frameTimes = new Map(samples.map((sample) => [sample.frameIndex, sample.timestampSec]));
  const additions: PoseSample[] = [];
  for (const [key, changes] of overrides) {
    if (existing.has(key)) continue;
    const move = changes.find((event) => (event.type === "SET_BOX" && event.keypoint === "box_center" && validBox(event.afterBox)) || (event.type === "MOVE_POINT" && event.after
      && Number.isFinite(event.after.x) && Number.isFinite(event.after.y) && event.after.x >= 0 && event.after.y >= 0));
    if (!move || move.frameIndex == null || !move.keypoint) continue;
    const timestampSec = frameTimes.get(move.frameIndex) ?? move.timestampSec;
    if (timestampSec == null || !Number.isFinite(timestampSec) || timestampSec < 0 || !Number.isInteger(move.frameIndex) || move.frameIndex < 0) continue;
    additions.push({ frameIndex: move.frameIndex, timestampSec, keypoint: move.keypoint, xPx: null, yPx: null,
      status: "missing", likelihood: 0, source: "detected" });
  }
  const result = [...samples, ...additions].map((sample) => {
    const original = sample.original ?? { xPx: sample.xPx, yPx: sample.yPx, likelihood: sample.likelihood,
      status: sample.status, spatialRegion: sample.spatialRegion, supportCount: sample.supportCount, supportTotal: sample.supportTotal,
      source: sample.source ?? "detected", bbox: sample.bbox, contour: sample.contour, metricReference: sample.metricReference, referenceApproved: sample.referenceApproved };
    return (overrides.get(`${sample.frameIndex}:${sample.keypoint}`) ?? []).reduce<PoseSample>((current, event) => {
      if (event.type === "SET_BOX") {
        if (event.keypoint !== "box_center" || !validBox(event.afterBox)) return current;
        const box = event.afterBox;
        return { ...current, original, bbox: { ...box }, contour: undefined, xPx: box.x + box.width / 2,
          yPx: box.y + box.height / 2, metricReference: "box_center", status: "valid", source: "manual", spatialRegion: "unknown" };
      }
      if (event.type === "CONFIRM_POINT") {
        if (current.source === "predicted" || current.xPx == null || current.yPx == null
          || current.status === "missing" || current.status === "out_of_arena"
          || (event.before && (event.before.x !== current.xPx || event.before.y !== current.yPx))) return current;
        return { ...current, original, status: "valid", source: "manual" };
      }
      if (event.type === "MARK_MISSING") return { ...current, original, xPx: null, yPx: null, bbox: undefined, contour: undefined, status: "missing", source: "manual", spatialRegion: "unknown" };
      if (!event.after || !Number.isFinite(event.after.x) || !Number.isFinite(event.after.y) || event.after.x < 0 || event.after.y < 0) return current;
      return { ...current, original, xPx: event.after.x, yPx: event.after.y, status: "valid", source: "manual", spatialRegion: "unknown" };
    }, sample);
  });
  // Caixas humanas são quadros-chave. A interpolação é uma prévia geométrica,
  // nunca uma detecção: mantém a observação original e não entra nas métricas.
  const lastBoxChange = new Map<number, CorrectionEvent>();
  for (const event of active) {
    if (event.frameIndex != null && event.keypoint === "box_center"
      && (event.type === "SET_BOX" || event.type === "MARK_MISSING" || event.type === "MOVE_POINT" || event.type === "CONFIRM_POINT")) {
      if (event.type !== "CONFIRM_POINT" || lastBoxChange.get(event.frameIndex)?.type !== "SET_BOX") {
        lastBoxChange.set(event.frameIndex, event);
      }
    }
  }
  const anchors = [...lastBoxChange.values()].filter((event) => event.type === "SET_BOX" && validBox(event.afterBox)
    && event.timestampSec != null && Number.isFinite(event.timestampSec))
    .sort((a, b) => a.timestampSec! - b.timestampSec! || a.frameIndex! - b.frameIndex!);
  if (anchors.length < 2) return additions.length ? sortSamples(result) : result;

  for (const sample of result) frameTimes.set(sample.frameIndex, sample.timestampSec);
  const knownFrames = [...frameTimes].sort(([a], [b]) => a - b);
  let frameCursor = 0;
  const centers = new Map(result.filter((sample) => sample.keypoint === "box_center").map((sample) => [sample.frameIndex, sample]));
  const predicted = new Map<number, PoseSample>();
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const start = anchors[index], end = anchors[index + 1];
    const startTime = start.timestampSec!, endTime = end.timestampSec!;
    if (endTime <= startTime || end.frameIndex! <= start.frameIndex!) continue;
    const first = start.afterBox!, last = end.afterBox!;
    // Só usa frames cujo relógio já veio do vídeo; não inventa timestamps.
    while (frameCursor < knownFrames.length && knownFrames[frameCursor][0] <= start.frameIndex!) frameCursor += 1;
    for (let offset = frameCursor; offset < knownFrames.length; offset += 1) {
      const [frame, time] = knownFrames[offset];
      if (frame >= end.frameIndex!) break;
      if (lastBoxChange.has(frame)) continue; // Respeita um frame explicitamente marcado como ausente.
      if (time <= startTime || time >= endTime) continue;
      const fraction = (time - startTime) / (endTime - startTime);
      const bbox = { x: first.x + (last.x - first.x) * fraction, y: first.y + (last.y - first.y) * fraction,
        width: first.width + (last.width - first.width) * fraction, height: first.height + (last.height - first.height) * fraction };
      const existing = centers.get(frame);
      const original = existing?.original ?? (existing ? { xPx: existing.xPx, yPx: existing.yPx, likelihood: existing.likelihood,
        status: existing.status, spatialRegion: existing.spatialRegion, supportCount: existing.supportCount, supportTotal: existing.supportTotal,
        source: existing.source ?? "detected", bbox: existing.bbox, contour: existing.contour,
        metricReference: existing.metricReference, referenceApproved: existing.referenceApproved }
        : { xPx: null, yPx: null, likelihood: 0, status: "missing" as const, source: "detected" as const,
          bbox: undefined, contour: undefined, metricReference: undefined, referenceApproved: undefined });
      predicted.set(frame, { ...existing, frameIndex: frame, timestampSec: time, keypoint: "box_center",
        xPx: bbox.x + bbox.width / 2, yPx: bbox.y + bbox.height / 2, bbox, contour: undefined,
        likelihood: 0, status: "low_confidence", source: "predicted", reason: "manual_keyframe_interpolation",
        metricReference: "box_center", referenceApproved: false, spatialRegion: "unknown", original });
    }
  }
  if (!predicted.size) return additions.length ? sortSamples(result) : result;
  const revised = result.map((sample) => sample.keypoint === "box_center" ? predicted.get(sample.frameIndex) ?? sample : sample);
  for (const [frame, sample] of predicted) if (!centers.has(frame)) revised.push(sample);
  return sortSamples(revised);
}

function sortSamples(samples: PoseSample[]) {
  return samples.sort((a, b) => a.timestampSec - b.timestampSec || a.frameIndex - b.frameIndex || a.keypoint.localeCompare(b.keypoint));
}

