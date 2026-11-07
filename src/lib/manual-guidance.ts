import type { BoundingBox, CorrectionEvent, Experiment } from "../types";
import { activeCorrectionEvents, validBox } from "./corrections";
import { reviewEvents } from "./tracking-reviews";

export type ManualAnchor = { frameIndex: number; timestampSec: number; box: BoundingBox; eventId: string };
export type LocalGuidance = { sourceJobId: string; anchors: ManualAnchor[] };

/** Usa só caixas humanas ativas da execução OpenCV selecionada. Previsões nunca são rótulos. */
export function localGuidance(experiment: Experiment): LocalGuidance | null {
  const selection = experiment.trackingSelection;
  if (selection?.engine !== "opencv") return null;
  const lastChange = new Map<number, CorrectionEvent>();
  for (const event of activeCorrectionEvents(reviewEvents(experiment))) {
    if (event.keypoint !== "box_center" || event.frameIndex == null) continue;
    if (event.type === "SET_BOX" || event.type === "MARK_MISSING" || event.type === "MOVE_POINT") lastChange.set(event.frameIndex, event);
    // Uma confirmação posterior não apaga uma caixa desenhada no mesmo frame.
    if (event.type === "CONFIRM_POINT" && lastChange.get(event.frameIndex)?.type !== "SET_BOX") lastChange.set(event.frameIndex, event);
  }
  const anchors = [...lastChange.values()].filter((event) => event.type === "SET_BOX" && validBox(event.afterBox)
    && event.afterBox!.width >= 3 && event.afterBox!.height >= 3
    && event.afterBox!.x + event.afterBox!.width <= experiment.video.width
    && event.afterBox!.y + event.afterBox!.height <= experiment.video.height
    && Number.isInteger(event.frameIndex) && event.frameIndex! >= 0 && event.frameIndex! <= 2_000_000
    && event.timestampSec != null && Number.isFinite(event.timestampSec) && event.timestampSec >= 0)
    .map((event) => ({ frameIndex: event.frameIndex!, timestampSec: event.timestampSec!, box: event.afterBox!, eventId: event.id }))
    .sort((a, b) => a.frameIndex - b.frameIndex);
  return { sourceJobId: selection.jobId, anchors };
}

export function usableLocalGuidance(guidance: LocalGuidance | null): guidance is LocalGuidance {
  return !!guidance && guidance.anchors.length >= 2
    && guidance.anchors.at(-1)!.timestampSec - guidance.anchors[0].timestampSec >= 1;
}
