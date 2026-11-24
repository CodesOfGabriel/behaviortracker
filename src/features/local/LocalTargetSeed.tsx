import { useEffect, useState } from "react";
import type { BoundingBox, OpenFieldExperiment } from "../../types";
import { loadStagedVideo } from "../colab/analysis";
import { BoxOverlay } from "../tracking/BoxOverlay";
import { stageLocalOriginal } from "./api";

/** Uma indicação no primeiro frame orienta identidade; não aprova métricas. */
export function LocalTargetSeed({ experiment, file, disabled, box, onChange }: {
  experiment: OpenFieldExperiment; file?: File; disabled: boolean;
  box?: BoundingBox; onChange: (box?: BoundingBox) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [drawing, setDrawing] = useState(true);
  const { width, height } = experiment.video;
  useEffect(() => {
    if (!open) return;
    let live = true;
    let temporaryUrl: string | undefined;
    setReady(false); setError(undefined);
    void (async () => {
      if (file && file.name === experiment.video.filename && file.size === experiment.video.sizeBytes) {
        temporaryUrl = URL.createObjectURL(file);
        return temporaryUrl;
      }
      const media = await stageLocalOriginal(experiment.id, experiment.video, undefined, () => undefined);
      if (!media) throw new Error("Reabra o vídeo original para marcar o animal no primeiro frame.");
      return loadStagedVideo(experiment.id, media.uploadId);
    })().then(value => { if (live) setUrl(value); })
      .catch(reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; if (temporaryUrl) URL.revokeObjectURL(temporaryUrl); };
  }, [open, experiment.id, experiment.video.filename, experiment.video.sizeBytes, file]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Indicar o animal no primeiro frame (opcional)</summary>
    <p>Em vídeos com reflexos, desenhe uma caixa ajustada ao corpo, sem a cauda. Essa indicação orienta a busca inicial e continua sujeita à revisão.</p>
    {open && url && <div className="local-target-seed" style={{ aspectRatio: `${width} / ${height}` }}>
      <video src={url} muted playsInline preload="auto" aria-label="Primeiro frame do vídeo original"
        onLoadedData={event => {
          const video = event.currentTarget;
          if (video.videoWidth !== width || video.videoHeight !== height) {
            setReady(false); setError("A resolução do original não corresponde à calibração. Confira o vídeo e a arena.");
          } else setReady(true);
        }} onError={() => { setReady(false); setError("Não foi possível abrir o primeiro frame do vídeo original."); }} />
      {ready && <svg viewBox={`0 0 ${width} ${height}`} aria-label="Marcar caixa corporal inicial">
        <BoxOverlay box={box} width={width} height={height} drawing={drawing || !box} editable={!disabled}
          manual onStart={() => undefined} onCancel={() => undefined}
          onCommit={value => { onChange(value); setDrawing(false); }} />
      </svg>}
    </div>}
    {error && <p role="status">{error}</p>}
    {box && <button type="button" disabled={disabled} onClick={() => { onChange(undefined); setDrawing(true); }}>Remover indicação</button>}
  </details>;
}
