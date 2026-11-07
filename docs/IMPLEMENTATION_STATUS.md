# Estado da implementação

## Entregue neste corte

- [x] Rastreamento macro local `opencv-box-2`: segmentação clara/escura ou fundo vazio fixo, caixa inicial visual no primeiro frame por clique (posição provisória ajustável) ou arraste (tamanho exato), associação temporal/aparência e caixas em coordenadas do vídeo original. Sem DeepLabCut/GPU nem envio do vídeo para fora do dispositivo.
- [x] Ambiente OpenCV isolado, preparação explícita reutilizada, jobs/configuração/hash no SQLite, leitura incremental, cancelamento e recuperação de estado terminal após reinício. Análise interrompida não é retomada automaticamente.
- [x] Caixa observada/prevista diferenciada no vídeo; previsão expira em até 0,25 s na configuração da interface e fica fora das métricas. Caixa parcial continua visível com aviso de revisão; nenhum ponto anatômico é fabricado.
- [x] Editor macro com desenho, translação, redimensionamento e undo por frame, preservando caixa/coordenadas/origem brutas. Trajeto usa centro geométrico da caixa, não centro corporal inventado.
- [x] Caixas manuais como quadros-chave na timeline: duas marcações preveem geometricamente as caixas intermediárias pelos timestamps do vídeo; uma marcação adicional refina o caminho, e o undo recalcula o intervalo. A prévia roxa e as caixas amarelas são estimativas visuais, não observações nem métricas científicas. Não exige nova execução OpenCV/Colab.
- [x] Seletor de resultados Colab/OpenCV por execução, referências e correções isoladas. Reprocessar/trocar fonte não apaga nem reaplica a revisão anterior. Falha ao carregar mantém o resultado ativo; carregamentos atrasados não vencem uma seleção posterior.
- [x] Compatibilidade com eventos antigos: vínculo conservador quando a origem é conhecida e associação explícita ao Colab quando o projeto já estava no modo local. Nenhum evento é descartado. Episódios comportamentais permanecem ligados ao vídeo, não ao motor.
- [x] Exportações preservam caixas bruta/revisada, procedência, consentimento e fonte/execução no manifesto. Testes numéricos, vídeo sintético com FFmpeg real e interface com ponte nativa simulada verificam edição, alternância, falha de carga e reabertura.

- [x] React + TypeScript + Vite + Tailwind CSS, preparado para Tauri 2.
- [x] Dashboard local e fluxo de criação de experimento OFT.
- [x] Leitura de metadados de vídeo no frontend e captura de frame de referência.
- [x] Compactação local sem perda com FFmpeg/ffprobe, comparação de pixels e timestamps por frame, fallback explícito para original e cache da preparação por upload.
- [x] Marcação e confirmação separadas dos quatro vértices da borda e dos quatro vértices do chão; arraste e teclado em coordenadas da resolução original.
- [x] Validação de quadrilátero e visualização da região central por fração da área.
- [x] Importação do CSV canônico de pose.
- [x] Player/timeline, inspeção de QC e navegação até o próximo problema.
- [x] Correção por arraste/clique, marcação de ponto ausente, confirmação explícita e undo auditável para pontos e comportamentos.
- [x] Editor organizado em abas exclusivas: revisão, comportamentos, exemplos/treino, diagnóstico e execuções. O treinamento separa seleção, anotação e versões; o histórico de correções agora permite navegar e desfazer registros.
- [x] Posicionamento de partes omitidas no resultado, arraste com captura do frame/coordenadas originais, prévia de pontos/segmentos e persistência ao soltar. Trajeto e métricas revisados são recalculados localmente, sem alterar poses brutas nem precisar de novo job Colab. Apenas o ponto de referência do experimento controla distância/zonas; as demais partes não o deslocam implicitamente.
- [x] Métricas exigem pares de frames consecutivos, sem unir linhas omitidas. Timestamps de outras partes preservam o tempo desconhecido quando falta a referência, inclusive no início/fim. Testes numéricos e de interface com vídeo sintético cobrem omissão, reposicionamento, desfazer, bruto/revisado e resultados; não substituem validação científica externa.
- [x] Anotação de início/fim de rearing, grooming e freezing, revisão completa por classe, frequência/duração e exportação de episódios sem duplicar sobreposições.
- [x] Sugestões exploratórias de comportamento, com descarte/confirmação humana; ausência de anotação não é tratada como zero.
- [x] Alternância entre dados brutos e revisados.
- [x] Homografia pixel → piso e métricas locais de distância, velocidade, zonas, entradas, latência, cobertura e imobilidade operacional.
- [x] Exportação de `experiment.json`, `poses_reviewed.csv`, `corrections.jsonl` e `metrics.csv`.
- [x] Testes numéricos iniciais para geometria e métricas SCI-001/002/004/005/006.
- [x] Shell Tauri mínimo com CSP e permissões básicas.
- [x] Configuração e sessão Google OAuth por perfil no SQLite; recuperação do Keychain antigo somente por ação explícita.
- [x] Confirmação do login após persistência da sessão, com atualização do topo por evento nativo e ao recuperar o foco.
- [x] Fluxo OAuth 2.0 para aplicativo desktop com PKCE/S256 e callback loopback.
- [x] Consulta de assinatura e runtimes elegíveis pela Colab API, com erro do provedor visível na interface.
- [x] Job Colab persistido no SQLite, com progresso, falha terminal e recuperação de jobs interrompidos.
- [x] Criação/reuso de runtime GPU elegível e acompanhamento da operação de criação.
- [x] Upload local e remoto do vídeo em blocos, com validação SHA-256 dentro do runtime.
- [x] Pasta de trabalho confirmada entre a sessão Python e a raiz da API Jupyter antes do upload; testes locais com raízes `/` e `/content`.
- [x] Fluxograma horizontal com GPU reportada por `nvidia-smi`, checkpoints persistidos e diário por execução; a falha mantém a etapa original.
- [x] Execução remota resumível via MCP, instalação do DeepLabCut e SuperAnimal TopViewMouse.
- [x] Leitura incremental SSE, retomada após interrupções com o mesmo executionId e preservação da sessão quando o resultado não pôde ser confirmado.
- [x] Validação e reutilização do DeepLabCut/CUDA já disponíveis no runtime; instalação condicional com trava e segunda checagem.
- [x] Instalação e inferência em workers independentes da célula MCP, com lançamento idempotente, estado em arquivo e consultas curtas a cada cinco segundos.
- [x] Progresso do lote atual reportado pelo SuperAnimal, sem usar 100% do detector como conclusão do job; log técnico local consultável na interface.
- [x] Seleção de GPU por resolução/duração do vídeo entre opções elegíveis, priorizando runtimes existentes; decisão registrada no diário.
- [x] Conversão do H5 do DeepLabCut para CSV canônico e importação automática no editor.
- [x] Geometria das duas áreas enviada e registrada por job; ROI inclui borda, chão e margem de 5%, com reposicionamento das coordenadas no vídeo original e sem alterar o H5.
- [x] Preservação de pontos disponíveis em detecções parciais, suporte anatômico do centro explícito, sentinelas normalizadas e trajetória sem ligar lacunas.
- [x] Segunda passagem visual com ROI temporal, pose runner reutilizado, procedência e dados originais no CSV; partes ocultas não são interpoladas.
- [x] Método `oft-0.2`: exclusão de baixa confiança/saltos/recuperações não confirmadas; intervalos inválidos ou longos são desconhecidos, não tempo de ocupação.
- [x] Persistência do CSV retornado no diretório de dados e restauração ao reabrir o experimento.
- [x] Renderização do H5 bruto pelo DeepLabCut, MP4 compatível com o player, validação SHA-256 no download e aba de reprodução sem intervenções do editor.
- [x] Diagnóstico curto (até 60 s), com recorte local sem perda verificado, detector/pose separados e todos os pontos brutos sobre o vídeo local; histórico e exportações isolados da análise científica.
- [x] Relatório diagnóstico com frames sem caixa/pose/centro, cobertura (não acurácia) e tempos sincronizados de detector/pose/decoder/carregamento/exportação.
- [x] Inferência principal e diagnóstico em lotes de dois frames; recuperação v2 sequencial, sem retries por orelha/cauda isoladas e com orçamento explícito de tentativas/tempo.
- [x] Worker separado para renderização; CSV recebido e disponível antes do vídeo, inclusive se a renderização for interrompida. Cache preparado não é removido ao concluir o job.
- [x] Pré-validação do cache (experimento, arquivo presente, tamanho e estado pronto) antes de criar jobs. Cache antigo removido solicita o original e permite refazer o staging sem perder calibração/correções; arquivo ausente não é reportado como falha genérica de ffprobe.
- [x] Espaço **Ensinar o modelo**: marcação de trechos/contextos, extração de frames exatos com PTS, caixa manual, nove partes com visibilidade, rascunhos e confirmação humana.
- [x] Seleção visual de trechos de treino na timeline, sem digitar início/fim: arraste nos dois sentidos, alças, deslocamento, régua/playhead sincronizado, zoom e faixas por comportamento. Edição de um trecho preserva seu ID; salvar, remover e extrair continuam ações explícitas. Testes locais de ponteiro/teclado/toque usam vídeo sintético e ponte nativa simulada, sem treinamento real no Colab.
- [x] Imagens e rótulos persistidos separadamente no SQLite/diretório de dados, snapshots cumulativos imutáveis, hashes e bloqueio de duplicatas/vazamento entre treino e validação por vídeo/animal.
- [x] Treinamento remoto explícito de Keypoint R-CNN personalizado, relatório de loss/avaliação, recebimento de checkpoint com SHA e seleção manual de versões sem sobrescrever modelos anteriores.
- [x] Modelo personalizado selecionado para novas análises/testes curtos, cache remoto por SHA, vídeo de prévia e retorno ao SuperAnimal; confiança anatômica não calibrada é explícita e não libera métricas automaticamente.

## Implementado como protótipo, ainda não validado para uso científico

- O OpenCV local depende do contraste e de uma câmera fixa; reflexos, grades, sombras, oclusões e mudanças de iluminação podem causar erros. A referência de cor e o gate temporal são heurísticos, não um detector de ratos treinado. Não há benchmark nem acurácia medida nos vídeos reais do usuário.
- A interpolação entre quadros-chave é linear para posição e tamanho da caixa. Curvas, paradas e mudanças bruscas exigem quadros-chave adicionais; ela não usa pixels do vídeo para identificar o animal e não corrige automaticamente desvios do detector. O vídeo original deve estar disponível para revisão.
- Caixa/centroide 2D não medem centro anatômico, altura ou contato com o piso. Métricas automáticas locais exigem consentimento e observação estável no chão; parciais/previsões continuam excluídas. A caixa prevista é somente auxílio visual, nunca evidência observada. O pipeline Colab não foi substituído por detector-only neste corte.

- Experimentos ainda usam `localStorage`; a configuração e a sessão Google OAuth usam SQLite. O produto final deve migrar os projetos para SQLite e arquivos versionados.
- A captura de frame usa o decoder do WebView. A preparação local integra FFmpeg/ffprobe e compara PTS relativos, mas a análise remota ainda usa frame/FPS; VFR e normalização completa de rotação precisam de integração própria.
- O CSV é deliberadamente simples e não suporta campos com vírgula arbitrária nem HDF5 do DeepLabCut.
- O conjunto sintético demonstra a interface, mas nunca deve ser usado como resultado experimental.
- As metas de desempenho com vídeo 1080p/30 FPS ainda precisam de benchmark.
- Borda e chão fornecem contexto geométrico 2D, não classificação automática de rearing nem recuperação de partes ocultas. O recorte e a preservação parcial foram testados com dados sintéticos; ganho de detecção em ratos em pé ainda precisa ser medido no Colab com vídeo real.
- A recuperação visual e os contratos DeepLabCut foram testados com modelos falsos, sem GPU. Ainda é preciso executar a API real no Colab e medir erros antes/depois com frames anotados. Falha de compatibilidade é visível no editor e não é tratada como recuperação concluída.
- As sugestões de rearing/grooming/freezing são heurísticas 2D não validadas; não substituem classificador treinado. Só episódios humanos confirmados são contados. O treino supervisionado novo aprende caixa/pontos, não classificação de comportamentos. Não há classificação automática validada neste corte.
- O fluxo Colab compila e possui testes locais de contrato, mas ainda precisa completar o gate P0 com um vídeo real e evidências sanitizadas da conta alvo.
- A continuidade do worker após encerramento/KeyboardInterrupt da célula de lançamento foi testada localmente com tarefas sintéticas. Falta confirmar esse comportamento no runtime Colab real; substituição da máquina e políticas do provedor continuam podendo encerrar processos. Fechar e reabrir o app não retoma o acompanhamento automaticamente.
- A primeira execução em um runtime sem ambiente compatível prepara o DeepLabCut e pode demorar; instalações válidas são reutilizadas. O ranking de GPU é heurístico e ainda não tem benchmark por acelerador. Não há compra automática de recursos.
- A compactação sem perda foi testada localmente com FFmpeg real e vídeo sintético. Ela pode não reduzir vídeos já comprimidos; não há redução automática de resolução/FPS nem promessa de ganho de velocidade na GPU. FFmpeg ainda não é empacotado.
- O renderizador de vídeo rotulado foi testado por contrato, sem executar DeepLabCut no Colab. O transporte possui testes HTTP locais de integridade; falta validar a renderização e reprodução com uma execução real na conta alvo.
- O diagnóstico usa APIs internas dos runners e caixas pós-filtro, não scores pré-filtro da rede. Contratos locais simulados verificam a separação entre falha de detector/pose/centro, lotes e coordenadas; falta validar compatibilidade, desempenho e ganho real no Colab. Caixa/ponto presente não é comprovação de acerto.
- Os limites da recuperação v2 evitam novas tentativas após o orçamento, mas não interrompem chamadas em andamento. Os valores são heurísticos e podem reduzir recuperações; não há benchmark remoto antes/depois nem promessa de rastreamento sem perdas.
- O treino personalizado foi verificado por contratos com modelos falsos, sem GPU local. Ainda não foi executado um treino real dos ratos no Colab nem medida melhora. Poucos frames servem para teste técnico; dados sem holdout independente não medem generalização. O erro de pose reportado usa somente caixas correspondidas e deve ser lido com cobertura/recall.
- O dataset inicial exige exemplos com animal visível e não inclui anotação de negativos de fundo. A validação científica ainda precisa cobrir falsos positivos em cenas sem animal, oclusões, posturas e animais independentes. Os rótulos de trechos não propagam poses e não treinam um classificador de comportamento.
- Frames de treino são PNG com índice/PTS exatos; a escolha de amostras usa o PTS real mais próximo, não o FPS aproximado do navegador. Cada imagem é revisada antes de entrar no dataset. A extração/indexação de muitos frames longos pode custar tempo local. Snapshots/modelos não têm limpeza automática.
- Testes de recorte usam FFmpeg real e vídeo sintético, inclusive limites entre frames; o player diagnóstico usa índice/FPS, não PTS reais. Seu alinhamento em vídeo VFR continua aproximado e é identificado na interface/exportação.

## Ainda não implementado

- [ ] Persistência SQLite dos experimentos, migrations versionadas e recuperação após crash.
- [ ] Indexação completa de PTS e uso de timestamps reais/VFR na análise e no player científico.
- [ ] Rastreamento assistido por evidência visual/fluxo óptico entre quadros-chave, com validação humana do intervalo antes de liberar métricas.
- [ ] Importador HDF5/CSV nativo do DeepLabCut e adapters versionados.
- [ ] Heatmap ponderado por duração e pacote ZIP completo com proveniência/checksums.
- [ ] Transporte alternativo por Drive/object storage para retomada entre runtimes; o transporte atual usa a API de conteúdo Jupyter em blocos.
- [ ] Validação externa com vídeos de ratos e dois avaliadores.
- [ ] Construção humana do dataset real de ratos, execução/benchmark do treino e avaliação independente por animal/vídeo; infraestrutura implementada não substitui esses dados e evidências.
- [ ] Assinatura, notarização e instaladores.

Consulte também [P0_COLAB_FEASIBILITY.md](./P0_COLAB_FEASIBILITY.md).

