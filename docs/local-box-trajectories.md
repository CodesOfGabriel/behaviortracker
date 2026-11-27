# Trajetórias locais pelo centro da caixa

Os relatórios experimentais indicados como registros locais não integram a
distribuição pública. Seus resumos históricos abaixo não substituem validação
independente. Veja as [condições de acesso aos dados](../DATASET_CARD.md) e os
[procedimentos públicos de validação](VALIDATION_GUIDE.md).

As trajetórias visuais de Campo Aberto e RAM usam o centro geométrico de cada caixa exibida: `x + width/2`, `y + height/2`. O FST aplica a mesma regra separadamente a cada cilindro, apenas quando há presença e caixa. O ponto desenhado no frame e o caminho usam a mesma referência.

O gráfico anterior de Campo Aberto filtrava `status: valid`. Esse estado também depende das restrições geométricas para métricas no piso; por isso, uma caixa acompanhando o animal junto à parede desaparecia da trajetória. O editor também usava a referência filtrada por elegibilidade científica. A nova função `boxCenterTrajectory` é exclusivamente visual: conserva os campos originais, deduplica as caixas por frame e não altera `metricEligible`, `referenceApproved` ou o cálculo das métricas.

- Verde indica observação sem alertas; âmbar indica caixa com alertas.
- Previsões e recuperações têm tracejados próprios. A mudança de origem não apaga o trecho: o segmento compartilhado conserva a origem menos confiável.
- Ausência de caixa, frame omitido ou intervalo temporal superior a 0,5 s mantém uma lacuna. Não há interpolação visual para preenchê-la.
- Correções de caixa têm prioridade sobre a caixa automática. No RAM, o círculo adicional de revisão humana continua indicando a posição marcada, que pode diferir do centro geométrico da caixa.

## FST local

O motor `opencv-fst-presence-3` mantém a referência pelo percentil escuro e o consenso temporal de presença do FST. Cada cilindro tem associação independente por distância e aparência Lab do núcleo da máscara corporal. Candidatos rejeitados não geram uma caixa prevista. Um corpo tocando ambas as laterais do cilindro pode ser selecionado; o limite anterior de largura podia descartá-lo e deixar somente uma reflexão inferior como alternativa.

A decodificação reduz a resolução em direção a 1280×720, sem ampliar o vídeo e preservando pelo menos 160 px na menor dimensão dos cilindros quando a resolução original permite. Referência e análise usam a mesma geometria. As caixas são reconvertidas para a ROI original; os PTS continuam vindos do vídeo original. `processingGeometry` registra a escala, o espaço das coordenadas e o método de associação. Os descritores de movimento mantêm unidades em pixels originais.

O contrato continua `fst-local-presence-1`, `classification: NOT_CLASSIFIED` e `behaviorMetrics: null`. Não há classificação automática de imobilidade, natação ou escalada. A associação é uma heurística experimental e ainda pode produzir caixas parciais, falhas de identidade ou reflexos.

## RAM local

Na estratégia `classical_roi_v1`, o motor `opencv-box-10` separa a área caminhável do recorte usado para segmentar o corpo. Uma margem morfológica local permite observar a silhueta acima e ao redor das laterais dos braços. Essa margem é calculada a partir da largura da máscara e limitada a 3–16 pixels na resolução de processamento; ela não impõe tamanho à caixa nem acrescenta cauda ao resultado.

O candidato continua precisando ter o centro dentro do polígono calibrado e pelo menos 35% da máscara corporal sobre ele. A referência de área, o polígono, a geometria dos braços, os gates e os critérios de métricas continuam usando a calibração original. Cortes na margem de segmentação ou na borda do vídeo ainda são sinalizados. Assim, uma caixa pode acompanhar o corpo com `localQuality.tracking: observed` e continuar `low_confidence` para medidas junto às bordas dos braços.

A alteração se aplica somente ao RAM clássico com máscara caminhável. Campo Aberto, RAM Color e Colab preservam suas regras de segmentação.

## Verificação

No DD2 já salvo, havia 7.356 caixas e somente 655 frames com `status: valid`. A trajetória nova conserva os 7.356 centros e as 7.355 ligações consecutivas, incluindo duas previsões/recuperações diferenciadas. Os 6.699 frames incertos continuam identificados. Isso corrige a apresentação; não transforma cobertura visual em precisão científica.

Os vídeos de Downloads indicados pelo usuário foram examinados com as calibrações salvas e saídas temporárias, sem substituir jobs do aplicativo. O relatório técnico e as prévias são materiais locais de desenvolvimento, fora da distribuição pública. A revisão dirigida do FST inclui 37–43 s e a falha observada por volta de 40 s no cilindro B. A revisão do RAM usa a máscara poligonal calibrada; braços, plataforma e gates ainda precisam ser completados para métricas de escolhas.

As mudanças de visualização se aplicam também a resultados locais anteriores. Os motores FST e RAM atualizados precisam de uma nova execução, após reiniciar o aplicativo compilado com o Python incorporado. Nenhum resultado antigo é migrado ou regravado automaticamente.


## Ocupação por zona e seleção da execução

Na aba Trajetória de Campo Aberto, o cartão Ocupação por zona permite selecionar uma execução concluída da máquina local ou do Colab. A seleção usa o mesmo carregamento de resultados e as correções da execução escolhida; enquanto ela carrega, o cartão não apresenta o gráfico anterior como se fosse o novo.

O cartão estima a distribuição visual do centro das caixas observadas na calibração da arena. Na ausência de caixa, usa uma referência de pose elegível disponível. Frames omitidos, previsões, recuperações, saltos, alertas de câmera e intervalos acima de 0,5 s são desconhecidos. A distribuição centro/periferia usa o tempo observado e informa separadamente sua cobertura e o tempo desconhecido. Sem intervalos observados, mostra “—”, distinguindo ausência de dados de 0% no centro.

Esse cálculo visual não altera `metricEligible`, aprovações, métricas científicas ou arquivos exportados de tracking. O relatório de interface e continuidade (registro local de desenvolvimento) registra a troca entre duas execuções sintéticas com distribuições distintas, no aplicativo renderizado pelo Chrome com a API nativa simulada.
