# Processamento clássico local

Os relatórios experimentais indicados como registros locais não integram a
distribuição pública. Seus resumos históricos abaixo não substituem validação
independente. Veja as [condições de acesso aos dados](../DATASET_CARD.md) e os
[procedimentos públicos de validação](VALIDATION_GUIDE.md).

O processamento local de Campo Aberto e RAM oferece a estratégia `classical_roi_v1`, selecionada inicialmente na interface. O fluxo usa OpenCV em CPU, sem pesos neurais. Wistar + HRNet, RAM Color e o processamento pelo Colab continuam disponíveis como alternativas independentes.

## Uso

No Campo Aberto, escolha **Máquina local → Analisar → OpenCV rápido · CPU** e a largura de 480, 640 ou 960 px. O padrão é 640 px; vídeos menores não são ampliados. No RAM, escolha **Fundo da sessão + continuidade (CPU)** e confira o contorno da área analisável. A primeira execução pode instalar OpenCV no ambiente Python isolado do aplicativo.

O Campo Aberto reutiliza ou copia o original, verifica SHA-256 e evita uma transcodificação prévia integral. O FFmpeg reduz a imagem durante a decodificação contínua. O relógio por frame continua vindo dos PTS originais, inclusive em vídeos com taxa variável; as caixas retornam às coordenadas originais.

## Fundo, ROI e continuidade

- Até 31 leituras pontuais por seek, distribuídas pela duração da sessão, formam a mediana temporal. Sem duração conhecida, a referência usa um prefixo limitado, declarado no relatório. Não há varredura integral extra para montar esse fundo. O FST mantém seu limite independente de 15 amostras.
- A referência permanece fixa: a imobilidade durante a análise não atualiza o fundo.
- Conversão para cinza/Lab, limiar e morfologia são calculados no retângulo da ROI; a máscara poligonal é reaplicada depois da morfologia. A versão `opencv-box-9` compensa mudanças globais sem atualizar o fundo e calcula limiares de luminância e cromaticidade a partir da dispersão robusta das amostras. A seleção combina distância, aparência do núcleo, área, preenchimento e sobreposição com o piso. Fluxo óptico bidirecional orienta a associação por até 0,25 s; não publica uma observação sozinho. Não há exigência de sobreposição com a caixa prevista pelo Kalman.
- Lab é usado somente nos recortes candidatos. No RAM Color, HSV e Lab ficam restritos ao retângulo da ROI; a máscara exportada mantém o tamanho e as coordenadas esperados pelo contrato anterior.
- Um animal imóvel nas próprias amostras pode ser incorporado à mediana. Nessa situação, o contraste estimado das amostras fornece uma tentativa auxiliar, marcada `recovered/low_confidence`; ela não atualiza o Kalman. Ambiguidades e perdas continuam explícitas.
- Previsões curtas do Kalman são `predicted/low_confidence`. Observações incertas, recuperações e previsões não entram automaticamente nas métricas científicas. `referenceApproved` começa como `false`.

Na versão 8, `localQuality.tracking` e `localQuality.geometry` separam a aceitação pelo rastreador das restrições geométricas. Uma silhueta consistente junto à borda do piso pode atualizar a posição rastreada, mas permanece `low_confidence` para as métricas do piso. Uma silhueta cortada pelo limite externo, uma mudança de aparência/área e candidatos ambíguos não atualizam posição, área ou aparência confiáveis. O início e a recuperação após uma perda exigem duas observações visualmente consistentes; uma caixa inicial explícita pode orientar o início. Essa consistência é heurística e não comprova identidade biológica nem delimitação correta de todo o corpo.

O Kalman só é corrigido por `trackingAccepted: true`; nos motores legados sem esse campo, exige `status: valid`. `kalmanUpdated`, `reasonCounts`, `qualityReasonCounts`, `trackingObservedCoveragePct` e `geometryRejectedFrames` tornam as decisões auditáveis. O histórico continua a distinguir as versões dos motores. O carregamento de referências também impede que caixas `predicted` ou `recovered` sejam convertidas em `detected`, preservando o uso independente das caixas realmente observadas pelo detector quando a pose anatômica é insuficiente.

`background-reference.png`, `reference.json` e `run_manifest.json` registram o fundo, os tempos solicitados ao seek, o método e a configuração. Os tempos da referência são alvos de amostragem, não uma nova indexação dos PTS dos frames analisados.

## Características reutilizáveis

O descritor `silhouette-features-1` contém área da máscara em pixels originais, razão de aspecto, preenchimento, eixo principal sem direção anatômica, deslocamento do centro de massa da máscara por segundo, fração de pixels alterados e diferença média de cinza na união das silhuetas consecutivas. Esse centro descreve pixels segmentados e difere do centro da caixa usado na trajetória. O eixo de uma silhueta aproximadamente simétrica é pouco informativo. Mudanças de iluminação também afetam esses descritores.

Os descritores usam o tempo efetivo entre frames; a primeira observação, uma perda de máscara ou um intervalo superior a 0,5 s interrompem o cálculo temporal. `observationUsable` expressa a qualidade heurística da observação e não equivale a aprovação científica. O Campo Aberto exporta `motion_features.jsonl` na aba **Arquivos**; os dados também permanecem em `samples.jsonl` no diretório da execução.

Os CSVs de pose têm colunas opcionais adicionais para aceitação do tracking, estados de localização/geometria/identidade, motivos e atualização do Kalman. Arquivos anteriores continuam legíveis. O JSONL de movimento inclui os mesmos indicadores. A confirmação humana explícita continua independente desses indicadores automáticos.

O FST mantém o contrato separado `fst-local-presence-1`, seu percentil escuro de referência e a presença por cilindro. A referência passa a usar as leituras pontuais. Características de movimento são extraídas somente na máscara corporal candidata de cada cilindro e exportadas em `motionFeatures`, com valor nulo quando não há corpo confirmado. O resultado continua `NOT_CLASSIFIED`, com `behaviorMetrics: null`.

Não foi incorporado código dos projetos citados na proposta. Esta implementação usa as técnicas descritas e as dependências existentes do aplicativo.

## Validação e limites

Os testes locais cobrem fundo fixo, parede estática, corpo imóvel nas amostras, oclusão e expiração da previsão, coordenadas originais, tempo variável, cancelamento da referência, leitura limitada sem duração, independência de dois cilindros e ausência de classes comportamentais no FST. A regressão da renderização VFR também passou a preservar o último frame do MP4, desativando B frames e a edit list que o cortava no FFmpeg local.

O comparativo técnico está em benchmark-classical-local-2026-11-24.json (registro local de desenvolvimento). Ele compara uma configuração clássica de uma execução existente com a nova estratégia em 480, 640 e 960 px, usando o mesmo vídeo de 7.356 frames. Os hashes das implementações e as configurações são registrados. Cada variante foi executada uma vez; não houve controle de temperatura ou carga externa. O tempo inclui referência, decodificação, características e gravação dos resultados, mas exclui renderização do vídeo de auditoria.

| Variante | Tempo total do processo | FPS do motor | Observações sem alertas | Frames para revisão |
| --- | ---: | ---: | ---: | ---: |
| Clássico anterior | 66,48 s | 110,7 | 28,66%* | 5.248* |
| Fundo/ROI · 480 px | 29,62 s | 248,8 | 13,69% | 6.349 |
| Fundo/ROI · 640 px | 32,65 s | 225,6 | 13,49% | 6.364 |
| Fundo/ROI · 960 px | 53,38 s | 137,9 | 13,32% | 6.376 |

\* O motor anterior não exporta esses dois campos diretamente: observações sem alertas = `observed - (suspect - predicted)`; revisão = `suspect + missing`, nesta execução sem caixas manuais ou recuperações.

O caminho de 640 px levou aproximadamente metade do tempo do baseline, mas teve **menos observações sem alertas**. A maioria dos frames ainda exige revisão. Este resultado não demonstra melhora de precisão e não sustenta liberação automática de métricas. A interface identifica o método como experimental. Ele implementa a variante B e a extração de descritores; o classificador temporal da variante C e a análise neural automática das exceções continuam sem um modelo validado.

### Revisão de confiança: versão 7 versus versão 8

O comparativo de confiança (registro local de desenvolvimento) usa a configuração idêntica de 640 px, o snapshot da versão 7 anterior a esta revisão e a versão 8. Inclui as referências, decodificação e características; exclui renderização. Os 7.356 frames e os PTS correspondem nas duas versões. Os tempos diferem do benchmark anterior, pois são execuções distintas sem controle de carga externa.

| Indicador | Versão 7 | Versão 8 |
| --- | ---: | ---: |
| Tempo total | 50,80 s | 48,92 s |
| FPS do motor | 144,9 | 150,5 |
| Frames sem caixa ou previsão | 309 | 68 |
| Observações sem alertas | 13,49% | 2,73% |
| Localizações aceitas pelo rastreador | Não registrado | 20,23% |
| Localizações aceitas com restrição geométrica | Não registrado | 1.287 |

O novo relatório contabiliza 3.149 alertas de aparência e 4.248 de área; um frame pode ter vários motivos. Não se deve interpretar o menor número de ausências como maior precisão. Inspeção visual de quatro frames desta gravação mostrou caixas que abrangem o animal, mas também uma caixa que representa somente parte do corpo. O método continua experimental, e as novas regras de consistência não resolvem sozinhas a segmentação corporal nessa sessão.

A fila de 120 frames (registro local de desenvolvimento) combina cobertura temporal e tipos de alerta. Ela registra SHA-256 verificado do vídeo, frame e PTS, com caixas sugeridas separadas de `humanBox`. Todos os campos humanos permanecem vazios e `approved` é falso. Essa fila não é ground truth e não é um conjunto independente. A anotação deve delimitar a referência corporal escolhida de forma consistente, identificar anotador e revisor e incluir outras gravações para avaliar generalização.

Para preparar outra fila a partir de uma execução concluída cujo manifesto contenha `videoSha256`:

```sh
python scripts/prepare-local-review.py \
  --run /caminho/da/execucao \
  --frames 120 \
  --output /tmp/revisao-pendente.json
```

Para repetir com outra sessão:

```sh
python scripts/benchmark-local-engine.py \
  --request /caminho/da/execucao/request.json \
  --classical-widths 480 640 960 \
  --output /tmp/benchmark-classical.json
```

Use um Python com OpenCV instalado. O benchmark remove a opção de vídeo de auditoria da solicitação para preservar os arquivos das execuções do aplicativo.

Cobertura válida e número de alertas são saídas heurísticas, não acurácia. A medição em uma sessão não estabelece generalização. Rearing, mobilidade/imobilidade, natação e escalada exigem dados humanos independentes e classificadores validados; não foram habilitados por limiares de silhueta. Também não houve validação no Colab/GPU nem interação com um aplicativo Tauri empacotado.

A suíte ampliada de `test_fst_pipeline` depende de pandas, ausente no ambiente OpenCV mínimo desta máquina. Os testes novos de FST local usam FFmpeg/OpenCV diretamente e não precisam dessa dependência.

Verificações após a revisão de confiança: build TypeScript/Vite; 129 testes Vitest; 11 testes Rust de `local_tracking`; 45 testes Python locais, com 44 aprovados e um teste exclusivo de bloqueio de arquivos no Windows ignorado no macOS; três testes do seletor de revisão humana. Há regressões para mudança de brilho, aparência e área, aquisição/reidentificação, ambiguidade, contorno cortado, separação de geometria, bloqueio de previsões/recuperações nas referências e preservação dos indicadores no CSV.

### Reflexos e continuidade visual: versão 9

A pesquisa de tecnologias e decisões (registro local de desenvolvimento) documenta as fontes primárias, as alternativas locais e o teste de VitTrack que apresentou deriva. O novo caminho mantém OpenCV mínimo em CPU, combinando cromaticidade, núcleo corporal, preferência geométrica e Lucas–Kanade. No diálogo local, **Indicar o animal no primeiro frame** permite desenhar uma caixa corporal opcional no original. Essa indicação não aprova métricas.

O comparativo DD2 (registro local de desenvolvimento) usa a arena exata do experimento, o motor versão 8 preservado no job original e a versão 9, com a mesma solicitação e os mesmos 7.356 PTS. O processamento final a 640 px levou 91,35 s (80,5 FPS); o baseline levou 45,25 s (162,6 FPS). O custo adicional decorre da segmentação por cor e continuidade visual. É uma medição de processamento de arquivo, sem renderização de auditoria, sem controle térmico e com parte dos testes concorrendo com a versão 9.

As localizações aceitas pelo algoritmo passaram de 24,59% para 81,92%; observações sem alertas passaram de 3,11% para 8,90%. **Nenhum desses percentuais mede acurácia.** A maioria dos frames continua perto das paredes e requer revisão geométrica. Na inspeção dirigida, os frames 2 e 7.000 passaram de regiões laterais pequenas para caixas no corpo; o frame 3.000 passou de fragmento para região corporal mais completa. O frame 100 ainda tem corpo parcialmente segmentado e permanece incerto. Outros erros podem existir fora desses exemplos.

As imagens lado a lado (registro local de desenvolvimento) preservam os pixels do vídeo e colocam legendas abaixo, com registros correspondentes (registro local de desenvolvimento). Verde indica apenas aceitação pelo rastreador. A nova fila de 120 frames (registro local de desenvolvimento) usa o SHA-256 verificado e mantém todos os campos humanos vazios. Os resultados anteriores do aplicativo não foram substituídos.

Para gerar uma comparação visual de outras execuções concluídas com o mesmo vídeo, arena e relógio:

```sh
python scripts/compare-local-boxes.py \
  --before-run /caminho/da/execucao-anterior \
  --after-run /caminho/da/execucao-nova \
  --frames 0 100 500 \
  --output /tmp/comparacao.jpg
```

Verificações da versão 9: build TypeScript/Vite, 129 testes Vitest, 11 testes Rust locais, 49 testes Python aprovados e um teste específico de Windows ignorado, além dos três testes do seletor de revisão. Os testes adicionais cobrem reflexo sintético maior fora do piso, corpo com luminância semelhante ao fundo, remoção de cauda fina, rejeição de fragmento na caixa inicial e validade curta do fluxo bidirecional. Não houve interação com aplicativo empacotado nem validação Colab/GPU.
