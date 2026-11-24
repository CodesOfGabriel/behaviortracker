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

from engine import read_frames, reference_frames, SilhouetteFeatures, timestamps, write_json
from fst_presence import body_evidence, classify_presence_rows

VERSION = "opencv-fst-presence-3"


class TankBodyTracker:
    """Per-cylinder association; rejected reflections never become predicted boxes.

    Presence consensus remains a separate FST step. No floor geometry is used.
    """
    def __init__(self):
        self.last = None
        self.appearance = None

    def observe(self, crop, reference, timestamp):
        temporal = body_evidence(crop, reference, debug=True)
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY+cv2.THRESH_OTSU)[0]
        static_mask = np.uint8(blurred >= max(92, otsu))*255
        h, w = gray.shape
        size = max(5, min(13, round(min(w, h)*.04)))
        static_mask = cv2.morphologyEx(static_mask, cv2.MORPH_OPEN,
                                     cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
        lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
        recent = self.last if self.last and 0 < timestamp-self.last[2] <= .5 else None
        candidates = []
        for method, mask in (("temporal", temporal["mask"]), ("static", static_mask)):
            count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
            for index in range(1, count):
                x, y, bw, bh, area = map(int, stats[index])
                fill = area/max(1, bw*bh)
                # Bodies may touch the glass on both sides. Width alone must
                # not discard them while retaining a lower reflected fragment.
                if not (.035*w*h <= area <= .45*w*h and bw >= .25*w and
                        .12*h <= bh <= .83*h and fill >= (.22 if method == "temporal" else .32)):
                    continue
                component = np.uint8(labels[y:y+bh, x:x+bw] == index)*255
                distance = cv2.distanceTransform(component, cv2.DIST_L2, 3)
                core = distance >= max(1, float(distance.max())*.35)
                color = np.median(lab[y:y+bh, x:x+bw][core], axis=0)
                center = (x+bw/2, y+bh/2)
                delta = float(np.linalg.norm((color-self.appearance)*[.3, 1, 1])) if self.appearance is not None else 0.
                movement = math.dist(center, recent[0]) if recent else 0.
                if recent and movement > max(.18*math.hypot(w, h), .8*max(recent[1][2:])):
                    continue
                if recent and delta > 45:
                    continue
                score = area/(w*h)+.15*fill-.4*movement/max(1, math.hypot(w, h))-.005*delta
                candidates.append({"bbox": (x, y, x+bw, y+bh), "score": area/(w*h),
                                   "rank": score, "method": method, "color": color,
                                   "component": component, "center": center})
        # Use the independent silhouette only when temporal candidates fail.
        primary = [c for c in candidates if c["method"] == "temporal"]
        chosen = max(primary or candidates, key=lambda c: c["rank"], default=None)
        mask = np.zeros_like(gray)
        if chosen:
            x, y, x2, y2 = chosen["bbox"]
            mask[y:y2, x:x2] = chosen["component"]
            self.last = (chosen["center"], (x, y, x2-x, y2-y), timestamp)
            self.appearance = chosen["color"].copy() if self.appearance is None else .95*self.appearance+.05*chosen["color"]
        return chosen, mask, temporal["foreground_fraction"]


def run(request_path):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    root = Path(request_path).parent
    config, video = request["config"], request["video"]
    probe = json.loads(subprocess.check_output([
        request["ffprobe"], "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", video
    ]))
    metadata = probe["streams"][0]
    width, height = int(metadata["width"]), int(metadata["height"])
    if (width, height) != (config["width"], config["height"]) or any(
        float(side.get("rotation", 0)) % 360 for side in metadata.get("side_data_list", [])
    ):
        raise ValueError("Resolução ou rotação do vídeo diverge dos cilindros calibrados")
    tanks = config["tanks"]
    # Bound CPU work without shrinking narrow calibrated cylinders below 160 px.
    minimum_side = min(min(t["roiPx"]["width"], t["roiPx"]["height"]) for t in tanks)
    scale = min(1., max(min(1280/width, 720/height), 160/minimum_side))
    processing_size = (round(width*scale), round(height*scale))
    rects = {tank["animalId"]: (
        round(tank["roiPx"]["x"]*scale), round(tank["roiPx"]["y"]*scale),
        round((tank["roiPx"]["x"] + tank["roiPx"]["width"])*scale),
        round((tank["roiPx"]["y"] + tank["roiPx"]["height"])*scale),
    ) for tank in tanks}
    backend = "CPU"
    started, parent = time.perf_counter(), os.getppid()
    total = int(metadata.get("nb_frames", 0)) if str(metadata.get("nb_frames", "")).isdigit() else 0
    report = {"version": VERSION, "state": "running", "phase": "reference", "framesProcessed": 0,
              "totalFrames": total, "computeBackend": backend, "scientificallyValidated": False}
    report["processingGeometry"] = {"width": processing_size[0], "height": processing_size[1],
                                    "coordinateSpace": "original_video", "scale": scale,
                                    "association": "per_tank_temporal_appearance"}
    write_json(root / "status.json", report)

    # Dark temporal percentile is the established visual reference; collect it
    # independently of pose so a missing neural point cannot imply absence.
    references = {animal: [] for animal in rects}
    duration = float(metadata.get("duration") or probe.get("format", {}).get("duration") or 0)
    sampled_times = []
    capture = reference_frames(video, request["ffmpeg"], width, height, duration, total,
                              output_size=processing_size,
                              cancelled=lambda: (root/"cancel").exists() or os.getppid() != parent)
    try:
        for second, frame in capture:
            sampled_times.append(second)
            for animal, (x1, y1, x2, y2) in rects.items():
                references[animal].append(cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY))
            report.update(referenceFrames=len(sampled_times), totalFrames=total or None)
            write_json(root / "status.json", report)
    except InterruptedError:
        report["state"] = "cancelled"
        write_json(root / "status.json", report)
        return
    finally:
        capture.close()
    if min(map(len, references.values())) < 5:
        raise ValueError("Vídeo sem frames suficientes para referência visual")
    references = {animal: np.percentile(np.stack(frames), 8, axis=0).astype(np.uint8)
                  for animal, frames in references.items()}
    report["backgroundReference"] = {"method": "dark_percentile_8_sparse_seek" if duration > 0 else "dark_percentile_8_bounded_prefix",
                                     "sampleTimesSec": sampled_times, "sampledFrames": len(sampled_times), "frozen": True}
    write_json(root / "reference.json", report["backgroundReference"])
    features = {animal: SilhouetteFeatures() for animal in rects}
    trackers = {animal: TankBodyTracker() for animal in rects}

    rows = {animal: [] for animal in rects}
    capture = read_frames(video, request["ffmpeg"], width, height, output_size=processing_size)
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
                chosen, body_mask, foreground_fraction = trackers[animal].observe(crop, references[animal], timestamp)
                gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
                motion = features[animal].extract(gray, body_mask, timestamp, scale)
                contours = cv2.findContours(body_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
                contour = cv2.approxPolyDP(max(contours, key=cv2.contourArea), 1, True)[:, 0].tolist() if contours else None
                rows[animal].append({
                    "frame": index, "timestampSec": timestamp, "animalId": animal,
                    "body_candidate": chosen is not None and chosen["bbox"] is not None,
                    "temporal_candidate": chosen is not None and chosen["method"] == "temporal",
                    "static_candidate": chosen is not None and chosen["method"] == "static",
                    "foreground_fraction": foreground_fraction,
                    "bodyScore": float(chosen["score"]) if chosen else 0.0,
                    "bboxLocal": chosen["bbox"] if chosen else None,
                    "motionFeatures": motion,
                    "contourLocal": contour,
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
        px1, py1, px2, py2 = rects[animal]
        roi = next(t["roiPx"] for t in tanks if t["animalId"] == animal)
        sx, sy = roi["width"]/(px2-px1), roi["height"]/(py2-py1)
        for record, state in zip(records, states):
            present = str(state) == "IN_TANK"
            box = record["bboxLocal"] if present else None
            confirmed += int(present)
            motion = record["motionFeatures"] if present and box else None
            if motion:
                motion["observationUsable"] = True
            frames.append({"frame": record["frame"], "timestampSec": record["timestampSec"],
                           "animalId": animal, "presence": str(state), "classification": "NOT_CLASSIFIED",
                           "bodyScore": record["bodyScore"], "motionFeatures": motion,
                           "contour": [{"x": roi["x"]+point[0]*sx, "y": roi["y"]+point[1]*sy}
                                       for point in record["contourLocal"]] if box and record["contourLocal"] else None,
                           "bbox": {
                               "x": roi["x"] + box[0]*sx, "y": roi["y"] + box[1]*sy,
                               "width": (box[2] - box[0])*sx, "height": (box[3] - box[1])*sy,
                           } if box else None})
    frames.sort(key=lambda value: (value["frame"], value["animalId"]))
    result = {"schemaVersion": "fst-local-presence-1", "protocol": "forced_swim",
              "engineId": VERSION, "analysisStatus": "EXPERIMENTAL_NOT_FOR_BEHAVIOR",
              "runId": config["jobId"], "video": {"sha256": config["videoSha256"],
              "width": width, "height": height, "fps": fps, "frameCount": count},
              "subjects": config["subjects"], "tanks": tanks, "frames": frames,
              "behaviorMetrics": None, "backgroundReference": report["backgroundReference"],
              "featureSchema": "silhouette-features-1", "processingGeometry": report["processingGeometry"]}
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
