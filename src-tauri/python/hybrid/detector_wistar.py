"""Seleção e normalização de detecções do detector Wistar."""

from dataclasses import dataclass
import math

try:
    import cv2
    import numpy as np
except ModuleNotFoundError:  # Geometry is only needed by the Colab runtime.
    cv2 = None
    np = None


@dataclass(frozen=True)
class Detection:
    score: float
    x1: float
    y1: float
    x2: float
    y2: float


def _number(value, name):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{name} inválido")
    return value


def _overlap(box, polygon):
    if cv2 is None or np is None:
        raise RuntimeError("OpenCV é necessário para seleção geométrica do detector")
    x1, y1, x2, y2 = box
    rectangle = np.asarray([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], dtype=np.float32)
    try:
        area, _ = cv2.intersectConvexConvex(polygon, rectangle)
    except cv2.error:
        return 0.0
    return float(max(0.0, area)) / max(1.0, (x2 - x1) * (y2 - y1))


def _iou(first, second):
    if first is None or second is None:
        return 0.0
    x1, y1 = max(first[0], second[0]), max(first[1], second[1])
    x2, y2 = min(first[2], second[2]), min(first[3], second[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = ((first[2] - first[0]) * (first[3] - first[1])
             + (second[2] - second[0]) * (second[3] - second[1]) - intersection)
    return intersection / max(union, 1e-6)


def select_detection(
    detections, width, height, threshold=.30, margin=.12,
    roi_polygon=None, floor_polygon=None, previous_box=None,
    frame_gap=1, roi_area=None, roi_overlap_min=.22, return_audit=False,
):
    """Seleciona uma bbox com os critérios geométricos e temporais do M4.

    A ausência de uma detecção permanece explícita; nenhuma caixa é inventada.
    """
    width = _number(width, "largura")
    height = _number(height, "altura")
    threshold = _number(threshold, "threshold")
    margin = _number(margin, "margem")
    if width <= 0 or height <= 0 or not 0 <= threshold <= 1 or not 0 <= margin < 1:
        raise ValueError("Parâmetros do detector inválidos")

    if frame_gap < 1:
        raise ValueError("Intervalo de frames inválido")
    if (roi_polygon is not None or floor_polygon is not None) and (cv2 is None or np is None):
        raise RuntimeError("OpenCV é necessário para seleção geométrica do detector")
    roi = None if roi_polygon is None else np.asarray(roi_polygon, dtype=np.float32)
    floor = None if floor_polygon is None else np.asarray(floor_polygon, dtype=np.float32)
    if roi is not None and (roi.ndim != 2 or roi.shape[0] < 3 or roi.shape[1] != 2):
        raise ValueError("ROI inválida")
    if floor is not None and (floor.ndim != 2 or floor.shape[0] < 3 or floor.shape[1] != 2):
        raise ValueError("Piso inválido")
    if roi_area is None and roi is not None:
        roi_area = max(float(cv2.contourArea(roi)), 1.0)
    candidates = []
    rejected = {"below_threshold": 0, "invalid": 0, "size": 0, "roi": 0, "jump": 0}
    highest_score = 0.0
    for item in detections:
        try:
            score = _number(item["score"], "score")
            box = tuple(_number(item[key], key) for key in ("x1", "y1", "x2", "y2"))
        except (KeyError, TypeError, ValueError):
            rejected["invalid"] += 1
            continue
        highest_score = max(highest_score, score)
        x1, y1, x2, y2 = box
        if score < threshold:
            rejected["below_threshold"] += 1
            continue
        if x2 <= x1 or y2 <= y1:
            rejected["invalid"] += 1
            continue
        area = (x2 - x1) * (y2 - y1)
        if roi is not None and (area < .0004 * roi_area or area > .40 * roi_area):
            rejected["size"] += 1
            continue
        overlap = _overlap(box, roi) if roi is not None else 1.0
        center = ((x1 + x2) / 2, (y1 + y2) / 2)
        center_inside = roi is None or cv2.pointPolygonTest(roi, center, False) >= 0
        if roi is not None and overlap < roi_overlap_min and not center_inside:
            rejected["roi"] += 1
            continue
        continuity, iou = 0.0, 0.0
        if previous_box is not None and frame_gap <= 16:
            previous_center = ((previous_box[0] + previous_box[2]) / 2,
                               (previous_box[1] + previous_box[3]) / 2)
            distance = math.hypot(center[0] - previous_center[0], center[1] - previous_center[1])
            normalized = distance / max(math.sqrt(roi_area or width * height), 1.0)
            if normalized > .27 * min(2.0, 1.0 + .08 * (frame_gap - 1)):
                rejected["jump"] += 1
                continue
            continuity = math.exp(-normalized / .14)
            iou = _iou(box, previous_box)
        floor_overlap = _overlap(box, floor) if floor is not None else 0.0
        floor_anchor = floor_overlap > .04
        rank = score + .48 * continuity + .30 * iou + .08 * overlap + .68 * floor_overlap
        if floor_anchor:
            rank += .25
        candidates.append((rank, Detection(score, x1, y1, x2, y2), overlap, floor_overlap, floor_anchor))

    if not candidates:
        result = {"observed": False, "score": None, "bboxRaw": None, "bboxPose": None,
                  "qualityFlags": ["detector_missing"],
                  "audit": {"rawCandidates": len(detections), "highestRawScore": highest_score,
                            "rejected": rejected}}
        return result if return_audit else result

    rank, chosen, overlap, floor_overlap, floor_anchor = max(candidates, key=lambda item: item[0])
    raw = {"x": chosen.x1, "y": chosen.y1, "width": chosen.x2 - chosen.x1,
           "height": chosen.y2 - chosen.y1}
    pad_x = raw["width"] * margin
    pad_y = raw["height"] * margin
    pose_x1 = max(0.0, chosen.x1 - pad_x)
    pose_y1 = max(0.0, chosen.y1 - pad_y)
    pose_x2 = min(width, chosen.x2 + pad_x)
    pose_y2 = min(height, chosen.y2 + pad_y)
    return {"observed": True, "score": chosen.score, "bboxRaw": raw,
            "bboxPose": {"x": pose_x1, "y": pose_y1, "width": pose_x2 - pose_x1,
                         "height": pose_y2 - pose_y1},
            "qualityFlags": [], "selectionRank": rank, "roiOverlap": overlap,
            "floorOverlap": floor_overlap, "anchorOnFloor": floor_anchor,
            "audit": {"rawCandidates": len(detections), "highestRawScore": highest_score,
                      "rejected": rejected}}
