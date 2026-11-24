import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { loadLocalAuditVideo } from "./api";

export function LocalAuditVideo({ jobId, protocol = "tracking", title = "Vídeo de auditoria" }: {
  jobId: string;
  protocol?: "tracking" | "presence";
  title?: string;
}) {
  const [rendering, setRendering] = useState(false);
  const currentJob = useRef(jobId);
  currentJob.current = jobId;
  const [video, setVideo] = useState<Awaited<ReturnType<typeof loadLocalAuditVideo>> | null>(null);
  const [playbackError, setPlaybackError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setVideo(null);
    setRendering(false);
    setPlaybackError(false);
    setExportError(null);
    void loadLocalAuditVideo(jobId, false)
      .then(artifact => { if (live) setVideo(artifact); })
      .catch(error => {
        if (live) setVideo({ videoUrl: null, videoError: error instanceof Error ? error.message : String(error) });
      });
    return () => { live = false; };
  }, [jobId]);

  async function rebuildVideo() {
    if (rendering || exporting) return;
    setRendering(true); setVideo(null); setPlaybackError(false); setExportError(null);
    try {
      const artifact = await loadLocalAuditVideo(jobId, true);
      if (currentJob.current === jobId) setVideo(artifact);
    } catch (error) {
      if (currentJob.current === jobId) setVideo({ videoUrl: null, videoError: error instanceof Error ? error.message : String(error) });
    } finally {
      if (currentJob.current === jobId) setRendering(false);
    }
  }

  async function downloadVideo() {
    if (!video?.videoUrl || exporting) return;
    setExporting(true); setExportError(null);
    try {
      const response = await fetch(video.videoUrl);
      if (!response.ok) throw new Error("O MP4 salvo não pôde ser lido.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `${jobId}-analise-local.mp4`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Não foi possível exportar o MP4 local.");
    } finally { setExporting(false); }
  }

  return <section className="results-video-section" aria-label="Vídeo de auditoria da análise local">
    <div className="results-video-heading">
      <div>
        <h2>{title}</h2>
        <p>{protocol === "presence" ? "MP4 com os cilindros, as caixas e os estados de presença por frame."
          : "MP4 com a região analisada, as caixas e os estados do rastreamento por frame."} As anotações pertencem a esta execução.</p>
        <p>O MP4 atualizado inclui o gráfico de deslocamento no canto superior direito. O modo rápido usa pixels por segundo.
          {" Quando a silhueta permite, também exibe um esqueleto corporal estimado. Ele não identifica pontos anatômicos nomeados."}</p>
      </div>
      {video && !video.videoUrl && <Button type="button" size="sm" variant="secondary"
        onClick={() => void rebuildVideo()}>Gerar MP4</Button>}
      {video?.videoUrl && <Button type="button" size="sm" variant="secondary"
        disabled={exporting} onClick={() => void rebuildVideo()}>Atualizar MP4</Button>}
      {video?.videoUrl && <Button type="button" size="sm" variant="secondary" loading={exporting}
        onClick={() => void downloadVideo()}>Baixar MP4</Button>}
    </div>
    {exportError && <p role="alert">{exportError}</p>}
    <div className="dlc-video-panel results-video-player">
      {!video ? <p className="results-video-message" role="status">
        {rendering ? "Renderizando o vídeo de auditoria…" : "Carregando o vídeo de auditoria…"}
      </p> : video.videoUrl ? <>
        <video src={video.videoUrl} controls playsInline preload="none" aria-label="MP4 anotado da análise local"
          onError={() => setPlaybackError(true)} />
        {playbackError && <p className="results-video-message" role="alert">O player não conseguiu reproduzir este MP4.</p>}
      </> : <p className="results-video-message" role={video.videoError ? "alert" : "status"}>
        {video.videoError ?? "Gere o MP4 a partir do vídeo e das observações salvas desta execução."}
      </p>}
    </div>
  </section>;
}
