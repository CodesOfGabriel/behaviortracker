# Estado da implementação

## Nado Forçado (FST)

- [x] Wizard e contrato próprios para um ou dois sujeitos e ROIs fixas de cilindros, sem parâmetros de arena OFT.
- [x] Rota Colab FST separada, SuperAnimal Quadruped/HRNet-w32, checkpoints por vídeo/modelo/ROI e artefatos versionados.
- [x] Presença visual v6.4 adaptada para início com animais presentes, caixas dinâmicas, MP4 e resultados por animal.
- [x] Indicadores de atividade, revisão humana temporal e exportações independentes; classificação automática permanece `NOT_CLASSIFIED`.
- [x] Build, testes TypeScript, Rust e testes CPU de presença/contrato locais.
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
- [x] Novos experimentos usam D+F no Colab; métricas, trajetória, calibração e vídeo revisado ficam no aplicativo.
- [x] Análise local, teste híbrido, comportamentos, treino personalizado e teste curto de rastreamento removidos da interface e da criação de jobs.
- [ ] Confirmar a API DLC PoseConfig/VideoIterator no runtime Colab e publicar as 27 poses HRNet; o upload e o preflight do bundle já estão conectados.
- [ ] Validar uma execução completa nesta versão com conta Colab A100/H100 e vídeo real.
- [ ] Comparar os pontos e a posição corporal com frames anotados manualmente antes de usar as métricas para conclusão científica.

Execuções e anotações anteriores não são apagadas. O backend conserva leitura de resultados OpenCV antigos para que os experimentos salvos continuem acessíveis.
