import type { BodyAxisObservation, Point, PoseSample } from "../types";

const point = (p: unknown): p is Point => !!p && typeof p === "object" &&
  "x" in p && "y" in p && typeof p.x === "number" && typeof p.y === "number" &&
  Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0;
const nullablePoint = (p: unknown) => p === null || point(p);

/** Discreet marker pointing from the tail towards the image-supported head. */
export function headTriangle(head: Point, tail: Point, radius: number): Point[] {
  const length = Math.hypot(head.x-tail.x,head.y-tail.y);
  if (!Number.isFinite(length) || length < 1e-6) return [];
  const x=(head.x-tail.x)/length,y=(head.y-tail.y)/length;
  return [{x:head.x+x*radius,y:head.y+y*radius},
    {x:head.x-x*radius*.7-y*radius*.7,y:head.y-y*radius*.7+x*radius*.7},
    {x:head.x-x*radius*.7+y*radius*.7,y:head.y-y*radius*.7-x*radius*.7}];
}

/** Validate imported estimates without granting them metric eligibility. */
export function parseLayeredObservation(text: string, sample: PoseSample): Pick<PoseSample, "bodyAxis" | "oftLayers"> {
  const value = JSON.parse(text);
  const axis = value?.bodyAxis, layers = value?.oftLayers;
  const orientation = layers?.orientation, rearing = layers?.rearing;
  if (layers?.version !== "oft-layers-1" || !orientation ||
      !["estimated", "ambiguous", "missing"].includes(orientation.state) ||
      typeof orientation.reason !== "string" || !Number.isFinite(orientation.confidence) ||
      orientation.confidence < 0 || orientation.confidence > 1 ||
      ![null, "tail_silhouette", "temporal_estimate"].includes(orientation.source) ||
      orientation.headRegion !== undefined && !["floor", "wall_projection", "unknown"].includes(orientation.headRegion) ||
      ![orientation.head, orientation.tailBase, orientation.tailTip].every(nullablePoint) ||
      orientation.state === "estimated" && (!point(orientation.head) || !point(orientation.tailBase)) ||
      orientation.state !== "estimated" && [orientation.head, orientation.tailBase, orientation.tailTip].some(p => p !== null) ||
      !rearing || !["UNKNOWN", "REARING_UNSPECIFIED", "REARING_SUPPORTED", "REARING_UNSUPPORTED"].includes(rearing.classification) ||
      rearing.score != null && (!Number.isFinite(rearing.score) || rearing.score < 0 || rearing.score > 1) ||
      axis?.schemaVersion !== "body-axis-2" || axis.frameIndex !== sample.frameIndex ||
      !Number.isFinite(axis.timestampSec) || Math.abs(axis.timestampSec - sample.timestampSec) > 1e-5 ||
      !["reliable", "ambiguous", "outlier", "missing"].includes(axis.state) ||
      !Array.isArray(axis.points) || ![0, 7].includes(axis.points.length) || !axis.points.every(point) ||
      (axis.state === "reliable") !== (axis.points.length === 7) ||
      typeof axis.reason !== "string" || typeof axis.filtered !== "boolean" ||
      [axis.angleRad, axis.rawAngleRad, axis.anisotropy].some(n => n !== null && !Number.isFinite(n))) {
    throw new Error("Camadas de Campo Aberto inválidas ou fora do quadro de origem.");
  }
  return {
    bodyAxis: { ...axis, anatomicalPose: false } as BodyAxisObservation,
    oftLayers: { version: "oft-layers-1", orientation: { ...orientation, metricEligible: false },
      rearing: { classification: rearing.classification, score: rearing.score ?? null,
        scoreKind: "model_score", reviewStatus: "pending", metricEligible: false } },
  };
}
