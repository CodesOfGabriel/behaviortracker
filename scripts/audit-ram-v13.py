#!/usr/bin/env python3
"""Read-only integrity audit for a RAM V11/V13 package and optional R2/R3 ZIPs."""

import argparse
import csv
import hashlib
import io
import json
import subprocess
import sys
import zipfile
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,nb_frames,duration,codec_name", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)["streams"][0]


def zip_rows(archive: zipfile.ZipFile, name: str) -> list[dict]:
    with archive.open(name) as source:
        return list(csv.DictReader(io.TextIOWrapper(source, encoding="utf-8-sig")))


def mask_pixels(path: Path, width: int, height: int) -> bytes:
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True,
    )
    if len(result.stdout) != width * height:
        raise ValueError("A máscara não tem a mesma resolução do vídeo original.")
    return result.stdout


def mask_integral(mask: bytes, width: int, height: int) -> list[int]:
    stride = width + 1
    integral = [0] * (stride * (height + 1))
    for y in range(height):
        row = 0
        for x in range(width):
            row += mask[y * width + x] > 127
            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row
    return integral


def rectangle_white(integral: list[int], width: int, x1: int, y1: int, x2: int, y2: int) -> int:
    stride = width + 1
    return integral[y2 * stride + x2] - integral[y1 * stride + x2] - integral[y2 * stride + x1] + integral[y1 * stride + x1]


def audit(source: Path, r2_path: Path | None, r3_path: Path | None) -> dict:
    video = source / "01_Video_Original" / "Caf 3 - dia 2.MOV"
    tracking = source / "03_Tracking_Geometria" / "tracking_v11.csv"
    mask_path = source / "03_Tracking_Geometria" / "mascara.png"
    config = json.loads((source / "03_Tracking_Geometria" / "config_v11.json").read_text())
    geometry = json.loads((source / "03_Tracking_Geometria" / "geometria.json").read_text())
    video_probe = probe(video)
    video_hash = sha256(video)
    width, height = int(video_probe["width"]), int(video_probe["height"])
    with tracking.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    frames = [int(row["frame"]) for row in rows]
    times = [float(row["time_nominal_s"]) for row in rows]
    tracking_valid = frames == list(range(len(rows))) and all(b > a for a, b in zip(times, times[1:]))
    model_manifest = json.loads((Path(__file__).resolve().parents[1] / "models" / "wistar_df_v2.manifest.json").read_text())
    model_checks = {}
    for filename, expected in model_manifest["files"].items():
        path = source / "04_Modelos_Treinados" / filename
        digest = sha256(path)
        model_checks[filename] = {
            "sha256": digest,
            "matchesManifest": digest == expected["sha256"] and path.stat().st_size == expected["sizeBytes"],
        }
    result = {
        "status": "AUDIT_ONLY_NO_CORRECTIONS_APPROVED",
        "video": {"sha256": video_hash, "matchesV11Config": video_hash == config["video_sha256"],
                  "width": width, "height": height, "codec": video_probe["codec_name"],
                  "frames": int(video_probe["nb_frames"]), "durationSec": float(video_probe["duration"])},
        "trackingV11": {"rows": len(rows), "continuousFramesAndNominalTimes": tracking_valid,
                         "matchesVideoFrameCount": len(rows) == int(video_probe["nb_frames"]),
                         "missingBoxCoordinates": sum(not row["x1"] or not row["y1"] for row in rows)},
        "geometryV11": {"width": geometry["width"], "height": geometry["height"],
                         "matchesVideoDimensions": (geometry["width"], geometry["height"]) == (width, height),
                         "ramArmsIndividuallyDefined": False},
        "models": model_checks,
    }
    if r2_path:
        with zipfile.ZipFile(r2_path) as archive:
            summary = json.loads(archive.read("v13_r2_summary.json"))
            flags = zip_rows(archive, "v13_r2_frame_flags.csv")
            centers = zip_rows(archive, "v13_r2_center_candidates_10166_10214.csv")
        result["r2"] = {"videoHashMatches": summary["video_sha256"] == video_hash,
                        "frameFlags": len(flags), "centerCandidates": len(centers),
                        "humanApprovedCenters": sum(row["human_approved"].lower() == "true" for row in centers),
                        "summary": summary}
    if r3_path:
        with zipfile.ZipFile(r3_path) as archive:
            manifest = json.loads(archive.read("r05_run_manifest.json"))
            candidates = zip_rows(archive, "r05_detector_candidates.csv")
        mask = mask_pixels(mask_path, width, height)
        integral = mask_integral(mask, width, height)
        overlap = []
        center_inside = []
        top1_center_inside = []
        for item in candidates:
            a, b, c, d = (float(item[key]) for key in ("x1", "y1", "x2", "y2"))
            x1, y1 = min(width, max(0, int(a))), min(height, max(0, int(b)))
            x2, y2 = min(width, max(0, int(c))), min(height, max(0, int(d)))
            area = max(1, (x2 - x1) * (y2 - y1))
            overlap.append(rectangle_white(integral, width, x1, y1, x2, y2) / area)
            cx, cy = int((a + c) / 2), int((b + d) / 2)
            inside = 0 <= cx < width and 0 <= cy < height and mask[cy * width + cx] > 127
            center_inside.append(inside)
            if item["rank"] == "0":
                top1_center_inside.append(inside)
        result["r3"] = {"videoHashMatches": manifest["video_sha256"] == video_hash,
                        "detectorHashMatches": manifest["detector_sha256"] == model_checks["best_detector.pth"]["sha256"],
                        "status": manifest["candidate_status"], "candidateCount": len(candidates),
                        "frameCount": len(set(int(item["frame"]) for item in candidates)),
                        "boxOverlapAtLeast35Pct": sum(value >= .35 for value in overlap),
                        "maxBoxOverlap": max(overlap), "candidateCentersInMask": sum(center_inside),
                        "top1CentersInMask": sum(top1_center_inside), "top1Count": len(top1_center_inside)}
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="BehaviorTracker_V13_Integracao_Agente_2026-11-17 directory")
    parser.add_argument("--r2", type=Path, help="V13_R2_QC_resultados.zip")
    parser.add_argument("--r3", type=Path, help="V13_R3_R05_detector_proposals.zip")
    args = parser.parse_args()
    print(json.dumps(audit(args.source, args.r2, args.r3), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, zipfile.BadZipFile) as exc:
        print(f"Auditoria RAM falhou: {exc}", file=sys.stderr)
        raise SystemExit(1)
