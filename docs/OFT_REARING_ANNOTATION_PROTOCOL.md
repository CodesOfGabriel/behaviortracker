# Protocolo de anotação de rearing · V2

Abra um experimento de Campo Aberto, conclua o **OpenCV rápido** em **Análise** e abra **Rearing → 1. Anotar vídeo → Abrir estúdio de anotação**. Selecione a execução correspondente ao vídeo. Não é necessário instalar um modelo neural para anotar.

O estúdio abre a revisão automática: vídeo e timeline ficam fixos à esquerda, sugestões à direita. Na tela de revisão, apenas a lista de cards tem rolagem. ✓, × e a tag salvam no próprio card, sem alternar para Anotação. Os botões de ápices, episódios, exemplos e pontos corporais abrem as ferramentas manuais quando necessário.

1. Informe seu identificador em **Anotador**. Ele é mantido durante esta sessão da aplicação, inclusive ao sair e voltar à aba. Selecionar uma marca antiga não troca o anotador atual; alterações preservam a autoria original no histórico.
2. Reproduza o vídeo. Use 0,5× ou 0,25× para trechos difíceis.
3. No ápice observável do rearing, pressione **R** ou **Marcar ápice agora (R)**. O vídeo pausa e uma barra aparece na timeline.
4. Escolha o tipo no painel à direita e clique em **Salvar marcação**. A barra registra o timestamp PTS e o índice do frame apresentado.
5. Clique na barra para rever o instante, alterar o tipo ou desfazer a marcação. **Descartar marcação** remove uma marca ainda não salva.
6. Para completar os ápices existentes, escolha **2. Episódios**. O vídeo abre antes do primeiro ápice pendente. Marque **início (I)** e **fim (F)**, confira se o ápice está dentro do intervalo e clique em **Salvar episódio e próximo**. O estúdio carrega o próximo ápice sem criar limites automaticamente. A ligação `peakId` preserva o instante e a autoria do ápice original.
7. Para novos intervalos e exemplos negativos, escolha **3. Exemplos e incertezas** ou **Anotar intervalo**, selecione o comportamento, marque início e fim e use **Salvar intervalo**. Para **Não rearing** ou **Incerto**, selecione também o tipo de exemplo: caminhada/farejamento, grooming, giro, parede, reflexo/sombra, entrada do pesquisador ou outro. A categoria descreve o exemplo, sem mudar seu rótulo comportamental.
8. Para corrigir um intervalo salvo, desfaça esse intervalo na lista e anote os limites corretos; o registro original permanece no histórico. Descartar um intervalo em edição não desfaz intervalos salvos.
9. Use **Exportar para treinamento** para abrir a preparação do ZIP, conferir sessão e arena e clicar em **Preparar ZIP**. Em **Mais opções**, os botões CSV exportam cada tipo de anotação separadamente; **Ver anotações salvas** abre o histórico de ápices/intervalos. O pacote inclui imagens dos quadros com pontos corporais, mesmo quando o vídeo completo não é incluído.

Ápices são instantes, sem duração atribuída. **Exportar ápices CSV** e `annotations/peaks.csv` no ZIP mantêm esses pontos separados de `intervals.csv`. O treinamento temporal atual exige intervalos completos, incluindo exemplos negativos; não converte um ápice em um episódio. Alterações de tipo e desfazer preservam o histórico original.

## Revisar sugestões no próprio card

No painel **Detecção automática**, aberto por padrão, clique na sugestão para conferir o vídeo e use **✓** para confirmar rearing ou **×** para rejeitar. Informe seu identificador em **Anotador** uma vez por sessão. A confirmação salva um ápice humano no frame sugerido, com apoio indeterminado por padrão. O seletor **Tag** é opcional: escolha **Com apoio** ou **Sem apoio** antes de confirmar ou altere depois; em um card confirmado, a mudança é salva imediatamente. **Sem tag** mantém o apoio indeterminado. O ícone **Configurar detecção** abre modelos locais e informações detalhadas da busca, mantendo os cards livres desses controles.

As decisões permanecem ao reabrir o estúdio. É possível trocar ✓ por × e vice-versa; cada alteração acrescenta registros ao histórico. Confirmar um frame já marcado reutiliza o ápice e preserva sua autoria original no histórico. Rejeitar uma confirmação desfaz o ápice; se ele já tiver um episódio completo, revise e desfaça o intervalo antes. Os limites estimados do detector não viram duração anotada. A rejeição registra apenas a decisão sobre aquele instante, disponível no histórico JSONL e no ZIP; para fornecer um intervalo negativo ao treinamento temporal, anote seu início e fim em **Anotação**.

| Tecla | Ação |
| --- | --- |
| Espaço | Reproduzir / pausar |
| ← / → | Frame anterior / próximo, usando os PTS do vídeo |
| R | Marcar ápice; no modo intervalo, marcar início / fim |
| I / F | Marcar início / fim no modo intervalo |
| 1 | Rearing com apoio |
| 2 | Rearing sem apoio |
| 3 | Rearing com apoio indeterminado |
| U | Selecionar incerto e marcar no modo atual |
| Ctrl Z / ⌘ Z | Desfazer a última marca ou intervalo salvo |

Os atalhos funcionam quando o estúdio tem foco, fora dos campos de edição. O avanço usa os tempos dos frames; não presume frame rate constante. A reprodução do navegador e a imagem efetivamente apresentada ainda precisam ser conferidas no aplicativo instalado em cada plataforma.

## Rótulos

- **Rearing com apoio:** elevação observável, com evidência visual do contato das patas anteriores com a parede. Estar perto da parede não basta.
- **Rearing sem apoio:** elevação observável e ausência observável de apoio das patas anteriores.
- **Rearing com apoio indeterminado:** rearing observável, mas contato com a parede não distinguível pela câmera superior.
- **Não rearing:** postura claramente observada sem rearing. Inclua caminhada em todas as orientações, grooming, repouso, giros e investigação da parede com quatro patas no piso.
- **Incerto / não observável:** oclusão, reflexo ambíguo, enquadramento insuficiente, ou falta de evidência para separar rearing de movimentos da cabeça. Não adivinhe.

Somente elevar a cabeça não caracteriza rearing. Caixa alta na imagem não mede altura física. O eixo de sete pontos é geométrico e não identifica cabeça, patas ou cauda.

Os intervalos seguem `[início, fim)`: o primeiro instante de postura quadrúpede pertence ao trecho seguinte. Trechos sem rótulo ficam desconhecidos. Para medir falsos positivos, contagem e duração por sessão, revise vídeos completos, incluindo negativos e incertezas. Para treinamento inicial são necessários grupos independentes de animais/sessões para treino, validação e teste; um vídeo serve para iniciar as anotações, mas não estabelece generalização.

Dois pesquisadores devem anotar independentemente uma amostra de sessões antes de adjudicar discordâncias. Registre a versão deste protocolo e as condições da câmera, arena, iluminação e animais.


## Pontos corporais humanos

Abra **4. Pontos corporais**. A lista de sugestões reúne ápices, momentos próximos, centros de intervalos, amostras do vídeo e quadros com tracking incerto. São candidatos para revisão humana, sem posições geradas automaticamente. O limite inicial de 200 sugestões é uma opção de organização, não uma quantidade que garante precisão. Qualquer quadro do vídeo também pode ser anotado.

1. Escolha um quadro sugerido ou avance até o quadro desejado. Clique em **Anotar este quadro**; o vídeo pausa no quadro apresentado.
2. Use **Ampliação da imagem** em 1×, 2× ou 4× para facilitar pontos pequenos; as barras de rolagem permitem navegar sem alterar as coordenadas originais. Clique na imagem para posicionar o ponto selecionado. A lista avança para o próximo ponto ainda pendente. Clique em um nome para reposicioná-lo; arraste o marcador para corrigir. Com a imagem em foco, as setas ajustam um pixel e Shift + seta ajusta cinco.
3. Marque os seis pontos: **nariz**, **orelha esquerda**, **orelha direita**, **centro do tronco**, **centro do quadril** e **base da cauda**. Esquerda e direita são as do animal, independentemente da orientação na tela. Nariz = ponta do focinho; orelhas = centro da porção visível de cada pavilhão; tronco = centro visual do torso; quadril = centro da região pélvica; base da cauda = junção visível entre cauda e corpo. Aplique a mesma definição em todos os vídeos e adjudique posições ambíguas entre anotadores.
4. Quando o ponto não puder ser visto, use **Ponto oculto** ou **Fora da imagem**. As coordenadas ficam nulas, sem inferência a partir do skeleton automático. Não marque uma localização suposta.
5. Clique em **Salvar pontos corporais**. Todos os seis pontos precisam estar classificados e pelo menos um deve estar visível. Para revisar uma anotação salva, volte ao quadro e clique em **Anotar este quadro**. Uma nova gravação acrescenta uma versão ao histórico; não apaga a anterior. Desfazer a revisão restaura a versão humana anterior.
6. Se navegar para outro quadro durante a edição, o estúdio bloqueia o posicionamento sobre a imagem diferente. **Voltar ao quadro da anotação** restaura a imagem correspondente ao rascunho. Salve ou descarte os pontos antes de mudar de modo. Um rascunho só passa a integrar o conjunto após uma gravação bem-sucedida.

O CSV `annotations/poses.csv` guarda os pixels originais, timestamp, índice de quadro, visibilidade, anotador e origem. O ZIP inclui `pose_frames/frame_XXXXXXXX.png`, extraído pelo índice do quadro decodificado, e `annotations/pose_schema.json`. A imagem deve ter as mesmas dimensões das coordenadas; divergências interrompem a exportação. Rótulos de comportamento e pontos corporais continuam separados e nenhum deles altera as observações originais do tracking ou confirma métricas automaticamente.
