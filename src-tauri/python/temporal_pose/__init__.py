"""Shared offline display refinement for local and Colab Open Field runs.

Only oftLayers.visualization changes. Raw poses, floor references, behavior
labels and metric eligibility retain their original values.
"""
import math
import cv2 as cv
import numpy as np
from .orientation_viterbi import decode
from .kalman_smoother import smooth

VERSION = "offline_pose_v2"


def _array(values):
    return np.array([[p["x"], p["y"]] for p in values], float)


def _point(value):
    return dict(x=float(value[0]), y=float(value[1]))


def _evidence(row, path):
    layers = row["oftLayers"]
    item = layers.get("orientationEvidence") or layers.get("orientation", {})
    if item.get("source") != "tail_silhouette" or not item.get("tailTip"):
        return None
    head, tail, tip = _array([item["head"], item["tailBase"], item["tailTip"]])
    length = max(5., np.linalg.norm(path[-1]-path[0]))
    ratio = np.linalg.norm(tip-tail)/length
    # Long connected tails carry more evidence than short paw/whisker-like
    # appendages. Repeated weak evidence can still be contradicted by future.
    return head-tail, float(np.clip(ratio, .1, 1.5) * 2.)


def _segments(rows):
    current = []
    for i, row in enumerate(rows):
        v = row.get("oftLayers", {}).get("visualization") or {}
        valid = v.get("state") == "estimated" and len(v.get("points", [])) == 7
        if current and (not valid or not 0 < row["timestampSec"]-rows[current[-1]]["timestampSec"] <= .25):
            yield current; current = []
        if valid:
            current.append(i)
    if current:
        yield current


def refine(rows, cancelled=lambda: False):
    """Viterbi + bounded RTS smoothing with silhouette projection and auditing."""
    changed = 0
    # Never carry a frozen skeleton indefinitely through an absent image.
    missing_since = None
    stopped = False
    for row in rows:
        v = row.get("oftLayers", {}).get("visualization")
        if not v:
            continue
        reason = row.get("reason")
        stopped |= reason in {"researcher_intervention", "animal_removed"}
        if stopped or reason in {"researcher_intervention_pending", "occluded", "camera_shift"}:
            state = "stopped" if stopped else "suspended" if reason == "researcher_intervention_pending" else "unavailable"
            v.update(state=state, source=None, points=[], head=None, tailBase=None,
                     box=None, orientationSource="unknown", ageSec=None, supportScore=0.)
        if v.get("source") in {"held_estimate", "optical_flow"}:
            if missing_since is None:
                missing_since = row["timestampSec"]
            limit = .25 if v["source"] == "held_estimate" else 2.
            if row["timestampSec"]-missing_since > limit:
                v.update(state="unavailable", source=None, points=[], head=None, tailBase=None,
                         box=None, orientationSource="unknown", ageSec=None, supportScore=0.)
        else:
            missing_since = None
        v["temporal"] = dict(version=VERSION, orientationState="unknown", margin=0., uncertaintyPx=None,
                             metricEligible=False)
        v["metricEligible"] = False
    for indices in _segments(rows):
        if cancelled():
            raise InterruptedError("Refinamento temporal cancelado")
        subset = [rows[i] for i in indices]
        visuals = [r["oftLayers"]["visualization"] for r in subset]
        paths = [_array(v["points"]) for v in visuals]
        times = np.array([r["timestampSec"] for r in subset])
        evidence = [_evidence(r, p) for r, p in zip(subset, paths)]
        motions = []
        for row in subset:
            matrix = (row["oftLayers"].get("temporalEvidence") or {}).get("flowMatrix")
            motions.append(np.array(matrix, float) if matrix is not None else None)
        states, margins, directions = decode(paths, times, evidence, motions, return_direction=True)
        # Geometric point order has no anatomical identity. Align it before
        # smoothing even on unknown frames; do not reverse raw bodyAxis.
        aligned = []
        for j, path in enumerate(paths):
            if directions[j] == 0:
                path = path[::-1].copy()
            aligned.append(path)
        lengths = [np.linalg.norm(p[-1]-p[0]) for p in aligned]
        length = max(5., float(np.median(lengths)))
        variances = [(length*(.015 if v["source"] == "observed_geometry" else .05 if v["source"] == "current_silhouette" else .15))**2 for v in visuals]
        smoothed, uncertainty = smooth(aligned, times, variances, length)
        anchors = [j for j, (state, item) in enumerate(zip(states, evidence)) if state != 2 and item is not None
                   and np.dot(aligned[j][-1]-aligned[j][0], item[0]) > 0]
        nearest = np.full(len(indices), -1, int)
        if anchors:
            # Linear forward/backward nearest anchor pass, bounded memory.
            anchors = np.array(anchors); insertion = np.searchsorted(times[anchors], times)
            before = anchors[np.maximum(0, insertion-1)]
            after = anchors[np.minimum(len(anchors)-1, insertion)]
            nearest = np.where(np.abs(times-times[before]) <= np.abs(times-times[after]), before, after)
        for j, (row, v) in enumerate(zip(subset, visuals)):
            if j % 128 == 0 and cancelled():
                raise InterruptedError("Refinamento temporal cancelado")
            path = smoothed[j]
            # Bound displacement relative to this frame; smoothing cannot move
            # a point outside the animal's currently observed foreground.
            displacement = path-aligned[j]
            maximum = max(1., lengths[j]*.08)
            path = aligned[j] + displacement * np.minimum(1., maximum/np.maximum(1e-9, np.linalg.norm(displacement, axis=1)))[:, None]
            contour = row.get("bodyAxisContour") or row.get("contour")
            if contour and row.get("source") == "segmented":
                polygon = _array(contour).astype(np.float32)
                for k, point in enumerate(path):
                    if cv.pointPolygonTest(polygon, tuple(map(float, point)), False) < 0:
                        path[k] = aligned[j][k]
            v["points"] = [_point(p) for p in path]
            anchor = int(nearest[j])
            if states[j] != 2 and anchor >= 0:
                from oft_layers import head_location
                head, tail = path[-1], path[0]
                if row.get("contour") and row.get("source") == "segmented":
                    head = head_location(row["contour"], head, tail)
                v.update(head=_point(head), tailBase=_point(tail), orientationSource="bidirectional_recovery",
                         ageSec=float(abs(times[j]-times[anchor])))
                v["temporal"].update(orientationState="estimated", anchorFrameIndex=subset[anchor]["frameIndex"])
                v.pop("directionAnchorFrameIndex", None)
                v["supportScore"] = float(min(1., margins[j]/6)*math.exp(-v["ageSec"]/5))
            else:
                v.update(head=None, tailBase=None, orientationSource="unknown", supportScore=0.)
            v["temporal"].update(margin=float(margins[j]), uncertaintyPx=float(uncertainty[j]))
            changed += 1
    return changed
