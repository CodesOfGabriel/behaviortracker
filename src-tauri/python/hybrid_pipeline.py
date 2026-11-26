"""Pipeline D+F portado do notebook M, com artefatos compatíveis com o app."""

import csv
import hashlib
from importlib.metadata import version
import json
import math
import time
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
import torch
import torchvision
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
LOCAL_PROGRESS = globals().get("LOCAL_PROGRESS")
# RAM explicitly disables this policy; local and legacy model runs retain their policy.
OFT_PRECISION = LOCAL_PROGRESS is None and MODEL_BUNDLE_ID == "wistar_df_v2"
LAYERED_OFT = True
OPEN_FIELD_TRACKING = True
POSE_RUNNER = None
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
    batch = 16 if memory_gb >= 35 else 8 if memory_gb >= 20 else 4 if memory_gb >= 14 else 2
    return max(1, batch // 4) if OFT_PRECISION else batch


def phase(message):
    print(f"BEHAVETRACKER_HYBRID_PHASE={message}", flush=True)


def local_progress(stage, processed=None, total=None, fps=None):
    if LOCAL_PROGRESS is not None:
        LOCAL_PROGRESS(stage, processed, total, fps, gpu_name() if DEVICE.type == "cuda" else "CPU")


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


def arena_mask(width, height, arena, include_walls=None):
    if include_walls is None:
        include_walls = OPEN_FIELD_TRACKING
    if include_walls and OPEN_FIELD_TRACKING:
        from arena import open_field_tracking_mask
        return open_field_tracking_mask(arena, width, height)
    mask = np.full((height, width), 255, dtype=np.uint8)
    regions = []
    if arena.get("cornersPx"):
        regions.append(polygon(arena["cornersPx"], width, height, "piso"))
    if include_walls and arena.get("rimCornersPx"):
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
    if OPEN_FIELD_TRACKING:
        from arena import open_field_tracking_polygon
        roi = np.asarray(open_field_tracking_polygon(arena, width, height), np.int32)
    else:
        roi = polygon(rim, width, height, "borda")
    floor_poly = polygon(floor, width, height, "piso")
    return roi, floor_poly, max(float(cv2.contourArea(roi)), 1.0)


def detector():
    checkpoint = torch.load(MODELS / "best_detector.pth", map_location="cpu", weights_only=True)
    if checkpoint.get("num_classes") != 2 or "state_dict" not in checkpoint:
        raise RuntimeError("Checkpoint do detector incompatível")
    # Match the scale at which this detector was trained. Larger inputs are
    # optional retries, not a replacement for the trained operating scale.
    model = fasterrcnn_resnet50_fpn_v2(weights=None, weights_backbone=None, min_size=640, max_size=1280)
    features = model.roi_heads.box_predictor.cls_score.in_features
    model.roi_heads.box_predictor = FastRCNNPredictor(features, 2)
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    return model.to(DEVICE).eval()


def run_detector(video, mask):
    if MODEL_BUNDLE_ID == "wistar_df_v2" and LAYERED_OFT:
        from layer_video import capture as open_video
        capture = open_video(video,globals().get("LAYERED_FFMPEG"),globals().get("LAYERED_FFPROBE"))
    else:
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
    max_batch_size = batch_size if OFT_PRECISION else 16
    global LAST_DETECTOR_BATCH_SIZE
    LAST_DETECTOR_BATCH_SIZE = 0
    successful_batches = 0
    phase(f"Detector Wistar · lote inicial {batch_size} · GPU {gpu_name()}")
    print(f"BEHAVETRACKER_DETECTOR_PROGRESS=0/{total or '?'}", flush=True)

    def choose(prediction):
        candidates = [
            (float(score), box.detach().cpu().numpy(), int(label))
            for score, label, box in zip(prediction["scores"], prediction["labels"], prediction["boxes"])
            if int(label) == 1
        ]
        frame_index = len(rows)
        return select_detection(
            [{"score": score, "x1": box[0], "y1": box[1], "x2": box[2], "y2": box[3]}
             for score, box, _ in candidates],
            width, height, threshold=DETECTOR_THRESHOLD, margin=BBOX_MARGIN,
            roi_polygon=roi_poly if MODEL_BUNDLE_ID == "wistar_df_v2" else None,
            floor_polygon=floor_poly if MODEL_BUNDLE_ID == "wistar_df_v2" else None,
            previous_box=previous_box if MODEL_BUNDLE_ID == "wistar_df_v2" else None,
            frame_gap=max(1, frame_index - previous_frame) if previous_box is not None else 1,
            roi_area=roi_area, roi_overlap_min=M4_MIN_ROI_OVERLAP,
            precision=OFT_PRECISION,
        )

    def append_prediction(prediction, original_frame):
        nonlocal previous_box, previous_frame
        frame_index = len(rows)
        selected = choose(prediction)
        attempts = [{"mask": "visible_arena", "minSize": 640, "audit": selected["audit"]}]
        selected_scale, selected_mask = 640, "visible_arena"
        if OFT_PRECISION and not selected["observed"]:
            # Re-read neither timestamps nor frames: each retry uses the exact
            # input frame from the primary batch and the same temporal context.
            for retry_mask, retry_size, retry_max, label in (
                    (mask, 960, 1600, "visible_arena"), (mask, 1280, 2048, "visible_arena")):
                masked = cv2.bitwise_and(original_frame, original_frame, mask=retry_mask)
                tensor = to_tensor(cv2.cvtColor(masked, cv2.COLOR_BGR2RGB)).to(DEVICE)
                original_min, original_max = model.transform.min_size, model.transform.max_size
                try:
                    model.transform.min_size, model.transform.max_size = (retry_size,), retry_max
                    retry_predictions = model([tensor])
                    if len(retry_predictions) != 1:
                        raise RuntimeError("Detector não retornou o quadro de recuperação")
                    candidate = choose(retry_predictions[0])
                except RuntimeError as error:
                    if DEVICE.type != "cuda" or "out of memory" not in str(error).lower():
                        raise
                    torch.cuda.empty_cache()
                    attempts.append({"mask": label, "minSize": retry_size, "error": "cuda_out_of_memory"})
                    continue
                finally:
                    model.transform.min_size, model.transform.max_size = original_min, original_max
                attempts.append({"mask": label, "minSize": retry_size, "audit": candidate["audit"]})
                if candidate["observed"]:
                    selected, selected_scale, selected_mask = candidate, retry_size, label
                    break
            selected["audit"] = {**selected["audit"], "retries": attempts}
        audit = selected["audit"]
        if not selected["observed"]:
            rows.append({"frame": len(rows), "x": "", "y": "", "w": "", "h": "",
                         "score": selected["score"] or 0.0, "observed": False,
                         "selection_rank": "", "roi_overlap": "", "floor_overlap": "",
                         "anchor_on_floor": False, "candidate_audit": json.dumps(audit)})
            rows[-1]["quality_flags"] = ";".join(selected.get("qualityFlags", []))
            rows[-1].update(detector_scale=selected_scale, detector_mask=selected_mask)
            contexts.append({"bboxes": np.empty((0, 4), np.float32)})
            return
        raw = selected["bboxRaw"]
        pose_box = selected["bboxPose"]
        px, py = pose_box["x"], pose_box["y"]
        qx, qy = px + pose_box["width"], py + pose_box["height"]
        w, h = pose_box["width"], pose_box["height"]
        previous_box = ((raw["x"], raw["y"], raw["x"] + raw["width"], raw["y"] + raw["height"])
                        if OFT_PRECISION else (px, py, qx, qy))
        previous_frame = frame_index
        rows.append({"frame": len(rows), "x": px, "y": py, "w": w, "h": h,
                     "score": selected["score"], "observed": True,
                     "raw_x1": raw["x"], "raw_y1": raw["y"],
                     "raw_x2": raw["x"] + raw["width"], "raw_y2": raw["y"] + raw["height"],
                     "selection_rank": selected["selectionRank"],
                     "roi_overlap": selected["roiOverlap"],
                     "floor_overlap": selected["floorOverlap"],
                     "anchor_on_floor": selected["anchorOnFloor"],
                     "candidate_audit": json.dumps(audit), "quality_flags": "",
                     "detector_scale": selected_scale, "detector_mask": selected_mask})
        contexts.append({"bboxes": np.asarray([[px, py, w, h]], dtype=np.float32)})

    with torch.inference_mode():
        while True:
            local_progress("tracking", len(rows), total or None, len(rows) / max(time.monotonic() - started, 1e-6))
            batch, original_frames = [], []
            for _ in range(batch_size):
                ok, frame = capture.read()
                if not ok:
                    break
                original_frames.append(frame)
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
                if not capture.set(cv2.CAP_PROP_POS_FRAMES, len(rows)):
                    raise RuntimeError("Não foi possível reposicionar o vídeo após falta de memória; alinhamento não confirmado") from error
                batch_size = max(1, batch_size // 2)
                max_batch_size = batch_size
                successful_batches = 0
                del batch
                torch.cuda.empty_cache()
                phase(f"Detector Wistar · memória insuficiente; reduzindo lote para {batch_size}")
                continue
            successful_batches += 1
            if len(predictions) != len(batch):
                raise RuntimeError("Detector retornou contagem diferente dos quadros enviados")
            LAST_DETECTOR_BATCH_SIZE = max(LAST_DETECTOR_BATCH_SIZE, len(predictions))
            if DEVICE.type == "cuda":
                torch.cuda.synchronize()
            elapsed_batch = max(time.monotonic() - batch_start, 1e-6)
            batch_fps = len(predictions) / elapsed_batch
            if DEVICE.type == "cuda" and successful_batches >= 3 and batch_size < max_batch_size and batch_fps > 0:
                batch_size = min(max_batch_size, batch_size * 2)
                phase(f"Detector Wistar · lote ajustado para {batch_size} · {batch_fps:.2f} frames/s")
            for prediction, original_frame in zip(predictions, original_frames):
                append_prediction(prediction, original_frame)
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
    global KEYPOINTS, POSE_RUNNER
    KEYPOINTS = list(config["metadata"]["bodyparts"])
    if len(KEYPOINTS) != 27:
        raise RuntimeError(f"Esperados 27 keypoints; configuração declarou {len(KEYPOINTS)}")
    inference_config = None
    if OFT_PRECISION:
        # DLC 3.0.2's asynchronous runner only extracts results after a neural
        # batch. Empty bounding boxes create no batch, so an empty suffix can
        # remain unreturned. Sequential preprocessing extracts every real frame,
        # including missing poses, while retaining neural batching on the GPU.
        # Copy these settings; the verified model configuration stays immutable.
        inference_config = dict(config.get("inference") or {})
        inference_config["multithreading"] = {
            **(inference_config.get("multithreading") or {}), "enabled": False,
        }
    runner = pep.get_pose_inference_runner(
        model_config=config, snapshot_path=str(MODELS / "snapshot-hrnet_w32-001.pt"),
        max_individuals=1, device=str(DEVICE), batch_size=2 if DEVICE.type == "cuda" else 1,
        inference_cfg=inference_config,
    )
    POSE_RUNNER = runner
    if LOCAL_PROGRESS is None:
        iterator = pep.VideoIterator(str(video))
    else:
        class LocalVideoIterator(pep.VideoIterator):
            def __next__(self):
                local_progress("pose", self._index, count)
                return super().__next__()

        iterator = LocalVideoIterator(str(video))
    iterator.set_context(contexts)
    predictions = pep.video_inference(
        video=iterator, pose_runner=runner, detector_runner=None, robust_nframes=LOCAL_PROGRESS is None,
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


def refine_pose(frame_df, detections, fps):
    global POSE_RUNNER
    from hybrid.pose_refinement import refine_video
    from hybrid.pose_continuity import recover_points, coverage_summary
    from hybrid.temporal_runtime import recover_video
    raw = np.stack([np.column_stack([column(frame_df, part, c) for c in ("x", "y", "likelihood")])
                    for part in KEYPOINTS], axis=1)
    def progress(done, total):
        print(f"BEHAVETRACKER_POSE_REFINEMENT_PROGRESS={done}/{total}", flush=True)
    selected, accepted, reasons, votes, sources, policy = refine_video(
        VIDEO, raw, detections, KEYPOINTS, POSE_RUNNER.inference, progress=progress)
    before_flow, before_flow_reasons = selected.copy(), reasons.copy()
    neural_accepted = accepted.copy()
    phase("Conferindo movimento dos pontos entre âncoras em ambas as direções")
    def flow_progress(direction, done, total):
        print(f"BEHAVETRACKER_POSE_FLOW_PROGRESS={direction}:{done}/{total}", flush=True)
    selected, recovered, continuity = recover_points(VIDEO, selected, accepted, detections, KEYPOINTS, fps,
                                                     progress=flow_progress)
    sources[recovered] = "optical_flow"
    reasons[recovered] = "visual_recovery_pending_review"
    # The HRNet runner is no longer needed. Release its CUDA allocations before
    # loading the temporal network, including on smaller Colab GPUs.
    POSE_RUNNER = None
    import gc
    gc.collect()
    if DEVICE.type == "cuda":
        getattr(torch.cuda, "empty_cache", lambda: None)()
    phase("Acompanhando imagens em ambas as direções; estimativas identificadas para revisão")
    def temporal_progress(direction, done, total):
        print(f"BEHAVETRACKER_POSE_TEMPORAL_PROGRESS={direction}:{done}/{total}", flush=True)
    temporal, temporal_recovered, temporal_policy, temporal_anchors, temporal_support = recover_video(
        VIDEO, before_flow, neural_accepted, detections, KEYPOINTS, MODELS, DEVICE, ARENA,
        progress=temporal_progress)
    selected[temporal_recovered] = temporal[temporal_recovered]
    sources[temporal_recovered] = "temporal_tracker"
    reasons[temporal_recovered & neural_accepted] = "temporal_disagreement_pending_review"
    reasons[temporal_recovered & ~neural_accepted] = "temporal_estimate_pending_review"
    recovered |= temporal_recovered
    accepted = neural_accepted | recovered
    policy = {**policy, "version": "pose-consensus-temporal-4", "continuity": continuity["policy"],
              "temporal": temporal_policy,
              "coverage": coverage_summary(accepted, recovered, KEYPOINTS, fps)}
    refined = frame_df.copy()
    for item in refined.columns:
        if item[-2] in KEYPOINTS and item[-1] in ("x", "y", "likelihood"):
            refined[item] = selected[:, KEYPOINTS.index(item[-2]), ("x", "y", "likelihood").index(item[-1])]
    with (OUTPUT / "pose_refinement.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["frame_index", "keypoint", "raw_x_px", "raw_y_px", "raw_likelihood",
                                                  "selected_x_px", "selected_y_px", "selected_likelihood",
                                                  "tracking_accepted", "tracking_reason", "agreeing_views", "pose_source",
                                                  "flow_anchor_before", "flow_anchor_after", "flow_max_fb_error_px",
                                                  "temporal_anchor_frame", "temporal_image_support"])
        writer.writeheader()
        for index in range(len(detections)):
            for joint, part in enumerate(KEYPOINTS):
                writer.writerow({"frame_index": index, "keypoint": part,
                          "raw_x_px": raw[index, joint, 0], "raw_y_px": raw[index, joint, 1],
                          "raw_likelihood": raw[index, joint, 2],
                          "selected_x_px": selected[index, joint, 0], "selected_y_px": selected[index, joint, 1],
                          "selected_likelihood": selected[index, joint, 2],
                          "tracking_accepted": bool(accepted[index, joint]), "tracking_reason": reasons[index, joint],
                          "agreeing_views": int(votes[index, joint]), "pose_source": sources[index, joint],
                          "flow_anchor_before": int(continuity["before"][index, joint]),
                          "flow_anchor_after": int(continuity["after"][index, joint]),
                          "flow_max_fb_error_px": continuity["error"][index, joint],
                          "temporal_anchor_frame": int(temporal_anchors[index, joint]),
                          "temporal_image_support": str(temporal_support[index, joint])})
    center = KEYPOINTS.index("mouse_center")
    policy.update({"acceptedKeypointCount": int((accepted & ~recovered).sum()),
                   "visualKeypointCount": int(accepted.sum()), "totalKeypointCount": int(accepted.size),
                   "rawCenterAboveLikelihoodThreshold": int((raw[:, center, 2] >= FC_THRESHOLD).sum()),
                   "acceptedCenterFrames": int((accepted[:, center] & ~recovered[:, center]).sum()),
                   "visualCenterFrames": int(accepted[:, center].sum())})
    return refined, {"accepted": accepted, "reasons": reasons, "sources": sources, "policy": policy,
                     "original": before_flow, "original_reasons": before_flow_reasons}


def export_canonical(frame_df, detections, fps, width, height, refinement=None):
    rows = []
    points = {part: tuple(column(frame_df, part, coordinate) for coordinate in ("x", "y", "likelihood"))
              for part in KEYPOINTS}
    for frame in range(len(detections)):
        detection = detections[frame]
        bbox = (detection["x"], detection["y"], detection["w"], detection["h"]) if detection["observed"] else ("", "", "", "")
        for joint, (bodypart, (xs, ys, likelihoods)) in enumerate(points.items()):
            x, y, likelihood = xs[frame], ys[frame], likelihoods[frame]
            valid = detection["observed"] and all(math.isfinite(value) for value in (x, y, likelihood)) and 0 <= x < width and 0 <= y < height
            status = "valid" if valid and likelihood >= FC_THRESHOLD else "low_confidence" if valid else "missing"
            accepted = valid and status == "valid"
            reason = ""
            if refinement is not None:
                accepted = accepted and bool(refinement["accepted"][frame, joint])
                reason = str(refinement["reasons"][frame, joint])
                if valid and not accepted:
                    status = "jump" if reason == "temporal_spike" else "low_confidence"
            recovered = refinement is not None and refinement["sources"][frame, joint] in ("optical_flow", "temporal_tracker")
            if recovered:
                status = "low_confidence"  # Flow is never a new measured neural observation.
            rows.append([frame, frame / fps, "animal_1", bodypart, x if valid else "", y if valid else "",
                         max(0., min(1., likelihood)) if math.isfinite(likelihood) else 0., status,
                         "unknown", bbox[0], bbox[1], bbox[2], bbox[3], "recovered" if recovered else "detected"])
            if refinement is not None:
                rows[-1].extend([str(accepted).lower(), reason, refinement["policy"]["version"]])
                if recovered:
                    rx, ry, score = refinement["original"][frame, joint]
                    raw_visible = (detection["observed"] and np.isfinite([rx, ry, score]).all()
                                   and 0 <= rx < width and 0 <= ry < height)
                    raw_status = ("jump" if refinement["original_reasons"][frame, joint] == "temporal_spike"
                                  else "low_confidence") if raw_visible else "missing"
                    rows[-1].extend([rx if raw_visible else "", ry if raw_visible else "",
                                     max(0., min(1., score)) if math.isfinite(score) else 0.,
                                     raw_status, "unknown", "detected"])
                else:
                    rows[-1].extend([""]*6)
    header = ["frame_index", "timestamp_sec", "animal_id", "keypoint", "x_px", "y_px", "likelihood",
              "status", "spatial_region", "bbox_x", "bbox_y", "bbox_width", "bbox_height", "source"]
    if refinement is not None:
        header.extend(["tracking_accepted", "tracking_reason", "processing_version"])
        header.extend(["raw_x_px", "raw_y_px", "raw_likelihood", "raw_status", "raw_spatial_region", "raw_source"])
    canonical_path = OUTPUT / "canonical_pose.csv"
    with canonical_path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    if Path(CSV_PATH) != canonical_path:
        Path(CSV_PATH).write_bytes(canonical_path.read_bytes())


def export_quality_and_filtered(frame_df, detections, fps, refinement=None, raw_df=None):
    filtered_rows = []
    quality_rows = []
    for joint, bodypart in enumerate(KEYPOINTS):
        values = list(zip(column(frame_df, bodypart, "x"),
                          column(frame_df, bodypart, "y"),
                          column(frame_df, bodypart, "likelihood")))
        trusted = [point if refinement is None or (refinement["accepted"][frame, joint]
                   and refinement["sources"][frame, joint] not in ("optical_flow", "temporal_tracker"))
                   else (np.nan, np.nan, point[2]) for frame, point in enumerate(values)]
        smoothed = filtered(trusted)
        original = values if raw_df is None else list(zip(*(column(raw_df, bodypart, c) for c in ("x", "y", "likelihood"))))
        for frame, (raw, final) in enumerate(zip(original, smoothed)):
            rx, ry, likelihood = raw
            fx, fy, _ = final
            recovered = refinement is not None and refinement["sources"][frame, joint] in ("optical_flow", "temporal_tracker")
            if recovered:
                # Display the image estimate, but never feed it into the median
                # of neighbouring measured points or label that median valid.
                fx, fy, _ = values[frame]
                if not np.isfinite([fx, fy]).all():
                    fx = fy = None
            filtered_rows.append({
                "frame_index": frame, "keypoint": bodypart,
                "raw_x_px": rx if math.isfinite(rx) else "",
                "raw_y_px": ry if math.isfinite(ry) else "",
                "raw_likelihood": likelihood if math.isfinite(likelihood) else 0.,
                "likelihood": final[2] if math.isfinite(final[2]) else 0.,
                "filtered_x_px": "" if fx is None else fx,
                "filtered_y_px": "" if fy is None else fy,
                "filtered_status": "low_confidence" if fx is not None and recovered else "valid" if fx is not None else "missing",
                "source": "recovered" if recovered else "detected",
            })
    reference = column(frame_df, "mouse_center", "likelihood") if "mouse_center" in KEYPOINTS else None
    for frame, detection in enumerate(detections):
        flags = list(filter(None, detection.get("quality_flags", "").split(";")))
        if not detection["observed"]:
            flags.append("sem_bbox")
        if reference is None:
            flags.append("centro_nao_confiavel")
        else:
            likelihood = reference[frame]
            if not math.isfinite(likelihood) or likelihood < FC_THRESHOLD:
                flags.append("centro_nao_confiavel")
        if refinement is not None:
            center = KEYPOINTS.index("mouse_center")
            if not refinement["accepted"][frame, center] and "centro_nao_confiavel" not in flags:
                flags.append("centro_nao_confiavel")
            if refinement["sources"][frame, center] in ("optical_flow", "temporal_tracker"):
                flags.append("centro_recuperado_revisar")
            flags.extend(sorted(set(str(r) for r in refinement["reasons"][frame] if r)))
        quality_rows.append({
            "frame_index": frame, "timestamp_sec": frame / fps,
            "observed": detection["observed"], "quality_flags": ";".join(flags),
        })
    pd.DataFrame(filtered_rows).to_csv(OUTPUT / "pose_filtered.csv", index=False)
    pd.DataFrame(quality_rows).to_csv(OUTPUT / "qc_by_frame.csv", index=False)


def main():
    phase("Inicializando pipeline de rastreamento")
    local_progress("model_setup")
    if MODEL_BUNDLE_ID not in ("wistar_df_v1", "wistar_df_v2"):
        raise RuntimeError("Modelo de análise desconhecido")
    layered_active = MODEL_BUNDLE_ID == "wistar_df_v2" and LAYERED_OFT
    for filename, expected in (("best_detector.pth", EXPECTED_DETECTOR_SHA256),
                               ("snapshot-hrnet_w32-001.pt", EXPECTED_POSE_SHA256),
                               ("pytorch_config.yaml", EXPECTED_CONFIG_SHA256)):
        if layered_active and filename != "best_detector.pth":
            continue
        if sha256(MODELS / filename) != expected:
            raise RuntimeError(f"Integridade do modelo inválida: {filename}")
    if DEVICE.type != "cuda" and LOCAL_PROGRESS is None:
        raise RuntimeError("O rastreamento requer CUDA")
    if DEVICE.type == "cpu":
        import os
        torch.set_num_threads(min(8, os.cpu_count() or 1))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if layered_active:
        from layer_video import capture as open_video
        capture = open_video(VIDEO,globals().get("LAYERED_FFMPEG"),globals().get("LAYERED_FFPROBE"))
    else:
        capture = cv2.VideoCapture(VIDEO)
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    if ARENA and (ARENA.get("videoWidth") != width or ARENA.get("videoHeight") != height):
        raise RuntimeError("A ROI foi calibrada em uma resolução diferente do vídeo")
    if layered_active:
        from oft_layered_pipeline import cached_detector, detector_identity, run as run_layers
        phase("Camada 1/4 · localizando o animal")
        identity = detector_identity(VIDEO, ARENA, EXPECTED_DETECTOR_SHA256, __file__)
        detections, _, count, fps, width, height = cached_detector(
            OUTPUT, identity, lambda: run_detector(VIDEO, arena_mask(width, height, ARENA)))
        phase("Camadas 2–4 · silhueta, orientação e rearing")
        def layer_progress(done,total):
            local_progress("pose",done,total)
            print(f"BEHAVETRACKER_POSE_REFINEMENT_PROGRESS={done}/{total}",flush=True)
        run_layers(VIDEO, detections, OUTPUT, ARENA, fps, width, height,
            model_directory=globals().get("LAYERED_REARING_MODEL_DIRECTORY", OUTPUT/"rearing_model"),
            ffmpeg=globals().get("LAYERED_FFMPEG"),ffprobe=globals().get("LAYERED_FFPROBE"),progress=layer_progress)
        canonical = OUTPUT/"canonical_pose.csv"
        if Path(CSV_PATH) != canonical:
            Path(CSV_PATH).write_bytes(canonical.read_bytes())
        Path(str(CSV_PATH)+".complete").write_text("complete",encoding="utf-8")
        phase("Camadas concluídas; estimativas e propostas identificadas para revisão")
        return
    if OFT_PRECISION:
        from hybrid.temporal_assets import prepare_assets
        phase("Verificando integridade do modelo de acompanhamento temporal")
        prepare_assets(MODELS)
    phase("Preparando máscara da arena")
    mask = arena_mask(width, height, ARENA)
    phase("Executando detector Wistar")
    local_progress("tracking", 0)
    detections, contexts, count, fps, width, height = run_detector(VIDEO, mask)
    phase("Executando HRNet adaptada")
    local_progress("pose")
    pose = pose_dataframe(VIDEO, contexts, count)
    raw_pose = pose
    refinement = None
    if OFT_PRECISION:
        phase("Conferindo poses com rotações, contraste e contexto; rejeitando outliers")
        pose, refinement = refine_pose(raw_pose, detections, fps)
    phase("Calculando controle de qualidade e filtro F+C")
    local_progress("quality")
    export_quality_and_filtered(pose, detections, fps, refinement=refinement, raw_df=raw_pose)
    phase("Gerando CSV canônico")
    export_canonical(pose, detections, fps, width, height, refinement=refinement)
    canonical_path = Path(CSV_PATH)
    if not canonical_path.is_file() or canonical_path.stat().st_size == 0:
        raise RuntimeError("O CSV canônico não foi gerado")
    phase("Gerando manifesto")
    manifest = {
        "schemaVersion": 1, "pipelineVersion": "hybrid-df-precision-6" if OFT_PRECISION else "hybrid-df-notebook-port-1",
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
            "floorOverlapWeight": .20 if OFT_PRECISION else .68, "floorAnchorBonus": .08 if OFT_PRECISION else .25,
            "ambiguityRankMargin": .10 if OFT_PRECISION else None,
            "initialAndReacquisitionThreshold": .65 if OFT_PRECISION else DETECTOR_THRESHOLD,
        },
        "detectorInput": {"minSize": 640, "maxSize": 1280,
                          "includeWalls": OFT_PRECISION or MODEL_BUNDLE_ID == "wistar_df_v1",
                          "retries": [{"mask": "floor", "minSize": 640, "maxSize": 1280},
                                      {"mask": "visible_arena", "minSize": 1280, "maxSize": 2048}] if OFT_PRECISION else []},
        "detectorBatchSize": LAST_DETECTOR_BATCH_SIZE,
        "poseLikelihoodThreshold": FC_THRESHOLD,
        "runtime": {"device": str(DEVICE), "torch": torch.__version__, "torchvision": torchvision.__version__,
                    "deepLabCut": version("deeplabcut"), "openCV": cv2.__version__},
        "artifacts": {"detections": "detections.csv", "poseRawCsv": "pose_raw.csv",
                      "poseRawH5": "pose_raw.h5", "poseFiltered": "pose_filtered.csv",
                      "quality": "qc_by_frame.csv", "canonical": "canonical_pose.csv"},
    }
    if refinement is not None:
        manifest["poseRefinement"] = refinement["policy"]
        manifest["artifacts"]["poseRefinement"] = "pose_refinement.csv"
    (OUTPUT / "run_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (OUTPUT / "canonical_pose.csv.complete").write_text("ok", encoding="utf-8")
    phase("Pipeline de rastreamento concluído")


if __name__ == "__main__":
    main()
