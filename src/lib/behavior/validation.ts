import type { BehaviorAnnotation, ProposalReviewState, RearingTag } from "./types";

// The saved human peak is authoritative, including edits/undo made outside the detector.
export function proposalReviews(events: BehaviorAnnotation[]) {
  const result:Record<number,ProposalReviewState>={};
  for(const event of events)if(event.type==="PROPOSAL_REVIEW"&&event.frameIndex!=null){
    if(event.decision==="reject")result[event.frameIndex]={decision:"reject"};
    else delete result[event.frameIndex];
  }
  for(const peak of activePeaks(events))if(peak.label?.startsWith("REARING_")&&peak.frameIndex!=null)
    result[peak.frameIndex]={decision:"accept",label:peak.label as RearingTag};
  return result;
}

export function activeAnnotations(events: BehaviorAnnotation[]) {
  const undone = new Set(events.filter(e => e.type === "UNDO").map(e => e.targetId));
  return events.filter(e => e.type === "INTERVAL" && !undone.has(e.id));
}
export function activePeaks(events: BehaviorAnnotation[]) {
  const undone = new Set(events.filter(e => e.type === "UNDO").map(e => e.targetId));
  const labels = new Map<string, BehaviorAnnotation>();
  for (const event of events) if (event.type === "LABEL_PEAK" && event.targetId) labels.set(event.targetId, event);
  return events.filter(e => e.type === "PEAK" && !undone.has(e.id)).map(peak => {
    const edit = labels.get(peak.id);
    return edit ? { ...peak, label: edit.label, annotatorId: edit.annotatorId, note: edit.note } : peak;
  });
}
export function peaksCsv(events: BehaviorAnnotation[], videoId: string) {
  return "video_id,timestamp_sec,frame_index,label,annotator_id,video_sha256,tracking_job_id,annotation_id\n" + activePeaks(events).map(e =>
    [videoId,e.timestampSec,e.frameIndex,e.label,e.annotatorId,e.videoSha256,e.trackingJobId,e.id].map(csvCell).join(",")).join("\n") + "\n";
}
export function intervalError(start: number, end: number, duration: number) {
  return !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + .001
    ? "Marque um início e um fim dentro do vídeo, com fim posterior ao início." : null;
}
export function annotationOverlap(events: BehaviorAnnotation[], start: number, end: number) {
  return activeAnnotations(events).some(e => Math.max(start, e.startSec!) < Math.min(end, e.endSec!));
}
export function frameAt(times: number[], time: number) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= time + 1e-6) lo = mid + 1; else hi = mid; }
  return Math.max(0, lo - 1);
}
export function csvCell(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
export function annotationsCsv(events: BehaviorAnnotation[], videoId: string) {
  return "video_id,start_sec,end_sec,label,annotator_id,video_sha256,tracking_job_id,annotation_id,peak_annotation_id,example_kind\n" + activeAnnotations(events).map(e =>
    [videoId, e.startSec, e.endSec, e.label, e.annotatorId, e.videoSha256, e.trackingJobId, e.id, e.peakId, e.exampleKind].map(csvCell).join(",")).join("\n") + "\n";
}
