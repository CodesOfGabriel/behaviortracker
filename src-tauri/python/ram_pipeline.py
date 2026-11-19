"""Experimental RAM tracking. No arm visit or reward inference is made here."""

import importlib.util
import json
import math
from pathlib import Path


def select_ram_detection(detections, width, height, polygon, previous_box=None,
                         threshold=.30, margin=.12, **_unused):
    import cv2
    import numpy as np

    region = np.asarray(polygon, dtype=np.float32)
    accepted = []
    rejected = {"below_threshold": 0, "outside_walkable": 0, "invalid": 0}
    highest = 0.0
    for item in detections:
        try:
            score = float(item["score"])
            x1, y1, x2, y2 = (float(item[key]) for key in ("x1", "y1", "x2", "y2"))
        except (KeyError, TypeError, ValueError):
            rejected["invalid"] += 1
            continue
        if not all(math.isfinite(v) for v in (score, x1, y1, x2, y2)) or x2 <= x1 or y2 <= y1:
            rejected["invalid"] += 1
            continue
        highest = max(highest, score)
        if score < threshold:
            rejected["below_threshold"] += 1
            continue
        center = ((x1 + x2) / 2, (y1 + y2) / 2)
        if cv2.pointPolygonTest(region, center, False) < 0:
            rejected["outside_walkable"] += 1
            continue
        continuity = 0.0
        if previous_box is not None:
            old = ((previous_box[0] + previous_box[2]) / 2,
                   (previous_box[1] + previous_box[3]) / 2)
            continuity = math.exp(-math.hypot(center[0] - old[0], center[1] - old[1])
                                  / max(math.hypot(width, height) * .12, 1.0))
        accepted.append((score + .25 * continuity, score, x1, y1, x2, y2))
    audit = {"rawCandidates": len(detections), "highestRawScore": highest, "rejected": rejected}
    if not accepted:
        return {"observed": False, "score": None, "bboxRaw": None, "bboxPose": None,
                "audit": audit, "qualityFlags": ["detector_missing_or_outside_walkable"]}
    rank, score, x1, y1, x2, y2 = max(accepted)
    pad_x, pad_y = (x2 - x1) * margin, (y2 - y1) * margin
    px1, py1 = max(0.0, x1 - pad_x), max(0.0, y1 - pad_y)
    px2, py2 = min(float(width), x2 + pad_x), min(float(height), y2 + pad_y)
    return {"observed": True, "score": score,
            "bboxRaw": {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1},
            "bboxPose": {"x": px1, "y": py1, "width": px2 - px1, "height": py2 - py1},
            "selectionRank": rank, "roiOverlap": 0.0, "floorOverlap": 0.0,
            "anchorOnFloor": False, "audit": audit, "qualityFlags": []}


def run(video_path, output_path, config):
    import cv2
    import numpy as np
    import torch

    output = Path(output_path)
    output.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("ram_hybrid", output / "hybrid_pipeline.py")
    hybrid = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hybrid)
    if not torch.cuda.is_available():
        raise RuntimeError("O tracking RAM requer uma GPU CUDA no Colab")
    for name, expected in (("best_detector.pth", hybrid.EXPECTED_DETECTOR_SHA256),
                           ("snapshot-hrnet_w32-001.pt", hybrid.EXPECTED_POSE_SHA256),
                           ("pytorch_config.yaml", hybrid.EXPECTED_CONFIG_SHA256)):
        if hybrid.sha256(hybrid.MODELS / name) != expected:
            raise RuntimeError(f"Integridade do modelo RAM inválida: {name}")
    capture = cv2.VideoCapture(video_path)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    if width != config["video"]["width"] or height != config["video"]["height"]:
        raise RuntimeError("A geometria RAM não corresponde à resolução do vídeo")
    points = hybrid.polygon(config["geometry"]["walkablePolygonPx"], width, height, "labirinto")
    if cv2.contourArea(points) <= 0:
        raise RuntimeError("Área do labirinto radial vazia")
    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(mask, [points], 255)
    hybrid.select_detection = lambda detections, w, h, **kwargs: select_ram_detection(
        detections, w, h, points, **kwargs)
    hybrid.phase("RAM · detector Wistar na área delimitada")
    detections, contexts, count, fps, _, _ = hybrid.run_detector(video_path, mask)
    hybrid.phase("RAM · HRNet e verificação por frame")
    poses = hybrid.pose_dataframe(video_path, contexts, count)
    if "mouse_center" not in hybrid.KEYPOINTS:
        raise RuntimeError("O bundle não contém mouse_center")
    xs = hybrid.column(poses, "mouse_center", "x")
    ys = hybrid.column(poses, "mouse_center", "y")
    likelihoods = hybrid.column(poses, "mouse_center", "likelihood")
    frames = []
    observed = 0
    for frame, detection in enumerate(detections):
        x, y, likelihood = float(xs[frame]), float(ys[frame]), float(likelihoods[frame])
        valid = (detection["observed"] and all(math.isfinite(v) for v in (x, y, likelihood))
                 and likelihood >= hybrid.FC_THRESHOLD and 0 <= x < width and 0 <= y < height
                 and mask[int(y), int(x)] > 0)
        flags = [] if valid else (["sem_bbox"] if not detection["observed"] else
                ["centro_nao_confiavel"] if not math.isfinite(likelihood) or likelihood < hybrid.FC_THRESHOLD else
                ["fora_da_area_analisavel"])
        observed += int(valid)
        frames.append({"frame": frame, "timestampSec": frame / fps,
                       "mouseCenter": {"x": x, "y": y} if valid else None,
                       "likelihood": likelihood if math.isfinite(likelihood) else None,
                       "qualityFlags": flags})
    if hybrid.sha256(video_path) != config["video"]["sha256"]:
        raise RuntimeError("O vídeo foi alterado durante o tracking")
    manifest = {"schemaVersion": "ram-tracking-1", "protocol": "radial_arm_maze",
                "engineId": "wistar_ram_hybrid_v1", "analysisStatus": "EXPERIMENTAL_NOT_FOR_METRICS",
                "jobId": config["jobId"], "modelBundleId": config["modelBundleId"],
                "detectorSha256": hybrid.sha256(hybrid.MODELS / "best_detector.pth"),
                "poseCheckpointSha256": hybrid.sha256(hybrid.MODELS / "snapshot-hrnet_w32-001.pt"),
                "geometry": config["geometry"], "video": config["video"],
                "frameCount": count, "fps": fps, "observedFrames": observed,
                "poseLikelihoodThreshold": hybrid.FC_THRESHOLD,
                "artifacts": ["result.json", "detections.csv", "pose_raw.csv", "pose_raw.h5", "qc_by_frame.csv", "run_manifest.json"]}
    result = {**manifest, "frames": frames, "behaviorMetrics": None}
    (output / "qc_by_frame.csv").write_text("frame_index,timestamp_sec,quality_flags\n" + "".join(
        f'{row["frame"]},{row["timestampSec"]},{";".join(row["qualityFlags"])}\n' for row in frames), encoding="utf-8")
    (output / "run_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (output / "result.json").write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
    hybrid.phase("RAM · tracking experimental concluído")
