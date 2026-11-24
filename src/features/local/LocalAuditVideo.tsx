import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { loadLocalAuditVideo } from "./api";

export function LocalAuditVideo({ jobId, protocol = "tracking", title = "Vídeo de auditoria" }: {
  jobId: string;
  protocol?: "tracking" | "presence";
  title?: string;
}) {
  const [renderRequest, setRenderRequest] = useState(0);
  const [video, setVideo] = useState<Awaited<ReturnType<typeof loadLocalAuditVideo>> | null>(null);
  const [playbackError, setPlaybackError] = useState(false);

  useEffect(() => {
    let live = true;
    setVideo(null);
    setPlaybackError(false);
    void loadLocalAuditVideo(jobId, renderRequest > 0)
      .then(artifact => { if (live) setVideo(artifact); })
      .catch(error => {
        if (live) setVideo({ videoUrl: null, videoError: error instanceof Error ? error.message : String(error) });
      });
    return () => { live = false; };
  }, [jobId, renderRequest]);

  return <section className="results-video-section" aria-label="Vídeo de auditoria da análise local">
    <div className="results-video-heading">
      <div>
        <h2>{title}</h2>
        <p>{protocol === "presence" ? "MP4 com os cilindros, as caixas e os estados de presença por frame."
          : "MP4 com a região analisada, as caixas e os estados do rastreamento por frame."} As anotações são as da execução selecionada.</p>
      </div>
      {video && !video.videoUrl && <Button type="button" size="sm" variant="secondary"
        onClick={() => setRenderRequest(count => count + 1)}>Gerar MP4</Button>}
    </div>
    <div className="dlc-video-panel results-video-player">
      {!video ? <p className="results-video-message" role="status">
        {renderRequest ? "Renderizando o vídeo de auditoria…" : "Carregando o vídeo de auditoria…"}
      </p> : video.videoUrl ? <>
        <video src={video.videoUrl} controls playsInline preload="metadata" aria-label="MP4 anotado da análise local"
          onError={() => setPlaybackError(true)} />
        {playbackError && <p className="results-video-message" role="alert">O player não conseguiu reproduzir este MP4.</p>}
      </> : <p className="results-video-message" role={video.videoError ? "alert" : "status"}>
        {video.videoError ?? "Gere o MP4 a partir do vídeo e das observações salvas desta execução."}
      </p>}
    </div>
  </section>;
}
