# Indicadores geométricos do Campo Aberto local

O modo rápido salva caixas segmentadas com `referenceApproved: false`. A referência usada pelos indicadores anteriores exigia aprovação e, por isso, podia descartar todos os pontos mesmo quando havia caixas observadas no piso. Os cards mostravam “Não mensurável” sem explicar essa distinção.

O Resumo agora oferece duas referências:

- **Referência revisada:** conserva a política `oft-0.2`, seus critérios de qualidade e as correções da execução.
- **Centro da caixa · estimativa no piso:** usa o centro geométrico das caixas observadas e aceitas no piso. Quando uma execução local rápida não tem pares elegíveis na referência revisada, essa visualização é selecionada inicialmente.

A estimativa informa distância, velocidade média, tempo no centro e entradas no centro. Seus títulos indicam que são estimativas e a interface mostra a cobertura temporal e a duração utilizável. Sem pares válidos, o cartão informa a causa; ausência de medidas não vira zero. Os indicadores complementares de Detalhes acompanham a referência escolhida.

## Regras e rastreabilidade

A política separada `oft-floor-box-estimate-1` exige caixas válidas, observações aceitas e geometria suficiente no piso. Exclui previsões, recuperações, perdas, rastreamento incerto, projeções na parede, câmera deslocada e centros fora do piso calibrado. Pares precisam ser de frames consecutivos e ter intervalo de até 0,5 s. Entradas no centro exigem permanência mínima de 0,2 s. Não há interpolação das lacunas.

A transformação para centímetros usa a calibração da arena. Ela não transforma a caixa em anatomia, não valida a segmentação e não autoriza interpretar os trechos desconhecidos como imobilidade. Os percentuais usam somente o tempo classificável. O gráfico de ocupação visual, que também admite posições sem geometria suficiente para medidas no piso, possui um escopo diferente desses indicadores.

Nenhum campo `referenceApproved`, `metricEligible`, status ou registro salvo é promovido para obter números. O cálculo científico existente continua usando sua própria elegibilidade. A exportação `metrics.csv` permanece vinculada à referência revisada; `box_metrics_estimated.json` identifica explicitamente a política estimada, calibração, fonte, correções, cobertura e exclusões. As estimativas não habilitam automaticamente a conclusão científica da análise.

Resultados antigos com caixas e PTS podem usar a nova apresentação sem repetir o tracking nem gerar outro MP4.

## Conferência de 24/11/2026

Nos 7.356 registros já salvos do DD2, a referência revisada permaneceu sem pares elegíveis. A estimativa encontrou 655 quadros aceitos no piso, correspondendo a 23,541668 s de pares consecutivos em 306,458333 s: cobertura de 7,68185%. Nesses trechos, a distância estimada foi de 324,976709 cm e a velocidade média de 13,804320 cm/s. O centro não foi observado nos trechos utilizáveis; isso não demonstra ausência de exploração central em todo o vídeo.

Foram excluídos 6.631 registros por geometria insuficiente, 68 por rastreamento incerto e 2 por previsão/recuperação. Os hashes dos dados salvos e os resultados da referência revisada permaneceram iguais antes e depois da conferência.

O [relatório de verificação](reports/local-floor-box-metrics-2026-11-24.json) separa essa leitura dos dados reais dos testes de interface com fontes fictícias. Passaram 156 testes em 25 arquivos e o build TypeScript/Vite. O navegador conferiu estimativas automáticas, exportação identificada, troca de referência, exclusão de caixas na borda e retorno ao resultado Colab elegível, com comandos Tauri simulados. Não houve nova análise local, execução Colab/GPU ou interação com o aplicativo instalado.
