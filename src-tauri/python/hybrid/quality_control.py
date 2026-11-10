"""Flags explícitas de qualidade para cada frame do pipeline híbrido."""


def frame_quality(detection, reference, floor_contains=None, occlusion_contains=None):
    flags = list(detection.get("qualityFlags", []))
    if not detection.get("observed"):
        flags.append("sem_bbox")
    x, y, likelihood = reference
    if x is None or y is None or likelihood is None or likelihood < .60:
        flags.append("centro_nao_confiavel")
    elif floor_contains is not None and not floor_contains((x, y)):
        flags.append("centro_fora_piso")
    if occlusion_contains is not None and x is not None and y is not None and occlusion_contains((x, y)):
        flags.append("oclusao")
    return sorted(set(flags))

