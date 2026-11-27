"""Auditable rearing proposals from observed geometry, never confirmed behavior.

No image vertical-axis test, smoothed/display pose, learned probability, or
human annotation is used as geometric evidence. All thresholds are provisional.
"""
import hashlib
import json
from pathlib import Path

import cv2 as cv
import numpy as np

from body_axis import BodyAxisFilter
from .observation_quality import behavior_observation_quality

VERSION = "oft-rearing-evidence-1"
POLICY = dict(minimumEpisodeSec=.20, maximumGapSec=.12, transitionWindowSec=1.2,
              minimumBaselineSec=2., scoreKind="heuristic_score",
              probabilityCalibrated=False, scientificallyValidated=False,
              metricEligible=False, durationMeasured=False)
BLOCKED = ("researcher_intervention", "camera_shift", "ambiguous_candidates", "identity_pending",
           "reacquisition_pending", "silhouette_clipped", "appearance_changed", "reflection",
           "outside_floor_candidate", "shape_inconsistent")


def xy(point):
    return np.asarray([point["x"], point["y"]], float)


def bounded(value):
    return float(np.clip(value, 0., 1.))


def measure(row, arena, axis_filter):
    """Read current contour/raw centerline; never substitute a display estimate."""
    reasons = set((row.get("localQuality") or {}).get("reasons", [])) | {row.get("reason", "")}
    if any(tag in reason for reason in reasons if isinstance(reason, str) for tag in BLOCKED):
        return None, "tracking_rejected"
    if behavior_observation_quality(row) != "OBSERVED":
        return None, "tracking_unobserved"
    support = (row.get("reflectionGuard") or {}).get("bodySupportFraction")
    if support is not None and (not isinstance(support, (int, float)) or not np.isfinite(support) or support < .45):
        return None, "reflection_unsupported"
    if "bodyAxisContour" in row and not row["bodyAxisContour"]:
        return None, "body_pixels_missing"
    contour = row.get("contour")
    if not contour or len(contour) < 3:
        return None, "silhouette_missing"
    axis = row.get("bodyAxis")
    if axis is None:
        axis = axis_filter.update(row)
    if axis.get("state") in {"outlier", "missing"}:
        return None, "axis_unreliable"
    observed_axis = axis.get("state") == "reliable" and len(axis.get("points", [])) == 7
    points = np.asarray([xy(p) for p in contour], np.float32)
    body = np.asarray([xy(p) for p in (row.get("bodyAxisContour") or contour)], np.float32)
    path = np.asarray([xy(p) for p in axis.get("points", [])])
    if not np.isfinite(points).all() or not np.isfinite(body).all() or not np.isfinite(path).all():
        return None, "geometry_invalid"
    area = float(cv.contourArea(body))
    hull = float(cv.contourArea(cv.convexHull(body)))
    major, minor = sorted(cv.minAreaRect(body)[1], reverse=True)
    length = float(np.linalg.norm(np.diff(path, axis=0), axis=1).sum()) if observed_axis else major
    chord = float(np.linalg.norm(path[-1]-path[0])) if observed_axis else major
    if min(area, minor, length, chord) <= 0 or area/max(hull, 1.) < .65:
        return None, "silhouette_inconsistent"
    # A centerline crossing background is not evidence of a shortened spine.
    if any(cv.pointPolygonTest(points, tuple(map(float, p)), False) < 0 for p in path):
        return None, "axis_outside_silhouette"
    tortuosity = length/chord
    if tortuosity > 1.25:
        return None, "curled_body"
    moments = cv.moments(body)
    center = path.mean(axis=0) if observed_axis else np.array([moments["m10"]/moments["m00"], moments["m01"]/moments["m00"]])
    floor = (arena or {}).get("cornersPx")
    overlap, distance, wall_head = None, None, False
    if floor and len(floor) == 4:
        boundary = np.asarray([xy(p) for p in floor], np.float32)
        distance = float(cv.pointPolygonTest(boundary, tuple(center), True))
        # Small silhouette raster keeps concave masks/tails out of a hull proxy.
        origin = points.min(0); scale = min(1., 64/max(np.ptp(points, axis=0)))
        local = np.rint((points-origin)*scale).astype(np.int32)+1
        mask = np.zeros((int(local[:, 1].max())+3, int(local[:, 0].max())+3), np.uint8)
        cv.fillPoly(mask, [local], 1)
        floor_mask = np.zeros_like(mask)
        cv.fillPoly(floor_mask, [np.rint((boundary-origin)*scale).astype(np.int32)+1], 1)
        overlap = float(np.count_nonzero(mask & floor_mask)/max(1, np.count_nonzero(mask)))
        orientation = (row.get("oftLayers") or {}).get("orientation") or {}
        if observed_axis and orientation.get("source") == "tail_silhouette" and orientation.get("head") and orientation.get("tailBase"):
            head, tail = xy(orientation["head"]), xy(orientation["tailBase"])
            head_distance = cv.pointPolygonTest(boundary, tuple(head), True)
            tail_distance = cv.pointPolygonTest(boundary, tuple(tail), True)
            # Wall contact never determines anatomical direction. Require a
            # current-image tail anchor, plausible support and head pixels.
            wall_head = bool(head_distance < -.04*length and tail_distance >= -.15*length
                             and cv.pointPolygonTest(points, tuple(head), True) >= -.03*length
                             and min(np.linalg.norm(tail-path[0]), np.linalg.norm(tail-path[-1])) < .25*length)
    return dict(axisLength=length if observed_axis else None, majorLength=major, axisObserved=observed_axis,
                area=area, aspect=major/minor, tortuosity=tortuosity,
                center=center, floorOverlap=overlap, wallDistance=distance, headOnWall=wall_head), None


def analyze(rows, config):
    if config.get("protocol") != "open_field":
        raise ValueError("Propostas geométricas disponíveis apenas para Campo Aberto")
    times = np.asarray([r["timestampSec"] for r in rows], float)
    indices = [r["frameIndex"] for r in rows]
    if not np.isfinite(times).all() or np.any(times < 0) or any(b <= a for a, b in zip(times, times[1:])) or indices != list(range(len(rows))):
        raise ValueError("Tracking deve preservar a sequência de quadros e timestamps")
    stop = next((i for i, r in enumerate(rows) if r.get("reason") == "researcher_intervention"), len(rows))
    measurements, predictions, segments = [], [], []
    axis_filter, segment, previous_valid = BodyAxisFilter(), 0, False
    for i, row in enumerate(rows):
        value, reason = measure(row, config.get("arena"), axis_filter) if i < stop else (None, "researcher_intervention")
        if value is None or not previous_valid or i and times[i]-times[i-1] > .25:
            segment += 1
            axis_filter = BodyAxisFilter()
        segments.append(segment)
        previous_valid = value is not None
        measurements.append(value)
        predictions.append(dict(frameIndex=row["frameIndex"], timestampSec=float(times[i]), classification="UNKNOWN",
            score=None, scoreKind="heuristic_score", verification="insufficient", reasons=[reason or "baseline_unavailable"],
            reviewStatus="pending", metricEligible=False))
    # Extended, floor-supported observed postures define this video's scale.
    floor = [m for m in measurements if m and m["axisObserved"] and m["aspect"] >= 1.6 and m["tortuosity"] < 1.12
             and (m["floorOverlap"] is None or m["floorOverlap"] >= .97)]
    baseline = None
    if len(floor) >= 12 and len(times) and times[min(stop, len(times))-1]-times[0] >= POLICY["minimumBaselineSec"]:
        cutoff = np.quantile([m["axisLength"] for m in floor], .4)
        extended = [m for m in floor if m["axisLength"] >= cutoff]
        baseline = {k: float(np.median([m[k] for m in extended])) for k in ("axisLength", "majorLength", "area", "aspect")}
    eligible = np.zeros(len(rows), bool)
    if baseline:
        for i, m in enumerate(measurements):
            if m is None:
                continue
            prediction = predictions[i]
            length_key = "axisLength" if m["axisObserved"] else "majorLength"
            axis_ratio = m[length_key]/baseline[length_key]
            area_ratio, aspect_ratio = (m[k]/baseline[k] for k in ("area", "aspect"))
            if not .35 <= area_ratio <= 1.8 or not .35 <= axis_ratio <= 1.8:
                prediction["reasons"] = ["geometry_outlier"]
                continue
            lo, hi = np.searchsorted(times, [times[i]-.16, times[i]+.16])
            neighbors = [j for j in range(lo, min(hi, len(rows))) if segments[j] == segments[i] and measurements[j]]
            speed = 0.
            if len(neighbors) >= 2:
                a, b = neighbors[0], neighbors[-1]
                speed = float(np.linalg.norm(measurements[b]["center"]-measurements[a]["center"])/(times[b]-times[a])/baseline["axisLength"])
            lo, hi = np.searchsorted(times, [times[i]-POLICY["transitionWindowSec"], times[i]+POLICY["transitionWindowSec"]])
            transition = any(segments[j] == segments[i] and measurements[j] and measurements[j].get(length_key) is not None
                             and measurements[j][length_key] >= baseline[length_key]*.9
                             and measurements[j][length_key] >= m[length_key]*1.15 for j in range(lo, min(hi, len(rows))))
            short, compact, stationary = axis_ratio <= .8, aspect_ratio <= .85, speed <= 1.2
            wall = m["headOnWall"] and m["floorOverlap"] is not None and .25 <= m["floorOverlap"] <= .97
            shape = short and compact and .45 <= area_ratio <= .95 and transition
            eligible[i] = stationary and (wall or shape)
            reasons = []
            if short: reasons.append("shortened_axis" if m["axisObserved"] else "shortened_silhouette")
            if not m["axisObserved"]: reasons.append("axis_unresolved")
            if compact: reasons.append("compact_silhouette")
            if wall: reasons.append("image_supported_head_on_wall")
            if transition: reasons.append("posture_transition")
            if stationary: reasons.append("low_displacement")
            if not (wall or shape): reasons.append("insufficient_corroboration")
            if not stationary: reasons.append("locomotion")
            score = .3*bounded((1-axis_ratio)/.35)+.15*bounded((1-aspect_ratio)/.4)+.1*bounded((1-area_ratio)/.4)+.3*wall+.1*stationary+.05*transition
            prediction.update(score=round(float(score), 5), reasons=reasons,
                evidence=dict(axisLengthRatio=round(axis_ratio, 4) if m["axisObserved"] else None,
                    silhouetteLengthRatio=round(m["majorLength"]/baseline["majorLength"], 4), silhouetteAreaRatio=round(area_ratio, 4),
                    aspectRatio=round(aspect_ratio, 4), speedBodyLengthsSec=round(speed, 4),
                    headOnWall=wall, floorOverlap=m["floorOverlap"]),
                verification="limited" if eligible[i] else "insufficient")
    candidates = []
    # No episode bridges unobserved/outlier frames, source gaps, or intervention.
    runs = []
    for i in np.flatnonzero(eligible):
        i = int(i)
        if (runs and segments[i] == segments[runs[-1][-1]] and times[i]-times[runs[-1][-1]] <= POLICY["maximumGapSec"]
                and not any(predictions[j]["reasons"] == ["geometry_outlier"] for j in range(runs[-1][-1]+1, i))):
            runs[-1].append(i)
        else:
            runs.append([i])
    for run in runs:
        a, b = run[0], run[-1]
        if times[b]-times[a] < POLICY["minimumEpisodeSec"]-1e-6 or len(run)/(b-a+1) < .7:
            continue
        peak = max(run, key=lambda j: (predictions[j]["score"], -j))
        proposal = predictions[peak]
        wall_frames = [j for j in run if predictions[j]["evidence"]["headOnWall"]]
        verified = len(wall_frames) >= .7*len(run) and times[wall_frames[-1]]-times[wall_frames[0]] >= POLICY["minimumEpisodeSec"]-1e-6
        candidates.append(dict(proposal, classification="REARING_UNSPECIFIED", label="REARING_UNSPECIFIED", source="geometry_candidate", observation="OBSERVED",
                               verification="consistent" if verified else "limited",
                               startSec=float(times[a]), endSec=float(times[b]), boundariesEstimated=True))
        for j in run:
            predictions[j]["classification"] = "REARING_UNSPECIFIED"
            predictions[j]["verification"] = "consistent" if verified else "limited"
    return dict(version=VERSION, state="proposed" if baseline else "insufficient_evidence", policy=POLICY,
                baseline=baseline, candidates=candidates, scientificallyValidated=False, metricEligible=False, durationMeasured=False,
                trackingTermination=dict(frameIndex=rows[stop]["frameIndex"], timestampSec=float(times[stop])) if stop < len(rows) else None,
                message="Propostas por silhueta, eixo corporal, parede e continuidade; confirme no vídeo. Limites são estimados."
                if baseline else "Tracking observado insuficiente para estimar a postura de referência; revise o vídeo ou execute novamente o tracking."), predictions


def run(request_path, output_path):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    data = Path(request["samples"]).read_bytes()
    rows = [json.loads(s) for s in data.splitlines()]
    report, predictions = analyze(rows, request["config"])
    destination = Path(output_path)
    report["samplesSha256"] = hashlib.sha256(data).hexdigest()
    report["videoSha256"] = request.get("videoSha256")
    if "annotations" in request:
        from .export_dataset import active_annotations
        from .peak_model import match_peaks
        history = [a for a in request["annotations"] if a.get("videoSha256") == request.get("videoSha256")
                   and a.get("trackingJobId") == request.get("trackingJobId")]
        _, peaks = active_annotations(history)
        peaks = [p for p in peaks if p.get("label", "").startswith("REARING_")]
        report["annotationComparison"] = dict(match_peaks([c["timestampSec"] for c in report["candidates"]], [p["timestampSec"] for p in peaks]),
            annotatedPeaks=len(peaks), annotationsUsedForDetection=False, independentValidation=False,
            message="Concordância com os ápices salvos neste vídeo, com tolerância de 0,5 s; propostas sem correspondência exigem revisão.")
    destination.write_text(json.dumps(report, allow_nan=False), encoding="utf-8")
    destination.with_name("evidence_predictions.jsonl").write_text("".join(json.dumps(p, allow_nan=False)+"\n" for p in predictions), encoding="utf-8")
