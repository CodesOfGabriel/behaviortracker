#!/usr/bin/env python3
"""Seleciona frames e clipes por vídeo e tempo, sem rotular comportamentos automaticamente."""

import argparse
import bisect
import csv
import hashlib
import json
from pathlib import Path
import random
import subprocess


VERSION = "validation-pilot-temporal-strata-1"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def probe(path, ffprobe):
    metadata = json.loads(subprocess.check_output([
        ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,avg_frame_rate", "-of", "json", str(path)], text=True))
    stream = metadata["streams"][0]
    output = json.loads(subprocess.check_output([
        ffprobe, "-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(path)], text=True))
    times = [float(frame["best_effort_timestamp_time"]) for frame in output["frames"]]
    if not times or any(next_time <= time for time, next_time in zip(times, times[1:])):
        raise ValueError(f"PTS ausentes ou não crescentes: {path.name}")
    return stream, times


def choose_indices(total, count, rng):
    if total < count:
        raise ValueError("Vídeo tem menos frames que sua cota de amostragem")
    selected = []
    for index in range(count):
        start = index * total // count
        end = (index + 1) * total // count
        selected.append(rng.randrange(start, end))
    return selected


def choose_clips(times, count, rng, duration_sec=4.0):
    if times[-1] - times[0] < count * duration_sec:
        raise ValueError("Vídeo curto para clipes distintos de 4 s")
    span = (times[-1] - times[0]) / count
    clips = []
    for index in range(count):
        low = times[0] + index * span
        high = times[0] + (index + 1) * span - duration_sec
        start_time = rng.uniform(low, high)
        first = bisect.bisect_left(times, start_time)
        last = bisect.bisect_right(times, start_time + duration_sec) - 1
        if first >= last:
            raise ValueError("Clipes sem frames suficientes")
        clips.append({"clipIndex": index, "startFrame": first, "endFrame": last,
                      "startSec": times[first], "endSec": times[last],
                      "reviewCategory": "unclassified",
                      "frames": [{"frameIndex": frame, "timestampSec": times[frame]}
                                 for frame in range(first, last + 1)]})
    return clips


def distribute(total, size):
    return [total // size + (index < total % size) for index in range(size)]


def select(recordings, holdout_id, frame_count=300, clip_count=20, seed=20261118, ffprobe="ffprobe"):
    if len(recordings) < 2 or holdout_id not in {item[0] for item in recordings}:
        raise ValueError("Informe ao menos dois vídeos e um vídeo independente para holdout")
    if len({item[0] for item in recordings}) != len(recordings):
        raise ValueError("IDs de gravação duplicados")
    if frame_count < len(recordings) or clip_count < len(recordings):
        raise ValueError("Cotas insuficientes para todas as gravações")
    result = []
    frame_quotas = distribute(frame_count, len(recordings))
    clip_quotas = distribute(clip_count, len(recordings))
    hashes = set()
    prepared = []
    for video_id, protocol, path in recordings:
        path = Path(path)
        if not path.is_file():
            raise ValueError(f"Vídeo indisponível: {video_id}")
        digest = sha256(path)
        if digest in hashes:
            raise ValueError("A mesma gravação não pode entrar duas vezes")
        hashes.add(digest)
        stream, times = probe(path, ffprobe)
        prepared.append((video_id, protocol, path, digest, stream, times))
    capacities = [int((times[-1] - times[0]) // 4) for *_, times in prepared]
    clip_quotas = [min(quota, capacity) for quota, capacity in zip(clip_quotas, capacities)]
    deficit = clip_count - sum(clip_quotas)
    while deficit:
        eligible = next((index for index, capacity in enumerate(capacities)
                         if clip_quotas[index] < capacity), None)
        if eligible is None:
            raise ValueError("Duração total insuficiente para os clipes solicitados")
        clip_quotas[eligible] += 1
        deficit -= 1
    for (video_id, protocol, path, digest, stream, times), n_frames, n_clips in zip(prepared, frame_quotas, clip_quotas):
        rng = random.Random(f"{seed}:{digest}:{VERSION}")
        frame_indices = choose_indices(len(times), n_frames, rng)
        frames = [{"frameIndex": index, "timestampSec": times[index],
                   "reviewCategory": "unclassified"} for index in frame_indices]
        clips = choose_clips(times, n_clips, rng)
        result.append({"videoId": video_id, "protocol": protocol,
                       "partition": "holdout" if video_id == holdout_id else "development",
                       "filename": path.name, "videoSha256": digest,
                       "width": stream["width"], "height": stream["height"],
                       "frameCount": len(times), "timingSource": "ffprobe_best_effort_pts",
                       "frames": frames, "clips": clips})
    return {"schemaVersion": 1, "selectionVersion": VERSION, "seed": seed,
            "frameTarget": frame_count, "clipTarget": clip_count,
            "stratification": "balanced_by_recording_and_time; behavior categories require human review",
            "holdoutPolicy": "entire_recording; do not tune filters on holdout labels",
            "recordings": result}


def write_csv(path, report):
    with path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        writer.writerow(("selection_version", "seed", "video_id", "protocol", "partition", "video_sha256", "item_type",
                         "frame_index", "timestamp_sec", "end_frame", "end_sec", "review_category"))
        for recording in report["recordings"]:
            common = [report["selectionVersion"], report["seed"],
                      *[recording[key] for key in ("videoId", "protocol", "partition", "videoSha256")]]
            for frame in recording["frames"]:
                writer.writerow([*common, "frame", frame["frameIndex"], frame["timestampSec"], "", "", frame["reviewCategory"]])
            for clip in recording["clips"]:
                writer.writerow([*common, "clip", clip["startFrame"], clip["startSec"],
                                 clip["endFrame"], clip["endSec"], clip["reviewCategory"]])


def write_markdown(path, report):
    lines = ["# Piloto de referência humana", "",
             f"Seleção: `{report['selectionVersion']}`; semente: `{report['seed']}`.",
             f"Meta: {report['frameTarget']} frames e {report['clipTarget']} clipes.",
             "Amostragem distribuída por gravação e tempo; categorias de comportamento aguardam revisão humana.",
             "O holdout reserva uma gravação inteira e seus rótulos não devem orientar ajustes dos filtros.", "",
             "| Gravação | Protocolo | Partição | SHA-256 do vídeo | Frames | Clipes |",
             "| --- | --- | --- | --- | ---: | ---: |"]
    for recording in report["recordings"]:
        lines.append(f"| {recording['videoId']} | {recording['protocol']} | {recording['partition']} | "
                     f"`{recording['videoSha256']}` | {len(recording['frames'])} | {len(recording['clips'])} |")
    lines.extend(["", "Os PTS de cada frame vêm de `ffprobe -show_frames`. Os clipes têm listas completas de frames no JSON.",
                  "O piloto não contém coordenadas humanas, rótulos de eventos ou estimativa de suficiência estatística.", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recording", action="append", required=True,
                        help="VIDEO_ID:PROTOCOL:PATH; pode repetir")
    parser.add_argument("--holdout-id", required=True)
    parser.add_argument("--frames", type=int, default=300)
    parser.add_argument("--clips", type=int, default=20)
    parser.add_argument("--seed", type=int, default=20261118)
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    recordings = []
    for value in args.recording:
        parts = value.split(":", 2)
        if len(parts) != 3 or not parts[0] or not parts[1] or not parts[2]:
            parser.error("Use VIDEO_ID:PROTOCOL:PATH em --recording")
        recordings.append(tuple(parts))
    try:
        report = select(recordings, args.holdout_id, args.frames, args.clips, args.seed, args.ffprobe)
    except (OSError, ValueError, subprocess.CalledProcessError, KeyError) as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(args.output.with_suffix(".csv"), report)
    write_markdown(args.output.with_suffix(".md"), report)
    print(json.dumps({"recordings": len(recordings), "frames": sum(len(r["frames"]) for r in report["recordings"]),
                      "clips": sum(len(r["clips"]) for r in report["recordings"]),
                      "output": str(args.output)}))


if __name__ == "__main__":
    main()
