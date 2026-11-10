"""Contexto 2D da caixa e conversão de poses; não é um classificador de rearing."""

import math
from itertools import combinations


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def polygon_points(points, width, height):
    if not isinstance(points, list) or len(points) != 4:
        raise ValueError("A área deve ter quatro vértices")
    result = [(float(point["x"]), float(point["y"])) for point in points]
    if any(not math.isfinite(x) or not math.isfinite(y) or x < 0 or x > width or y < 0 or y > height
           for x, y in result):
        raise ValueError("Vértice fora da resolução do vídeo")
    turns = [cross(result[i], result[(i + 1) % 4], result[(i + 2) % 4]) for i in range(4)]
    area = abs(sum(result[i][0] * result[(i + 1) % 4][1] - result[(i + 1) % 4][0] * result[i][1]
                   for i in range(4))) / 2
    if area < 100 or not (all(value > 0 for value in turns) or all(value < 0 for value in turns)):
        raise ValueError("Área degenerada ou quadrilátero cruzado")
    return result


def convex_hull(points):
    ordered = sorted(set(points))
    def half(sequence):
        result = []
        for point in sequence:
            while len(result) >= 2 and cross(result[-2], result[-1], point) <= 0:
                result.pop()
            result.append(point)
        return result
    return half(ordered)[:-1] + half(reversed(ordered))[:-1]


def prepare_geometry(arena, width, height):
    if width <= 0 or height <= 0:
        raise ValueError("O vídeo não informou dimensões válidas")
    if arena and (arena.get("videoWidth", width) != width or arena.get("videoHeight", height) != height):
        raise ValueError("A resolução do vídeo é diferente da usada para marcar borda e chão; refaça a calibração")
    floor = polygon_points(arena["cornersPx"], width, height) if arena else []
    rim = polygon_points(arena["rimCornersPx"], width, height) if arena and arena.get("rimCornersPx") else []
    hull = convex_hull(floor + rim) if rim else []
    crop = None
    if rim:
        # A união preserva paredes mesmo quando chão e aro não são aninhados em perspectiva.
        xs, ys = zip(*(floor + rim))
        margin_x, margin_y = (max(xs) - min(xs)) * .05, (max(ys) - min(ys)) * .05
        crop = [max(0, math.floor(min(xs) - margin_x)), min(width, math.ceil(max(xs) + margin_x)),
                max(0, math.floor(min(ys) - margin_y)), min(height, math.ceil(max(ys) + margin_y))]
    return {"schemaVersion": 1, "poseAdapterVersion": "superanimal-canonical-2",
            "arenaRevision": arena.get("revision") if arena else None,
            "videoWidth": width, "videoHeight": height, "floorCornersPx": floor,
            "rimCornersPx": rim, "enclosureHullPx": hull, "cropping": crop,
            "marginFraction": .05, "outputCoordinateSpace": "original_video_pixels",
            "postureClassification": "not_performed", "occludedPoints": "not_imputed"}


def contains(point, polygon):
    if len(polygon) < 3:
        return False
    turns = [cross(polygon[i], polygon[(i + 1) % len(polygon)], point) for i in range(len(polygon))]
    return all(value >= -1e-7 for value in turns) or all(value <= 1e-7 for value in turns)


def spatial_region(x, y, geometry):
    if x is None or y is None:
        return "unknown"
    if contains((x, y), geometry["floorCornersPx"]):
        return "floor"
    if not geometry["enclosureHullPx"]:
        return "unknown"
    return "wall_projection" if contains((x, y), geometry["enclosureHullPx"]) else "outside"


def restore_point(x, y, likelihood, geometry):
    try:
        x, y, score = float(x), float(y), float(likelihood)
    except (ValueError, TypeError):
        return None, None, 0.0, "missing"
    if not math.isfinite(score) or not 0 <= score <= 1:
        return None, None, 0.0, "missing"
    crop = geometry["cropping"] or [0, geometry["videoWidth"], 0, geometry["videoHeight"]]
    if not math.isfinite(x) or not math.isfinite(y) or x < 0 or y < 0 or x >= crop[1] - crop[0] or y >= crop[3] - crop[2] or score < .1:
        return None, None, score, "missing"
    return x + crop[0], y + crop[2], score, "low_confidence" if score < .6 else "valid"


def reliable_torso_points(points, max_span=None):
    visible = [point for point in points if point[0] is not None and point[1] is not None
               and point[3] == "valid" and point[2] >= .6]
    if not visible:
        return []
    if max_span is not None and len(visible) >= 2:
        groups = [group for size in range(2, len(visible) + 1)
                  for group in combinations(visible, size)
                  if all(math.dist(a[:2], b[:2]) <= max_span for a, b in combinations(group, 2))]
        if groups:
            visible = list(max(groups, key=lambda group: (len(group), sum(point[2] for point in group))))
        else:
            return []
    return visible


def torso_center(points, max_span=None):
    visible = reliable_torso_points(points, max_span)
    if not visible:
        return None, None, 0.0, "missing"
    count = len(visible)
    x, y, score = (sum(point[index] for point in visible) / count for index in range(3))
    # Dois pontos de tronco confiáveis bastam; um ponto sozinho pede revisão.
    status = "valid" if count >= 2 else "low_confidence"
    return x, y, score, status
