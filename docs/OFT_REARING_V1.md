# Campo Aberto · rearing local V1

A implementação acrescenta uma camada comportamental independente do tracking OpenCV. O manifesto incluído está explicitamente **sem treinamento**. Não há pesos de rearing, precisão medida nem resultados científicos produzidos por esta alteração. Os checkpoints Wistar/HRNet existentes são detectores/pose e não substituem um classificador supervisionado de rearing.

## Uso no aplicativo

**Resultados → Rearing → Anotar vídeo → Abrir estúdio de anotação** abre o estúdio com vídeo original, timestamps, caixa, eixo geométrico, marcação por frame, intervalos humanos e histórico persistente. Veja [o protocolo de anotação](OFT_REARING_ANNOTATION_PROTOCOL.md).

**Detecção automática** prepara um ambiente CPU separado e instala um bundle exportado. Sem pesos treinados a ação permanece indisponível. A anotação humana funciona com o ambiente OpenCV existente, sem ONNX ou PyTorch. O classificador pode reutilizar um tracking concluído; sua falha não altera o tracking nem a locomoção.

**Resultados e revisão** seleciona uma execução comportamental desse tracking, apresenta cobertura, episódios, duração e latência, permite confirmar/rejeitar/corrigir episódios e exporta dados automáticos, revisados e proveniência separadamente. A seleção fica salva por tracking e hash do vídeo e também alimenta o resumo do experimento. Correções que sobreponham rearings são rejeitadas para não duplicar contagens/duração. Confirmar episódios não equivale a revisar todos os negativos da sessão.

## Extração e contratos

- Rastreamento continua com a política anterior de métricas no piso. `behaviorObservation` distingue `OBSERVED`, `UNCERTAIN` e `UNOBSERVED`, incluindo paredes observáveis. Área/aparência rejeitadas continuam como candidatas, sem promover previsões ou reflexos a observações confirmadas.
- A segunda passagem decodifica sequencialmente o vídeo original via FFmpeg e verifica os PTS via FFprobe contra cada frame salvo. Nenhum relógio é calculado com `frame_index / fps`.
- Recorte quadrado RGB 128 px, escala de sessão = mediana do maior lado das caixas aceitas × 1,6 × 1,30. A política usa o vídeo inteiro sem rótulos e deve ser considerada na validação. Corpo cortado pelo enquadramento, corpo maior que o recorte ou posição recuperada ficam incertos. Padding apenas do fundo ao redor de um corpo inteiramente visível é permitido e registrado em `cropPadded`/`paddingFraction`; não equivale a reconstruir parte do animal.
- Silhueta, eixo e larguras são calculados em Python. O perfil é invariante à inversão do eixo. Silhuetas quase isotrópicas deixam o eixo como ausente. Larguras, área e distância usam pixels originais; não são medidas anatômicas ou altura física.
- Fluxo em 96 px: Farnebäck padrão e opção Lucas–Kanade para comparação. Compensa translação residual pela mediana. Ausência de silhueta/continuidade não vira movimento zero. Variações relativas de área, comprimento e largura usam dimensões fixas de sessão estimadas pela mediana de até 64 silhuetas aceitas, selecionadas por reservoir com seed 42; a calibração é registrada no manifesto.
- Grade temporal 10/15/30 Hz deve corresponder ao treinamento. Janela não causal de 31 amostras e máscaras explícitas. Embedding visual calculado uma vez por imagem. O suporte de cada resultado preserva o PTS original; grandes lacunas ficam desconhecidas. A duração vem do stream de vídeo no FFprobe. Se indisponível, usa o último delta positivo limitado a 100 ms, registrando que a duração é estimada; suportes de predição continuam limitados pela amostragem e o restante fica desconhecido.
- Histerese confirma início/fim retrospectivamente. Postura quadrúpede confirmada separa episódios. Lacunas curtas podem manter um episódio censurado, mas não entram na duração observada. Limiares incluídos são valores iniciais de desenvolvimento, ainda não otimizados em validação.
- Zero eventos só é mensurável quando existe tempo classificável. Denominadores usam cobertura comportamental. Latência é nula se o prefixo estiver desconhecido.

## Treinamento

### Ajuste local com ápices

O botão **Exportar para treinamento** salva CSV mesmo quando existem apenas ápices. CSV/JSONL e ZIP são gravados na pasta de resultados do aplicativo; **Mostrar arquivo** abre a localização pelo sistema. O ZIP inclui a referência de fundo e os metadados disponíveis do tracking, necessários para reproduzir a interrupção por entrada do pesquisador.

`scripts/behavior/train_oft_peaks.py` permite um ajuste CPU experimental com pontos humanos após a declaração explícita de que todos os rearings do vídeo foram marcados. O alvo é o ápice, sem atribuir duração ou transformar o restante de um episódio em “Não rearing”. O treinamento usa imagem, geometria, movimento e contexto de ±0,5 s; separa blocos temporais com margem, escolhe o limiar em validação e registra os falsos positivos. Um único vídeo oferece somente uma avaliação de desenvolvimento, sem validar outros animais ou sessões. Caixas segmentadas incertas podem fornecer descritores, com essa condição registrada; propostas continuam pendentes de revisão.

Depois de extrair o pacote exportado, em um ambiente de treinamento com NumPy, OpenCV e scikit-learn:

```bash
python scripts/behavior/train_oft_peaks.py /dados/pacote_extraido /dados/ajuste_local --exhaustive-peaks --video /dados/video_original.mp4 --ffmpeg ffmpeg --ffprobe ffprobe
```

O vídeo precisa corresponder ao SHA-256 das anotações. `--video` é opcional quando o pacote contém o original. A pasta `ajuste_local/model` contém o manifesto e a floresta portátil JSON, verificadas por hash e equivalência numérica. Em **Rearing → Detecção automática → Pasta do modelo de ápices**, informe essa pasta e execute **Detectar ápices com modelo local**. A inferência usa o ambiente OpenCV existente, sem instalar scikit-learn no aplicativo. Os resultados exibem a precisão de desenvolvimento, indicam vídeos usados no treinamento e abrem cada proposta no estúdio para revisão. Esse fluxo não altera o classificador de episódios ONNX nem as métricas científicas.

O OpenCV de Campo Aberto também suspende a observação diante de uma intrusão grande conectada ao limite da arena e encerra o tracking após confirmação temporal. Todas as amostras seguintes ficam ausentes, com o instante e a evidência registrados em `trackingTermination`. É uma regra conservadora de primeiro plano e geometria; requer verificação em outras gravações e também pode responder a objetos grandes. Ao analisar tracking antigo, o modelo de ápices verifica novamente a entrada no vídeo original e preserva os arquivos históricos.

### Classificador de episódios

O notebook `scripts/behavior/BehaviorTracker_OFT_Rearing_Training_V1.ipynb` prepara as etapas para Colab. **Não foi executado no Colab nesta implementação.** PyTorch/torchvision, scikit-learn e bibliotecas de exportação pertencem ao treinamento; a inferência local requer somente OpenCV, NumPy e ONNX Runtime CPU.

Organize o dataset:

```text
OFT_Rearing/
  videos/{video_id}.mp4
  annotations/videos.csv
  annotations/intervals.csv
  tracking/{video_id}/request.json
  tracking/{video_id}/samples.jsonl
```

`videos.csv`:

```csv
video_id,animal_id,session_id,arena_id,sha256,filename,condition
```

`intervals.csv`:

```csv
video_id,start_sec,end_sec,label,annotator_id,video_sha256,tracking_job_id,annotation_id
```

O construtor verifica hashes, relógios e intervalos; somente trechos inteiramente cobertos por rótulos humanos recebem rótulo. Componentes conectados por animal, sessão ou hash nunca cruzam partições. Pelo menos três componentes independentes são exigidos. É responsabilidade do estudo escolher IDs globais de sessão consistentes e coletar exemplos positivos/negativos em cada partição.

```bash
python scripts/behavior/build_oft_dataset.py /dataset/OFT_Rearing /dataset/snapshot_v1
python scripts/behavior/train_oft_baseline.py /dataset/snapshot_v1 /training/model_a
python scripts/behavior/train_oft_visual.py /dataset/snapshot_v1 /training/model_b --architecture visual --device cuda
python scripts/behavior/train_oft_visual.py /dataset/snapshot_v1 /training/model_c --architecture visual_tcn --device cuda
python scripts/behavior/train_oft_visual.py /dataset/snapshot_v1 /training/model_d --architecture hybrid_tcn --device cuda
python scripts/behavior/export_onnx.py /training/model_d /export/model_d --version 1.0.0
python scripts/behavior/validate_oft_behavior.py /dataset/snapshot_v1 /export/model_d /reports/model_d --split test
```

Não carregue checkpoints `joblib` de terceiros: o exportador do baseline desserializa o arquivo produzido pelo treinamento. Checkpoints neurais usam `weights_only=True`. A inicialização MobileNet é ImageNet, não um modelo de rearing já treinado.

A exportação verifica equivalência numérica com ONNX. O manifesto registra hashes/tamanhos de pesos e configurações, código de treinamento, arquitetura e estado experimental. `--release-base https://github.com/ORG/REPO/releases/download/TAG` prepara URLs fixas; não cria release nem publica arquivos. O aplicativo aceita um bundle local verificado antes de existir uma release. Não há URLs fictícias nem pesos no instalador.

A avaliação verifica também a ausência de animais/sessões/hashes do treino nos dados de avaliação, trata sessões negativas sem exigir métricas inaplicáveis e não aprova uma coorte que contenha somente negativos. Com `--source-videos /dataset/OFT_Rearing/videos`, gera clipes qualitativos dos erros (até 30 por padrão). A avaliação produz métricas por sessão/condição/subtipo, F1 por frame, correspondência um para um de episódios por tIoU ≥ 0,5, erros de início/fim/contagem/duração e intervalos de falsos positivos/negativos. A aprovação automática exige anotação exaustiva e todas as metas do documento de especificação. Isso é uma triagem de desenvolvimento; não substitui validação independente e concordância humana. Quantização INT8 e comparação de FP32/INT8 ainda exigem modelos treinados e os mesmos vídeos de teste.

## Runtime e persistência

`local_behavior.rs` materializa todos os módulos `behavior/` com `include_str!`, cria jobs independentes e persiste anotações/revisões via migration SQLite 004. Revisões pertencem à execução comportamental; anotações humanas pertencem ao tracking/vídeo. Os scripts são transportados pelo binário, sem depender da árvore do repositório no aplicativo instalado.

Ambiente isolado: `local-behavior/venv`. ONNX Runtime 1.20.1 foi fixado para disponibilidade de wheels Intel macOS. O wheel Intel de OpenCV 4.13.0.92 usado neste ambiente exige macOS 14+. O wheel ONNX 1.20.1 para Python 3.13 exige macOS 13+; o requisito combinado é o mais restritivo. Sistemas anteriores precisam de um ambiente externo compatível, que ainda deve ser validado. Consulte a [distribuição oficial](https://pypi.org/project/onnxruntime/1.20.1/) e a [API CPU](https://onnxruntime.ai/docs/api/python/api_summary.html). `BEHAVETRACKER_BEHAVIOR_PYTHON` permite apontar para um ambiente previamente preparado. A instalação não altera o Python global ou o ambiente do rastreador.

Resultados são escritos em `pending/` e publicados pelo rename de um único diretório para `result/`, seguido de estado terminal. Cancelamento/falha não disponibiliza métricas como concluídas. O reinício recupera jobs interrompidos. Dados contêm manifesto, hashes do vídeo e tracking, features JSONL, embeddings, predições JSONL, CSV/JSON de episódios, métricas e relatório de qualidade.

A especificação científica ainda depende de: anotações humanas, treinamento, seleção de limiares somente em validação, teste em vídeos completos independentes, benchmark do classificador treinado no DD2, comparação FP32/INT8 e interação no aplicativo instalado nas três plataformas. Testes sintéticos não demonstram reconhecimento de rearing real, grooming ou reflexos.

## Verificação desta implementação

O [relatório de 25/11/2026](reports/oft-rearing-v1-2026-11-25.json) registra os testes, o pipeline sintético completo, a interface em navegador simulado e a extração de features no DD2. O [preview do estúdio](reports/oft-rearing-studio-2026-11-25.png) usa vídeo e comandos Tauri simulados. A interface reutiliza os componentes existentes de shadcn/ui/Radix e os diálogos locais do projeto.

A [auditoria item por item](OFT_REARING_IMPLEMENTATION_AUDIT.md) preserva o escopo completo e identifica os critérios ainda sem evidência. Os resultados de exemplo do [resumo](reports/oft-rearing-summary-2026-11-25.png) são simulados.
