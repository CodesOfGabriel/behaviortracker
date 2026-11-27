# Radial Arm Maze: contrato de preparação

## Estado em 17/11/2026

`radial_arm_maze` é um terceiro protocolo independente. O aplicativo permite cadastrar o animal e o vídeo, capturar um frame e configurar a preparação em três fases: contornar uma vez toda a área transitável, marcar os oito potes com quadrados ajustáveis e escolher os quatro com recompensa. Cada quadrado pode ser arrastado ou redimensionado pelo canto; o usuário avança manualmente após cada pote. A política temporal de visita é registrada para uso futuro. O mapa é exportável em JSON. O resultado abre uma tela própria de preparação e não inicia o motor de Campo Aberto.

O motor puro em `src/lib/radial-maze/` classifica posição em `CENTER`, `ARM_1`–`ARM_8`, `DISTAL_1`–`DISTAL_8` ou `UNKNOWN`, exige retorno estável ao centro e cruzamento da linha de entrada, detecta escolhas com permanência configurável e produz um log de escolhas com `confirmed` ou `pending`. Ele separa primeira visita recompensada (`CORRECT`), primeira visita não recompensada (`RME`), revisita recompensada (`WME`) e revisita não recompensada (`RWME`). `RWME` não entra novamente em `WME`. Uma lacuna de identidade não vira posição interpolada; ela pode deixar a escolha pendente. Uma escolha pendente no mesmo braço impede classificar uma escolha posterior como primeira visita ou revisita definitiva.

Os contadores são calculados **somente a partir de entradas confirmadas no log fornecido ao motor**. `definitive` no resultado do motor significa apenas que o log de entrada não contém pendências; não equivale a validação científica da sessão. A tela de preparação não apresenta esses contadores porque ainda não há tracking RAM aprovado.

Na preparação nova, `walkableMaskVersion` é SHA-256 do contorno único, prefixado por `ram-walkable-polygon-1`. Revisões antigas preservam o hash `ram-polygon-mask-1` de plataforma e braços. Mudanças na geometria criam nova revisão e novo hash. As coordenadas são pixels do vídeo original; o SVG usa `viewBox` para manter a relação de aspecto. A validação da nova preparação exige contorno e potes não degenerados, sem cruzamentos próprios, os oito potes com alguma sobreposição à área marcada e exatamente quatro recompensas. Um pote parcialmente ocluído pode ter parte do quadrado fora do labirinto. A região efetiva de cada pote é a interseção do quadrado com a área transitável; posições fora da área transitável ficam excluídas de qualquer análise. Um quadrado sem interseção com o labirinto permanece inválido. Essa marcação única não define plataforma, limites individuais dos braços ou linhas de entrada e distal. O motor de eventos rejeita essa geometria; visitas e erros de memória não podem ser calculados dela.

O botão **Revisar geometria** cria uma nova revisão e guarda a configuração anterior em `geometryHistory`. A tela também permite restaurar uma revisão anterior como uma nova revisão, sem apagar o histórico. A restauração retorna a sessão a `draft`.

## Auditoria dos arquivos recebidos

Os dados foram lidos de um pacote local de integração V13 fornecido para auditoria; o código não altera nem copia os originais para o repositório.

Para repetir a auditoria localmente: `python3 scripts/audit-ram-v13.py CAMINHO_DO_PACOTE --r2 CAMINHO_DO_R2.zip --r3 CAMINHO_DO_R3.zip`. O script lê os arquivos e imprime JSON; requer `ffprobe` e `ffmpeg` instalados.

## Tracking experimental no Colab

O aplicativo desktop pode executar `wistar_ram_hybrid_v1` com o bundle `wistar_df_v2` e a HRNet já distribuídos. O V12 disponível é uma reconstrução que reutiliza o tracking V11; o V13 contém auditorias e redetecção de candidatos, não um modelo RAM novo validado. Por isso esta execução é apenas uma observação experimental e não substitui o novo treinamento e a validação independente planejados.

O contorno único do labirinto limita os pixels fornecidos ao detector. Uma caixa só é aceita quando seu centro está na área marcada. A pose `mouse_center` só é publicada se houver caixa observada, likelihood de pelo menos 0,60 e centro dentro do contorno. Fora da área marcada não há análise. Quadros sem evidência permanecem nulos. Os potes e recompensas não participam deste tracking.

O resultado segue `schemas/ram-tracking.schema.json` e traz SHA-256 do vídeo preparado e original, revisão e versão da máscara, frames com qualidade e `behaviorMetrics: null`. Os artefatos brutos incluem detecções, pose CSV/H5, QC e manifesto. `schemas/ram-result.schema.json` continua reservado para resultados comportamentais após revisão e validação; esta execução não produz escolhas por braço, erros de memória nem consumo de recompensa.

## Evidências da auditoria V13

- `Caf 3 - dia 2.MOV`: SHA-256 `8f1fbed025c972c5ad7e194502a0f1ac1b0dffe8a52bf1a8d577e3ff20ae69b3`, HEVC, 1920 × 1080, 14.514 frames, duração de stream 604,720833 s. O arquivo tem 705.214.054 bytes.
- Os três arquivos de modelo do pacote têm os mesmos SHA-256 e tamanhos do manifesto local `wistar_df_v2`: detector `211891e0…`, HRNet `d81c8f18…`, configuração `847076c1…`. O manifesto descreve validação apenas de treino/validação, sem teste independente.
- `tracking_v11.csv` tem frames 0–14513 sem duplicatas, 14.514 linhas, 182 linhas sem `x1` ou `y1`. `time_nominal_s` termina em 604,679169 s. Esse tempo é nominal e não substitui o PTS original sem conferência.
- `V13_R2_QC_resultados.zip` e `V13_R3_R05_detector_proposals.zip` estão em `Downloads`, fora da pasta principal. O R2 registra 2.388 frames para revisão, 2.020 centros ausentes e 49 centros derivados **não aprovados**. O R3 contém 3.280 propostas em 410 frames (4030–4439), sem pose reexecutada e com status `UNVERIFIED_NOT_FOR_METRICS`.
- A máscara PNG e o vídeo têm 1920 × 1080. Ao medir as propostas R3 contra os pixels brancos dessa máscara, nenhuma caixa alcança 35% de área sobreposta; a maior alcança 30,54%. Porém, 1.209 das 3.280 caixas têm **centro** dentro da máscara. Entre as 410 propostas de maior score por frame, somente 64 têm centro na máscara. Isso confirma que a regra de sobreposição da caixa inteira é inadequada para braços estreitos e que o maior score frequentemente aponta para fora da área transitável. A inspeção visual do frame próximo a R05 mostra o animal em um braço enquanto há objetos externos. Esta medição não aprova nenhuma proposta nem exclui outros problemas de orientação, crop ou identidade.

## Pendências para validar a inferência e calcular comportamento

1. Conferir o vídeo original e a máscara no mesmo sistema de coordenadas, com a preparação de vídeo que será usada no Colab. Comparar PTS real, frame index e eventuais rotações/crops.
2. Construir e versionar as referências específicas dos braços antes de calcular visitas. A área transitável única, inclusive a máscara V11, não contém plataforma, braços e linhas separados. Não deve ser tratada como geometria de eventos RAM pronta.
3. Produzir uma trajetória revisada, com decisões humanas para R05 (4066–4403) e R15 (10166–10214), preservando as observações originais e a origem de cada centro derivado. O R2 tem candidatos, não correções aprovadas.
4. Substituir o detector Wistar v2 experimental por um bundle RAM treinado e validado, com evidência de segmentação e associação temporal de identidade antes de aprovar caixas e eventos. O tracking inicial já roda no Colab, mas não oferece essas garantias.
5. Criar armazenamento local versionado para tracking, pose, QC, eventos e revisões por frame; importar V11/R2/R3 com validação de hash, schema, frames e tempos. Estes dados volumosos não pertencem a `localStorage`.
6. Criar tela de revisão do vídeo e dos artefatos RAM, anotação humana de inspeção/consumo de recompensa e exportações finais. Proximidade ao pote não prova consumo.
7. Comparar identidade, posição e eventos com anotações humanas independentes de novas sessões antes de apresentar métricas como validadas. Os limiares de permanência iniciais do wizard são parâmetros de trabalho, não padrões científicos.

Os critérios de eventos e erros de memória dependem da política salva com cada sessão. Uma revisão do critério precisa reprocessar o log de eventos e produzir uma nova versão das métricas, preservando as saídas brutas.

## RAM Color v2 — integração local em 23/11/2026

A estratégia `ram_color_geometry_v2` usa o mesmo job Tauri/OpenCV, ambiente Python, staging, cancelamento e histórico das análises locais. O código em `ram_color.py` porta a segmentação HSV/Lab, morfologia e componentes do protótipo V1 recebido. A seleção acrescenta comparação de aparência e orientação, ambiguidade entre candidatos e reaplica a máscara após morfologia. Cor, área, densidade, velocidade e readquisição são parâmetros por execução. Os valores iniciais são exploratórios da sessão de origem, não parâmetros universais. Não há fallback neural ou classificação comportamental automática.

`observed`, `uncertain` e `missing` coexistem com os estados legados de `PoseSample`. Uma previsão não é observação e não entra nas métricas. O candidato incerto pode aparecer na revisão; seu centro é excluído dos eventos. O centro é explicitamente `segmented_body_bbox_center`, estimativa geométrica do corpo segmentado, sem equivalência a `mouse_center` anatômico. `bodyBbox` é distinto de `fullAnimalBbox` e `pose`, que permanecem nulos. `uncertaintyPx` é heurístico, não intervalo estatístico calibrado. Obstáculos/reflexos da mesma aparência e iluminação não representada continuam sendo riscos de identidade.

Cada job preserva `request.json`, `run_manifest.json`, `samples.jsonl`, `walkable-mask.png` e `masks/{frameIndex}.png` em `app_data_dir/local-tracking/{jobId}`. Máscaras são na resolução de processamento, com escala no manifesto; caixas e centros usam pixels originais. O vídeo original permanece no staging sem modificar seus frames. Timestamps vêm de `ffprobe` PTS e a leitura rejeita divergência de frames, rotação ou resolução. O contrato adicional é `schemas/ram-local.schema.json`; os contratos RAM neural existentes permanecem legíveis.

A quarta fase do wizard permite desenhar plataforma, oito polígonos e linhas de entrada/distal. A associação Bn/Pn usa o mesmo ID e recompensa registrada. `eventGeometryConfirmed` registra revisão explícita das referências. A máscara continua independente dos limites de eventos. Apenas marcar a área transitável não permite calcular visitas. Revisões de geometria preservam histórico; com a mesma máscara preservam tracking e correções, e os derivados são recalculados com a nova revisão e política.

A revisão mostra vídeo, caixa dinâmica, trajetória recente, qualidade, gráfico de deslocamento e navegação por frame/incertezas/escolhas. Posição, caixa e confirmação de identidade são decisões humanas por frame; não geram interpolação. A migration SQLite 003 acrescenta `ram_review_events`, com sequência imutável pela API, IDs únicos, vínculo ao job, vídeo SHA-256 e relógio original. Reversão acrescenta evento e preserva os anteriores. A exportação JSON inclui observações brutas, corrigidas, histórico, geometria, política, configuração, métricas e proveniência. Estes dados não são gravados em `localStorage`.

Eventos reutilizam `detectRamChoices`/`calculateRamMetrics`. Frames ausentes, saltos do relógio e referências incompletas não são tratados como deslocamento contínuo. Ocupação, distância e velocidade somam somente intervalos adjacentes observados, de até 0,25 s. Distância e velocidade em cm exigem escala uniforme explicitamente registrada; não se infere escala da imagem nem se corrige perspectiva automaticamente. Com lacunas, as contagens são parciais e `definitive=false`. Nenhuma ausência vira imobilidade.

O módulo independente `rewards.ts` delimita janelas antes/depois de escolhas e conserva `reward_present`, `reward_absent`, `occluded`, `uncertain`, score e versão. Mesmo uma mudança consistente de estado permanece `PENDING` para retirada de alimento. O pacote recebido inclui predições V7, mas não checkpoint MobileNetV3, manifesto de inferência nem contrato de crops. Portanto, execução automática de V7 e revisão visual específica de recompensas ainda não estão disponíveis; o módulo não inventa esse modelo nem converte aproximação em consumo. As contagens de memória descrevem a política de visitas e não inferem retirada.

Validação científica exige outra gravação e referências temporais independentes para identidade, centro corporal, entradas/saídas e recompensa. A execução na gravação de desenvolvimento e os 23 frames revisados são diagnóstico, não generalização.
