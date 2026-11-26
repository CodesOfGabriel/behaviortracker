"""Train an experimental CPU apex detector from exhaustively annotated points.

This target is an apex, not posture duration. Background frames are non-apex
examples derived from the operator's explicit completeness declaration.
"""
import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path
import numpy as np
from common import write_json
from behavior.export_dataset import active_annotations, export, export_annotations
from behavior.open_field import read_samples, sha256
from behavior.peak_model import SCHEMA, features, visual_features, predict_forest, proposals, match_peaks


def read_request(source, video=None):
    source = Path(source).resolve()
    if source.is_dir():
        metadata = json.loads((source/"dataset_export.json").read_text(encoding="utf-8"))
        vid = metadata["videoId"]
        if not isinstance(vid,str) or Path(vid).name != vid or any(c in vid for c in "/\\"):
            raise ValueError("ID de vídeo inválido")
        tracking = source/"tracking"/vid
        with (source/"annotations/videos.csv").open(newline="",encoding="utf-8-sig") as stream:
            video_metadata = next((row for row in csv.DictReader(stream) if row["video_id"]==vid),None)
        if video_metadata is None:
            raise ValueError("Metadados do vídeo ausentes")
        request = json.loads((tracking/"request.json").read_text(encoding="utf-8"))
        request.update(experimentId=vid, trackingJobId=metadata["trackingJobId"], videoSha256=metadata["videoSha256"],
            samples=str(tracking/"samples.jsonl"), trackingDirectory=str(tracking),
            annotations=[json.loads(line) for line in (source/"annotations/history.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()],
            annotationProtocol=(source/"annotations/annotation_protocol.md").read_text(encoding="utf-8"),
            animalId=video_metadata["animal_id"], sessionId=video_metadata["session_id"], arenaId=video_metadata["arena_id"],
            condition=video_metadata.get("condition","unspecified"), includeVideo=False)
        videos = list((source/"videos").glob(vid+".*")) if (source/"videos").is_dir() else []
        if len(videos)==1:
            request["video"] = str(videos[0])
    else:
        request = json.loads(source.read_text(encoding="utf-8"))
    if video:
        request["video"] = str(Path(video).resolve())
    return request


def portable(forest):
    result = []
    for estimator in forest.estimators_:
        tree = estimator.tree_
        weights = tree.value[:, 0]
        result.append(dict(feature=tree.feature.tolist(), threshold=tree.threshold.tolist(),
            left=tree.children_left.tolist(), right=tree.children_right.tolist(),
            positive=(weights[:, 1]/weights.sum(axis=1)).tolist()))
    return result


def fit(matrix, labels, selected, seed):
    from sklearn.ensemble import RandomForestClassifier
    if set(labels[selected]) != {0, 1}:
        raise ValueError("A partição precisa de ápices e exemplos de fundo")
    return RandomForestClassifier(n_estimators=240, max_depth=12, min_samples_leaf=2,
        max_features=.25, class_weight="balanced", random_state=seed, n_jobs=2).fit(matrix[selected], labels[selected])


def save_bundle(path, rearing, subtype, threshold, report, report_matrix):
    path.mkdir()
    model = dict(featureSchema=SCHEMA, rearing=portable(rearing), subtype=portable(subtype) if subtype else None,
        threshold=threshold, minimumGapSec=.3)
    write_json(path/"peak_model.json", model)
    data = (path/"peak_model.json").read_bytes()
    manifest = dict(modelId="oft_rearing_apex_v1", modelVersion="local-1", featureSchema=SCHEMA,
        predictionTarget="human_annotated_apex", durationMeasured=False, validationStatus="experimental",
        scientificallyValidated=False, sha256=hashlib.sha256(data).hexdigest(), sizeBytes=len(data),
        probabilityCalibrated=False, training=report)
    write_json(path/"manifest.json", manifest)
    expected = rearing.predict_proba(report_matrix)[:, 1]
    actual = predict_forest(model["rearing"], report_matrix)
    np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-6)
    return model


def train(request_path, output, exhaustive=False, seed=42, video=None, ffmpeg=None, ffprobe=None):
    if not exhaustive:
        raise ValueError("Confirme a revisão completa com --exhaustive-peaks; ápices ausentes não são negativos")
    request = read_request(request_path, video)
    if ffmpeg: request["ffmpeg"] = ffmpeg
    if ffprobe: request["ffprobe"] = ffprobe
    snapshot = json.dumps(request, ensure_ascii=False)
    if request.get("config", {}).get("protocol") != "open_field":
        raise ValueError("O treinamento de ápices é exclusivo do Campo Aberto")
    if sha256(request["video"]) != request["videoSha256"]:
        raise ValueError("Vídeo original divergente")
    _, peaks = active_annotations(request["annotations"])
    positives = [p for p in peaks if p["label"].startswith("REARING_")]
    if len(positives) < 12:
        raise ValueError("São necessários pelo menos 12 ápices confirmados para este ajuste experimental")
    samples = list(read_samples(request["samples"]))
    for peak in peaks:
        if peak.get("source") != "human" or not str(peak.get("annotatorId","")).strip() or peak.get("label") not in {"REARING_SUPPORTED","REARING_UNSUPPORTED","REARING_UNSPECIFIED","UNKNOWN"}:
            raise ValueError("Somente ápices humanos identificados podem supervisionar o modelo")
        if not isinstance(peak.get("frameIndex"),int) or not 0 <= peak["frameIndex"] < len(samples) or not np.isfinite(peak.get("timestampSec",float("nan"))):
            raise ValueError("Frame ou timestamp da anotação inválido")
        if peak["videoSha256"] != request["videoSha256"] or peak["trackingJobId"] != request["trackingJobId"]:
            raise ValueError("Anotação de outro vídeo/tracking")
        if abs(samples[peak["frameIndex"]]["timestampSec"]-peak["timestampSec"]) > 1e-6:
            raise ValueError("O ápice diverge do PTS original")
    visual, termination = visual_features(request, samples)
    matrix, usable, observed = features(samples, visual, termination["timestampSec"] if termination else None)
    times = np.array([s["timestampSec"] for s in samples])
    cutoff = termination["timestampSec"] if termination else times[-1]
    usable &= times < cutoff
    peak_times = np.array([p["timestampSec"] for p in positives])
    distance = np.min(np.abs(times[:, None]-peak_times[None, :]), axis=1)
    labels = (distance <= 1/12+1e-6).astype(np.int64)
    # The grey region around a peak is excluded, irrespective of session completeness.
    selected = usable & ((labels == 1) | ((distance >= .75) & (np.arange(len(times)) % 3 == 0)))
    for peak in peaks:
        if peak["label"] == "UNKNOWN":
            selected &= np.abs(times-peak["timestampSec"]) > .75
    bounds = (.6*cutoff, .8*cutoff)
    parts = dict(train=times < bounds[0]-1., validation=(times >= bounds[0]+1.) & (times < bounds[1]-1.), test=times >= bounds[1]+1.)
    output = Path(output); output.mkdir(parents=True, exist_ok=False)
    checkpoint = fit(matrix, labels, selected & parts["train"], seed)
    scores = checkpoint.predict_proba(matrix)[:, 1]
    best = None
    for threshold in np.arange(.05, .96, .025):
        candidates = proposals(samples, scores, usable & parts["validation"], float(threshold), .3)
        expected = [t for t in peak_times if bounds[0]+1 <= t < bounds[1]-1]
        metrics = match_peaks([times[i] for i in candidates], expected)
        rank = (metrics["f1"] or 0., metrics["precision"] or 0., float(threshold))
        if best is None or rank > best[0]:
            best = rank, float(threshold), metrics
    threshold = best[1]
    heldout = proposals(samples, scores, usable & parts["test"], threshold, .3)
    test = match_peaks([times[i] for i in heldout], [t for t in peak_times if t >= bounds[1]+1])
    peak_indices = [p["frameIndex"] for p in positives]
    report = dict(schemaVersion=1, target="apex_only_no_duration", exhaustivePeaksConfirmed=True,
        completenessSource="explicit_operator_declaration", annotations=len(positives),
        annotationLabels=dict(collections.Counter(p["label"] for p in positives)),
        observedPeakDescriptors=sum(bool(observed[i]) for i in peak_indices),
        uncertainPeakDescriptors=sum(bool(usable[i] and not observed[i]) for i in peak_indices),
        unusablePeakDescriptors=sum(not bool(usable[i]) for i in peak_indices),
        videoSha256=request["videoSha256"], trackingJobId=request["trackingJobId"],
        samplesSha256=sha256(request["samples"]), requestSha256=hashlib.sha256(snapshot.encode()).hexdigest(),
        annotationsSha256=hashlib.sha256("".join(json.dumps(e,ensure_ascii=False)+"\n" for e in request["annotations"]).encode()).hexdigest(),
        featureSchema=SCHEMA,
        independentVideos=1, independentValidation=False, scientificallyValidated=False,
        inputFeatures="silhouette_geometry_motion_and_rotation_invariant_image_HOG_texture",
        positiveWindowSec=1/12, negativeExclusionSec=.75, contextSec=.5, temporalEmbargoSec=1.,
        splitPolicy="chronological_60_20_20_same_video", splitBoundariesSec=list(bounds),
        partitionSamples={key:int(np.count_nonzero(selected & value)) for key,value in parts.items()},
        threshold=threshold, thresholdSelectedOn="validation_only", validation=best[2], temporalHoldoutTest=test,
        finalModelRefittedOnAllAnnotations=True, finalModelIndependentAccuracy=None,
        trackingTermination=termination, durationMeasured=False, seed=seed,
        limitations=["Single animal/session/video; temporal holdout does not establish generalization to other animals.",
            "The temporal test slice was reused during development and is not an untouched final test.",
            "Completeness applies to apex points, not episode onset, offset or duration.",
            "Uncertain segmented boxes may supply descriptors; model proposals never confirm identity or floor metrics.",
            "The final all-data refit has no independent accuracy estimate; test metrics describe the pre-refit model."])
    report["trainingCodeSha256"] = hashlib.sha256(Path(__file__).read_bytes()+
        (Path(__file__).resolve().parents[2]/"src-tauri/python/behavior/peak_model.py").read_bytes()).hexdigest()
    report["testStatus"] = "reused_development_temporal_holdout"
    # Known subtypes use exact human frames; unknown subtypes never become negatives.
    subtype_rows = [(p["frameIndex"], int(p["label"] == "REARING_SUPPORTED")) for p in positives
        if p["label"] in {"REARING_SUPPORTED", "REARING_UNSUPPORTED"} and usable[p["frameIndex"]]]
    subtype = None
    if {label for _,label in subtype_rows} == {0,1}:
        from sklearn.ensemble import RandomForestClassifier
        indices, targets = zip(*subtype_rows)
        subtype = RandomForestClassifier(n_estimators=160, max_depth=6, min_samples_leaf=2,
            class_weight="balanced", random_state=seed, n_jobs=2).fit(matrix[list(indices)], targets)
    final = fit(matrix, labels, selected, seed)
    report_matrix = matrix[::max(1, len(matrix)//200)]
    model = save_bundle(output/"model", final, subtype, threshold, report, report_matrix)
    final_scores = predict_forest(model["rearing"], matrix)
    indices = proposals(samples, final_scores, usable, threshold, .3)
    report["resubstitutionDiagnosticOnly"] = match_peaks([times[i] for i in indices], peak_times)
    write_json(output/"training_report.json", report)
    np.savez_compressed(output/"training_features.npz", matrix=matrix, usable=usable, observed=observed)
    write_json(output/"evaluation_model.json", dict(rearing=portable(checkpoint), threshold=threshold))
    write_json(output/"evaluation_predictions.json", dict(test=[dict(timestampSec=float(times[i]), score=float(scores[i])) for i in heldout]))
    saved = output/"request.json"
    saved.write_text(snapshot, encoding="utf-8")
    export_annotations(saved, output/"peaks.csv", "peaks")
    export_annotations(saved, output/"behavior_annotations.jsonl", "history")
    export(saved, output/"human_annotations.zip")
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request"); parser.add_argument("output")
    parser.add_argument("--video",help="Vídeo original, quando o ZIP foi exportado sem vídeo")
    parser.add_argument("--ffmpeg");parser.add_argument("--ffprobe")
    parser.add_argument("--exhaustive-peaks", action="store_true"); parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(); train(args.request, args.output, args.exhaustive_peaks, args.seed,args.video,args.ffmpeg,args.ffprobe)
