"""Behavior evidence is independent of floor-metric eligibility."""
import math

INVALID_REASONS = {"camera_shift", "ambiguous_candidates", "silhouette_clipped", "identity_pending",
                   "reacquisition_pending", "no_contour", "outside_floor_candidate"}


def behavior_observation_quality(sample):
    box = sample.get("bbox")
    if sample.get("source") == "predicted" or sample.get("status") in {"missing", "out_of_arena"} or not box:
        return "UNOBSERVED"
    if any(not isinstance(box.get(k), (int, float)) or not math.isfinite(box[k]) for k in ("x", "y", "width", "height")) or min(box["width"], box["height"]) <= 0:
        return "UNOBSERVED"
    quality = sample.get("localQuality") or {}
    reasons = set(quality.get("reasons", [])) | {sample.get("reason")}
    if reasons & INVALID_REASONS or sample.get("source") in {"recovered", "manual"}:
        return "UNCERTAIN"
    if sample.get("trackingAccepted") is True and sample.get("source") == "segmented":
        return "OBSERVED"
    # Posture/appearance candidates remain available to the visual model and annotation,
    # but never become accepted observations merely because a network scores them highly.
    return "UNCERTAIN"


def crop_observation_quality(observation, crop_available, crop_usable):
    """Pixels recovered for context never change an unobserved frame into evidence."""
    if not crop_available:
        return "UNOBSERVED"
    if observation == "OBSERVED" and not crop_usable:
        return "UNCERTAIN"
    return observation
