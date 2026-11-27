"""Human annotation snapshot and original tracking, optionally with the source video."""
import csv
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
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


LANDMARKS = ("nose", "left_ear", "right_ear", "body_center", "hip", "tail_base")


def active_pose_frames(events):
    undone = {e.get("targetId") for e in events if e["type"] == "UNDO"}
    latest = {}
    for event in events:
        if event["type"] == "POSE_FRAME" and event["id"] not in undone:
            latest[event["frameIndex"]] = event
    return [latest[i] for i in sorted(latest)]


POSE_FIELDS = ["video_id", "frame_index", "timestamp_sec", "image_path", "image_width", "image_height",
               "keypoint", "x", "y", "visibility", "annotator_id", "video_sha256", "tracking_job_id", "annotation_id"]


def pose_rows(poses, video_id):
    for event in poses:
        for key in LANDMARKS:
            point = event["pose"][key]
            yield dict(video_id=video_id, frame_index=event["frameIndex"], timestamp_sec=event["timestampSec"],
                image_path=f"pose_frames/frame_{event['frameIndex']:08d}.png", image_width=event["imageWidth"], image_height=event["imageHeight"],
                keypoint=key, x=point["x"], y=point["y"], visibility=point["visibility"], annotator_id=event["annotatorId"],
                video_sha256=event["videoSha256"], tracking_job_id=event["trackingJobId"], annotation_id=event["id"])


def write_pose_images(archive, request, poses):
    if not poses:
        return
    ffmpeg = request.get("ffmpeg") or shutil.which("ffmpeg")
    if not ffmpeg:
        raise ValueError("FFmpeg é necessário para incluir os quadros anotados")
    frames = [e["frameIndex"] for e in poses]
    if any(not isinstance(i, int) or isinstance(i, bool) or i < 0 for i in frames):
        raise ValueError("Índice de quadro inválido")
    with tempfile.TemporaryDirectory(prefix="human-pose-") as folder:
        folder = Path(folder)
        # Select by decoded frame index, never by a rounded FPS seek. Preserve
        # the same autorotation policy as the source annotation player.
        orientation = [] if request.get("config", {}).get("autorotate", False) else ["-noautorotate"]
        selection = "+".join(f"eq(n\\,{i})" for i in frames)
        command = [str(ffmpeg), "-v", "error", "-nostdin", *orientation, "-i", request["video"],
            "-map", "0:v:0", "-vf", "select="+selection, "-fps_mode", "passthrough", "-start_number", "0", str(folder/"%08d.png")]
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode:
            raise ValueError("Não foi possível extrair os quadros anotados: "+result.stderr.decode(errors="replace")[-1000:])
        images = sorted(folder.glob("*.png"))
        if len(images) != len(poses):
            raise ValueError("Os quadros anotados não correspondem ao vídeo original")
        for image, event in zip(images, poses):
            with image.open("rb") as stream:
                header = stream.read(24)
            if len(header)!=24 or header[:8]!=b"\x89PNG\r\n\x1a\n" or struct.unpack(">II",header[16:24])!=(event["imageWidth"],event["imageHeight"]):
                raise ValueError("As dimensões do quadro divergem das coordenadas anotadas")
            archive.write(image, f"pose_frames/frame_{event['frameIndex']:08d}.png", compress_type=zipfile.ZIP_STORED)


def export_annotations(request_path, destination, kind):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    intervals, peaks = active_annotations(request["annotations"])
    if kind == "poses":
        poses = active_pose_frames(request["annotations"])
        if not poses:
            raise ValueError("Não há pontos corporais salvos para exportar")
        with Path(destination).open("w", newline="", encoding="utf-8-sig") as stream:
            writer = csv.DictWriter(stream, fieldnames=POSE_FIELDS)
            writer.writeheader()
            writer.writerows(pose_rows(poses,request["experimentId"]))
        return
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
        extras = ["peak_annotation_id", "example_kind"] if kind == "intervals" else []
        writer.writerow(["video_id", *fields, "label", "annotator_id", "video_sha256", "tracking_job_id", "annotation_id", *extras])
        for event in rows:
            writer.writerow([request["experimentId"], *(event[key] for key in keys), event["label"], event["annotatorId"],
                             event["videoSha256"], event["trackingJobId"], event["id"], *([event.get("peakId", ""), event.get("exampleKind", "")] if extras else [])])


def export(request_path, destination):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    intervals, peaks = active_annotations(request["annotations"])
    poses = active_pose_frames(request["annotations"])
    if not intervals and not peaks and not poses:
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
            ["video_id", "start_sec", "end_sec", "label", "annotator_id", "video_sha256", "tracking_job_id", "annotation_id", "peak_annotation_id", "example_kind"],
            [dict(video_id=vid, start_sec=e["startSec"], end_sec=e["endSec"], label=e["label"], annotator_id=e["annotatorId"],
                  video_sha256=e["videoSha256"], tracking_job_id=e["trackingJobId"], annotation_id=e["id"], peak_annotation_id=e.get("peakId", ""), example_kind=e.get("exampleKind", "")) for e in intervals]))
        archive.writestr("annotations/poses.csv", csv_text(POSE_FIELDS, pose_rows(poses,vid)))
        archive.writestr("annotations/pose_schema.json", json.dumps(dict(schemaVersion=1, keypoints=LANDMARKS,
            coordinateSpace="original_video_pixels", hiddenCoordinates=None, visibility=["visible","occluded","out_of_frame"],
            source="human", anatomicalSides="animal_left_and_right", estimatedPointsIncluded=False), indent=2))
        write_pose_images(archive,request,poses)
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
            poseFrames=len(poses), containsAnnotatedPoseImages=bool(poses), intervals=len(intervals), peaks=len(peaks),
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
