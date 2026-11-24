"""Render corresponding frames from two local runs; never create human labels."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"src-tauri/python"))
from opencv_engine import read_frames


def render(before, after, indices, output):
    import cv2 as cv
    import numpy as np
    request = json.loads((after/"request.json").read_text())
    digest = hashlib.sha256()
    with Path(request["video"]).open("rb") as source:
        for chunk in iter(lambda: source.read(4*1024*1024), b""):
            digest.update(chunk)
    rows = []
    versions = []
    for run in (before, after):
        manifest = json.loads((run/"run_manifest.json").read_text())
        if manifest["config"].get("videoSha256") != digest.hexdigest():
            raise ValueError("Video SHA-256 differs from the run manifest")
        if manifest["config"]["arena"] != request["config"]["arena"]:
            raise ValueError("Arena differs between runs")
        versions.append(manifest["algorithmVersion"])
        rows.append([json.loads(line) for line in (run/"samples.jsonl").read_text().splitlines()])
    if len(rows[0]) != len(rows[1]) or any(
            a["frameIndex"] != b["frameIndex"] or a["timestampSec"] != b["timestampSec"]
            for a, b in zip(*rows)):
        raise ValueError("Frame indices or PTS differ between runs")
    indices = sorted(set(indices))
    if not indices or indices[0] < 0 or indices[-1] >= len(rows[0]):
        raise ValueError("Requested frame is outside the run")
    config = request["config"]
    width, height = config["width"], config["height"]
    scale = min(1., 640/width)
    size = (round(width*scale), round(height*scale))
    selected, panels, metadata = set(indices), [], []
    capture = read_frames(request["video"], request["ffmpeg"], width, height,
                          autorotate=config.get("autorotate", False), output_size=size,
                          frame_limit=indices[-1]+1)
    try:
        for index, frame in enumerate(capture):
            if index not in selected:
                continue
            tiles = []
            for label, version, samples in zip(("before", "after"), versions, rows):
                sample = samples[index]
                tile = np.zeros((size[1]+56, size[0], 3), np.uint8)
                tile[:size[1]] = frame
                color = (80, 220, 100) if sample.get("trackingAccepted") else (0, 190, 255)
                box = sample.get("bbox")
                if box:
                    x, y, w, h = (round(box[key]*scale) for key in ("x", "y", "width", "height"))
                    cv.rectangle(tile, (x, y), (x+w, y+h), color, 2)
                cv.putText(tile, f"{label} {version} | frame {index} | {sample['timestampSec']:.3f}s",
                           (6, size[1]+20), cv.FONT_HERSHEY_SIMPLEX, .48, (255, 255, 255), 1)
                cv.putText(tile, sample["reason"], (6, size[1]+43), cv.FONT_HERSHEY_SIMPLEX, .45, color, 1)
                tiles.append(tile)
            panels.append(np.hstack(tiles))
            metadata.append({"frameIndex": index, "timestampSec": rows[0][index]["timestampSec"],
                             "before": rows[0][index], "after": rows[1][index]})
    finally:
        capture.close()
    if len(panels) != len(indices):
        raise ValueError("Decoder ended before the selected frames")
    output.parent.mkdir(parents=True, exist_ok=True)
    if not cv.imwrite(str(output), np.vstack(panels)):
        raise OSError("Could not write diagnostic image")
    output.with_suffix(".json").write_text(json.dumps({"schemaVersion": "local-box-comparison-1",
        "videoSha256": digest.hexdigest(), "accuracyMeasured": False,
        "note": "Algorithm boxes only. Green means tracking accepted, not scientifically approved. No human ground truth.",
        "frames": metadata}, ensure_ascii=False, indent=2, allow_nan=False)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before-run", type=Path, required=True)
    parser.add_argument("--after-run", type=Path, required=True)
    parser.add_argument("--frames", type=int, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    render(args.before_run, args.after_run, args.frames, args.output)
