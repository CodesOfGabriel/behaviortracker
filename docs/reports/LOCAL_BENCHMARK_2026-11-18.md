# Benchmark técnico da análise local e comparação do filtro 1€

## Escopo

Foi analisada uma gravação real de Campo Aberto já presente no cache do aplicativo: 1.280 × 720 px, 7.356 frames, 24 FPS, 306,5 s. O benchmark executou o motor OpenCV salvo em `HEAD` (`opencv-box-4`) e o motor atual (`opencv-box-5`) com o mesmo vídeo e a mesma configuração, em CPU. Os SHA-256 dos motores, do vídeo e da configuração estão nos relatórios JSON. A referência 2D desta execução não foi aprovada para métricas científicas.

A comparação inclui todas as diferenças entre as duas versões dos motores. O teste mede tempo, recursos e equivalência das saídas; não isola causalmente uma única otimização. Não houve execução no Colab.

Ambiente: macOS 15.8.2, x86_64, Python 3.13.3, OpenCV 4.13.0 e FFmpeg 7.1.1. O OpenCL foi desativado nas duas versões para comparar o caminho de CPU. A revisão de referência em Git era `63ff5091f55a`.

| Cenário | Frames | Tempo `HEAD` | Tempo atual | Mudança no tempo | Coordenadas pareáveis | Diferença máxima | Frames incertos por câmera |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Vídeo real completo | 7.356 | 55,80 s | 47,96 s | −14,0% | 7.046 | 0 px | 0 |
| Trecho real de 20 s | 480 | 4,37 s | 3,41 s | −22,0% | 254 | 0 px | 0 |
| Deslocamento controlado de 8 px por 4 s | 480 | 4,32 s | 3,53 s | −18,3% | 409 | 0 px | 101 |
| Obstrução controlada de 200 × 200 px por 4 s | 480 | 4,38 s | 3,64 s | −16,8% | 410 | 0 px | 0 |
| Início + final da gravação real | 156 | 1,92 s | 1,71 s | −11,1% | 35 | 0 px | 0 |

No vídeo completo, os 7.356 frames mantiveram os mesmos estados e a distância entre observações consecutivas válidas permaneceu em 2.577,45 px nas duas versões. O tempo de CPU do processo Python e subprocessos caiu de 176,32 s para 146,52 s. O pico de RSS do processo Python subiu de 60,34 para 85,18 MiB; o maior subprocesso ficou perto de 138,8 MiB nas duas versões. Esses picos de RSS não são uma soma simultânea da memória do pipeline.

O deslocamento controlado deslocou todos os pixels dos frames 192–287 para a direita. O verificador marcou 101 frames, pois também inclui a margem entre verificações; as coordenadas observadas foram preservadas. A obstrução controlada cobriu parte da textura da arena nos segundos 8–12 e não gerou alerta. Esses dois cenários são transformações artificiais de frames reais, com causa conhecida; não são gravações experimentais independentes.

Uma primeira execução do vídeo completo registrou cinco alertas no final. A inspeção dos frames mostrou uma pessoa entrando na borda externa da imagem, enquanto a arena permaneceu no lugar. O verificador usava pontos dessa borda. Após restringir os pontos à textura distribuída dentro da arena e excluir a caixa inicial do animal, o trecho final e o vídeo completo terminaram sem esses alertas. O [relatório anterior](local-engine-real-full-before-guard-fix-2026-11-18.json) foi preservado para documentar essa correção.

## Comparação de pose: bruto, F+C e 1€

O script de comparação leu um CSV canônico de pose já produzido pelo aplicativo: 7.610 frames e 27 keypoints. Ele usa `timestamp_sec`, `status` e `source` de cada amostra. O filtro 1€ é uma camada experimental independente; observações ausentes ou de baixa confiança reiniciam seu estado. Os dados brutos e o filtro F+C atual não foram modificados. A implementação segue as equações publicadas por [Casiez, Roussel e Vogel](https://gery.casiez.net/publications/CHI2012-casiez.pdf), com parâmetros ainda não ajustados para roedores.

Neste CSV, `timestamp_sec` avança exatamente 0,04 s por frame. Isso é o relógio registrado no artefato de pose; não foi demonstrada sua equivalência ao PTS do vídeo original.

Exemplo do keypoint `mouse_center`:

| Variante | Frames disponíveis | Mediana da segunda diferença | Distância entre pares consecutivos válidos |
| --- | ---: | ---: | ---: |
| Bruto | 922 | 3,31 px | 1.802,75 px |
| F+C mediana | 734 | 0,86 px | 691,45 px |
| 1€, β = 0,001 | 922 | 0,48 px | 571,29 px |
| 1€, β = 0,01 | 922 | 0,57 px | 672,96 px |

A segunda diferença é apenas um indicador de variação temporal: pode diminuir porque o filtro apagou movimento real. As distâncias não são diretamente comparáveis quando a cobertura difere. Sem centros anatômicos aprovados em frames independentes, não há MAE real, atraso real ou evidência de que uma variante seja mais precisa. Os relatórios deixam o MAE real como `null`.

Nos 27 keypoints somados, o script também contou lacunas **internas** e pares consecutivos com deslocamento acima de 15 px. Esse limiar é descritivo e não foi calibrado para separar movimento real de erro.

| Variante | Amostras válidas | Pares consecutivos válidos | Lacunas internas | Pares acima de 15 px | Coordenadas alteradas |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bruto | 19.762 | 14.387 | 5.348 | 482 | 0 |
| F+C mediana | 15.899 | 13.528 | 2.344 | 209 | 12.955 |
| 1€, β = 0,001 | 19.762 | 14.387 | 5.348 | 389 | 14.270 |

Uma coordenada é contada como alterada quando difere mais de 0,01 px do bruto no mesmo frame; isso não significa correção de erro. O F+C descarta mais amostras, inclusive próximas a lacunas; por isso, a contagem menor de saltos não demonstra melhor rastreamento. O 1€ conserva as amostras válidas do bruto e não preenche lacunas. Os [relatórios da pose](local-filter-comparison-2026-11-18.json) e da [variação β = 0,01](local-filter-comparison-beta-0.01-2026-11-18.json) registram as medidas por keypoint.

## Referência humana disponível

Foi inspecionado o arquivo `05_Auditorias_e_Validacao-20261118T145645Z-1-001.zip` em Downloads. O `ground_truth_template.csv` tem 302 linhas, mas nenhuma delas contém valores nas quatro colunas `gt_x1`, `gt_y1`, `gt_x2`, `gt_y2`. O `validation_audit.csv` registra 93 métricas de detecção, sem centros ou keypoints humanos por frame para a série de pose analisada. `tracking_v11_color.csv` é saída automática e não foi usado como referência. O arquivo `trajetoria_H2_para_revisao.csv` não foi encontrado no material local inspecionado. Portanto, nenhuma previsão automática foi tratada como verdade de referência.

## Sinais sintéticos com trajetória conhecida

O [benchmark sintético](pose-filters-synthetic-2026-11-18.json) usa 25 FPS, semente fixa, ruído gaussiano de 2 px por eixo e três trajetórias geradas. O erro abaixo é contra as coordenadas geradas pelo script, não contra uma anotação de vídeo real.

| Sinal | Bruto | F+C mediana | 1€, β = 0,001 | 1€, β = 0,01 |
| --- | ---: | ---: | ---: | ---: |
| Parado com ruído e lacuna: erro médio | 2,47 px | 1,26 px | 0,85 px | 0,91 px |
| Movimento periódico com ruído: erro médio | 2,48 px | 1,57 px | 5,19 px | 3,30 px |
| Degrau limpo de 40 px: atraso até metade | 0 ms | 0 ms | 80 ms | 40 ms |

O F+C usa uma janela centrada que consulta frames futuros; seu atraso de 0 ms no degrau não representa uma execução causal em tempo real. O 1€ suavizou o sinal parado, mas atrasou movimentos e elevou o erro no movimento periódico simulado. Esses resultados não justificam adotá-lo nas métricas científicas do aplicativo. A lacuna sintética de cinco frames permaneceu vazia em todas as variantes.

## Reproduzir e continuar a validação

```bash
python3 scripts/benchmark-local-engine.py --request REQUEST_JSON --python PYTHON_COM_OPENCV --output benchmark.json
python3 scripts/compare-pose-filters.py --pose POSE_CANONICA.csv --beta 0.001 --output filtros.json
python3 scripts/compare-pose-filters.py --pose POSE_CANONICA.csv --reference ANOTACOES_APROVADAS.csv --video-sha256 SHA256_DO_VIDEO_ORIGINAL --annotator OBSERVADOR --output filtros-com-referencia.json
python3 scripts/benchmark-pose-filters-synthetic.py --output filtros-sinteticos.json
```

O CSV de referência deve vir do editor humano e incluir `frame_index`, `timestamp_sec`, `animal_id`, `keypoint`, coordenadas, visibilidade, anotador, revisor, status de aprovação, origem humana e SHA-256 do vídeo. Só referências visíveis com `approved=true` e `status=approved` entram no erro espacial. O comparador rejeita PTS divergentes, séries ausentes e observadores aprovados duplicados sem seleção explícita. O CSV de pose não carrega SHA-256 do vídeo; sua associação ao original precisa ser conferida separadamente. Os arquivos `.summary.csv`, `.paired.csv` e `.md` acompanham o JSON. Para validar precisão e comportamento ainda faltam anotações independentes e revisão visual dos alertas em novas sessões. A análise One Euro não participa das métricas do aplicativo nesta etapa.
