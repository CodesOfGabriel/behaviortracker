"""Offline noncausal windows with explicit padding and observation masks."""
import numpy as np


def windows(matrix, observed, size=31, batch_size=32):
    if size % 2 != 1:
        raise ValueError("An odd temporal window is required")
    radius = size//2
    padded = np.pad(matrix, ((radius, radius), (0, 0)))
    validity = np.pad(np.asarray(observed, np.float32), (radius, radius))
    for start in range(0, len(matrix), batch_size):
        stop = min(len(matrix), start+batch_size)
        yield start, np.stack([np.concatenate((padded[i:i+size], validity[i:i+size, None]), axis=1).T for i in range(start, stop)]).astype(np.float32)
