"""Renderiza o vídeo de inspeção D+F a partir dos CSVs do job."""

import csv
from bisect import bisect_left
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess


SOURCE = "behavetracker-hybrid-df-v2"
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
    try:
        x, y, score = float(row["x_px"]), float(row["y_px"]), float(row["likelihood"])
        if (all(math.isfinite(v) for v in (x, y, score)) and
                0 <= x < width and 0 <= y < height and score >= VISUAL_LIKELIHOOD and
                row["status"] != "missing"):
            return x, y, score
    except (ValueError, TypeError, KeyError):
        pass
    return None


def locomotor_series(poses, timestamps, arena, width, height):
    """Velocidade em cm/s, usando somente pares consecutivos de mouse_center válidos."""
    import cv2
    import numpy as np

    result = [None] * len(timestamps)
    corners = (arena or {}).get("cornersPx")
    width_cm, height_cm = (arena or {}).get("widthCm"), (arena or {}).get("heightCm")
    if not corners or len(corners) != 4 or not width_cm or not height_cm:
        return result
    source = np.float32([[p["x"], p["y"]] for p in corners])
    destination = np.float32([[0, 0], [width_cm, 0], [width_cm, height_cm], [0, height_cm]])
    matrix = cv2.getPerspectiveTransform(source, destination)
    previous = None
    for index, rows in enumerate(poses):
        center = next((row for row in rows if row["keypoint"] == "mouse_center"), None)
        point = visual_point(center, width, height) if center else None
        if not point or center["status"] != "valid" or point[2] < METRIC_LIKELIHOOD:
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


def draw_panel(frame, index, timestamp, total, model, animal, valid_count, score, speed, series, timestamps, immobile):
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
    label(f"POSE >=0.60 {valid_count}/27   {detector_text}", margin + 11, margin + round(71 * scale),
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


def render(video, output_dir, arena):
    import cv2

    root = Path(output_dir)
    report = {"schemaVersion": 1, "available": False, "source": SOURCE,
              "filename": "dlc_labeled.mp4", "error": None}
    temporary = root / "dlc_labeled.partial.mp4"
    target = root / report["filename"]
    process = None
    capture = None
    try:
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            raise RuntimeError("FFmpeg não disponível")
        manifest = json.loads((root / "run_manifest.json").read_text())
        expected = int(manifest["frameCount"])
        width, height, fps = int(manifest["frameWidth"]), int(manifest["frameHeight"]), float(manifest["fps"])
        if expected <= 0 or width <= 0 or height <= 0 or fps <= 0:
            raise ValueError("Metadados de vídeo inválidos")
        with (root / "detections.csv").open(newline="") as handle:
            detections = list(csv.DictReader(handle))
        if len(detections) != expected:
            raise ValueError("Contagem de detecções incompatível")
        poses = {}
        with (root / "canonical_pose.csv").open(newline="") as handle:
            for row in csv.DictReader(handle):
                poses.setdefault(int(row["frame_index"]), []).append(row)
        if len(poses) != expected or any(len(poses.get(i, [])) != 27 for i in range(expected)):
            raise ValueError("Contagem de poses incompatível")
        if set(manifest.get("keypoints", [])) != {row["keypoint"] for row in poses[0]}:
            raise ValueError("Keypoints do manifesto não correspondem às poses")
        timestamps = [float(poses[index][0]["timestamp_sec"]) for index in range(expected)]
        if any(not math.isfinite(value) or (index and value <= timestamps[index - 1])
               for index, value in enumerate(timestamps)):
            raise ValueError("Timestamps de poses inválidos")
        pose_rows = [poses[index] for index in range(expected)]
        raw_speeds = locomotor_series(pose_rows, timestamps, arena, width, height)
        speeds = smooth_series(raw_speeds, timestamps)
        immobility = immobility_flags(raw_speeds, timestamps)
        capture = cv2.VideoCapture(str(video))
        if not capture.isOpened() or int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)) != width or int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) != height:
            raise ValueError("Vídeo original não corresponde à inferência")
        process = subprocess.Popen([ffmpeg, "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{width}x{height}", "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264", "-crf", "18",
            "-preset", "fast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(temporary)],
            stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        colors = {"cornersPx": (80, 195, 35), "rimCornersPx": (65, 185, 245)}
        for index in range(expected):
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
            if detection.get("observed", "").lower() == "true":
                x, y, w, h = (round(float(detection[key])) for key in ("x", "y", "w", "h"))
                cv2.rectangle(frame, (x, y), (x+w, y+h), (248, 189, 56), max(2, round(width / 640)))
            score = float(detection["score"]) if detection.get("observed", "").lower() == "true" else None
            valid_count = 0
            for pose in poses[index]:
                point = visual_point(pose, width, height)
                if point is None:
                    continue
                x, y, likelihood = point
                color = COLORS[REGIONS.get(pose["keypoint"], "other")]
                radius = max(3, round(width / 320))
                cv2.circle(frame, (round(x), round(y)), radius + 1, (12, 18, 22), -1, cv2.LINE_AA)
                cv2.circle(frame, (round(x), round(y)), radius, color, -1, cv2.LINE_AA)
                if pose["status"] == "valid" and likelihood >= METRIC_LIKELIHOOD:
                    valid_count += 1
            draw_panel(frame, index, timestamps[index], expected, manifest.get("modelBundleId", "Wistar D+F"),
                       poses[index][0].get("animal_id", "animal_1"), valid_count, score,
                       speeds[index], speeds, timestamps, immobility[index])
            legend_y = height - max(12, round(height * .025))
            legend_x = 12
            for name, region in (("cabeca", "head"), ("orelhas", "ears"), ("tronco", "trunk"), ("anterior", "front"),
                                 ("posterior", "hind"), ("cauda", "tail")):
                cv2.circle(frame, (legend_x + 4, legend_y - 4), 4, COLORS[region], -1, cv2.LINE_AA)
                cv2.putText(frame, name, (legend_x + 12, legend_y), cv2.FONT_HERSHEY_SIMPLEX,
                            max(.35, min(width / 1800, .55)), (238, 241, 244), 1, cv2.LINE_AA)
                legend_x += max(70, round(width * .095))
            process.stdin.write(frame.tobytes())
        ok, _ = capture.read()
        if ok:
            raise RuntimeError("Vídeo possui frames extras")
        process.stdin.close()
        errors = process.stderr.read()
        if process.wait() != 0:
            raise RuntimeError(errors.decode(errors="replace")[-1000:])
        process = None
        verification = cv2.VideoCapture(str(temporary))
        try:
            if not verification.isOpened() or int(verification.get(cv2.CAP_PROP_FRAME_COUNT)) != expected or int(verification.get(cv2.CAP_PROP_FRAME_WIDTH)) != width or int(verification.get(cv2.CAP_PROP_FRAME_HEIGHT)) != height:
                raise RuntimeError("MP4 gerado não corresponde às poses")
        finally:
            verification.release()
        temporary.replace(target)
        report.update(available=True, sizeBytes=target.stat().st_size, sha256=digest(target), frameCount=expected,
                      width=width, height=height, fps=fps, playbackEncoding="h264-yuv420p",
                      visualization={"version": "scientific-video-1", "reference": "mouse_center",
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
    (root / "video_artifact.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    return report
