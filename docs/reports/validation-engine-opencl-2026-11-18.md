# Benchmark sequencial CPU e OpenCL

Status: `TECHNICAL_BENCHMARK_NOT_ACCURACY_VALIDATION`.

Repetições medidas por braço: 2; aquecimentos: 1.
Dispositivo OpenCL: `{"active": true, "gpuTypeMask": 4, "name": "Iris Pro", "type": 4, "vendor": "Intel"}`.

| Gravação | Versão | OpenCL solicitado | Backend efetivo | Tempo mediano (s) | FPS mediano | CPU média (%) | RSS simultâneo amostrado (MiB) | Válidos (%) | Incertos |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| oft_01 | head | cpu | não registrado | 24.54 | 311.8 | 228.5 | 148.0 | 50.4 | 1520 |
| oft_01 | head | opencl | não registrado | 22.57 | 338.8 | 234.6 | 147.7 | 50.4 | 1520 |
| oft_01 | current | cpu | CPU | 18.45 | 412.5 | 268.9 | 156.6 | 50.4 | 1520 |
| oft_01 | current | opencl | OpenCL parcial | 34.93 | 217.9 | 166.1 | 164.2 | 50.4 | 1520 |
| oft_02 | head | cpu | não registrado | 25.25 | 175.8 | 264.0 | 196.1 | 0.0 | 4438 |
| oft_02 | head | opencl | não registrado | 25.00 | 177.6 | 265.1 | 197.4 | 0.0 | 4438 |
| oft_02 | current | cpu | CPU | 21.60 | 205.5 | 242.9 | 210.2 | 0.0 | 4438 |
| oft_02 | current | opencl | OpenCL parcial | 32.69 | 135.9 | 164.4 | 217.1 | 0.0 | 4438 |
| oft_03 | head | cpu | não registrado | 58.69 | 125.3 | 315.8 | 232.9 | 90.9 | 356 |
| oft_03 | head | opencl | não registrado | 57.69 | 127.5 | 318.5 | 233.3 | 90.9 | 356 |
| oft_03 | current | cpu | CPU | 46.90 | 156.9 | 305.8 | 246.8 | 90.9 | 356 |
| oft_03 | current | opencl | OpenCL parcial | 67.35 | 109.2 | 203.2 | 246.9 | 90.9 | 356 |

## Proveniência e configuração

Commit HEAD: `63ff5091f55a85d68e3ff93dc0e1efb38fbcdc7c`.
Motor `head` SHA-256: `798684e65c1591138d36b66a14032685b63f29328ad2e34223a22e57be4c7a76`.
Motor `current` SHA-256: `fe3549cb9bad4487485e639f1c35ac10eb32f3aca96ee56d1349ff6d90c5c29c`.

### oft_01

Vídeo `openfield01.mp4` SHA-256: `67f3e8eba5c1af4f192d8f226a37f286e6998f962d306306d8c9ff678d05aa5a`.
Configuração SHA-256: `59168294eb86c88443cbbef748f01d3e39ae04014410773767f93260672d5251`.
Parâmetros: `{"arena": {"boundaryPolicy": "center_inclusive", "centerAreaFraction": 0.25, "cornersPx": [{"x": 134.3214133673904, "y": 69.74882928905919}, {"x": 439.4725415070243, "y": 79.33929331630483}, {"x": 429.8820774797787, "y": 408.0306513409962}, {"x": 127.34653043848442, "y": 408.0306513409962}], "heightCm": 40, "revision": 1, "rimCornersPx": [{"x": 110.78118348233288, "y": 41.84929757343551}, {"x": 476.9625372498936, "y": 58.414644529587065}, {"x": 463.0127713920818, "y": 448.1362281822052}, {"x": 106.42188165176668, "y": 443.77692635163896}], "widthCm": 50}, "backgroundFrameIndex": null, "height": 480, "initialBox": null, "maxAreaFraction": 0.12, "maxPredictionSec": 0.25, "maxWidth": 1280, "minAreaFraction": 0.001, "mode": "light", "referenceApproved": false, "seed": null, "threshold": 210, "width": 586}`.
Frames processados: 7610.

Perfil OpenCL solicitado=False: P95 por frame 5.123922950588167 ms; etapas (s) `{"camera_guard": 3.8479404121171683, "frame_read_wait": 3.5810823132051155, "probe": 0.1989765859907493, "serialization": 0.39158571866573766, "status_write": 0.36315147118875757, "tracking": 8.804975420061965}`; cobertura observada válida=50.367936925098554%; incertos=1520; ausentes=2257; contagens `{"manual": 0, "missing": 2257, "observed": 5099, "predicted": 254, "suspect": 1520, "visual": 0}`.
Perfil OpenCL solicitado=True: P95 por frame 8.267795026767999 ms; etapas (s) `{"camera_guard": 6.030838969047181, "frame_read_wait": 3.876804834813811, "probe": 0.3250836100196466, "serialization": 0.3811694033211097, "status_write": 0.385506373597309, "tracking": 21.27801917132456}`; cobertura observada válida=50.367936925098554%; incertos=1520; ausentes=2257; contagens `{"manual": 0, "missing": 2257, "observed": 5099, "predicted": 254, "suspect": 1520, "visual": 0}`.

Comparação `head_vs_current` repetição 1: 0 estados alterados, 0 de 5353 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 3833 alterados, máximo 0.0 px.
Comparação `opencl_vs_cpu` repetição 1: 0 estados alterados, 0 de 5353 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 3833 alterados, máximo 0.0 px.
Comparação `head_vs_current` repetição 2: 0 estados alterados, 0 de 5353 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 3833 alterados, máximo 0.0 px.
Comparação `opencl_vs_cpu` repetição 2: 0 estados alterados, 0 de 5353 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 3833 alterados, máximo 0.0 px.
Comparação `head_vs_current` repetição 1: 0 estados alterados, 0 de 5353 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 3833 alterados, máximo 0.0 px.
Comparação `head_vs_current` repetição 2: 0 estados alterados, 0 de 5353 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 3833 alterados, máximo 0.0 px.

### oft_02

Vídeo `openfield02.mp4` SHA-256: `e8cd0c3a5624a4342346fcf56a328e8a86419cf058d27cccf1bea1a6141e51c4`.
Configuração SHA-256: `20b43d2750d1d853655666a51a2fe2091e65f450cec6b692a0513ecb7503de55`.
Parâmetros: `{"arena": {"boundaryPolicy": "center_inclusive", "centerAreaFraction": 0.25, "cornersPx": [{"x": 230.29118773946368, "y": 166.08939974457215}, {"x": 580.779054916986, "y": 172.62835249042146}, {"x": 570.3167305236271, "y": 528.3473818646232}, {"x": 218.52107279693496, "y": 515.2694763729247}], "heightCm": 40, "revision": 1, "rimCornersPx": [{"x": 166.20945083014055, "y": 98.0842911877395}, {"x": 626.551724137931, "y": 113.77777777777784}, {"x": 614.7816091954024, "y": 575.4278416347382}, {"x": 150.51596424010222, "y": 551.8876117496807}], "widthCm": 50}, "backgroundFrameIndex": null, "height": 720, "initialBox": null, "maxAreaFraction": 0.12, "maxPredictionSec": 0.25, "maxWidth": 1280, "minAreaFraction": 0.001, "mode": "light", "referenceApproved": false, "seed": null, "threshold": 95, "width": 900}`.
Frames processados: 4438.

Perfil OpenCL solicitado=False: P95 por frame 8.410962007474154 ms; etapas (s) `{"camera_guard": 3.073382632166613, "frame_read_wait": 5.775714738178067, "probe": 0.1989470959524624, "serialization": 0.32150632253615186, "status_write": 0.21249351324513555, "tracking": 10.72020843718201}`; cobertura observada válida=0.0%; incertos=4438; ausentes=0; contagens `{"manual": 0, "missing": 0, "observed": 4436, "predicted": 2, "suspect": 4438, "visual": 0}`.
Perfil OpenCL solicitado=True: P95 por frame 12.877024011686444 ms; etapas (s) `{"camera_guard": 4.933047620230354, "frame_read_wait": 6.298882770759519, "probe": 0.2614551080041565, "serialization": 0.3285552092711441, "status_write": 0.22275800461648032, "tracking": 19.87529274210101}`; cobertura observada válida=0.0%; incertos=4438; ausentes=0; contagens `{"manual": 0, "missing": 0, "observed": 4436, "predicted": 2, "suspect": 4438, "visual": 0}`.

Comparação `head_vs_current` repetição 1: 0 estados alterados, 0 de 4438 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 0 alterados, máximo 0.0 px.
Comparação `opencl_vs_cpu` repetição 1: 0 estados alterados, 0 de 4438 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 0 alterados, máximo 0.0 px.
Comparação `head_vs_current` repetição 2: 0 estados alterados, 0 de 4438 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 0 alterados, máximo 0.0 px.
Comparação `opencl_vs_cpu` repetição 2: 0 estados alterados, 0 de 4438 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 0 alterados, máximo 0.0 px.
Comparação `head_vs_current` repetição 1: 0 estados alterados, 0 de 4438 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 0 alterados, máximo 0.0 px.
Comparação `head_vs_current` repetição 2: 0 estados alterados, 0 de 4438 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 0 alterados, máximo 0.0 px.

### oft_03

Vídeo `4daed623-b4c3-49d1-a742-bd381e4699cb.mp4` SHA-256: `53f45629b5c6545ad29b03c5b6e9383e7bf2fd53ac657ea7f0af8a4d2afa9ef0`.
Configuração SHA-256: `20cdaf6d5cc9285820c1f05da2ad266b6e4baa7bf27ff1e727d5731ea3f3f58e`.
Parâmetros: `{"arena": {"boundaryPolicy": "center_inclusive", "centerAreaFraction": 0.25, "cornersPx": [{"x": 323.67816091954023, "y": 22.886334610472545}, {"x": 915.4533844189018, "y": 11.443167305236216}, {"x": 897.471264367816, "y": 560.7151979565773}, {"x": 366.1813537675607, "y": 555.8109833971902}], "heightCm": 40, "revision": 1, "rimCornersPx": [{"x": 223.95913154533844, "y": 47.407407407407504}, {"x": 979.2081736909324, "y": 24.52107279693496}, {"x": 946.513409961686, "y": 698.0332056194127}, {"x": 290.9833971902938, "y": 698.0332056194127}], "widthCm": 50}, "backgroundFrameIndex": null, "height": 720, "initialBox": null, "maxAreaFraction": 0.12, "maxPredictionSec": 0.25, "maxWidth": 1280, "minAreaFraction": 0.001, "mode": "light", "referenceApproved": false, "threshold": 190, "width": 1280}`.
Frames processados: 7356.

Perfil OpenCL solicitado=False: P95 por frame 12.080904038157314 ms; etapas (s) `{"camera_guard": 7.511138723348267, "frame_read_wait": 15.664622761658393, "probe": 0.23172823403729126, "serialization": 0.39056819264078513, "status_write": 0.41395575663773343, "tracking": 21.38569275185}`; cobertura observada válida=90.94616639477977%; incertos=356; ausentes=310; contagens `{"manual": 0, "missing": 310, "observed": 6898, "predicted": 148, "suspect": 356, "visual": 0}`.
Perfil OpenCL solicitado=True: P95 por frame 16.161432024091482 ms; etapas (s) `{"camera_guard": 10.02129295031773, "frame_read_wait": 14.428206170792691, "probe": 0.24051525996765122, "serialization": 0.3633326625567861, "status_write": 0.36545713781379163, "tracking": 38.045424673415255}`; cobertura observada válida=90.94616639477977%; incertos=356; ausentes=310; contagens `{"manual": 0, "missing": 310, "observed": 6898, "predicted": 148, "suspect": 356, "visual": 0}`.

Comparação `head_vs_current` repetição 1: 0 estados alterados, 0 de 7046 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 6690 alterados, máximo 0.0 px.
Comparação `opencl_vs_cpu` repetição 1: 0 estados alterados, 62 de 7046 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 52.501 px; entre válidos, 49 de 6690 alterados, máximo 3.5 px.
Comparação `head_vs_current` repetição 2: 0 estados alterados, 0 de 7046 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 0.000 px; entre válidos, 0 de 6690 alterados, máximo 0.0 px.
Comparação `opencl_vs_cpu` repetição 2: 0 estados alterados, 62 de 7046 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 52.501 px; entre válidos, 49 de 6690 alterados, máximo 3.5 px.
Comparação `head_vs_current` repetição 1: 0 estados alterados, 62 de 7046 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 52.501 px; entre válidos, 49 de 6690 alterados, máximo 3.5 px.
Comparação `head_vs_current` repetição 2: 0 estados alterados, 62 de 7046 coordenadas pareadas alteradas, 0 mudanças de presença, diferença máxima 52.501 px; entre válidos, 49 de 6690 alterados, máximo 3.5 px.

CPU mean is total process CPU seconds divided by wall seconds; max sampled CPU is the highest ps %cpu snapshot (a time-averaged process metric, not an instantaneous peak). Simultaneous RSS is sampled from the ps process tree every 0.2 s. Timing comparisons use benchmarkProfile disabled in both versions. Separate current-engine profile runs supply P95 frame latency and stages; frame read wait overlaps FFmpeg decode. HEAD has no internal profiler.

OpenCL requested is not proof of GPU use; inspect computeBackend and openclDevice. The HEAD engine does not report computeBackend. Two measured repeats per arm on one computer do not establish general speedup; background load and thermal state were not controlled. Coordinates and coverage are technical outputs, not anatomical accuracy. No human ground truth or Colab inference is used.
