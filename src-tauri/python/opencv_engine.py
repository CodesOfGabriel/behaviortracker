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

VERSION = "opencv-box-2"


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

    def process(self, frame, timestamp):
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
        target = prediction or (self.tracker.last if self.tracker.last and timestamp-self.tracker.last[2] <= self.tracker.max_gap else None)
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
    counts = {"observed": 0, "predicted": 0, "missing": 0, "suspect": 0}
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
    clock = timestamps(video, request["ffprobe"])
    report = {"version": VERSION, "state": "running", "framesProcessed": 0, "totalFrames": total, "counts": counts,
              "reference": "box_center", "scientificallyValidated": False, "accuracyMeasured": False,
              "referenceApproved": config.get("referenceApproved", False), "timing": "ffprobe_pts", "elapsedSec": 0., "processingFps": 0.}
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
                result = segmenter.process(frame, timestamp)
                sample = {"frameIndex": index, "timestampSec": timestamp, "keypoint": "box_center", "likelihood": 0,
                          "metricReference": "box_center", "referenceApproved": config.get("referenceApproved", False), **result}
                output.write(json.dumps(sample, allow_nan=False) + "\n")
                counts["predicted" if result["source"] == "predicted" else "missing" if result["status"] == "missing" else "observed"] += 1
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
