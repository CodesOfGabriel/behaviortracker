import type { ArenaConfig, BoundingBox, Point, PoseSample, TankConfig, VideoMetadata, VideoPreparation } from "../../types";

export function preparedGeometry(video: Pick<VideoMetadata, "width" | "height">, preparation: VideoPreparation) {
  const width = preparation.uploadWidth ?? video.width;
  const height = preparation.uploadHeight ?? video.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > video.width || height > video.height) {
    throw new Error("Resolução do vídeo preparado inválida.");
  }
  return { width, height, scaleX: width / video.width, scaleY: height / video.height };
}

function scalePoint(point: Point, x: number, y: number): Point {
  return { x: point.x * x, y: point.y * y };
}

function scaleBox(box: BoundingBox, x: number, y: number): BoundingBox {
  return { x: box.x * x, y: box.y * y, width: box.width * x, height: box.height * y };
}

export function scaleArenaToUpload(arena: ArenaConfig, video: Pick<VideoMetadata, "width" | "height">, preparation: VideoPreparation): ArenaConfig {
  const { scaleX, scaleY } = preparedGeometry(video, preparation);
  return { ...arena, cornersPx: arena.cornersPx.map(point => scalePoint(point, scaleX, scaleY)) as ArenaConfig["cornersPx"],
    rimCornersPx: arena.rimCornersPx?.map(point => scalePoint(point, scaleX, scaleY)) as ArenaConfig["rimCornersPx"],
    occlusionPolygonsPx: arena.occlusionPolygonsPx?.map(polygon => polygon.map(point => scalePoint(point, scaleX, scaleY))) };
}

export function scaleTanksToUpload(tanks: TankConfig[], video: Pick<VideoMetadata, "width" | "height">, preparation: VideoPreparation): TankConfig[] {
  const { scaleX, scaleY } = preparedGeometry(video, preparation);
  return tanks.map(tank => {
    const source = tank.roiPx;
    const x = Math.round(source.x * scaleX), y = Math.round(source.y * scaleY);
    return { ...tank, roiPx: { x, y,
      width: Math.round((source.x + source.width) * scaleX) - x,
      height: Math.round((source.y + source.height) * scaleY) - y } };
  });
}

export function scalePoseToOriginal(samples: PoseSample[], video: Pick<VideoMetadata, "width" | "height">, preparation: VideoPreparation): PoseSample[] {
  const { scaleX, scaleY } = preparedGeometry(video, preparation);
  if (scaleX === 1 && scaleY === 1) return samples;
  const x = 1 / scaleX, y = 1 / scaleY;
  return samples.map(sample => ({ ...sample,
    xPx: sample.xPx === null ? null : sample.xPx * x,
    yPx: sample.yPx === null ? null : sample.yPx * y,
    bbox: sample.bbox ? scaleBox(sample.bbox, x, y) : undefined,
    contour: sample.contour?.map(point => scalePoint(point, x, y)),
    uncertaintyPx: sample.uncertaintyPx === undefined ? undefined : sample.uncertaintyPx * Math.max(x, y),
    original: sample.original ? { ...sample.original,
      xPx: sample.original.xPx === null ? null : sample.original.xPx * x,
      yPx: sample.original.yPx === null ? null : sample.original.yPx * y,
      bbox: sample.original.bbox ? scaleBox(sample.original.bbox, x, y) : undefined,
      contour: sample.original.contour?.map(point => scalePoint(point, x, y)) } : undefined,
  }));
}
