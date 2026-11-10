"""Filtro F+C reversível por keypoint, sem interpolação de lacunas."""

from statistics import median


POLICY = {
    "version": "wistar-fc-keypoint-median-1",
    "likelihoodThreshold": .60,
    "windowFrames": 5,
    "minimumWindowSamples": 3,
}


def filter_keypoint(samples, likelihood_threshold=.60):
    """Filtra uma série de (x, y, likelihood), preservando os valores raw.

    Frames inelegíveis recebem None na camada filtrada e nunca são preenchidos.
    """
    if likelihood_threshold != POLICY["likelihoodThreshold"]:
        if not 0 <= likelihood_threshold <= 1:
            raise ValueError("Threshold de likelihood inválido")
    result = []
    half = POLICY["windowFrames"] // 2
    for index, sample in enumerate(samples):
        x, y, likelihood = sample
        eligible = (x is not None and y is not None and
                    likelihood is not None and likelihood >= likelihood_threshold)
        if not eligible:
            result.append(None)
            continue
        start = max(0, index - half)
        end = min(len(samples), index + half + 1)
        neighbors = []
        for candidate in samples[start:end]:
            cx, cy, score = candidate
            if cx is not None and cy is not None and score is not None and score >= likelihood_threshold:
                neighbors.append((cx, cy))
        if len(neighbors) < POLICY["minimumWindowSamples"]:
            result.append(None)
            continue
        result.append((median(point[0] for point in neighbors),
                       median(point[1] for point in neighbors), likelihood))
    return result

