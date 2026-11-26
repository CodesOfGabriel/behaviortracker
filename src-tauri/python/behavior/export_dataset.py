"""Human annotation snapshot and original tracking, optionally with the source video."""
import csv
import io
import json
from pathlib import Path
import sys
import zipfile


def active_annotations(events):
    """Resolve the append-only history identically for CSV, ZIP and training."""
    request = {"annotations": events}
    undone = {event.get("targetId") for event in request["annotations"] if event["type"] == "UNDO"}
    intervals = [event for event in request["annotations"] if event["type"] == "INTERVAL" and event["id"] not in undone]
    labels = {e["targetId"]: e for e in request["annotations"] if e["type"] == "LABEL_PEAK"}
    peaks = [{**e, **{k: labels[e["id"]][k] for k in ("label", "annotatorId", "note") if k in labels[e["id"]]}}
             if e["id"] in labels else e for e in request["annotations"] if e["type"] == "PEAK" and e["id"] not in undone]
    return intervals, peaks


def export_annotations(request_path, destination, kind):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    intervals, peaks = active_annotations(request["annotations"])
    if kind == "history":
        Path(destination).write_text("".join(json.dumps(e, ensure_ascii=False)+"\n" for e in request["annotations"]), encoding="utf-8")
        return
    rows = peaks if kind == "peaks" else intervals if kind == "intervals" else None
    if rows is None or not rows:
        raise ValueError("Não há marcações salvas para esta exportação")
    fields = (["timestamp_sec", "frame_index"] if kind == "peaks" else ["start_sec", "end_sec"])
    keys = (["timestampSec", "frameIndex"] if kind == "peaks" else ["startSec", "endSec"])
    with Path(destination).open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.writer(stream)
        writer.writerow(["video_id", *fields, "label", "annotator_id", "video_sha256", "tracking_job_id", "annotation_id"])
        for event in rows:
            writer.writerow([request["experimentId"], *(event[key] for key in keys), event["label"], event["annotatorId"],
                             event["videoSha256"], event["trackingJobId"], event["id"]])


def export(request_path, destination):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    intervals, peaks = active_annotations(request["annotations"])
    if not intervals and not peaks:
        raise ValueError("Salve pelo menos uma anotação humana antes de exportar")
    def csv_text(fields, rows):
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
        return stream.getvalue()
    vid = request["experimentId"]
    filename = vid+Path(request["video"]).suffix
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("annotations/intervals.csv", csv_text(
            ["video_id", "start_sec", "end_sec", "label", "annotator_id", "video_sha256", "tracking_job_id", "annotation_id"],
            [dict(video_id=vid, start_sec=e["startSec"], end_sec=e["endSec"], label=e["label"], annotator_id=e["annotatorId"],
                  video_sha256=e["videoSha256"], tracking_job_id=e["trackingJobId"], annotation_id=e["id"]) for e in intervals]))
        archive.writestr("annotations/peaks.csv", csv_text(
            ["video_id", "timestamp_sec", "frame_index", "label", "annotator_id", "video_sha256", "tracking_job_id", "annotation_id"],
            [dict(video_id=vid, timestamp_sec=e["timestampSec"], frame_index=e["frameIndex"], label=e["label"],
                  annotator_id=e["annotatorId"], video_sha256=e["videoSha256"], tracking_job_id=e["trackingJobId"], annotation_id=e["id"]) for e in peaks]))
        archive.writestr("annotations/videos.csv", csv_text(
            ["video_id", "animal_id", "session_id", "arena_id", "sha256", "filename", "condition"],
            [dict(video_id=vid, animal_id=request["animalId"], session_id=request["sessionId"], arena_id=request["arenaId"],
                  sha256=request["videoSha256"], filename=filename, condition=request.get("condition", "unspecified"))]))
        archive.writestr("annotations/history.jsonl", "".join(json.dumps(e)+"\n" for e in request["annotations"]))
        archive.writestr("annotations/annotation_protocol.md", request["annotationProtocol"])
        archive.write(Path(request["trackingDirectory"])/"samples.jsonl", f"tracking/{vid}/samples.jsonl")
        archive.write(Path(request["trackingDirectory"])/"request.json", f"tracking/{vid}/request.json")
        for name in ("background-reference.png", "reference.json", "run_manifest.json", "status.json"):
            source = Path(request["trackingDirectory"])/name
            if source.is_file():
                archive.write(source, f"tracking/{vid}/{name}")
        if request.get("includeVideo"):
            archive.write(request["video"], "videos/"+filename, compress_type=zipfile.ZIP_STORED)
        archive.writestr("dataset_export.json", json.dumps(dict(schemaVersion=1, videoId=vid, videoSha256=request["videoSha256"],
            trackingJobId=request["trackingJobId"], containsOriginalVideo=bool(request.get("includeVideo")), source="human",
            note="Merge independent videos before dataset splitting. Unannotated intervals are unknown. Peaks mark single frames and do not define episode duration or interval training labels."), indent=2))


def export_results(directory, destination, reviews):
    directory = Path(directory)
    status = json.loads((directory/"status.json").read_text(encoding="utf-8"))
    if status.get("state") != "succeeded":
        raise ValueError("Only completed behavior runs can be exported")
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for filename in ("request.json", "status.json", "engine.log"):
            source = directory/filename
            if source.is_file():
                archive.write(source, filename)
        for source in sorted((directory/"result").iterdir()):
            if source.is_file():
                archive.write(source, source.name)
        archive.write(reviews, "behavior_review_events.json")


if __name__ == "__main__":
    export(sys.argv[1], sys.argv[2])
