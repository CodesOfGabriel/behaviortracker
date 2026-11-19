"""Segmentação local, sem redes neurais, com observação e previsão separadas.

O centro da caixa não é centro anatômico nem ponto de contato com o piso.
Fundo e limiar são estáticos: um animal imóvel não é absorvido pelo fundo.
"""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

VERSION = "opencv-box-5"


def write_json(path, value):
    temporary = Path(str(path) + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, path)


def timestamps(video, ffprobe):
    child = subprocess.Popen([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_frames",
                              "-show_entries", "frame=best_effort_timestamp_time", "-of", "compact=p=1:nk=0", video],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    previous = None
    origin = None
    try:
        for line in child.stdout:
            if not line.startswith("frame|"):
                continue
            fields = dict(field.split("=", 1) for field in line.strip().split("|")[1:] if "=" in field)
            value = float(fields.get("best_effort_timestamp_time", "nan"))
            if not math.isfinite(value) or (previous is not None and value <= previous):
                raise ValueError("Timestamps ausentes ou não crescentes; análise interrompida para preservar sincronização")
            origin = value if origin is None else origin
            previous = value
            yield value - origin
        if child.wait() != 0:
            raise ValueError("ffprobe não conseguiu indexar os timestamps")
    finally:
        child.stdout.close()
        if child.poll() is None:
            child.terminate()
        child.wait()


def read_frames(video, ffmpeg, width, height):
    import numpy as np
    child = subprocess.Popen([ffmpeg,"-v","error","-noautorotate","-i",video,"-an","-sn","-fps_mode","passthrough","-f","rawvideo","-pix_fmt","bgr24","pipe:1"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    size=width*height*3
    try:
        while True:
            data=child.stdout.read(size)
            if not data:break
            if len(data)!=size:raise ValueError("Frame decodificado incompleto")
            yield np.frombuffer(data,dtype=np.uint8).reshape(height,width,3)
        if child.wait()!=0:raise ValueError("FFmpeg não conseguiu decodificar o vídeo")
    finally:
        child.stdout.close()
        if child.poll() is None:child.terminate()
        child.wait()


class TemporalTracker:
    def __init__(self, max_gap=.25):
        self.max_gap = max_gap
        self.last = None
        self.velocity = (0., 0.)

    def predict(self, timestamp):
        if self.last is None:
            return None
        x, y, previous = self.last
        elapsed = timestamp - previous
        if elapsed <= 0 or elapsed > self.max_gap:
            return None
        return (x + self.velocity[0] * elapsed, y + self.velocity[1] * elapsed, elapsed)

    def observe(self, point, timestamp):
        if self.last:
            x, y, previous = self.last
            elapsed = timestamp - previous
            self.velocity = ((point[0]-x)/elapsed, (point[1]-y)/elapsed) if 0 < elapsed <= self.max_gap else (0., 0.)
        self.last = (*point, timestamp)


class HybridKalman:
    """Centro e velocidade em pixels/segundo; previsões nunca são observações."""
    def __init__(self, width, height, max_gap=.35):
        import cv2
        import numpy as np
        self.cv, self.np = cv2, np
        self.width, self.height, self.max_gap = width, height, max_gap
        self.filter = cv2.KalmanFilter(4, 2, 0, cv2.CV_32F)
        self.filter.measurementMatrix = np.array([[1,0,0,0],[0,1,0,0]], np.float32)
        self.filter.transitionMatrix = np.eye(4, dtype=np.float32)
        self.filter.processNoiseCov = np.diag([4,4,100,100]).astype(np.float32)
        self.filter.measurementNoiseCov = np.eye(2, dtype=np.float32)*16
        self.filter.errorCovPost = np.eye(4, dtype=np.float32)*25
        self.last_time = None
        self.last_observed = None
        self.last_point = None
        self.box = None

    def predict(self, timestamp):
        if self.last_time is None:
            return None
        dt = timestamp - self.last_time
        if dt <= 0:
            return None
        self.filter.transitionMatrix[0, 2] = dt
        self.filter.transitionMatrix[1, 3] = dt
        state = self.filter.predict()
        self.last_time = timestamp
        x, y = float(state[0, 0]), float(state[1, 0])
        uncertainty = math.sqrt(max(0., float(self.filter.errorCovPre[0, 0] + self.filter.errorCovPre[1, 1])))
        return (x, y, uncertainty)

    def observe(self, point, box, timestamp, predicted=False):
        np = self.np
        gap = timestamp-self.last_observed if self.last_observed is not None else None
        if self.last_time is None or (gap is not None and gap > self.max_gap):
            self.filter.statePost = np.array([[point[0]], [point[1]], [0], [0]], np.float32)
            self.filter.errorCovPost = np.eye(4, dtype=np.float32)*25
        else:
            if not predicted:
                self.predict(timestamp)
            self.filter.correct(np.array([[point[0]], [point[1]]], np.float32))
            if gap and self.last_point:
                velocity = ((point[0]-self.last_point[0])/gap, (point[1]-self.last_point[1])/gap)
                self.filter.statePost[2, 0] = .5*self.filter.statePost[2, 0]+.5*velocity[0]
                self.filter.statePost[3, 0] = .5*self.filter.statePost[3, 0]+.5*velocity[1]
        self.last_time = timestamp
        self.last_observed = timestamp
        self.last_point = point
        self.box = dict(box)

    def provisional_box(self, center):
        if not self.box:
            return None
        w, h = self.box["width"], self.box["height"]
        return {"x": max(0., min(self.width-w, center[0]-w/2)),
                "y": max(0., min(self.height-h, center[1]-h/2)), "width": w, "height": h}


class HybridSegmenter:
    """Fundo fixo + segmentação existente + Kalman curto; sem rede neural."""
    def __init__(self, config, segmenter):
        self.segmenter = segmenter
        self.kalman = HybridKalman(config["width"], config["height"], config.get("maxPredictionSec", .35))

    def process(self, frame, timestamp):
        kalman, segmenter = self.kalman, self.segmenter
        predicted = kalman.predict(timestamp)
        age = timestamp-kalman.last_observed if kalman.last_observed is not None else float("inf")
        guide = kalman.provisional_box(predicted) if predicted and age <= kalman.max_gap else None
        result = segmenter.process(frame, timestamp, guide_box=guide)
        if result["source"] == "segmented" and result["status"] != "missing" and result.get("bbox"):
            kalman.observe((result["xPx"], result["yPx"]), result["bbox"], timestamp, predicted is not None)
            return {**result, "reason": "hybrid_"+result["reason"]}
        if predicted and age <= kalman.max_gap:
            x, y, uncertainty = predicted
            if 0 <= x < kalman.width and 0 <= y < kalman.height and segmenter.cv.pointPolygonTest(segmenter.enclosure, (x, y), False) >= 0:
                box = kalman.provisional_box(predicted)
                if box:
                    return {"xPx": box["x"]+box["width"]/2, "yPx": box["y"]+box["height"]/2,
                            "bbox": box, "source": "predicted", "status": "low_confidence",
                            "reason": "kalman_prediction", "uncertaintyPx": uncertainty}
        return {"xPx": None, "yPx": None, "source": "predicted", "status": "missing", "reason": "hybrid_no_observation"}


class ManualVisualTracker:
    """Referências visuais de caixas humanas; não é um detector treinado.

    Fluxo óptico orienta a busca, mas cada nova caixa exige correspondência
    visual com uma das imagens verificadas. Ao perder a evidência, para.
    """
    def __init__(self, width, height, scale):
        import cv2
        import numpy as np
        self.cv, self.np = cv2, np
        self.width, self.height, self.scale = width, height, scale
        self.templates = []
        self.previous = None
        self.points = None
        self.box = None
        self.misses = 0

    def gray(self, frame):
        return self.cv.cvtColor(self.cv.resize(frame, (round(self.width*self.scale), round(self.height*self.scale))), self.cv.COLOR_BGR2GRAY)

    def scaled_box(self, box):
        return [int(round(box[key]*self.scale)) for key in ("x", "y", "width", "height")]

    def features(self, gray, box):
        x, y, w, h = box
        mask = self.np.zeros(gray.shape, self.np.uint8)
        inset_x, inset_y = max(1, w//8), max(1, h//8)
        mask[y+inset_y:y+h-inset_y, x+inset_x:x+w-inset_x] = 255
        return self.cv.goodFeaturesToTrack(gray, 60, .02, 3, mask=mask)

    def add_anchor(self, frame, box):
        gray = self.gray(frame)
        x, y, w, h = self.scaled_box(box)
        crop = gray[y:y+h, x:x+w]
        if crop.shape[0] >= 5 and crop.shape[1] >= 5 and float(crop.std()) >= 4:
            self.templates.append(crop.copy())
        return gray

    def begin(self, frame, box):
        gray = self.gray(frame)
        self.box = self.scaled_box(box)
        self.previous = gray
        self.points = self.features(gray, self.box)
        self.misses = 0

    def update(self, frame):
        cv, np = self.cv, self.np
        gray = self.gray(frame)
        if self.box is None or self.previous is None or not self.templates or self.misses >= 5:
            return None
        x, y, w, h = self.box
        center_x, center_y = x+w/2, y+h/2
        if self.points is not None and len(self.points) >= 4:
            tracked, state, _ = cv.calcOpticalFlowPyrLK(self.previous, gray, self.points, None)
            if tracked is not None:
                back, reverse, _ = cv.calcOpticalFlowPyrLK(gray, self.previous, tracked, None)
                if back is not None:
                    good = (state.ravel() == 1) & (reverse.ravel() == 1) & (np.linalg.norm(back-self.points, axis=2).ravel() < 2)
                    if np.count_nonzero(good) >= 4:
                        delta = np.median((tracked-self.points)[good, 0], axis=0)
                        if np.linalg.norm(delta) <= max(w, h)*1.5:
                            center_x += float(delta[0])
                            center_y += float(delta[1])
        radius = int(max(12, max(w, h)*1.25)*(1+.5*self.misses))
        best = None
        for template in self.templates:
            th, tw = template.shape
            left = max(0, int(center_x-radius-tw/2))
            top = max(0, int(center_y-radius-th/2))
            right = min(gray.shape[1], int(center_x+radius+tw/2))
            bottom = min(gray.shape[0], int(center_y+radius+th/2))
            search = gray[top:bottom, left:right]
            if search.shape[0] < th or search.shape[1] < tw:
                continue
            scores = cv.matchTemplate(search, template, cv.TM_CCOEFF_NORMED)
            _, score, _, location = cv.minMaxLoc(scores)
            candidate_x, candidate_y = left+location[0], top+location[1]
            distance = math.hypot(candidate_x+tw/2-center_x, candidate_y+th/2-center_y)
            ranked = score - .08*distance/max(1, radius)
            if best is None or ranked > best[0]:
                best = (ranked, score, [candidate_x, candidate_y, tw, th])
        # Correlação sozinha não é prova suficiente de identidade do animal.
        if best is None or best[1] < .66 or best[0] < .60:
            self.misses += 1
            self.previous = gray
            self.points = None
            return None
        _, score, chosen = best
        self.box = chosen
        self.previous = gray
        self.points = self.features(gray, chosen)
        self.misses = 0
        return {"bbox": {"x": chosen[0]/self.scale, "y": chosen[1]/self.scale,
                         "width": chosen[2]/self.scale, "height": chosen[3]/self.scale}, "matchScore": float(score)}


class ArenaMotionGuard:
    """Sinaliza desvio da calibração usando textura distribuída na arena."""
    def __init__(self, cv, np, roi, scale, corners):
        self.cv, self.np, self.scale = cv, np, scale
        self.mask = cv.erode(roi, np.ones((5, 5), np.uint8))
        self.corners = np.asarray(corners, np.float32).reshape(-1, 1, 2) * scale
        self.reference = None
        self.points = None
        self.state = "unavailable"
        self.motion_px = None

    def assess(self, gray, frame_index, exclude_box=None):
        cv, np = self.cv, self.np
        if self.reference is None:
            self.reference = gray.copy()
            mask = self.mask.copy()
            if exclude_box:
                x = int(exclude_box["x"] * self.scale)
                y = int(exclude_box["y"] * self.scale)
                w = int(exclude_box["width"] * self.scale)
                h = int(exclude_box["height"] * self.scale)
                pad = max(6, int(max(w, h) * .5))
                cv.rectangle(mask, (max(0, x-pad), max(0, y-pad)),
                             (min(mask.shape[1]-1, x+w+pad), min(mask.shape[0]-1, y+h+pad)), 0, -1)
            points = cv.goodFeaturesToTrack(gray, 120, .02, 6, mask=mask)
            spread = np.ptp(points[:, 0], axis=0) if points is not None else (0, 0)
            if points is not None and len(points) >= 12 and spread[0] >= gray.shape[1]*.25 and spread[1] >= gray.shape[0]*.25:
                self.points = points
                self.state = "stable"
                self.motion_px = 0.
            return self.state
        if self.points is None:
            return self.state
        tracked, forward, _ = cv.calcOpticalFlowPyrLK(self.reference, gray, self.points, None)
        if tracked is None or forward is None:
            self.state = "drift" if self.state == "drift" else "unavailable"
            return self.state
        back, reverse, _ = cv.calcOpticalFlowPyrLK(gray, self.reference, tracked, None)
        if back is None or reverse is None:
            self.state = "drift" if self.state == "drift" else "unavailable"
            return self.state
        good = ((forward.ravel() == 1) & (reverse.ravel() == 1)
                & (np.linalg.norm(back-self.points, axis=2).ravel() < 1.5))
        if np.count_nonzero(good) < 8:
            self.state = "drift" if self.state == "drift" else "unavailable"
            return self.state
        source = self.points[good, 0]
        destination = tracked[good, 0]
        transform, inliers = cv.estimateAffinePartial2D(
            source, destination, method=cv.RANSAC, ransacReprojThreshold=1.5)
        if transform is None or inliers is None or not np.isfinite(transform).all() or np.count_nonzero(inliers) < 8 or np.mean(inliers) < .7:
            self.state = "drift" if self.state == "drift" else "unavailable"
            return self.state
        static_points = source[inliers.ravel() == 1]
        span = np.ptp(static_points, axis=0)
        if span[0] < gray.shape[1] * .25 or span[1] < gray.shape[0] * .25:
            self.state = "drift" if self.state == "drift" else "unavailable"
            return self.state
        displaced = cv.transform(self.corners, transform)
        self.motion_px = float(np.max(np.linalg.norm(displaced-self.corners, axis=2))) / self.scale
        threshold = max(3., .003 * float(np.linalg.norm(np.ptp(self.corners[:, 0], axis=0)))) / self.scale
        self.state = "drift" if self.motion_px > threshold else "stable"
        return self.state


class Segmenter:
    def __init__(self, config, background=None):
        import cv2
        import numpy as np
        self.cv, self.np = cv2, np
        cv2.setNumThreads(2)
        cv2.ocl.setUseOpenCL(bool(config.get("useOpenCL", True)) and cv2.ocl.haveOpenCL())
        self.opencl = bool(cv2.ocl.useOpenCL())
        self.config, self.background = config, background
        self.width, self.height = config["width"], config["height"]
        self.scale = min(1., config.get("maxWidth", 1280)/self.width)
        self.size = (round(self.width*self.scale), round(self.height*self.scale))
        self.floor = np.array([[p["x"], p["y"]] for p in config.get("walkablePolygonPx", config["arena"]["cornersPx"])], np.float32)
        rim = config.get("walkablePolygonPx") or config["arena"].get("rimCornersPx") or config["arena"]["cornersPx"]
        self.enclosure = np.array([[p["x"], p["y"]] for p in rim], np.float32)
        self.roi = np.zeros((self.size[1], self.size[0]), np.uint8)
        cv2.fillPoly(self.roi, [np.round(self.enclosure*self.scale).astype(np.int32)], 255)
        self.roi_area = cv2.countNonZero(self.roi)
        if self.roi_area < 16:
            raise ValueError("Arena inválida para segmentação")
        if background is not None:
            self.background = self.gray(background)
        self.kernel = np.ones((3, 3), np.uint8)
        self.min_area = self.roi_area * config["minAreaFraction"]
        self.max_area = self.roi_area * config["maxAreaFraction"]
        self.motion_guard = ArenaMotionGuard(cv2, np, self.roi, self.scale, self.enclosure)
        self.tracker = TemporalTracker(config.get("maxPredictionSec", .25))
        self.last_area = None
        self.last_box = None
        self.appearance = None

    def gray(self, frame):
        source = self.cv.UMat(frame) if self.opencl else frame
        result = self.cv.GaussianBlur(self.cv.cvtColor(self.cv.resize(source, self.size), self.cv.COLOR_BGR2GRAY), (5, 5), 0)
        return result.get() if self.opencl else result

    def reset_to_anchor(self, box, timestamp):
        center = (box["x"]+box["width"]/2, box["y"]+box["height"]/2)
        self.tracker.last = (*center, timestamp)
        self.tracker.velocity = (0., 0.)
        self.last_box = dict(box)
        self.last_area = None
        self.appearance = None  # Uma detecção anterior errada não veta a caixa humana.

    def assess_camera(self, frame, frame_index, force=False, exclude_box=None):
        if self.motion_guard.reference is not None and self.motion_guard.points is None:
            return self.motion_guard.state
        if force or frame_index == 0 or frame_index % 6 == 0:
            return self.motion_guard.assess(self.gray(frame), frame_index, exclude_box)
        return self.motion_guard.state

    def process(self, frame, timestamp, guide_box=None):
        cv, np, config = self.cv, self.np, self.config
        gray = self.gray(frame)
        mode, threshold = config["mode"], config["threshold"]
        if mode == "background":
            if self.background is None:
                raise ValueError("Selecione um frame com a caixa realmente vazia para usar subtração do fundo")
            mask = cv.threshold(cv.absdiff(gray, self.background), threshold, 255, cv.THRESH_BINARY)[1]
        else:
            mask = cv.threshold(gray, threshold, 255, cv.THRESH_BINARY if mode == "light" else cv.THRESH_BINARY_INV)[1]
        mask = cv.bitwise_and(mask, self.roi)
        mask = cv.morphologyEx(cv.morphologyEx(mask, cv.MORPH_OPEN, self.kernel), cv.MORPH_CLOSE, self.kernel)
        contours = cv.findContours(mask, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)[0]
        candidates = []
        resized = None
        for contour in contours:
            area = float(cv.contourArea(contour))
            if not self.min_area <= area <= self.max_area:
                continue
            x, y, width, height = cv.boundingRect(contour)
            center = ((x + width/2)/self.scale, (y + height/2)/self.scale)
            if guide_box:
                gx, gy = guide_box["x"]*self.scale, guide_box["y"]*self.scale
                gw, gh = guide_box["width"]*self.scale, guide_box["height"]*self.scale
                intersection = max(0, min(x+width,gx+gw)-max(x,gx))*max(0,min(y+height,gy+gh)-max(y,gy))
                if intersection/max(1, min(width*height, gw*gh)) < .25:
                    continue
            if resized is None:
                resized = cv.resize(frame, self.size)
            crop = cv.cvtColor(resized[y:y+height, x:x+width], cv.COLOR_BGR2LAB)
            contour_mask = np.zeros((height, width), np.uint8)
            cv.drawContours(contour_mask, [contour], -1, 255, -1, offset=(-x, -y))
            appearance = np.array(cv.mean(crop, mask=contour_mask)[:3])
            if self.appearance is not None and float(np.linalg.norm(appearance-self.appearance)) > 45:
                continue
            initial_box = config.get("initialBox")
            if self.tracker.last is None and initial_box:
                bx, by = initial_box["x"]*self.scale, initial_box["y"]*self.scale
                bw, bh = initial_box["width"]*self.scale, initial_box["height"]*self.scale
                overlap = max(0, min(x+width, bx+bw)-max(x,bx))*max(0,min(y+height,by+bh)-max(y,by))
                if overlap / max(1, width*height) < .3:
                    continue
            candidates.append((contour, area, center, appearance))
        prediction = self.tracker.predict(timestamp)
        seed = config.get("seed")
        target = (guide_box["x"]+guide_box["width"]/2, guide_box["y"]+guide_box["height"]/2) if guide_box else prediction or (self.tracker.last if self.tracker.last and timestamp-self.tracker.last[2] <= self.tracker.max_gap else None)
        if target is None and self.tracker.last is None:
            initial_box = config.get("initialBox")
            if initial_box:
                target = (initial_box["x"]+initial_box["width"]/2, initial_box["y"]+initial_box["height"]/2)
            elif seed:
                target = (seed["x"], seed["y"])
        if target:
            candidates.sort(key=lambda item: math.hypot(item[2][0]-target[0], item[2][1]-target[1]))
            gate = math.hypot(self.width, self.height)*.2
            candidates = [item for item in candidates if math.hypot(item[2][0]-target[0], item[2][1]-target[1]) <= gate]
        else:
            candidates.sort(key=lambda item: -item[1])
        ambiguous = len(candidates) > 1 and (not target or abs(math.hypot(candidates[0][2][0]-target[0], candidates[0][2][1]-target[1]) - math.hypot(candidates[1][2][0]-target[0], candidates[1][2][1]-target[1])) < self.width*.025)
        if not candidates or ambiguous:
            if prediction:
                x, y, gap = prediction
                if 0 <= x < self.width and 0 <= y < self.height and cv.pointPolygonTest(self.enclosure, (float(x), float(y)), False) >= 0:
                    box = None
                    if self.last_box:
                        box = {**self.last_box, "x": max(0., min(self.width-self.last_box["width"], x-self.last_box["width"]/2)),
                               "y": max(0., min(self.height-self.last_box["height"], y-self.last_box["height"]/2))}
                        x, y = box["x"]+box["width"]/2, box["y"]+box["height"]/2
                    return {"xPx": x, "yPx": y, "bbox": box, "source": "predicted", "status": "low_confidence", "reason": "prediction_only", "uncertaintyPx": self.width*.01 + gap*self.width*.2}
            return {"xPx": None, "yPx": None, "source": "segmented", "status": "missing", "reason": "ambiguous" if ambiguous else "no_contour"}
        contour, area, center, appearance = candidates[0]
        x, y, width, height = cv.boundingRect(contour)
        original = [(float(p[0][0]/self.scale), float(p[0][1]/self.scale)) for p in cv.approxPolyDP(contour, 2, True)]
        margin = math.hypot(self.width, self.height)*.012
        partial = any(cv.pointPolygonTest(self.floor, point, True) <= margin for point in original)
        unstable = self.last_area is not None and not .5 <= area/self.last_area <= 2
        reacquired = self.tracker.last is not None and timestamp-self.tracker.last[2] > self.tracker.max_gap
        region = "floor" if cv.pointPolygonTest(self.floor, center, False) >= 0 else "wall_projection"
        self.tracker.observe(center, timestamp)
        self.last_area = area
        self.last_box = {"x": x/self.scale, "y": y/self.scale, "width": width/self.scale, "height": height/self.scale}
        if self.appearance is None:
            self.appearance = appearance  # Referência fixa: não aprende a parede durante uma oclusão.
        return {"xPx": center[0], "yPx": center[1], "source": "segmented", "status": "low_confidence" if partial or unstable or reacquired else "valid",
                "spatialRegion": region, "reason": "near_wall_or_partial" if partial else "area_changed" if unstable else "reacquired" if reacquired else "observed",
                "bbox": self.last_box,
                "contour": [{"x": p[0], "y": p[1]} for p in original]}


def run(request_path):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    root, video = Path(request_path).parent, request["video"]
    status_path, samples_path = root/"status.json", root/"samples.jsonl"
    config = request["config"]
    started, parent = time.perf_counter(), os.getppid()
    profile = bool(config.get("benchmarkProfile", False))
    stage_seconds = {name: 0. for name in ("probe", "frame_read_wait", "tracking", "camera_guard", "serialization", "status_write")}
    frame_latencies_ms = []
    counts = {"observed": 0, "predicted": 0, "missing": 0, "suspect": 0, "manual": 0, "visual": 0}
    metadata=json.loads(subprocess.check_output([request["ffprobe"],"-v","error","-select_streams","v:0","-show_streams","-of","json",video]))["streams"][0]
    if profile: stage_seconds["probe"] += time.perf_counter()-started
    total=int(metadata.get("nb_frames","0")) if str(metadata.get("nb_frames","")).isdigit() else 0
    rotation=any(float(side.get("rotation",0))%360 for side in metadata.get("side_data_list",[]))
    if (metadata["width"],metadata["height"]) != (config["width"], config["height"]) or rotation:
        raise ValueError("Resolução/rotação do vídeo não corresponde à arena. Reabra o original e confira a calibração")
    capture=read_frames(video,request["ffmpeg"],config["width"],config["height"])
    background = None
    if config["mode"] == "background":
        reference = config.get("backgroundFrameIndex")
        if reference is None or reference < 0:
            raise ValueError("Selecione o frame de fundo vazio")
        for _ in range(reference + 1):
            background=next(capture,None)
            if background is None:raise ValueError("Frame de fundo não existe")
        capture.close()
        capture=read_frames(video,request["ffmpeg"],config["width"],config["height"])
    segmenter = Segmenter(config, background)
    hybrid = HybridSegmenter(config, segmenter) if config.get("strategy") == "hybrid_kalman_v1" else None
    guidance = config.get("guidance") or {}
    anchors = guidance.get("anchors") or []
    by_frame = {anchor["frameIndex"]: anchor for anchor in anchors}
    last_anchor = anchors[-1]["frameIndex"] if anchors else -1
    visual = ManualVisualTracker(config["width"], config["height"], segmenter.scale) if anchors else None
    # Amostra no máximo oito posturas verificadas, distribuídas pelo trecho.
    template_frames = {anchors[round(i*(len(anchors)-1)/min(7,len(anchors)-1))]["frameIndex"]
                       for i in range(min(8,len(anchors)))} if anchors else set()
    anchor_cursor = 0
    clock = timestamps(video, request["ffprobe"])
    report = {"version": VERSION, "state": "running", "framesProcessed": 0, "totalFrames": total, "counts": counts,
              "reference": "box_center", "scientificallyValidated": False, "accuracyMeasured": False,
              "referenceApproved": config.get("referenceApproved", False), "timing": "ffprobe_pts", "elapsedSec": 0., "processingFps": 0.,
              "guidanceSourceJobId": guidance.get("sourceJobId"), "manualAnchorCount": len(anchors),
              "assistedMethod": "manual_templates_lk_1" if anchors else None,
              "strategy": config.get("strategy", "classic"), "neuralFallback": "unavailable" if hybrid else None,
              "computeBackend": "OpenCL parcial" if segmenter.opencl else "CPU",
              "cameraMotionState": "unavailable", "cameraUncertainFrames": 0, "cameraMotionPx": None}
    write_json(status_path, report)
    index = 0
    last_frame = None
    try:
        with samples_path.open("w", encoding="utf-8", buffering=1) as output:
            pending = []

            def publish_pending(current_drift=False):
                write_started = time.perf_counter() if profile else 0.
                for sample, flagged, measured_px in pending:
                    flagged = flagged or current_drift
                    if flagged and sample["status"] != "missing":
                        sample.update(status="low_confidence", spatialRegion="unknown",
                                      segmentReason=sample["reason"], reason="camera_shift",
                                      cameraMotionPx=segmenter.motion_guard.motion_px if current_drift else measured_px)
                    output.write(json.dumps(sample, allow_nan=False) + "\n")
                    bucket = "missing" if sample["status"] == "missing" else "manual" if sample["source"] == "manual" else "visual" if sample["source"] == "recovered" else "predicted" if sample["source"] == "predicted" else "observed"
                    counts[bucket] += 1
                    counts["suspect"] += sample["status"] == "low_confidence"
                    report["cameraUncertainFrames"] += flagged
                pending.clear()
                if profile: stage_seconds["serialization"] += time.perf_counter()-write_started

            while True:
                if (root/"cancel").exists() or os.getppid() != parent:
                    report["state"] = "cancelled"
                    break
                frame_started = time.perf_counter() if profile else 0.
                frame=next(capture,None)
                if profile: stage_seconds["frame_read_wait"] += time.perf_counter()-frame_started
                if frame is None:
                    report["state"] = "succeeded"
                    break
                last_frame = frame
                timestamp = next(clock, None)
                if timestamp is None:
                    raise ValueError("Frames e timestamps divergiram; resultado não publicado")
                tracking_started = time.perf_counter() if profile else 0.
                if index in by_frame:
                    anchor = by_frame[index]
                    box = anchor["box"]
                    if index in template_frames: visual.add_anchor(frame, box)
                    segmenter.reset_to_anchor(box, timestamp)
                    if index == last_anchor:
                        if not visual.templates:
                            raise ValueError("As caixas humanas ficaram pequenas ou sem textura na resolução escolhida. Aumente a resolução de processamento e confira as caixas.")
                        visual.begin(frame, box)
                    result = {"xPx": box["x"]+box["width"]/2, "yPx": box["y"]+box["height"]/2,
                              "bbox": box, "source": "manual", "status": "valid", "spatialRegion": "unknown",
                              "reason": "manual_anchor"}
                    anchor_cursor += 1
                elif anchors and anchors[0]["frameIndex"] < index < last_anchor:
                    start, end = anchors[anchor_cursor-1], anchors[anchor_cursor]
                    fraction = max(0., min(1., (timestamp-start["timestampSec"])/(end["timestampSec"]-start["timestampSec"])))
                    box = {key: start["box"][key]+fraction*(end["box"][key]-start["box"][key])
                           for key in ("x", "y", "width", "height")}
                    result = {"xPx": box["x"]+box["width"]/2, "yPx": box["y"]+box["height"]/2,
                              "bbox": box, "source": "predicted", "status": "low_confidence",
                              "reason": "manual_keyframe_interpolation"}
                elif visual and index > last_anchor:
                    estimate = visual.update(frame)
                    if estimate:
                        box = estimate["bbox"]
                        observed = segmenter.process(frame, timestamp, guide_box=box)
                        if observed["source"] == "segmented" and observed["status"] != "missing" and observed.get("bbox"):
                            result = {**observed, "status": "low_confidence", "reason": "assisted_visual_and_contour"}
                        else:
                            result = {"xPx": box["x"]+box["width"]/2, "yPx": box["y"]+box["height"]/2,
                                      "bbox": box, "source": "recovered", "status": "low_confidence",
                                      "reason": "assisted_visual_match"}
                    else:
                        result = {"xPx": None, "yPx": None, "source": "recovered", "status": "missing",
                                  "reason": "assisted_visual_lost"}
                elif hybrid:
                    result = hybrid.process(frame, timestamp)
                else:
                    result = segmenter.process(frame, timestamp)
                if profile: stage_seconds["tracking"] += time.perf_counter()-tracking_started
                guard_started = time.perf_counter() if profile else 0.
                camera_state = segmenter.assess_camera(frame, index, exclude_box=result.get("bbox"))
                if profile: stage_seconds["camera_guard"] += time.perf_counter()-guard_started
                sample = {"frameIndex": index, "timestampSec": timestamp, "keypoint": "box_center", "likelihood": 0,
                          "metricReference": "box_center", "referenceApproved": config.get("referenceApproved", False), **result}
                pending.append((sample, camera_state == "drift", segmenter.motion_guard.motion_px))
                if index % 6 == 0:
                    publish_pending(camera_state == "drift")
                report["cameraMotionState"] = camera_state
                report["cameraMotionPx"] = segmenter.motion_guard.motion_px
                index += 1
                if index % 12 == 0:
                    elapsed = time.perf_counter()-started
                    report.update(framesProcessed=index, elapsedSec=elapsed, processingFps=index/max(.001, elapsed))
                    status_started = time.perf_counter() if profile else 0.
                    write_json(status_path, report)
                    if profile: stage_seconds["status_write"] += time.perf_counter()-status_started
                if profile: frame_latencies_ms.append((time.perf_counter()-frame_started)*1000)
            if pending:
                if report["state"] == "succeeded":
                    camera_state = segmenter.assess_camera(last_frame, index-1, force=True)
                    report["cameraMotionState"] = camera_state
                    report["cameraMotionPx"] = segmenter.motion_guard.motion_px
                publish_pending(camera_state == "drift")
            if index == 0 and report["state"] == "succeeded":
                raise ValueError("O decoder não conseguiu ler nenhum frame")
            if report["state"] == "succeeded" and next(clock, None) is not None:
                raise ValueError("O decoder encerrou antes do fim dos timestamps")
            elapsed = time.perf_counter()-started
            report.update(framesProcessed=index, elapsedSec=elapsed, processingFps=index/max(.001, elapsed), observationCoveragePct=100*counts["observed"]/max(1,index))
            if profile and frame_latencies_ms:
                ordered = sorted(frame_latencies_ms)
                report["benchmarkProfile"] = {"stageSeconds": stage_seconds,
                    "frameLatencyMeanMs": sum(ordered)/len(ordered),
                    "frameLatencyP95Ms": ordered[min(len(ordered)-1, int(.95*len(ordered)))],
                    "frameLatencyMaxMs": ordered[-1],
                    "frameLatencyDefinition": "read_frame_return_to_sample_and_periodic_status; ffmpeg decode and PTS run concurrently"}
            write_json(status_path, report)
    except BaseException as error:
        elapsed = time.perf_counter()-started
        report.update(state="failed", error=str(error)[:2000], framesProcessed=index,
                      elapsedSec=elapsed, processingFps=index/max(.001, elapsed),
                      observationCoveragePct=100*counts["observed"]/max(1,index))
        write_json(status_path, report)
        raise
    finally:
        capture.close()
        clock.close()


if __name__ == "__main__":
    try:
        run(sys.argv[1])
    except BaseException as error:
        import traceback
        traceback.print_exc()
        path = Path(sys.argv[1]).parent/"status.json"
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = {"version": VERSION}
        if previous.get("state") != "failed":
            write_json(path, {**previous, "state": "failed", "error": str(error)[:2000]})
        raise SystemExit(1)
