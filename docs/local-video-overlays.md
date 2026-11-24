# Eixo corporal e gráfico no vídeo local

O exportador `local-audit-4` reutiliza `samples.jsonl` e seus contornos. Os players de revisão dos três protocolos exibem a linha corporal e o gráfico no canto superior direito. O player usa secções do contorno rasterizado em até 64 px; o exportador pondera as secções pela distância ao fundo em até 96 px. Ambos são aproximações geométricas sem nomes anatômicos. A geração do MP4 acrescenta a visualização sem repetir o rastreamento e sem mudar as observações ou métricas salvas.

## Modo rápido

A silhueta corporal pode receber uma linha central aproximada com até sete pontos. O cálculo usa o eixo principal da máscara e secções transversais, ponderadas pela [distância dos pixels ao fundo](https://docs.opencv.org/4.13.0/d2/dbd/tutorial_distance_transform.html). Trabalha em um recorte de até 96 px, usando as dependências OpenCV/NumPy existentes.

Os pontos são calculados na máscara atual. Silhuetas aproximadamente circulares conservam a última direção visual quando os frames são consecutivos, o intervalo é de até 0,25 s e a caixa permanece próxima; sem essa referência, usam uma secção horizontal sem orientação anatômica. Em máscaras côncavas, conserva-se o maior trecho contínuo válido com pelo menos três pontos. Contornos observados podem exibir a linha mesmo quando a posição não foi aprovada para métricas. Observações incertas aparecem em âmbar, com legenda própria. Perdas, previsões sem máscara e contornos inválidos não recebem um esqueleto inventado a partir do retângulo.

**É um eixo geométrico, sem identificação de cabeça, cauda, patas ou articulações.** A legenda do vídeo informa “Eixo da silhueta estimado - sem identidade anatômica”. Erros na segmentação também afetam o eixo. Ele não alimenta métricas comportamentais ou medidas anatômicas.

O modo **Wistar + HRNet** existente estima 27 pontos nomeados com um modelo neural. O desempenho desse modo em CPU não foi medido nesta mudança. A disponibilidade de uma implementação de [pose online](https://github.com/DeepLabCut/DeepLabCut-live) não garante a mesma velocidade para qualquer modelo e hardware.

## Gráfico no canto superior direito

O painel mostra a velocidade do centro da caixa na imagem, em **pixels por segundo**, ao longo dos últimos dez segundos. O título “DESLOCAMENTO - IMAGEM” e a unidade identificam essa referência visual; não se trata de distância percorrida no piso em centímetros.

- Cada valor usa a distância entre centros de caixas em frames consecutivos dividida pelo intervalo real entre seus PTS.
- Aceitação do rastreamento permite visualizar movimento na imagem, inclusive em regiões com restrição geométrica. Ela não aprova métricas científicas.
- Incertos rejeitados, previsões, recuperações, perdas, saltos de frame e intervalos acima de 0,5 s interrompem a série.
- Lacunas ficam vazias; não viram zeros nem recebem linhas de interpolação. Uma velocidade observada igual a zero continua sendo zero.
- O gráfico é causal: cada frame mostra somente observações anteriores e a atual. A escala vertical se ajusta à janela visível, e pode haver picos por mudanças da caixa ou ruído de segmentação.
- No FST local, cada cilindro tem sua própria série de locomoção, sem agregação entre animais. O eixo corporal também é habilitado quando a execução contém o contorno da máscara corporal; execuções anteriores sem contornos precisam ser refeitas.

O painel segue a posição e a janela temporal do renderizador neural já existente em `hybrid_render.py`, com unidades próprias para as caixas locais. A renderização usa os mesmos [comandos vetoriais ASS](https://aegisub.org/docs/latest/ass_tags/#drawing-commands) do vídeo de auditoria. O fluxo Wistar/HRNet conserva seu renderizador e gráfico calibrado separado.

## Uso e rastreabilidade

Na aba de vídeo da execução local, **Atualizar MP4** reconstrói o vídeo com o renderizador atual; **Baixar MP4** salva uma cópia. Uma nova geração substitui o vídeo derivado somente após a codificação concluir. Os arquivos de rastreamento não são reescritos. Ao selecionar outra execução, o aplicativo apenas carrega seu vídeo existente.

Execuções antigas com contornos podem receber o eixo sem nova análise. Na ausência de contornos, continuam com caixas e gráfico. O arquivo `video_overlay.json` registra a versão, o método geométrico, a ausência de pose anatômica, quantos frames receberam eixo e os parâmetros do gráfico. O fluxo neural continua usando seu `video_artifact.json` próprio.

## Verificação anterior do renderizador de 24/11/2026

O DD2 foi renderizado a partir das observações já salvas:

- 7.356 frames, 1.280 × 720; todos os PTS do MP4 coincidem com os registros originais.
- 156,15 s para gerar o MP4 completo de aproximadamente 61,2 MB, incluindo preparação das anotações e codificação H.264 em CPU.
- Eixo disponível em 5.654 frames; 5.929 pares consecutivos disponíveis para o gráfico. Esses números indicam disponibilidade, não precisão anatômica.
- Em uma amostra distribuída de 503 contornos aceitos, o cálculo isolado do eixo teve mediana de 1,94 ms e percentil 95 de 3,62 ms. Esse tempo exclui gráfico e codificação.

O [relatório de verificação](reports/local-axis-displacement-validation-2026-11-24.json) registra hashes e medições. A [prévia](reports/local-axis-displacement-preview-2026-11-24.jpg) foi extraída do MP4 final.

Passaram o build TypeScript/Vite, 130 testes Vitest, 11 testes Rust locais e os 13 testes Python de renderização local/neural. As regressões cobrem PTS variáveis, posição do painel, desenho efetivo do eixo, exclusão de previsões, lacunas, causalidade e separação entre cilindros. Não houve execução de HRNet, Colab/GPU ou interação com aplicativo empacotado; estes resultados não são validação anatômica independente.

## Três protocolos no player e no MP4

A atualização `local-audit-3` habilita a mesma linha corporal no FST a partir do contorno da máscara corporal, armazenado nas novas execuções. O player local de Campo Aberto, a revisão RAM e o player FST também mostram um esqueleto geométrico com até sete pontos e o gráfico no canto superior direito. Os cilindros do FST usam históricos independentes. Resultados FST anteriores sem contorno exibem uma orientação para refazer a análise.

As prévias abaixo vieram de MP4s efetivamente renderizados em trechos dos vídeos indicados:

- [Campo Aberto](reports/local-open_field-skeleton-motion-2026-11-24.jpg): trecho 20–24 s do DD2.
- [Labirinto radial](reports/local-radial_arm_maze-skeleton-motion-2026-11-24.jpg): trecho 80–84 s.
- [Nado forçado](reports/local-forced_swim-skeleton-motion-2026-11-24.jpg): trecho 37–43 s, com dois cilindros.

O [relatório técnico](reports/local-box-trajectories-validation-2026-11-24.json) registra os processamentos completos, as verificações das trajetórias e as provas de renderização. Os trechos são cópias recodificadas para inspeção; o renderer normaliza o início dos PTS para zero e preserva os intervalos, com diferença máxima de até 2 microssegundos na verificação. Eles não substituem os jobs salvos. A análise completa de FST preservou 11.052 frames e a de RAM preservou 14.514 frames, com os mesmos índices e PTS dos respectivos baselines.

No cálculo isolado do eixo do player, 402 contornos aceitos do DD2 tiveram mediana de 0,65 ms e percentil 95 de 1,47 ms em Node. Isso exclui player, layout, decodificação e gráfico e não mede desempenho de uma aplicação instalada. A verificação final passou 138 testes Vitest, 11 testes Rust locais e 58 testes Python, com um teste específico de Windows ignorado no macOS, além do build TypeScript/Vite.


## Interface e continuidade — local-audit-4

Campo Aberto, Nado Forçado e Labirinto Radial compartilham as abas **Resumo, Vídeo, Trajetória, Detalhes, Análise e Arquivos**. A aba Análise concentra configuração e histórico; os vídeos de auditoria ficam em Vídeo. Os controles de revisão e geometria permanecem em Detalhes. O histórico local e o Colab continuam disponíveis separadamente.

A nova regra visual foi comparada nos 7.356 contornos/caixas salvos do DD2: a disponibilidade da linha passou de 5.654 para 7.354 observações. As duas restantes são previsões sem máscara observada. Isso mede disponibilidade visual, não precisão anatômica. Os registros de rastreamento e a elegibilidade científica não foram alterados.

Trechos reais dos três protocolos foram novamente renderizados com `local-audit-4`: 96 frames no Campo Aberto, 96 no RAM e 180 no FST, este com duas observações por frame. Todos apresentaram linha corporal e painel no canto superior direito; os intervalos normalizados dos PTS foram preservados. O [relatório desta atualização](reports/local-ui-continuity-zones-2026-11-24.json) separa essas provas de vídeo da verificação de interface em Chrome com comandos Tauri simulados. Não houve validação no aplicativo instalado nem execução remota Colab/GPU.

Para vídeos já gerados, use **Atualizar MP4** depois de reiniciar a versão recompilada do aplicativo. Não é necessário repetir o tracking se o resultado já contém contornos.


## Histórico de vídeos e resumo das execuções

A aba Vídeo reúne as execuções concluídas locais e Colab do mesmo experimento, ordenadas por data, com identificação própria e controles de download. Cada player carrega o MP4 sob demanda (`preload="none"`); abrir o histórico não dispara uma nova renderização local. Execuções sem MP4 indicam a ausência do arquivo e, quando disponíveis, oferecem geração local. Os controles sincronizados do FST Colab ficam em Detalhes para revisão dos intervalos.

A aba Análise contém somente o card de acompanhamento da execução. Configuração e histórico ficam recolhidos dentro dele. O botão Referência humana foi removido dos cabeçalhos de resultados dos três protocolos; os dados e as funções existentes de revisão foram preservados.

O Resumo mostra nome informado pelo pesquisador, protocolo, arquivo, duração do vídeo, tempo registrado do processamento, quadros processados, resolução, FPS e data da execução. Seu seletor acompanha a fonte de tracking escolhida. No Colab, o tempo é o intervalo total registrado entre criação e atualização final do job, incluindo fila e transferência; localmente, usa-se `report.elapsedSec`. Metadados históricos ausentes aparecem como não registrados. A contagem de quadros não soma animais ou pontos anatômicos.

Experimentos recentes usa duas linhas por página: seis cards em três colunas, quatro em duas ou dois em uma coluna, conforme a largura disponível. A [verificação desta interface](reports/local-results-history-ui-2026-11-24.json) inclui os três protocolos e as larguras de 1440, 1000, 740 e 390 px, com dados fictícios e comandos nativos simulados. Não representa interação com o aplicativo instalado.
