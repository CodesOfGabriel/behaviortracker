export type OftPosture = "NON_REARING" | "REARING_SUPPORTED" | "REARING_UNSUPPORTED" | "REARING_UNSPECIFIED" | "UNKNOWN";
export const postureLabels: Record<OftPosture, string> = {
  NON_REARING: "Não rearing", REARING_SUPPORTED: "Rearing com apoio", REARING_UNSUPPORTED: "Rearing sem apoio",
  REARING_UNSPECIFIED: "Rearing · apoio indeterminado", UNKNOWN: "Incerto / não observável",
};
export type BehaviorAnnotation = {
  schemaVersion: 1; id: string; type: "INTERVAL" | "PEAK" | "LABEL_PEAK" | "UNDO"; source: "human";
  experimentId: string; trackingJobId: string; videoSha256: string; createdAt: string;
  startSec?: number; endSec?: number; label?: OftPosture; annotatorId?: string; targetId?: string; note?: string;
  timestampSec?: number; frameIndex?: number;
};
export type BehaviorEvent = {
  eventId: string; startSec: number; endSec: number; durationSec: number; behavior: OftPosture;
  score: number; reviewStatus: "pending" | "confirmed" | "rejected" | "corrected";
  observedIntervals: [number, number][]; censored: boolean;
};
export type BehaviorReview = {
  id: string; type: "CONFIRM" | "REJECT" | "CORRECT"; eventId: string; reviewerId: string;
  startSec?: number; endSec?: number; label?: OftPosture; createdAt: string;
};
export type BehaviorPrediction = {
  frameIndex: number | null; timestampSec: number; endSec: number; observation: "OBSERVED" | "UNCERTAIN" | "UNOBSERVED";
  classification: OftPosture; pRearing: number | null; pSupportedGivenRearing: number | null;
  scoreKind: "probability" | "model_score";
};
export type BehaviorMetrics = {
  schemaVersion: 1; modelId: string; modelVersion: string; validationStatus: "experimental";
  metricSource: "automatic"; analysisDurationSec: number; classifiableDurationSec: number; unknownDurationSec: number; coveragePct: number | null;
  rearing: {
    totalCount: number | null; supportedCount: number | null; unsupportedCount: number | null; unspecifiedCount: number | null;
    totalDurationSec: number | null; meanDurationSec: number | null; maxDurationSec: number | null;
    perClassifiableMinute: number | null; percentClassifiableTime: number | null; latencySec: number | null;
    firstObservedRearingSec: number | null; latencyExact: boolean; interEpisodeIntervalsSec: (number | null)[]; interObservedEpisodeGapsSec: number[];
  };
  perMinute: { startSec: number; endSec: number; classifiableDurationSec: number; count: number }[];
};
export type BehaviorResult = {
  manifest: { experimentId: string; trackingJobId: string; videoSha256: string; model: {modelId: string; modelVersion: string; probabilityCalibrated: boolean}; scientificallyValidated: false };
  metrics: BehaviorMetrics; events: BehaviorEvent[]; predictions: BehaviorPrediction[]; quality: Record<string, unknown>;
};
export type BehaviorJobState = "queued" | "preparing" | "extracting" | "classifying" | "decoding" | "succeeded" | "cancelled" | "failed";
export type BehaviorJob = {jobId: string; state: BehaviorJobState; error: string | null; createdAt: string; modelVersion: string; videoSha256: string; report: {framesProcessed?: number; elapsedSec?: number}};
export type BehaviorModelStatus = {environmentReady: boolean; installed: boolean; remoteAvailable: boolean; message: string | null;
  manifest: {modelVersion: string; sampleRateHz: number; architecture: string; availability: string}};
