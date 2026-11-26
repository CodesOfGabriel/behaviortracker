"""Portable CPU forest for apex proposals; it never assigns episode duration."""
import hashlib
import json
from pathlib import Path
import cv2 as cv
import numpy as np
from .export_dataset import active_annotations
from .observation_quality import behavior_observation_quality

SCHEMA = "oft-apex-features-2"
OFFSETS = (-.5, -.25, -.125, 0., .125, .25, .5)


def number(value):
    return float(value) if isinstance(value, (int, float)) and np.isfinite(value) else np.nan


def features(samples, visual=None, cutoff=None):
    """Noncausal +/-0.5 s context, using source PTS and explicit missing masks."""
    times = np.array([s["timestampSec"] for s in samples])
    if not len(times) or np.any(np.diff(times) <= 0):
        raise ValueError("Tracking timestamps must be strictly increasing")
    base = np.full((len(samples), 16), np.nan, np.float32)
    usable = np.zeros(len(samples), bool)
    observed = np.zeros(len(samples), bool)
    for index, sample in enumerate(samples):
        if sample.get("frameIndex") != index:
            raise ValueError("Tracking must contain every source frame in order")
        box, contour = sample.get("bbox"), sample.get("contour")
        if not box or not contour or sample.get("source") != "segmented" or sample.get("reason") in {"camera_shift", "researcher_intervention", "researcher_intervention_pending"}:
            continue
        if not all(np.isfinite(number(box.get(k))) for k in ("x", "y", "width", "height")):
            continue
        points = np.asarray([[p["x"], p["y"]] for p in contour], np.float32)
        if len(points) < 3 or not np.isfinite(points).all():
            continue
        area, perimeter = cv.contourArea(points), cv.arcLength(points, True)
        if area <= 0 or min(box["width"], box["height"]) <= 0:
            continue
        major, minor = sorted(cv.minAreaRect(points)[1], reverse=True)
        hull = cv.contourArea(cv.convexHull(points))
        f = sample.get("features") or {}
        observed[index] = behavior_observation_quality(sample) == "OBSERVED"
        usable[index] = True
        base[index] = [np.log1p(area), np.log1p(major), np.log1p(minor), major/max(1., minor),
            min(1., 4*np.pi*area/max(1., perimeter**2)), area/max(1., hull),
            area/(box["width"]*box["height"]), box["width"]/box["height"],
            number(f.get("speedPxSec"))/np.sqrt(area), number(f.get("changedPixelFraction")),
            number(f.get("meanAbsDifference"))/255., number(sample.get("floorOverlapFraction")),
            np.sin(2*number(f.get("axisRad"))), np.cos(2*number(f.get("axisRad"))),
            float(observed[index]), float(sample.get("trackingAccepted") is True)]
    if cutoff is not None:
        after = times >= cutoff
        base[after] = np.nan
        usable[after] = False
        observed[after] = False
        if visual is not None:
            visual = visual.copy()
            visual[after] = np.nan
    columns = []
    for offset in OFFSETS:
        wanted = times+offset
        right = np.clip(np.searchsorted(times, wanted), 0, len(times)-1)
        left = np.maximum(0, right-1)
        selected = np.where(np.abs(times[left]-wanted) <= np.abs(times[right]-wanted), left, right)
        values = base[selected].copy()
        values[np.abs(times[selected]-wanted) > .09] = np.nan
        columns.append(values)
    raw = np.concatenate(columns, axis=1)
    if visual is not None:
        for offset in (-.25, 0., .25):
            wanted = times+offset
            right = np.clip(np.searchsorted(times, wanted), 0, len(times)-1)
            left = np.maximum(0, right-1)
            selected = np.where(np.abs(times[left]-wanted) <= np.abs(times[right]-wanted), left, right)
            value = visual[selected].copy()
            value[np.abs(times[selected]-wanted) > .09] = np.nan
            columns.append(value)
        raw = np.concatenate(columns, axis=1)
    return np.concatenate([np.nan_to_num(raw, nan=0.), np.isfinite(raw).astype(np.float32)], axis=1), usable, observed


def visual_features(request, samples):
    """Rotation/180-degree invariant body texture and shape, from actual pixels."""
    from .open_field import read_frames, session_reference
    from .intervention import InterventionGuard
    config = request["config"]
    background = cv.imread(str(Path(request["trackingDirectory"])/"background-reference.png"))
    if background is None:
        raise ValueError("Refaça o tracking OpenCV para detectar a entrada do pesquisador")
    guard = InterventionGuard(config, background)
    size = (min(640, config["width"]), round(config["height"]*min(640, config["width"])/config["width"]))
    scale = size[0]/config["width"]
    side = session_reference(request["samples"])["cropLengthPx"]*1.6*scale
    hog = cv.HOGDescriptor((32, 32), (16, 16), (16, 16), (8, 8), 9)
    result = np.full((len(samples), 208), np.nan, np.float32)
    cv.setNumThreads(2)
    capture = read_frames(request["video"], request["ffmpeg"], config["width"], config["height"],
        config.get("autorotate", False), output_size=size)
    try:
        for index, row in enumerate(samples):
            frame = next(capture, None)
            if frame is None:
                raise ValueError("Frames e tracking divergiram")
            guard.update(frame, row["timestampSec"], row)
            if guard.pending is not None or guard.stopped is not None:
                continue
            box = row.get("bbox")
            if not box or not row.get("contour") or row.get("source") != "segmented":
                continue
            center = ((box["x"]+box["width"]/2)*scale, (box["y"]+box["height"]/2)*scale)
            angle = number((row.get("features") or {}).get("axisRad"))
            transform = cv.getRotationMatrix2D(center, float(np.degrees(angle)) if np.isfinite(angle) else 0., 32/side)
            transform[:, 2] += (16-center[0], 16-center[1])
            crop = cv.warpAffine(frame, transform, (32, 32), borderMode=cv.BORDER_CONSTANT)
            gray = cv.cvtColor(crop, cv.COLOR_BGR2GRAY)
            # An undirected body axis cannot establish head/tail. Average both views.
            inverse = cv.flip(gray, -1)
            gradient = (hog.compute(gray).ravel()+hog.compute(inverse).ravel())/2
            texture = (cv.resize(gray, (8, 8)).astype(np.float32)+cv.resize(inverse, (8, 8)))/510.
            result[index] = np.concatenate([gradient, texture.ravel()])
        if next(capture, None) is not None:
            raise ValueError("Tracking terminou antes do vídeo")
    finally:
        capture.close()
    return result, guard.stopped


def predict_forest(trees, matrix):
    result = np.zeros(len(matrix), np.float64)
    for tree in trees:
        feature, threshold = np.array(tree["feature"]), np.array(tree["threshold"])
        left, right = np.array(tree["left"]), np.array(tree["right"])
        values = np.array(tree["positive"])
        nodes = np.zeros(len(matrix), np.int32)
        active = np.flatnonzero(left[nodes] >= 0)
        depth = 0
        while len(active):
            depth += 1
            if depth > 64:
                raise ValueError("Árvore do modelo inválida ou cíclica")
            current = nodes[active]
            nodes[active] = np.where(matrix[active, feature[current]] <= threshold[current], left[current], right[current])
            active = active[left[nodes[active]] >= 0]
        result += values[nodes]
    return result/max(1, len(trees))


def proposals(samples, scores, usable, threshold, minimum_gap=.6):
    # One maximum per contiguous score excursion, not one proposal every few
    # frames throughout a plateau. This still never creates episode duration.
    above = np.flatnonzero(usable & (scores >= threshold))
    runs = []
    for index in above:
        if not runs or index != runs[-1][-1]+1 or samples[index]["timestampSec"]-samples[runs[-1][-1]]["timestampSec"] > .125:
            runs.append([])
        runs[-1].append(int(index))
    order = [max(run, key=lambda i: scores[i]) for run in runs]
    order = sorted(order, key=lambda i: (-scores[i], samples[i]["timestampSec"]))
    selected = []
    for index in order:
        time = samples[index]["timestampSec"]
        if all(abs(time-samples[other]["timestampSec"]) >= minimum_gap for other in selected):
            selected.append(int(index))
    return sorted(selected, key=lambda i: samples[i]["timestampSec"])


def match_peaks(predicted, expected, tolerance=.5):
    """Maximum cardinality one-to-one matching of sorted points on a time axis."""
    predicted, expected = sorted(predicted), sorted(expected)
    i = j = 0
    errors = []
    while i < len(predicted) and j < len(expected):
        if predicted[i] < expected[j]-tolerance:
            i += 1
        elif expected[j] < predicted[i]-tolerance:
            j += 1
        else:
            errors.append(predicted[i]-expected[j]); i += 1; j += 1
    tp, fp, fn = len(errors), len(predicted)-len(errors), len(expected)-len(errors)
    return dict(truePositive=tp, falsePositive=fp, falseNegative=fn,
        precision=tp/(tp+fp) if tp+fp else None, recall=tp/(tp+fn) if tp+fn else None,
        f1=2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None,
        meanAbsoluteTimingErrorSec=float(np.mean(np.abs(errors))) if errors else None, toleranceSec=tolerance)


def load_model(directory):
    directory = Path(directory)
    manifest = json.loads((directory/"manifest.json").read_text(encoding="utf-8"))
    model_file = directory/"peak_model.json"
    if manifest.get("modelId") != "oft_rearing_apex_v1" or manifest.get("featureSchema") != SCHEMA:
        raise ValueError("Modelo de ápices incompatível")
    data = model_file.read_bytes()
    if len(data) != manifest["sizeBytes"] or hashlib.sha256(data).hexdigest() != manifest["sha256"]:
        raise ValueError("Modelo de ápices corrompido")
    model = json.loads(data)
    if not .0 < model["threshold"] <= 1 or not model.get("rearing"):
        raise ValueError("Modelo de ápices inválido")
    return manifest, model


def analyze(request, model_directory):
    from .open_field import sha256, read_samples
    if request.get("config", {}).get("protocol") != "open_field":
        raise ValueError("O modelo de ápices é exclusivo do Campo Aberto")
    if sha256(request["video"]) != request["videoSha256"]:
        raise ValueError("O vídeo foi alterado")
    manifest, model = load_model(model_directory)
    samples = list(read_samples(request["samples"]))
    cv.setNumThreads(2)
    visual, termination = visual_features(request, samples)
    matrix, usable, observed = features(samples, visual, termination["timestampSec"] if termination else None)
    if termination:
        usable &= np.array([s["timestampSec"] < termination["timestampSec"] for s in samples])
    scores = predict_forest(model["rearing"], matrix)
    subtype = predict_forest(model["subtype"], matrix) if model.get("subtype") else np.full(len(matrix), .5)
    indices = proposals(samples, scores, usable, model["threshold"], model["minimumGapSec"])
    candidates = [dict(frameIndex=i, timestampSec=samples[i]["timestampSec"], score=float(scores[i]),
        label="REARING_SUPPORTED" if subtype[i] >= .8 else "REARING_UNSUPPORTED" if subtype[i] <= .2 else "REARING_UNSPECIFIED",
        observation="OBSERVED" if observed[i] else "UNCERTAIN", source="model_candidate", reviewStatus="pending") for i in indices]
    metrics = manifest.get("training", {}).get("temporalHoldoutTest", {})
    warning = ""
    if metrics.get("precision") is not None:
        warning = f" No teste temporal de desenvolvimento: {100*metrics['precision']:.1f}% de precisão ({metrics['truePositive']} acertos e {metrics['falsePositive']} propostas extras)."
    return dict(model=manifest, candidates=candidates, trackingTermination=termination,
        sameTrainingVideo=request["videoSha256"] == manifest.get("training", {}).get("videoSha256"),
        scientificallyValidated=False, durationMeasured=False, message="Propostas de ápices para revisão. O score não é uma probabilidade calibrada; nenhum episódio ou duração foi criado."+warning)


def run(request_path, model_directory, output_path):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    result = analyze(request, model_directory)
    Path(output_path).write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    return result
