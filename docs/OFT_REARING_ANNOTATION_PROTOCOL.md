# Protocolo de anotação de rearing · V1

Abra um experimento de Campo Aberto, conclua o **OpenCV rápido** em **Análise** e abra **Rearing → 1. Anotar vídeo → Abrir estúdio de anotação**. Selecione a execução correspondente ao vídeo. Não é necessário instalar um modelo neural para anotar.

1. Informe seu identificador em **Anotador**. Ele é mantido durante esta sessão da aplicação, inclusive ao sair e voltar à aba. Selecionar uma marca antiga não troca o anotador atual; alterações preservam a autoria original no histórico.
2. Reproduza o vídeo. Use 0,5× ou 0,25× para trechos difíceis.
3. No ápice observável do rearing, pressione **R** ou **Marcar ápice agora (R)**. O vídeo pausa e uma barra aparece na timeline.
4. Escolha o tipo no painel à direita e clique em **Salvar marcação**. A barra registra o timestamp PTS e o índice do frame apresentado.
5. Clique na barra para rever o instante, alterar o tipo ou desfazer a marcação. **Descartar marcação** remove uma marca ainda não salva.
6. Para registrar a duração de um episódio, escolha **Anotar intervalo**, marque início e fim com **R** e use **Salvar intervalo**.

Ápices são instantes, sem duração atribuída. **Exportar ápices CSV** e `annotations/peaks.csv` no ZIP mantêm esses pontos separados de `intervals.csv`. O treinamento temporal atual exige intervalos completos, incluindo exemplos negativos; não converte um ápice em um episódio. Alterações de tipo e desfazer preservam o histórico original.

| Tecla | Ação |
| --- | --- |
| Espaço | Reproduzir / pausar |
| ← / → | Frame anterior / próximo, usando os PTS do vídeo |
| R | Marcar ápice; no modo intervalo, marcar início / fim |
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
