# Auditoria de escopo · Rearing Detection V1

Esta auditoria usa a especificação anexada ao pedido e distingue implementação, execução técnica e precisão científica. O objetivo completo **ainda não foi atingido**: o usuário informou possuir vídeo com rearing, mas ainda não existem anotações humanas disponíveis para este trabalho. Não há pesos supervisionados de rearing nem validação em vídeos independentes. Os testes sintéticos abaixo verificam contratos e execução; seus rótulos não representam animais reais.

| Item da especificação | Evidência no estado atual | Situação |
| --- | --- | --- |
| 1. Camada de comportamento independente do tracking | `python/behavior/`, `local_behavior.rs`, `behavior_jobs`, política de observação separada | Implementado e testado em CPU com fixtures |
| 2. Tecnologias e isolamento de FST/RAM | FFmpeg/FFprobe, OpenCV/NumPy, ONNX CPU, React/Rust, SQLite/JSONL; PyTorch apenas no treinamento | Implementado; regressão local passou; execução real de três plataformas pendente |
| 3. Qualidade comportamental separada da geometria | `observation_quality.py`; `observationUsable` das métricas permanece com a política anterior; candidatas rejeitadas mantêm pixels/caixas para contexto | Implementado; efeito na sensibilidade real ainda precisa de dados |
| 4. Skeleton e features de silhueta | `silhouette_features.py`, descritores invariantes à inversão do eixo e aspect ratio orientado, máscaras de validade | Testes de geometria/rotação passaram; validade comportamental pendente |
| 5. Movimento interno | `motion_features.py`, Lucas–Kanade/Farnebäck em 96 px, translação residual compensada | Implementado e comparado no DD2; discriminação entre comportamentos pendente |
| 6. Estrutura dos módulos e scripts | Todos os módulos nomeados estão em `src-tauri/python/behavior`; scripts, notebook e quatro JSONs em `models/oft_rearing_v1` | Implementado; manifesto declara ausência de treinamento |
| 7. Dynamic ROI em vídeo original, duas passagens | `crop_extractor.py`, `open_field.py`, escala de sessão fixa, PTS verificados, recorte de contexto recuperado curto e incerto | Executado no DD2 e em vídeo VFR sintético; padding apenas de fundo registrado |
| 8. MobileNetV3-Small | `networks.VisualEncoder`, fine-tuning supervisionado e cache de embeddings | Código preparado; treinamento/execução neural real e equivalência PyTorch/ONNX neural pendentes |
| 9. TCN e classificação hierárquica | `RearingTCN`, 31 amostras, dilatações 1/2/4/8, máscaras, saídas rearing/subtipo | Código preparado; pesos, sensibilidade e precisão pendentes |
| 10. Estúdio e manual de anotação | Modal com vídeo, PTS, caixa/eixo, atalhos, intervalos humanos, desfazer e histórico; `OFT_REARING_ANNOTATION_PROTOCOL.md` | Interface verificada em navegador com Tauri simulado; uso por pesquisador no app instalado pendente |
| 11. Dataset e rastreabilidade | ZIP/CSV/JSONL, SHA-256, animal/sessão/arena, divisão por componentes conectados | Implementado; dados científicos reais ainda não fornecidos |
| 12. Notebook e modelos A/B/C/D | Notebook com 12 etapas, Random Forest, visual, visual+TCN e híbrido, mesma divisão e normalização apenas no treino | Baseline/avaliação executados somente com fixtures; Colab, comparação real dos quatro modelos e curvas de aprendizagem pendentes |
| 13. Event decoder e relógio | Histerese temporal, início retrospectivo, duração mínima, gaps desconhecidos, não unir postura quadrúpede confirmada, PTS originais | Testes temporais/VFR passaram; limiares ainda são valores de desenvolvimento |
| 14. ONNX e otimização | `onnx_inference.py`, batches, embeddings únicos, threads CPU limitadas, exportador com verificação de paridade | RF/ONNX CPU verificado; encoder/TCN treinados e comparação FP32/INT8 pendentes |
| 15. Entrega de modelos | Hash/tamanho, manifesto, cache, publicação temporária/atômica, importação local e URLs versionadas opcionais | Integridade, offline e cancelamento testados; download real de release de rearing pendente de pesos/publicação autorizada |
| 16. Tauri, persistência e empacotamento | Comandos registrados, migration 004, `include_str!` de todos os módulos, origem do vídeo/tracking verificada, jobs/cancelamento/recuperação | Rust compilado/testado; instaladores e interação macOS/Windows/Linux ainda não verificados |
| 17. Artefatos e proveniência | `request/status/log`, manifesto, features, embeddings, predições, CSV/JSON de eventos, métricas, qualidade e ZIP; revisões separadas | Pipeline sintético completo passou; sem resultados biológicos |
| 18. React e seleção por execução | Aba Rearing, anotação/detecção/revisão, escolha persistida por tracking/hash e verificação de origem | Browser verificou execução antiga, troca de aba e troca de tracking sem misturar métricas |
| 19. Vídeo e overlay | `local_audit_video.py` aceita predições salvas; mantém caixa/eixo/gráfico, acrescenta label/score e cor | Vídeo VFR regenerado com mesmos PTS em fixture, sem reexecutar tracking/classificador |
| 20. Resumo e métricas | Exploração vertical integrada ao resumo, cobertura/tempo desconhecido, subtipos, frequência, latência censurada, revisão e exportações | Implementado; valores reais dependem de modelo e revisão |
| 21. Aprovação científica | Avaliador por sessão/condição/subtipo, tIoU um para um, frame/event F1, erros, cobertura e independência do treino; sessões negativas tratadas separadamente | Avaliador técnico testado; nenhuma meta científica demonstrada em animais reais |
| 22. Benchmark DD2 | 7.356 frames/PTS reaproveitados; extração separada e comparação dos dois métodos de flow | Extração medida; tempo do encoder/TCN treinado, tamanho real, benchmark completo e FP32/INT8 pendentes |
| 23. Testes obrigatórios | Contratos de rotação, paredes, previsões/reflexos/identidade, gaps, episódios, VFR, cancelamento, integridade, seleção, migração e regressão de protocolos | Testes de software passaram; walking/grooming/rearing apoiado/sem apoio em vídeos anotados e paridade neural real não demonstrados |
| 24. Sequência de etapas | Alterações mantidas locais, sem commit/push/PR/publicação | Organização técnica preparada; etapas de coleta/treinamento/validação continuam abertas |
| 25. Restrições científicas | Sem altura física derivada da caixa, anatomia inventada, autorrótulo como ground truth ou métricas definitivas | Preservadas; manifesto e UI continuam experimentais |

## O que falta para atingir a precisão solicitada

1. O pesquisador deve anotar o vídeo no estúdio, incluindo exemplos claramente negativos e trechos incertos. Um vídeo inicia o dataset; não demonstra generalização.
2. Coletar sessões de animais independentes, com identificação consistente de animal/sessão/arena, para treino, validação e teste. Trechos não anotados não viram negativos.
3. Executar e comparar A/B/C/D; ajustar normalização/decoder somente com treino/validação e registrar aprendizagem conforme a quantidade de dados.
4. Avaliar vídeos completos independentes e revisar falsos positivos/negativos. Medir concordância humana e relatar condições cobertas, limitações da câmera superior, F1, erros e cobertura.
5. Exportar os pesos escolhidos, verificar paridade neural, medir o classificador no computador de referência e comparar FP32/INT8 antes de distribuir INT8.
6. Verificar a interação e o empacotamento reais nas plataformas suportadas. Publicação/Git continuam sob controle do usuário.

Até existir essa evidência, o estado correto é implementação experimental disponível para anotação e desenvolvimento de modelo, com precisão de rearing ainda não estabelecida.
