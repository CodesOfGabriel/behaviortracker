# Estado da implementação

## Entregue neste corte

- [x] React + TypeScript + Vite + Tailwind CSS, preparado para Tauri 2.
- [x] Dashboard local e fluxo de criação de experimento OFT.
- [x] Leitura de metadados de vídeo no frontend e captura de frame de referência.
- [x] Marcação e confirmação separadas dos quatro vértices da borda e dos quatro vértices do chão; arraste e teclado em coordenadas da resolução original.
- [x] Validação de quadrilátero e visualização da região central por fração da área.
- [x] Importação do CSV canônico de pose.
- [x] Player/timeline, inspeção de QC e navegação até o próximo problema.
- [x] Correção por arraste/clique, marcação de ponto ausente, confirmação explícita e undo auditável para pontos e comportamentos.
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

## Implementado como protótipo, ainda não validado para uso científico

- Experimentos ainda usam `localStorage`; a configuração e a sessão Google OAuth usam SQLite. O produto final deve migrar os projetos para SQLite e arquivos versionados.
- A captura de frame usa o decoder do WebView; o backend deve integrar ffprobe/FFmpeg, PTS real, VFR e rotação.
- O CSV é deliberadamente simples e não suporta campos com vírgula arbitrária nem HDF5 do DeepLabCut.
- O conjunto sintético demonstra a interface, mas nunca deve ser usado como resultado experimental.
- As metas de desempenho com vídeo 1080p/30 FPS ainda precisam de benchmark.
- Borda e chão fornecem contexto geométrico 2D, não classificação automática de rearing nem recuperação de partes ocultas. O recorte e a preservação parcial foram testados com dados sintéticos; ganho de detecção em ratos em pé ainda precisa ser medido no Colab com vídeo real.
- A recuperação visual e os contratos DeepLabCut foram testados com modelos falsos, sem GPU. Ainda é preciso executar a API real no Colab e medir erros antes/depois com frames anotados. Falha de compatibilidade é visível no editor e não é tratada como recuperação concluída.
- As sugestões de rearing/grooming/freezing são heurísticas 2D não validadas; não substituem classificador treinado. Só episódios humanos confirmados são contados. Não há estimativa de acurácia, treino supervisionado ou classificação automática validada neste corte.
- O fluxo Colab compila e possui testes locais de contrato, mas ainda precisa completar o gate P0 com um vídeo real e evidências sanitizadas da conta alvo.
- A continuidade do worker após encerramento/KeyboardInterrupt da célula de lançamento foi testada localmente com tarefas sintéticas. Falta confirmar esse comportamento no runtime Colab real; substituição da máquina e políticas do provedor continuam podendo encerrar processos. Fechar e reabrir o app não retoma o acompanhamento automaticamente.
- A primeira execução em um runtime sem ambiente compatível prepara o DeepLabCut e pode demorar; instalações válidas são reutilizadas. O ranking de GPU é heurístico e ainda não tem benchmark por acelerador. Não há compra automática de recursos.

## Ainda não implementado

- [ ] Persistência SQLite dos experimentos, migrations versionadas e recuperação após crash.
- [ ] ffprobe/FFmpeg no Rust, checksum SHA-256 e indexação de PTS.
- [ ] Interpolação assistida com prévia e confirmação.
- [ ] Importador HDF5/CSV nativo do DeepLabCut e adapters versionados.
- [ ] Heatmap ponderado por duração e pacote ZIP completo com proveniência/checksums.
- [ ] Transporte alternativo por Drive/object storage para retomada entre runtimes; o transporte atual usa a API de conteúdo Jupyter em blocos.
- [ ] Validação externa com vídeos de ratos e dois avaliadores.
- [ ] Assinatura, notarização e instaladores.

Consulte também [P0_COLAB_FEASIBILITY.md](./P0_COLAB_FEASIBILITY.md).

