"""Only the training partition may fit normalization parameters."""
import numpy as np
from .contracts import FEATURES, SCHEMA


def fit_training(rows):
    matrix = np.asarray([[r.get(k, np.nan) for k in FEATURES] for r in rows], dtype=float)
    matrix[~np.isfinite(matrix)] = np.nan
    means, scales = [], []
    for column in matrix.T:
        usable = column[np.isfinite(column)]
        means.append(float(usable.mean()) if len(usable) else 0.)
        scales.append(max(float(usable.std()), 1e-6) if len(usable) else 1.)
    return dict(schemaVersion=SCHEMA, features=list(FEATURES), mean=means, std=scales, fittedOn="train")


def validate(value):
    if value.get("features") != list(FEATURES) or value.get("schemaVersion") != SCHEMA or value.get("fittedOn") != "train":
        raise ValueError("Normalization feature contract mismatch")
    if len(value.get("mean", [])) != len(FEATURES) or len(value.get("std", [])) != len(FEATURES):
        raise ValueError("Normalization dimension mismatch")
    if not np.isfinite(value["mean"]).all() or not np.isfinite(value["std"]).all() or min(value["std"]) <= 0:
        raise ValueError("Invalid normalization")
    return value
