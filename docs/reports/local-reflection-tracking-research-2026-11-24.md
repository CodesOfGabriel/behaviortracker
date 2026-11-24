# Rastreamento local com reflexos: pesquisa e decisões

Consulta às fontes primárias em 24/11/2026. Escopo: vídeo existente de um animal, câmera fixa, processamento em CPU no macOS Intel. Esta revisão cobre as principais famílias de soluções; a lista de bibliotecas não representa uma comparação experimental entre todas elas.

## O que outros projetos fazem

| Família / referência | Técnica útil | Limite para este caso |
| --- | --- | --- |
| [ezTrack](https://github.com/denisecailab/ezTrack) e [guia dos autores](https://www.denisecailab.com/s/2021_ezTrack-A-step-by-step-guide-to-behavior-tracking.pdf) | Fundo fixo, diferença de imagem e janela ponderada pela posição anterior. | Uma janela pode acompanhar um reflexo se a inicialização estiver errada. |
| [AnimalTA](https://besjournals.onlinelibrary.wiley.com/doi/full/10.1111/2041-210X.14115) | Segmentação adaptativa ou subtração de fundo, estabilização, arenas e correção de fundo. | Mediana temporal pode conter o animal quando ele permanece muito tempo no mesmo lugar. |
| [idtracker.ai: segmentação](https://www.idtracker.ai/latest/user_guide/segmentation_app.html) e [condições de vídeo](https://www.idtracker.ai/6.0.0/good_videos/video_conditions.html) | Inspeção de blobs, limites de tamanho e ROIs; identifica reflexos nas paredes como fonte de falsas detecções. | Reidentificação não substitui segmentação correta. Uma imagem refletida ainda pode parecer o mesmo indivíduo. |
| [TRex](https://trex.run/docs/tutorials.html) e [parâmetros](https://trex.run/docs/parameters_trex.html) | Fundo ou detector neural, filtros de tamanho, limites de velocidade e encerramento de tracklets pouco confiáveis. | Modelos genéricos precisam de adaptação ao animal e à cena. Taxas publicadas em outros cenários não medem este notebook. |
| [ToxTrac, artigo dos autores](https://arxiv.org/abs/1706.02577) | Rastreamento local de organismos e identificação. | Trocar o programa inteiro não demonstra que o reflexo específico será resolvido. Não foi instalado nem comparado aqui. |
| [OpenCV: Lucas–Kanade](https://docs.opencv.org/4.13.0/d4/dee/tutorial_optical_flow.html) | Pontos visuais acompanhados em pirâmides; verificação adicional de ida e volta permite rejeitar correspondências inconsistentes. | Fluxo visual pode acompanhar o reflexo, e perde suporte em superfícies sem textura ou oclusões. Serve como guia. |
| [OpenCV: CSRT](https://docs.opencv.org/4.13.0/db/d55/classcv_1_1TrackerCSRT-members.html) | Rastreador de objeto inicializado por caixa, com máscara inicial opcional. | A instalação mínima atual não contém CSRT. Seria necessário OpenCV contrib; uma caixa inicial errada também o compromete. |
| [OpenCV: GrabCut](https://docs.opencv.org/4.5.3/d8/d83/tutorial_py_grabcut.html) | Refinamento interativo com região do objeto e marcações de primeiro plano/fundo. | Refinar uma região ajuda a silhueta, mas requer sementes corretas; não resolve identidade sozinho. Não foi integrado nesta mudança. |
| [OpenCV Zoo: VitTrack](https://github.com/opencv/opencv_zoo/tree/main/models/object_tracking_vittrack) e [NanoTrack](https://github.com/HonglinChu/SiamTrackers/tree/master/NanoTrack) | Rastreadores neurais pequenos, utilizáveis por OpenCV DNN sem PyTorch no fluxo de inferência. | VitTrack foi testado neste vídeo e apresentou deriva/expansão da caixa. NanoTrack não foi executado. |
| [ByteTrack](https://github.com/FoundationVision/ByteTrack) | Associação de detecções fortes e fracas para reduzir interrupções. | Requer detector capaz de distinguir candidatos. Confiança baixa de um reflexo não o torna um animal verdadeiro. |
| [BoT-SORT](https://github.com/NirAharon/BoT-SORT) e [Norfair](https://github.com/tryolabs/norfair) | Combinação de movimento, aparência, distâncias personalizadas e compensação de câmera. | São mecanismos de associação, não detectores especializados de corpo/reflexo. Para um animal, uma associação pequena e auditável evita dependências desnecessárias. |
| [PyTracking: ATOM/DiMP/KeepTrack](https://github.com/visionml/pytracking) | Tratamento de distratores, atualização condicionada e reidentificação. | Pesos e dependências adicionais; não foram executados neste Mac. A distinção entre alvo, distrator e perda orienta as salvaguardas locais. |
| [DeepLabCut Live](https://github.com/DeepLabCut/DeepLabCut-live) e [limitações da GUI](https://deeplabcut.github.io/DeepLabCut/docs/dlc-live/dlc-live-gui/index.html) | Pose anatômica com modelo exportado, integração com câmera e processamento online. | Modelo apropriado e compatibilidade de backend são necessários; desempenho em CPU pode ser limitante. O fluxo Wistar/HRNet existente continua separado. |
| [SLEAP-NN](https://nn.sleap.ai/latest/help/faq/) | Pose supervisionada, CPU e exportação ONNX/TensorRT. | Precisa de exemplos anotados e avaliação independente. Disponibilidade de CPU não garante execução em tempo real. |
| [SAM 2](https://github.com/facebookresearch/sam2) | Segmentação de vídeo guiada por prompts, com memória temporal. | O custo e a operação em CPU precisam de medição própria. Não foi instalado nem apresentado como solução em tempo real neste hardware. |
| [ONNX Runtime](https://onnxruntime.ai/docs/execution-providers/) | Execução local de modelos exportados com provedores diferentes. | A arquitetura, os operadores e o sistema operacional precisam ser compatíveis; o runtime não melhora o modelo por si só. |
| [OpenVINO, notas oficiais](https://github.com/openvinotoolkit/openvino/releases) | Otimização de inferência para hardware compatível. | O suporte a macOS x86 foi encerrado em 2026.0. Não é uma boa dependência padrão para este Mac Intel. |

## Decisão implementada

O `opencv-box-9` mantém a arquitetura local leve e implementa uma associação própria, sem incorporar código desses projetos:

1. Referência mediana congelada e estimativa de ruído por pixel; compensação de variações globais de iluminação.
2. Diferença de luminância **e** cromaticidade Lab. O limiar cromático usa sua própria escala e ruído: o mesmo limiar numérico da luminância omitia partes claras do corpo sobre piso claro.
3. Abertura morfológica para remover estruturas finas antes da seleção, reduzindo cauda e pontes entre corpo e reflexo. A caixa não é artificialmente ampliada.
4. Associação por sobreposição da silhueta com o piso, área, densidade, aparência e continuidade. Um candidato sem apoio suficiente no piso fica incerto; não recebe um rótulo semântico de “reflexo confirmado”.
5. Aparência medida pela mediana do núcleo, privilegiando pixels sobre o piso; área de referência baseada em histórico de observações aceitas. Isso reduz a influência de uma primeira caixa fragmentada.
6. Lucas–Kanade com verificação de ida e volta, consenso entre pontos e validade temporal curta. O fluxo orienta a escolha de contorno; não gera uma observação científica sozinho.
7. Identificação inicial e recuperação exigem consenso. Candidatos rejeitados não corrigem Kalman, aparência ou área. Uma indicação corporal opcional no primeiro frame restringe a busca; sua sobreposição é verificada nos dois sentidos para impedir que um fragmento pequeno satisfaça a caixa inteira.
8. Geometria e localização continuam separadas: corpo localizado perto da parede pode permanecer visível para revisão enquanto a posição no piso continua incerta.

Na interface, a indicação inicial reutiliza o editor de caixas existente. A referência de interação é o próprio `BoxOverlay`, mantendo desenho, movimentação e redimensionamento em coordenadas do original. A opção fica em uma seção expansível no diálogo local.

## Experimento com VitTrack

Modelo oficial `object_tracking_vittrack_2023sep.onnx`, 714.726 bytes, SHA-256 `2990f0b7cd44d92afa48cd97db6de7be113fc1d9594fddb74e2725c10478e91d`, licença Apache-2.0. O arquivo foi baixado para uma pasta temporária e seu hash conferido com o ponteiro LFS oficial. Não foi adicionado ao instalador.

Uma caixa de diagnóstico ajustada visualmente ao corpo no primeiro frame foi usada somente nesse teste, sem tratá-la como anotação humana independente. Foram executados 2.400 frames a 640 px, OpenCV 4.13, CPU e duas threads. A rodada levou aproximadamente 38,87 s, concorrendo com outro diagnóstico. O rastreador expandiu a caixa para grande parte da arena e manteve scores moderados. A inspeção dos frames 100, 500 e 1.000 mostrou que o score não assegurava localização corporal. Esse teste rejeita esta configuração como solução padrão; não é um benchmark de precisão do modelo em geral.

## Como interpretar a comparação

A avaliação local usa o vídeo e a arena do experimento informado, os 7.356 frames com PTS originais e processamento a 640 px. A comparação numérica e o hash do código ficam em `benchmark-dd2-reflections-2026-11-24.json`. As estatísticas de observações aceitas e alertas são indicadores do algoritmo, **não porcentagens de acerto**.

O vídeo foi usado no diagnóstico e ajuste, portanto não é um conjunto independente de validação. IoU, erro de centro, trocas por reflexo e duração de perdas exigem caixas aprovadas por revisores humanos. A fila de revisão mantém essas caixas vazias. Persistem riscos em rearing, oclusões, corpo unido ao reflexo, enquadramento cortado e fundo estimado com ocupação prolongada. Uma máscara do piso não determina o ponto anatômico de contato.

Para medir a próxima melhoria, revisar frames distribuídos e trechos contínuos com reflexos/perdas; manter gravações separadas para avaliação; se necessário treinar um detector/segmentador pequeno com exemplos positivos de corpo e negativos de reflexo/cauda. ONNX/OpenCV DNN pode hospedar esse modelo depois de aferir precisão e latência no hardware de destino. Este trabalho não cria rótulos humanos nem treina um modelo a partir das próprias previsões.
