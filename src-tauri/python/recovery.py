"""Segunda passagem visual com ROI temporal. Não reconstrói anatomia ocluída.

Política conservadora versionada; thresholds não representam acurácia validada.
Importações de ML são tardias para permitir testes sem GPU e reutilizar o runtime.
"""

import math
import statistics
import time

POLICY = {"version": "visual-recovery-2", "minScore": .6, "minAnchors": 3,
          "maxHistorySec": .75, "marginBodyLengths": .8,
          "maxDisplacementBodyLengths": 1.5,
          "minTorsoSupport": 2, "maxAttempts": 1200, "maxRetryFraction": .15,
          "maxRecoveryWallSec": 60, "decoder": "sequential",
          "metricEligibility": "detected_valid_or_manually_confirmed"}


def reliable(point):
    return (point is not None and len(point) >= 3 and all(math.isfinite(v) for v in point[:3])
            and point[0] >= 0 and point[1] >= 0 and POLICY["minScore"] <= point[2] <= 1)


def anchors(points):
    # A cauda distal aumenta artificialmente o tamanho da caixa.
    return {name: point for name, point in points.items() if reliable(point)
            and ("tail" not in name or name in ("tail_base", "tailbase", "tail_root"))}


def needs_recovery(points):
    torso = [point for name, point in points.items()
             if any(token in name for token in ("spine", "body", "center", "centre", "shoulder", "hip", "back"))
             and not any(token in name for token in ("tail", "paw", "ear", "nose", "snout"))]
    # Orelha/cauda pouco confiáveis não justificam executar o modelo novamente.
    if torso:
        return sum(reliable(point) for point in torso) < min(POLICY["minTorsoSupport"], len(torso))
    return len(anchors(points)) < POLICY["minAnchors"]


def bounding_box(points, width, height):
    values = list(anchors(points).values())
    if len(values) < POLICY["minAnchors"]:
        return None
    xs, ys = [p[0] for p in values], [p[1] for p in values]
    span = max(max(xs) - min(xs), max(ys) - min(ys), min(width, height) * .025)
    margin = POLICY["marginBodyLengths"] * span
    x0, y0 = max(0, min(xs) - margin), max(0, min(ys) - margin)
    x1, y1 = min(width, max(xs) + margin), min(height, max(ys) + margin)
    return (x0, y0, x1 - x0, y1 - y0)


def compatible(candidate, previous, bbox):
    good = anchors(candidate)
    if len(good) < POLICY["minAnchors"]:
        return False
    x, y, width, height = bbox
    if any(not (x <= p[0] <= x + width and y <= p[1] <= y + height) for p in good.values()):
        return False
    common = [(p, previous[name]) for name, p in good.items() if reliable(previous.get(name))]
    if len(common) < 2:
        return False
    displacement = statistics.median(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in common)
    body_span = max(width, height) / (1 + 2 * POLICY["marginBodyLengths"])
    return displacement <= body_span * POLICY["maxDisplacementBodyLengths"]


class VisualRecovery:
    """Um pose runner carregado uma única vez por execução; pesos já em cache."""

    def __init__(self, video, geometry):
        self.video, self.geometry = video, geometry
        self.capture = self.runner = None
        self.disabled_reason = None
        self.attempted = self.accepted = 0
        self.skipped_budget = 0
        self._started = None
        self._next_frame = 0
        self.attempt_limit = POLICY["maxAttempts"]

    def _prepare(self):
        import cv2
        import torch
        from deeplabcut.pose_estimation_pytorch.apis.utils import get_pose_inference_runner
        from deeplabcut.pose_estimation_pytorch.modelzoo.utils import get_super_animal_snapshot_path
        from deeplabcut.pose_estimation_pytorch.config.pose import PoseConfig

        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        builder = getattr(PoseConfig, "build_for_superanimal_inference", None)
        if builder:
            config = builder(super_animal="superanimal_topviewmouse", model_name="hrnet_w32",
                             detector_name="fasterrcnn_resnet50_fpn_v2", max_individuals=1, device=device)
        else:
            from deeplabcut.pose_estimation_pytorch.modelzoo.utils import load_super_animal_config
            config = load_super_animal_config("superanimal_topviewmouse", "hrnet_w32",
                                             "fasterrcnn_resnet50_fpn_v2", max_individuals=1, device=device)
        snapshot = get_super_animal_snapshot_path("superanimal_topviewmouse", "hrnet_w32", download=False)
        self.names = [str(name).lower().replace("-", "_").replace(" ", "_")
                      for name in config["metadata"]["bodyparts"]]
        self.runner = get_pose_inference_runner(config, snapshot, batch_size=1, device=device, max_individuals=1)
        self.capture = cv2.VideoCapture(self.video)

    def retry(self, frame_index, previous, crop_width, crop_height):
        bbox = bounding_box(previous, crop_width, crop_height)
        if bbox is None or self.disabled_reason:
            return {}
        if self._started is None:
            self._started = time.monotonic()
        if self.attempted >= self.attempt_limit or time.monotonic() - self._started >= POLICY["maxRecoveryWallSec"]:
            self.skipped_budget += 1
            return {}
        self.attempted += 1
        try:
            if self.runner is None:
                self._prepare()
            import cv2
            import numpy as np
            # Avança o decoder uma única vez: não busca um keyframe para cada tentativa.
            if frame_index < self._next_frame:
                raise RuntimeError("Frames fora de ordem na recuperação sequencial")
            while self._next_frame < frame_index:
                if not self.capture.grab():
                    return {}
                self._next_frame += 1
            ok, image = self.capture.read()
            self._next_frame += 1
            if not ok:
                return {}
            crop = self.geometry["cropping"]
            if crop:
                image = image[crop[2]:crop[3], crop[0]:crop[1]]
            # O runner recebe RGB e bboxes xywh no espaço da imagem recortada.
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            output = self.runner.inference(images=[(image, {"bboxes": np.array([bbox], dtype=float),
                                                           "bbox_scores": np.array([1.0])})])
            data = output[0]["bodyparts"]
            if data.shape != (1, len(self.names), 3):
                raise RuntimeError("Contrato de saída do pose runner incompatível")
            candidate = {name: tuple(float(v) for v in point) for name, point in zip(self.names, data[0])}
            if compatible(candidate, previous, bbox):
                self.accepted += 1
                return candidate
        except Exception as error:
            # Não interrompe a análise nem omite a indisponibilidade desta segunda passagem.
            self.disabled_reason = f"{type(error).__name__}: {error}"
            print("BEHAVETRACKER_RECOVERY_UNAVAILABLE=" + self.disabled_reason, flush=True)
        return {}

    def close(self):
        if self.capture is not None:
            self.capture.release()
        self.capture = self.runner = None


def recover_frames(frames, fps, geometry, retry, report=print):
    """Retorna medições novas + originais. Nunca interpola lacunas longas.

    A história só avança com evidência visual, nunca com previsão cinemática.
    Frames são mapeamentos de todos os pontos do modelo em pixels do crop.
    """
    crop = geometry["cropping"] or [0, geometry["videoWidth"], 0, geometry["videoHeight"]]
    width, height = crop[1] - crop[0], crop[3] - crop[2]
    previous, last_visual = None, -math.inf
    for index, raw in enumerate(frames):
        points, recovered = dict(raw), set()
        if previous and index / fps - last_visual <= POLICY["maxHistorySec"]:
            # Também tenta recuperar pontos parciais; nunca substitui um ponto original confiável.
            if needs_recovery(raw):
                candidate = retry(index, previous, width, height)
                for name, point in candidate.items():
                    if name in raw and reliable(point) and not reliable(raw[name]):
                        points[name] = point
                        recovered.add(name)
        if len(anchors(points)) >= POLICY["minAnchors"]:
            previous, last_visual = points, index / fps
        if index and index % max(1, round(fps * 10)) == 0:
            report(f"BEHAVETRACKER_RECOVERY_PROGRESS={index + 1}/{len(frames)}")
        yield points, recovered
