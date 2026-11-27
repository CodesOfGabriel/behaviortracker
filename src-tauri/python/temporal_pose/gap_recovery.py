"""Recover short missing display paths from future image pixels, not a template."""
import cv2 as cv
import numpy as np


def recover(video, rows, size, cancelled=lambda: False):
    from oft_continuity import VisualContinuity
    from layer_video import capture
    groups = []
    start = None
    stopped = False
    for i, row in enumerate(rows):
        stopped |= row.get("reason") == "researcher_intervention"
        v = row.get("oftLayers", {}).get("visualization") or {}
        allowed = not stopped and row.get("reason") not in {
            "researcher_intervention_pending", "occluded", "animal_removed", "camera_shift"}
        missing = allowed and (v.get("state") == "unavailable" or v.get("source") == "held_estimate")
        if missing and start is None:
            start = i
        if not missing and start is not None:
            # The future anchor must be visible in current foreground, within
            # 750 ms and without a clock discontinuity or intervention.
            if allowed and v.get("source") in {"observed_geometry", "current_silhouette"} and row["timestampSec"]-rows[start]["timestampSec"] <= .75:
                if all(0 < rows[j+1]["timestampSec"]-rows[j]["timestampSec"] <= .25 for j in range(start, i)):
                    groups.append((start, i))
            start = None
    if not groups:
        return 0
    cap = capture(video)
    count = 0
    try:
        for start, anchor in groups:
            tracker = VisualContinuity(*size)
            origin = rows[anchor]["timestampSec"]
            for i in range(anchor, start-1, -1):
                if cancelled():
                    raise InterruptedError("Recuperação temporal cancelada")
                if not cap.set(cv.CAP_PROP_POS_FRAMES, i):
                    raise ValueError("Quadro futuro indisponível para recuperação")
                ok, frame = cap.read()
                if not ok:
                    raise ValueError("Vídeo interrompido durante recuperação temporal")
                row = rows[i]
                sample = {**row, "timestampSec": origin-row["timestampSec"]}
                if i == anchor:
                    # Reuse the future silhouette, without borrowing its label.
                    sample = {**sample, "bodyAxis": {"state": "reliable", "points": row["oftLayers"]["visualization"]["points"]}}
                visual = tracker.update(frame, sample, {"state": "ambiguous"})
                matrix = tracker.evidence.get("flowMatrix")
                if i != anchor and visual["source"] == "optical_flow" and matrix is not None:
                    row["oftLayers"]["visualization"] = visual
                    # The backwards matrix transports i+1 -> i. Store its
                    # inverse where the decoder expects forward image motion.
                    target = rows[i+1]["oftLayers"].setdefault("temporalEvidence", {})
                    if target.get("flowMatrix") is None:
                        target["flowMatrix"] = cv.invertAffineTransform(np.array(matrix, float)).tolist()
                    count += 1
    finally:
        cap.release()
    return count
