export type Point = { x: number; y: number };
export type BoundingBox = { x: number; y: number; width: number; height: number };
export type TrackingSelection = { engine: "opencv" | "colab"; jobId: string };
export type Quadrilateral = [Point, Point, Point, Point];
export type AnalysisEngineId = "superanimal_video_adapt_b_legacy" | "wistar_superanimal_hybrid_v1" | "fst_superanimal_quadruped_v1" | "wistar_ram_hybrid_v1";

export type ExperimentStatus =
  | "draft"
  | "processing"
  | "review"
  | "completed"
  | "blocked"
  | "failed";

export type AppRoute =
  | { name: "dashboard" }
  | { name: "new-experiment"; resumePreparation?: boolean }
  | { name: "edit-ram"; experimentId: string }
  | { name: "validation"; experimentId: string }
  | { name: "results"; experimentId: string }
  | { name: "colab" }
  | { name: "about" };

export interface VideoMetadata {
  filename: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationSec: number;
  fps: number | null;
  timingSource: "browser-estimate" | "ffprobe" | "synthetic";
  calibrationFrameSec?: number;
  lastModified?: number;
  sha256?: string;
  preparation?: VideoPreparation;
}

export interface VideoPreparation {
  uploadId: string;
  originalBytes: number;
  uploadBytes: number;
  status: "optimized" | "original" | "unavailable";
  message: string;
  policyVersion: "lossless-upload-1" | "quality-upload-2" | "quality-upload-3" | "quality-upload-4" | "fst-adaptive-1" | "fst-adaptive-2";
  pixelVerified: boolean;
  frameCount: number | null;
  uploadWidth?: number | null;
  uploadHeight?: number | null;
  encoder?: string | null;
  method?: "passthrough" | "streamcopy" | "transcode" | null;
  preparationMs?: number | null;
  cacheHit?: boolean;
}

export interface ArenaConfig {
  revision: number;
  cornersPx: Quadrilateral;
  rimCornersPx?: Quadrilateral;
  widthCm: number;
  heightCm: number;
  centerAreaFraction: number;
  boundaryPolicy: "center_inclusive";
  occlusionPolygonsPx?: Point[][];
  calibrationVersion?: string;
  referenceFrameSec?: number;
}

export interface CorrectionEvent {
  id: string;
  type: "MOVE_POINT" | "SET_BOX" | "MARK_MISSING" | "CONFIRM_POINT" | "ANNOTATE_BEHAVIOR" | "REJECT_CANDIDATE" | "REVERT_EVENT";
  createdAt: string;
  frameIndex?: number;
  timestampSec?: number;
  keypoint?: string;
  before?: Point | null;
  after?: Point | null;
  beforeBox?: BoundingBox | null;
  afterBox?: BoundingBox;
  reviewSource?: string;
  targetEventId?: string;
  startSec?: number;
  endSec?: number;
  label?: "rearing" | "grooming" | "freezing" | "other";
  candidateId?: string;
  runId?: string;
  algorithmVersion?: string;
  sourceVideoSha256?: string;
  clockMapVersion?: string;
  source: "manual";
}

export interface OpenFieldExperiment {
  id: string;
  schemaVersion: "1.0";
  analysisMethodVersion: "oft-0.1" | "oft-0.2";
  analysisEngine?: "superanimal_video_adapt_b_legacy" | "wistar_superanimal_hybrid_v1";
  modelBundleId?: string;
  title: string;
  subjectId: string;
  group?: string;
  notes?: string;
  testType: "open_field";
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
  video: VideoMetadata;
  calibrationThumbnailDataUrl?: string;
  arena: ArenaConfig;
  referencePoint: string;
  corrections: CorrectionEvent[];
  behaviorReviewed?: Partial<Record<BehaviorLabel, boolean>>;
  trackingSelection?: TrackingSelection;
  behaviorSelections?: Record<string, {jobId: string; videoSha256: string}>;
  trackingReviews?: Record<string, { referencePoint: string }>;
  legacyReviewSource?: string;
}

export type TankPresence = "IN_TANK" | "NOT_IN_TANK" | "UNCERTAIN";
export type FstBehavior = "IMMOBILITY" | "SWIMMING" | "CLIMBING" | "MIXED" | "UNCERTAIN";
export interface ForcedSwimSubject { animalId: string; subjectId: string; }
export interface TankConfig { tankId: string; animalId: string; subjectId: string; roiPx: BoundingBox; revision: number; }
export interface FstAnnotation {
  id: string; animalId: string; startSec: number; endSec: number;
  label: FstBehavior; source: "manual"; analysisVersion: "fst-0.1";
  createdAt: string; runId?: string;
}
export interface ForcedSwimExperiment {
  id: string; schemaVersion: "1.0"; analysisMethodVersion: "fst-0.1";
  analysisEngine: "fst_superanimal_quadruped_v1";
  title: string; subjectId: string; group?: string; notes?: string;
  testType: "forced_swim"; status: ExperimentStatus; createdAt: string; updatedAt: string;
  video: VideoMetadata; calibrationThumbnailDataUrl?: string;
  subjects: ForcedSwimSubject[]; tanks: TankConfig[];
  annotations: FstAnnotation[]; trackingSelection?: TrackingSelection;
}
export type ArmId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface RadialArm {
  id: ArmId;
  polygonPx: Point[];
  entryGatePx: [Point, Point];
  distalGatePx: [Point, Point];
  cupPolygonPx: Point[];
  baited: boolean;
}
export interface RadialMazeGeometry {
  eventGeometryConfirmed?: boolean;
  revision: number;
  walkablePolygonPx?: Point[];
  centerPolygonPx: Point[];
  arms: RadialArm[];
  walkableMaskVersion: string;
  referenceFrameSec: number;
}
export interface RamVisitPolicy {
  minimumArmDwellSec: number;
  minimumCenterDwellSec: number;
  minimumDistalDwellSec: number;
  unknownGapToleranceSec: number;
  choiceCriterion: "arm_entry" | "distal_reached";
}
export interface RadialMazeExperiment {
  id: string; schemaVersion: "1.0"; analysisMethodVersion: "ram-1.0";
  analysisEngine: "wistar_ram_hybrid_v1"; modelBundleId: string;
  title: string; subjectId: string; group?: string; notes?: string;
  testType: "radial_arm_maze"; status: ExperimentStatus; createdAt: string; updatedAt: string;
  video: VideoMetadata; calibrationThumbnailDataUrl?: string;
  geometry: RadialMazeGeometry; visitPolicy: RamVisitPolicy;
  geometryHistory?: RadialMazeGeometry[];
  corrections: CorrectionEvent[]; trackingSelection?: TrackingSelection;
  spatialCalibration?: { pixelsPerCm: number; method: "planar_uniform" };
}
export type Experiment = OpenFieldExperiment | ForcedSwimExperiment | RadialMazeExperiment;

export interface VideoAsset {
  objectUrl?: string;
  frameDataUrl?: string;
  thumbnailDataUrl?: string;
  frameTimeSec?: number;
  file?: File;
}

export type PoseStatus = "valid" | "low_confidence" | "jump" | "missing" | "out_of_arena";
export type BehaviorLabel = "rearing" | "grooming" | "freezing";
export type PoseSource = "detected" | "recovered" | "predicted" | "manual" | "segmented";

export interface SilhouetteMotionFeatures {
  schemaVersion: "silhouette-features-1";
  areaPx: number;
  aspectRatio: number;
  extent: number;
  axisRad: number;
  deltaSec: number | null;
  speedPxSec: number | null;
  changedPixelFraction: number | null;
  meanAbsDifference: number | null;
  observationUsable?: boolean;
}

export type BodyAxisObservation={schemaVersion:"body-axis-2";frameIndex:number;timestampSec:number;
  points:Point[];state:"reliable"|"ambiguous"|"outlier"|"missing";reason:string;
  rawAngleRad:number|null;angleRad:number|null;anisotropy:number|null;filtered:boolean;anatomicalPose:false};

export interface PoseSample {
  oftLayers?: {
    version: "oft-layers-1";
    orientation: {state:"estimated"|"ambiguous"|"missing";reason:string;head:Point|null;tailBase:Point|null;tailTip:Point|null;headRegion?:"floor"|"wall_projection"|"unknown";
      confidence:number;source:"tail_silhouette"|"temporal_estimate"|null;metricEligible:false};
    rearing:{classification:string;reviewStatus:"pending";metricEligible:false;score?:number|null;scoreKind?:"model_score"};
  };
  bodyAxis?: BodyAxisObservation;
  bodyAxisContour?: Point[];
  bodyAxisEvidence?: {method:"frozen_body_color_v1";supported:boolean;supportFraction:number};
  frameIndex: number;
  normalizedFrameIndex?: number;
  sourceFrameIndex?: number;
  timestampSec: number;
  sourceTimestampSec?: number;
  keypoint: string;
  xPx: number | null;
  yPx: number | null;
  likelihood: number;
  status: PoseStatus;
  spatialRegion?: "floor" | "wall_projection" | "outside" | "unknown";
  supportCount?: number;
  supportTotal?: number;
  source?: PoseSource;
  metricReference?: "silhouette_centroid" | "box_center";
  referenceApproved?: boolean;
  trackingAccepted?: boolean;
  kalmanUpdated?: boolean;
  localQuality?: {
    tracking: "observed" | "uncertain" | "missing";
    geometry: "floor" | "boundary" | "wall_projection" | "unknown";
    identity?: "unverified" | "consistent" | "seeded";
    reasons: string[];
  };
  features?: SilhouetteMotionFeatures | null;
  behaviorObservation?: "OBSERVED" | "UNCERTAIN" | "UNOBSERVED";
  bbox?: BoundingBox;
  contour?: Point[];
  reason?: string;
  processingVersion?: string;
  runId?: string;
  clockMapVersion?: string;
  uncertaintyPx?: number | null;
  observationState?: "observed" | "uncertain" | "missing";
  bodyBbox?: BoundingBox | null;
  fullAnimalBbox?: BoundingBox | null;
  bodyCenter?: Point;
  centerDefinition?: string;
  algorithmVersion?: string;
  maskArtifact?: string;
  recoveryState?: "ready" | "unavailable" | "limited" | "not_needed";
  original?: Pick<PoseSample, "xPx" | "yPx" | "likelihood" | "status" | "spatialRegion" | "supportCount" | "supportTotal" | "source" | "bbox" | "contour" | "metricReference" | "referenceApproved">;
}

export interface FrameClockMap {
  version: string;
  normalizedFrameIndex: number;
  sourceFrameIndex: number | null;
  normalizedTimestampSec: number;
  sourceTimestampSec: number | null;
}

export interface DetectionSample {
  frameIndex: number;
  timestampSec: number;
  observed: boolean;
  score: number | null;
  bboxRaw?: BoundingBox | null;
  bboxPose?: BoundingBox | null;
  qualityFlags: string[];
  runId?: string;
}

export interface OftMetrics {
  revision: "raw" | "reviewed";
  analysisDurationSec: number;
  validDurationSec: number;
  coveragePct: number;
  distanceCm: number | null;
  meanSpeedCmS: number | null;
  centerTimeSec: number;
  peripheralTimeSec: number;
  unknownTimeSec: number;
  centerPctClassifiable: number | null;
  centerEntries: number;
  centerLatencySec: number | null;
  immobilityTimeSec: number;
}
