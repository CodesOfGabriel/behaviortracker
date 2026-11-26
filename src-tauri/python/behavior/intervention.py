"""Conservative, latched stop for a large external intrusion into Open Field.

This is a foreground/arena guard, not a semantic human-hand detector. It also
stops for other large intrusions, irrespective of skin colour or gloves.
"""
import cv2 as cv
import numpy as np


class InterventionGuard:
    def __init__(self, config, background):
        if background.shape[1] > 320:
            background = cv.resize(background, (320, round(background.shape[0]*320/background.shape[1])))
        self.size = (background.shape[1], background.shape[0])
        scale = np.array([self.size[0]/config["width"], self.size[1]/config["height"]])
        self.coordinate_area_scale = float(np.prod(scale))
        from arena import open_field_tracking_polygon
        points = np.asarray(open_field_tracking_polygon(config["arena"], config["width"], config["height"])) * scale
        self.roi = np.zeros(background.shape[:2], np.uint8)
        cv.fillPoly(self.roi, [np.round(points).astype(np.int32)], 255)
        radius = max(3, round(min(self.size)*.025))
        kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, (2*radius+1, 2*radius+1))
        self.interior = cv.erode(self.roi, kernel) > 0
        self.outside = cv.dilate(self.roi, kernel) == 0
        # A calibrated arena may fill the image; the frame boundary is also an
        # entry boundary, even when no pixels outside the arena are visible.
        self.outside[[0, -1], :] = True
        self.outside[:, [0, -1]] = True
        self.area = np.count_nonzero(self.roi)
        if not self.area or not np.any(self.interior):
            raise ValueError("Arena pequena demais para verificar a entrada do pesquisador")
        self.background = cv.cvtColor(cv.GaussianBlur(background, (5, 5), 0), cv.COLOR_BGR2LAB).astype(np.float32)
        self.body_areas = []
        self.pending = None
        self.stopped = None
        self.last_evidence = None

    def update(self, frame, timestamp, observation=None):
        if self.stopped is not None:
            return self.stopped
        view = cv.resize(frame, self.size)
        lab = cv.cvtColor(cv.GaussianBlur(view, (5, 5), 0), cv.COLOR_BGR2LAB).astype(np.float32)
        residual = lab-self.background
        shift = np.median(residual[self.interior][::16], axis=0)
        delta = residual-shift
        foreground = (np.abs(delta[:, :, 0]) > 25) | (np.linalg.norm(delta[:, :, 1:], axis=2) > 15)
        mask = cv.morphologyEx(foreground.astype(np.uint8), cv.MORPH_OPEN, np.ones((3, 3), np.uint8))
        count, labels, stats, _ = cv.connectedComponentsWithStats(mask)
        body_area = float(np.median(self.body_areas)) if self.body_areas else self.area*.012
        evidence = None
        for index in range(1, count):
            if stats[index, cv.CC_STAT_AREA] < self.area*.035:
                continue
            component = labels == index
            inside = np.count_nonzero(component & self.interior)
            outside = np.count_nonzero(component & self.outside)
            if inside >= max(self.area*.035, body_area*2.8) and outside >= self.area*.0005:
                evidence = dict(insideAreaFraction=inside/self.area, outsideAreaFraction=outside/self.area,
                                bodyAreaRatio=inside/max(1., body_area))
                break
        if evidence is not None:
            if self.pending is None:
                self.pending = timestamp
            self.last_evidence = evidence
            if timestamp-self.pending >= .08-1e-6:
                self.stopped = dict(reason="researcher_intervention", timestampSec=self.pending,
                    confirmedAtSec=timestamp, method="boundary_connected_foreground_v1", **evidence)
                return self.stopped
        else:
            self.pending = None
            if observation and observation.get("trackingAccepted") and observation.get("contour"):
                points = np.asarray([[p["x"], p["y"]] for p in observation["contour"]], np.float32)
                area = cv.contourArea(points)*self.coordinate_area_scale
                if 0 < area < self.area*.06:
                    self.body_areas.append(area)
                    self.body_areas = self.body_areas[-240:]
        return None

    def suppress(self, observation):
        if self.pending is None and self.stopped is None:
            return observation
        reason = "researcher_intervention" if self.stopped else "researcher_intervention_pending"
        return dict(xPx=None, yPx=None, source="segmented", status="missing", reason=reason,
                    spatialRegion="unknown", trackingAccepted=False, kalmanUpdated=False,
                    behaviorObservation="UNOBSERVED", localQuality=dict(tracking="missing", geometry="unknown",
                    identity="unverified", reasons=[reason]))


def scan(request, samples):
    """Apply the same guard to legacy tracking without changing the saved run."""
    from .open_field import read_frames
    from pathlib import Path
    background = cv.imread(str(Path(request["trackingDirectory"])/"background-reference.png"))
    if background is None:
        raise ValueError("Refaça o tracking OpenCV para detectar a entrada do pesquisador")
    guard = InterventionGuard(request["config"], background)
    config = request["config"]
    capture = read_frames(request["video"], request["ffmpeg"], config["width"], config["height"],
                          config.get("autorotate", False), output_size=guard.size)
    try:
        for row in samples:
            frame = next(capture, None)
            if frame is None:
                raise ValueError("Vídeo e tracking divergiram ao verificar a intervenção")
            termination = guard.update(frame, row["timestampSec"], row)
            if termination:
                return termination
        if next(capture, None) is not None:
            raise ValueError("Tracking incompleto ao verificar a intervenção")
        return None
    finally:
        capture.close()
