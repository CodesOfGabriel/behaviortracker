import type { ArenaConfig, Point, PoseSample } from "../types";
import { LAYERED_SKELETON_EDGES, visiblePose } from "./pose";
import { headTriangle } from "./oft-layers";

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
  ...LAYERED_SKELETON_EDGES,
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

export function drawPose(context: CanvasRenderingContext2D, samples: PoseSample[]) {
  const layered=samples.find(sample=>sample.oftLayers);
  const points = new Map(samples
    .filter(visiblePose)
    .map(sample => [sample.keypoint, sample] as const));
  const stopped=samples.some(sample=>["researcher_intervention","researcher_intervention_pending"].includes(sample.reason??""));
  if(stopped) return;
  const visual=layered?.oftLayers?.visualization;
  const bbox = visual?visual.box:samples.find(sample => sample.bbox)?.bbox;
  if (bbox) {
    context.strokeStyle = "#9fb8a3";
    context.lineWidth = 2;
    context.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
  }
  context.lineCap = "round";
  for (const [from, to] of (layered?[]:skeletonEdges)) {
    const start = points.get(from);
    const end = points.get(to);
    if (!start || !end) continue;
    context.strokeStyle = "#76d6b1";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(start.xPx!, start.yPx!);
    context.lineTo(end.xPx!, end.yPx!);
    context.stroke();
  }
  for (const sample of (layered?[]:points.values())) {
    const estimated = sample.source === "recovered" || sample.source === "predicted";
    const weak = sample.likelihood != null && sample.likelihood < .6;
    context.fillStyle = weak || estimated ? "#f3bd62" : "#9fb8a3";
    context.strokeStyle = context.fillStyle;
    context.beginPath();
    context.arc(sample.xPx!, sample.yPx!, weak ? 3 : 4, 0, Math.PI * 2);
    if (estimated) context.stroke(); else context.fill();
  }
  if(layered){
    const path=visual?.points??layered.bodyAxis?.points??[];
    const inferred=visual&&visual.source!=="observed_geometry";
    context.strokeStyle=inferred?"#ffca70":"#6be7ff";context.lineWidth=2;
    if(path.length){context.beginPath();path.forEach((p,i)=>i?context.lineTo(p.x,p.y):context.moveTo(p.x,p.y));context.stroke();}
    context.fillStyle=inferred?"#ffca70":"#6be7ff";
    for(const p of path){context.beginPath();context.arc(p.x,p.y,2,0,Math.PI*2);context.fill();}
    const orientation=visual?{state:"estimated",head:visual.head,tailBase:visual.tailBase}:layered.oftLayers!.orientation;
    context.strokeStyle="#ffca70";context.fillStyle="#ffca70";context.font="12px sans-serif";
    if(orientation.state==="estimated"&&orientation.head&&orientation.tailBase){
      const triangle=headTriangle(orientation.head,orientation.tailBase,5);
      if(triangle.length){context.beginPath();context.moveTo(triangle[0].x,triangle[0].y);for(const p of [...triangle.slice(1),triangle[0]])context.lineTo(p.x,p.y);context.stroke();}
      context.beginPath();context.arc(orientation.tailBase.x,orientation.tailBase.y,3,0,Math.PI*2);context.stroke();
    }
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
