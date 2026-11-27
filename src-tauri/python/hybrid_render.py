"""Renderiza o vídeo de inspeção D+F a partir dos CSVs do job."""

import csv
from bisect import bisect_left
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys


SOURCE = "behavetracker-hybrid-df-v2"
SKELETON_VIDEO_VERSION = "oft-layered-video-8"
VISUAL_LIKELIHOOD = .50
METRIC_LIKELIHOOD = .60
MAX_PAIR_GAP_SEC = .5
SMOOTHING_SEC = 1.0
IMMOBILITY_THRESHOLD_CM_S = 2.0
MIN_IMMOBILITY_SEC = .5

# Nomes da configuração HRNet Wistar; nenhuma cor depende da posição da coluna.
REGIONS = {
    "nose": "head", "left_ear": "ears", "right_ear": "ears",
    "left_ear_tip": "ears", "right_ear_tip": "ears", "left_eye": "head",
    "right_eye": "head", "head_midpoint": "head", "neck": "head",
    "mid_back": "trunk", "mouse_center": "trunk", "mid_backend": "trunk",
    "mid_backend2": "trunk", "mid_backend3": "trunk",
    "left_shoulder": "front", "right_shoulder": "front",
    "left_midside": "trunk", "right_midside": "trunk",
    "left_hip": "hind", "right_hip": "hind",
    "tail_base": "tail", "tail1": "tail", "tail2": "tail",
    "tail3": "tail", "tail4": "tail", "tail5": "tail", "tail_end": "tail",
}
COLORS = {"head": (238, 211, 34), "ears": (250, 165, 96), "trunk": (153, 211, 52),
          "front": (21, 204, 250), "hind": (60, 146, 251),
          "tail": (182, 114, 244), "other": (225, 213, 203)}


def visual_point(row, width, height):
    if (str(row.get("tracking_accepted", "")).strip().lower() in ("false", "0") and row.get("source") != "manual"
            or row.get("status") in ("jump", "out_of_arena")):
        return None
    try:
        x, y, score = float(row["x_px"]), float(row["y_px"]), float(row["likelihood"])
        if (all(math.isfinite(v) for v in (x, y, score)) and
                0 <= x < width and 0 <= y < height and
                (score >= VISUAL_LIKELIHOOD or row.get("source") == "recovered" and row.get("processing_version") == "oft-layers-1") and
                row["status"] != "missing"):
            return x, y, score
    except (ValueError, TypeError, KeyError):
        pass
    return None


def has_calibration(arena):
    corners = (arena or {}).get("cornersPx")
    measures = ((arena or {}).get(key) for key in ("widthCm", "heightCm"))
    return bool(corners and len(corners) == 4
                and all(isinstance(value, (int, float)) and math.isfinite(value) and value > 0 for value in measures))


def floor_speed_pairs(values, layers):
    """A wall silhouette is visible tracking, never a floor speed pair."""
    eligible = [row.get("trackingAccepted") is True
                and (row.get("localQuality") or {}).get("tracking") == "observed"
                and (row.get("localQuality") or {}).get("geometry") == "floor"
                and row.get("reason") not in {"researcher_intervention", "researcher_intervention_pending"}
                for row in layers]
    return [value if i and eligible[i] and eligible[i-1] else None for i, value in enumerate(values)]


def locomotor_series(poses, timestamps, arena, width, height):
    """Velocidade em cm/s, usando somente pares consecutivos de mouse_center válidos."""
    import cv2
    import numpy as np

    result = [None] * len(timestamps)
    if not has_calibration(arena):
        return result
    corners, width_cm, height_cm = arena["cornersPx"], arena["widthCm"], arena["heightCm"]
    source = np.float32([[p["x"], p["y"]] for p in corners])
    destination = np.float32([[0, 0], [width_cm, 0], [width_cm, height_cm], [0, height_cm]])
    matrix = cv2.getPerspectiveTransform(source, destination)
    previous = None
    for index, rows in enumerate(poses):
        center = next((row for row in rows if row["keypoint"] == "mouse_center"), None)
        point = visual_point(center, width, height) if center else None
        if (not point or center["status"] != "valid" or point[2] < METRIC_LIKELIHOOD
                or center.get("source") in ("recovered", "predicted")):
            previous = None
            continue
        floor = cv2.perspectiveTransform(np.float32([[[point[0], point[1]]]]), matrix)[0, 0]
        if not all(math.isfinite(float(v)) for v in floor) or not (0 <= floor[0] <= width_cm and 0 <= floor[1] <= height_cm):
            previous = None
            continue
        current = (index, timestamps[index], float(floor[0]), float(floor[1]))
        if previous and previous[0] == index - 1:
            delta = current[1] - previous[1]
            if 0 < delta <= MAX_PAIR_GAP_SEC:
                result[index] = math.hypot(current[2] - previous[2], current[3] - previous[3]) / delta
        previous = current
    return result


def smooth_series(values, timestamps, window_sec=SMOOTHING_SEC):
    """Média móvel causal; lacunas quebram a série, sem criar zeros."""
    result = [None] * len(values)
    start = 0
    total = 0.0
    for index, value in enumerate(values):
        if value is None:
            start, total = index + 1, 0.0
            continue
        total += value
        while start < index and timestamps[index] - timestamps[start] > window_sec:
            total -= values[start]
            start += 1
        result[index] = total / (index - start + 1)
    return result


def immobility_flags(values, timestamps):
    """Marca somente frames após 0,5 s consecutivos de baixa velocidade válida."""
    flags = [False] * len(values)
    duration = 0.0
    for index, value in enumerate(values):
        if index == 0 or value is None or value > IMMOBILITY_THRESHOLD_CM_S:
            duration = 0.0
            continue
        delta = timestamps[index] - timestamps[index - 1]
        duration = duration + delta if 0 < delta <= MAX_PAIR_GAP_SEC else 0.0
        flags[index] = duration >= MIN_IMMOBILITY_SEC
    return flags


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def draw_panel(frame, index, timestamp, total, model, animal, valid_count, score, speed, series, timestamps, immobile, calibrated=True, point_count=27, skeleton_count=None):
    import cv2

    height, width = frame.shape[:2]
    scale = max(.48, min(width / 1280, height / 720, 1.25))
    margin = max(8, round(16 * scale))
    font = cv2.FONT_HERSHEY_SIMPLEX
    header_w = min(width - 2 * margin, round(515 * scale))
    header_h = round(84 * scale)
    overlay = frame.copy()
    cv2.rectangle(overlay, (margin, margin), (margin + header_w, margin + header_h), (10, 14, 17), -1)
    cv2.addWeighted(overlay, .72, frame, .28, 0, frame)
    def label(value, x, y, color=(238, 241, 244), size=.58):
        cv2.putText(frame, value, (x, y), font, size * scale, color, max(1, round(2 * scale)), cv2.LINE_AA)
    label(f"{animal}  |  {model}", margin + 11, margin + round(23 * scale), (238, 241, 244), .54)
    label(f"FRAME {index + 1}/{total}   TEMPO {timestamp:.2f} s", margin + 11, margin + round(47 * scale), size=.55)
    detector_text = f"DETECTOR {score:.2f}" if score is not None else "DETECTOR --"
    pose_text = f"SKELETON {skeleton_count}/7" if skeleton_count is not None else f"POSE >=0.60 {valid_count}/{point_count}"
    label(f"{pose_text}   {detector_text}", margin + 11, margin + round(71 * scale),
          (153, 211, 52) if valid_count >= 2 else (80, 180, 250), .55)

    # Janela temporal de 10 segundos. Cada ponto vem do frame já renderizado.
    chart_w = min(round(width * .28), round(350 * scale))
    chart_h = round(145 * scale)
    if chart_w < 110 or width < 600 or chart_h + 2 * margin > height:
        return
    left, top = width - margin - chart_w, margin
    overlay = frame.copy()
    cv2.rectangle(overlay, (left, top), (left + chart_w, top + chart_h), (10, 14, 17), -1)
    cv2.addWeighted(overlay, .78, frame, .22, 0, frame)
    label("ATIVIDADE LOCOMOTORA", left + 9, top + round(20 * scale), size=.42)
    label(f"{speed:.1f} cm/s" if speed is not None else "-- cm/s", left + 9, top + round(45 * scale),
          (153, 211, 52) if speed is not None else (175, 175, 175), .66)
    if immobile:
        label("IMOBILIDADE OPERACIONAL", left + round(112 * scale), top + round(44 * scale),
              (80, 180, 250), .33)
    x0, x1 = left + round(27 * scale), left + chart_w - round(10 * scale)
    y0, y1 = top + round(58 * scale), top + chart_h - round(22 * scale)
    cv2.line(frame, (x0, y0), (x0, y1), (120, 126, 129), 1)
    cv2.line(frame, (x0, y1), (x1, y1), (120, 126, 129), 1)
    visible_start = timestamp - 10
    visible = range(bisect_left(timestamps, visible_start), index + 1)
    cap = max((series[j] for j in visible if series[j] is not None), default=1.0)
    if not any(series[j] is not None for j in visible):
        label("SEM PARES VALIDOS NESTE TRECHO" if calibrated else "CALIBRACAO INDISPONIVEL",
              x0 + round(6 * scale), (y0 + y1) // 2, (175, 175, 175), .35)
    cap = max(2.0, cap)
    label(f"{cap:.0f}", left + round(4 * scale), y0 + round(4 * scale), size=.34)
    label("0", left + round(9 * scale), y1, size=.34)
    previous = None
    for j in visible:
        value = series[j]
        if value is None:
            previous = None
            continue
        x = round(x0 + (timestamps[j] - visible_start) / 10 * (x1 - x0))
        y = round(y1 - min(value / cap, 1) * (y1 - y0))
        if previous is not None:
            cv2.line(frame, previous, (x, y), (153, 211, 52), max(1, round(2 * scale)), cv2.LINE_AA)
        previous = (x, y)
    if previous:
        cv2.circle(frame, previous, max(2, round(3 * scale)), (238, 241, 244), -1, cv2.LINE_AA)
    label("-10 s", x0, top + chart_h - round(5 * scale), size=.37)
    label("agora", x1 - round(42 * scale), top + chart_h - round(5 * scale), size=.37)


def render(video, output_dir, arena, *, job_id=None, ffmpeg_path=None, progress=None):
    import cv2

    root = Path(output_dir)
    prefix = f"{job_id}-" if job_id else ""
    video_name = f"{job_id}-dlc-activity.mp4" if job_id else "dlc_labeled.mp4"
    report = {"schemaVersion": 1, "available": False, "source": SOURCE,
              "filename": video_name, "error": None}
    target = root / report["filename"]
    temporary = target.with_suffix(".partial.mp4")
    process = None
    capture = None
    try:
        ffmpeg = ffmpeg_path or shutil.which("ffmpeg")
        if ffmpeg is None:
            raise RuntimeError("FFmpeg não disponível")
        manifest = json.loads((root / f"{prefix}run_manifest.json").read_text(encoding="utf-8"))
        expected = int(manifest["frameCount"])
        width, height, fps = int(manifest["frameWidth"]), int(manifest["frameHeight"]), float(manifest["fps"])
        if expected <= 0 or width <= 0 or height <= 0 or fps <= 0:
            raise ValueError("Metadados de vídeo inválidos")
        with (root / f"{prefix}detections.csv").open(newline="", encoding="utf-8") as handle:
            detections = list(csv.DictReader(handle))
        if len(detections) != expected:
            raise ValueError("Contagem de detecções incompatível")
        poses = {}
        with (root / (f"{job_id}.csv" if job_id else "canonical_pose.csv")).open(newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                poses.setdefault(int(row["frame_index"]), []).append(row)
        layered = manifest.get("pipelineVersion") == "oft-layers-1"
        point_count = int(manifest.get("keypointCount", 27)) if layered else 27
        if point_count <= 0 or point_count > 64 or len(poses) != expected or any(len(poses.get(i, [])) != point_count for i in range(expected)):
            raise ValueError("Contagem de poses incompatível")
        if set(manifest.get("keypoints", [])) != {row["keypoint"] for row in poses[0]}:
            raise ValueError("Keypoints do manifesto não correspondem às poses")
        timestamps = [float(poses[index][0]["timestamp_sec"]) for index in range(expected)]
        if any(not math.isfinite(value) or (index and value <= timestamps[index - 1])
               for index, value in enumerate(timestamps)):
            raise ValueError("Timestamps de poses inválidos")
        pose_rows = [poses[index] for index in range(expected)]
        # Historical OFT jobs retain their original 27-point CSV. Rebuild only
        # the display geometry from the video and the saved detector boxes.
        legacy_oft = (manifest.get("modelBundleId") in {"wistar_df_v1", "wistar_df_v2"}
                      and manifest.get("protocol", "open_field") == "open_field"
                      and manifest.get("engineId", "wistar_superanimal_hybrid_v1") == "wistar_superanimal_hybrid_v1")
        from oft_layers import POLICY, TRACKING_BOX_POLICY, tracking_box
        layer_root, layer_prefix = root, prefix
        layer_source = "saved_layers" if layered else None
        if legacy_oft and (not layered or manifest.get("layers", {}).get("trackingBox") != TRACKING_BOX_POLICY
                           or manifest.get("layers", {}).get("headTracking") != POLICY["headTracking"]
                           or manifest.get("layers", {}).get("temporalRefinement") != POLICY["temporalRefinement"]
                           or manifest.get("layers", {}).get("silhouetteSupport") != POLICY["silhouetteSupport"]):
            from oft_layered_pipeline import run as reconstruct_layers
            layer_root, layer_prefix = root / f"{prefix}video-layers", ""
            reconstruct_layers(video, detections, layer_root, arena, fps, width, height, ffmpeg=ffmpeg)
            layer_source = "saved_detections_cpu_geometry"
        body_overlay = layered or legacy_oft
        layer_rows, layer_predictions = [], []
        if body_overlay:
            from oft_layers import draw_overlay
            with (layer_root/f"{layer_prefix}samples.jsonl").open(encoding="utf-8") as source:
                layer_rows = [json.loads(line) for line in source]
            prediction_file = root/f"{prefix}rearing_predictions.jsonl" if layered else layer_root/f"{layer_prefix}rearing_predictions.jsonl"
            with prediction_file.open(encoding="utf-8") as source:
                layer_predictions = [json.loads(line) for line in source]
            if len(layer_rows) != expected or len(layer_predictions) != expected or any(
                row["frameIndex"] != i or abs(row["timestampSec"]-timestamps[i]) > 1e-6
                for rows in [layer_rows, layer_predictions] for i,row in enumerate(rows)):
                raise ValueError("Camadas e vídeo divergem")
        raw_speeds = locomotor_series(pose_rows, timestamps, arena, width, height)
        if body_overlay:
            raw_speeds = floor_speed_pairs(raw_speeds, layer_rows)
        calibrated = has_calibration(arena)
        speeds = smooth_series(raw_speeds, timestamps)
        immobility = immobility_flags(raw_speeds, timestamps)
        from layer_video import capture as open_video
        capture = open_video(video,ffmpeg)
        if not capture.isOpened() or int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)) != width or int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) != height:
            raise ValueError("Vídeo original não corresponde à inferência")
        process = subprocess.Popen([ffmpeg, "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{width}x{height}", "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264", "-crf", "18",
            "-preset", "fast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(temporary)],
            stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        colors = {"cornersPx": (80, 195, 35), "rimCornersPx": (65, 185, 245)}
        skeleton_frames = 0
        inferred_skeleton_frames = 0
        for index in range(expected):
            if progress is not None:
                progress(index, expected)
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError(f"Vídeo terminou no frame {index}")
            for name, color in colors.items():
                points = (arena or {}).get(name)
                if points:
                    import numpy as np
                    cv2.polylines(frame, [np.asarray([[round(p["x"]), round(p["y"])] for p in points], dtype=np.int32)], True, color, 2)
            detection = detections[index]
            if int(detection["frame"]) != index:
                raise ValueError("Detecções fora de ordem")
            stopped = body_overlay and layer_rows[index].get("reason") in ["researcher_intervention", "researcher_intervention_pending"]
            if body_overlay and not stopped:
                visual=(layer_rows[index].get("oftLayers") or {}).get("visualization")
                box=visual.get("box") if visual else tracking_box(layer_rows[index])
                if box:
                    x,y,w,h=(round(box[key]) for key in ("x","y","width","height"))
                    color=(45,185,245) if layer_rows[index].get("boxSource")=="recovered" else (248,189,56)
                    cv2.rectangle(frame,(x,y),(x+w,y+h),color,max(2,round(width/640)))
            elif detection.get("observed", "").lower() == "true" and not stopped:
                x, y, w, h = (round(float(detection[key])) for key in ("x", "y", "w", "h"))
                cv2.rectangle(frame, (x, y), (x+w, y+h), (248, 189, 56), max(2, round(width / 640)))
            score = float(detection["score"]) if detection.get("observed", "").lower() == "true" and not stopped else None
            valid_count = 0
            recovered_count = 0
            skeleton_count = None
            if body_overlay:
                draw_overlay(frame, layer_rows[index], layer_predictions[index])
                axis = layer_rows[index].get("bodyAxis") or {}
                visual=(layer_rows[index].get("oftLayers") or {}).get("visualization")
                skeleton_count = len(visual["points"]) if visual and not stopped else len(axis.get("points") or []) if not stopped and axis.get("state") == "reliable" else 0
                skeleton_frames += skeleton_count == 7
                inferred_skeleton_frames += bool(skeleton_count==7 and visual and visual.get("source")!="observed_geometry")
            # The shared skeleton already draws its seven nodes and estimated
            # endpoints. Do not cover it with a second, incompatible pose.
            for pose in ([] if body_overlay or stopped else poses[index]):
                point = visual_point(pose, width, height)
                if point is None:
                    continue
                x, y, likelihood = point
                color = COLORS[REGIONS.get(pose["keypoint"], "other")]
                radius = max(3, round(width / 320))
                cv2.circle(frame, (round(x), round(y)), radius + 1, (12, 18, 22), -1, cv2.LINE_AA)
                cv2.circle(frame, (round(x), round(y)), radius,
                           (45, 185, 245) if pose.get("source") == "recovered" else color,
                           1 if pose.get("source") == "recovered" else -1, cv2.LINE_AA)
                recovered_count += pose.get("source") == "recovered"
                if pose["status"] == "valid" and likelihood >= METRIC_LIKELIHOOD:
                    valid_count += 1
            if not body_overlay:
                draw_panel(frame, index, timestamps[index], expected, manifest.get("modelBundleId", "Wistar D+F"),
                           poses[index][0].get("animal_id", "animal_1"), valid_count, score,
                           speeds[index], speeds, timestamps, immobility[index], calibrated, point_count, skeleton_count)
            legend_y = height - max(12, round(height * .025))
            if recovered_count:
                cv2.putText(frame, f"Estimativas: {recovered_count} pontos - revisar (circulos vazados)",
                            (12, legend_y-22), cv2.FONT_HERSHEY_SIMPLEX,
                            max(.35, min(width/1800, .55)), (45, 185, 245), 1, cv2.LINE_AA)
            legend_x = 12
            legend = () if body_overlay else (("cabeca", "head"), ("orelhas", "ears"), ("tronco", "trunk"), ("anterior", "front"),
                                 ("posterior", "hind"), ("cauda", "tail"))
            for name, region in legend:
                cv2.circle(frame, (legend_x + 4, legend_y - 4), 4, (255, 231, 107) if region == "axis" else COLORS[region], -1, cv2.LINE_AA)
                cv2.putText(frame, name, (legend_x + 12, legend_y), cv2.FONT_HERSHEY_SIMPLEX,
                            max(.35, min(width / 1800, .55)), (238, 241, 244), 1, cv2.LINE_AA)
                legend_x += max(70, round(width * .095))
            if stopped and not body_overlay:
                cv2.putText(frame, "Tracking interrompido - intervencao na arena", (12, legend_y-22),
                            cv2.FONT_HERSHEY_SIMPLEX, max(.35, min(width/1800, .55)), (100,197,255), 1, cv2.LINE_AA)
            process.stdin.write(frame.tobytes())
        ok, _ = capture.read()
        if ok:
            raise RuntimeError("Vídeo possui frames extras")
        process.stdin.close()
        errors = process.stderr.read()
        process.stderr.close()
        if process.wait() != 0:
            raise RuntimeError(errors.decode(errors="replace")[-1000:])
        process = None
        verification = open_video(temporary,ffmpeg)
        try:
            if not verification.isOpened() or int(verification.get(cv2.CAP_PROP_FRAME_COUNT)) != expected or int(verification.get(cv2.CAP_PROP_FRAME_WIDTH)) != width or int(verification.get(cv2.CAP_PROP_FRAME_HEIGHT)) != height:
                raise RuntimeError("MP4 gerado não corresponde às poses")
        finally:
            verification.release()
        temporary.replace(target)
        report.update(available=True, sizeBytes=target.stat().st_size, sha256=digest(target), frameCount=expected,
                      width=width, height=height, fps=fps, playbackEncoding="h264-yuv420p",
                      visualization={"version": SKELETON_VIDEO_VERSION if body_overlay else "scientific-video-3", "reference": "mouse_center",
                                     "skeletonMethod": "body-axis-2" if body_overlay else None,
                                     "skeletonSource": layer_source, "skeletonFrames": skeleton_frames,
                                     "inferredSkeletonFrames":inferred_skeleton_frames,
                                     "trackingBoxPolicy": TRACKING_BOX_POLICY if body_overlay else None,
                                     "textOverlay":not body_overlay,"headMarker":"hollow_triangle" if body_overlay else None,
                                     "anatomicalPose": False if body_overlay else None,
                                     "recoveryStyle": "hollow_amber_pending_review",
                                     "estimatedPointsMetricEligible": False,
                                     "calibrated": calibrated, "validSpeedPairs": sum(speed is not None for speed in raw_speeds),
                                     "visualLikelihoodMinimum": VISUAL_LIKELIHOOD,
                                     "metricLikelihoodMinimum": METRIC_LIKELIHOOD,
                                     "smoothingSec": SMOOTHING_SEC, "maxPairGapSec": MAX_PAIR_GAP_SEC,
                                     "immobilityThresholdCmS": IMMOBILITY_THRESHOLD_CM_S,
                                     "minImmobilityDurationSec": MIN_IMMOBILITY_SEC})
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"[:1500]
        print("BEHAVETRACKER_LABELED_VIDEO_UNAVAILABLE=" + report["error"], flush=True)
    finally:
        if capture is not None:
            capture.release()
        if process is not None:
            process.kill()
            process.wait()
        temporary.unlink(missing_ok=True)
    # Keep an existing valid desktop artifact and its marker on render failure.
    if report["available"] or not job_id:
        marker = root / f"{prefix}video_artifact.json"
        pending = marker.with_suffix(".partial.json")
        pending.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        pending.replace(marker)
    return report


if __name__ == "__main__":
    video, output_dir, job_id, calibration, ffmpeg = sys.argv[1:]
    result = render(video, output_dir, json.loads(calibration), job_id=job_id, ffmpeg_path=ffmpeg)
    if not result["available"]:
        print(result["error"], file=sys.stderr)
        raise SystemExit(1)
