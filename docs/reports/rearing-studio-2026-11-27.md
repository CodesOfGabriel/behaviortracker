# Estúdio de anotação para treinamento de rearing

O estúdio em **Rearing → 1. Anotar vídeo → Abrir estúdio de anotação** ganhou um fluxo para completar episódios, reunir exemplos negativos/incertos e anotar posições anatômicas. Usa os componentes e seletores Radix existentes, com painel lateral, espaçamento entre controles, avanço por PTS e ampliação da imagem. O operador é preservado durante a sessão; selecionar marcações históricas não substitui o identificador atual.

## Uso

1. Selecione o tracking em que as marcações foram salvas. As anotações são vinculadas ao vídeo, SHA-256 e execução de tracking, mantendo sua proveniência.
2. **Ápices:** continue marcando os instantes com R. O estúdio mantém a edição de tipo e o histórico existente.
3. **Completar episódios:** abre o primeiro ápice de rearing sem intervalo humano. Marque início com I e fim com F, ou use os botões/campos. O intervalo precisa conter o ápice; salvar avança para o próximo pendente. Não há limites gerados a partir do ápice, nem conversão de trechos vazios em negativos.
4. **Exemplos e incertezas:** permite registrar caminhada/farejamento, grooming, giro, investigação da parede, reflexo/sombra, entrada do pesquisador e outros. O rótulo observado e o tipo de exemplo ficam separados.
5. **Pontos corporais:** escolha um quadro e clique em Anotar este quadro. Posicione nariz, orelhas, centro do tronco, quadril e base da cauda. O ponto selecionado avança após cada marcação. Arraste para corrigir ou use as setas na imagem; Shift + seta ajusta cinco pixels. Esquerda/direita pertencem ao animal. Pontos ocultos ou fora da imagem têm coordenadas nulas, sem aproveitamento automático do skeleton geométrico.
6. **Ampliação:** 1×, 2× e 4×, com navegação por barras de rolagem. A transformação conserva as coordenadas no vídeo original. A imagem é centralizada após a atualização de tamanho, sem acompanhar continuamente a rolagem do operador.
7. **Exportar para treinamento:** abre a preparação do ZIP completo. Informe sessão e arena. O vídeo completo é opcional; para treinar comportamento em outra máquina é necessário incluí-lo ou fornecer o original separadamente. As imagens dos quadros com pontos sempre acompanham o pacote.

Os quadros sugeridos incluem ápices, momentos próximos, centros de intervalos, amostras do vídeo e observações incertas. O lote inicial de até 200 sugestões organiza o trabalho; não representa um mínimo científico nem uma garantia de desempenho. Quadros escolhidos manualmente e salvos continuam acessíveis na lista, mesmo fora desse lote.

## Integridade

- Novas marcações `POSE_FRAME` usam o histórico append-only existente. Revisar um quadro cria nova versão. A resolução usa a última versão ativa por quadro; desfazer uma revisão restaura a versão anterior.
- O backend verifica PTS, índice de quadro, dimensões originais, seis pontos, limites finitos e coordenadas nulas para pontos não visíveis. É necessário ao menos um ponto visível. Intervalos ligados a ápices exigem origem ativa e contêm o instante em `[início,fim)`.
- Rascunhos permanecem após falha de gravação. Trocas de modo são bloqueadas enquanto há uma anotação em edição. Navegar no vídeo durante edição de pontos bloqueia o posicionamento na imagem errada e oferece voltar ao quadro correspondente.
- O ZIP inclui `annotations/poses.csv`, `annotations/pose_schema.json`, imagens PNG em `pose_frames/`, intervalos, ápices e histórico. A extração seleciona o índice decodificado, preserva a política de orientação e verifica as dimensões. Exportações CSV de intervalos mantêm `peak_annotation_id` e `example_kind`.
- Os arquivos originais, observações de tracking, anotações humanas salvas e modelos existentes não foram reescritos pelas ferramentas desta implementação. Os testes de interface usam IPC simulado e dados sintéticos.

## Validação

- Build TypeScript/Vite aprovado.
- Frontend: 236 testes aprovados.
- Python: 356 testes, 355 aprovados e uma exclusão esperada específica de Windows.
- Rust: 109 testes aprovados; após a atualização do protocolo, os sete testes comportamentais também foram repetidos com sucesso.
- Interface: 18 testes aprovados em Chromium/WebKit, incluindo fila de episódios, exemplos negativos, autoria, navegação, erro de gravação, pontos ocultos e ampliação. A conferência adicional de arraste ampliado e histórico está registrada separadamente nos artefatos.
- O teste de exportação compara o PNG ao quadro decodificado do vídeo de origem, sem inferir anatomia. `git diff --check` sem erros.

Logs, identidade dos módulos e capturas sintéticas ficam em `artifacts/rearing-studio-2026-11-27/`, ignorados pelo Git. A validação não representa interação com um aplicativo instalado, Colab/GPU ou acurácia anatômica/comportamental. Nenhum treinamento de pesos foi executado nesta alteração: as novas anotações humanas ainda precisam ser coletadas e revisadas. Não houve commit, publicação ou alteração em VPS.

A revalidação adicional terminou com **2 testes aprovados**, um por navegador. Ela aguarda a imagem ampliada estar desenhada e o marcador efetivamente receber o clique, arrasta em 2×, verifica o deslocamento em pixels de origem, salva a revisão e confirma que a versão anterior continua no histórico. A centralização passou a aguardar o fechamento do seletor e a estabilização das dimensões. As capturas `pontos-ampliados-1.png` e `pontos-ampliados-2.png` usam exclusivamente o vídeo sintético de teste.
