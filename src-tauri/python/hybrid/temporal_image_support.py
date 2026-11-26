"""Check uncertain neural image tracks against independent bidirectional LK.

Coordinates are never interpolated or held. Each uncertain candidate must agree
with motion measured in the two actual adjacent images, rooted at a valid query.
"""
import cv2
import numpy as np

POLICY = {"version": "temporal-image-support-1", "maxForwardBackwardErrorPx": 1.,
          "maxTrackerFlowDisagreementPx": 2., "maxPatchError": 20.,
          "coordinateSpace": "384x512_model_images", "metricEligible": False}


def flow_support(images, tracks, visible, queries):
    tracks, visible, queries = np.asarray(tracks, float), np.asarray(visible, bool), np.asarray(queries, float)
    count = len(images)
    if (tracks.ndim != 3 or tracks.shape[0] != count or tracks.shape[-1] != 2
            or visible.shape != tracks.shape[:2] or queries.shape != (tracks.shape[1], 3)
            or not np.isfinite(queries).all() or (queries[:, 0] != np.floor(queries[:, 0])).any()
            or (queries[:, 0] < 0).any() or (queries[:, 0] >= count).any()):
        raise ValueError("Trajetória incompatível com as imagens para conferência de movimento")
    result = np.zeros(visible.shape, bool)
    if not count:
        return result
    height, width = images[0].shape
    if any(image.dtype != np.uint8 or image.shape != (height, width) for image in images):
        raise ValueError("Imagens temporais devem ser cinza uint8 com resolução constante")
    finite = np.isfinite(tracks).all(axis=2)
    inside = (finite & (tracks[:, :, 0] >= 0) & (tracks[:, :, 0] < width)
              & (tracks[:, :, 1] >= 0) & (tracks[:, :, 1] < height))
    times = queries[:, 0].astype(int)
    for joint, time in enumerate(times):
        if inside[time, joint] and np.linalg.norm(tracks[time, joint]-queries[joint, 1:]) <= 1.:
            # The accepted query/carried image anchor starts the chain. This is
            # separately identified as validated_anchor, not a measured LK pair.
            result[time, joint] = not visible[time, joint]
    parameters = dict(winSize=(21, 21), maxLevel=3,
                      criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, .01))
    for frame in range(1, count):
        active = np.flatnonzero((frame > times) & inside[frame-1] & inside[frame]
                                & (visible[frame-1] | result[frame-1]) & ~visible[frame])
        if not len(active):
            continue
        previous = tracks[frame-1, active].astype(np.float32).reshape(-1, 1, 2)
        forward, ok, error = cv2.calcOpticalFlowPyrLK(images[frame-1], images[frame], previous, None, **parameters)
        if forward is None or ok is None or error is None:
            continue
        valid = np.flatnonzero(ok.reshape(-1).astype(bool) & np.isfinite(forward).all(axis=(1, 2))
                               & np.isfinite(error.reshape(-1)) & (error.reshape(-1) <= POLICY["maxPatchError"]))
        if not len(valid):
            continue
        backward, back_ok, _ = cv2.calcOpticalFlowPyrLK(images[frame], images[frame-1], forward[valid], None, **parameters)
        if backward is None or back_ok is None:
            continue
        fb = np.linalg.norm(backward[:, 0]-previous[valid, 0], axis=1)
        agreement = np.linalg.norm(forward[valid, 0]-tracks[frame, active[valid]], axis=1)
        supported = (back_ok.reshape(-1).astype(bool) & np.isfinite(fb) & np.isfinite(agreement)
                     & (fb <= POLICY["maxForwardBackwardErrorPx"])
                     & (agreement <= POLICY["maxTrackerFlowDisagreementPx"]))
        result[frame, active[valid[supported]]] = True
    return result
