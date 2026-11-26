"""Low-resolution flow; translation is removed before internal-motion measurement."""
import cv2 as cv
import numpy as np


class MotionFeatures:
    def __init__(self, method="farneback", reference_dimensions=None):
        if method not in {"farneback", "lk"}:
            raise ValueError("Unknown flow method")
        self.method, self.previous = method, None
        self.reference_dimensions = reference_dimensions or {}

    def extract(self, crop, sample, observation, spatial_side):
        result = {}
        if crop is None or observation != "OBSERVED":
            self.previous = None
            return result
        gray = cv.cvtColor(cv.resize(crop, (96, 96)), cv.COLOR_RGB2GRAY)
        mask = np.zeros((96, 96), np.uint8)
        roi = sample.get("classificationCrop")
        contour = sample.get("contour")
        if roi and contour:
            points = np.asarray([[(p["x"]-roi["x"])*96/roi["width"],
                                  (p["y"]-roi["y"])*96/roi["height"]] for p in contour], np.int32)
            cv.fillPoly(mask, [points], 255)
        box = sample["bbox"]
        center = np.array([box["x"]+box["width"]/2, box["y"]+box["height"]/2])
        timestamp = sample["timestampSec"]
        if self.previous:
            old_gray, old_mask, old_center, old_time, old_speed, old_values = self.previous
            dt = timestamp-old_time
            if 0 < dt <= .2:
                speed = float(np.linalg.norm(center-old_center))/dt
                result["centroid_velocity"] = speed
                if old_speed is not None:
                    result["centroid_acceleration"] = (speed-old_speed)/dt
                for key, source in (("relative_area_change", "silhouette_area"), ("relative_length_change", "body_axis_length"), ("relative_width_change", "body_width_mean")):
                    a, b = sample["values"].get(source), old_values.get(source)
                    reference = self.reference_dimensions.get(source)
                    if a is not None and b is not None and reference is not None and reference > 0:
                        result[key] = (a-b)/reference
                flow = None
                if self.method == "lk":
                    points = cv.goodFeaturesToTrack(old_gray, 80, .01, 3, mask=old_mask)
                    if points is not None:
                        new, ok, _ = cv.calcOpticalFlowPyrLK(old_gray, gray, points, None)
                        if new is not None:
                            flow = (new-points)[ok.ravel() == 1].reshape(-1, 2)
                elif np.any(old_mask):
                    dense = cv.calcOpticalFlowFarneback(old_gray, gray, None, .5, 2, 15, 2, 5, 1.1, 0)
                    flow = dense[old_mask > 0]
                if flow is not None and len(flow) >= 5 and np.isfinite(flow).all():
                    # Crops already follow translation; remove residual translation as well.
                    magnitude = np.linalg.norm(flow, axis=1)*spatial_side/96/dt
                    residual = flow-np.median(flow, axis=0)
                    result.update(optical_flow_mean=float(magnitude.mean()), optical_flow_p90=float(np.quantile(magnitude, .9)),
                                  internal_motion=float(np.linalg.norm(residual, axis=1).mean())*spatial_side/96/dt)
        self.previous = (gray, mask, center, timestamp, result.get("centroid_velocity"), dict(sample["values"]))
        return result
