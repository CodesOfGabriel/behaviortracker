"""Diagnóstico curto: detector e pose separados, sem recuperação/adaptação/treino.

Caixas e coordenadas vêm dos runners do DLC. Cobertura não é acurácia.
Importações de ML só acontecem no runtime Colab.
"""
import csv
import json
import math
from pathlib import Path
import time

VERSION = "tracking-diagnostic-1"
BATCH_SIZE = 2


def frame_evidence(index, fps, names, points, bbox, bbox_score, geometry, arena_api):
    restored = {name: arena_api["restore_point"](*point, geometry) for name, point in zip(names, points)}
    torso = [point for name, point in restored.items()
             if any(token in name for token in ("spine", "body", "center", "centre", "shoulder", "hip", "back"))
             and not any(token in name for token in ("tail", "paw", "ear", "nose", "snout"))]
    center = arena_api["torso_center"](torso)
    visible = sum(point[3] != "missing" for point in restored.values())
    strong = sum(point[3] == "valid" for point in restored.values())
    raw_available = sum(all(math.isfinite(float(value)) for value in point) and float(point[0]) >= 0
                        and float(point[1]) >= 0 and .1 <= float(point[2]) <= 1 for point in points)
    if bbox is None:
        state = "detector_missing"
    elif not visible and raw_available:
        state = "adapter_rejected"
    elif not visible:
        state = "pose_missing"
    elif center[3] == "missing":
        state = "center_missing"
    elif strong < len(names) or center[3] != "valid":
        state = "partial"
    else:
        state = "points_available"
    crop = geometry["cropping"] or [0, geometry["videoWidth"], 0, geometry["videoHeight"]]
    box = None if bbox is None else {"x": float(bbox[0]) + crop[0], "y": float(bbox[1]) + crop[2],
                                    "width": float(bbox[2]), "height": float(bbox[3]), "score": float(bbox_score)}
    evidence = {"frameIndex": index, "timestampSec": index / fps, "state": state, "bbox": box,
                "availablePoints": visible, "strongPoints": strong, "totalPoints": len(names),
                "rawAvailablePoints": int(raw_available), "adapterRejectedPoints": int(raw_available - visible),
                "canonicalCenterAvailable": center[3] != "missing", "canonicalCenterStatus": center[3]}
    return evidence, restored


def summary(frames):
    counts = {state: sum(frame["state"] == state for frame in frames) for state in
              ("detector_missing", "pose_missing", "adapter_rejected", "center_missing", "partial", "points_available")}
    return {"frameCount": len(frames), "states": counts,
            "detectorCoveragePct": 100 * sum(frame["bbox"] is not None for frame in frames) / len(frames) if frames else 0,
            "centerCoveragePct": 100 * sum(frame["canonicalCenterAvailable"] for frame in frames) / len(frames) if frames else 0,
            "accuracyMeasured": False}


def run_diagnostic(video_path, output_dir, canonical_path, arena, arena_api, selection):
    import cv2
    import numpy as np
    import torch
    from deeplabcut.pose_estimation_pytorch.config.pose import PoseConfig
    from deeplabcut.pose_estimation_pytorch.apis.utils import get_inference_runners
    from deeplabcut.pose_estimation_pytorch.modelzoo.utils import get_super_animal_snapshot_path

    root = Path(output_dir)
    root.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    timings = {key: 0.0 for key in ("modelLoadSec", "decodeSec", "detectorSec", "poseSec", "exportSec")}
    device = "cuda:0" if torch.cuda.is_available() else "cpu"

    def sync():
        if device.startswith("cuda"):
            torch.cuda.synchronize()

    model_started = time.perf_counter()
    builder = getattr(PoseConfig, "build_for_superanimal_inference", None)
    if builder:
        config = builder(super_animal="superanimal_topviewmouse", model_name="hrnet_w32", detector_name="fasterrcnn_resnet50_fpn_v2", max_individuals=1, device=device)
    else:
        from deeplabcut.pose_estimation_pytorch.modelzoo.utils import load_super_animal_config
        config = load_super_animal_config("superanimal_topviewmouse", "hrnet_w32", "fasterrcnn_resnet50_fpn_v2", max_individuals=1, device=device)
    names = [str(name).lower().replace("-", "_").replace(" ", "_") for name in config["metadata"]["bodyparts"]]
    pose_runner, detector_runner = get_inference_runners(config,
        snapshot_path=get_super_animal_snapshot_path("superanimal_topviewmouse", "hrnet_w32"),
        detector_path=get_super_animal_snapshot_path("superanimal_topviewmouse", "fasterrcnn_resnet50_fpn_v2"),
        max_individuals=1, num_bodyparts=len(names), num_unique_bodyparts=0,
        batch_size=BATCH_SIZE, detector_batch_size=BATCH_SIZE, device=device)
    if detector_runner is None:
        raise RuntimeError("O diagnóstico requer saída explícita do detector; API instalada incompatível")
    sync()
    timings["modelLoadSec"] = time.perf_counter() - model_started
    capture = cv2.VideoCapture(video_path)
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if not math.isfinite(fps) or fps <= 0 or fps > 240:
        capture.release()
        raise RuntimeError("FPS inválido ou acima do limite diagnóstico")
    geometry = arena_api["prepare_geometry"](arena, width, height)
    crop = geometry["cropping"]
    frames, raw_rows = [], []
    raw_predictions = []
    print("BEHAVETRACKER_DIAGNOSTIC=Detector e pose em lotes; recuperação desativada", flush=True)
    try:
        while True:
            decode_started = time.perf_counter()
            images = []
            for _ in range(BATCH_SIZE):
                ok, image = capture.read()
                if not ok:
                    break
                if crop:
                    image = image[crop[2]:crop[3], crop[0]:crop[1]]
                images.append(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
            timings["decodeSec"] += time.perf_counter() - decode_started
            if not images:
                break
            if len(frames) + len(images) > math.ceil(60 * fps) + 1:
                raise RuntimeError("Arquivo excede 60 segundos; diagnóstico interrompido sem analisar o vídeo completo")
            sync()
            phase = time.perf_counter()
            detections = list(detector_runner.inference(images=images))
            sync()
            timings["detectorSec"] += time.perf_counter() - phase
            if len(detections) != len(images):
                raise RuntimeError("Detector retornou quantidade de frames incompatível")
            boxes, scores, pose_inputs, pose_indices = [], [], [], []
            for offset, (image, detection) in enumerate(zip(images, detections)):
                boxes_raw, scores_raw = detection.get("bboxes"), detection.get("bbox_scores")
                if boxes_raw is None or scores_raw is None:
                    raise RuntimeError("API do detector não expôs caixas e scores; não é seguro atribuir falhas")
                candidates = [(box, score) for box, score in zip(boxes_raw, scores_raw)
                    if len(box) == 4 and all(math.isfinite(float(v)) for v in box)
                    and float(box[0]) >= 0 and float(box[1]) >= 0 and float(box[2]) > 0 and float(box[3]) > 0
                    and math.isfinite(float(score)) and 0 < float(score) <= 1]
                if not candidates:
                    boxes.append(None); scores.append(0.0); continue
                box, score = max(candidates, key=lambda value: float(value[1]))
                boxes.append(box); scores.append(float(score))
                pose_inputs.append((image, {"bboxes": np.array([box], dtype=float), "bbox_scores": np.array([score], dtype=float)}))
                pose_indices.append(offset)
            sync()
            phase = time.perf_counter()
            poses = list(pose_runner.inference(images=pose_inputs)) if pose_inputs else []
            sync()
            timings["poseSec"] += time.perf_counter() - phase
            if len(poses) != len(pose_inputs):
                raise RuntimeError("Pose retornou quantidade de frames incompatível")
            lookup = dict(zip(pose_indices, poses))
            for offset in range(len(images)):
                points = lookup[offset]["bodyparts"] if offset in lookup else np.full((1, len(names), 3), -1.0)
                if points.shape != (1, len(names), 3):
                    raise RuntimeError("Formato dos pontos incompatível com o diagnóstico")
                index = len(frames)
                data, restored = frame_evidence(index, fps, names, points[0], boxes[offset], scores[offset], geometry, arena_api)
                frames.append(data)
                raw_predictions.append({"bodyparts": points.tolist(), "bboxes": [] if boxes[offset] is None else [list(map(float, boxes[offset]))], "bbox_scores": [scores[offset]]})
                for name, raw_point in zip(names, points[0]):
                    x, y, score, status = restored[name]
                    raw_rows.append([index, index / fps, "animal_1", name, x, y, score, status,
                                     arena_api["spatial_region"](x, y, geometry), "detected", *map(float, raw_point)])
            print(f"BEHAVETRACKER_DIAGNOSTIC_PROGRESS={len(frames)} frames · detector {timings['detectorSec']:.2f}s · pose {timings['poseSec']:.2f}s", flush=True)
    finally:
        capture.release()
    if not frames:
        raise RuntimeError("Trecho diagnóstico sem frames decodificáveis")
    phase = time.perf_counter()
    with open(canonical_path, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["frame_index", "timestamp_sec", "animal_id", "keypoint", "x_px", "y_px", "likelihood", "status", "spatial_region", "source", "raw_crop_x_px", "raw_crop_y_px", "raw_model_likelihood"])
        writer.writerows(raw_rows)
    (root / "diagnostic_predictions.json").write_text(json.dumps(raw_predictions), encoding="utf-8")
    timings["exportSec"] = time.perf_counter() - phase
    timings["totalSec"] = time.perf_counter() - started
    report = {"schemaVersion": 1, "version": VERSION, "selection": selection, "geometry": geometry,
              "fps": fps, "durationSec": len(frames) / fps, "timestampBasis": "clip_frame_index_divided_by_fps",
              "sourceTimestampExact": False, "batchSize": BATCH_SIZE, "recoveryEnabled": False,
              "rawCoordinateSpace": "roi_pixels", "exportedCoordinateSpace": "original_video_pixels",
              "videoAdaptEnabled": False, "timings": timings, "summary": summary(frames), "frames": frames,
              "model": {"pose": "hrnet_w32", "detector": "fasterrcnn_resnet50_fpn_v2", "dataset": "superanimal_topviewmouse"},
              "warning": "Caixas pós-filtro do detector e pontos do modelo; cobertura não mede acurácia. PTS/VFR exatos da origem não são usados neste relatório."}
    (root / "diagnostic_report.json").write_text(json.dumps(report, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    Path(canonical_path + ".complete").write_text("ok", encoding="utf-8")
    print("BEHAVETRACKER_DIAGNOSTIC_DONE=" + json.dumps(report["summary"]), flush=True)
