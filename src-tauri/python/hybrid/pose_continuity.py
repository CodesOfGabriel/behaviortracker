"""Recover short pose gaps with image motion and two neural anchors.

Recovered points are visual estimates requiring review, not new neural
observations. They must retain source=recovered and stay outside metrics.
"""
import math

import cv2
import numpy as np

from hybrid.pose_refinement import observed, point_usable, box_diagonal

POLICY = {"version": "pose-image-flow-1", "maxAnchorDistanceSec": .75,
          "maxForwardBackwardErrorPx": 1., "maxPatchError": 20.,
          "maxAnchorAgreementPx": 2., "requiresBothDirections": True,
          "requiresObservedBox": True, "metricEligible": False,
          "interpolation": False, "scientificallyValidated": False}


def coverage_summary(accepted, recovered, keypoints, fps):
    """Audit every gap, including leading/trailing gaps, without measuring accuracy."""
    accepted = np.asarray(accepted, dtype=bool)
    recovered = np.asarray(recovered, dtype=bool)
    if (accepted.ndim != 2 or accepted.shape != recovered.shape
            or accepted.shape[1] != len(keypoints) or not len(keypoints)
            or not math.isfinite(fps) or fps <= 0 or np.any(recovered & ~accepted)):
        raise ValueError("Dados inválidos para conferir cobertura da pose")

    def summarize(mask):
        missing = ~mask
        edges = np.diff(np.r_[False, missing, False].astype(np.int8))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
        durations = ends-starts
        longest = int(np.argmax(durations)) if len(durations) else None
        return {"acceptedFrames": int(mask.sum()), "gapCount": len(starts),
                "maxGapFrames": int(durations[longest]) if longest is not None else 0,
                "maxGapSec": float(durations[longest]/fps) if longest is not None else 0.,
                "longestGap": {"startFrame": int(starts[longest]),
                               "endFrameExclusive": int(ends[longest])} if longest is not None else None}

    return {"accuracyMeasured": False, "frameCount": len(accepted),
            "framesWithoutAnyVisualPoint": int((~accepted.any(axis=1)).sum()),
            "framesWithoutFullVisualPose": int((~accepted.all(axis=1)).sum()),
            "completeVisualCoverage": bool(len(accepted) and accepted.all()),
            "perKeypoint": {key: {"neural": summarize(accepted[:, j] & ~recovered[:, j]),
                                  "visualIncludingRecovery": summarize(accepted[:, j])}
                            for j, key in enumerate(keypoints)}}


def gray_frames(video, count, reverse=False, capture_factory=None):
    """Reverse decode in bounded blocks; never seek independently for each point."""
    capture = (capture_factory or cv2.VideoCapture)(str(video))
    try:
        if not capture.isOpened():
            raise RuntimeError("Não foi possível abrir o vídeo para conferir o movimento dos pontos")
        if not reverse:
            for index in range(count):
                ok, image = capture.read()
                if not ok:
                    raise RuntimeError(f"Vídeo de continuidade terminou no quadro {index}")
                yield index, cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            if capture.read()[0]:
                raise RuntimeError("Vídeo de continuidade contém quadros adicionais")
        else:
            end = count
            while end:
                start = max(0, end - 48)
                if start and (not capture.set(cv2.CAP_PROP_POS_FRAMES, start)
                              or abs(capture.get(cv2.CAP_PROP_POS_FRAMES) - start) > .5):
                    raise RuntimeError("Posição do vídeo não confirmada na conferência reversa")
                if start == 0 and end != count and not capture.set(cv2.CAP_PROP_POS_FRAMES, 0):
                    raise RuntimeError("Não foi possível retornar ao início do vídeo")
                frames = []
                for index in range(start, end):
                    ok, image = capture.read()
                    if not ok:
                        raise RuntimeError(f"Vídeo de continuidade terminou no quadro {index}")
                    frames.append(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
                for index in range(end-1, start-1, -1):
                    yield index, frames[index-start]
                end = start
    finally:
        capture.release()


def _direction(frames, poses, accepted, detections, fps, reverse, flow, progress):
    count, joints, _ = poses.shape
    tracks = np.full((count, joints, 2), np.nan)
    anchors = np.full((count, joints), -1, dtype=np.int32)
    residuals = np.full((count, joints), np.nan)
    positions = np.full((joints, 2), np.nan)
    last_anchor = np.full(joints, -1, dtype=np.int32)
    worst_residual = np.zeros(joints)
    previous = None
    expected = count-1 if reverse else 0
    total = 0
    eligible = accepted.sum(axis=0) >= 2
    for index, gray in frames:
        if index != expected:
            raise RuntimeError("Quadros fora de ordem na recuperação visual")
        expected += -1 if reverse else 1
        total += 1
        if progress and (total == 1 or total % 64 == 0 or total == count):
            progress("backward" if reverse else "forward", total, count)
        height, width = gray.shape
        valid = (np.isfinite(positions).all(axis=1) & (last_anchor >= 0) & eligible
                 & (np.abs(index-last_anchor)/fps <= POLICY["maxAnchorDistanceSec"] + 1e-9))
        if not observed(detections[index]):
            valid[:] = False  # No identity continuity through a missing/ambiguous box.
        indices = np.flatnonzero(valid)
        updated = np.full_like(positions, np.nan)
        if previous is not None and len(indices):
            points = positions[indices].astype(np.float32).reshape(-1, 1, 2)
            params = {"winSize": (21, 21), "maxLevel": 3,
                      "criteria": (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, .01)}
            forward, status, error = flow(previous, gray, points, None, **params)
            if forward is not None:
                backward, back_status, _ = flow(gray, previous, forward, None, **params)
                if backward is not None:
                    for n, joint in enumerate(indices):
                        point = forward[n, 0].astype(float)
                        residual = float(np.linalg.norm(backward[n, 0]-points[n, 0]))
                        if (status[n, 0] and back_status[n, 0] and np.isfinite(point).all()
                                and math.isfinite(residual) and math.isfinite(float(error[n, 0]))
                                and residual <= POLICY["maxForwardBackwardErrorPx"]
                                and float(error[n, 0]) <= POLICY["maxPatchError"]
                                and np.linalg.norm(point-positions[joint]) <= .35*box_diagonal(detections[index])
                                and point_usable((*point, .6), detections[index], width, height)):
                            updated[joint] = point
                            worst_residual[joint] = max(worst_residual[joint], residual)
        positions = updated
        for joint in np.flatnonzero(accepted[index] & eligible):
            if point_usable(poses[index, joint], detections[index], width, height):
                positions[joint] = poses[index, joint, :2]
                last_anchor[joint] = index
                worst_residual[joint] = 0.
        active = np.isfinite(positions).all(axis=1)
        tracks[index, active] = positions[active]
        anchors[index, active] = last_anchor[active]
        residuals[index, active] = worst_residual[active]
        previous = gray
    if total != count:
        raise RuntimeError("Quantidade de quadros incompatível na recuperação visual")
    return tracks, anchors, residuals


def recover_points(video, poses, accepted, detections, keypoints, fps, frames=None, flow=None, progress=None):
    poses = np.asarray(poses, dtype=float)
    accepted = np.asarray(accepted, dtype=bool)
    if poses.shape != (len(detections), len(keypoints), 3) or accepted.shape != poses.shape[:2]:
        raise ValueError("Contagens incompatíveis na continuidade da pose")
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("FPS inválido na continuidade da pose")
    selected = poses.copy()
    recovered = np.zeros(accepted.shape, dtype=bool)
    before = np.full(accepted.shape, -1, np.int32)
    after = np.full(accepted.shape, -1, np.int32)
    errors = np.full(accepted.shape, np.nan)
    if np.any(accepted.sum(axis=0) >= 2):
        reader = frames or (lambda reverse: gray_frames(video, len(poses), reverse))
        forward, f_anchor, f_error = _direction(reader(False), poses, accepted, detections, fps, False,
                                                flow or cv2.calcOpticalFlowPyrLK, progress)
        backward, b_anchor, b_error = _direction(reader(True), poses, accepted, detections, fps, True,
                                                 flow or cv2.calcOpticalFlowPyrLK, progress)
        agreement = np.linalg.norm(forward-backward, axis=2)
        for index, joint in np.argwhere(~accepted & np.isfinite(agreement) & (agreement <= POLICY["maxAnchorAgreementPx"])):
            left, right = int(f_anchor[index, joint]), int(b_anchor[index, joint])
            if not left < index < right:
                continue
            selected[index, joint, :2] = (forward[index, joint]+backward[index, joint])/2
            # This is anchor confidence, not a model score for the missing point.
            selected[index, joint, 2] = min(poses[left, joint, 2], poses[right, joint, 2])
            recovered[index, joint] = True
            before[index, joint], after[index, joint] = left, right
            errors[index, joint] = max(f_error[index, joint], b_error[index, joint])
    summary = {**POLICY, "recoveredPointCount": int(recovered.sum()),
               "perKeypoint": {key: int(recovered[:, j].sum()) for j, key in enumerate(keypoints)},
               "likelihoodInterpretation": "minimum_anchor_likelihood_for_recovered_points"}
    return selected, recovered, {"before": before, "after": after, "error": errors, "policy": summary}
