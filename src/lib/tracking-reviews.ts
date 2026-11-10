import type { CorrectionEvent, Experiment, PoseSample, TrackingSelection } from "../types";

export function trackingSourceKey(selection?: TrackingSelection) {
  return selection ? `${selection.engine}:${selection.jobId}` : "legacy";
}

/** Comportamentos descrevem o vídeo. Coordenadas pertencem a uma execução, nunca a outra. */
export function reviewEvents(experiment: Experiment): CorrectionEvent[] {
  const current = trackingSourceKey(experiment.trackingSelection);
  const events = new Map(experiment.corrections.map(event => [event.id, event]));
  const scope = (event: CorrectionEvent, visited = new Set<string>()): string => {
    if (visited.has(event.id)) return "invalid";
    visited.add(event.id);
    if (event.type === "REVERT_EVENT") {
      const target = events.get(event.targetEventId ?? "");
      return target ? scope(target, visited) : "invalid";
    }
    if (event.type === "REJECT_CANDIDATE") return event.reviewSource ?? "legacy";
    if (event.type === "ANNOTATE_BEHAVIOR") {
      return event.sourceVideoSha256 && event.sourceVideoSha256 === experiment.video.sha256
        ? "shared"
        : event.reviewSource ?? "legacy";
    }
    return event.reviewSource ?? experiment.legacyReviewSource ?? "legacy";
  };
  return experiment.corrections.filter(event => [current, "shared"].includes(scope(event)));
}

export function hasUnassignedCorrections(experiment: Experiment) {
  return (!experiment.legacyReviewSource || experiment.legacyReviewSource === "legacy") && !!experiment.trackingSelection
    && experiment.corrections.some(event => !event.reviewSource && ["MOVE_POINT", "SET_BOX", "MARK_MISSING", "CONFIRM_POINT"].includes(event.type));
}

export function preferredReference(samples: PoseSample[]) {
  return ["box_center", "silhouette_center", "body_center", "mouse_center"].find(key => samples.some(sample => sample.keypoint === key)) ?? samples[0]?.keypoint ?? "body_center";
}

/** Não altera/apaga eventos. Congela a revisão anterior antes de trocar os dados exibidos. */
export function selectTrackingReview(experiment: Experiment, selection: TrackingSelection, samples: PoseSample[]): Partial<Experiment> {
  const previous = trackingSourceKey(experiment.trackingSelection);
  const next = trackingSourceKey(selection);
  const trackingReviews = { ...experiment.trackingReviews, [previous]: { referencePoint: experiment.referencePoint } };
  const referencePoint = trackingReviews[next]?.referencePoint ?? preferredReference(samples);
  return {
    trackingSelection: selection, trackingReviews: { ...trackingReviews, [next]: { referencePoint } }, referencePoint,
    // Sem seleção anterior, o app antigo carregava o último Colab. Vincule uma única vez.
    // Se o usuário já selecionou OpenCV, a origem dos eventos antigos é ambígua: peça associação explícita.
    legacyReviewSource: experiment.legacyReviewSource ?? (!experiment.trackingSelection
      ? selection.engine === "colab" ? next : "legacy"
      : experiment.trackingSelection.engine === "colab" ? previous : undefined),
    status: "review", analysisMethodVersion: "oft-0.2",
  };
}
