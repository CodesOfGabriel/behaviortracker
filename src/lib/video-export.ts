import type { ArenaConfig, Point, PoseSample } from "../types";

function drawPolygon(context: CanvasRenderingContext2D, points: Point[], color: string) {
  if (!points.length) return;
  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.closePath();
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.stroke();
}

export async function exportAnnotatedVideo(
  video: HTMLVideoElement,
  samples: PoseSample[],
  arena: ArenaConfig,
  filename = "behavetracker-revisado.webm",
) {
  if (!window.MediaRecorder) throw new Error("Este navegador não suporta exportação de vídeo.");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Não foi possível preparar o canvas de exportação.");
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = event => event.data.size && chunks.push(event.data);
  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error("A gravação do vídeo falhou."));
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
  });
  const source = [...samples].sort((a, b) => a.timestampSec - b.timestampSec);
  const draw = () => {
    context.drawImage(video, 0, 0);
    drawPolygon(context, arena.cornersPx, "#23c483");
    if (arena.rimCornersPx) drawPolygon(context, arena.rimCornersPx, "#f5b942");
    arena.occlusionPolygonsPx?.forEach(points => drawPolygon(context, points, "#ef5da8"));
    const frame = source.reduce<PoseSample | undefined>((best, sample) =>
      !best || Math.abs(sample.timestampSec - video.currentTime) < Math.abs(best.timestampSec - video.currentTime) ? sample : best, undefined);
    if (frame?.xPx != null && frame.yPx != null && frame.status !== "missing") {
      context.fillStyle = "#5ba7ff";
      context.beginPath();
      context.arc(frame.xPx, frame.yPx, 6, 0, Math.PI * 2);
      context.fill();
    }
    if (!video.paused && !video.ended) requestAnimationFrame(draw);
  };
  video.currentTime = 0;
  await new Promise<void>(resolve => video.addEventListener("seeked", () => resolve(), { once: true }));
  recorder.start(250);
  draw();
  await video.play();
  await new Promise<void>(resolve => video.addEventListener("ended", () => resolve(), { once: true }));
  recorder.stop();
  const blob = await finished;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
