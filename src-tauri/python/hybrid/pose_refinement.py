"""Conservative, same-frame pose refinement. Never fills missing detections.

Raw likelihoods are not calibrated probabilities. Agreement across transformed
views is a consistency check, not independent scientific validation.
"""
from itertools import combinations
import math

import cv2
import numpy as np

VERSION = "pose-consensus-2"
CORE = {"nose", "neck", "mid_back", "mouse_center", "tail_base",
        "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_hip", "right_hip"}
POLICY = {"version": VERSION, "likelihoodMinimum": .60, "minimumVotes": 2,
          "agreementFractionOfBoxDiagonal": .10, "cropScale": 1.10,
          "views": ["rotate90", "rotate180", "rotate270", "contrast"],
          "contextScales": [1.5, 2.0], "contextContrast": True,
          "contextWhen": "incomplete_same_frame_consensus", "maxViewsPerInferenceCall": 4,
          "applyTo": "all_observed_frames",
          "interpolation": False, "scientificallyValidated": False}


def observed(detection):
    return str(detection.get("observed", False)).lower() == "true"


def box_diagonal(detection):
    return max(1., math.hypot(float(detection.get("w") or 0), float(detection.get("h") or 0)))


def point_usable(point, detection, width, height, threshold=.60):
    x, y, confidence = point
    if not observed(detection) or not np.isfinite(point).all() or confidence < threshold or confidence > 1:
        return False
    if not 0 <= x < width or not 0 <= y < height:
        return False
    # Small tolerance for points at the edge of the external detector box.
    margin = .10 * box_diagonal(detection)
    bx, by, bw, bh = (float(detection[key]) for key in ("x", "y", "w", "h"))
    return bx - margin <= x <= bx + bw + margin and by - margin <= y <= by + bh + margin


def consensus(points, tolerance, threshold=.60):
    """Complete-link clusters prevent averaging between incompatible locations."""
    points = np.asarray(points, dtype=float)
    available = [i for i, p in enumerate(points) if np.isfinite(p).all() and threshold <= p[2] <= 1]
    for size in range(len(available), 1, -1):
        clusters = [indices for indices in combinations(available, size)
                    if all(np.linalg.norm(points[a, :2] - points[b, :2]) <= tolerance
                           for a, b in combinations(indices, 2))]
        if not clusters:
            continue
        centers = [np.median(points[list(indices), :2], axis=0) for indices in clusters]
        if any(np.linalg.norm(a - b) > tolerance for a, b in combinations(centers, 2)):
            return None, 0  # Equally supported but conflicting hypotheses.
        indices = max(clusters, key=lambda indices: min(points[i, 2] for i in indices))
        return np.r_[np.median(points[list(indices), :2], axis=0), min(points[i, 2] for i in indices)], size
    return None, 0


def inverse_rotation(points, turns, side, origin):
    """Invert numpy.rot90 pixel coordinates; labels are never swapped by rotation."""
    result = np.asarray(points, dtype=float).copy()
    x, y = result[:, 0].copy(), result[:, 1].copy()
    invalid = ~np.isfinite(result).all(axis=1) | (x < 0) | (y < 0) | (x >= side) | (y >= side)
    if turns == 1:
        result[:, 0], result[:, 1] = side - 1 - y, x
    elif turns == 2:
        result[:, 0], result[:, 1] = side - 1 - x, side - 1 - y
    elif turns == 3:
        result[:, 0], result[:, 1] = y, side - 1 - x
    result[:, :2] += origin
    result[invalid, :2] = np.nan
    return result


def square_crop(rgb, detection, scale):
    x, y, w, h = (float(detection[key]) for key in ("x", "y", "w", "h"))
    side = max(2, math.ceil(max(w, h) * scale))
    left, top = math.floor(x + w / 2 - side / 2), math.floor(y + h / 2 - side / 2)
    crop = np.zeros((side, side, 3), np.uint8)
    height, width = rgb.shape[:2]
    x1, y1, x2, y2 = max(0, left), max(0, top), min(width, left + side), min(height, top + side)
    crop[y1-top:y2-top, x1-left:x2-left] = rgb[y1:y2, x1:x2]
    return crop, side, (left, top)


def contrast_view(crop):
    lab = cv2.cvtColor(crop, cv2.COLOR_RGB2LAB)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=2., tileGridSize=(4, 4)).apply(lab[:, :, 0])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)


def crop_views(rgb, detection):
    crop, side, origin = square_crop(rgb, detection, POLICY["cropScale"])
    contrast = contrast_view(crop)
    images = [np.ascontiguousarray(np.rot90(crop, k)) for k in (1, 2, 3)] + [contrast]
    return images, side, origin


def context_views(rgb, detection):
    result = []
    for scale in POLICY["contextScales"]:
        crop, side, origin = square_crop(rgb, detection, scale)
        result.extend([(crop, side, origin), (contrast_view(crop), side, origin)])
    return result


def validate_sequence(poses, detections, keypoints, width, height):
    """Return acceptance and reasons, retaining all original coordinates/scores."""
    poses = np.asarray(poses, dtype=float)
    if poses.shape != (len(detections), len(keypoints), 3):
        raise ValueError("Pose e detecções não possuem o mesmo número de quadros/pontos")
    accepted = np.array([[point_usable(p, d, width, height) for p in row]
                         for row, d in zip(poses, detections)], dtype=bool)
    reasons = np.full(accepted.shape, "", dtype=object)
    reasons[~accepted] = "low_confidence_or_outside_box"
    core = [i for i, key in enumerate(keypoints) if key in CORE]
    for index, d in enumerate(detections):
        valid = [i for i in core if accepted[index, i]]
        if len(valid) >= 4:
            positions = poses[index, valid, :2]
            if np.max(np.linalg.norm(positions - np.median(positions, axis=0), axis=1)) < .03 * box_diagonal(d):
                accepted[index, valid] = False
                reasons[index, valid] = "collapsed_pose"
    snapshot = accepted.copy()
    for index in range(1, len(poses) - 1):
        if not all(observed(d) for d in detections[index-1:index+2]):
            continue
        scale = max(box_diagonal(d) for d in detections[index-1:index+2])
        for joint in range(len(keypoints)):
            if not snapshot[index-1:index+2, joint].all():
                continue
            before, current, after = poses[index-1:index+2, joint, :2]
            if (np.linalg.norm(before - after) <= .18 * scale and
                    min(np.linalg.norm(current - before), np.linalg.norm(current - after)) > .40 * scale):
                accepted[index, joint] = False
                reasons[index, joint] = "temporal_spike"
    return accepted, reasons


def refine_video(video, raw, detections, keypoints, infer, progress=None, capture_factory=None):
    """infer receives DLC-compatible (RGB image, xywh context) pairs, bounded to
    four crops per call. The original prediction also votes; incomplete poses
    get a second call with wider context at two scales, with and without CLAHE.
    """
    capture = (capture_factory or cv2.VideoCapture)(str(video))
    try:
        if not capture.isOpened():
            raise RuntimeError("Não foi possível reler o vídeo para conferir a pose")
        width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        selected = np.asarray(raw, dtype=float).copy()
        if selected.shape != (len(detections), len(keypoints), 3):
            raise ValueError("Pose e detecções não possuem o mesmo número de quadros/pontos")
        accepted, reasons = validate_sequence(selected, detections, keypoints, width, height)
        votes = np.zeros(accepted.shape, dtype=np.uint8)
        source = np.full(accepted.shape, "original", dtype=object)
        requested, context_requested = 0, 0
        for index, detection in enumerate(detections):
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError(f"Vídeo de refinamento terminou no quadro {index}")
            if progress and (index == 0 or index % 32 == 0):
                progress(index, len(detections))
            if not observed(detection):
                continue
            requested += 1
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            images, side, origin = crop_views(rgb, detection)
            predictions = infer([(image, {"bboxes": np.array([[0, 0, side, side]], np.float32)}) for image in images])
            if len(predictions) != 4:
                raise RuntimeError("A HRNet não retornou as quatro vistas de conferência")
            views = [selected[index].copy()]
            for prediction, turns in zip(predictions, (1, 2, 3, 0)):
                points = np.asarray(prediction["bodyparts"], dtype=float)
                if points.shape == (1, len(keypoints), 3):
                    points = points[0]
                if points.shape != (len(keypoints), 3):
                    raise RuntimeError("Formato incompatível das poses de conferência")
                views.append(inverse_rotation(points, turns, side, origin))
            tolerance = max(3., .10 * box_diagonal(detection))
            def select(joint):
                candidates = [view[joint] if point_usable(view[joint], detection, width, height) else (np.nan, np.nan, 0)
                              for view in views]
                return consensus(candidates, tolerance)

            if any(select(joint)[0] is None for joint in range(len(keypoints))):
                context_requested += 1
                extra = context_views(rgb, detection)
                predictions = infer([(image, {"bboxes": np.array([[0, 0, size, size]], np.float32)})
                                     for image, size, _ in extra])
                if len(predictions) != len(extra):
                    raise RuntimeError("A HRNet não retornou as quatro vistas de contexto")
                for prediction, (_, size, offset) in zip(predictions, extra):
                    points = np.asarray(prediction["bodyparts"], dtype=float)
                    if points.shape == (1, len(keypoints), 3):
                        points = points[0]
                    if points.shape != (len(keypoints), 3):
                        raise RuntimeError("Formato incompatível das poses de contexto")
                    views.append(inverse_rotation(points, 0, size, offset))
            for joint in range(len(keypoints)):
                point, support = select(joint)
                if point is None:
                    accepted[index, joint] = False
                    reasons[index, joint] = "view_disagreement"
                else:
                    selected[index, joint] = point
                    votes[index, joint] = support
                    source[index, joint] = "view_consensus"
                    accepted[index, joint] = True
                    reasons[index, joint] = ""
        if capture.read()[0]:
            raise RuntimeError("Vídeo de refinamento contém quadros adicionais")
        checked, flags = validate_sequence(selected, detections, keypoints, width, height)
        newly_rejected = ~checked & (accepted | (reasons == ""))
        reasons[newly_rejected] = flags[newly_rejected]
        accepted &= checked
        if progress:
            progress(len(detections), len(detections))
        return selected, accepted, reasons, votes, source, {**POLICY, "framesRechecked": requested,
                                                         "framesContextRechecked": context_requested}
    finally:
        capture.release()
