"""Colab box provider -> shared CPU geometry/orientation -> temporal behavior.

Detection, geometry and behavior have separate checksummed artifacts. No HRNet,
CoTracker or anatomical templates are used in this path. Display recovery is
kept separate from raw geometry and scientific eligibility.
"""
import ast
import csv
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess

import cv2 as cv
import numpy as np
from body_axis import BodyAxisFilter
from oft_layers import KEYPOINTS, POLICY, VERSION, TRACKING_BOX_POLICY, LayeredTracker, atomic_json, digest, finish_layers, silhouette, tracking_box
from behavior.intervention import InterventionGuard
try:
    from opencv_engine import RobustSegmenter
except ImportError:
    from engine import RobustSegmenter
from layer_video import capture as open_video


def detector_identity(video, arena, model_digest, pipeline_file):
    names = {"run_detector", "detector", "detector_batch_size", "selection_polygons", "arena_mask", "polygon"}
    tree = ast.parse(Path(pipeline_file).read_text())
    code = ast.dump(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[]), include_attributes=False)
    selector = Path(pipeline_file).parent/"hybrid/detector_wistar.py"
    return dict(version="oft-box-stage-1", sourceSha256=digest(video), arena=arena,
                detectorSha256=model_digest, codeSha256=hashlib.sha256(code.encode()).hexdigest(),
                arenaCodeSha256=digest(Path(__file__).with_name("arena.py")),
                selectorSha256=digest(selector))


def geometry_code_identity():
    # Classifier thresholds/weights/descriptors can change independently of
    # geometry. Only the functions consumed by this stage invalidate its cache.
    source = Path(__file__).with_name("oft_layers.py")
    names = {"point", "coordinates", "silhouette", "tail_evidence", "head_location", "LayeredTracker", "tracking_box", "finalize_temporal_pose"}
    tree = ast.parse(source.read_text())
    code = ast.dump(ast.Module(body=[n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))
                                    and n.name in names], type_ignores=[]), include_attributes=False)
    return hashlib.sha256(code.encode()).hexdigest()


def cached_detector(root, identity, run):
    """Cache only complete detections from the same video/arena/weights/policy."""
    root = Path(root); marker = root/"detector-stage.json"; csv_path = root/"detections.csv"
    if marker.is_file() and csv_path.is_file():
        saved = json.loads(marker.read_text())
        if saved.get("identity") == identity and saved.get("sha256") == digest(csv_path):
            with csv_path.open(newline="") as handle:
                rows = list(csv.DictReader(handle))
            for i, row in enumerate(rows):
                if int(row["frame"]) != i:
                    raise ValueError("Cache do detector fora de ordem")
                row["frame"] = i; row["observed"] = row["observed"].lower() == "true"
                for key in ["x", "y", "w", "h", "score"]:
                    row[key] = float(row[key]) if row.get(key) else None
            assert len(rows) == saved["frameCount"]
            return rows, [], len(rows), saved["fps"], saved["width"], saved["height"]
    result = run()
    rows, _, count, fps, width, height = result
    atomic_json(marker, dict(identity=identity, sha256=digest(csv_path), frameCount=count, fps=fps, width=width, height=height))
    return result


def frame_clock(video, count, fps, ffprobe=None):
    probe = ffprobe or shutil.which("ffprobe")
    if probe:
        completed = subprocess.run([str(probe), "-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries",
                                    "frame=best_effort_timestamp_time", "-of", "json", str(video)], capture_output=True, text=True, check=True)
        frames = json.loads(completed.stdout)["frames"]
        values = [float(f["best_effort_timestamp_time"]) for f in frames]
        if len(values) != count or any(not math.isfinite(t) or (i and t <= values[i-1]) for i, t in enumerate(values)):
            raise ValueError("O relógio do vídeo diverge da detecção")
        return [t-values[0] for t in values], "ffprobe_pts"
    # Colab normally supplies FFprobe. Constant-FPS fallback is explicit.
    return [i/fps for i in range(count)], "constant_fps_metadata"


def background_reference(video, count, ffmpeg=None, ffprobe=None):
    cap = open_video(video,ffmpeg,ffprobe); frames = []
    try:
        for index in np.linspace(0, count-1, min(31, count), dtype=int):
            if not cap.set(cv.CAP_PROP_POS_FRAMES, int(index)):
                raise ValueError("Não foi possível preparar o fundo")
            ok, frame = cap.read()
            if not ok:
                raise ValueError("Quadro de referência ausente")
            frames.append(frame)
    finally:
        cap.release()
    return np.median(np.stack(frames), axis=0).astype(np.uint8), frames


def run(video, detections, root, arena, fps, width, height, *, model_directory=None, ffmpeg=None, ffprobe=None, progress=None):
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    count = len(detections)
    if not count or fps <= 0:
        raise ValueError("Detecções ou relógio ausentes")
    # CSV transports audit fields as strings. Hash only the normalized inputs
    # consumed by this layer, so a cached detector does not invalidate geometry.
    normalized=[]
    for i,detection in enumerate(detections):
        observed=str(detection["observed"]).lower()=="true"
        value=dict(frame=int(detection["frame"]),observed=observed)
        value.update({key:float(detection[key]) if observed else None for key in ["x","y","w","h","score"]})
        if value["frame"]!=i or observed and (not np.isfinite([value[k] for k in ["x","y","w","h","score"]]).all()
                or min(value["w"],value["h"])<=0 or min(value["x"],value["y"])<0
                or value["x"]+value["w"]>width+1 or value["y"]+value["h"]>height+1):
            raise ValueError("Caixa do detector inválida ou fora do quadro")
        normalized.append(value)
    rows_signature = json.dumps(normalized, sort_keys=True,allow_nan=False).encode()
    identity = dict(version=VERSION, sourceSha256=digest(video), detectionsSha256=hashlib.sha256(rows_signature).hexdigest(),
        arena=arena, width=width, height=height, fps=fps, codeSha256=digest(__file__),
        sharedCodeSha256=geometry_code_identity(),
        arenaCodeSha256=digest(Path(__file__).with_name("arena.py")),
        axisCodeSha256=digest(Path(__file__).with_name("body_axis.py")),
        interventionCodeSha256=digest(Path(__file__).parent/"behavior/intervention.py"),
        segmenterCodeSha256=digest(__import__(RobustSegmenter.__module__).__file__))
    identity["continuityCodeSha256"]=digest(Path(__file__).with_name("oft_continuity.py"))
    identity["temporalCodeSha256"]={p.name:digest(p) for p in sorted(Path(__file__).with_name("temporal_pose").glob("*.py"))}
    marker = root/"layer_manifest.json"
    cached = False
    if marker.is_file():
        saved = json.loads(marker.read_text())
        cached = saved.get("identity") == identity and all((root/name).is_file() and digest(root/name) == sha
                    for name, sha in saved.get("files", {}).items()) and bool(saved.get("files"))
    config = dict(protocol="open_field", width=width, height=height, arena=arena or dict(cornersPx=[
        dict(x=0,y=0),dict(x=width-1,y=0),dict(x=width-1,y=height-1),dict(x=0,y=height-1)]))
    if not cached:
        timestamps, timing = frame_clock(video, count, fps, ffprobe)
        background, reference_samples = background_reference(video, count,ffmpeg,ffprobe)
        segmentation_config={**config,"mode":"background","threshold":25,"strategy":"classical_roi_v1",
            "minAreaFraction":.001,"maxAreaFraction":.12,"maxPredictionSec":.25,"maxWidth":640,"useOpenCL":False}
        segmenter=RobustSegmenter(segmentation_config,background,reference_samples)
        del reference_samples
        if not cv.imwrite(str(root/"background-reference.png"), background):
            raise OSError("Não foi possível guardar a referência de imagem")
        tracker = LayeredTracker(width, height, config["arena"], background)
        axis_filter = BodyAxisFilter(); guard = InterventionGuard(config, background)
        cap = open_video(video,ffmpeg,ffprobe); temporary = root/"samples.partial.jsonl"
        try:
            with temporary.open("w", encoding="utf-8") as stream:
                for i, detection in enumerate(detections):
                    if int(detection["frame"]) != i:
                        raise ValueError("Detecções fora de ordem")
                    ok, frame = cap.read()
                    if not ok or frame.shape[:2] != (height, width):
                        raise ValueError("Frames e detecções divergem")
                    row = dict(frameIndex=i, timestampSec=timestamps[i], keypoint="box_center", likelihood=0.,
                        source="segmented", status="missing", xPx=None, yPx=None, trackingAccepted=False,
                        metricReference="box_center", referenceApproved=False, reason="no_detection", spatialRegion="unknown")
                    neural=str(detection["observed"]).lower()=="true" and guard.stopped is None
                    box=dict(zip(["x","y","width","height"],[float(detection[k]) for k in ["x","y","w","h"]])) if neural else None
                    if neural:
                        row.update(bbox=box,detectorBox=box,boxSource="detected",source="detected",likelihood=float(detection["score"] or 0.),
                            status="low_confidence",reason="silhouette_unresolved",trackingAccepted=True,
                            xPx=box["x"]+box["width"]/2,yPx=box["y"]+box["height"]/2,
                            localQuality=dict(tracking="observed",geometry="unknown",identity="consistent",reasons=["silhouette_unresolved"]))
                    if guard.stopped is None:
                        # Reuse precisely the same silhouette/appearance engine as
                        # local OpenCV. The neural rectangle guides association;
                        # its size or aspect never substitutes for a skeleton.
                        body=segmenter.process(frame,timestamps[i],guide_box=box)
                        has_body=body.get("source")=="segmented" and body.get("contour") and body.get("bbox")
                        if has_body and box:
                            b=body["bbox"]
                            intersection=max(0,min(b["x"]+b["width"],box["x"]+box["width"])-max(b["x"],box["x"]))*max(0,min(b["y"]+b["height"],box["y"]+box["height"])-max(b["y"],box["y"]))
                            # A floor-only historical neural box can be a small
                            # part of the visible rearing body. Association uses
                            # the smaller support; it never crops that body.
                            has_body=intersection/max(1,min(b["width"]*b["height"],box["width"]*box["height"]))>=.5
                        if has_body:
                            row.update(body)
                            if box:
                                row.update(detectorBox=box,boxSource="detected",likelihood=float(detection["score"] or 0.))
                                row["xPx"],row["yPx"]=box["x"]+box["width"]/2,box["y"]+box["height"]/2
                            else:
                                row.update(boxSource="recovered",likelihood=.7)
                                row["localQuality"]={**body["localQuality"],"tracking":"uncertain",
                                    "reasons":[*body["localQuality"]["reasons"],"local_box_recovery_pending_review"]}
                            row["trackingAccepted"]=bool(neural or body.get("trackingAccepted"))
                            # A box whose center projects above the floor cannot
                            # become floor locomotion through a valid contour.
                            floor=np.array([[p["x"],p["y"]] for p in config["arena"]["cornersPx"]],np.float32)
                            if cv.pointPolygonTest(floor,(row["xPx"],row["yPx"]),False)<0:
                                row["spatialRegion"]="wall_projection"
                                row["localQuality"]["geometry"]="wall_projection"
                        camera=segmenter.assess_camera(frame,i,exclude_box=row.get("bbox"))
                        if camera=="drift":
                            row.update(trackingAccepted=False,status="low_confidence",reason="camera_shift")
                            row["localQuality"]={"tracking":"uncertain","geometry":"unknown","identity":"unverified","reasons":["camera_shift"]}
                    termination = guard.update(frame, timestamps[i], row)
                    if guard.pending is not None or termination:
                        row = {**row, **guard.suppress(row)}
                        row.pop("bbox",None); row.pop("contour",None)
                    row["trackingBox"] = tracking_box(row)
                    row["trackingBoxMethod"] = TRACKING_BOX_POLICY
                    row["bodyAxis"] = axis_filter.update(row)
                    row["oftLayers"] = tracker.update(frame, row)
                    stream.write(json.dumps(row, allow_nan=False)+"\n")
                    if progress and i%32 == 0:
                        progress(i, count)
                if cap.read()[0]:
                    raise ValueError("Vídeo contém quadros além das detecções")
            temporary.replace(root/"samples.jsonl")
        finally:
            cap.release(); temporary.unlink(missing_ok=True)
        from oft_layers import finalize_temporal_pose
        finalize_temporal_pose(root,video,config)
        atomic_json(marker, dict(identity=identity, frameCount=count, policy=POLICY, timing=timing,
            trackingTermination=guard.stopped, files={name:digest(root/name) for name in ["samples.jsonl","background-reference.png"]}))
    behavior = finish_layers(root, video, config, model_directory,ffmpeg=ffmpeg,ffprobe=ffprobe)
    samples = [json.loads(line) for line in (root/"samples.jsonl").read_text().splitlines()]
    export(samples, detections, root)
    manifest = dict(schemaVersion=1, pipelineVersion=VERSION, modelBundleId="wistar_df_v2", engineId="wistar_superanimal_hybrid_v1",
        sourceSha256=identity["sourceSha256"], frameCount=count, fps=fps, frameWidth=width, frameHeight=height,
        keypointCount=len(KEYPOINTS), keypoints=KEYPOINTS, layers={**POLICY,"trackingBox":TRACKING_BOX_POLICY}, metricReference="box_center",
        geometryCacheReused=cached, rearing=behavior, artifacts=dict(layeredSamples="samples.jsonl",
        layerManifest="layer_manifest.json", rearingCandidates="rearing_candidates.json", rearingPredictions="rearing_predictions.jsonl"))
    atomic_json(root/"run_manifest.json", manifest)
    if progress: progress(count, count)
    return manifest


def export(samples, detections, root):
    predictions = {r["frameIndex"]:r for r in map(json.loads,(Path(root)/"rearing_predictions.jsonl").read_text().splitlines())}
    header = ["frame_index","timestamp_sec","animal_id","keypoint","x_px","y_px","likelihood","status","spatial_region",
              "bbox_x","bbox_y","bbox_width","bbox_height","source","raw_x_px","raw_y_px","raw_likelihood","raw_status","raw_source",
              "metric_reference","reference_approved","tracking_accepted","tracking_reason","processing_version",
              "tracking_state","geometry_state","identity_state","quality_reasons","layered_observation"]
    quality = []
    with (Path(root)/"canonical_pose.csv").open("w",newline="") as handle:
        writer = csv.DictWriter(handle,fieldnames=header); writer.writeheader()
        for sample, detection in zip(samples,detections):
            orientation = sample["oftLayers"]["orientation"]
            axis = sample["bodyAxis"]["points"]
            visual = sample["oftLayers"].get("visualization")
            if visual:
                # Canonical recovered points are estimates, matching the
                # display. Original bodyAxis/orientation stay in frame metadata.
                axis = visual["points"]
                orientation = dict(head=visual["head"],tailBase=visual["tailBase"],confidence=visual["supportScore"])
            box = tracking_box(sample)
            valid = sample.get("trackingAccepted") is True and box is not None
            accepted = 0
            for key in KEYPOINTS:
                value = None; score = .7; source = "recovered"
                if key.startswith("body_axis_") and axis:
                    value = axis[int(key[-1])]
                elif key in ["head_midpoint","tail_base"]:
                    value = orientation["head" if key=="head_midpoint" else "tailBase"]
                    score = orientation["confidence"]
                elif key == "mouse_center" and valid:
                    value = dict(x=sample["xPx"],y=sample["yPx"]); score=sample.get("likelihood",0.);source=sample.get("boxSource","detected")
                visible = value is not None and sample.get("reason") not in ["researcher_intervention","researcher_intervention_pending"]
                accepted += visible
                writer.writerow(dict(frame_index=sample["frameIndex"], timestamp_sec=sample["timestampSec"],animal_id="animal_1",keypoint=key,
                    x_px=value["x"] if visible else "", y_px=value["y"] if visible else "",likelihood=score if visible else 0.,
                    status="valid" if visible and source=="detected" and sample.get("localQuality",{}).get("geometry")=="floor" else "low_confidence" if visible else "missing",
                    spatial_region=sample.get("spatialRegion","unknown"), bbox_x=box["x"] if box else "",bbox_y=box["y"] if box else "",
                    bbox_width=box["width"] if box else "",bbox_height=box["height"] if box else "",source=source,
                    raw_x_px=value["x"] if visible and source=="detected" else "",raw_y_px=value["y"] if visible and source=="detected" else "",
                    raw_likelihood=score if visible and source=="detected" else 0.,raw_status="valid" if visible and source=="detected" else "missing",raw_source="detected",
                    metric_reference="box_center" if key=="mouse_center" else "",reference_approved="false",
                    tracking_accepted=str(visible).lower(),tracking_reason="silhouette_estimate_pending_review" if visible and source=="recovered" else sample["reason"],processing_version=VERSION,
                    tracking_state=sample.get("localQuality",{}).get("tracking","missing"),geometry_state=sample.get("localQuality",{}).get("geometry","unknown"),
                    identity_state=sample.get("localQuality",{}).get("identity","unverified"),quality_reasons="|".join(sample.get("localQuality",{}).get("reasons",[])),
                    layered_observation=json.dumps(dict(bodyAxis=sample["bodyAxis"],oftLayers={**sample["oftLayers"],"rearing":predictions[sample["frameIndex"]]})) if key=="mouse_center" else ""))
            quality.append(dict(frame_index=sample["frameIndex"],timestamp_sec=sample["timestampSec"],visual_points=accepted,
                orientation_state=sample["oftLayers"]["orientation"]["state"],
                estimated_orientation_state=(visual.get("temporal") or {}).get("orientationState", "estimated" if visual.get("head") else "unknown") if visual else "unavailable",
                quality_flags=sample["reason"]))
    with (Path(root)/"qc_by_frame.csv").open("w",newline="") as handle:
        writer=csv.DictWriter(handle,fieldnames=list(quality[0]));writer.writeheader();writer.writerows(quality)
