"""Filtro conservador do trajeto derivado do DeepLabCut adaptado (versão C)."""

import math
from statistics import median


POLICY = {
    "version": "dlc-adapted-trajectory-c-1",
    "windowFrames": 7,
    "minimumWindowSamples": 5,
    "minimumDeviationFraction": 0.04,
    "madMultiplier": 4.0,
    "smoothWeights": [0.25, 0.5, 0.25],
}


def postprocess_centers(centers, sources, frame_width, frame_height):
    """Retorna centros filtrados sem preencher lacunas nem alterar a entrada.

    Cada centro é (x, y, likelihood, status). Só observações detectadas e
    válidas participam do filtro. Recuperações continuam disponíveis para
    revisão, mas não servem como evidência para descartar ou suavizar pontos.
    """
    if len(centers) != len(sources):
        raise ValueError("Centros e origens têm comprimentos diferentes")
    result = list(centers)
    eligible = [source == "detected" and point[3] == "valid" and
                point[0] is not None and point[1] is not None
                for point, source in zip(centers, sources)]
    floor = POLICY["minimumDeviationFraction"] * min(frame_width, frame_height)
    half = POLICY["windowFrames"] // 2
    rejected = 0

    for index in range(2, len(centers) - 2):
        if not eligible[index]:
            continue
        start = index
        while start > max(0, index - half) and eligible[start - 1]:
            start -= 1
        end = index + 1
        while end < min(len(centers), index + half + 1) and eligible[end]:
            end += 1
        # Exige ao menos dois vizinhos em cada lado, sem atravessar lacunas.
        if index - start < 2 or end - index - 1 < 2 or end - start < POLICY["minimumWindowSamples"]:
            continue
        window_indices = range(start, end)
        neighbors = [centers[other] for other in window_indices if other != index]
        midpoint = (median(point[0] for point in neighbors), median(point[1] for point in neighbors))
        deviations = [math.dist(point[:2], midpoint) for point in neighbors]
        typical = median(deviations)
        mad = median(abs(value - typical) for value in deviations)
        limit = max(floor, typical + POLICY["madMultiplier"] * 1.4826 * mad)
        previous, following = centers[index - 1], centers[index + 1]
        # Exige retorno próximo à trajetória local: uma mudança sustentada
        # de posição não é tratada como um ponto isolado.
        if (math.dist(centers[index][:2], midpoint) > limit and
                math.dist(previous[:2], following[:2]) <= limit):
            result[index] = (*centers[index][:3], "jump")
            rejected += 1

    observed = [eligible[index] and result[index][3] == "valid" for index in range(len(result))]
    smoothed = 0
    for index in range(1, len(result) - 1):
        if not all(observed[other] for other in (index - 1, index, index + 1)):
            continue
        before, current, after = (centers[other] for other in (index - 1, index, index + 1))
        if max(math.dist(before[:2], current[:2]), math.dist(current[:2], after[:2])) > floor:
            continue
        weights = POLICY["smoothWeights"]
        x = sum(point[0] * weight for point, weight in zip((before, current, after), weights))
        y = sum(point[1] * weight for point, weight in zip((before, current, after), weights))
        result[index] = (x, y, current[2], current[3])
        smoothed += 1
    return result, {"rejectedStatistical": rejected, "smoothedFrames": smoothed,
                    "validDetectedFrames": sum(observed)}
