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

VERSION = "opencv-box-4"


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


class Segmenter:
    def __init__(self, config, background=None):
        import cv2
        import numpy as np
        self.cv, self.np = cv2, np
        cv2.setNumThreads(2)
        self.config, self.background = config, background
        self.width, self.height = config["width"], config["height"]
        self.scale = min(1., config.get("maxWidth", 1280)/self.width)
        self.size = (round(self.width*self.scale), round(self.height*self.scale))
        self.floor = np.array([[p["x"], p["y"]] for p in config["arena"]["cornersPx"]], np.float32)
        rim = config["arena"].get("rimCornersPx") or config["arena"]["cornersPx"]
        self.enclosure = np.array([[p["x"], p["y"]] for p in rim], np.float32)
        self.roi = np.zeros((self.size[1], self.size[0]), np.uint8)
        cv2.fillPoly(self.roi, [np.round(self.enclosure*self.scale).astype(np.int32)], 255)
        self.roi_area = cv2.countNonZero(self.roi)
        if self.roi_area < 16:
            raise ValueError("Arena inválida para segmentação")
        if background is not None:
            self.background = self.gray(background)
        self.tracker = TemporalTracker(config.get("maxPredictionSec", .25))
        self.last_area = None
        self.last_box = None
        self.appearance = None

    def gray(self, frame):
        return self.cv.GaussianBlur(self.cv.cvtColor(self.cv.resize(frame, self.size), self.cv.COLOR_BGR2GRAY), (5, 5), 0)

    def reset_to_anchor(self, box, timestamp):
        center = (box["x"]+box["width"]/2, box["y"]+box["height"]/2)
        self.tracker.last = (*center, timestamp)
        self.tracker.velocity = (0., 0.)
        self.last_box = dict(box)
        self.last_area = None
        self.appearance = None  # Uma detecção anterior errada não veta a caixa humana.

    def process(self, frame, timestamp, guide_box=None):
        cv, np, config = self.cv, self.np, self.config
        gray = self.gray(frame)
        color = cv.cvtColor(cv.resize(frame, self.size), cv.COLOR_BGR2LAB)
        mode, threshold = config["mode"], config["threshold"]
        if mode == "background":
            if self.background is None:
                raise ValueError("Selecione um frame com a caixa realmente vazia para usar subtração do fundo")
            mask = cv.threshold(cv.absdiff(gray, self.background), threshold, 255, cv.THRESH_BINARY)[1]
        else:
            mask = cv.threshold(gray, threshold, 255, cv.THRESH_BINARY if mode == "light" else cv.THRESH_BINARY_INV)[1]
        mask = cv.bitwise_and(mask, self.roi)
        kernel = np.ones((3, 3), np.uint8)
        mask = cv.morphologyEx(cv.morphologyEx(mask, cv.MORPH_OPEN, kernel), cv.MORPH_CLOSE, kernel)
        contours = cv.findContours(mask, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)[0]
        candidates = []
        for contour in contours:
            area = float(cv.contourArea(contour))
            if not self.roi_area*config["minAreaFraction"] <= area <= self.roi_area*config["maxAreaFraction"]:
                continue
            moment = cv.moments(contour)
            if moment["m00"] <= 0:
                continue
            x, y, width, height = cv.boundingRect(contour)
            center = ((x + width/2)/self.scale, (y + height/2)/self.scale)
            if guide_box:
                gx, gy = guide_box["x"]*self.scale, guide_box["y"]*self.scale
                gw, gh = guide_box["width"]*self.scale, guide_box["height"]*self.scale
                intersection = max(0, min(x+width,gx+gw)-max(x,gx))*max(0,min(y+height,gy+gh)-max(y,gy))
                if intersection/max(1, min(width*height, gw*gh)) < .25:
                    continue
            contour_mask = np.zeros_like(mask)
            cv.drawContours(contour_mask, [contour], -1, 255, -1)
            appearance = np.array(cv.mean(color, mask=contour_mask)[:3])
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
    counts = {"observed": 0, "predicted": 0, "missing": 0, "suspect": 0, "manual": 0, "visual": 0}
    metadata=json.loads(subprocess.check_output([request["ffprobe"],"-v","error","-select_streams","v:0","-show_streams","-of","json",video]))["streams"][0]
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
              "strategy": config.get("strategy", "classic"), "neuralFallback": "unavailable" if hybrid else None}
    write_json(status_path, report)
    try:
        with samples_path.open("w", encoding="utf-8", buffering=1) as output:
            index = 0
            while True:
                if (root/"cancel").exists() or os.getppid() != parent:
                    report["state"] = "cancelled"
                    break
                frame=next(capture,None)
                if frame is None:
                    report["state"] = "succeeded"
                    break
                timestamp = next(clock, None)
                if timestamp is None:
                    raise ValueError("Frames e timestamps divergiram; resultado não publicado")
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
                        if observed["source"] == "segmented" and observed["bbox"]:
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
                sample = {"frameIndex": index, "timestampSec": timestamp, "keypoint": "box_center", "likelihood": 0,
                          "metricReference": "box_center", "referenceApproved": config.get("referenceApproved", False), **result}
                output.write(json.dumps(sample, allow_nan=False) + "\n")
                bucket = "missing" if result["status"] == "missing" else "manual" if result["source"] == "manual" else "visual" if result["source"] == "recovered" else "predicted" if result["source"] == "predicted" else "observed"
                counts[bucket] += 1
                counts["suspect"] += result["status"] == "low_confidence"
                index += 1
                if index % 12 == 0:
                    elapsed = time.perf_counter()-started
                    report.update(framesProcessed=index, elapsedSec=elapsed, processingFps=index/max(.001, elapsed))
                    write_json(status_path, report)
            if index == 0 and report["state"] == "succeeded":
                raise ValueError("O decoder não conseguiu ler nenhum frame")
            if report["state"] == "succeeded" and next(clock, None) is not None:
                raise ValueError("O decoder encerrou antes do fim dos timestamps")
            elapsed = time.perf_counter()-started
            report.update(framesProcessed=index, elapsedSec=elapsed, processingFps=index/max(.001, elapsed), observationCoveragePct=100*counts["observed"]/max(1,index))
            write_json(status_path, report)
    finally:
        capture.close()
        clock.close()


if __name__ == "__main__":
    try:
        run(sys.argv[1])
    except BaseException as error:
        import traceback
        traceback.print_exc()
        write_json(Path(sys.argv[1]).parent/"status.json", {"version": VERSION, "state": "failed", "error": str(error)[:2000]})
        raise SystemExit(1)
