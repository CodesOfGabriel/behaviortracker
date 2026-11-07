export type Point = { x: number; y: number };
export type Quadrilateral = [Point, Point, Point, Point];

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
  | { name: "editor"; experimentId: string }
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
}

export interface CorrectionEvent {
  id: string;
  type: "MOVE_POINT" | "MARK_MISSING" | "CONFIRM_POINT" | "ANNOTATE_BEHAVIOR" | "REJECT_CANDIDATE" | "REVERT_EVENT";
  createdAt: string;
  frameIndex?: number;
  timestampSec?: number;
  keypoint?: string;
  before?: Point | null;
  after?: Point | null;
  targetEventId?: string;
  startSec?: number;
  endSec?: number;
  label?: "rearing" | "grooming" | "freezing" | "other";
  candidateId?: string;
  source: "manual";
}

export interface Experiment {
  id: string;
  schemaVersion: "1.0";
  analysisMethodVersion: "oft-0.1" | "oft-0.2";
  title: string;
  subjectId: string;
  group?: string;
  notes?: string;
  testType: "open_field";
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
  video: VideoMetadata;
  arena: ArenaConfig;
  referencePoint: string;
  corrections: CorrectionEvent[];
  behaviorReviewed?: Partial<Record<BehaviorLabel, boolean>>;
}

export interface VideoAsset {
  objectUrl?: string;
  frameDataUrl?: string;
  frameTimeSec?: number;
  file?: File;
}

export type PoseStatus = "valid" | "low_confidence" | "jump" | "missing" | "out_of_arena";
export type BehaviorLabel = "rearing" | "grooming" | "freezing";
export type PoseSource = "detected" | "recovered" | "predicted" | "manual";

export interface PoseSample {
  frameIndex: number;
  timestampSec: number;
  keypoint: string;
  xPx: number | null;
  yPx: number | null;
  likelihood: number;
  status: PoseStatus;
  spatialRegion?: "floor" | "wall_projection" | "outside" | "unknown";
  supportCount?: number;
  supportTotal?: number;
  source?: PoseSource;
  recoveryState?: "ready" | "unavailable" | "limited" | "not_needed";
  original?: Pick<PoseSample, "xPx" | "yPx" | "likelihood" | "status" | "spatialRegion" | "supportCount" | "supportTotal">;
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

