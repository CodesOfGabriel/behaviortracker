#!/usr/bin/env python3
"""Compare observações de pose, F+C e 1€ sem modificar resultados do app."""

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from statistics import median
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src-tauri" / "python"))

from hybrid.one_euro_filter import VERSION, filter_keypoint as one_euro_filter
from hybrid.temporal_filter import POLICY as FC_POLICY, filter_keypoint as fc_filter


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_pose(path):
    series = {}
    times = {}
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        required = {"frame_index", "timestamp_sec", "animal_id", "keypoint", "x_px", "y_px", "likelihood", "status", "source"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("Use o CSV canônico de pose com frame, tempo, origem e status")
        for row in reader:
            frame = int(row["frame_index"])
            timestamp = number(row["timestamp_sec"])
            if frame < 0 or timestamp is None:
                raise ValueError("Frame ou timestamp inválido")
            if frame in times and abs(times[frame] - timestamp) > 0.000001:
                raise ValueError("Timestamps divergentes no mesmo frame")
            times[frame] = timestamp
            key = (row["animal_id"], row["keypoint"])
            group = series.setdefault(key, {})
            if frame in group:
                raise ValueError("Pose duplicada para animal, keypoint e frame")
            group[frame] = row
    if not times or sorted(times) != list(range(len(times))):
        raise ValueError("Frames ausentes no relógio da pose")
    ordered = [times[frame] for frame in range(len(times))]
    if any(b <= a for a, b in zip(ordered, ordered[1:])):
        raise ValueError("Timestamps não são crescentes")
    return series, ordered


def read_reference(path, video_sha256, annotator=None):
    approved = {}
    if not video_sha256 or len(video_sha256) != 64 or any(c not in "0123456789abcdef" for c in video_sha256.lower()):
        raise ValueError("Informe o SHA-256 do vídeo original ao comparar referência humana")
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        required = {"frame_index", "animal_id", "keypoint", "x_px", "y_px", "approved",
                    "visibility", "annotator_id", "reviewer_id", "video_sha256", "status",
                    "annotation_source", "timestamp_sec"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("Use o CSV exportado pela referência humana, com aprovação e proveniência")
        for row in reader:
            if row["video_sha256"].lower() != video_sha256.lower():
                raise ValueError("Referência pertence a outro vídeo")
            if row["annotation_source"] != "human" or not row["annotator_id"].strip():
                raise ValueError("Referência sem origem humana identificada")
            if annotator and row["annotator_id"] != annotator:
                continue
            if row["approved"].strip().lower() != "true" or row["status"] != "approved":
                continue
            if not row["reviewer_id"].strip() or row["reviewer_id"].strip() == row["annotator_id"].strip():
                raise ValueError("Anotação aprovada sem revisor independente identificado")
            if row["visibility"] != "visible":
                continue
            x, y = number(row["x_px"]), number(row["y_px"])
            if x is None or y is None:
                raise ValueError("Coordenada humana aprovada inválida")
            frame = int(row["frame_index"])
            timestamp = number(row["timestamp_sec"])
            if frame < 0 or timestamp is None or timestamp < 0:
                raise ValueError("Frame ou timestamp da referência inválido")
            key = (row["animal_id"], row["keypoint"], frame)
            if key in approved:
                raise ValueError("Duas anotações aprovadas no mesmo frame: selecione --annotator")
            approved[key] = (x, y, timestamp)
    return approved


def distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def summary(values, raw, reference, key, common_frames, large_step_threshold_px):
    valid = [index for index, point in enumerate(values) if point is not None]
    consecutive = [distance(values[index], values[index - 1]) for index in valid
                   if index > 0 and values[index - 1] is not None]
    internal_gaps = [right - left - 1 for left, right in zip(valid, valid[1:]) if right - left > 1]
    second_difference = [math.hypot(values[index - 1][0] - 2*values[index][0] + values[index + 1][0],
                                    values[index - 1][1] - 2*values[index][1] + values[index + 1][1])
                         for index in range(1, len(values) - 1)
                         if all(values[other] is not None for other in (index - 1, index, index + 1))]
    displacement = [distance(values[index], raw[index]) for index in valid if raw[index] is not None]
    compared = [(index, reference[(key[0], key[1], index)]) for index in valid
                if (key[0], key[1], index) in reference]
    errors = [distance(values[index], reference[(key[0], key[1], index)]) for index in common_frames]
    return {"validFrames": len(valid), "consecutivePairCount": len(consecutive),
            "coveragePct": 100 * len(valid) / len(values) if values else 0,
            "internalGapRuns": len(internal_gaps),
            "longestInternalGapFrames": max(internal_gaps, default=0),
            "largeStepPairs": sum(step > large_step_threshold_px for step in consecutive),
            "changedFromRawFrames": sum(change > .01 for change in displacement),
            "consecutiveDistancePx": sum(consecutive),
            "medianSecondDifferencePx": median(second_difference) if second_difference else None,
            "medianDisplacementFromRawPx": median(displacement) if displacement else None,
            "approvedReferenceFrames": len(compared),
            "maeOnCommonApprovedFramesPx": sum(errors) / len(errors) if errors else None,
            "rmseOnCommonApprovedFramesPx": math.sqrt(sum(error * error for error in errors) / len(errors)) if errors else None,
            "pckAt5PxOnCommonApprovedFramesPct": 100 * sum(error <= 5 for error in errors) / len(errors) if errors else None,
            "pckAt10PxOnCommonApprovedFramesPct": 100 * sum(error <= 10 for error in errors) / len(errors) if errors else None}


def compare(pose, reference=None, min_cutoff=1.0, beta=0.001, max_gap_sec=0.25,
            large_step_threshold_px=15.0, video_sha256=None, annotator=None):
    if not math.isfinite(large_step_threshold_px) or large_step_threshold_px <= 0:
        raise ValueError("Limiar de passo grande deve ser positivo e finito")
    series, timestamps = read_pose(pose)
    truth = read_reference(reference, video_sha256, annotator) if reference else {}
    for (animal_id, keypoint, frame), (_, _, timestamp) in truth.items():
        if (animal_id, keypoint) not in series:
            raise ValueError("Referência aprovada sem série de pose correspondente")
        if frame >= len(timestamps) or abs(timestamps[frame] - timestamp) > 0.001:
            raise ValueError("Referência e pose não compartilham o mesmo relógio de frames; confira o vídeo e o PTS")
    groups = []
    paired_errors = []
    for key, rows in sorted(series.items()):
        samples = []
        for frame in range(len(timestamps)):
            row = rows.get(frame)
            if row and row["status"] == "valid" and row["source"] == "detected":
                x, y, confidence = (number(row[name]) for name in ("x_px", "y_px", "likelihood"))
                samples.append((x, y, confidence))
            else:
                samples.append((None, None, None))
        raw = [sample if sample[0] is not None and sample[1] is not None
               and sample[2] is not None and sample[2] >= .6 else None for sample in samples]
        median_layer = fc_filter(samples)
        euro_layer = one_euro_filter(samples, timestamps, min_cutoff=min_cutoff, beta=beta,
                                     max_gap_sec=max_gap_sec)
        common_frames = [frame for frame in range(len(timestamps))
                         if raw[frame] is not None and median_layer[frame] is not None and euro_layer[frame] is not None
                         and (key[0], key[1], frame) in truth]
        for frame in common_frames:
            target = truth[(key[0], key[1], frame)]
            paired_errors.append({"animalId": key[0], "keypoint": key[1], "frameIndex": frame,
                                  "timestampSec": timestamps[frame], "humanXPx": target[0], "humanYPx": target[1],
                                  "rawErrorPx": distance(raw[frame], target),
                                  "fcMedianErrorPx": distance(median_layer[frame], target),
                                  "oneEuroErrorPx": distance(euro_layer[frame], target)})
        groups.append({"animalId": key[0], "keypoint": key[1],
                       "approvedReferenceTotal": sum((key[0], key[1], frame) in truth for frame in range(len(timestamps))),
                       "commonApprovedReferenceFrames": len(common_frames),
                       "pairedApprovedCoveragePct": 100 * len(common_frames) /
                           max(1, sum((key[0], key[1], frame) in truth for frame in range(len(timestamps)))),
                       "raw": summary(raw, raw, truth, key, common_frames, large_step_threshold_px),
                       "fcMedian": summary(median_layer, raw, truth, key, common_frames, large_step_threshold_px),
                       "oneEuro": summary(euro_layer, raw, truth, key, common_frames, large_step_threshold_px)})
    return {"status": "HUMAN_REFERENCE_PAIRED_EXPERIMENTAL" if truth else "COMPARISON_ONLY_NOT_VALIDATED",
            "poseSha256": sha256(pose),
            "referenceSha256": sha256(reference) if reference else None,
            "videoSha256": video_sha256,
            "referenceAnnotator": annotator,
            "approvedReferenceCount": len(truth),
            "temporalEventErrorMs": None,
            "frameCount": len(timestamps), "timeSource": "canonical_pose_csv_timestamp_sec",
            "filterVersions": {"fcMedian": FC_POLICY["version"], "oneEuro": VERSION},
            "parameters": {"likelihoodThreshold": .6, "minCutoffHz": min_cutoff, "beta": beta,
                           "maxGapSec": max_gap_sec, "largeStepThresholdPx": large_step_threshold_px,
                           "changedFromRawThresholdPx": .01},
            "interpretation": "MAE is mean Euclidean point error; RMSE is root mean squared Euclidean point error; PCK thresholds Euclidean point distance. These metrics use only shared frames with visible, explicitly approved human annotations tied to the asserted video SHA-256 and matching frame timestamps. The pose CSV does not carry a video SHA-256, so its video provenance must be verified separately. PCK thresholds of 5 and 10 px are absolute and not anatomy-normalized. Second difference, large steps and displacement are descriptive proxies, not anatomical error. Changed coordinates are not verified corrections. Large steps can be real movement. Internal gaps exclude missing frames before the first and after the last valid frame. Distances are not directly comparable when frame coverage differs. Real temporal event error requires separately approved event onset labels.",
            "series": groups, "pairedErrors": paired_errors}


def write_sidecars(path, result):
    provenance_columns = ("poseSha256", "referenceSha256", "videoSha256", "fcMedianVersion", "oneEuroVersion",
                          "minCutoffHz", "beta", "maxGapSec", "likelihoodThreshold",
                          "largeStepThresholdPx", "changedFromRawThresholdPx")
    provenance = {"poseSha256": result["poseSha256"], "referenceSha256": result["referenceSha256"],
                  "videoSha256": result["videoSha256"],
                  "fcMedianVersion": result["filterVersions"]["fcMedian"],
                  "oneEuroVersion": result["filterVersions"]["oneEuro"],
                  "minCutoffHz": result["parameters"]["minCutoffHz"], "beta": result["parameters"]["beta"],
                  "maxGapSec": result["parameters"]["maxGapSec"],
                  "likelihoodThreshold": result["parameters"]["likelihoodThreshold"],
                  "largeStepThresholdPx": result["parameters"]["largeStepThresholdPx"],
                  "changedFromRawThresholdPx": result["parameters"]["changedFromRawThresholdPx"]}
    metric_columns = ("animalId", "keypoint", "variant", "approvedReferenceTotal", "commonApprovedReferenceFrames",
               "pairedApprovedCoveragePct", "validFrames", "coveragePct", "consecutivePairCount", "internalGapRuns", "longestInternalGapFrames",
               "largeStepPairs", "changedFromRawFrames", "consecutiveDistancePx",
               "medianSecondDifferencePx", "medianDisplacementFromRawPx", "approvedReferenceFrames",
               "maeOnCommonApprovedFramesPx", "rmseOnCommonApprovedFramesPx",
               "pckAt5PxOnCommonApprovedFramesPct", "pckAt10PxOnCommonApprovedFramesPct")
    columns = (*provenance_columns, *metric_columns)
    with path.with_suffix(".summary.csv").open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=columns)
        writer.writeheader()
        for group in result["series"]:
            for variant in ("raw", "fcMedian", "oneEuro"):
                writer.writerow({**provenance, "animalId": group["animalId"], "keypoint": group["keypoint"],
                                 "variant": variant,
                                 "approvedReferenceTotal": group["approvedReferenceTotal"],
                                 "commonApprovedReferenceFrames": group["commonApprovedReferenceFrames"],
                                 "pairedApprovedCoveragePct": group["pairedApprovedCoveragePct"],
                                 **{key: group[variant].get(key) for key in metric_columns[6:]}})
    paired_columns = (*provenance_columns, "animalId", "keypoint", "frameIndex", "timestampSec", "humanXPx", "humanYPx",
                      "rawErrorPx", "fcMedianErrorPx", "oneEuroErrorPx")
    with path.with_suffix(".paired.csv").open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=paired_columns)
        writer.writeheader()
        writer.writerows({**provenance, **row} for row in result["pairedErrors"])
    lines = ["# Comparação pareada de filtros de pose", "",
             f"Status: `{result['status']}`.", "",
             f"Pose SHA-256: `{result['poseSha256']}`.",
             f"Vídeo SHA-256: `{result['videoSha256'] or 'não informado'}`.",
             f"Referência SHA-256: `{result['referenceSha256'] or 'ausente'}`.",
             f"Anotador selecionado: `{result['referenceAnnotator'] or 'nenhum'}`.", "",
             f"Parâmetros: `{json.dumps(result['parameters'], sort_keys=True)}`.",
             f"Versões: `{json.dumps(result['filterVersions'], sort_keys=True)}`.", "",
             f"Frames aprovados pareados: {len(result['pairedErrors'])}.", "",
             result["interpretation"], ""]
    lines.extend(["| Animal | Ponto | Variante | Cobertura (%) | Lacunas internas | 2ª diferença (px) | MAE humano (px) | RMSE humano (px) | PCK@5 (%) | PCK@10 (%) |",
                  "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"])
    def shown(value):
        return "—" if value is None else f"{value:.2f}"
    for group in result["series"]:
        for variant in ("raw", "fcMedian", "oneEuro"):
            value = group[variant]
            lines.append(f"| {group['animalId']} | {group['keypoint']} | {variant} | "
                         f"{shown(value['coveragePct'])} | {value['internalGapRuns']} | "
                         f"{shown(value['medianSecondDifferencePx'])} | "
                         f"{shown(value['maeOnCommonApprovedFramesPx'])} | "
                         f"{shown(value['rmseOnCommonApprovedFramesPx'])} | "
                         f"{shown(value['pckAt5PxOnCommonApprovedFramesPct'])} | "
                         f"{shown(value['pckAt10PxOnCommonApprovedFramesPct'])} |")
    lines.append("")
    path.with_suffix(".md").write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pose", required=True, type=Path, help="CSV canônico de pose exportado pelo aplicativo")
    parser.add_argument("--reference", type=Path, help="CSV de anotações humanas aprovadas")
    parser.add_argument("--video-sha256", help="SHA-256 do vídeo original ao usar --reference")
    parser.add_argument("--annotator", help="Selecione um anotador quando houver duas referências aprovadas no mesmo frame")
    parser.add_argument("--min-cutoff", type=float, default=1.0)
    parser.add_argument("--beta", type=float, default=0.001)
    parser.add_argument("--max-gap-sec", type=float, default=0.25)
    parser.add_argument("--large-step-threshold-px", type=float, default=15.0)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = compare(args.pose, args.reference, args.min_cutoff, args.beta, args.max_gap_sec,
                     args.large_step_threshold_px, args.video_sha256, args.annotator)
    payload = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
        write_sidecars(args.output, result)
    else:
        print(payload)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(f"Comparação interrompida: {error}")
