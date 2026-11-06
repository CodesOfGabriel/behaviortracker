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
  type: "MOVE_POINT" | "MARK_MISSING" | "ANNOTATE_BEHAVIOR" | "REVERT_EVENT";
  createdAt: string;
  frameIndex?: number;
  keypoint?: string;
  before?: Point | null;
  after?: Point | null;
  targetEventId?: string;
  startSec?: number;
  endSec?: number;
  label?: "rearing" | "grooming" | "freezing" | "other";
  source: "manual";
}

export interface Experiment {
  id: string;
  schemaVersion: "1.0";
  analysisMethodVersion: "oft-0.1";
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
}

export interface VideoAsset {
  objectUrl?: string;
  frameDataUrl?: string;
  frameTimeSec?: number;
  file?: File;
}

export type PoseStatus = "valid" | "low_confidence" | "jump" | "missing" | "out_of_arena";

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

