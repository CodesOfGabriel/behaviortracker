"""Filtro 1€ experimental para séries 2D; não altera observações originais.

Implementação independente das equações de Casiez, Roussel e Vogel (CHI 2012).
As frequências de corte são parâmetros de comparação, não valores validados
para anatomia de roedores.
"""

import math


VERSION = "one-euro-keypoint-1"


def _alpha(elapsed, cutoff):
    return 1.0 / (1.0 + 1.0 / (2.0 * math.pi * cutoff * elapsed))


class OneEuro2D:
    def __init__(self, min_cutoff=1.0, beta=0.001, derivative_cutoff=1.0, max_gap_sec=0.25):
        if any(not math.isfinite(value) for value in (min_cutoff, beta, derivative_cutoff, max_gap_sec)):
            raise ValueError("Parâmetros do filtro devem ser finitos")
        if min_cutoff <= 0 or beta < 0 or derivative_cutoff <= 0 or max_gap_sec <= 0:
            raise ValueError("Frequências e lacuna devem ser positivas; beta não pode ser negativo")
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.derivative_cutoff = derivative_cutoff
        self.max_gap_sec = max_gap_sec
        self.reset()

    def reset(self):
        self.timestamp = None
        self.position = None
        self.derivative = (0.0, 0.0)

    def update(self, timestamp, x, y):
        if not all(math.isfinite(value) for value in (timestamp, x, y)):
            raise ValueError("Tempo e coordenadas devem ser finitos")
        if self.timestamp is not None and timestamp <= self.timestamp:
            raise ValueError("Timestamps devem crescer estritamente")
        if self.timestamp is None or timestamp - self.timestamp > self.max_gap_sec:
            self.timestamp = timestamp
            self.position = (x, y)
            self.derivative = (0.0, 0.0)
            return self.position
        elapsed = timestamp - self.timestamp
        derivative_alpha = _alpha(elapsed, self.derivative_cutoff)
        derivative = tuple(
            derivative_alpha * ((value - previous) / elapsed) + (1.0 - derivative_alpha) * previous_derivative
            for value, previous, previous_derivative in zip((x, y), self.position, self.derivative)
        )
        position = []
        for value, previous, speed in zip((x, y), self.position, derivative):
            weight = _alpha(elapsed, self.min_cutoff + self.beta * abs(speed))
            position.append(weight * value + (1.0 - weight) * previous)
        position = tuple(position)
        self.timestamp, self.position, self.derivative = timestamp, position, derivative
        return position


def filter_keypoint(samples, timestamps, statuses=None, likelihood_threshold=0.60, **parameters):
    """Retorna uma camada filtrada; lacunas/baixa confiança reiniciam o estado.

    Cada amostra é (x, y, likelihood). O resultado contém tuplas equivalentes
    ou None. A entrada permanece intacta e nenhum frame é interpolado.
    """
    if len(samples) != len(timestamps) or (statuses is not None and len(statuses) != len(samples)):
        raise ValueError("Séries e timestamps devem ter o mesmo tamanho")
    if not math.isfinite(likelihood_threshold) or not 0 <= likelihood_threshold <= 1:
        raise ValueError("Threshold de confiança inválido")
    tracker = OneEuro2D(**parameters)
    result = []
    previous_time = None
    for index, (sample, timestamp) in enumerate(zip(samples, timestamps)):
        if not math.isfinite(timestamp) or (previous_time is not None and timestamp <= previous_time):
            raise ValueError("Timestamps devem ser finitos e crescentes")
        previous_time = timestamp
        x, y, confidence = sample
        eligible = (statuses is None or statuses[index] == "valid") and all(
            value is not None and math.isfinite(value) for value in (x, y, confidence)
        ) and confidence >= likelihood_threshold
        if not eligible:
            tracker.reset()
            result.append(None)
            continue
        filtered = tracker.update(timestamp, x, y)
        result.append((filtered[0], filtered[1], confidence))
    return result
