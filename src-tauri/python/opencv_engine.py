"""Segmentação local, sem redes neurais, com observação e previsão separadas.

O centro da caixa não é centro anatômico nem ponto de contato com o piso.
Fundo e limiar são estáticos: um animal imóvel não é absorvido pelo fundo.
"""
import json
import math
import os
from contextlib import suppress
from pathlib import Path
import subprocess
import sys
import time

VERSION = "opencv-box-15"


def write_json(path, value):
    temporary = Path(str(path) + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    try:
        for delay in (.01, .02, .04, .08, .16, .2, .2, None):
            try:
                os.replace(temporary, path)
                return
            except OSError as error:
                # A Windows reader can temporarily prevent an atomic replacement.
                if delay is None or getattr(error, "winerror", None) not in {5, 32, 33}:
                    raise
                time.sleep(delay)
    except OSError:
        with suppress(OSError):
            temporary.unlink(missing_ok=True)
        raise


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


def read_frames(video, ffmpeg, width, height, autorotate=False, seek_sec=None, frame_limit=None, output_size=None):
    import numpy as np
    orientation = [] if autorotate else ["-noautorotate"]
    seek = ["-ss", str(seek_sec)] if seek_sec is not None else []
    limit = ["-frames:v", str(frame_limit)] if frame_limit is not None else []
    scaling = ["-vf", f"scale={output_size[0]}:{output_size[1]}"] if output_size else []
    width, height = output_size or (width, height)
    child = subprocess.Popen([ffmpeg,"-v","error",*orientation,*seek,"-i",video,"-an","-sn",*scaling,*limit,"-fps_mode","passthrough","-f","rawvideo","-pix_fmt","bgr24","pipe:1"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
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


def reference_frames(video, ffmpeg, width, height, duration, total=0, autorotate=False,
                     output_size=None, cancelled=lambda: False, sample_count=15):
    """Amostras pontuais por seek; o relógio da análise continua sendo o PTS original.

    Sem duração conhecida, usa um prefixo limitado, declarado no manifesto.
    Nunca varre o vídeo inteiro apenas para construir a referência.
    """
    count = min(sample_count, total) if total else sample_count
    if math.isfinite(duration) and duration > 0:
        for index in range(count):
            if cancelled():
                raise InterruptedError("Referência cancelada")
            second = duration * index / count
            capture = read_frames(video, ffmpeg, width, height, autorotate,
                                  seek_sec=second, frame_limit=1, output_size=output_size)
            try:
                frame = next(capture, None)
                if frame is not None:
                    yield second, frame
            finally:
                capture.close()
    else:
        capture = read_frames(video, ffmpeg, width, height, autorotate,
                              frame_limit=count, output_size=output_size)
        try:
            for index, frame in enumerate(capture):
                if cancelled():
                    raise InterruptedError("Referência cancelada")
                yield None, frame
        finally:
            capture.close()


class SilhouetteFeatures:
    """Descritores de imagem, sem inferência comportamental ou direção anatômica."""
    def __init__(self):
        self.previous = None

    def extract(self, gray, mask, timestamp, scale=1.):
        import cv2 as cv
        import numpy as np
        active = mask > 0
        area = int(np.count_nonzero(active))
        if not area:
            self.previous = None
            return None
        moments = cv.moments(mask, binaryImage=True)
        center = (moments["m10"]/area, moments["m01"]/area)
        x, y, w, h = cv.boundingRect(mask)
        angle = .5*math.atan2(2*moments["mu11"], moments["mu20"]-moments["mu02"])
        value = {"schemaVersion": "silhouette-features-1", "areaPx": area/(scale*scale),
                 "aspectRatio": w/h, "extent": area/(w*h), "axisRad": angle,
                 "deltaSec": None, "speedPxSec": None, "changedPixelFraction": None,
                 "meanAbsDifference": None}
        if self.previous:
            old_gray, old_active, old_center, old_time = self.previous
            dt = timestamp-old_time
            if old_gray.shape == gray.shape and 0 < dt <= .5:
                union = active | old_active
                value.update(deltaSec=dt, speedPxSec=math.dist(center, old_center)/(scale*dt),
                             changedPixelFraction=float(np.count_nonzero(active ^ old_active)/np.count_nonzero(union)),
                             meanAbsDifference=float(cv.absdiff(gray, old_gray)[union].mean()))
        self.previous = (gray.copy(), active.copy(), center, timestamp)
        return value


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
        if result["source"] == "recovered":
            # Evidência estática auxiliar não realimenta a previsão de posição.
            return result
        if result["source"] == "segmented" and result["status"] != "missing" and result.get("bbox"):
            accepted = result.get("trackingAccepted", result["status"] == "valid")
            if accepted:
                kalman.observe((result["xPx"], result["yPx"]), result["bbox"], timestamp, predicted is not None)
            return {**result, "reason": "hybrid_"+result["reason"], "kalmanUpdated": bool(accepted)}
        if predicted and age <= kalman.max_gap:
            x, y, uncertainty = predicted
            if 0 <= x < kalman.width and 0 <= y < kalman.height and segmenter.cv.pointPolygonTest(segmenter.enclosure, (x, y), False) >= 0:
                box = kalman.provisional_box(predicted)
                if box:
                    return {"xPx": box["x"]+box["width"]/2, "yPx": box["y"]+box["height"]/2,
                            "bbox": box, "source": "predicted", "status": "low_confidence",
                            "reason": "kalman_prediction", "uncertaintyPx": uncertainty,
                            "trackingAccepted": False, "kalmanUpdated": False}
        return {"xPx": None, "yPx": None, "source": "predicted", "status": "missing", "reason": "hybrid_no_observation",
                "trackingAccepted": False, "kalmanUpdated": False}


class ReferenceSegmenter:
    """Fundo mediano congelado; contraste independente recupera corpos imóveis.

    O fallback é sempre incerto: uma referência contendo o animal não demonstra
    ausência, e a segmentação estática sozinha não demonstra identidade.
    """
    def __init__(self, primary, fallback=None):
        self.primary, self.fallback = primary, fallback
        self.cv, self.enclosure = primary.cv, primary.enclosure

    def process(self, frame, timestamp, guide_box=None):
        result = self.primary.process(frame, timestamp, guide_box)
        if result["source"] == "segmented" and result.get("bbox"):
            if self.fallback and result.get("trackingAccepted", result["status"] == "valid"):
                self.fallback.reset_to_anchor(result["bbox"], timestamp)
            return result
        if self.fallback:
            recovered = self.fallback.process(frame, timestamp, guide_box)
            if recovered["source"] == "segmented" and recovered.get("bbox"):
                return {**recovered, "source": "recovered", "status": "low_confidence", "reason": "static_reference_overlap",
                        "trackingAccepted": False, "kalmanUpdated": False}
        return result


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
        cv2.ocl.setUseOpenCL(bool(config.get("useOpenCL", False)) and cv2.ocl.haveOpenCL())
        self.opencl = bool(cv2.ocl.useOpenCL())
        self.config, self.background = config, background
        self.width, self.height = config["width"], config["height"]
        self.scale = min(1., config.get("maxWidth", 1280)/self.width)
        self.size = (round(self.width*self.scale), round(self.height*self.scale))
        self.floor = np.array([[p["x"], p["y"]] for p in config.get("walkablePolygonPx", config["arena"]["cornersPx"])], np.float32)
        self.open_field = (config.get("protocol", "open_field") == "open_field"
                           and not config.get("walkablePolygonPx") and config.get("strategy") != "ram_color_geometry_v2")
        rim = config.get("walkablePolygonPx") or config["arena"].get("rimCornersPx") or config["arena"]["cornersPx"]
        self.enclosure = np.array([[p["x"], p["y"]] for p in rim], np.float32)
        self.roi = np.zeros((self.size[1], self.size[0]), np.uint8)
        if self.open_field:
            from arena import open_field_tracking_polygon, open_field_tracking_mask
            self.enclosure = np.asarray(open_field_tracking_polygon(config["arena"], self.width, self.height), np.float32)
            self.roi = cv2.resize(open_field_tracking_mask(config["arena"], self.width, self.height), self.size, interpolation=cv2.INTER_NEAREST)
        else:
            cv2.fillPoly(self.roi, [np.round(self.enclosure*self.scale).astype(np.int32)], 255)
        self.roi_area = cv2.countNonZero(self.roi)
        if self.roi_area < 16:
            raise ValueError("Arena inválida para segmentação")
        self.roi_rect = cv2.boundingRect(self.roi)
        self.features = SilhouetteFeatures() if config.get("strategy") == "classical_roi_v1" else None
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
        # Conversões, limiar e morfologia ficam no retângulo da ROI. Contornos
        # voltam às coordenadas da imagem reduzida antes de qualquer seleção.
        resized = cv.resize(frame, self.size)
        rx, ry, rw, rh = self.roi_rect
        gray = cv.GaussianBlur(cv.cvtColor(resized[ry:ry+rh, rx:rx+rw], cv.COLOR_BGR2GRAY), (5, 5), 0)
        roi = self.roi[ry:ry+rh, rx:rx+rw]
        mode, threshold = config["mode"], config["threshold"]
        if mode == "background":
            if self.background is None:
                raise ValueError("Selecione um frame com a caixa realmente vazia para usar subtração do fundo")
            mask = cv.threshold(cv.absdiff(gray, self.background[ry:ry+rh, rx:rx+rw]), threshold, 255, cv.THRESH_BINARY)[1]
        else:
            mask = cv.threshold(gray, threshold, 255, cv.THRESH_BINARY if mode == "light" else cv.THRESH_BINARY_INV)[1]
        mask = cv.bitwise_and(mask, roi)
        mask = cv.morphologyEx(cv.morphologyEx(mask, cv.MORPH_OPEN, self.kernel), cv.MORPH_CLOSE, self.kernel)
        mask = cv.bitwise_and(mask, roi)
        prediction = self.tracker.predict(timestamp)
        # A busca usa a mesma distância máxima da associação temporal. O
        # recorte inclui a extensão anterior para não truncar o corpo no limite.
        search = mask
        ox, oy = rx, ry
        if prediction and self.last_box:
            gate = math.hypot(self.width, self.height)*.2
            pad = max(self.last_box["width"], self.last_box["height"])
            radius = (gate+pad)*self.scale
            px, py = prediction[0]*self.scale-rx, prediction[1]*self.scale-ry
            x1, y1 = max(0, int(px-radius)), max(0, int(py-radius))
            x2, y2 = min(rw, math.ceil(px+radius)), min(rh, math.ceil(py+radius))
            if x2 > x1 and y2 > y1:
                search, ox, oy = mask[y1:y2, x1:x2], rx+x1, ry+y1
        contours = cv.findContours(search, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE, offset=(ox, oy))[0]
        candidates = []
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
            if self.features:
                self.features.previous = None
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
        features = None
        if self.features:
            body = np.zeros(gray.shape, np.uint8)
            cv.drawContours(body, [contour], -1, 255, -1, offset=(-rx, -ry))
            features = self.features.extract(gray, body, timestamp, self.scale)
        return {"xPx": center[0], "yPx": center[1], "source": "segmented", "status": "low_confidence" if partial or unstable or reacquired else "valid",
                "spatialRegion": region, "reason": "near_wall_or_partial" if partial else "area_changed" if unstable else "reacquired" if reacquired else "observed",
                "bbox": self.last_box, **({"features": features} if self.features else {}),
                "contour": [{"x": p[0], "y": p[1]} for p in original]}


class BodyFlow:
    """LK bidirecional orienta associação; não publica observações sozinho."""
    def __init__(self, max_gap):
        self.max_gap = max_gap
        self.reference = None
        self.points = None
        self.box = None
        self.time = None

    def observe(self, gray, mask, box, timestamp):
        import cv2 as cv
        import numpy as np
        self.reference = gray.copy()
        x, y, w, h = (int(box[key]) for key in ("x", "y", "width", "height"))
        crop = gray[y:y+h, x:x+w]
        self.points = cv.goodFeaturesToTrack(crop, 60, .02, 3, mask=cv.erode(mask[y:y+h, x:x+w], None))
        if self.points is not None:
            self.points += np.array([x, y], np.float32)
        self.box, self.time = dict(box), timestamp

    def predict(self, gray, timestamp):
        import cv2 as cv
        import numpy as np
        if self.points is None or len(self.points) < 4 or not 0 < timestamp-self.time <= self.max_gap:
            return None
        current, valid, _ = cv.calcOpticalFlowPyrLK(self.reference, gray, self.points, None)
        if current is None:
            return None
        returned, reverse, _ = cv.calcOpticalFlowPyrLK(gray, self.reference, current, None)
        if returned is None:
            return None
        good = (valid[:, 0] > 0) & (reverse[:, 0] > 0) & (np.linalg.norm(returned-self.points, axis=2)[:, 0] < 1.)
        if np.count_nonzero(good) < 4:
            return None
        flow = (current-self.points)[good, 0]
        displacement = np.median(flow, axis=0)
        inliers = np.linalg.norm(flow-displacement, axis=1) < max(2., min(self.box["width"], self.box["height"])*.15)
        if np.mean(inliers) < .6 or np.count_nonzero(inliers) < 4:
            return None
        dx, dy = np.median(flow[inliers], axis=0)
        if math.hypot(dx, dy) > max(self.box["width"], self.box["height"])*2:
            return None
        return {**self.box, "x": self.box["x"]+float(dx), "y": self.box["y"]+float(dy)}


class RobustSegmenter(Segmenter):
    """Associação por evidência visual; geometria não equivale a identidade.

    Só observações aceitas alteram posição, área e aparência de referência.
    A geometria continua conservadora para medidas no piso.
    """
    def __init__(self, config, background, reference_samples=()):
        super().__init__(config, background)
        cv, np = self.cv, self.np
        self.ram_body_margin = config.get("protocol") == "radial_arm_maze" and bool(config.get("walkablePolygonPx"))
        if self.ram_body_margin:
            # Walkability constrains the center, not the whole elevated body.
            # Keep the calibrated polygon intact for geometry and metrics.
            distance = cv.distanceTransform(self.roi, cv.DIST_L2, 3)
            padding = max(3, min(16, round(float(np.percentile(distance[self.roi > 0], 75)))))
            kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, (2*padding+1, 2*padding+1))
            self.roi = cv.dilate(self.roi, kernel)
            self.roi_rect = cv.boundingRect(self.roi)
            self.body_roi_distance = cv.distanceTransform(self.roi, cv.DIST_L2, 3)
        rx, ry, rw, rh = self.roi_rect
        self.background_crop = self.background[ry:ry+rh, rx:rx+rw]
        background_view = cv.resize(background, self.size)[ry:ry+rh, rx:rx+rw]
        self.background_lab = cv.cvtColor(cv.GaussianBlur(background_view, (5, 5), 0), cv.COLOR_BGR2LAB).astype(np.float32)
        self.active_roi = self.roi[ry:ry+rh, rx:rx+rw] > 0
        self.probe_y, self.probe_x = np.unravel_index(np.flatnonzero(self.active_roi.ravel())[::8], (rh, rw))
        self.noise = np.zeros((rh, rw), np.float32)
        self.chroma_noise = np.zeros((rh, rw), np.float32)
        floor_mask = np.zeros_like(self.roi)
        cv.fillPoly(floor_mask, [np.round(self.floor*self.scale).astype(np.int32)], 255)
        self.floor_mask = floor_mask
        # Abertura proporcional à resolução remove cauda e pontes finas entre
        # corpo e reflexo antes da associação. Não aumenta a caixa corporal.
        opening_size = max(5, min(7, int(round(math.hypot(*self.size)*.006)) | 1))
        self.body_kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, (opening_size, opening_size))
        if reference_samples:
            residuals = []
            chroma_residuals = []
            for frame in reference_samples:
                gray = self.gray(frame)[ry:ry+rh, rx:rx+rw]
                residual = gray.astype(np.float32)-self.background_crop.astype(np.float32)
                residual -= float(np.median(residual[self.active_roi][::8]))
                residuals.append(residual)
                view = cv.resize(frame, self.size)[ry:ry+rh, rx:rx+rw]
                lab = cv.cvtColor(cv.GaussianBlur(view, (5, 5), 0), cv.COLOR_BGR2LAB).astype(np.float32)
                chroma = lab[:, :, 1:]-self.background_lab[:, :, 1:]
                chroma -= np.median(chroma[self.active_roi][::8], axis=0)
                chroma_residuals.append(chroma)
            stack = np.stack(residuals)
            self.noise = 1.4826*np.median(np.abs(stack-np.median(stack, axis=0)), axis=0)
            stack = np.stack(chroma_residuals)
            deviation = 1.4826*np.median(np.abs(stack-np.median(stack, axis=0)), axis=0)
            self.chroma_noise = np.linalg.norm(deviation, axis=2)
        self.pending_identity = None
        self.identity_shape = None
        self.area_history = []
        self.body_flow = BodyFlow(self.tracker.max_gap)
        self.threshold = np.maximum(float(self.config["threshold"]), 3*self.noise)
        self.chroma_threshold = np.maximum(max(8., self.config["threshold"]*.3), 3*self.chroma_noise)
        self.noise_threshold_median = float(np.median(self.threshold[self.probe_y, self.probe_x]))

    def reset_to_anchor(self, box, timestamp):
        super().reset_to_anchor(box, timestamp)
        self.pending_identity = None
        self.identity_shape = None
        self.area_history = []
        self.body_flow = BodyFlow(self.tracker.max_gap)

    def extend_on_wall(self, chosen, residual, delta_a, delta_b, shift, chroma_shift, lab):
        """Recover low-contrast head/neck pixels connected to the current body.

        The strong, opened mask establishes identity. A bounded weak mask may
        extend that same component across the floor boundary; floor pixels,
        distant wall blobs and thin appendages cannot seed a new animal.
        """
        cv, np = self.cv, self.np
        rx, ry, rw, rh = self.roi_rect
        contour=chosen["contour"]
        x,y,w,h=cv.boundingRect(contour)
        reference_area=float(np.median(self.area_history)) if self.area_history else self.last_area
        body_area=max(chosen["area"],reference_area or 0)
        pad=max(6,round(max(max(w,h)*.65,1.5*math.sqrt(body_area))))
        left,top=max(0,x-rx-pad),max(0,y-ry-pad)
        right,bottom=min(rw,x-rx+w+pad),min(rh,y-ry+h+pad)
        seed=np.zeros((bottom-top,right-left),np.uint8)
        cv.drawContours(seed,[contour],-1,255,-1,offset=(-rx-left,-ry-top))
        outside=self.floor_mask[ry+top:ry+bottom,rx+left:rx+right]==0
        if not np.any(outside):return chosen,0
        luminance=np.abs(residual[top:bottom,left:right]-shift)
        chroma=cv.magnitude(delta_a[top:bottom,left:right],delta_b[top:bottom,left:right])
        weak=((luminance>np.maximum(7.,self.threshold[top:bottom,left:right]*.35)) |
              (chroma>np.maximum(5.,self.chroma_threshold[top:bottom,left:right]*.5)))
        # Keep a narrow connected band on both sides of the calibration line:
        # discarding weak floor pixels here would cut the neck at that line.
        near_seed=cv.distanceTransform(np.uint8(seed==0),cv.DIST_L2,3)<=4
        weak &= self.active_roi[top:bottom,left:right] & (outside|near_seed)
        weak=np.uint8(weak)*255
        weak=cv.morphologyEx(cv.bitwise_or(weak,seed),cv.MORPH_CLOSE,np.ones((5,5),np.uint8))
        weak=cv.morphologyEx(weak,cv.MORPH_OPEN,self.kernel)
        weak=cv.bitwise_or(weak,seed)
        _,labels=cv.connectedComponents(weak)
        ids,counts=np.unique(labels[seed>0],return_counts=True)
        connected=labels==int(ids[np.argmax(counts)])
        extra=np.uint8(connected & (seed==0))
        count,parts,stats,_=cv.connectedComponentsWithStats(extra)
        radius=float(cv.distanceTransform(seed,cv.DIST_L2,3).max())
        reference=self.appearance if self.appearance is not None else chosen["appearance"]
        recovered=np.zeros_like(seed)
        for i in range(1,count):
            area=stats[i,cv.CC_STAT_AREA]
            component=np.uint8(parts==i)
            wall_area=np.count_nonzero((component>0)&outside)
            if not max(6,body_area*.015)<=wall_area<=body_area*.7 or area>body_area*1.2:continue
            if float(cv.distanceTransform(component,cv.DIST_L2,3).max())<max(2.,radius*.28):continue
            appearance=np.median(lab[top:bottom,left:right][component>0],axis=0).astype(float)
            appearance[0]-=shift
            appearance[1:]-=chroma_shift
            if float(np.linalg.norm((appearance-reference)*[.5,1,1]))>35:continue
            recovered[component>0]=255
        added=cv.countNonZero(recovered)
        if not added or added>body_area*1.2:return chosen,0
        merged=cv.bitwise_or(seed,recovered)
        contours=cv.findContours(merged,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE,offset=(rx+left,ry+top))[0]
        if len(contours)!=1:return chosen,0
        contour=contours[0];area=float(cv.contourArea(contour))
        if not self.min_area<=area<=self.max_area:return chosen,0
        x,y,w,h=cv.boundingRect(contour)
        # Do not silently publish a head truncated by this bounded search.
        if x<=rx+left or y<=ry+top or x+w>=rx+right or y+h>=ry+bottom:return chosen,0
        body=np.zeros((h,w),np.uint8);cv.drawContours(body,[contour],-1,255,-1,offset=(-x,-y))
        floor_fraction=float(np.count_nonzero((body>0)&(self.floor_mask[y:y+h,x:x+w]>0))/max(1,cv.countNonZero(body)))
        return {**chosen,"contour":contour,"area":area,"center":((x+w/2)/self.scale,(y+h/2)/self.scale),
            "bbox":dict(x=x/self.scale,y=y/self.scale,width=w/self.scale,height=h/self.scale),
            "density":area/max(1,w*h),"aspect":max(w,h)/max(1,min(w,h)),"floor_fraction":floor_fraction,
            "area_ratio":area/reference_area if reference_area else 1.},added

    def process(self, frame, timestamp, guide_box=None):
        cv, np = self.cv, self.np
        rx, ry, rw, rh = self.roi_rect
        view = cv.resize(frame, self.size)
        gray = cv.GaussianBlur(cv.cvtColor(view[ry:ry+rh, rx:rx+rw], cv.COLOR_BGR2GRAY), (5, 5), 0)
        residual = gray.astype(np.float32)-self.background_crop.astype(np.float32)
        # A mediana esparsa mede a mudança global de brilho sem atualizar o fundo.
        shift = float(np.median(residual[self.probe_y, self.probe_x]))
        lab = cv.cvtColor(cv.GaussianBlur(view[ry:ry+rh, rx:rx+rw], (5, 5), 0), cv.COLOR_BGR2LAB)
        chroma_probe = lab[self.probe_y, self.probe_x, 1:]-self.background_lab[self.probe_y, self.probe_x, 1:]
        chroma_shift = np.median(chroma_probe, axis=0)
        delta_a = lab[:, :, 1].astype(np.float32)-self.background_lab[:, :, 1]-chroma_shift[0]
        delta_b = lab[:, :, 2].astype(np.float32)-self.background_lab[:, :, 2]-chroma_shift[1]
        # Mudanças cromáticas recuperam corpo sobre piso de luminância próxima.
        # O limiar continua relativo a uma referência congelada e ao ruído local.
        foreground = (np.abs(residual-shift) > self.threshold) | (cv.magnitude(delta_a, delta_b) > self.chroma_threshold)
        mask = np.uint8(foreground & self.active_roi)*255
        mask = cv.morphologyEx(cv.morphologyEx(mask, cv.MORPH_OPEN, self.body_kernel), cv.MORPH_CLOSE, self.kernel)
        mask = cv.bitwise_and(mask, self.roi[ry:ry+rh, rx:rx+rw])
        contours = cv.findContours(mask, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE, offset=(rx, ry))[0]
        prediction = self.tracker.predict(timestamp)
        recent = self.tracker.last and 0 <= timestamp-self.tracker.last[2] <= self.tracker.max_gap
        target = ((guide_box["x"]+guide_box["width"]/2, guide_box["y"]+guide_box["height"]/2)
                  if guide_box else prediction or (self.tracker.last if recent else None))
        # Floor support helps initialize identity, but cannot constrain the
        # silhouette of an already associated animal as it rises on a wall.
        wall_association = self.open_field and bool(recent or guide_box or self.config.get("initialBox"))
        visual_box = self.body_flow.predict(gray, timestamp)
        if visual_box:
            target = ((visual_box["x"]+visual_box["width"]/2+rx)/self.scale,
                      (visual_box["y"]+visual_box["height"]/2+ry)/self.scale)
        initial_box = self.config.get("initialBox") if self.tracker.last is None else None
        candidates = []
        for contour in contours:
            area = float(cv.contourArea(contour))
            if not self.min_area <= area <= self.max_area:
                continue
            x, y, w, h = cv.boundingRect(contour)
            center = ((x+w/2)/self.scale, (y+h/2)/self.scale)
            density = area/max(1, w*h)
            aspect = max(w, h)/max(1, min(w, h))
            component = np.zeros((h, w), np.uint8)
            cv.drawContours(component, [contour], -1, 255, -1, offset=(-x, -y))
            on_floor = (component > 0) & (self.floor_mask[y:y+h, x:x+w] > 0)
            floor_fraction = float(np.count_nonzero(on_floor)/max(1, cv.countNonZero(component)))
            if self.ram_body_margin and (floor_fraction < .35 or cv.pointPolygonTest(self.floor, center, False) < 0):
                continue
            # Mediana no núcleo reduz contaminação por cauda, sombra e reflexo.
            core = cv.erode(component, self.kernel) > 0
            if np.count_nonzero(core & on_floor) >= 9:
                core &= on_floor
            if np.count_nonzero(core) < 9:
                core = component > 0
            appearance = np.median(lab[y-ry:y-ry+h, x-rx:x-rx+w][core], axis=0).astype(np.float64)
            # Luminância é comparada após compensar o brilho global, enquanto
            # os dois canais cromáticos conservam seu peso na identidade.
            appearance[0] -= shift
            appearance[1:] -= chroma_shift
            color_delta = float(np.linalg.norm((appearance-self.appearance)*np.array([.5, 1., 1.]))) if self.appearance is not None else 0.
            reference_area = float(np.median(self.area_history)) if self.area_history else self.last_area
            area_ratio = area/reference_area if reference_area else 1.
            displacement = math.dist(center, target[:2]) if target else 0.
            body_size = max(self.last_box["width"], self.last_box["height"]) if self.last_box else max(w, h)/self.scale
            distance_cost = displacement/max(body_size*2, math.hypot(self.width, self.height)*.025)
            # Rotação e mudança de postura alteram aspecto sem trocar identidade.
            shape_cost = max(0., math.log(aspect/4))
            size_support = min(3., math.log(max(1., area/self.min_area)))
            score = (density+(.25 if wall_association else 2)*floor_fraction+.45*size_support-distance_cost
                     -color_delta/40-.5*abs(math.log(area_ratio))-shape_cost*.5)
            if target and displacement > math.hypot(self.width, self.height)*.2:
                continue
            if initial_box:
                bx, by = initial_box["x"]*self.scale, initial_box["y"]*self.scale
                bw, bh = initial_box["width"]*self.scale, initial_box["height"]*self.scale
                overlap = max(0, min(x+w, bx+bw)-max(x, bx))*max(0, min(y+h, by+bh)-max(y, by))
                if overlap/max(1, w*h) < .3 or overlap/max(1, bw*bh) < .3:
                    continue
            candidates.append(dict(contour=contour, area=area, center=center, appearance=appearance,
                bbox={"x": x/self.scale, "y": y/self.scale, "width": w/self.scale, "height": h/self.scale},
                density=density, aspect=aspect, color_delta=color_delta, area_ratio=area_ratio,
                floor_fraction=floor_fraction, score=score))
        candidates.sort(key=lambda value: value["score"], reverse=True)
        diagnostics = {"candidateCount": len(candidates), "illuminationShift": shift,
                       "visualContinuity": visual_box is not None,
                       "noiseThresholdMedian": self.noise_threshold_median}
        if not candidates:
            self.pending_identity = None
            self.features.previous = None
            return {"xPx": None, "yPx": None, "source": "segmented", "status": "missing", "reason": "no_contour",
                    "trackingAccepted": False, "localQuality": {"tracking": "missing", "geometry": "unknown", "reasons": ["no_contour"]}, **diagnostics}
        chosen = candidates[0]
        wall_pixels=0
        if self.open_field and (wall_association or chosen["floor_fraction"]>=.15):
            chosen,wall_pixels=self.extend_on_wall(chosen,residual,delta_a,delta_b,shift,chroma_shift,lab)
        contour, area, center = chosen["contour"], chosen["area"], chosen["center"]
        original = [(float(p[0][0]/self.scale), float(p[0][1]/self.scale)) for p in cv.approxPolyDP(contour, 2, True)]
        margin = math.hypot(self.width, self.height)*.012
        partial = any(cv.pointPolygonTest(self.floor, point, True) <= margin for point in original)
        region = "floor" if cv.pointPolygonTest(self.floor, center, False) >= 0 else "wall_projection"
        geometry = "boundary" if partial and region == "floor" else region
        reasons = []
        score_margin = chosen["score"]-candidates[1]["score"] if len(candidates) > 1 else None
        if score_margin is not None and score_margin < .25:
            reasons.append("ambiguous_candidates")
        if chosen["density"] < .2 or chosen["aspect"] > 8:
            reasons.append("shape_inconsistent")
        if chosen["color_delta"] > 35:
            reasons.append("appearance_changed")
        if not .5 <= chosen["area_ratio"] <= 2:
            reasons.append("area_changed")
        if chosen["floor_fraction"] < .15 and not wall_association:
            reasons.append("outside_floor_candidate")
        if self.ram_body_margin:
            pixels = [(round(point[0]*self.scale), round(point[1]*self.scale)) for point in original]
            clipped = any(x <= 1 or y <= 1 or x >= self.size[0]-2 or y >= self.size[1]-2
                          or self.body_roi_distance[y, x] <= 1.5 for x, y in pixels)
        else:
            clipped = any(cv.pointPolygonTest(self.enclosure, point, True) <= 1.5/self.scale for point in original)
        if clipped:
            reasons.append("silhouette_clipped")
        reacquiring = self.tracker.last is None or not recent
        identity = "consistent" if self.tracker.last else "unverified"
        if not reasons and reacquiring and not initial_box:
            previous = self.pending_identity
            consistent = (previous is not None and 0 < timestamp-previous["time"] <= .5
                and math.dist(center, previous["center"]) <= max(chosen["bbox"]["width"], chosen["bbox"]["height"])*2
                and .5 <= area/previous["area"] <= 2
                and float(np.linalg.norm(chosen["appearance"]-previous["appearance"])) <= 35)
            self.pending_identity = {**chosen, "time": timestamp}
            if not consistent:
                reasons.append("identity_pending" if self.tracker.last is None else "reacquisition_pending")
            else:
                identity = "consistent"
        elif reasons:
            self.pending_identity = None
        elif initial_box:
            identity = "seeded"
        accepted = not reasons
        if accepted:
            self.tracker.observe(center, timestamp)
            self.last_area, self.last_box = area, dict(chosen["bbox"])
            if chosen["floor_fraction"] >= .5:
                self.area_history = [*self.area_history[-30:], area]
            if self.appearance is None:
                self.appearance = chosen["appearance"].copy()
                self.identity_shape = chosen["aspect"]
            self.pending_identity = None
        else:
            self.features.previous = None
        body = np.zeros(gray.shape, np.uint8)
        cv.drawContours(body, [contour], -1, 255, -1, offset=(-rx, -ry))
        if accepted:
            x, y, w, h = cv.boundingRect(contour)
            self.body_flow.observe(gray, body, {"x": x-rx, "y": y-ry, "width": w, "height": h}, timestamp)
        feature_engine = self.features if accepted else SilhouetteFeatures()
        features = feature_engine.extract(gray, body, timestamp, self.scale)
        from body_axis import appearance_contour
        x, y, w, h = cv.boundingRect(contour)
        axis_contour, axis_evidence = appearance_contour(lab[y-ry:y-ry+h, x-rx:x-rx+w], body[y-ry:y-ry+h, x-rx:x-rx+w],
            self.appearance, shift, chroma_shift, self.scale, (x, y))
        geometry_reasons = ["near_wall_or_partial"] if geometry != "floor" else []
        reason = reasons[0] if reasons else geometry_reasons[0] if geometry_reasons else "observed"
        return {"xPx": center[0], "yPx": center[1], "source": "segmented",
            "status": "valid" if accepted and geometry == "floor" else "low_confidence", "reason": reason,
            "spatialRegion": region, "bbox": chosen["bbox"], "contour": [{"x": p[0], "y": p[1]} for p in original],
            "features": features, "trackingAccepted": accepted,
            "bodyAxisContour": axis_contour, "bodyAxisEvidence": axis_evidence,
            "localQuality": {"tracking": "observed" if accepted else "uncertain", "geometry": geometry,
                             "identity": identity, "reasons": reasons+geometry_reasons},
            "candidateScore": chosen["score"], "candidateMargin": score_margin,
            "wallExtension": {"method":"connected_wall_foreground_v2","addedAreaPx":wall_pixels/self.scale**2},
            "floorOverlapFraction": chosen["floor_fraction"], **diagnostics}


def segmentation_thresholds(samples, config):
    """Gera limiares candidatos a partir da luminância dentro da área analisável."""
    import cv2 as cv
    import numpy as np
    if len(samples) < 2:
        raise ValueError("Vídeo curto demais para reconhecer o contraste do animal na arena")
    probe = Segmenter({**config, "mode": "light"})
    pixels = np.concatenate([probe.gray(frame)[probe.roi > 0][::8] for _, frame in samples])
    otsu = cv.threshold(pixels.reshape(-1, 1), 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU)[0]
    clamp = lambda value: max(1, min(254, int(round(value))))
    quantile = lambda q: float(np.quantile(pixels, q))
    return {
        "dark": sorted({clamp(value) for value in (otsu, quantile(.03), quantile(.08), quantile(.15), quantile(.25), quantile(.05)-8)}),
        "light": sorted({clamp(value) for value in (otsu, quantile(.75), quantile(.85), quantile(.9), quantile(.95), quantile(.97), quantile(.95)+8)}),
    }


def evaluate_segmentation(frames, config, thresholds, sampled_frames):
    """Pontua cada candidato por observações válidas em frames consecutivos."""
    candidates = {(mode, threshold): Segmenter({**config, "mode": mode, "threshold": threshold})
                  for mode, values in thresholds.items() for threshold in values}
    score = {candidate: 0. for candidate in candidates}
    valid = {candidate: 0 for candidate in candidates}
    count = 0
    for index, frame in frames:
        count += 1
        for candidate, detector in candidates.items():
            result = detector.process(frame, index / 30.)
            if result["source"] == "segmented" and result["status"] == "valid":
                score[candidate] += 3
                valid[candidate] += 1
            elif result["source"] == "segmented" and result["status"] == "low_confidence":
                score[candidate] += .15
            elif result.get("reason") == "ambiguous":
                score[candidate] -= 2
    ranked = sorted(score, key=score.get, reverse=True)
    selected = ranked[0]
    competing_mode = max((item for item in ranked if item[0] != selected[0]), key=score.get)
    if (valid[selected] < max(2, math.ceil(count * .08)) or score[selected] < 6
            or score[selected] - score[competing_mode] < max(3., score[selected] * .2)):
        raise ValueError("O contraste do animal não pôde ser reconhecido com segurança na área marcada. Confira o vídeo, a iluminação e a geometria antes de analisar.")
    return {"mode": selected[0], "threshold": selected[1], "sampledFrames": sampled_frames,
            "inspectedFrames": count, "validFrames": valid[selected],
            "scores": {f"{mode}:{threshold}": round(value, 2) for (mode, threshold), value in score.items()},
            "method": "roi_luminance_candidate_tracking_2"}


def select_segmentation(samples, config):
    return evaluate_segmentation(samples, config, segmentation_thresholds(samples, config), len(samples))


def inspect_video_segmentation(open_frames, config):
    import cv2 as cv
    width, height = config["width"], config["height"]
    scale = min(1., config.get("maxWidth", 1280) / width)
    size = (round(width * scale), round(height * scale))
    capture = open_frames()
    samples = []
    try:
        for index, frame in enumerate(capture):
            if index < 3 or index % 20 == 0:
                samples.append((index, cv.resize(frame, size)))
            if index >= 479:
                break
    finally:
        capture.close()
    thresholds = segmentation_thresholds(samples, config)
    capture = open_frames()
    def evaluated_frames():
        for index, frame in enumerate(capture):
            yield index, frame
            if index >= 479:
                break
    try:
        return evaluate_segmentation(evaluated_frames(), config, thresholds, len(samples))
    finally:
        capture.close()


def run(request_path):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    root, video = Path(request_path).parent, request["video"]
    status_path, samples_path = root/"status.json", root/"samples.jsonl"
    config = request["config"]
    started, parent = time.perf_counter(), os.getppid()
    profile = bool(config.get("benchmarkProfile", False))
    stage_seconds = {name: 0. for name in ("probe", "frame_read_wait", "tracking", "camera_guard", "serialization", "status_write")}
    frame_latencies_ms = []
    counts = {"observed": 0, "predicted": 0, "missing": 0, "suspect": 0, "manual": 0, "visual": 0, "uncertain": 0, "validObserved": 0}
    probe=json.loads(subprocess.check_output([request["ffprobe"],"-v","error","-select_streams","v:0","-show_streams","-show_format","-of","json",video]))
    metadata=probe["streams"][0]
    if profile: stage_seconds["probe"] += time.perf_counter()-started
    total=int(metadata.get("nb_frames","0")) if str(metadata.get("nb_frames","")).isdigit() else 0
    rotation = next((float(side["rotation"]) % 360 for side in metadata.get("side_data_list", [])
                     if "rotation" in side), 0)
    preparation = config.get("videoPreparation")
    autorotate = bool(config.get("autorotate", False) or preparation and preparation["status"] != "optimized")
    frame_size = (metadata["width"], metadata["height"])
    if autorotate and rotation in (90, 270):
        frame_size = frame_size[::-1]
    expected_size = ((preparation["uploadWidth"], preparation["uploadHeight"])
                     if preparation else (config["width"], config["height"]))
    if frame_size != expected_size or rotation not in ((0, 90, 180, 270) if autorotate else (0,)):
        raise ValueError("Resolução/rotação do vídeo não corresponde à arena. Reabra o original e confira a calibração")

    is_classical = config.get("strategy") == "classical_roi_v1"
    scale = min(1., config.get("maxWidth", 640)/config["width"])
    processing_size = (round(config["width"]*scale), round(config["height"]*scale)) if is_classical else None

    def open_frames():
        return read_frames(video, request["ffmpeg"], *frame_size, autorotate=autorotate, output_size=processing_size)

    selection = None
    reference_report = None
    fallback = None
    background = None
    is_ram_color = config.get("strategy") == "ram_color_geometry_v2"
    if is_classical:
        import cv2 as cv
        import numpy as np
        write_json(status_path, {"version": VERSION, "state": "running", "phase": "reference",
                                 "framesProcessed": 0, "totalFrames": total})
        size = processing_size
        duration = float(metadata.get("duration") or probe.get("format", {}).get("duration") or 0)
        samples = []
        try:
            for second, frame in reference_frames(video, request["ffmpeg"], *frame_size, duration, total,
                    autorotate, size, lambda: (root/"cancel").exists() or os.getppid() != parent, sample_count=31):
                samples.append((second, frame))
                write_json(status_path, {"version": VERSION, "state": "running", "phase": "reference",
                    "referenceFrames": len(samples), "framesProcessed": 0, "totalFrames": total})
        except InterruptedError:
            write_json(status_path, {"version": VERSION, "state": "cancelled", "phase": "reference"})
            return
        if len(samples) < 2:
            raise ValueError("Vídeo sem amostras suficientes para referência local")
        background = np.median(np.stack([frame for _, frame in samples]), axis=0).astype(np.uint8)
        # Uma única inspeção das amostras, sem duas leituras adicionais do vídeo.
        try:
            selection = select_segmentation(list(enumerate(frame for _, frame in samples)), config)
            fallback = Segmenter({**config, "mode": selection["mode"], "threshold": selection["threshold"]})
        except ValueError:
            selection = None
        reference_report = {"method": "session_median_sparse_seek" if duration > 0 else "session_median_bounded_prefix",
                            "sampleTimesSec": [second for second, _ in samples], "sampledFrames": len(samples),
                            "frozen": True, "staticFallbackAvailable": fallback is not None}
        cv.imwrite(str(root/"background-reference.png"), background)
        write_json(root/"reference.json", reference_report)
        config = {**config, "mode": "background"}
    elif config["mode"] == "auto" and not is_ram_color:
        write_json(status_path, {"version": VERSION, "state": "running", "phase": "recognition",
                                 "framesProcessed": 0, "totalFrames": total})
        selection = inspect_video_segmentation(open_frames, config)
        config = {**config, "mode": selection["mode"], "threshold": selection["threshold"]}
    capture = open_frames()
    if config["mode"] == "background" and not is_classical:
        reference = config.get("backgroundFrameIndex")
        if reference is None or reference < 0:
            raise ValueError("Selecione o frame de fundo vazio")
        for _ in range(reference + 1):
            background=next(capture,None)
            if background is None:raise ValueError("Frame de fundo não existe")
        capture.close()
        capture = open_frames()
    segmenter = (RobustSegmenter(config, background, [frame for _, frame in samples]) if is_classical
                 else Segmenter(config, background))
    color = None
    if is_ram_color:
        from ram_color import RamColorSegmenter, VERSION as color_version
        color = RamColorSegmenter(config, segmenter)
        config = {**config, "ramColor": color.params}
        (root / "masks").mkdir(exist_ok=True)
        segmenter.cv.imwrite(str(root / "walkable-mask.png"), segmenter.roi)
        write_json(root / "run_manifest.json", {"schemaVersion": "ram-local-2", "algorithmVersion": color_version,
            "config": config, "timing": "ffprobe_pts", "maskScale": segmenter.scale,
            "sourceVideoPreserved": True, "scientificallyValidated": False})
    hybrid = (HybridSegmenter(config, ReferenceSegmenter(segmenter, fallback) if is_classical else segmenter)
              if is_classical or config.get("strategy") == "hybrid_kalman_v1" else None)
    if is_classical:
        write_json(root/"run_manifest.json", {"schemaVersion": "classical-local-1", "algorithmVersion": VERSION,
            "config": config, "reference": reference_report, "timing": "ffprobe_pts",
            "featureSchema": "silhouette-features-1", "scientificallyValidated": False,
            "neuralFallback": "unavailable", "sourceVideoPreserved": True})
    guidance = config.get("guidance") or {}
    anchors = guidance.get("anchors") or []
    by_frame = {anchor["frameIndex"]: anchor for anchor in anchors}
    last_anchor = anchors[-1]["frameIndex"] if anchors else -1
    visual = ManualVisualTracker(config["width"], config["height"], segmenter.scale) if anchors else None
    # Amostra no máximo oito posturas verificadas, distribuídas pelo trecho.
    template_frames = {anchors[round(i*(len(anchors)-1)/min(7,len(anchors)-1))]["frameIndex"]
                       for i in range(min(8,len(anchors)))} if anchors else set()
    anchor_cursor = 0
    from body_axis import BodyAxisFilter
    body_axis_filter = BodyAxisFilter()
    layered = None
    if config.get("protocol") == "open_field":
        from oft_layers import LayeredTracker, POLICY
        layered = LayeredTracker(config["width"], config["height"], config.get("arena"))
    clock = timestamps(video, request["ffprobe"])
    intervention = None
    if is_classical and config.get("protocol") == "open_field":
        from behavior.intervention import InterventionGuard
        intervention = InterventionGuard(config, background)
    report = {"version": VERSION, "state": "running", "phase": "tracking", "framesProcessed": 0, "totalFrames": total, "counts": counts,
              "reasonCounts": {}, "qualityReasonCounts": {}, "trackingObservedFrames": 0,
              "geometryRejectedFrames": 0, "kalmanUpdateCount": 0,
              "reference": "box_center", "scientificallyValidated": False, "accuracyMeasured": False,
              "referenceApproved": config.get("referenceApproved", False), "timing": "ffprobe_pts", "elapsedSec": 0., "processingFps": 0.,
              "guidanceSourceJobId": guidance.get("sourceJobId"), "manualAnchorCount": len(anchors),
              "assistedMethod": "manual_templates_lk_1" if anchors else None,
              "strategy": config.get("strategy", "classic"), "neuralFallback": "unavailable" if hybrid else None,
              "computeBackend": "OpenCL parcial" if segmenter.opencl else "CPU",
              "segmentationSelection": selection,
              "backgroundReference": reference_report,
              "cameraMotionState": "unavailable", "cameraUncertainFrames": 0, "cameraMotionPx": None}
    write_json(status_path, report)
    index = 0
    last_frame = None
    try:
        with samples_path.open("w", encoding="utf-8", buffering=1) as output:
            pending = []

            def publish_pending(current_drift=False):
                write_started = time.perf_counter() if profile else 0.
                for sample, flagged, measured_px, source_frame in pending:
                    flagged = flagged or current_drift
                    if flagged and sample["status"] != "missing":
                        sample.update(status="low_confidence", spatialRegion="unknown",
                                      segmentReason=sample["reason"], reason="camera_shift",
                                      cameraMotionPx=segmenter.motion_guard.motion_px if current_drift else measured_px)
                        if sample.get("localQuality"):
                            sample["localQuality"] = {**sample["localQuality"], "tracking": "uncertain", "geometry": "unknown",
                                                      "reasons": [*sample["localQuality"]["reasons"], "camera_shift"]}
                        sample["trackingAccepted"] = False
                    if is_ram_color:
                        sample["observationState"] = "missing" if sample["status"] == "missing" else "observed" if sample["status"] == "valid" and sample["source"] != "predicted" else "uncertain"
                    if sample.get("features"):
                        sample["features"]["observationUsable"] = sample["status"] == "valid" and sample["source"] == "segmented"
                    if config.get("protocol") == "open_field":
                        from behavior.observation_quality import behavior_observation_quality
                        sample["behaviorObservation"] = behavior_observation_quality(sample)
                    sample["bodyAxis"] = body_axis_filter.update(sample)
                    if layered:
                        sample["oftLayers"] = layered.update(source_frame, sample)
                    axis_reason = sample["bodyAxis"]["reason"]
                    report.setdefault("bodyAxisQualityCounts", {})[axis_reason] = report.get("bodyAxisQualityCounts", {}).get(axis_reason, 0)+1
                    output.write(json.dumps(sample, allow_nan=False) + "\n")
                    bucket = "missing" if sample["status"] == "missing" else "manual" if sample["source"] == "manual" else "visual" if sample["source"] == "recovered" else "predicted" if sample["source"] == "predicted" else "observed"
                    if is_ram_color and sample["status"] == "low_confidence": bucket = "uncertain"
                    counts[bucket] += 1
                    counts["validObserved"] += sample["status"] == "valid" and sample["source"] == "segmented"
                    counts["suspect"] += sample["status"] == "low_confidence"
                    report["reasonCounts"][sample["reason"]] = report["reasonCounts"].get(sample["reason"], 0)+1
                    quality = sample.get("localQuality") or {}
                    for reason in quality.get("reasons", []):
                        report["qualityReasonCounts"][reason] = report["qualityReasonCounts"].get(reason, 0)+1
                    tracked = sample.get("trackingAccepted", False) and sample["source"] == "segmented"
                    report["trackingObservedFrames"] += bool(tracked)
                    report["geometryRejectedFrames"] += bool(tracked and quality.get("geometry") != "floor")
                    report["kalmanUpdateCount"] += bool(sample.get("kalmanUpdated", False))
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
                if intervention and intervention.stopped is not None:
                    result = intervention.suppress({})
                elif index in by_frame:
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
                elif color:
                    result = color.process(frame, timestamp)
                    mask_name = f"masks/{index:08d}.png"
                    if not segmenter.cv.imwrite(str(root / mask_name), color.foreground):
                        raise OSError("Não foi possível preservar a máscara RAM")
                    result["maskArtifact"] = mask_name
                elif hybrid:
                    result = hybrid.process(frame, timestamp)
                else:
                    result = segmenter.process(frame, timestamp)
                if intervention:
                    termination = intervention.update(frame, timestamp, result)
                    if termination:
                        report["trackingTermination"] = termination
                    result = intervention.suppress(result)
                if profile: stage_seconds["tracking"] += time.perf_counter()-tracking_started
                guard_started = time.perf_counter() if profile else 0.
                camera_state = segmenter.assess_camera(frame, index, exclude_box=result.get("bbox"))
                if profile: stage_seconds["camera_guard"] += time.perf_counter()-guard_started
                sample = {"frameIndex": index, "timestampSec": timestamp, "keypoint": "box_center", "likelihood": 0,
                          "metricReference": "box_center", "referenceApproved": config.get("referenceApproved", False), **result}
                pending.append((sample, camera_state == "drift", segmenter.motion_guard.motion_px, frame if layered else None))
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
            report.update(framesProcessed=index, elapsedSec=elapsed, processingFps=index/max(.001, elapsed), observationCoveragePct=100*counts["observed"]/max(1,index),
                          validObservationCoveragePct=100*counts["validObserved"]/max(1,index),
                          trackingObservedCoveragePct=100*report["trackingObservedFrames"]/max(1,index),
                          reviewRequiredFrames=counts["suspect"]+counts["missing"])
            if profile and frame_latencies_ms:
                ordered = sorted(frame_latencies_ms)
                report["benchmarkProfile"] = {"stageSeconds": stage_seconds,
                    "frameLatencyMeanMs": sum(ordered)/len(ordered),
                    "frameLatencyP95Ms": ordered[min(len(ordered)-1, int(.95*len(ordered)))],
                    "frameLatencyMaxMs": ordered[-1],
                    "frameLatencyDefinition": "read_frame_return_to_sample_and_periodic_status; ffmpeg decode and PTS run concurrently"}
        if layered and report["state"] == "succeeded":
            from oft_layers import finish_layers, atomic_json, digest
            report["layers"] = POLICY
            report["rearing"] = finish_layers(root, video, config, request.get("rearingModelDirectory"),
                cancelled=lambda: (root/"cancel").exists() or os.getppid() != parent,
                ffmpeg=request["ffmpeg"],ffprobe=request["ffprobe"])
            atomic_json(root/"layer_manifest.json", dict(policy=POLICY, frameCount=index,
                samplesSha256=digest(samples_path), sourceVideoPreserved=True))
        if request.get("auditVideo"):
            from local_audit_video import finalize
            finalize(request, root, report, parent, write_json)
        write_json(status_path, report)
    except InterruptedError:
        report.update(state="cancelled", framesProcessed=index, elapsedSec=time.perf_counter()-started)
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
