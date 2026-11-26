"""Observed body centerline with shape checks and a causal outlier gate.

No anatomical landmarks, interpolation over gaps, or metric approval is created.
The matching TypeScript implementation is src/lib/body-axis.ts.
"""
import math
import cv2 as cv
import numpy as np

VERSION = "body-axis-2"


def angle_delta(value, reference):
    return (value-reference+math.pi/2) % math.pi-math.pi/2


def inside(point, contour):
    x, y = point
    yes = False
    for a, b in zip(contour, [*contour[1:], contour[0]]):
        if (a["y"] > y) != (b["y"] > y) and x < (b["x"]-a["x"])*(y-a["y"])/(b["y"]-a["y"])+a["x"]:
            yes = not yes
    return yes


def measure(contour):
    result = dict(points=[], reason="invalid_contour", angleRad=None, anisotropy=None, areaPx=None, center=None)
    if not contour or len(contour) < 3:
        return result
    points = np.asarray([[p["x"], p["y"]] for p in contour], np.float64)
    if not np.isfinite(points).all():
        return result
    origin, extent = points.min(0), np.ptp(points, axis=0)
    if min(extent) < 3:
        return result
    scale = min(1., 62/max(extent))
    polygon = (points-origin)*scale+1
    w, h = math.ceil(extent[0]*scale)+3, math.ceil(extent[1]*scale)+3
    y, x = np.mgrid[:h, :w]
    mask = np.zeros((h, w), bool)
    for a, b in zip(polygon, np.roll(polygon, -1, axis=0)):
        if a[1] == b[1]:
            continue
        mask ^= ((a[1] > y) != (b[1] > y)) & (x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])
    mask[[0, -1], :] = False; mask[:, [0, -1]] = False
    if np.count_nonzero(mask) < 16:
        return result
    # Chessboard distance is reproducible in the browser and removes thin tails
    # and bridges before estimating the orientation of the thick body core.
    distance = cv.distanceTransform(mask.astype(np.uint8), cv.DIST_C, 3)
    maximum = float(distance.max())
    if maximum < 2:
        return {**result, "reason": "thin_mask"}
    core = distance >= max(1.5, maximum*.35)
    count, labels, stats, _ = cv.connectedComponentsWithStats(core.astype(np.uint8), connectivity=8)
    components = sorted(range(1, count), key=lambda i: int(stats[i, cv.CC_STAT_AREA]), reverse=True)
    if not components:
        return {**result, "reason": "thin_mask"}
    selected = labels == components[0]
    if np.count_nonzero(selected) < .7*np.count_nonzero(core):
        return {**result, "reason": "fragmented_body"}
    yy, xx = np.nonzero(selected)
    pixels = np.column_stack((xx, yy)).astype(np.float64)
    hull_area = cv.contourArea(cv.convexHull(pixels.astype(np.float32))) + np.ptp(xx)+np.ptp(yy)+1
    if len(pixels)/max(1., hull_area) < .8:
        return {**result, "reason": "concave_body"}
    weights = distance[selected].astype(np.float64)**2
    center = np.average(pixels, axis=0, weights=weights)
    delta = pixels-center
    xxvar, yyvar, xyvar = (float(np.sum(weights*delta[:, 0]**2)), float(np.sum(weights*delta[:, 1]**2)),
                            float(np.sum(weights*delta[:, 0]*delta[:, 1])))
    disc = math.hypot(xxvar-yyvar, 2*xyvar)
    major, minor = (xxvar+yyvar+disc)/2, (xxvar+yyvar-disc)/2
    ratio = major/max(1., minor)
    angle = .5*math.atan2(2*xyvar, xxvar-yyvar)
    result.update(angleRad=angle, anisotropy=ratio, areaPx=np.count_nonzero(mask)/(scale*scale),
                  center=dict(x=float((center[0]-1)/scale+origin[0]), y=float((center[1]-1)/scale+origin[1])))
    if ratio < 1.5:
        return {**result, "reason": "ambiguous_orientation"}
    direction = np.array([math.cos(angle), math.sin(angle)])
    # Explicit rounded operations avoid BLAS/FMA differences at section edges.
    projection = np.floor((pixels[:, 0]*direction[0]+pixels[:, 1]*direction[1])*1e9+.5)/1e9
    ordered = np.sort(projection)
    low, high = ordered[int(len(ordered)*.02)], ordered[min(len(ordered)-1, int(len(ordered)*.98))]
    path = []
    for index in range(7):
        part = (projection >= low+(high-low)*index/7) & (projection <= low+(high-low)*(index+1)/7)
        if not np.any(part):
            return {**result, "reason": "incomplete_axis"}
        section = pixels[part]
        target = np.average(section, axis=0, weights=weights[part])
        squared = np.sum((section-target)**2, axis=1)
        # Stable row-major tie break, including equivalent IEEE rounding in JS.
        nearest = section[np.flatnonzero(squared <= float(squared.min())+1e-9)[0]]
        p = (nearest-1)/scale+origin
        path.append(dict(x=float(p[0]), y=float(p[1])))
    for a, b in zip(path, path[1:]):
        if not all(inside((a["x"]+(b["x"]-a["x"])*i/16, a["y"]+(b["y"]-a["y"])*i/16), contour) for i in range(17)):
            return {**result, "reason": "disconnected_axis"}
    return {**result, "points": path, "reason": "ok"}


def drawable(sample):
    if "presence" in sample and sample["presence"] != "IN_TANK":
        return False
    if not sample.get("bbox") or sample.get("source") in {"predicted", "recovered", "manual"} or sample.get("status") in {"missing", "out_of_arena", "jump"}:
        return False
    reasons = set((sample.get("localQuality") or {}).get("reasons", [])) | {sample.get("reason", "")}
    rejected = ("camera_shift", "silhouette_clipped", "ambiguous_candidates", "identity_pending", "reacquisition_pending", "appearance_changed", "researcher_intervention")
    return not any(any(reason.endswith(tag) or reason.startswith(tag) for tag in rejected) for reason in reasons if isinstance(reason, str))


class BodyAxisFilter:
    def __init__(self):
        self.history = []
        self.pending = None
        self.last_seen = None

    def update(self, sample, measurement=None):
        frame, time = sample["frameIndex"], sample["timestampSec"]
        if self.last_seen and (frame != self.last_seen[0]+1 or not 0 < time-self.last_seen[1] <= .25):
            self.history, self.pending = [], None
        self.last_seen = (frame, time)
        base = dict(schemaVersion=VERSION, frameIndex=frame, timestampSec=time, points=[], state="missing", reason="unobserved",
                    rawAngleRad=None, angleRad=None, anisotropy=None, filtered=False, anatomicalPose=False)
        if not drawable(sample):
            self.history, self.pending = [], None
            return base
        contour = sample.get("bodyAxisContour", sample.get("contour"))
        measured = measurement if measurement is not None else measure(contour)
        base.update(rawAngleRad=measured["angleRad"], anisotropy=measured["anisotropy"])
        if not measured["points"]:
            self.history, self.pending = [], None
            reason = "unsupported_current_image" if "bodyAxisContour" in sample and not contour else measured["reason"]
            return {**base, "state": "ambiguous", "reason": reason}
        angle, area = measured["angleRad"], measured["areaPx"]
        self.history = [old for old in self.history[-7:] if time-old["time"] <= .3]
        old = self.history[-1] if self.history else None
        reason = None
        if old:
            velocities = [angle_delta(b["angle"], a["angle"])/(b["time"]-a["time"]) for a, b in zip(self.history, self.history[1:])]
            velocity = float(np.median(velocities[-3:])) if velocities else 0.
            velocity = max(-math.pi*4, min(math.pi*4, velocity))
            innovation = abs(angle_delta(angle, old["angle"]+velocity*(time-old["time"])))
            residuals = [abs(angle_delta(b["angle"], a["angle"])) for a, b in zip(self.history, self.history[1:])]
            noise = float(np.median(residuals)) if residuals else 0.
            median_area = float(np.median([row["area"] for row in self.history]))
            if innovation > max(math.radians(35), min(math.radians(65), noise*3)):
                reason = "orientation_outlier"
            elif not .55 <= area/median_area <= 1.8:
                reason = "area_outlier"
            elif math.dist(tuple(measured["center"].values()), tuple(old["center"].values())) > 1.25*math.sqrt(median_area):
                reason = "position_outlier"
        confirmed = False
        if reason:
            p = self.pending
            consistent = (p and p["reason"] == reason and abs(angle_delta(angle, p["angle"])) < math.radians(20)
                          and .7 <= area/p["area"] <= 1.4
                          and math.dist(tuple(measured["center"].values()), tuple(p["center"].values())) <= 1.25*math.sqrt(area))
            if not consistent:
                self.pending = dict(angle=angle, area=area, center=measured["center"], reason=reason, time=time, count=1)
            else:
                self.pending["count"] += 1
                confirmed = self.pending["count"] >= 2 and time-self.pending["time"] >= .08-1e-6
            if not confirmed:
                return {**base, "state": "outlier", "reason": reason}
            self.history = []
        self.pending = None
        smoothed = angle
        if old and not confirmed:
            change = angle_delta(angle, old["filteredAngle"])
            # Bound the lag to eight degrees; a filter cannot keep the old axis
            # perpendicular to a clear new observation.
            smoothed = angle-max(-math.radians(8), min(math.radians(8), change*.25))
        points = measured["points"]
        rotation = angle_delta(smoothed, angle)
        if abs(rotation) > 1e-6:
            center = measured["center"]
            c, s = math.cos(rotation), math.sin(rotation)
            rotated = [dict(x=center["x"]+(p["x"]-center["x"])*c-(p["y"]-center["y"])*s,
                            y=center["y"]+(p["x"]-center["x"])*s+(p["y"]-center["y"])*c) for p in points]
            supported = all(inside((a["x"]+(b["x"]-a["x"])*i/16, a["y"]+(b["y"]-a["y"])*i/16), contour)
                            for a, b in zip(rotated, rotated[1:]) for i in range(17))
            if supported:
                points = rotated
            else:
                smoothed = angle
        self.history.append(dict(angle=angle, filteredAngle=smoothed, time=time, area=area, center=measured["center"]))
        return {**base, "points": points, "angleRad": smoothed, "state": "reliable",
                "reason": "change_confirmed" if confirmed else "ok", "filtered": abs(angle_delta(smoothed, angle)) > 1e-6}


def appearance_contour(lab, component, reference, shift, chroma_shift, scale, offset):
    """Axis-only support in current pixels; rejects ghosts from background subtraction.

    The frozen body color comes from the tracker. This never changes its boxes,
    raw silhouette, position metrics, or existing behavioral feature schema.
    """
    evidence = dict(method="frozen_body_color_v1", supported=False, supportFraction=0.)
    if reference is None or cv.countNonZero(component) < 16:
        return [], evidence
    delta = (lab.astype(np.float32)-np.asarray([shift, *chroma_shift], np.float32)-reference)*[.5, 1., 1.]
    supported = np.uint8((component > 0) & (np.linalg.norm(delta, axis=2) <= 45))*255
    supported = cv.morphologyEx(supported, cv.MORPH_OPEN, np.ones((3, 3), np.uint8))
    supported = cv.morphologyEx(supported, cv.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    supported = cv.bitwise_and(supported, component)
    contours = sorted(cv.findContours(supported, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)[0], key=cv.contourArea, reverse=True)
    if not contours:
        return [], evidence
    largest = cv.contourArea(contours[0])
    fraction = float(largest/cv.countNonZero(component))
    evidence["supportFraction"] = fraction
    if fraction < .3 or largest < 16 or (len(contours) > 1 and cv.contourArea(contours[1]) > .3*largest):
        return [], evidence
    path = cv.approxPolyDP(contours[0], .75, True)
    evidence["supported"] = True
    return [dict(x=float((p[0][0]+offset[0])/scale), y=float((p[0][1]+offset[1])/scale)) for p in path], evidence
