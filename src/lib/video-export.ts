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

const skeletonEdges: Array<[string, string]> = [
  ["nose", "head_midpoint"], ["head_midpoint", "left_ear"], ["head_midpoint", "right_ear"],
  ["head_midpoint", "neck"], ["neck", "mid_back"], ["mid_back", "mid_backend"],
  ["mid_backend", "tail_base"], ["tail_base", "tail_end"],
  ["neck", "left_forepaw"], ["neck", "right_forepaw"],
  ["mid_backend", "left_hindpaw"], ["mid_backend", "right_hindpaw"],
];

function frameSamples(samples: PoseSample[]) {
  const grouped = new Map<number, PoseSample[]>();
  for (const sample of samples) {
    const group = grouped.get(sample.frameIndex) ?? [];
    group.push(sample);
    grouped.set(sample.frameIndex, group);
  }
  return grouped;
}

function drawPose(context: CanvasRenderingContext2D, samples: PoseSample[]) {
  const points = new Map(samples
    .filter(sample => sample.xPx != null && sample.yPx != null && sample.status !== "missing")
    .map(sample => [sample.keypoint, sample] as const));
  const bbox = samples.find(sample => sample.bbox)?.bbox;
  if (bbox) {
    context.strokeStyle = "#5ba7ff";
    context.lineWidth = 2;
    context.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
  }
  context.lineCap = "round";
  for (const [from, to] of skeletonEdges) {
    const start = points.get(from);
    const end = points.get(to);
    if (!start || !end || start.likelihood != null && start.likelihood < .6 || end.likelihood != null && end.likelihood < .6) continue;
    context.strokeStyle = "#76d6b1";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(start.xPx!, start.yPx!);
    context.lineTo(end.xPx!, end.yPx!);
    context.stroke();
  }
  for (const sample of points.values()) {
    const weak = sample.likelihood != null && sample.likelihood < .6;
    context.fillStyle = weak ? "#f3bd62" : "#65a9ff";
    context.beginPath();
    context.arc(sample.xPx!, sample.yPx!, weak ? 3 : 4, 0, Math.PI * 2);
    context.fill();
  }
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
  const byFrame = frameSamples(samples);
  const source = [...samples].sort((a, b) => a.timestampSec - b.timestampSec);
  const draw = () => {
    context.drawImage(video, 0, 0);
    drawPolygon(context, arena.cornersPx, "#23c483");
    if (arena.rimCornersPx) drawPolygon(context, arena.rimCornersPx, "#f5b942");
    arena.occlusionPolygonsPx?.forEach(points => drawPolygon(context, points, "#ef5da8"));
    const frame = source.reduce<PoseSample | undefined>((best, sample) =>
      !best || Math.abs(sample.timestampSec - video.currentTime) < Math.abs(best.timestampSec - video.currentTime) ? sample : best, undefined);
    if (frame) drawPose(context, byFrame.get(frame.frameIndex) ?? []);
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
