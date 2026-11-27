"""Shared Open Field layers: observed silhouette, body axis, orientation, proposals.

Head/tail endpoints are explicitly estimates, never anatomical measurements.
Behavior proposals never create confirmed episodes or automatic durations.
"""
import hashlib
import json
import math
from pathlib import Path

import cv2 as cv
import numpy as np
from body_axis import BodyAxisFilter
from layer_video import capture as open_video
from oft_continuity import VisualContinuity, VERSION as CONTINUITY_VERSION
from temporal_pose import VERSION as TEMPORAL_VERSION

VERSION = "oft-layers-1"
TRACKING_BOX_POLICY = "observed_detector_silhouette_union_v1"


def tracking_box(sample):
    """Observed body extent is never cropped to the detector or metric floor."""
    if sample.get("reason") in {"researcher_intervention", "researcher_intervention_pending"}:
        return None
    boxes = [sample.get("detectorBox")]
    if sample.get("source") == "segmented" and sample.get("contour"):
        boxes.append(sample.get("bbox"))
    if not any(boxes):
        boxes = [sample.get("bbox")]
    boxes = [b for b in boxes if b and all(math.isfinite(b[k]) for k in ["x", "y", "width", "height"])
             and min(b["width"], b["height"]) > 0]
    if not boxes:
        return None
    left, top = min(b["x"] for b in boxes), min(b["y"] for b in boxes)
    return dict(x=left, y=top, width=max(b["x"]+b["width"] for b in boxes)-left,
                height=max(b["y"]+b["height"] for b in boxes)-top)
KEYPOINTS = [*(f"body_axis_{i}" for i in range(7)), "head_midpoint", "mouse_center", "tail_base"]
POLICY = {"version": VERSION, "stages": ["box", "silhouette", "body_axis", "head_tail", "rearing"],
          "headTracking":"axial_tail_foreground_v3",
          "visualContinuity":CONTINUITY_VERSION,
          "temporalRefinement":TEMPORAL_VERSION,
          "silhouetteSupport":"body_background_likelihood_v1",
          "anatomicalEndpoints": "estimated_pending_review", "estimatedPointsMetricEligible": False,
          "orientationScoreCalibrated": False,
          "orientationMaximumGapSec": .75, "behaviorOutput": "apex_candidates_pending_review",
          "heightMeasured": False, "scientificallyValidated": False}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024*1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(".partial.json")
    temporary.write_text(json.dumps(value, allow_nan=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def point(value):
    return dict(x=float(value[0]), y=float(value[1]))


def coordinates(value):
    return np.array([value["x"], value["y"]], float)


def silhouette(frame, box, background=None, floor_mask=None):
    """Segment only the detector crop, without interpreting a rectangle as pose.

    Frozen background differences preserve immobile animals. Otsu polarity is
    considered only when the difference has no usable current component.
    """
    if not box:
        return None
    height, width = frame.shape[:2]
    x, y, w, h = (float(box[k]) for k in ("x", "y", "width", "height"))
    if not np.isfinite([x, y, w, h]).all() or min(w, h) <= 2:
        return None
    margin = .15*max(w, h)
    left, top = max(0, int(x-margin)), max(0, int(y-margin))
    right, bottom = min(width, math.ceil(x+w+margin)), min(height, math.ceil(y+h+margin))
    if min(right-left, bottom-top) < 5:
        return None
    view = frame[top:bottom, left:right]
    gray = cv.GaussianBlur(cv.cvtColor(view, cv.COLOR_BGR2GRAY), (3, 3), 0)
    masks = []
    changed = None
    if background is not None:
        ref = cv.cvtColor(background[top:bottom, left:right], cv.COLOR_BGR2GRAY)
        delta = gray.astype(float)-cv.GaussianBlur(ref, (3, 3), 0).astype(float)
        delta -= np.median(delta)
        changed = (np.abs(delta) >= 12).astype(np.uint8)*255
        masks.append(changed)
    _, light = cv.threshold(gray, 0, 255, cv.THRESH_BINARY+cv.THRESH_OTSU)
    masks.extend([light, 255-light])
    # Stable bright walls cannot be joined to the animal just because Otsu
    # assigns them the same intensity. Keep all floor pixels and current image
    # changes above the floor, preserving wall projections during rearing.
    support = ((floor_mask[top:bottom,left:right]>0) | (changed>0)) if floor_mask is not None and changed is not None else None
    candidates = []
    for order, mask in enumerate(masks):
        if support is not None:
            mask=cv.bitwise_and(mask,support.astype(np.uint8)*255)
        # Remove thin tails before defining the thick body core and axis.
        radius = max(2, min(6, round(min(w, h)*.10)))
        kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, (radius*2+1, radius*2+1))
        clean = cv.morphologyEx(cv.morphologyEx(mask, cv.MORPH_OPEN, kernel), cv.MORPH_CLOSE, kernel)
        for contour in cv.findContours(clean, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)[0]:
            area = cv.contourArea(contour)
            if not max(12., w*h*.025) <= area <= w*h*.95:
                continue
            bx, by, bw, bh = cv.boundingRect(contour)
            bx += left; by += top
            overlap = max(0., min(bx+bw, x+w)-max(bx, x))*max(0., min(by+bh, y+h)-max(by, y))
            if overlap/(bw*bh) < .65:
                continue
            # Reject components cut by the crop; a clipped wall is not a rat.
            if bx <= left or by <= top or bx+bw >= right or by+bh >= bottom:
                continue
            moments = cv.moments(contour)
            center = (moments["m10"]/moments["m00"]+left, moments["m01"]/moments["m00"]+top)
            displacement = math.dist(center, (x+w/2, y+h/2))/max(w, h)
            score = area/(bw*bh)+overlap/(bw*bh)-displacement+min(1.,area/(w*h))
            original = cv.approxPolyDP(contour, .75, True).reshape(-1, 2)+[left, top]
            candidates.append((order, score, original, dict(x=bx, y=by, width=bw, height=bh)))
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[1], reverse=True)
    distinct=[]
    for candidate in candidates:
        box_a=candidate[3]
        duplicate=False
        for previous in distinct:
            box_b=previous[3]
            intersection=max(0,min(box_a["x"]+box_a["width"],box_b["x"]+box_b["width"])-max(box_a["x"],box_b["x"]))*max(0,min(box_a["y"]+box_a["height"],box_b["y"]+box_b["height"])-max(box_a["y"],box_b["y"]))
            union=box_a["width"]*box_a["height"]+box_b["width"]*box_b["height"]-intersection
            if intersection/max(1,union)>.6:duplicate=True;break
        if not duplicate:distinct.append(candidate)
    candidates=distinct
    if len(candidates) > 1 and candidates[0][1]-candidates[1][1] < .12:
        return None
    _, _, contour, body_box = candidates[0]
    return dict(contour=[point(p) for p in contour], bbox=body_box)


def tail_evidence(frame, contour, axis, original_size, arena=None, background=None):
    """A long, thin image appendage connected to the current body supports direction.

    No head is assigned from PCA sign, wall proximity, travel direction or a
    previous pose alone. Ambiguous/no-tail images retain explicit uncertainty.
    """
    scale = np.array([frame.shape[1]/original_size[0], frame.shape[0]/original_size[1]])
    polygon = np.rint(np.array([[p["x"], p["y"]] for p in contour])*scale).astype(np.int32)
    x, y, w, h = cv.boundingRect(polygon)
    margin = max(w, h)
    left, top = max(0, x-margin), max(0, y-margin)
    right, bottom = min(frame.shape[1], x+w+margin), min(frame.shape[0], y+h+margin)
    gray = cv.cvtColor(frame[top:bottom, left:right], cv.COLOR_BGR2GRAY)
    mask = np.zeros(gray.shape, np.uint8)
    cv.fillPoly(mask, [polygon-[left, top]], 255)
    distance = cv.distanceTransform(mask, cv.DIST_L2, 3)
    radius = float(distance.max())
    if radius < 2:
        return None
    core = distance >= radius*.55
    ring_radius=max(4,round(radius*.75))
    ring = (cv.dilate(mask, cv.getStructuringElement(cv.MORPH_ELLIPSE,(2*ring_radius+1,2*ring_radius+1))) > 0) & (mask == 0)
    floor_mask=None
    if arena and arena.get("cornersPx"):
        floor_mask=np.zeros_like(mask)
        floor_polygon=np.rint(np.array([[p["x"],p["y"]] for p in arena["cornersPx"]])*scale-[left,top]).astype(np.int32)
        cv.fillPoly(floor_mask,[floor_polygon],255)
        ring &= floor_mask>0
    if not np.any(ring):
        return None
    body = float(np.median(gray[core])); floor = float(np.median(gray[ring]))
    contrast = abs(body-floor)
    if contrast < 10:
        return None
    # A body-like intensity band rejects bright walls/dark floor independently
    # of whether this session has light or dark animals.
    spread = max(5., float(np.percentile(np.abs(gray[core].astype(float)-body), 85)))
    # A bare tail can differ substantially from fur. Require local floor
    # contrast plus a thin connected appendage, rather than equal fur colour.
    similar = np.abs(gray.astype(float)-body) <= max(spread*3, contrast*.98)
    signed = (gray.astype(float)-floor)*np.sign(body-floor) >= max(4.,contrast*.08)
    foreground = (similar & signed).astype(np.uint8)
    if background is not None:
        # A pale animal can have a darker tail. Frozen image differences also
        # reject the unchanged floor grid that otherwise resembles a tail.
        reference=cv.resize(background,(frame.shape[1],frame.shape[0]))
        reference=cv.cvtColor(reference[top:bottom,left:right],cv.COLOR_BGR2GRAY)
        difference=gray.astype(float)-reference.astype(float)
        difference-=float(np.median(difference[ring]))
        changed=np.abs(difference)>=8
        foreground=np.uint8((mask>0)|(changed & (np.abs(gray.astype(float)-floor)>=4)))
    if floor_mask is not None:
        foreground &= ((floor_mask>0)|(mask>0)).astype(np.uint8)
    full_count, full_labels = cv.connectedComponents(foreground, connectivity=8)
    labels, counts = np.unique(full_labels[core], return_counts=True)
    choices = [(int(count), int(label)) for label, count in zip(labels, counts) if label]
    if not choices:
        return None
    selected = full_labels == max(choices)[1]
    body_dilation = cv.dilate(mask, np.ones((3, 3), np.uint8)) > 0
    outside = selected & ~body_dilation
    count, components, _, _ = cv.connectedComponentsWithStats(outside.astype(np.uint8), connectivity=8)
    from_body = cv.distanceTransform((mask == 0).astype(np.uint8), cv.DIST_L2, 3)
    thickness = cv.distanceTransform(selected.astype(np.uint8), cv.DIST_L2, 3)
    body_pixels = np.column_stack(np.nonzero(mask > 0))[:, ::-1]
    proposals = []
    for label in range(1, count):
        yy, xx = np.nonzero(components == label)
        if len(xx) < 4 or np.min(from_body[yy, xx]) > 3:
            continue
        if min(xx)<=1 or min(yy)<=1 or max(xx)>=gray.shape[1]-2 or max(yy)>=gray.shape[0]-2:
            continue
        extension = float(np.max(from_body[yy, xx]))
        if extension < max(5., radius*.8) or float(np.percentile(thickness[yy, xx], 70)) > radius*.45:
            continue
        at = int(np.argmin(from_body[yy, xx]))
        attachment = np.array([xx[at], yy[at]])
        root = body_pixels[np.argmin(np.sum((body_pixels-attachment)**2, axis=1))]
        far = int(np.argmax(from_body[yy, xx]))
        end = np.array([xx[far], yy[far]])
        root = (root+[left, top])/scale
        end = (end+[left, top])/scale
        a, b = coordinates(axis[0]), coordinates(axis[-1])
        length = max(1., np.linalg.norm(a-b))
        endpoint,other=(a,b) if np.linalg.norm(root-a)<np.linalg.norm(root-b) else (b,a)
        outward=(endpoint-other)/length
        # A paw, floor seam or shadow attached to the middle is not a tail.
        # Require attachment near one end and extension beyond that end.
        attachment=root-endpoint
        if (np.dot(attachment,outward)<-length*.25 or
                abs(attachment[0]*outward[1]-attachment[1]*outward[0])>max(4.,length*.3) or
                np.linalg.norm(end-root)>length*1.75 or
                np.dot(end-endpoint,outward)<max(4.,length*.15) or
                np.dot(end-root,outward)<np.linalg.norm(end-root)*.3):
            continue
        proposals.append((extension, root, end))
    proposals.sort(key=lambda p: p[0], reverse=True)
    if not proposals or len(proposals) > 1 and proposals[1][0] > proposals[0][0]*.7:
        return None
    _, root, tip = proposals[0]
    return root, tip


def head_location(contour, head, tail):
    """Locate the distal head on current body pixels after direction is known.

    Wall position never assigns anatomical direction. The robust torso axis
    intentionally excludes the neck; the head marker uses the full silhouette.
    """
    polygon=np.asarray([[p["x"],p["y"]] for p in contour],float)
    origin=np.floor(polygon.min(axis=0))
    size=np.ceil(polygon.max(axis=0)-origin).astype(int)+3
    if min(size)<3 or max(size)>4096:return head
    mask=np.zeros((size[1],size[0]),np.uint8)
    cv.fillPoly(mask,[np.rint(polygon-origin).astype(np.int32)],255)
    yy,xx=np.nonzero(cv.erode(mask,np.ones((3,3),np.uint8)))
    if len(xx)<9:return head
    pixels=np.column_stack([xx,yy])+origin
    direction=head-tail
    length=np.linalg.norm(direction)
    if length<1:return head
    projection=(pixels-tail)@(direction/length)
    selected=pixels[projection>=np.percentile(projection,90)]
    target=np.mean(selected,axis=0)
    return selected[np.argmin(np.sum((selected-target)**2,axis=1))]


def visual_descriptor(frame, sample, original_size, reference_length=None):
    """Same 208-D rotation/180-degree-invariant descriptor as the trained apex model."""
    box = sample.get("bbox")
    if not box or not sample.get("contour") or sample.get("source") != "segmented":
        return np.full(208, np.nan, np.float32)
    sx, sy = frame.shape[1]/original_size[0], frame.shape[0]/original_size[1]
    center = ((box["x"]+box["width"]/2)*sx, (box["y"]+box["height"]/2)*sy)
    side = (reference_length if reference_length is not None else max(box["width"], box["height"]))*sx*1.6
    angle = float((sample.get("features") or {}).get("axisRad") or 0.)
    if not np.isfinite(angle):
        angle = 0.
    transform = cv.getRotationMatrix2D(center, np.degrees(angle), 32/max(1., side))
    transform[:, 2] += (16-center[0], 16-center[1])
    crop = cv.warpAffine(frame, transform, (32, 32), borderMode=cv.BORDER_CONSTANT)
    gray = cv.cvtColor(crop, cv.COLOR_BGR2GRAY); inverse = cv.flip(gray, -1)
    hog = cv.HOGDescriptor((32, 32), (16, 16), (16, 16), (8, 8), 9)
    return np.concatenate([(hog.compute(gray).ravel()+hog.compute(inverse).ravel())/2,
                           ((cv.resize(gray, (8, 8)).astype(np.float32)+cv.resize(inverse, (8, 8)))/510.).ravel()]).astype(np.float32)


def finish_layers(root, video, config, model_directory=None, cancelled=lambda: False, ffmpeg=None, ffprobe=None):
    """Cache visual features separately; replacing classifier weights reuses them."""
    finalize_temporal_pose(root,video,config,cancelled)
    root = Path(root)
    samples_file = root/"samples.jsonl"
    rows = [json.loads(line) for line in samples_file.read_text(encoding="utf-8").splitlines()]
    model_available = model_directory and (Path(model_directory)/"manifest.json").is_file()
    cache = root/"layer_visual.npy"
    signature = dict(version=VERSION, samplesSha256=digest(samples_file), sourceSha256=digest(video),
                     descriptor="oft-apex-features-2-session-median-208")
    cache_manifest = root/"visual-stage.json"
    cached = False
    if cache.is_file() and cache_manifest.is_file():
        saved = json.loads(cache_manifest.read_text())
        cached = saved.get("identity") == signature and saved.get("sha256") == digest(cache)
    if model_available and not cached:
        from behavior.observation_quality import behavior_observation_quality
        lengths = [max(r["bbox"]["width"], r["bbox"]["height"]) for r in rows
                   if behavior_observation_quality(r) == "OBSERVED"]
        values = np.full((len(rows), 208), np.nan, np.float32)
        if lengths:
            reference = float(np.median(lengths))
            capture = open_video(video,ffmpeg,ffprobe)
            size = (min(640, config["width"]), round(config["height"]*min(640, config["width"])/config["width"]))
            try:
                for i, row in enumerate(rows):
                    if cancelled():
                        raise InterruptedError("Classificação cancelada")
                    ok, frame = capture.read()
                    if not ok:
                        raise ValueError("Vídeo terminou antes das camadas")
                    if row.get("reason") in {"researcher_intervention", "researcher_intervention_pending"}:
                        continue
                    frame = cv.resize(frame, size)
                    values[i] = visual_descriptor(frame, row, (config["width"], config["height"]), reference)
                if capture.read()[0]:
                    raise ValueError("Vídeo possui mais quadros que as camadas")
            finally:
                capture.release()
        temporary = cache.with_suffix(".partial.npy")
        np.save(temporary, values, allow_pickle=False); temporary.replace(cache)
        atomic_json(cache_manifest, dict(identity=signature, sha256=digest(cache)))
    elif not model_available and not cached:
        # Absence stays explicit. These NaNs are not cached as real descriptors.
        np.save(cache, np.full((len(rows), 208), np.nan, np.float32), allow_pickle=False)
        cache_manifest.unlink(missing_ok=True)
    return classify_rearing(root, model_directory, config)


def finalize_temporal_pose(root,video,config,cancelled=lambda:False):
    """Atomically refine display poses once, before cache hashes and exports.

    Video/config remain in the signature for callers shared with legacy runs;
    image-motion evidence was recorded during the forward pixel pass.
    """
    from temporal_pose import refine, VERSION as TEMPORAL_VERSION
    path=Path(root)/"samples.jsonl"
    with path.open(encoding="utf-8") as stream:
        first_line=next(stream,None)
    if first_line is None:return 0
    first=json.loads(first_line)
    visual=(first.get("oftLayers") or {}).get("visualization")
    if not visual or (visual.get("temporal") or {}).get("version")==TEMPORAL_VERSION:return 0
    rows=[json.loads(s) for s in path.read_text(encoding="utf-8").splitlines()]
    if video is not None:
        from temporal_pose.gap_recovery import recover
        recover(video,rows,(config["width"],config["height"]),cancelled)
    changed=refine(rows,cancelled)
    partial=path.with_name("samples.display.partial.jsonl")
    try:
        with partial.open("w",encoding="utf-8") as stream:
            for i,row in enumerate(rows):
                if i%128==0 and cancelled():raise InterruptedError("Refinamento temporal cancelado")
                stream.write(json.dumps(row,allow_nan=False)+"\n")
        partial.replace(path)
    finally:partial.unlink(missing_ok=True)
    return changed


class LayeredTracker:
    def __init__(self, width, height, arena=None, background=None):
        self.size = (width, height)
        self.arena = arena or {}
        self.background = background
        self.axis = BodyAxisFilter()
        self.previous = None
        self.pending = None
        self.stopped = False
        self.visual = VisualContinuity(width,height)

    def update(self, frame, sample):
        result=self.observe(frame,sample)
        visual=self.visual.update(frame,sample,result["orientation"])
        if visual["head"] and sample.get("contour") and sample.get("source")=="segmented":
            visual["head"]=point(head_location(sample["contour"],coordinates(visual["head"]),coordinates(visual["tailBase"])))
        result["visualization"]=visual
        result["temporalEvidence"]=self.visual.evidence
        return result

    def observe(self, frame, sample):
        stopped = sample.get("reason") == "researcher_intervention"
        self.stopped |= stopped
        axis = sample.get("bodyAxis") or self.axis.update(sample)
        result = dict(version=VERSION, orientation=dict(state="missing", reason="unobserved", head=None,
            tailBase=None, tailTip=None, headRegion="unknown", confidence=0., source=None, metricEligible=False),
            rearing=dict(classification="UNKNOWN", reviewStatus="pending", metricEligible=False))
        if self.stopped:
            self.previous = None
            result["orientation"]["reason"] = "researcher_intervention"
            return result
        path = axis.get("points") or []
        if not path or not sample.get("contour") or sample.get("source") != "segmented":
            self.previous = None
            self.pending = None
            result["orientation"].update(state="ambiguous" if sample.get("bbox") else "missing", reason=axis.get("reason", "no_axis"))
            return result
        timestamp = sample["timestampSec"]
        previous = self.previous if self.previous and 0 < timestamp-self.previous["time"] <= .75 else None
        evidence = tail_evidence(frame, sample["contour"], path, self.size, self.arena, self.background)
        a, b = coordinates(path[0]), coordinates(path[-1])
        tip = None
        if evidence is not None:
            root, tip = evidence
            head, tail = (b, a) if np.linalg.norm(a-root) < np.linalg.norm(b-root) else (a, b)
            # Preserve the current-image hypothesis before the preview's causal
            # hysteresis. The offline decoder must evaluate both directions.
            result["orientationEvidence"]=dict(source="tail_silhouette", head=point(head),
                tailBase=point(tail),tailTip=point(tip))
            source, confidence = "tail_silhouette", .75
            if previous and np.dot(head-tail, previous["direction"]) < 0:
                if self.pending is None:
                    self.pending = timestamp
                if timestamp-self.pending < .08-1e-6:
                    evidence = None
                else:
                    self.pending = None
            else:
                self.pending = None
        else:
            self.pending = None
        if evidence is None:
            if previous is None:
                result["orientation"].update(state="ambiguous", reason="head_tail_unresolved")
                return result
            head, tail = (a, b) if np.dot(a-b, previous["direction"]) >= 0 else (b, a)
            source, confidence = "temporal_estimate", .4
            tip = None
        # Only image-supported initialization refreshes the direction's age.
        anchor_time = timestamp if evidence is not None else previous["time"]
        self.previous = dict(time=anchor_time, direction=head-tail)
        head=head_location(sample["contour"],head,tail)
        floor=self.arena.get("cornersPx")
        head_region="unknown"
        if floor:
            polygon=np.array([[p["x"],p["y"]] for p in floor],np.float32)
            head_region="floor" if cv.pointPolygonTest(polygon,tuple(map(float,head)),False)>=0 else "wall_projection"
        result["orientation"].update(state="estimated", reason="orientation_pending_review", head=point(head),
            tailBase=point(tail), tailTip=point(tip) if tip is not None else None,
            headRegion=head_region, confidence=confidence, source=source)
        return result


def classify_rearing(root, model_directory=None, config=None):
    """Propose geometry episodes and cross-check optional learned apex scores.

    Scores remain separate and neither method creates confirmed annotations.
    Replacing classifier logic/weights never rewrites observed geometry.
    """
    from behavior.rearing_evidence import analyze
    from behavior.peak_model import features, load_model, predict_forest, proposals
    root = Path(root)
    rows = [json.loads(line) for line in (root/"samples.jsonl").read_text(encoding="utf-8").splitlines()]
    report, predictions = analyze(rows, config or {"protocol": "open_field"})
    report["evidenceState"] = report["state"]
    report["evidenceVersion"] = report.pop("version")
    report["version"] = VERSION
    report["model"] = None
    if model_directory and (Path(model_directory)/"manifest.json").is_file():
        manifest, model = load_model(model_directory)
        visual = np.load(root/"layer_visual.npy", allow_pickle=False)
        stop = (report.get("trackingTermination") or {}).get("timestampSec")
        matrix, usable, observed = features(rows, visual, stop)
        scores = predict_forest(model["rearing"], matrix)
        selected = proposals(rows, scores, usable, model["threshold"], model["minimumGapSec"])
        report["model"] = manifest
        report["state"] = "classified"
        for i in selected:
            evidence = predictions[i]
            if any(tag in str(rows[i].get("reason", "")) for tag in ("researcher_intervention", "camera_shift")):
                continue
            matching = next((c for c in report["candidates"] if c["startSec"]-.15 <= rows[i]["timestampSec"] <= c["endSec"]+.15), None)
            if matching is not None:
                matching.update(modelScore=float(scores[i]), source="geometry_and_model_candidate")
            else:
                report["candidates"].append(dict(evidence, frameIndex=rows[i]["frameIndex"], timestampSec=rows[i]["timestampSec"],
                    score=float(scores[i]), scoreKind="model_score", label="REARING_UNSPECIFIED",
                    classification="REARING_UNSPECIFIED",
                    observation="OBSERVED" if observed[i] else "UNCERTAIN", source="model_candidate"))
            evidence.update(classification="REARING_UNSPECIFIED", modelScore=float(scores[i]))
        report["message"] = "Propostas geométricas e do modelo de ápices, com checagem de postura; confirme no vídeo. Limites são estimados."
    report["candidates"].sort(key=lambda c: c["timestampSec"])
    atomic_json(root/"rearing_candidates.json", report)
    with (root/"rearing_predictions.jsonl").open("w", encoding="utf-8") as stream:
        for value in predictions:
            stream.write(json.dumps(value, allow_nan=False)+"\n")
    return report


def draw_overlay(frame, sample, prediction=None):
    """Shared visual semantics for CPU/Colab exports: geometry, hollow estimates."""
    from local_audit_video import AXIS, UNCERTAIN, accepted_body, head_triangle
    if sample.get("reason") in {"researcher_intervention", "researcher_intervention_pending"}:
        return frame
    color = tuple(bytes.fromhex(AXIS if accepted_body(sample) else UNCERTAIN))
    estimated_color = tuple(bytes.fromhex(UNCERTAIN))
    axis = sample.get("bodyAxis") or {}
    visual=(sample.get("oftLayers") or {}).get("visualization")
    points = visual["points"] if visual else axis.get("points") or []
    if visual and visual.get("source")!="observed_geometry":color=estimated_color
    if (visual or axis.get("state") == "reliable") and len(points) == 7:
        coordinates = np.asarray([[p["x"], p["y"]] for p in points], dtype=float)
        if np.isfinite(coordinates).all() and ((coordinates >= 0) & (coordinates < [frame.shape[1], frame.shape[0]])).all():
            nodes = np.rint(coordinates).astype(np.int32)
            cv.polylines(frame, [nodes], False, color, 2, cv.LINE_AA)
            radius = max(2, round(frame.shape[0] * .003))
            for x, y in nodes:
                cv.rectangle(frame, (x-radius, y-radius), (x+radius, y+radius), color, -1)
    orientation = (sample.get("oftLayers") or {}).get("orientation") or {}
    if visual:orientation=dict(state="estimated",head=visual.get("head"),tailBase=visual.get("tailBase"))
    if orientation.get("state") == "estimated" and orientation.get("head") and orientation.get("tailBase"):
        triangle=head_triangle(orientation["head"],orientation["tailBase"],max(4,frame.shape[0]*.007))
        if triangle:cv.polylines(frame,[np.rint(triangle).astype(np.int32)],True,estimated_color,1,cv.LINE_AA)
        p=orientation["tailBase"]
        cv.circle(frame,tuple(np.rint([p["x"],p["y"]]).astype(int)),max(2,round(frame.shape[0]*.003)),estimated_color,1,cv.LINE_AA)
    return frame
