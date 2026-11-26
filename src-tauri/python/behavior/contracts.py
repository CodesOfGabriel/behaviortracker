"""Versioned inputs shared by dataset building and local inference."""
import math

SCHEMA = "oft-behavior-features-1"
POSTURES = ("NON_REARING", "REARING_SUPPORTED", "REARING_UNSUPPORTED", "REARING_UNSPECIFIED", "UNKNOWN")
FEATURES = (
    "silhouette_area", "silhouette_perimeter", "major_axis_length", "minor_axis_length",
    "eccentricity", "circularity", "solidity", "extent", "oriented_aspect_ratio",
    "body_axis_length", "body_axis_curvature", "body_axis_tortuosity", "body_width_mean",
    "body_width_std", *(f"body_width_{i}" for i in range(7)), "centroid_velocity",
    "centroid_acceleration", "optical_flow_mean", "optical_flow_p90", "internal_motion",
    "relative_area_change", "relative_length_change", "relative_width_change",
    "distance_to_wall", "wall_overlap_fraction", "tracking_accepted", "silhouette_observed",
)
DECODER = dict(onsetThreshold=.75, offsetThreshold=.4, minimumDurationSec=.2,
               minimumOnsetConfirmationSec=.13, minimumOffsetConfirmationSec=.13,
               maximumMergeGapSec=.15, maximumUnobservedGapSec=.15, subtypeThreshold=.8)


def validate_decoder(config):
    result = {**DECODER, **config}
    if set(result) != set(DECODER) or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in result.values()):
        raise ValueError("Invalid decoder configuration")
    if not 0 <= result["offsetThreshold"] < result["onsetThreshold"] <= 1 or not .5 < result["subtypeThreshold"] <= 1:
        raise ValueError("Invalid decoder thresholds")
    if any(not 0 <= result[key] <= 5 for key in result if key.endswith("Sec")):
        raise ValueError("Invalid decoder durations")
    return result


def vector(features, normalization):
    """Missing features are zero only alongside an explicit validity mask."""
    values, valid = [], []
    for key, mean, std in zip(FEATURES, normalization["mean"], normalization["std"]):
        value = features.get(key)
        usable = isinstance(value, (int, float)) and math.isfinite(value)
        values.append((value-mean)/std if usable else 0.)
        valid.append(float(usable))
    return values + valid
