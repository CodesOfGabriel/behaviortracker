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
  const visual=layers?.visualization;
  if(visual!==undefined && (visual?.version!=="image_flow_and_mask_v1" ||
    !["estimated","unavailable","suspended","stopped"].includes(visual.state) ||
    ![null,"observed_geometry","current_silhouette","optical_flow","held_estimate"].includes(visual.source) ||
    !["current_tail","flow_direction","previous_direction","future_direction","bidirectional_recovery","unknown"].includes(visual.orientationSource) ||
    visual.orientationSource==="future_direction" && (!Number.isInteger(visual.directionAnchorFrameIndex)||visual.directionAnchorFrameIndex<=sample.frameIndex) ||
    !Array.isArray(visual.points) || !visual.points.every(point) ||
    (visual.state==="estimated"?visual.points.length!==7:visual.points.length!==0) ||
    ![visual.head,visual.tailBase].every(nullablePoint) || (visual.head===null)!==(visual.tailBase===null) ||
    visual.ageSec!==null && (!Number.isFinite(visual.ageSec)||visual.ageSec<0) ||
    !Number.isFinite(visual.supportScore)||visual.supportScore<0||visual.supportScore>1 ||
    visual.box!==null && (!point(visual.box)||![visual.box.width,visual.box.height].every(n=>Number.isFinite(n)&&n>0)))) {
    throw new Error("Estimativas visuais de Campo Aberto inválidas.");
  }
  const temporal=visual?.temporal;
  if(visual?.orientationSource==="bidirectional_recovery" && !temporal) {
    throw new Error("Recuperação bidirecional sem registro temporal.");
  }
  if(temporal!==undefined && (!["offline_pose_v1","offline_pose_v2"].includes(temporal?.version) ||
    !["estimated","unknown"].includes(temporal.orientationState) ||
    !Number.isFinite(temporal.margin)||temporal.margin<0 ||
    temporal.uncertaintyPx!==null && (!Number.isFinite(temporal.uncertaintyPx)||temporal.uncertaintyPx<0) ||
    temporal.anchorFrameIndex!==undefined && (!Number.isInteger(temporal.anchorFrameIndex)||temporal.anchorFrameIndex<0) ||
    temporal.orientationState==="estimated" && (!visual?.head || temporal.anchorFrameIndex===undefined || visual.orientationSource!=="bidirectional_recovery") ||
    temporal.orientationState==="unknown" && visual?.head!==null)) {
    throw new Error("Refinamento temporal de Campo Aberto inválido.");
  }
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
      rearing.scoreKind !== undefined && !["model_score", "heuristic_score"].includes(rearing.scoreKind) ||
      rearing.verification !== undefined && !["consistent", "limited", "insufficient"].includes(rearing.verification) ||
      rearing.reasons !== undefined && (!Array.isArray(rearing.reasons) || !rearing.reasons.every((reason:unknown) => typeof reason === "string")) ||
      rearing.modelScore !== undefined && (!Number.isFinite(rearing.modelScore) || rearing.modelScore < 0 || rearing.modelScore > 1) ||
      rearing.evidence !== undefined && (!rearing.evidence ||
        rearing.evidence.axisLengthRatio !== null && (!Number.isFinite(rearing.evidence.axisLengthRatio) || rearing.evidence.axisLengthRatio < 0) ||
        ["silhouetteLengthRatio", "silhouetteAreaRatio", "aspectRatio", "speedBodyLengthsSec"].some(key => !Number.isFinite(rearing.evidence[key]) || rearing.evidence[key] < 0) ||
        typeof rearing.evidence.headOnWall !== "boolean" ||
        rearing.evidence.floorOverlap !== null && (!Number.isFinite(rearing.evidence.floorOverlap) || rearing.evidence.floorOverlap < 0 || rearing.evidence.floorOverlap > 1)) ||
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
      ...(visual?{visualization:{...visual,metricEligible:false,...(temporal?{temporal:{...temporal,metricEligible:false}}:{})}}:{}),
      rearing: { classification: rearing.classification, score: rearing.score ?? null,
        scoreKind: rearing.scoreKind ?? "model_score", verification:rearing.verification, reasons:rearing.reasons,
        modelScore:rearing.modelScore, ...(rearing.evidence?{evidence:{axisLengthRatio:rearing.evidence.axisLengthRatio,
          silhouetteLengthRatio:rearing.evidence.silhouetteLengthRatio,silhouetteAreaRatio:rearing.evidence.silhouetteAreaRatio,
          aspectRatio:rearing.evidence.aspectRatio,speedBodyLengthsSec:rearing.evidence.speedBodyLengthsSec,
          headOnWall:rearing.evidence.headOnWall,floorOverlap:rearing.evidence.floorOverlap}}:{}), reviewStatus: "pending", metricEligible: false } },
  };
}
