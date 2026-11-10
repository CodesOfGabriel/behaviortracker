"""Triagem conservadora de candidatos a rearing; não é classificação automática."""


def candidates(frames, min_duration_sec=.20, min_vertical_fraction=.20):
    """Agrupa frames com postura potencialmente vertical em candidatos revisáveis.

    Cada frame deve fornecer ``timestampSec``, ``bbox`` e ``pose``. O resultado
    só sugere intervalos; nunca marca um episódio como confirmado.
    """
    if min_duration_sec <= 0 or not 0 < min_vertical_fraction < 1:
        raise ValueError("Parâmetros de triagem inválidos")
    active = []
    result = []
    for frame in frames:
        bbox = frame.get("bbox")
        pose = frame.get("pose") or {}
        if not bbox or not pose.get("head") or not pose.get("base"):
            active.append(None)
            continue
        head_y = pose["head"][1]
        base_y = pose["base"][1]
        height = bbox.get("height", 0)
        possible = height > 0 and abs(base_y - head_y) / height >= min_vertical_fraction
        active.append(frame if possible else None)
    start = None
    for index, frame in enumerate(active + [None]):
        if frame is not None and start is None:
            start = index
        if frame is None and start is not None:
            segment = [item for item in active[start:index] if item is not None]
            if segment and segment[-1]["timestampSec"] - segment[0]["timestampSec"] >= min_duration_sec:
                result.append({"candidateId": f"rearing-{len(result) + 1}",
                               "startSec": segment[0]["timestampSec"],
                               "endSec": segment[-1]["timestampSec"],
                               "status": "needs_review"})
            start = None
    return result

