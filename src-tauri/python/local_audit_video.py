"""Render saved local observations over the exact video used for tracking."""
from itertools import groupby
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


def observations(root, is_fst):
    if is_fst:
        result = json.loads((root / "result.json").read_text(encoding="utf-8"))
        animals = {tank["animalId"]: index for index, tank in enumerate(result["tanks"], 1)}
        for index, rows in groupby(result["frames"], key=lambda row: row["frame"]):
            rows = list(rows)
            if {row["animalId"] for row in rows} != animals.keys() or len(rows) != len(animals):
                raise ValueError("Registros de presença incompletos para o vídeo de auditoria")
            items = []
            for row in rows:
                label, color = {"IN_TANK": ("Presente", OBSERVED), "UNCERTAIN": ("Incerto", UNCERTAIN),
                                "NOT_IN_TANK": ("Ausente", MISSING)}[row["presence"]]
                box = row.get("bbox") if row["presence"] != "NOT_IN_TANK" else None
                items.append((f"Cilindro {animals[row['animalId']]}: {label}", color, box))
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
            yield row["frameIndex"], row["timestampSec"], [(label, color, box)]


def write_annotations(path, root, config, width, height, cancelled):
    scale = width / config["width"], height / config["height"]
    font = max(12, round(height * .032))
    stroke = max(1, round(height * .003))
    is_fst = config.get("protocol") == "forced_swim"
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
            start, index, timestamp, items = row
            labels = r"\N".join(rf"{{\1c&H{color}&}}{label}" for label, color, _ in items)
            out.write(event(start, end, rf"AUDITORIA LOCAL  |  Frame {index + 1}  |  {timestamp:.3f} s\N{labels}", 2))
            for _, color, box in items:
                if box:
                    out.write(event(start, end, rectangle(box, color, stroke, scale), 1))

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


def render(request, root, destination, cancelled):
    config, video = request["config"], request["video"]
    if not Path(video).is_file():
        raise ValueError("O vídeo usado na análise saiu do cache. Analise novamente com o arquivo original.")
    preparation = config.get("videoPreparation")
    width, height = ((preparation["uploadWidth"], preparation["uploadHeight"])
                     if preparation else (config["width"], config["height"]))
    orientation = [] if preparation and preparation["status"] != "optimized" else ["-noautorotate"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="audit-", dir=root) as work:
        work = Path(work)
        write_annotations(work / "annotations.ass", root, config, width, height, cancelled)
        with TemporaryDirectory(prefix="audit-", dir=destination.parent) as staging:
            partial = Path(staging) / "video.mp4"
            filters = ("settb=1/1000000,setpts=(PTS-STARTPTS)*10,ass=annotations.ass,"
                       "setpts=PTS/10,pad=ceil(iw/2)*2:ceil(ih/2)*2")
            with (work / "ffmpeg.log").open("w+b") as log:
                with subprocess.Popen([
                    request["ffmpeg"], "-nostdin", "-v", "error", *orientation, "-i", video,
                    "-map", "0:v:0", "-vf", filters, "-an", "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "20", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000",
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


def finalize(request, root, report, parent, write_json):
    destination = request.get("auditVideo")
    if not destination or report["state"] != "succeeded":
        return
    status = root / "status.json"
    write_json(status, {**report, "state": "running", "phase": "rendering"})
    try:
        render(request, root, Path(destination), lambda: (root / "cancel").exists() or os.getppid() != parent)
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
