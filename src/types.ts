export type Point = { x: number; y: number };
export type BoundingBox = { x: number; y: number; width: number; height: number };
export type TrackingSelection = { engine: "opencv" | "colab"; jobId: string };
export type Quadrilateral = [Point, Point, Point, Point];
export type AnalysisEngineId = "superanimal_video_adapt_b_legacy" | "wistar_superanimal_hybrid_v1";

export type ExperimentStatus =
  | "draft"
  | "processing"
  | "review"
  | "completed"
  | "blocked"
  | "failed";

export type AppRoute =
  | { name: "dashboard" }
  | { name: "new-experiment" }
  | { name: "results"; experimentId: string }
  | { name: "colab" };

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
  policyVersion: "lossless-upload-1";
  pixelVerified: boolean;
  frameCount: number | null;
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

export interface Experiment {
  id: string;
  schemaVersion: "1.0";
  analysisMethodVersion: "oft-0.1" | "oft-0.2";
  analysisEngine?: AnalysisEngineId;
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
  trackingReviews?: Record<string, { referencePoint: string }>;
  legacyReviewSource?: string;
}

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

export interface PoseSample {
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
  bbox?: BoundingBox;
  contour?: Point[];
  reason?: string;
  processingVersion?: string;
  runId?: string;
  clockMapVersion?: string;
  uncertaintyPx?: number;
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
