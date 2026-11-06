import type { ArenaConfig, Experiment, Point, PoseSample } from "../types";
import { calculateHomography, transformPoint } from "./geometry";

export const DEMO_VIDEO_WIDTH = 1280;
export const DEMO_VIDEO_HEIGHT = 720;

export const defaultArena: ArenaConfig = {
  revision: 1,
  rimCornersPx: [
    { x: 150, y: 40 }, { x: 1130, y: 48 },
    { x: 1200, y: 680 }, { x: 80, y: 670 },
  ],
  cornersPx: [
    { x: 216, y: 92 },
    { x: 1068, y: 102 },
    { x: 1134, y: 637 },
    { x: 148, y: 626 },
  ],
  widthCm: 60,
  heightCm: 60,
  centerAreaFraction: 0.25,
  boundaryPolicy: "center_inclusive",
};

export function makeDemoExperiment(id = crypto.randomUUID()): Experiment {
  const now = new Date().toISOString();
  return {
    id,
    schemaVersion: "1.0",
    analysisMethodVersion: "oft-0.2",
    title: "Campo aberto · demonstração",
    subjectId: "RAT_DEMO_01",
    group: "Controle",
    notes: "Conjunto sintético para explorar o fluxo de revisão. Não usar como resultado científico.",
    testType: "open_field",
    status: "review",
    createdAt: now,
    updatedAt: now,
    video: {
      filename: "arena_demo_sintetica.mp4",
      sizeBytes: 0,
      width: DEMO_VIDEO_WIDTH,
      height: DEMO_VIDEO_HEIGHT,
      durationSec: 120,
      fps: 30,
      timingSource: "synthetic",
    },
    arena: defaultArena,
    referencePoint: "body_center",
    corrections: [],
  };
}

function floorToPixel(arena: ArenaConfig, point: Point) {
  const matrix = calculateHomography(
    [
      { x: 0, y: 0 },
      { x: arena.widthCm, y: 0 },
      { x: arena.widthCm, y: arena.heightCm },
      { x: 0, y: arena.heightCm },
    ],
    arena.cornersPx,
  );
  return transformPoint(point, matrix);
}

export function makeDemoPose(experiment: Experiment): PoseSample[] {
  const duration = Math.min(Math.max(experiment.video.durationSec || 120, 20), 600);
  const frequency = 10;
  const samples: PoseSample[] = [];
  for (let frame = 0; frame <= Math.floor(duration * frequency); frame += 1) {
    const time = frame / frequency;
    const phase = time / duration;
    const radius = 0.36 + 0.13 * Math.sin(time * 0.19);
    const angle = phase * Math.PI * 10 + Math.sin(time * 0.11) * 0.8;
    const floorPoint = {
      x: experiment.arena.widthCm * (0.5 + radius * Math.cos(angle)),
      y: experiment.arena.heightCm * (0.5 + radius * Math.sin(angle) * 0.92),
    };
    let point = floorToPixel(experiment.arena, floorPoint);
    let status: PoseSample["status"] = "valid";
    let likelihood = 0.97 - 0.05 * Math.abs(Math.sin(time));
    if (phase > 0.36 && phase < 0.39) {
      point = { x: point.x + 150 * Math.sin(time * 6), y: point.y - 95 };
      status = "jump";
      likelihood = 0.24;
    } else if (phase > 0.69 && phase < 0.71) {
      status = "missing";
      likelihood = 0.13;
    } else if (phase > 0.78 && phase < 0.8) {
      status = "low_confidence";
      likelihood = 0.38;
    }
    const direction = angle + Math.PI / 2;
    const pointDefinitions = [
      ["body_center", 0, 0],
      ["nose", 26, 0],
      ["tail_base", -22, 0],
      ["left_ear", 12, -11],
      ["right_ear", 12, 11],
    ] as const;
    pointDefinitions.forEach(([keypoint, forward, side]) => {
      const x = point.x + Math.cos(direction) * forward + Math.cos(direction + Math.PI / 2) * side;
      const y = point.y + Math.sin(direction) * forward + Math.sin(direction + Math.PI / 2) * side;
      const pointStatus = keypoint === "body_center" ? status : status === "missing" ? "low_confidence" : status;
      samples.push({
        frameIndex: frame,
        timestampSec: time,
        keypoint,
        xPx: pointStatus === "missing" ? null : x,
        yPx: pointStatus === "missing" ? null : y,
        likelihood: Math.max(0.05, likelihood - (keypoint === "body_center" ? 0 : 0.04)),
        status: pointStatus,
      });
    });
  }
  return samples;
}

