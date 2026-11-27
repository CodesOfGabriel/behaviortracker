export type OftPosture = "NON_REARING" | "REARING_SUPPORTED" | "REARING_UNSUPPORTED" | "REARING_UNSPECIFIED" | "UNKNOWN";
export type RearingTag = Extract<OftPosture, `REARING_${string}`>;
export type ProposalReviewInput = {frameIndex:number;timestampSec:number;decision:"accept"|"reject";label?:RearingTag;annotatorId:string};
export type ProposalReviewState = {decision:"accept"|"reject";label?:RearingTag};
export const postureLabels: Record<OftPosture, string> = {
  NON_REARING: "Não rearing", REARING_SUPPORTED: "Rearing com apoio", REARING_UNSUPPORTED: "Rearing sem apoio",
  REARING_UNSPECIFIED: "Rearing · apoio indeterminado", UNKNOWN: "Incerto / não observável",
};
export const exampleLabels = { walking: "Caminhando / farejando", grooming: "Grooming", turning: "Giro", wall: "Junto à parede, sem rearing", reflection: "Reflexo / sombra", intervention: "Entrada do pesquisador", other: "Outro exemplo" } as const;
export type BehaviorExample = keyof typeof exampleLabels;
export const bodyLandmarks = { nose: "Nariz", left_ear: "Orelha esquerda", right_ear: "Orelha direita", body_center: "Centro do tronco", hip: "Centro do quadril", tail_base: "Base da cauda" } as const;
export type BodyLandmark = keyof typeof bodyLandmarks;
export type LandmarkPosition = { visibility: "visible"; x: number; y: number } | { visibility: "occluded" | "out_of_frame"; x: null; y: null };
export type HumanPose = Record<BodyLandmark, LandmarkPosition>;
export type BehaviorAnnotation = {
  schemaVersion: 1; id: string; type: "INTERVAL" | "PEAK" | "LABEL_PEAK" | "POSE_FRAME" | "UNDO" | "PROPOSAL_REVIEW"; source: "human";
  experimentId: string; trackingJobId: string; videoSha256: string; createdAt: string;
  startSec?: number; endSec?: number; label?: OftPosture; annotatorId?: string; targetId?: string; note?: string;
  timestampSec?: number; frameIndex?: number;
  peakId?: string; exampleKind?: BehaviorExample;
  decision?: "accept" | "reject";
  pose?: HumanPose; imageWidth?: number; imageHeight?: number;
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
