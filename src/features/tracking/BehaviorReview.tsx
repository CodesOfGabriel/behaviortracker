import { useMemo, useState } from "react";
import type { BehaviorLabel, CorrectionEvent, Experiment, PoseSample } from "../../types";
import { BEHAVIOR_LABELS, behaviorCandidates, behaviorSummary } from "../../lib/behaviors";
import { activeCorrectionEvents } from "../../lib/corrections";
import { Button } from "../../components/ui/Button";

interface Props {
  experiment: Experiment; samples: PoseSample[]; currentTime: number; duration: number; disabled: boolean;
  onSeek: (time: number) => void; onChange: (patch: Partial<Experiment>) => void;
}

export function BehaviorReview({ experiment, samples, currentTime, duration, disabled, onSeek, onChange }: Props) {
  const [label, setLabel] = useState<BehaviorLabel>("rearing");
  const [start, setStart] = useState(0), [end, setEnd] = useState(0);
  const [error, setError] = useState("");
  const suggestions = useMemo(() => behaviorCandidates(samples), [samples]);
  const active = activeCorrectionEvents(experiment.corrections);
  const decided = new Set(active.filter((event) => event.candidateId).map((event) => event.candidateId));
  const pending = suggestions.filter((candidate) => !decided.has(candidate.id));
  const summary = behaviorSummary(experiment, duration);
  const add = (partial: Partial<CorrectionEvent>) => {
    const event: CorrectionEvent = { id: crypto.randomUUID(), type: "ANNOTATE_BEHAVIOR", createdAt: new Date().toISOString(), source: "manual", ...partial };
    onChange({ corrections: [...experiment.corrections, event], status: "review" });
  };
  const save = () => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration) {
      setError("Marque início e fim dentro do vídeo; o fim deve ser posterior ao início."); return;
    }
    setError(""); add({ label, startSec: start, endSec: end });
  };
  return <section className="inspector-section behavior-review" aria-label="Revisão de comportamentos">
    <div className="inspector-label">Comportamentos · revisão assistida</div>
    <p>Sugestões exploratórias, não um classificador validado. Só episódios confirmados entram nos resultados. Reveja também trechos sem sugestões.</p>
    <label>Comportamento<select aria-label="Comportamento" value={label} onChange={(event) => setLabel(event.target.value as BehaviorLabel)}>
      {Object.entries(BEHAVIOR_LABELS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
    <div className="behavior-interval">
      <label>Início (s)<input aria-label="Início do comportamento" type="number" min="0" max={duration} step="0.001" value={start} onChange={(event) => setStart(Number(event.target.value))} /></label>
      <label>Fim (s)<input aria-label="Fim do comportamento" type="number" min="0" max={duration} step="0.001" value={end} onChange={(event) => setEnd(Number(event.target.value))} /></label>
    </div>
    <div className="behavior-interval"><Button size="sm" variant="secondary" disabled={disabled} onClick={() => setStart(Number(currentTime.toFixed(3)))}>Marcar início</Button><Button size="sm" variant="secondary" disabled={disabled} onClick={() => setEnd(Number(currentTime.toFixed(3)))}>Marcar fim</Button></div>
    <Button size="sm" disabled={disabled} onClick={save}>Confirmar episódio</Button>
    {error && <p role="alert">{error}</p>}
    <details><summary>{pending.length} sugestões pendentes · mostrar</summary>
      <p>Sem patas anteriores confiáveis não há sugestões de grooming. Sem evidência suficiente, a ausência de sugestão não significa ausência do comportamento.</p>
      {pending.slice(0, 20).map((candidate) => <article className="behavior-candidate" key={candidate.id}>
        <strong>{BEHAVIOR_LABELS[candidate.label]}? · {candidate.startSec.toFixed(2)}–{candidate.endSec.toFixed(2)} s</strong>
        <p>{candidate.evidence}</p><div className="behavior-interval">
          <Button size="sm" variant="secondary" onClick={() => { onSeek(candidate.startSec); setLabel(candidate.label); setStart(candidate.startSec); setEnd(candidate.endSec); }}>Revisar vídeo</Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => add({ type: "REJECT_CANDIDATE", candidateId: candidate.id })}>Descartar</Button>
        </div>
        <Button size="sm" disabled={disabled} onClick={() => add({ label: candidate.label, startSec: candidate.startSec, endSec: candidate.endSec, candidateId: candidate.id })}>Confirmar após revisar</Button>
      </article>)}
      {pending.length > 20 && <p>Revise as primeiras sugestões para exibir as próximas.</p>}
    </details>
    <div className="behavior-summary">{summary.map((item) => <div key={item.label}>
      <strong>{BEHAVIOR_LABELS[item.label]} · {item.count == null ? "não anotado" : `${item.count} episódio(s) · ${item.durationSec!.toFixed(2)} s`}</strong>
      <label><input type="checkbox" disabled={disabled} checked={item.reviewed} onChange={(event) => onChange({ behaviorReviewed: { ...experiment.behaviorReviewed, [item.label]: event.target.checked }, status: "review" })} /> Revisei todo o vídeo para esta classe</label>
    </div>)}</div>
    <details><summary>Episódios anotados</summary>{active.filter((event) => event.type === "ANNOTATE_BEHAVIOR").map((event) => <div className="behavior-episode" key={event.id}>
      <button onClick={() => onSeek(event.startSec!)}>{event.label} · {event.startSec?.toFixed(2)}–{event.endSec?.toFixed(2)} s</button>
      <button disabled={disabled} onClick={() => add({ type: "REVERT_EVENT", targetEventId: event.id })}>Remover</button>
    </div>)}</details>
  </section>;
}
