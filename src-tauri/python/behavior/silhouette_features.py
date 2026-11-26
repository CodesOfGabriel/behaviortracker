"""Undirected silhouette geometry, in original-video pixels, computed in Python."""
import math
import cv2 as cv
import numpy as np
from .contracts import SCHEMA


def extract(contour, arena=None):
    if not contour or len(contour) < 3:
        return {}
    points = np.asarray([[p["x"], p["y"]] for p in contour], np.float32)
    if not np.isfinite(points).all():
        return {}
    polygon = points.reshape(-1, 1, 2)
    area, perimeter = cv.contourArea(polygon), cv.arcLength(polygon, True)
    if area <= 0 or perimeter <= 0:
        return {}
    rect = cv.minAreaRect(polygon)
    major, minor = sorted(rect[1], reverse=True)
    hull = cv.contourArea(cv.convexHull(polygon))
    x, y, w, h = cv.boundingRect(polygon)
    values = dict(silhouette_area=area, silhouette_perimeter=perimeter,
                  major_axis_length=major, minor_axis_length=minor,
                  eccentricity=math.sqrt(max(0., 1-(minor/max(major, 1e-9))**2)),
                  circularity=min(1., 4*math.pi*area/perimeter**2), solidity=area/max(hull, 1e-9),
                  extent=area/(w*h), oriented_aspect_ratio=major/max(minor, 1e-9))
    origin = points.min(0)
    factor = float(min(1., 94/float(max(np.ptp(points, axis=0)))))
    local = np.round((points-origin)*factor).astype(np.int32)+1
    mask = np.zeros((int(local[:, 1].max())+2, int(local[:, 0].max())+2), np.uint8)
    cv.fillPoly(mask, [local], 255)
    yy, xx = np.nonzero(mask)
    pixels = np.column_stack((xx, yy)).astype(np.float64)
    if len(pixels) >= 16:
        eigen, vectors = np.linalg.eigh(np.cov(pixels.T))
        direction = vectors[:, -1]
        # Nearly isotropic masks have no stable principal direction; keep axis features missing.
        if eigen[-1] >= 1.15*max(eigen[0], 1e-9):
            projection = pixels @ direction
            cross = pixels @ np.array([-direction[1], direction[0]])
            edges = np.linspace(*np.quantile(projection, [.05, .95]), 8)
            path, widths = [], []
            for low, high in zip(edges, edges[1:]):
                selected = (projection >= low) & (projection <= high)
                section = pixels[selected]
                if not len(section):
                    break
                mean = section.mean(0)
                path.append(section[np.argmin(((section-mean)**2).sum(1))]/factor)
                widths.append(float(np.ptp(cross[selected]))/factor)
            if len(path) == 7:
                path = np.asarray(path)
                delta = np.diff(path, axis=0)
                length = float(np.linalg.norm(delta, axis=1).sum())
                angles = np.arctan2(delta[:, 1], delta[:, 0])
                curvature = float(np.abs(np.angle(np.exp(1j*np.diff(angles)))).sum())
                # Canonical reversal makes the width profile independent of head/tail assignment.
                widths = min(widths, list(reversed(widths)))
                values.update(body_axis_length=length, body_axis_curvature=curvature,
                              body_axis_tortuosity=length/max(float(np.linalg.norm(path[-1]-path[0])), 1e-9),
                              body_width_mean=float(np.mean(widths)), body_width_std=float(np.std(widths)),
                              body_width_profile=widths)
                values.update({f"body_width_{i}": value for i, value in enumerate(widths)})
    floor = (arena or {}).get("cornersPx")
    if floor and len(floor) == 4:
        boundary = np.asarray([[p["x"], p["y"]] for p in floor], np.float32)
        moments = cv.moments(polygon)
        center = (moments["m10"]/moments["m00"], moments["m01"]/moments["m00"])
        values["distance_to_wall"] = float(cv.pointPolygonTest(boundary, center, True))
        floor_mask = np.zeros_like(mask)
        cv.fillPoly(floor_mask, [np.round((boundary-origin)*factor).astype(np.int32)+1], 255)
        inside = int(np.count_nonzero((floor_mask > 0) & (mask > 0)))
        values["wall_overlap_fraction"] = 1-inside/len(pixels)
    return values


def describe(sample, arena=None):
    values = extract(sample.get("contour"), arena)
    values.update(tracking_accepted=float(sample.get("trackingAccepted") is True),
                  silhouette_observed=float(bool(sample.get("contour")) and sample.get("source") == "segmented"))
    return {"schemaVersion": SCHEMA, "values": values,
            "feature_validity_mask": {key: value is not None for key, value in values.items()}}
