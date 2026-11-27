# Continuidade visual e orientação temporal de Campo Aberto

## Estado e escopo

A implementação acrescenta recuperação visual e refinamento offline compartilhados pela análise local e pelo adaptador Colab. O objetivo completo — área corporal precisa, cabeça/cauda corretas e episódios de rearing validados — permanece em aberto. Cobertura do desenho não demonstra acurácia anatômica.

A reprodução usa as imagens e observações salvas da execução local de 7.356 quadros a 24 fps mostrada pelo usuário. Não executa novamente o detector neural, não usa GPU e não modifica os arquivos do aplicativo. A suspensão por possível intervenção começa no quadro 7.303, seguida da confirmação; os 53 quadros finais permanecem sem estimativa de animal.

## Falhas reproduzidas

Aos 51 s, a versão anterior marcava a cabeça à direita, sobre a região posterior, enquanto o focinho visível estava à esquerda. Uma extensão abaixo do meio do corpo havia sido aceita como cauda. Uma primeira correção causal reduziu inversões aos 3,875 e 15,542 s, mas depois manteve uma orientação incorreta aos 160,542 s mesmo diante de uma cauda longa visível.

Esse segundo caso mostra o limite de aumentar apenas a persistência da direção anterior. O refinamento final passou a avaliar hipóteses de ambos os sentidos com informações anteriores e posteriores.

## Arquitetura implementada

1. O detector fornece a região de associação; a silhueta segmentada fornece a geometria. `detectorBox`, máscara corporal, caixa visual e referência do centro no piso continuam com funções distintas.
2. `oft_continuity.py` preserva um caminho visual durante falhas transitórias. Um caminho de menor custo pela transformada de distância representa corpos curvados quando o eixo observado é rejeitado. O eixo observado permanece em `bodyAxis`.
3. O fluxo Lucas–Kanade verifica correspondências de ida e volta, exige pelo menos quatro pontos e limita erro de retorno, escala e deslocamento. A matriz fica em coordenadas originais para transportar as extremidades na passagem offline.
4. `temporal_pose/gap_recovery.py` procura apoio real em imagens futuras para lacunas de até 750 ms. Só aceita a recuperação retrospectiva quando o fluxo é validado. Não atravessa intervenção, remoção, oclusão explícita ou descontinuidade de tempo.
5. `temporal_pose/orientation_viterbi.py` decodifica três hipóteses: cabeça na primeira extremidade, na última ou orientação desconhecida. Evidências atuais de cauda são registradas antes dos filtros causais da prévia. Transições comparam as extremidades transportadas pelo movimento da imagem; deslocamento corporal não determina qual lado é a cabeça. Uma passagem de custos reversa identifica empates e suporte insuficiente.
6. `temporal_pose/kalman_smoother.py` aplica filtro de velocidade constante e suavização Rauch–Tung–Striebel, usando os timestamps existentes. A correção visual é limitada a 8% do comprimento por ponto. Se um ponto suavizado sair da máscara atual, conserva-se a posição anterior à suavização naquele quadro.
7. O finalizador grava atomicamente e apenas uma vez a estimativa refinada, antes dos hashes do cache, classificação e exportação. Alterar o classificador conserva a possibilidade de reutilizar a geometria. Os hashes incluem os módulos temporais.

Uma pose congelada sem apoio de imagem não continua indefinidamente: a manutenção sem fluxo expira após 250 ms de lacuna; recuperação apenas por fluxo fica limitada a dois segundos. Oclusão explícita produz ausência de estimativa. Intervenção confirmada e remoção encerram o desenho. Esses limites são parâmetros de engenharia, ainda sujeitos à validação.

## Separação e exportação dos dados

`bodyAxis`, contorno, centro, elegibilidade, qualidade e orientação original permanecem preservados. `oftLayers.visualization` contém os pontos estimados e, em `temporal`, versão, estado da orientação, margem de custos, índice do quadro de apoio e incerteza posicional do filtro. Margem, escore de suporte e covariância não são probabilidades calibradas de acerto anatômico. Toda estimativa tem `metricEligible: false`.

Os pontos canônicos classificados como recuperados representam a estimativa refinada; os campos brutos desses pontos continuam ausentes e inelegíveis para métricas. Os metadados por quadro conservam o eixo e a orientação originais. Os centros observados usados para locomoção não são substituídos pelos pontos suavizados. A reconstrução de vídeos Colab históricos usa uma pasta própria e preserva o CSV original.

SVG, Canvas, MP4 local e MP4 Colab usam a mesma representação visual. A cabeça recebe um triângulo e a base da cauda um círculo discreto, sem textos sobre a imagem. Orientação desconhecida conserva o caminho corporal e omite os marcadores anatômicos.

Versões: motor `opencv-box-17`, cabeça `axial_tail_foreground_v3`, continuidade `image_flow_and_mask_v1`, refinamento `offline_pose_v1`, MP4 local `local-audit-9` e MP4 Wistar `oft-layered-video-6`. A análise OpenCV histórica precisa ser executada novamente para recalcular a orientação; atualizar somente seu MP4 preserva as observações salvas. A reconstrução Wistar verifica também a versão do refinamento temporal.

## Reprodução no vídeo real

Artefatos privados em `artifacts/oft-orientation-continuity-2026-11-26/offline-motion/`, excluídos do Git. `audit_offline.py` compara todos os campos originais, registra hashes e conserva as observações anteriores ao refinamento em `forward-samples.jsonl`.

| Indicador | Resultado |
| --- | --- |
| Quadros originais | 7.356 |
| Quadros anteriores à suspensão | 7.303 |
| Caminho visual disponível antes da suspensão | 7.303 / 7.303 |
| Caminho baseado no eixo geométrico atual | 4.080 |
| Caminho recuperado da silhueta atual | 3.223 |
| Quadros ativos com orientação estimada | 6.884 / 7.303 (94,26%) |
| Quadros ativos com orientação desconhecida | 419 (5,74%) |
| Campos originais fora de `oftLayers` | Todos iguais |
| Estimativas elegíveis para métricas | 0 |
| Execução de Colab/GPU | Não realizada |

Nos quadros inspecionados de 51 e 52 s, o focinho estimado está à esquerda e o corpo curvado permanece representado. Aos 160,542 s, a cabeça passa a apontar para baixo, de acordo com a imagem. Aos 3,875 e 15,542 s, o refinamento conserva a geometria e sinaliza orientação desconhecida diante das evidências conflitantes.

A verificação não encontrou reversões acima de 90 graus em pares consecutivos com orientação disponível, considerando o transporte pela imagem quando disponível. Esse diagnóstico não mede a taxa real de inversões: lacunas de orientação e erros persistentes podem escapar dele. Não há anotações anatômicas humanas suficientes para demonstrar 99% de acerto, IoU corporal ou erro absoluto das extremidades.

## Verificação e trabalho restante

A suíte Python terminou com 345 testes executados, 344 aprovados e um teste específico de Windows ignorado nesta plataforma. Passaram também 227 testes de frontend, 107 testes Rust e oito regressões de interface em Chromium/WebKit. O build de produção, os tipos da aplicação e dos testes e a verificação de espaços do diff passaram. O build conserva o aviso anterior de tamanho do bundle JavaScript.

O MP4 `offline-motion/audit.mp4` foi renderizado e decodificado integralmente, com 7.356 quadros. O relatório `offline-verification.json` registra o hash do arquivo e a comparação dos 7.356 timestamps com o vídeo de origem; o maior desvio reportado pelo FFprobe foi de 0 s na precisão de saída dessa ferramenta. O quadro exportado de 51 s também foi inspecionado.

Os testes exercitam inversão isolada, consenso futuro, empate sem identificação arbitrária, movimento de ré, mudança de sinal do PCA, giro de 180 graus, timestamps irregulares, redução de jitter, limites da máscara, recuperação retrospectiva por pixels, perdas longas, cancelamento, gravação atômica, interrupção e preservação do centro bruto. A integração verifica o CSV canônico, cache, renderização e empacotamento dos mesmos módulos para local e Colab. A interface tem regressões de busca em Chromium e WebKit.

As etapas de rede anatômica e classificador temporal de episódios ainda exigem dados apropriados. O usuário possui um vídeo integralmente revisado com 40 ápices de rearing; eles não contêm posições anatômicas nem início/fim dos episódios. Na execução mostrada não existe modelo de rearing instalado. O modelo experimental anterior registra precisão temporal de 18,18% e recall de 100% em um recorte desse único vídeo, sem validação independente. Ele não foi promovido a um detector preciso de episódios.

Nenhum modelo de quatro landmarks foi treinado com rótulos inventados. Treinamento anatômico, classificação de episódios, metas de precisão/recall e validação em outras sessões permanecem pendentes.

## Correção posterior: inversão após 13 s

O usuário identificou nova inversão perto de 13 s. Foi usada a execução local mais recente, já produzida com `offline_pose_v1`. O focinho estava identificado corretamente aos 13 s; depois de um pequeno intervalo incerto, o marcador reaparecia na extremidade da cauda aos 14 e 14,5 s.

A causa estava no estado único de orientação desconhecida do Viterbi: as transições de uma orientação para desconhecido e depois para a orientação oposta custavam menos que a troca direta. Assim, a incerteza podia apagar a identidade das extremidades. A checagem anterior apenas de pares consecutivos com cabeça disponível não detectava esse tipo de troca.

`offline_pose_v2` mantém duas hipóteses internas também durante a incerteza. Ficar incerto pode ocultar o rótulo, mas conserva o custo de associação de cada extremidade. Quando uma transformação de fluxo validada transporta os mesmos pontos corporais, uma associação que inverte esse sentido não é aceita. Giros reais continuam permitidos pelo transporte da rotação. O alinhamento dos sete pontos para a suavização também utiliza essa direção interna, inclusive nos quadros sem marcador anatômico.

Foram adicionadas regressões com propostas contrárias persistentes, com e sem fluxo óptico. No caso sintético de identidade conhecida e movimento de imagem validado, o decodificador antigo marcou 19 quadros com orientação trocada; a versão nova marcou zero. Isso comprova a regressão do algoritmo nesse exemplo, sem representar uma taxa de acerto no vídeo biológico.

O refinamento foi reproduzido sobre os 7.356 registros salvos da análise indicada. Foram preservados todos os campos brutos, métricas e evidências originais de orientação. Continuam disponíveis 7.303 caminhos corporais antes da suspensão; 7.060 quadros ativos têm orientação estimada e 243 ficam indeterminados. A inspeção das imagens confirmou a correção aos 13, 13,333, 13,583, 14 e 14,5 s, além de preservar os casos anteriores de 51, 52 e 160,542 s. Disponibilidade continua distinta de acurácia anatômica.

A comparação, o vídeo de seis segundos correspondente ao trecho original de 11 a 17 s e os hashes estão em `artifacts/oft-orientation-continuity-2026-11-26/reversal-13s/`, excluídos do Git. O clipe foi decodificado com seus 144 quadros esperados. Essa reprodução refina a geometria salva; não representa nova detecção neural ou execução de Colab/GPU.

Versões após a correção: motor `opencv-box-18`, refinamento `offline_pose_v2`, MP4 local `local-audit-10` e MP4 Wistar `oft-layered-video-7`. A importação continua aceitando metadados antigos `offline_pose_v1`. Para recalcular as observações de uma análise OpenCV histórica no aplicativo, é necessária uma nova análise; trocar apenas o MP4 não recalcula sua orientação.

Após essa correção, a suíte Python passou com 347 testes executados (346 aprovados e um teste específico de Windows ignorado). Passaram também os 227 testes de frontend, 107 testes Rust, build de produção e verificação de tipos da aplicação e dos testes. As duas regressões novas verificam a preservação das identidades durante incerteza com e sem fluxo óptico. Não houve mudança no desenho da interface nesta etapa; a renderização do clipe e os testes de SVG/Canvas cobrem o consumo da representação temporal revisada.
