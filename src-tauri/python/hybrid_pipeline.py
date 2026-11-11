"""Pipeline D+F portado do notebook M, com artefatos compatíveis com o app."""

import csv
import hashlib
import json
import math
import time
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
import torch
from torchvision.models.detection import fasterrcnn_resnet50_fpn_v2
from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
from torchvision.transforms.functional import to_tensor

import deeplabcut.pose_estimation_pytorch as pep
from deeplabcut.pose_estimation_pytorch.apis.videos import create_df_from_prediction
from deeplabcut.pose_estimation_pytorch.config import PoseConfig
from hybrid.detector_wistar import select_detection


VIDEO = __VIDEO__
OUTPUT = Path(__OUTPUT__)
CSV_PATH = __CSV__
MODELS = Path(__MODELS__)
MODEL_BUNDLE_ID = __MODEL_BUNDLE_ID__
EXPECTED_DETECTOR_SHA256 = __DETECTOR_SHA256__
EXPECTED_POSE_SHA256 = __POSE_SHA256__
EXPECTED_CONFIG_SHA256 = __CONFIG_SHA256__
ARENA = __ARENA__ or {}
DEVICE = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
KEYPOINTS = []
DETECTOR_THRESHOLD = .30
BBOX_MARGIN = .12
FC_THRESHOLD = .60
LAST_DETECTOR_BATCH_SIZE = 1
M4_MIN_ROI_OVERLAP = .22


def gpu_name():
    if DEVICE.type != "cuda":
        return "cpu"
    return torch.cuda.get_device_name(DEVICE.index or 0)


def detector_batch_size():
    if DEVICE.type != "cuda":
        return 1
    memory_gb = torch.cuda.get_device_properties(DEVICE).total_memory / (1024 ** 3)
    if memory_gb >= 35:
        return 16
    if memory_gb >= 20:
        return 8
    if memory_gb >= 14:
        return 4
    return 2


def phase(message):
    print(f"BEHAVETRACKER_HYBRID_PHASE={message}", flush=True)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def polygon(points, width, height, name):
    if not isinstance(points, list) or len(points) < 3:
        raise ValueError(f"{name} precisa de ao menos três vértices")
    result = []
    for point in points:
        x, y = float(point["x"]), float(point["y"])
        if not math.isfinite(x) or not math.isfinite(y) or not 0 <= x <= width or not 0 <= y <= height:
            raise ValueError(f"{name} possui vértice fora do vídeo")
        result.append([round(x), round(y)])
    return np.asarray(result, dtype=np.int32)


def arena_mask(width, height, arena):
    mask = np.full((height, width), 255, dtype=np.uint8)
    regions = []
    if arena.get("cornersPx"):
        regions.append(polygon(arena["cornersPx"], width, height, "piso"))
    if MODEL_BUNDLE_ID == "wistar_df_v1" and arena.get("rimCornersPx"):
        regions.append(polygon(arena["rimCornersPx"], width, height, "borda"))
    if regions:
        mask.fill(0)
        for region in regions:
            cv2.fillPoly(mask, [region], 255)
    for index, points in enumerate(arena.get("occlusionPolygonsPx", [])):
        cv2.fillPoly(mask, [polygon(points, width, height, f"oclusão {index + 1}")], 0)
    return mask


def selection_polygons(width, height, arena):
    rim = arena.get("rimCornersPx") or arena.get("cornersPx")
    floor = arena.get("cornersPx")
    if not rim or not floor:
        return None, None, None
    roi = polygon(rim, width, height, "borda")
    floor_poly = polygon(floor, width, height, "piso")
    return roi, floor_poly, max(float(cv2.contourArea(roi)), 1.0)


def detector():
    checkpoint = torch.load(MODELS / "best_detector.pth", map_location="cpu", weights_only=True)
    if checkpoint.get("num_classes") != 2 or "state_dict" not in checkpoint:
        raise RuntimeError("Checkpoint do detector incompatível")
    model = fasterrcnn_resnet50_fpn_v2(weights=None, weights_backbone=None, min_size=640, max_size=1280)
    features = model.roi_heads.box_predictor.cls_score.in_features
    model.roi_heads.box_predictor = FastRCNNPredictor(features, 2)
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    return model.to(DEVICE).eval()


def run_detector(video, mask):
    capture = cv2.VideoCapture(video)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if width <= 0 or height <= 0 or not fps > 0:
        raise RuntimeError("Vídeo sem resolução ou FPS válidos")
    phase(f"Detector Wistar · GPU {gpu_name()} · carregando modelo")
    model = detector()
    rows, contexts = [], []
    roi_poly, floor_poly, roi_area = selection_polygons(width, height, ARENA)
    previous_box = None
    previous_frame = -1
    started = time.monotonic()
    batch_size = detector_batch_size()
    global LAST_DETECTOR_BATCH_SIZE
    LAST_DETECTOR_BATCH_SIZE = batch_size
    successful_batches = 0
    phase(f"Detector Wistar · lote inicial {batch_size} · GPU {gpu_name()}")
    print(f"BEHAVETRACKER_DETECTOR_PROGRESS=0/{total or '?'}", flush=True)

    def append_prediction(prediction):
        nonlocal previous_box, previous_frame
        candidates = [
            (float(score), box.detach().cpu().numpy(), int(label))
            for score, label, box in zip(prediction["scores"], prediction["labels"], prediction["boxes"])
            if int(label) == 1
        ]
        frame_index = len(rows)
        selected = select_detection(
            [{"score": score, "x1": box[0], "y1": box[1], "x2": box[2], "y2": box[3]}
             for score, box, _ in candidates],
            width, height, threshold=DETECTOR_THRESHOLD, margin=BBOX_MARGIN,
            roi_polygon=roi_poly if MODEL_BUNDLE_ID == "wistar_df_v2" else None,
            floor_polygon=floor_poly if MODEL_BUNDLE_ID == "wistar_df_v2" else None,
            previous_box=previous_box if MODEL_BUNDLE_ID == "wistar_df_v2" else None,
            frame_gap=max(1, frame_index - previous_frame) if previous_box is not None else 1,
            roi_area=roi_area, roi_overlap_min=M4_MIN_ROI_OVERLAP,
        )
        audit = selected["audit"]
        if not selected["observed"]:
            rows.append({"frame": len(rows), "x": "", "y": "", "w": "", "h": "",
                         "score": selected["score"] or 0.0, "observed": False,
                         "selection_rank": "", "roi_overlap": "", "floor_overlap": "",
                         "anchor_on_floor": False, "candidate_audit": json.dumps(audit)})
            contexts.append({"bboxes": np.empty((0, 4), np.float32)})
            return
        raw = selected["bboxRaw"]
        pose_box = selected["bboxPose"]
        px, py = pose_box["x"], pose_box["y"]
        qx, qy = px + pose_box["width"], py + pose_box["height"]
        w, h = pose_box["width"], pose_box["height"]
        previous_box = (px, py, qx, qy)
        previous_frame = frame_index
        rows.append({"frame": len(rows), "x": px, "y": py, "w": w, "h": h,
                     "score": selected["score"], "observed": True,
                     "raw_x1": raw["x"], "raw_y1": raw["y"],
                     "raw_x2": raw["x"] + raw["width"], "raw_y2": raw["y"] + raw["height"],
                     "selection_rank": selected["selectionRank"],
                     "roi_overlap": selected["roiOverlap"],
                     "floor_overlap": selected["floorOverlap"],
                     "anchor_on_floor": selected["anchorOnFloor"],
                     "candidate_audit": json.dumps(audit)})
        contexts.append({"bboxes": np.asarray([[px, py, w, h]], dtype=np.float32)})

    with torch.inference_mode():
        while True:
            batch = []
            for _ in range(batch_size):
                ok, frame = capture.read()
                if not ok:
                    break
                masked = cv2.bitwise_and(frame, frame, mask=mask)
                batch.append(to_tensor(cv2.cvtColor(masked, cv2.COLOR_BGR2RGB)).to(DEVICE))
            if not batch:
                break
            print(
                f"BEHAVETRACKER_DETECTOR_PROGRESS={len(rows)}/{total or '?'} "
                f"processando lote de {len(batch)}",
                flush=True,
            )
            batch_start = time.monotonic()
            try:
                predictions = model(batch)
            except RuntimeError as error:
                if DEVICE.type != "cuda" or "out of memory" not in str(error).lower() or batch_size <= 1:
                    raise
                capture.set(cv2.CAP_PROP_POS_FRAMES, len(rows))
                batch_size = max(1, batch_size // 2)
                torch.cuda.empty_cache()
                phase(f"Detector Wistar · memória insuficiente; reduzindo lote para {batch_size}")
                continue
            successful_batches += 1
            LAST_DETECTOR_BATCH_SIZE = max(LAST_DETECTOR_BATCH_SIZE, batch_size)
            if DEVICE.type == "cuda":
                torch.cuda.synchronize()
            elapsed_batch = max(time.monotonic() - batch_start, 1e-6)
            batch_fps = len(predictions) / elapsed_batch
            if successful_batches >= 3 and batch_size < 16 and batch_fps > 0:
                batch_size = min(16, batch_size * 2)
                phase(f"Detector Wistar · lote ajustado para {batch_size} · {batch_fps:.2f} frames/s")
            for prediction in predictions:
                append_prediction(prediction)
                processed = len(rows)
                if processed == 1 or processed % max(batch_size * 2, 1) == 0:
                    elapsed = max(time.monotonic() - started, 1e-6)
                    print(
                        f"BEHAVETRACKER_DETECTOR_PROGRESS={processed}/{total or '?'} "
                        f"({processed / elapsed:.2f} frames/s)",
                        flush=True,
                    )
    capture.release()
    if not rows:
        raise RuntimeError("Vídeo sem frames")
    pd.DataFrame(rows).to_csv(OUTPUT / "detections.csv", index=False)
    print(f"BEHAVETRACKER_DETECTOR_PROGRESS={len(rows)}/{total or len(rows)} concluído", flush=True)
    return rows, contexts, len(rows), fps, width, height


def pose_dataframe(video, contexts, count):
    config = PoseConfig.from_any(str(MODELS / "pytorch_config.yaml"))
    global KEYPOINTS
    KEYPOINTS = list(config["metadata"]["bodyparts"])
    if len(KEYPOINTS) != 27:
        raise RuntimeError(f"Esperados 27 keypoints; configuração declarou {len(KEYPOINTS)}")
    runner = pep.get_pose_inference_runner(
        model_config=config, snapshot_path=str(MODELS / "snapshot-hrnet_w32-001.pt"),
        max_individuals=1, device="cuda:0", batch_size=2,
    )
    iterator = pep.VideoIterator(str(video))
    iterator.set_context(contexts)
    predictions = pep.video_inference(
        video=iterator, pose_runner=runner, detector_runner=None, robust_nframes=True,
    )
    if len(predictions) != count:
        raise RuntimeError(f"DeepLabCut retornou {len(predictions)}/{count} frames; alinhamento temporal não pode ser confirmado")
    frame_df = create_df_from_prediction(
        predictions=predictions, dlc_scorer="wistar_extdet_hrnet_adaptada",
        multi_animal=True, model_cfg=config, output_path=OUTPUT,
        output_prefix="pose_raw", save_as_csv=True,
    )
    raw_csv = OUTPUT / "pose_raw.csv"
    if not (OUTPUT / "pose_raw.h5").is_file():
        raise RuntimeError("DeepLabCut não gerou o H5 bruto esperado")
    if not raw_csv.is_file():
        frame_df.to_csv(raw_csv)
    return frame_df


def column(frame_df, bodypart, coordinate):
    matches = [item for item in frame_df.columns if len(item) >= 2 and item[-2] == bodypart and item[-1] == coordinate]
    if len(matches) != 1:
        raise RuntimeError(f"Coluna {bodypart}/{coordinate} ambígua ou ausente")
    return frame_df[matches[0]].to_numpy(dtype=float)


def filtered(values):
    result = []
    half = 2
    for index, sample in enumerate(values):
        x, y, likelihood = sample
        if not all(math.isfinite(value) for value in (x, y, likelihood)) or likelihood < FC_THRESHOLD:
            result.append((None, None, likelihood))
            continue
        window = [
            item for item in values[max(0, index - half):min(len(values), index + half + 1)]
            if all(math.isfinite(value) for value in item) and item[2] >= FC_THRESHOLD
        ]
        if len(window) < 3:
            result.append((None, None, likelihood))
        else:
            result.append((float(np.median([item[0] for item in window])),
                           float(np.median([item[1] for item in window])), likelihood))
    return result


def export_canonical(frame_df, detections, fps, width, height):
    rows = []
    for frame in range(len(detections)):
        detection = detections[frame]
        bbox = (detection["x"], detection["y"], detection["w"], detection["h"]) if detection["observed"] else ("", "", "", "")
        for bodypart in KEYPOINTS:
            x, y, likelihood = column(frame_df, bodypart, "x")[frame], column(frame_df, bodypart, "y")[frame], column(frame_df, bodypart, "likelihood")[frame]
            valid = detection["observed"] and all(math.isfinite(value) for value in (x, y, likelihood)) and x >= 0 and y >= 0
            status = "valid" if valid and likelihood >= FC_THRESHOLD else "low_confidence" if valid else "missing"
            rows.append([frame, frame / fps, "animal_1", bodypart, x if valid else "", y if valid else "",
                         max(0., min(1., likelihood)) if math.isfinite(likelihood) else 0., status,
                         "unknown", bbox[0], bbox[1], bbox[2], bbox[3], "detected"])
    header = ["frame_index", "timestamp_sec", "animal_id", "keypoint", "x_px", "y_px", "likelihood",
              "status", "spatial_region", "bbox_x", "bbox_y", "bbox_width", "bbox_height", "source"]
    canonical_path = OUTPUT / "canonical_pose.csv"
    with canonical_path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    if Path(CSV_PATH) != canonical_path:
        Path(CSV_PATH).write_bytes(canonical_path.read_bytes())


def export_quality_and_filtered(frame_df, detections, fps):
    filtered_rows = []
    quality_rows = []
    for bodypart in KEYPOINTS:
        values = list(zip(column(frame_df, bodypart, "x"),
                          column(frame_df, bodypart, "y"),
                          column(frame_df, bodypart, "likelihood")))
        smoothed = filtered(values)
        for frame, (raw, final) in enumerate(zip(values, smoothed)):
            rx, ry, likelihood = raw
            fx, fy, _ = final
            filtered_rows.append({
                "frame_index": frame, "keypoint": bodypart,
                "raw_x_px": rx if math.isfinite(rx) else "",
                "raw_y_px": ry if math.isfinite(ry) else "",
                "likelihood": likelihood if math.isfinite(likelihood) else 0.,
                "filtered_x_px": "" if fx is None else fx,
                "filtered_y_px": "" if fy is None else fy,
                "filtered_status": "valid" if fx is not None else "missing",
            })
    reference = "mouse_center" if "mouse_center" in KEYPOINTS else None
    for frame, detection in enumerate(detections):
        flags = []
        if not detection["observed"]:
            flags.append("sem_bbox")
        if reference is None:
            flags.append("centro_nao_confiavel")
        else:
            likelihood = column(frame_df, reference, "likelihood")[frame]
            if not math.isfinite(likelihood) or likelihood < FC_THRESHOLD:
                flags.append("centro_nao_confiavel")
        quality_rows.append({
            "frame_index": frame, "timestamp_sec": frame / fps,
            "observed": detection["observed"], "quality_flags": ";".join(flags),
        })
    pd.DataFrame(filtered_rows).to_csv(OUTPUT / "pose_filtered.csv", index=False)
    pd.DataFrame(quality_rows).to_csv(OUTPUT / "qc_by_frame.csv", index=False)


def main():
    phase("Inicializando pipeline de rastreamento")
    if MODEL_BUNDLE_ID not in ("wistar_df_v1", "wistar_df_v2"):
        raise RuntimeError("Modelo de análise desconhecido")
    for filename, expected in (("best_detector.pth", EXPECTED_DETECTOR_SHA256),
                               ("snapshot-hrnet_w32-001.pt", EXPECTED_POSE_SHA256),
                               ("pytorch_config.yaml", EXPECTED_CONFIG_SHA256)):
        if sha256(MODELS / filename) != expected:
            raise RuntimeError(f"Integridade do modelo remoto inválida: {filename}")
    if DEVICE.type != "cuda":
        raise RuntimeError("O rastreamento requer CUDA")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(VIDEO)
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    if ARENA and (ARENA.get("videoWidth") != width or ARENA.get("videoHeight") != height):
        raise RuntimeError("A ROI foi calibrada em uma resolução diferente do vídeo")
    phase("Preparando máscara da arena")
    mask = arena_mask(width, height, ARENA)
    phase("Executando detector Wistar")
    detections, contexts, count, fps, width, height = run_detector(VIDEO, mask)
    phase("Executando HRNet adaptada")
    pose = pose_dataframe(VIDEO, contexts, count)
    phase("Calculando controle de qualidade e filtro F+C")
    export_quality_and_filtered(pose, detections, fps)
    phase("Gerando CSV canônico")
    export_canonical(pose, detections, fps, width, height)
    canonical_path = Path(CSV_PATH)
    if not canonical_path.is_file() or canonical_path.stat().st_size == 0:
        raise RuntimeError("O CSV canônico não foi gerado")
    phase("Gerando manifesto")
    manifest = {
        "schemaVersion": 1, "pipelineVersion": "hybrid-df-notebook-port-1",
        "engineId": "wistar_superanimal_hybrid_v1", "modelBundleId": MODEL_BUNDLE_ID,
        "detectorSha256": sha256(MODELS / "best_detector.pth"),
        "poseCheckpointSha256": sha256(MODELS / "snapshot-hrnet_w32-001.pt"),
        "sourceSha256": sha256(VIDEO), "frameCount": count, "fps": fps,
        "frameWidth": width, "frameHeight": height, "keypointCount": len(KEYPOINTS),
        "keypoints": KEYPOINTS,
        "detectorThreshold": DETECTOR_THRESHOLD, "bboxMargin": BBOX_MARGIN,
        "detectorSelection": {
            "roiOverlapMinimum": M4_MIN_ROI_OVERLAP,
            "minAreaFraction": .0004, "maxAreaFraction": .40,
            "continuityWeight": .48, "maxJumpFraction": .27,
            "floorOverlapWeight": .68, "floorAnchorBonus": .25,
        },
        "detectorBatchSize": LAST_DETECTOR_BATCH_SIZE,
        "poseLikelihoodThreshold": FC_THRESHOLD,
        "artifacts": {"detections": "detections.csv", "poseRawCsv": "pose_raw.csv",
                      "poseRawH5": "pose_raw.h5", "poseFiltered": "pose_filtered.csv",
                      "quality": "qc_by_frame.csv", "canonical": "canonical_pose.csv"},
    }
    (OUTPUT / "run_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (OUTPUT / "canonical_pose.csv.complete").write_text("ok", encoding="utf-8")
    phase("Pipeline de rastreamento concluído")


if __name__ == "__main__":
    main()
