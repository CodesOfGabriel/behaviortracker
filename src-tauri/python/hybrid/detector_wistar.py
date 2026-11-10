"""Seleção e normalização de detecções do detector Wistar."""

from dataclasses import dataclass
import math


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


def select_detection(detections, width, height, threshold=.30, margin=.12):
    """Escolhe a maior pontuação e retorna bbox raw e bbox de pose em xywh.

    A ausência de uma detecção permanece explícita; nenhuma caixa é inventada.
    """
    width = _number(width, "largura")
    height = _number(height, "altura")
    threshold = _number(threshold, "threshold")
    margin = _number(margin, "margem")
    if width <= 0 or height <= 0 or not 0 <= threshold <= 1 or not 0 <= margin < 1:
        raise ValueError("Parâmetros do detector inválidos")

    candidates = []
    for item in detections:
        try:
            score = _number(item["score"], "score")
            box = tuple(_number(item[key], key) for key in ("x1", "y1", "x2", "y2"))
        except (KeyError, TypeError, ValueError):
            continue
        x1, y1, x2, y2 = box
        if score < threshold or x2 <= x1 or y2 <= y1:
            continue
        candidates.append(Detection(score, x1, y1, x2, y2))

    if not candidates:
        return {"observed": False, "score": None, "bboxRaw": None, "bboxPose": None,
                "qualityFlags": ["detector_missing"]}

    chosen = max(candidates, key=lambda item: item.score)
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
            "qualityFlags": []}

