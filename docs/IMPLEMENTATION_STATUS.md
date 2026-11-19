# Estado da implementação

## Radial Arm Maze (RAM)

- [x] Terceiro protocolo independente, com wizard de vídeo, contorno único da área transitável, oito potes e quatro recompensas configuráveis.
- [x] Contratos TypeScript/JSON Schema, hash versionado da máscara e motor determinístico inicial de escolhas para geometrias antigas com braços definidos. A preparação com contorno único não produz eventos por braço.
- [x] Tela de preparação e exportação da configuração; resultados científicos não são apresentados sem tracking aprovado.
- [x] Rota Colab RAM experimental com detector Wistar v2, HRNet, SHA-256, máscara da área transitável, centros observados por frame, QC e artefatos brutos. Não produz visitas nem erros de memória.
- [ ] Importação persistente dos artefatos V11/V12/V13, editor de revisão e integração do futuro bundle treinado especificamente para RAM.
- [ ] No pacote V13 auditado, validar R05/R15 visualmente, medir eventos contra referência humana e executar uma sessão completa em Colab.

Detalhes, auditoria e pendências: [RAM_CONTRACT.md](RAM_CONTRACT.md).

## Nado Forçado (FST)

- [x] Wizard e contrato próprios para um ou dois sujeitos e ROIs fixas de cilindros, sem parâmetros de arena OFT.
- [x] Rota Colab FST separada, SuperAnimal Quadruped/HRNet-w32, caixas visuais antes da pose e checkpoints vinculados ao código, vídeo, modelo e ROIs.
- [x] Presença visual v6.4 adaptada para início com animais presentes, caixas dinâmicas exportadas por frame, MP4 e resultados por animal.
- [x] Indicadores de atividade, revisão humana temporal e exportações independentes; classificação automática permanece `NOT_CLASSIFIED`.
- [x] Build e testes TypeScript, além de testes CPU locais para presença, caixas por frame e contrato de inferência com runner simulado.
- [ ] Executar o pipeline novo com DeepLabCut 3.0.2 e CUDA no Colab; o teste local não exercita o modelo nem a codificação MP4 real.
- [ ] Confirmar uma execução FST real no Colab com CUDA, comparar presença, caixas e pontos em frames anotados e avaliar outras condições de iluminação antes de afirmar validade geral.

Detalhes e limites: [FST_CONTRACT.md](FST_CONTRACT.md).

## Fluxo ativo

- [x] Criação de experimento, upload do vídeo e calibração da borda e do chão.
- [x] Conta Google e seleção de runtime A100/H100 para a análise adaptada.
- [x] SuperAnimal TopViewMouse com os parâmetros do Teste B e importação do HDF5 pós-adaptação.
- [x] Rejeição de contagem de frames divergente antes de gerar trajetos ou métricas.
- [x] Versão C: centro corporal do Teste B com corte de confiança, filtro estatístico de picos isolados, suavização temporal e revisão manual; coordenadas brutas preservadas.
- [x] Vídeo rotulado com caixas e corte visual de confiança em 0,50.
- [x] Resultados de campo aberto e exportação de poses, correções e métricas.
- [x] Contratos versionados para engine, bundle, oclusões, mapa temporal e revisões por execução.
- [x] Componentes puros experimentais do pipeline Wistar D+F: detecção, filtro F+C, QC e triagem de rearing.
- [x] Registry local e manifest determinístico para checkpoints, artefatos e contagens de frames D+F.
- [x] Bundle `wistar_df_v1` validado localmente e preparado para upload remoto com SHA-256.
- [x] A rota Colab preserva D+F; métricas, trajetória, calibração e vídeo revisado ficam no aplicativo.
- [x] Teste híbrido, treino personalizado e teste curto de rastreamento permanecem fora da interface principal.
- [ ] Confirmar a API DLC PoseConfig/VideoIterator no runtime Colab e publicar as 27 poses HRNet; o upload e o preflight do bundle já estão conectados.
- [ ] Validar uma execução completa nesta versão com conta Colab A100/H100 e vídeo real.
- [ ] Comparar os pontos e a posição corporal com frames anotados manualmente antes de usar as métricas para conclusão científica.

## Análise local após criar o experimento

- [x] A entrada no aplicativo permite acesso local sem conta Google; a conexão permanece necessária para iniciar Colab.
- [x] Campo Aberto oferece OpenCV para caixas e trajetória 2D, com progresso, cancelamento, histórico e revisão. As métricas locais exigem aprovação explícita do centro da caixa como referência 2D; a ausência dessa aprovação não vira uma detecção válida.
- [x] Nado Forçado oferece presença visual por cilindro, com `IN_TANK`, `NOT_IN_TANK` e `UNCERTAIN` independentes de pose. O resultado local mantém `NOT_CLASSIFIED`, sem inferir imobilidade, natação ou escalada.
- [x] Labirinto Radial oferece centros de caixas observadas dentro do contorno salvo, com revisão visual e histórico. Não produz visitas, erros de memória ou recompensa.
- [x] Os jobs locais usam o banco e os diretórios do aplicativo, registram o SHA-256 do original na primeira execução e o conferem nas seguintes, e preservam timestamps do FFprobe. O OpenCV usa CPU por padrão; OpenCL pode ser solicitado manualmente para operações compatíveis de Campo Aberto e RAM quando uma GPU OpenCL utilizável for detectada. A habilitação automática aguarda benefício consistente em benchmark.
- [x] O motor local de Campo Aberto e RAM reduz conversões de cor ao recorte dos contornos candidatos e verifica a estabilidade da câmera com pontos visuais distribuídos na área analisável, excluindo a caixa inicial do animal. Quando detecta deslocamento confiável, marca o intervalo entre verificações como incerto, preserva as coordenadas observadas e exclui esses frames das métricas. Sem pontos estáticos suficientes, informa que a verificação ficou indisponível.
- [x] Benchmark técnico em um vídeo real de Campo Aberto (7.356 frames): tempo completo 55,80 → 47,96 s, coordenadas pareáveis idênticas, estados idênticos após corrigir um falso alerta no final. Deslocamento e obstrução controlados sobre frames reais também foram medidos. O pico de RAM do Python aumentou. [Resultados e método](reports/LOCAL_BENCHMARK_2026-11-18.md).
- [x] Filtro 1€ experimental e comparação isolada com F+C sobre 27 séries de pose já existentes, preservando observações brutas e reiniciando após lacunas. O comparador conta lacunas e passos grandes; um benchmark sintético mede erro e atraso contra coordenadas geradas. O template de auditoria encontrado em Downloads tem 302 linhas sem caixas humanas preenchidas. O 1€ permanece fora das métricas científicas, pois não há anotação humana aprovada e, no movimento periódico sintético, ele aumentou o erro.
- [x] Editor de referência humana acessível nos resultados dos três protocolos, com plano de amostragem, SHA-256 do vídeo, anotadores independentes, visibilidade/oclusão, revisão por outra pessoa e histórico de alterações em migration SQLite versionada. As anotações ficam separadas das predições e das métricas existentes.
- [x] Seleção reprodutível de 300 frames e 20 clipes de 4 s em gravações reais disponíveis, com um vídeo inteiro reservado para holdout. As categorias de comportamento continuam sem rótulo até revisão humana. O comparador de filtros só calcula MAE/RMSE/PCK em pontos humanos aprovados e pareados no mesmo relógio; sem esses pontos, informa medidas descritivas e erro espacial nulo/indisponível.
- [ ] Concluir a anotação e aprovação humana, medir erro espacial e temporal em vídeos reais e validar concordância entre observadores. O piloto não determina suficiência estatística por protocolo.
- [x] O [guia do piloto](reports/VALIDATION_GUIDE_2026-11-18.md) descreve importação, anotação, revisão, exportação, comparação dos filtros e reprodução do benchmark local.
- [x] Benchmark sequencial de três gravações reais de Campo Aberto, com aquecimento e duas repetições de `HEAD`/atual e CPU/OpenCL, hashes, recursos, cobertura válida, P95 e tempos por etapa na versão atual. A GPU Intel Iris Pro foi mais lenta que CPU nos três casos; no segundo vídeo, a configuração segmentou a parede e gerou 0% de frames válidos. [Resultados e limitações](reports/VALIDATION_GUIDE_2026-11-18.md).
- [x] Build TypeScript, testes de métricas/contratos, testes Rust do motor local e smoke test local com vídeo sintético para OFT/RAM e presença FST.
- [ ] Validar os três fluxos na aplicação desktop empacotada com vídeos reais e anotações humanas; medir cobertura, erro espacial, presença, tempo e uso de CPU/GPU por sistema operacional.
- [ ] Exportar e validar equivalência de modelos neurais para runtime local antes de oferecer pose anatômica local. ONNX/OpenVINO/Core ML/DirectML ainda não estão integrados.

Execuções e anotações anteriores não são apagadas. A leitura de resultados OpenCV antigos continua disponível.
