import type { BehaviorLabel, CorrectionEvent, Experiment, PoseSample } from "../types";
import { activeCorrectionEvents } from "./corrections";
import { metricEligible } from "./pose";

export const BEHAVIOR_LABELS: Record<BehaviorLabel, string> = { rearing: "Rearing", grooming: "Grooming", freezing: "Freezing" };
export const BEHAVIOR_POLICY = { version: "behavior-candidates-1", validatedClassifier: false,
  minDurationSec: { rearing: .5, grooming: .5, freezing: 1 }, maxGapSec: .15,
  freezingMaxMotionBodyLengthsSec: .05, groomingPawFaceBodyLengths: .35,
  groomingMinPawMotionBodyLengthsSec: .08, rearingMaxProjectedLengthRatio: .65,
  metricSource: "human_confirmed_episodes_only" } as const;

export interface BehaviorCandidate {
  id: string; label: BehaviorLabel; startSec: number; endSec: number; evidence: string;
}
export interface BehaviorEpisode { label: BehaviorLabel; startSec: number; endSec: number }

/** União de intervalos por classe: confirmar duas sugestões sobrepostas não duplica episódios. */
export function behaviorEpisodes(events: CorrectionEvent[], duration: number): BehaviorEpisode[] {
  const result: BehaviorEpisode[] = [];
  for (const label of Object.keys(BEHAVIOR_LABELS) as BehaviorLabel[]) {
    const intervals = activeCorrectionEvents(events).filter((event) => event.type === "ANNOTATE_BEHAVIOR" && event.label === label
      && Number.isFinite(event.startSec) && Number.isFinite(event.endSec))
      .map((event) => ({ label, startSec: Math.max(0, event.startSec!), endSec: Math.min(duration, event.endSec!) }))
      .filter((event) => event.endSec > event.startSec).sort((a, b) => a.startSec - b.startSec);
    let last: BehaviorEpisode | undefined;
    for (const interval of intervals) {
      if (last && interval.startSec <= last.endSec) last.endSec = Math.max(last.endSec, interval.endSec);
      else { last = { ...interval }; result.push(last); }
    }
  }
  return result;
}

export function behaviorSummary(experiment: Experiment, duration: number) {
  const episodes = behaviorEpisodes(experiment.corrections, duration);
  return (Object.keys(BEHAVIOR_LABELS) as BehaviorLabel[]).map((label) => {
    const selected = episodes.filter((episode) => episode.label === label);
    const reviewed = experiment.behaviorReviewed?.[label] === true;
    return { label, reviewed, count: reviewed || selected.length ? selected.length : null,
      durationSec: reviewed || selected.length ? selected.reduce((sum, episode) => sum + episode.endSec - episode.startSec, 0) : null };
  });
}

/** Triagem exploratória de pose 2D, NÃO classificador treinado nem diagnóstico.
 * Só orienta a revisão humana. Sem pontos suficientes, não inventa um candidato.
 */
export function behaviorCandidates(samples: PoseSample[]): BehaviorCandidate[] {
  const byFrame = new Map<number, Map<string, PoseSample>>();
  for (const sample of samples) {
    if (!byFrame.has(sample.frameIndex)) byFrame.set(sample.frameIndex, new Map());
    byFrame.get(sample.frameIndex)!.set(sample.keypoint, sample);
  }
  const frames = [...byFrame.values()].sort((a, b) => a.values().next().value!.frameIndex - b.values().next().value!.frameIndex);
  const dist = (a: PoseSample, b: PoseSample) => Math.hypot(a.xPx! - b.xPx!, a.yPx! - b.yPx!);
  const get = (frame: Map<string, PoseSample>, name: string) => {
    const point = frame.get(name);
    return metricEligible(point) ? point : undefined;
  };
  const lengths = frames.flatMap((frame) => {
    const nose = get(frame, "nose"), tail = get(frame, "tail_base");
    return nose && tail && nose.spatialRegion !== "wall_projection" && dist(nose, tail) > 1 ? [dist(nose, tail)] : [];
  }).sort((a, b) => a - b);
  const bodyLength = lengths[Math.floor(lengths.length / 2)];
  if (!bodyLength) return [];
  const candidates: BehaviorCandidate[] = [];
  const pending = new Map<BehaviorLabel, BehaviorCandidate>();
  const flush = (label: BehaviorLabel) => {
    const run = pending.get(label);
    if (run && run.endSec - run.startSec >= BEHAVIOR_POLICY.minDurationSec[label]) candidates.push(run);
    pending.delete(label);
  };
  for (let index = 1; index < frames.length; index++) {
    const frame = frames[index], previous = frames[index - 1];
    const center = get(frame, "body_center"), prevCenter = get(previous, "body_center");
    const nose = get(frame, "nose"), tail = get(frame, "tail_base");
    const timePoint = frame.values().next().value!, prevTimePoint = previous.values().next().value!;
    const dt = timePoint.timestampSec - prevTimePoint.timestampSec;
    const continuous = timePoint.frameIndex === prevTimePoint.frameIndex + 1 && dt > 0 && dt <= BEHAVIOR_POLICY.maxGapSec;
    const bodyMotion = center && prevCenter && continuous ? dist(center, prevCenter) / dt / bodyLength : Infinity;
    const fullNames = ["body_center", "nose", "tail_base", "left_ear", "right_ear"];
    const fullMotion = continuous && fullNames.every((name) => get(frame, name) && get(previous, name))
      ? Math.max(...fullNames.map((name) => dist(get(frame, name)!, get(previous, name)!) / dt / bodyLength)) : Infinity;
    const pawActive = continuous && nose && ["left_forepaw", "right_forepaw"].some((name) => {
      const paw = get(frame, name), prevPaw = get(previous, name), prevNose = get(previous, "nose");
      if (!paw || !prevPaw || !prevNose) return false;
      const relativeMotion = Math.hypot((paw.xPx! - nose.xPx!) - (prevPaw.xPx! - prevNose.xPx!),
        (paw.yPx! - nose.yPx!) - (prevPaw.yPx! - prevNose.yPx!)) / dt / bodyLength;
      return dist(paw, nose) / bodyLength < BEHAVIOR_POLICY.groomingPawFaceBodyLengths
        && relativeMotion > BEHAVIOR_POLICY.groomingMinPawMotionBodyLengthsSec;
    });
    const flags: Record<BehaviorLabel, boolean> = {
      freezing: fullMotion <= BEHAVIOR_POLICY.freezingMaxMotionBodyLengthsSec,
      grooming: Boolean(pawActive && bodyMotion < .2 && nose && center && dist(nose, center) < bodyLength * .8),
      rearing: Boolean(continuous && nose && tail && center && nose.spatialRegion === "wall_projection"
        && center.spatialRegion === "floor" && dist(nose, tail) < bodyLength * BEHAVIOR_POLICY.rearingMaxProjectedLengthRatio && bodyMotion < .3),
    };
    const evidence = { freezing: "Pouco movimento dos cinco pontos visíveis. Sono, pausa e exploração ainda precisam ser descartados no vídeo.",
      grooming: "Pata anterior próxima ao focinho com movimento relativo e pouco deslocamento corporal. Confirme a sequência de autolimpeza.",
      rearing: "Encurtamento da projeção corporal com focinho na projeção da parede. A vista superior não comprova elevação." };
    for (const label of Object.keys(flags) as BehaviorLabel[]) {
      if (!flags[label]) { flush(label); continue; }
      const run = pending.get(label);
      if (run) run.endSec = timePoint.timestampSec;
      else pending.set(label, { id: `${BEHAVIOR_POLICY.version}:${label}:${prevTimePoint.frameIndex}`, label,
        startSec: prevTimePoint.timestampSec, endSec: timePoint.timestampSec, evidence: evidence[label] });
    }
  }
  for (const label of Object.keys(BEHAVIOR_LABELS) as BehaviorLabel[]) flush(label);
  return candidates;
}

export function behaviorCsv(experiment: Experiment, duration: number) {
  const header = "behavior,start_sec,end_sec,duration_sec,source";
  return [header, ...behaviorEpisodes(experiment.corrections, duration).map((episode) =>
    `${episode.label},${episode.startSec},${episode.endSec},${episode.endSec - episode.startSec},human_confirmed`)].join("\n");
}
