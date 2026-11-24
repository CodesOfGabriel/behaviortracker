"""CPU/OpenCL visual presence for fixed FST tank ROIs. No pose or behavior inference."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

import cv2
import numpy as np

from engine import read_frames, timestamps, write_json
from fst_presence import body_evidence, static_body_evidence, classify_presence_rows

VERSION = "opencv-fst-presence-1"


def run(request_path):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    root = Path(request_path).parent
    config, video = request["config"], request["video"]
    metadata = json.loads(subprocess.check_output([
        request["ffprobe"], "-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", video
    ]))["streams"][0]
    width, height = int(metadata["width"]), int(metadata["height"])
    if (width, height) != (config["width"], config["height"]) or any(
        float(side.get("rotation", 0)) % 360 for side in metadata.get("side_data_list", [])
    ):
        raise ValueError("Resolução ou rotação do vídeo diverge dos cilindros calibrados")
    tanks = config["tanks"]
    rects = {tank["animalId"]: (
        tank["roiPx"]["x"], tank["roiPx"]["y"],
        tank["roiPx"]["x"] + tank["roiPx"]["width"],
        tank["roiPx"]["y"] + tank["roiPx"]["height"],
    ) for tank in tanks}
    backend = "CPU"
    started, parent = time.perf_counter(), os.getppid()
    total = int(metadata.get("nb_frames", 0)) if str(metadata.get("nb_frames", "")).isdigit() else 0
    report = {"version": VERSION, "state": "running", "phase": "reference", "framesProcessed": 0,
              "totalFrames": total, "computeBackend": backend, "scientificallyValidated": False}
    write_json(root / "status.json", report)

    # Dark temporal percentile is the established visual reference; collect it
    # independently of pose so a missing neural point cannot imply absence.
    stride = max(1, total // 72) if total else 1
    references = {animal: [] for animal in rects}
    capture = read_frames(video, request["ffmpeg"], width, height)
    try:
        for index, frame in enumerate(capture):
            if (root / "cancel").exists() or os.getppid() != parent:
                report["state"] = "cancelled"
                write_json(root / "status.json", report)
                return
            if index % stride == 0 and len(next(iter(references.values()))) < 72:
                for animal, (x1, y1, x2, y2) in rects.items():
                    references[animal].append(cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY))
            if index % 120 == 0:
                report.update(referenceFrames=index + 1, totalFrames=total or None)
                write_json(root / "status.json", report)
    finally:
        capture.close()
    if min(map(len, references.values())) < 5:
        raise ValueError("Vídeo sem frames suficientes para referência visual")
    references = {animal: np.percentile(np.stack(frames), 8, axis=0).astype(np.uint8)
                  for animal, frames in references.items()}

    rows = {animal: [] for animal in rects}
    capture = read_frames(video, request["ffmpeg"], width, height)
    clock = timestamps(video, request["ffprobe"])
    last_time = 0.0
    report["phase"] = "presence"
    try:
        for index, frame in enumerate(capture):
            if (root / "cancel").exists() or os.getppid() != parent:
                report["state"] = "cancelled"
                write_json(root / "status.json", report)
                return
            timestamp = next(clock, None)
            if timestamp is None:
                raise ValueError("Frames e timestamps divergiram")
            last_time = timestamp
            for animal, (x1, y1, x2, y2) in rects.items():
                crop = frame[y1:y2, x1:x2]
                temporal = body_evidence(crop, references[animal])
                static = static_body_evidence(crop) if temporal["bbox"] is None else None
                chosen = temporal if temporal["bbox"] is not None else static
                rows[animal].append({
                    "frame": index, "timestampSec": timestamp, "animalId": animal,
                    "body_candidate": chosen is not None and chosen["bbox"] is not None,
                    "temporal_candidate": temporal["bbox"] is not None,
                    "static_candidate": static is not None,
                    "foreground_fraction": temporal["foreground_fraction"],
                    "bodyScore": float(chosen["score"]) if chosen else 0.0,
                    "bboxLocal": chosen["bbox"] if chosen else None,
                })
            if index % 12 == 0:
                elapsed = time.perf_counter() - started
                report.update(framesProcessed=index + 1, totalFrames=total or None,
                              elapsedSec=elapsed, processingFps=(index + 1) / max(.001, elapsed))
                write_json(root / "status.json", report)
        if next(clock, None) is not None:
            raise ValueError("Decoder encerrou antes dos timestamps")
    finally:
        capture.close()
        clock.close()
    count = len(next(iter(rows.values())))
    if count < 2:
        raise ValueError("Vídeo sem frames válidos")
    if total and count != total:
        raise ValueError("Contagem de frames divergiu do vídeo original")
    fps = (count - 1) / last_time if last_time > 0 else 0
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("FPS do vídeo inválido")
    frames, confirmed = [], 0
    for animal, records in rows.items():
        states, _ = classify_presence_rows(records, fps)
        x1, y1, _, _ = rects[animal]
        for record, state in zip(records, states):
            present = str(state) == "IN_TANK"
            box = record["bboxLocal"] if present else None
            confirmed += int(present)
            frames.append({"frame": record["frame"], "timestampSec": record["timestampSec"],
                           "animalId": animal, "presence": str(state), "classification": "NOT_CLASSIFIED",
                           "bodyScore": record["bodyScore"], "bbox": {
                               "x": x1 + box[0], "y": y1 + box[1],
                               "width": box[2] - box[0], "height": box[3] - box[1],
                           } if box else None})
    frames.sort(key=lambda value: (value["frame"], value["animalId"]))
    result = {"schemaVersion": "fst-local-presence-1", "protocol": "forced_swim",
              "engineId": VERSION, "analysisStatus": "EXPERIMENTAL_NOT_FOR_BEHAVIOR",
              "runId": config["jobId"], "video": {"sha256": config["videoSha256"],
              "width": width, "height": height, "fps": fps, "frameCount": count},
              "subjects": config["subjects"], "tanks": tanks, "frames": frames,
              "behaviorMetrics": None}
    write_json(root / "result.json", result)
    elapsed = time.perf_counter() - started
    report.update(state="succeeded", phase="complete", framesProcessed=count,
                  totalFrames=count, elapsedSec=elapsed, processingFps=count / max(.001, elapsed),
                  confirmedPresenceFrames=confirmed)
    if request.get("auditVideo"):
        from local_audit_video import finalize
        finalize(request, root, report, parent, write_json)
    write_json(root / "status.json", report)


if __name__ == "__main__":
    try:
        run(sys.argv[1])
    except BaseException as error:
        import traceback
        traceback.print_exc()
        path = Path(sys.argv[1]).parent / "status.json"
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = {"version": VERSION}
        write_json(path, {**previous, "state": "failed", "error": str(error)[:2000]})
        raise SystemExit(1)
