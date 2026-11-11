"""Renderiza o vídeo de inspeção D+F a partir dos CSVs do job."""

import csv
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


SOURCE = "behavetracker-hybrid-df-v2"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


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
                cv2.rectangle(frame, (x, y), (x+w, y+h), (0, 220, 255), 2)
                cv2.putText(frame, f"bbox {float(detection['score']):.2f}", (max(x, 0), max(y-8, 20)),
                            cv2.FONT_HERSHEY_SIMPLEX, .6, (0, 220, 255), 2)
            valid_count = 0
            for pose in poses[index]:
                if pose["status"] != "valid" or not pose["x_px"] or not pose["y_px"]:
                    continue
                x, y = round(float(pose["x_px"])), round(float(pose["y_px"]))
                cv2.circle(frame, (x, y), 3, (0, 255, 0), -1)
                valid_count += 1
            cv2.putText(frame, f"{index} | {valid_count}/27", (12, 28), cv2.FONT_HERSHEY_SIMPLEX, .7, (255, 255, 255), 2)
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
                      width=width, height=height, fps=fps, playbackEncoding="h264-yuv420p")
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
