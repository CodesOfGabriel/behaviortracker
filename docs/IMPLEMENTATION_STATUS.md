# Estado da implementação

## Fluxo ativo

- [x] Criação de experimento, upload do vídeo e calibração da borda e do chão.
- [x] Conta Google e seleção de runtime A100/H100 para a análise adaptada.
- [x] SuperAnimal TopViewMouse com os parâmetros do Teste B e importação do HDF5 pós-adaptação.
- [x] Rejeição de contagem de frames divergente antes de gerar trajetos ou métricas.
- [x] Versão C: centro corporal do Teste B com corte de confiança, filtro estatístico de picos isolados, suavização temporal e revisão manual; coordenadas brutas preservadas.
- [x] Vídeo rotulado com caixas e corte visual de confiança em 0,50.
- [x] Resultados de campo aberto e exportação de poses, correções e métricas.
- [x] Análise local, teste híbrido, comportamentos, treino personalizado e teste curto de rastreamento removidos da interface e da criação de jobs.
- [ ] Validar uma execução completa nesta versão com conta Colab A100/H100 e vídeo real.
- [ ] Comparar os pontos e a posição corporal com frames anotados manualmente antes de usar as métricas para conclusão científica.

Execuções e anotações anteriores não são apagadas. O backend conserva leitura de resultados OpenCV antigos para que os experimentos salvos continuem acessíveis.
