# Comparação pareada de filtros de pose

Status: `COMPARISON_ONLY_NOT_VALIDATED`.

Pose SHA-256: `774023b5725c9d268ab0ecae3d9dc75f979187e07c85911ed24353a64c6d369c`.
Vídeo SHA-256: `não informado`.
Referência SHA-256: `ausente`.
Anotador selecionado: `nenhum`.

Parâmetros: `{"beta": 0.01, "changedFromRawThresholdPx": 0.01, "largeStepThresholdPx": 15.0, "likelihoodThreshold": 0.6, "maxGapSec": 0.25, "minCutoffHz": 1.0}`.
Versões: `{"fcMedian": "wistar-fc-keypoint-median-1", "oneEuro": "one-euro-keypoint-1"}`.

Frames aprovados pareados: 0.

MAE is mean Euclidean point error; RMSE is root mean squared Euclidean point error; PCK thresholds Euclidean point distance. These metrics use only shared frames with visible, explicitly approved human annotations tied to the asserted video SHA-256 and matching frame timestamps. The pose CSV does not carry a video SHA-256, so its video provenance must be verified separately. PCK thresholds of 5 and 10 px are absolute and not anatomy-normalized. Second difference, large steps and displacement are descriptive proxies, not anatomical error. Changed coordinates are not verified corrections. Large steps can be real movement. Internal gaps exclude missing frames before the first and after the last valid frame. Distances are not directly comparable when frame coverage differs. Real temporal event error requires separately approved event onset labels.

| Animal | Ponto | Variante | Cobertura (%) | Lacunas internas | 2ª diferença (px) | MAE humano (px) | RMSE humano (px) | PCK@5 (%) | PCK@10 (%) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| animal_1 | head_midpoint | raw | 1.93 | 63 | 2.35 | — | — | — | — |
| animal_1 | head_midpoint | fcMedian | 1.20 | 17 | 0.55 | — | — | — | — |
| animal_1 | head_midpoint | oneEuro | 1.93 | 63 | 0.35 | — | — | — | — |
| animal_1 | left_ear | raw | 6.54 | 185 | 3.40 | — | — | — | — |
| animal_1 | left_ear | fcMedian | 4.43 | 65 | 0.82 | — | — | — | — |
| animal_1 | left_ear | oneEuro | 6.54 | 185 | 0.56 | — | — | — | — |
| animal_1 | left_ear_tip | raw | 2.18 | 90 | 2.88 | — | — | — | — |
| animal_1 | left_ear_tip | fcMedian | 1.01 | 16 | 0.56 | — | — | — | — |
| animal_1 | left_ear_tip | oneEuro | 2.18 | 90 | 0.51 | — | — | — | — |
| animal_1 | left_eye | raw | 2.00 | 70 | 2.61 | — | — | — | — |
| animal_1 | left_eye | fcMedian | 1.17 | 19 | 0.79 | — | — | — | — |
| animal_1 | left_eye | oneEuro | 2.00 | 70 | 0.39 | — | — | — | — |
| animal_1 | left_hip | raw | 9.37 | 217 | 3.17 | — | — | — | — |
| animal_1 | left_hip | fcMedian | 7.21 | 89 | 0.74 | — | — | — | — |
| animal_1 | left_hip | oneEuro | 9.37 | 217 | 0.47 | — | — | — | — |
| animal_1 | left_midside | raw | 6.78 | 202 | 3.21 | — | — | — | — |
| animal_1 | left_midside | fcMedian | 4.70 | 79 | 0.76 | — | — | — | — |
| animal_1 | left_midside | oneEuro | 6.78 | 202 | 0.55 | — | — | — | — |
| animal_1 | left_shoulder | raw | 0.32 | 12 | 1.19 | — | — | — | — |
| animal_1 | left_shoulder | fcMedian | 0.16 | 3 | 0.34 | — | — | — | — |
| animal_1 | left_shoulder | oneEuro | 0.32 | 12 | 0.18 | — | — | — | — |
| animal_1 | mid_back | raw | 3.09 | 109 | 2.99 | — | — | — | — |
| animal_1 | mid_back | fcMedian | 1.92 | 35 | 0.80 | — | — | — | — |
| animal_1 | mid_back | oneEuro | 3.09 | 109 | 0.47 | — | — | — | — |
| animal_1 | mid_backend | raw | 6.37 | 157 | 2.99 | — | — | — | — |
| animal_1 | mid_backend | fcMedian | 4.65 | 58 | 0.79 | — | — | — | — |
| animal_1 | mid_backend | oneEuro | 6.37 | 157 | 0.49 | — | — | — | — |
| animal_1 | mid_backend2 | raw | 5.22 | 119 | 2.59 | — | — | — | — |
| animal_1 | mid_backend2 | fcMedian | 4.11 | 55 | 0.74 | — | — | — | — |
| animal_1 | mid_backend2 | oneEuro | 5.22 | 119 | 0.46 | — | — | — | — |
| animal_1 | mid_backend3 | raw | 4.30 | 130 | 2.17 | — | — | — | — |
| animal_1 | mid_backend3 | fcMedian | 2.90 | 46 | 0.56 | — | — | — | — |
| animal_1 | mid_backend3 | oneEuro | 4.30 | 130 | 0.39 | — | — | — | — |
| animal_1 | mouse_center | raw | 12.12 | 260 | 3.31 | — | — | — | — |
| animal_1 | mouse_center | fcMedian | 9.65 | 113 | 0.86 | — | — | — | — |
| animal_1 | mouse_center | oneEuro | 12.12 | 260 | 0.57 | — | — | — | — |
| animal_1 | neck | raw | 2.37 | 77 | 2.39 | — | — | — | — |
| animal_1 | neck | fcMedian | 1.46 | 23 | 0.63 | — | — | — | — |
| animal_1 | neck | oneEuro | 2.37 | 77 | 0.49 | — | — | — | — |
| animal_1 | nose | raw | 8.11 | 236 | 2.70 | — | — | — | — |
| animal_1 | nose | fcMedian | 5.73 | 90 | 1.01 | — | — | — | — |
| animal_1 | nose | oneEuro | 8.11 | 236 | 0.63 | — | — | — | — |
| animal_1 | right_ear | raw | 5.10 | 196 | 3.18 | — | — | — | — |
| animal_1 | right_ear | fcMedian | 2.71 | 57 | 0.42 | — | — | — | — |
| animal_1 | right_ear | oneEuro | 5.10 | 196 | 0.49 | — | — | — | — |
| animal_1 | right_ear_tip | raw | 1.16 | 61 | 7.13 | — | — | — | — |
| animal_1 | right_ear_tip | fcMedian | 0.35 | 10 | 1.08 | — | — | — | — |
| animal_1 | right_ear_tip | oneEuro | 1.16 | 61 | 1.20 | — | — | — | — |
| animal_1 | right_eye | raw | 2.09 | 75 | 2.25 | — | — | — | — |
| animal_1 | right_eye | fcMedian | 1.21 | 23 | 0.63 | — | — | — | — |
| animal_1 | right_eye | oneEuro | 2.09 | 75 | 0.41 | — | — | — | — |
| animal_1 | right_hip | raw | 10.04 | 215 | 3.20 | — | — | — | — |
| animal_1 | right_hip | fcMedian | 7.91 | 84 | 0.77 | — | — | — | — |
| animal_1 | right_hip | oneEuro | 10.04 | 215 | 0.51 | — | — | — | — |
| animal_1 | right_midside | raw | 10.14 | 226 | 3.79 | — | — | — | — |
| animal_1 | right_midside | fcMedian | 7.88 | 93 | 0.98 | — | — | — | — |
| animal_1 | right_midside | oneEuro | 10.14 | 226 | 0.65 | — | — | — | — |
| animal_1 | right_shoulder | raw | 0.78 | 38 | 2.67 | — | — | — | — |
| animal_1 | right_shoulder | fcMedian | 0.29 | 4 | 0.28 | — | — | — | — |
| animal_1 | right_shoulder | oneEuro | 0.78 | 38 | 0.43 | — | — | — | — |
| animal_1 | tail1 | raw | 22.05 | 521 | 3.13 | — | — | — | — |
| animal_1 | tail1 | fcMedian | 17.24 | 242 | 0.90 | — | — | — | — |
| animal_1 | tail1 | oneEuro | 22.05 | 521 | 0.60 | — | — | — | — |
| animal_1 | tail2 | raw | 10.57 | 310 | 3.21 | — | — | — | — |
| animal_1 | tail2 | fcMedian | 7.36 | 117 | 0.72 | — | — | — | — |
| animal_1 | tail2 | oneEuro | 10.57 | 310 | 0.56 | — | — | — | — |
| animal_1 | tail3 | raw | 15.89 | 324 | 2.91 | — | — | — | — |
| animal_1 | tail3 | fcMedian | 12.92 | 152 | 0.67 | — | — | — | — |
| animal_1 | tail3 | oneEuro | 15.89 | 324 | 0.51 | — | — | — | — |
| animal_1 | tail4 | raw | 0.38 | 18 | 4.34 | — | — | — | — |
| animal_1 | tail4 | fcMedian | 0.14 | 4 | 2.15 | — | — | — | — |
| animal_1 | tail4 | oneEuro | 0.38 | 18 | 1.20 | — | — | — | — |
| animal_1 | tail5 | raw | 0.35 | 14 | 1.45 | — | — | — | — |
| animal_1 | tail5 | fcMedian | 0.18 | 7 | 0.90 | — | — | — | — |
| animal_1 | tail5 | oneEuro | 0.35 | 14 | 0.58 | — | — | — | — |
| animal_1 | tail_base | raw | 53.82 | 671 | 2.45 | — | — | — | — |
| animal_1 | tail_base | fcMedian | 49.08 | 381 | 0.82 | — | — | — | — |
| animal_1 | tail_base | oneEuro | 53.82 | 671 | 0.47 | — | — | — | — |
| animal_1 | tail_end | raw | 56.64 | 752 | 2.96 | — | — | — | — |
| animal_1 | tail_end | fcMedian | 51.34 | 462 | 1.15 | — | — | — | — |
| animal_1 | tail_end | oneEuro | 56.64 | 752 | 0.74 | — | — | — | — |
