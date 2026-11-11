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

function estimatedFps(samples: PoseSample[]) {
  const frames = [...new Map(samples.map(sample => [sample.frameIndex, sample])).values()]
    .sort((a, b) => a.frameIndex - b.frameIndex);
  const rates = [];
  for (let index = 1; index < frames.length; index += 1) {
    const frameDelta = frames[index].frameIndex - frames[index - 1].frameIndex;
    const timeDelta = frames[index].timestampSec - frames[index - 1].timestampSec;
    if (frameDelta > 0 && timeDelta > 0) rates.push(frameDelta / timeDelta);
  }
  return rates.length ? rates.sort((a, b) => a - b)[Math.floor(rates.length / 2)] : 30;
}

function drawPose(context: CanvasRenderingContext2D, samples: PoseSample[]) {
  const points = new Map(samples
    .filter(sample => sample.xPx != null && sample.yPx != null && sample.status !== "missing")
    .map(sample => [sample.keypoint, sample] as const));
  const bbox = samples.find(sample => sample.bbox)?.bbox;
  if (bbox) {
    context.strokeStyle = "#9fb8a3";
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
    context.fillStyle = weak ? "#f3bd62" : "#9fb8a3";
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
  const fps = estimatedFps(samples);
  const sourceFrames = [...byFrame.keys()].sort((a, b) => a - b);
  const draw = () => {
    context.drawImage(video, 0, 0);
    drawPolygon(context, arena.cornersPx, "#80aa8b");
    if (arena.rimCornersPx) drawPolygon(context, arena.rimCornersPx, "#f5b942");
    arena.occlusionPolygonsPx?.forEach(points => drawPolygon(context, points, "#c98f83"));
    const targetFrame = Math.max(0, Math.round(video.currentTime * fps));
    const frameIndex = sourceFrames.reduce((best, frame) =>
      Math.abs(frame - targetFrame) < Math.abs(best - targetFrame) ? frame : best,
      sourceFrames[0] ?? 0);
    drawPose(context, byFrame.get(frameIndex) ?? []);
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
