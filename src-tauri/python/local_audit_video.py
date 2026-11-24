"""Render saved local observations over the exact video used for tracking."""
from itertools import groupby
from collections import deque
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time


OBSERVED = "B4DE51"  # ASS colors are BGR.
UNCERTAIN = "64C5FF"
PREDICTED = "F19DD5"
MISSING = "A0A0A0"
REGION = "E7A66B"
AXIS = "FFE76B"
VISUALIZATION_VERSION = "local-audit-4"


def accepted_body(row, is_fst=False):
    if is_fst:
        return row.get("presence") == "IN_TANK"
    if row.get("status") in {"missing", "jump"} or row.get("reason") == "camera_shift":
        return False
    if row.get("source") in {"predicted", "recovered"}:
        return False
    if row.get("trackingAccepted") is False:
        return False
    quality = row.get("localQuality") or {}
    if quality and quality.get("tracking") != "observed":
        return False
    return row.get("trackingAccepted") is True or row.get("status") == "valid"


def visible_silhouette(row, is_fst=False):
    if not row.get("bbox") or not row.get("contour"):
        return False
    if is_fst:
        return row.get("presence") == "IN_TANK"
    return row.get("status") not in {"missing", "out_of_arena"} and row.get("source") != "predicted"


def silhouette_axis(contour, direction_hint=None):
    """Linha central aproximada por secções da máscara; sem identidade anatômica.

    Trabalha apenas no recorte corporal de até 96 px. Cada ponto permanece
    dentro da silhueta. A direção de exibição nunca identifica cabeça/cauda.
    """
    import cv2 as cv
    import numpy as np
    if not contour or len(contour) < 3:
        return None
    points = np.asarray([[p["x"], p["y"]] for p in contour], np.float32)
    if not np.isfinite(points).all():
        return None
    origin = points.min(axis=0)
    extent = points.max(axis=0)-origin
    if min(extent) < 3:
        return None
    factor = min(1., 94/max(extent))
    local = np.round((points-origin)*factor).astype(np.int32)+1
    mask = np.zeros((int(local[:, 1].max())+2, int(local[:, 0].max())+2), np.uint8)
    cv.fillPoly(mask, [local], 255)
    y, x = np.nonzero(mask)
    if len(x) < 16:
        return None
    pixels = np.column_stack((x, y)).astype(np.float32)
    eigenvalues, vectors = np.linalg.eigh(np.cov(pixels.T))
    if eigenvalues[-1] < 1.6*max(1., eigenvalues[0]):
        direction = np.asarray(direction_hint if direction_hint is not None else [1., 0.], np.float32)
        if direction.shape != (2,) or not np.isfinite(direction).all() or np.linalg.norm(direction) < .001:
            direction = np.array([1., 0.], np.float32)
        direction /= np.linalg.norm(direction)
    else:
        direction = vectors[:, -1]
    if direction[np.argmax(np.abs(direction))] < 0:
        direction = -direction
    projection = pixels@direction
    low, high = np.quantile(projection, [.05, .95])
    edges = np.linspace(low, high, 8)
    distance = cv.distanceTransform(mask, cv.DIST_L2, 3)[y, x]
    path = []
    for start, end in zip(edges, edges[1:]):
        selected = (projection >= start) & (projection <= end)
        section = pixels[selected]
        if not len(section):
            continue
        center = np.average(section, axis=0, weights=distance[selected]**2)
        nearest = section[np.argmin(np.sum((section-center)**2, axis=1))]
        point = (nearest-1)/factor+origin
        path.append((float(point[0]), float(point[1])))
    # Não conecte regiões de um corpo muito côncavo através do fundo.
    longest, current = [], path[:1]
    for a, b in zip(path, path[1:]):
        segment = np.linspace((np.asarray(a)-origin)*factor+1,
                              (np.asarray(b)-origin)*factor+1, 12).round().astype(int)
        if np.mean(mask[segment[:, 1], segment[:, 0]] > 0) < .8:
            if len(current) > len(longest):
                longest = current
            current = []
        current.append(b)
    if len(current) > len(longest):
        longest = current
    return longest if len(longest) >= 3 else None


class DisplacementChart:
    """Série causal em px/s do centro da caixa; lacunas nunca viram zeros."""
    def __init__(self, is_fst=False):
        self.is_fst = is_fst
        self.previous = {}
        self.history = deque()
        self.pairs = 0

    def update(self, index, timestamp, items):
        values = {}
        for _, _, box, row in items:
            subject = row.get("animalId", "body")
            value = None
            old = self.previous.pop(subject, None)
            if box and accepted_body(row, self.is_fst):
                center = (box["x"]+box["width"]/2, box["y"]+box["height"]/2)
                if all(math.isfinite(v) for v in center):
                    dt = timestamp-old[1] if old else 0
                    if old and old[0] == index-1 and 0 < dt <= .5:
                        value = math.dist(center, old[2])/dt
                        self.pairs += 1
                    self.previous[subject] = (index, timestamp, center)
            values[subject] = value
        self.history.append((timestamp, values))
        while self.history and self.history[0][0] < timestamp-10:
            self.history.popleft()
        return values

    def drawing(self, timestamp, values, width, height):
        margin = max(6, round(height*.02))
        panel_w = min(width-2*margin, max(100, round(width*.29)))
        panel_h = min(height-2*margin, max(76, round(height*.23)))
        left, top = width-margin-panel_w, margin
        font = max(8, round(height*.019))
        scale = (1, 1)
        parts = [filled_rectangle(left, top, panel_w, panel_h, "17140F", "25")]
        def text(x, y, value, color="FFFFFF", size=font):
            size = max(6., min(size, (panel_w-12)/max(1., len(value)*.55)))
            parts.append(rf"{{\an7\pos({x},{y})\p0\fs{size:.1f}\1a&H00&\1c&H{color}&\bord0}}{value}")
        text(left+6, top+4, "DESLOCAMENTO - IMAGEM")
        current = "  ".join((f"C{i+1}: " if self.is_fst else "")+
                            (f"{v:.1f}" if v is not None else "--") for i, v in enumerate(values.values()))
        text(left+6, top+font+7, current+" px/s", OBSERVED)
        x0, x1 = left+18, left+panel_w-8
        y0, y1 = top+font*2+13, top+panel_h-font-9
        parts.append(outline([(x0, y0), (x0, y1)], MISSING, .7, scale))
        parts.append(outline([(x0, y1), (x1, y1)], MISSING, .7, scale))
        cap = max(2., max((v for _, series in self.history for v in series.values() if v is not None), default=0))
        text(left+3, y0, f"{cap:.0f}", MISSING, max(6, font-2))
        text(left+5, y1-font, "0", MISSING, max(6, font-2))
        any_pairs = False
        for subject_index, subject in enumerate(values):
            color = OBSERVED if subject_index == 0 else PREDICTED
            segment = []
            def flush():
                if len(segment) >= 2:
                    commands = " ".join(f"m {a[0]} {a[1]} l {b[0]} {b[1]}"
                                        for a, b in zip(segment, segment[1:]))
                    parts.append(rf"{{\an7\pos(0,0)\p1\bord{max(1, height*.002)}\1a&HFF&\3c&H{color}&}}"
                                 +commands+r"{\p0}")
            for time_sec, series in self.history:
                value = series.get(subject)
                if value is None:
                    flush(); segment = []
                    continue
                any_pairs = True
                point = (round(x0+(time_sec-timestamp+10)/10*(x1-x0)), round(y1-value/cap*(y1-y0)))
                # Um ponto por coluna, preservando a interrupção em cada lacuna.
                if segment and segment[-1][0] == point[0]:
                    segment[-1] = point
                else:
                    segment.append(point)
            flush()
        if not any_pairs:
            text(x0+3, y0+max(0, (y1-y0-font)//2), "Sem pares observados", MISSING, max(6, font-1))
        text(x0, y1+3, "-10 s", MISSING, max(6, font-1))
        text(x1-font*3, y1+3, "agora", MISSING, max(6, font-1))
        return parts


class RenderCancelled(Exception):
    pass


def ass_time(centiseconds):
    seconds, fraction = divmod(centiseconds, 100)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{fraction:02d}"


def event(start, end, text, layer=0):
    return f"Dialogue: {layer},{ass_time(start)},{ass_time(end)},Audit,,0,0,0,,{text}\n"


def outline(points, color, stroke, scale):
    coordinates = " l ".join(f"{round(x * scale[0])} {round(y * scale[1])}" for x, y in points)
    return (rf"{{\an7\pos(0,0)\p1\bord{stroke}\1a&HFF&\3c&H{color}&}}"
            rf"m {coordinates}{{\p0}}")


def rectangle(box, color, stroke, scale):
    left, top = box["x"], box["y"]
    right, bottom = left + box["width"], top + box["height"]
    return outline([(left, top), (right, top), (right, bottom), (left, bottom)], color, stroke, scale)


def filled_rectangle(x, y, width, height, color, alpha="00"):
    return (rf"{{\an7\pos(0,0)\p1\bord0\1c&H{color}&\1a&H{alpha}&}}"
            rf"m {round(x)} {round(y)} l {round(x+width)} {round(y)} "
            rf"{round(x+width)} {round(y+height)} {round(x)} {round(y+height)}{{\p0}}")


def observations(root, is_fst):
    if is_fst:
        result = json.loads((root / "result.json").read_text(encoding="utf-8"))
        animals = {tank["animalId"]: index for index, tank in enumerate(result["tanks"], 1)}
        for index, rows in groupby(result["frames"], key=lambda row: row["frame"]):
            rows = list(rows)
            if {row["animalId"] for row in rows} != animals.keys() or len(rows) != len(animals):
                raise ValueError("Registros de presença incompletos para o vídeo de auditoria")
            rows.sort(key=lambda row: animals[row["animalId"]])
            items = []
            for row in rows:
                label, color = {"IN_TANK": ("Presente", OBSERVED), "UNCERTAIN": ("Incerto", UNCERTAIN),
                                "NOT_IN_TANK": ("Ausente", MISSING)}[row["presence"]]
                box = row.get("bbox") if row["presence"] != "NOT_IN_TANK" else None
                items.append((f"Cilindro {animals[row['animalId']]}: {label}", color, box, row))
            yield index, rows[0]["timestampSec"], items
        return
    with (root / "samples.jsonl").open(encoding="utf-8") as samples:
        for line in samples:
            row = json.loads(line)
            if row["status"] == "missing":
                label, color = "Sem detecção", MISSING
            elif row["source"] == "predicted":
                label, color = "Previsto", PREDICTED
            elif row.get("reason") == "camera_shift":
                label, color = "Incerto (movimento da câmera)", UNCERTAIN
            elif row["status"] != "valid":
                label, color = "Incerto", UNCERTAIN
            elif row["source"] == "manual":
                label, color = "Caixa manual", OBSERVED
            else:
                label, color = "Observado", OBSERVED
            box = row.get("bbox") if row["status"] != "missing" else None
            yield row["frameIndex"], row["timestampSec"], [(label, color, box, row)]


def write_annotations(path, root, config, width, height, cancelled):
    scale = width / config["width"], height / config["height"]
    font = max(12, round(height * .032))
    stroke = max(1, round(height * .003))
    is_fst = config.get("protocol") == "forced_swim"
    chart = DisplacementChart(is_fst)
    skeleton_frames = 0
    uncertain_skeletons = 0
    previous_axes = {}
    with path.open("w", encoding="utf-8") as out:
        out.write(f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Audit,Arial,{font},&H00FFFFFF,&H00FFFFFF,&H00121714,&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,8,8,8,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""")
        previous = None

        def write_frame(row, end):
            nonlocal skeleton_frames, uncertain_skeletons
            start, index, timestamp, items = row
            labels = r"\N".join(rf"{{\1c&H{color}&}}{label}" for label, color, _, _ in items)
            out.write(event(start, end, rf"AUDITORIA LOCAL  |  Frame {index + 1}  |  {timestamp:.3f} s\N{labels}", 2))
            for _, color, box, sample in items:
                if box:
                    out.write(event(start, end, rectangle(box, color, stroke, scale), 1))
                subject = sample.get("animalId", "body")
                old = previous_axes.pop(subject, None)
                hint = None
                if old and index == old[0]+1 and 0 < timestamp-old[1] <= .25 and box and old[3]:
                    previous_box = old[3]
                    movement = math.hypot(box["x"]+box["width"]/2-previous_box["x"]-previous_box["width"]/2,
                                          box["y"]+box["height"]/2-previous_box["y"]-previous_box["height"]/2)
                    if movement <= math.hypot(previous_box["width"], previous_box["height"]):
                        hint = [old[2][-1][0]-old[2][0][0], old[2][-1][1]-old[2][0][1]]
                path = silhouette_axis(sample.get("contour"), hint) if visible_silhouette(sample, is_fst) else None
                if path:
                    previous_axes[subject] = (index, timestamp, path, box)
                    uncertain = not accepted_body(sample, is_fst)
                    axis_color = UNCERTAIN if uncertain else AXIS
                    uncertain_skeletons += int(uncertain)
                    skeleton_frames += 1
                    for a, b in zip(path, path[1:]):
                        out.write(event(start, end, outline([a, b], axis_color, stroke, scale), 1))
                    for x, y in path:
                        radius = max(2, round(height*.003))
                        out.write(event(start, end, filled_rectangle(x*scale[0]-radius, y*scale[1]-radius,
                                                                    radius*2, radius*2, axis_color), 1))
                    out.write(event(start, end, rf"{{\an1\pos(8,{height-8})\fs{max(10, round(font*.7))}}}"+
                                    ("Silhueta incerta | " if uncertain else "")+
                                    "Eixo da silhueta estimado - sem identidade anatômica", 2))
            values = chart.update(index, timestamp, items)
            for drawing in chart.drawing(timestamp, values, width, height):
                out.write(event(start, end, drawing, 3))

        for expected, (index, timestamp, items) in enumerate(observations(root, is_fst)):
            if cancelled():
                raise RenderCancelled()
            if index != expected or not math.isfinite(timestamp) or (previous is None and timestamp != 0) or (
                previous and timestamp - previous[2] < .002
            ):
                raise ValueError("Frames ou timestamps inconsistentes para renderizar a auditoria")
            # Change overlays between video frames, away from rounding at their exact PTS.
            # The filter stretches PTS 10×, giving ASS ticks of 1 ms of source time.
            start = round((timestamp + previous[2]) * 500) if previous else 0
            if previous:
                write_frame(previous, start)
            previous = start, index, timestamp, items
        if previous is None:
            raise ValueError("A execução não contém observações para renderizar")
        last_end = math.ceil(previous[2] * 1000) + 100
        write_frame(previous, last_end)
        if is_fst:
            for tank in config["tanks"]:
                out.write(event(0, last_end, rectangle(tank["roiPx"], REGION, stroke, scale)))
        else:
            polygon = config.get("walkablePolygonPx") or (config.get("arena") or {}).get("cornersPx", [])
            if polygon:
                out.write(event(0, last_end, outline([(p["x"], p["y"]) for p in polygon], REGION, stroke, scale)))
    return {"version": VISUALIZATION_VERSION, "skeletonMethod": "silhouette_cross_sections_1",
            "anatomicalPose": False, "skeletonFrames": skeleton_frames,
            "uncertainSkeletonObservations": uncertain_skeletons, "skeletonVisibility": "current_mask_independent_of_metric_eligibility",
            "displacementChart": {"position": "top_right", "units": "px/s", "reference": "box_center",
                                  "coordinateSpace": "source_image", "windowSec": 10, "maxPairGapSec": .5,
                                  "validPairs": chart.pairs, "scientificMetric": False}}


def render(request, root, destination, cancelled):
    config, video = request["config"], request["video"]
    if not Path(video).is_file():
        raise ValueError("O vídeo usado na análise saiu do cache. Analise novamente com o arquivo original.")
    preparation = config.get("videoPreparation")
    width, height = ((preparation["uploadWidth"], preparation["uploadHeight"])
                     if preparation else (config["width"], config["height"]))
    orientation = [] if config.get("autorotate", False) or preparation and preparation["status"] != "optimized" else ["-noautorotate"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="audit-", dir=root) as work:
        work = Path(work)
        visualization = write_annotations(work / "annotations.ass", root, config, width, height, cancelled)
        with TemporaryDirectory(prefix="audit-", dir=destination.parent) as staging:
            partial = Path(staging) / "video.mp4"
            filters = ("settb=1/1000000,setpts=(PTS-STARTPTS)*10,ass=annotations.ass,"
                       "setpts=PTS/10,pad=ceil(iw/2)*2:ceil(ih/2)*2")
            with (work / "ffmpeg.log").open("w+b") as log:
                with subprocess.Popen([
                    request["ffmpeg"], "-nostdin", "-v", "error", *orientation, "-i", video,
                    "-map", "0:v:0", "-vf", filters, "-an", "-c:v", "libx264", "-preset", "veryfast",
                    # Avoid an MP4 edit list clipping the final VFR frame.
                    # Disabling B frames also keeps the original zero PTS origin.
                    "-crf", "20", "-bf", "0", "-use_editlist", "0", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000",
                    "-movflags", "+faststart", str(partial),
                ], cwd=work, stdout=subprocess.DEVNULL, stderr=log) as child:
                    try:
                        while child.poll() is None:
                            if cancelled():
                                raise RenderCancelled()
                            time.sleep(.15)
                    finally:
                        if child.poll() is None:
                            child.kill()
                if child.returncode != 0:
                    log.seek(0)
                    details = log.read(1200).decode("utf-8", errors="replace").strip()
                    raise ValueError(f"O FFmpeg não conseguiu renderizar o vídeo de auditoria. {details}".strip())
            if cancelled():
                raise RenderCancelled()
            if not partial.is_file() or partial.stat().st_size == 0:
                raise ValueError("O FFmpeg não gerou o vídeo de auditoria")
            os.replace(partial, destination)
            metadata = root/"video_overlay.json"
            temporary = metadata.with_suffix(".tmp")
            temporary.write_text(json.dumps(visualization, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            os.replace(temporary, metadata)
            return visualization


def finalize(request, root, report, parent, write_json):
    destination = request.get("auditVideo")
    if not destination or report["state"] != "succeeded":
        return
    status = root / "status.json"
    write_json(status, {**report, "state": "running", "phase": "rendering"})
    try:
        report["videoVisualization"] = render(request, root, Path(destination), lambda: (root / "cancel").exists() or os.getppid() != parent)
    except RenderCancelled:
        report["state"] = "cancelled"
    except (OSError, ValueError, KeyError, TypeError) as error:
        report["videoError"] = str(error)[:1500]
    report["phase"] = "complete"


if __name__ == "__main__":
    request_path, destination, ffmpeg = map(Path, sys.argv[1:])
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        request["ffmpeg"] = str(ffmpeg)
        parent = os.getppid()
        render(request, request_path.parent, destination, lambda: os.getppid() != parent)
    except (OSError, ValueError, KeyError, TypeError, RenderCancelled) as error:
        print(str(error) or "Renderização interrompida", file=sys.stderr)
        raise SystemExit(1)
