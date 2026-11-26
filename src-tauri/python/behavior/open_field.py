"""Second sequential pass over the original video; results publish as one directory."""
import csv
import hashlib
import json
import math
import os
import random
from pathlib import Path
import shutil
import subprocess
import sys
import time

import cv2 as cv
import numpy as np
try:
    from opencv_engine import read_frames, timestamps, write_json
except ImportError:
    from engine import read_frames, timestamps, write_json
from .contracts import SCHEMA, FEATURES
from .crop_extractor import CropExtractor
from .motion_features import MotionFeatures
from .observation_quality import behavior_observation_quality, crop_observation_quality
from .silhouette_features import describe
from .event_decoder import decode
from .metrics import calculate


def sha256(path, cancelled=lambda: False):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024*1024), b""):
            if cancelled():
                raise InterruptedError("Hash verification cancelled")
            digest.update(block)
    return digest.hexdigest()


def read_samples(path):
    previous = -1.
    with Path(path).open(encoding="utf-8") as source:
        for expected, line in enumerate(source):
            row = json.loads(line)
            if row.get("frameIndex") != expected or not math.isfinite(row["timestampSec"]) or row["timestampSec"] <= previous:
                raise ValueError("Tracking frames must be complete and PTS strictly increasing")
            previous = row["timestampSec"]
            yield row


def session_reference(samples):
    # Predeclared label-free calibration: fixed-seed reservoir of accepted silhouettes.
    # Memory is bounded independently of video length; crop scale still uses all boxes.
    lengths, reservoir, count = [], [], 0
    rng = random.Random(42)
    for row in read_samples(samples):
        if behavior_observation_quality(row) != "OBSERVED":
            continue
        lengths.append(max(row["bbox"]["width"], row["bbox"]["height"]))
        if row.get("contour"):
            count += 1
            if len(reservoir) < 64:
                reservoir.append(row)
            else:
                index = rng.randrange(count)
                if index < 64:
                    reservoir[index] = row
    if not lengths:
        raise ValueError("Sem observações confiáveis para calibrar a escala do recorte")
    geometry = [describe(row)["values"] for row in reservoir]
    dimensions = {}
    for key in ("silhouette_area", "body_axis_length", "body_width_mean"):
        values = [value[key] for value in geometry if value.get(key) is not None and value[key] > 0]
        dimensions[key] = float(np.median(values)) if values else None
    return dict(cropLengthPx=float(np.median(lengths)), dimensions=dimensions,
                descriptorPolicy="median_64_reservoir_seed42_accepted_silhouettes_session_v1",
                descriptorReferenceCount=len(reservoir))


def reference_length(samples):
    return session_reference(samples)["cropLengthPx"]


def video_duration(video, ffprobe, last_pts, last_delta):
    result = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "json", str(video)],
                            capture_output=True, text=True, check=True)
    streams = json.loads(result.stdout).get("streams", [])
    try:
        duration = float(streams[0].get("duration", "nan"))
    except (ValueError, IndexError, TypeError):
        duration = float("nan")
    if math.isfinite(duration) and last_pts < duration <= 172800:
        return duration, "ffprobe_video_stream_duration"
    return last_pts+min(last_delta, .1), "estimated_last_positive_pts_delta_bounded_100ms"


def extract(request, output, cancelled=lambda: False, progress=lambda phase, count: None, encoder=None, save_crops=False):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    config = request["config"]
    cv.setNumThreads(max(1, min(8, int(request.get("cpuThreads", 2)))))
    if config.get("protocol") != "open_field":
        raise ValueError("Behavior V1 only supports Open Field")
    rate = request.get("sampleRateHz", 15)
    if rate not in {10, 15, 30}:
        raise ValueError("Unsupported behavior rate")
    if sha256(request["video"], cancelled) != request["videoSha256"]:
        raise ValueError("Original-video SHA-256 mismatch")
    samples_hash = sha256(request["samples"], cancelled)
    calibration = session_reference(request["samples"])
    reference = calibration["cropLengthPx"]
    cropper, motion = CropExtractor(reference), MotionFeatures(request.get("flowMethod", "farneback"), calibration["dimensions"])
    clock = timestamps(request["video"], request["ffprobe"])
    frames = read_frames(request["video"], request["ffmpeg"], config["width"], config["height"], config.get("autorotate", False))
    samples = read_samples(request["samples"])
    rows, embeddings, batch, batch_indices = [], [], [], []
    next_tick, last_time, last_dt = 0, None, None
    timings = dict(decode_time_sec=0., crop_extraction_time_sec=0., feature_extraction_time_sec=0., encoder_time_sec=0.)
    if save_crops:
        (output/"crops").mkdir(exist_ok=True)

    def flush():
        if not batch:
            return
        start = time.perf_counter()
        values = encoder.encode(batch) if encoder else np.zeros((len(batch), 0), np.float32)
        timings["encoder_time_sec"] += time.perf_counter()-start
        for index, value in zip(batch_indices, values):
            embeddings[index] = value
        batch.clear()
        batch_indices.clear()

    try:
        with (output/"behavior_features.jsonl").open("w", encoding="utf-8") as stream:
            for index, row in enumerate(samples):
                if cancelled():
                    raise InterruptedError("Behavior extraction cancelled")
                start = time.perf_counter()
                frame, pts = next(frames, None), next(clock, None)
                timings["decode_time_sec"] += time.perf_counter()-start
                if frame is None or pts is None or abs(pts-row["timestampSec"]) > .002:
                    raise ValueError("Original-video PTS and tracking diverged")
                if last_time is not None:
                    last_dt = pts-last_time
                last_time = pts
                if pts+1e-8 < next_tick/rate:
                    continue
                # A large VFR gap creates masked grid positions, never duplicated images.
                while pts-next_tick/rate > 1/rate+1e-8:
                    gap = dict(frameIndex=None, timestampSec=next_tick/rate, gridTimeSec=next_tick/rate,
                               observation="UNOBSERVED", values={}, cropUsable=False)
                    rows.append(gap)
                    embeddings.append(None)
                    stream.write(json.dumps(gap)+"\n")
                    next_tick += 1
                start = time.perf_counter()
                observation = behavior_observation_quality(row)
                crop, crop_info = cropper.extract(frame, row, observation)
                timings["crop_extraction_time_sec"] += time.perf_counter()-start
                start = time.perf_counter()
                geometry = describe(row, config.get("arena"))["values"]
                observation = crop_observation_quality(observation, crop is not None, crop_info["cropUsable"])
                entry = dict(frameIndex=index, timestampSec=pts, gridTimeSec=next_tick/rate,
                             observation=observation, trackingBbox=row.get("bbox"), values=geometry, **crop_info)
                entry["values"].update(motion.extract(crop, {**row, **entry}, observation, cropper.side))
                entry["feature_validity_mask"] = {key: key in entry["values"] for key in FEATURES}
                timings["feature_extraction_time_sec"] += time.perf_counter()-start
                rows.append(entry)
                embeddings.append(None)
                if crop is not None:
                    if encoder:
                        batch.append(crop)
                        batch_indices.append(len(rows)-1)
                        if len(batch) >= 16:
                            flush()
                    if save_crops:
                        filename = f"crops/{index:08d}.png"
                        if not cv.imwrite(str(output/filename), cv.cvtColor(crop, cv.COLOR_RGB2BGR)):
                            raise ValueError("Crop could not be saved")
                        entry["cropPath"] = filename
                stream.write(json.dumps(entry, allow_nan=False)+"\n")
                next_tick += 1
                if len(rows) % 30 == 0:
                    progress("extracting", index+1)
            if next(frames, None) is not None or next(clock, None) is not None:
                raise ValueError("Tracking ended before the original video")
            flush()
    finally:
        frames.close()
        clock.close()
    if last_time is None or last_dt is None or not rows:
        raise ValueError("Video has insufficient temporal evidence")
    duration, duration_source = video_duration(request["video"], request["ffprobe"], last_time, last_dt)
    for i, row in enumerate(rows):
        row["endSec"] = min(duration, rows[i+1]["timestampSec"] if i+1 < len(rows) else duration, row["timestampSec"]+1.5/rate)
    with (output/"behavior_features.jsonl").open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, allow_nan=False)+"\n")
    dimension = 128 if encoder and encoder.encoder is not None else 0
    embedding_array = np.asarray([v if v is not None else np.zeros(dimension, np.float32) for v in embeddings], np.float32)
    if encoder:
        np.save(output/"embeddings.npy", embedding_array)
    return rows, embedding_array, dict(referenceLengthPx=reference, referencePolicy="median_accepted_long_bbox_side_session_v1",
        descriptorReference=calibration, samplesSha256=samples_hash, durationSec=duration, durationSource=duration_source,
        lastFrameSupport="prediction_support_bounded_by_sampling_interval_remainder_unknown", timings=timings)


def run(request_path):
    request_path = Path(request_path)
    request = json.loads(request_path.read_text(encoding="utf-8"))
    root, parent, started = request_path.parent, os.getppid(), time.perf_counter()
    pending = root/"pending"
    report = dict(state="preparing", framesProcessed=0, schemaVersion=1)
    cancelled = lambda: (root/"cancel").exists() or os.getppid() != parent
    def progress(phase, count):
        report.update(state=phase, framesProcessed=count, elapsedSec=time.perf_counter()-started)
        write_json(root/"status.json", report)
    try:
        progress("preparing", 0)
        if cancelled():
            raise InterruptedError("Behavior preparation cancelled")
        expected_model_hash = request.get("modelManifestSha256")
        if expected_model_hash and sha256(Path(request["modelDirectory"])/"manifest.json", cancelled) != expected_model_hash:
            raise ValueError("Model manifest changed after the behavior job was created")
        from .onnx_inference import Inference
        inference = Inference(request["modelDirectory"], request.get("cpuThreads", 2))
        if request.get("sampleRateHz", 15) != inference.manifest["sampleRateHz"]:
            raise ValueError("Inference frequency must match the trained model")
        pending.mkdir()
        rows, embeddings, metadata = extract(request, pending, cancelled, progress, inference)
        progress("classifying", report["framesProcessed"])
        start = time.perf_counter()
        scores = inference.classify(rows, embeddings, [r["observation"] == "OBSERVED" for r in rows], cancelled)
        metadata["timings"]["tcn_inference_time_sec"] = time.perf_counter()-start
        predictions = []
        for row, score in zip(rows, scores):
            observed = row["observation"] == "OBSERVED"
            p, sub = map(float, score)
            subtype = sub if inference.manifest.get("subtypeTrained") else None
            label = "NON_REARING" if p < inference.decoder["offsetThreshold"] else "REARING_UNSPECIFIED" if p >= inference.decoder["onsetThreshold"] else "UNKNOWN"
            if label == "REARING_UNSPECIFIED" and subtype is not None:
                label = "REARING_SUPPORTED" if sub >= inference.decoder["subtypeThreshold"] else "REARING_UNSUPPORTED" if sub <= 1-inference.decoder["subtypeThreshold"] else label
            predictions.append(dict(frameIndex=row["frameIndex"], timestampSec=row["timestampSec"], endSec=row["endSec"],
                gridTimeSec=row["gridTimeSec"], observation=row["observation"], pRearing=p if observed else None,
                pSupportedGivenRearing=subtype if observed else None, pUnsupportedGivenRearing=1-subtype if observed and subtype is not None else None,
                classification=label if observed else "UNKNOWN", scoreKind="probability" if inference.manifest.get("probabilityCalibrated") else "model_score"))
        progress("decoding", report["framesProcessed"])
        start = time.perf_counter()
        events = decode(predictions, inference.decoder)
        # Final frame labels follow decoded episodes, including hysteresis, rather than
        # independently thresholding a score and calling every short spike an episode.
        cursor = 0
        for prediction in predictions:
            while cursor < len(events) and events[cursor]["endSec"] <= prediction["timestampSec"]:
                cursor += 1
            event = events[cursor] if cursor < len(events) else None
            inside = event and any(a <= prediction["timestampSec"] < b for a, b in event["observedIntervals"])
            prediction["classification"] = event["behavior"] if inside else "NON_REARING" if prediction["observation"] == "OBSERVED" and prediction["pRearing"] < inference.decoder["offsetThreshold"] else "UNKNOWN"
        metrics = calculate(predictions, events, metadata["durationSec"])
        metrics.update(modelId=inference.manifest["modelId"], modelVersion=inference.manifest["modelVersion"])
        metadata["timings"]["event_decoder_time_sec"] = time.perf_counter()-start
        with (pending/"frame_predictions.jsonl").open("w", encoding="utf-8") as stream:
            for p in predictions:
                stream.write(json.dumps(p, allow_nan=False)+"\n")
        with (pending/"behavior_events.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=["eventId", "startSec", "endSec", "durationSec", "behavior", "score", "reviewStatus"])
            writer.writeheader()
            writer.writerows({k: e[k] for k in writer.fieldnames} for e in events)
        write_json(pending/"behavior_events.json", events)
        write_json(pending/"behavior_metrics.json", metrics)
        quality = dict(coveragePct=metrics["coveragePct"], unknownDurationSec=metrics["unknownDurationSec"],
                       observationCounts={state: sum(r["observation"] == state for r in rows) for state in ("OBSERVED", "UNCERTAIN", "UNOBSERVED")})
        write_json(pending/"quality_report.json", quality)
        metadata["timings"]["total_analysis_time_sec"] = time.perf_counter()-started
        write_json(pending/"run_manifest.json", dict(schemaVersion=1, featureSchema=SCHEMA, model=inference.manifest,
            modelManifestSha256=sha256(Path(request["modelDirectory"])/"manifest.json"), videoSha256=request["videoSha256"],
            trackingJobId=request["trackingJobId"], experimentId=request["experimentId"], sampleRateHz=request.get("sampleRateHz", 15),
            cpuThreads=request.get("cpuThreads", 2), scientificallyValidated=False, **metadata))
        if cancelled():
            raise InterruptedError("Behavior analysis cancelled")
        os.replace(pending, root/"result")
        report.update(state="succeeded", resultPath=str(root/"result"), elapsedSec=time.perf_counter()-started)
    except InterruptedError:
        report.update(state="cancelled")
    except Exception as error:
        report.update(state="failed", error=str(error))
    finally:
        shutil.rmtree(pending, ignore_errors=True)
        write_json(root/"status.json", report)
    return report


if __name__ == "__main__":
    result = run(sys.argv[1])
    sys.exit(1 if result["state"] == "failed" else 0)
