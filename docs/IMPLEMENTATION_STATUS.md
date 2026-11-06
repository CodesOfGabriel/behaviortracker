# Estado da implementação

## Entregue neste corte

- [x] React + TypeScript + Vite + Tailwind CSS, preparado para Tauri 2.
- [x] Dashboard local e fluxo de criação de experimento OFT.
- [x] Leitura de metadados de vídeo no frontend e captura de frame de referência.
- [x] Marcação arrastável dos quatro vértices em coordenadas da resolução original.
- [x] Validação de quadrilátero e visualização da região central por fração da área.
- [x] Importação do CSV canônico de pose.
- [x] Player/timeline, inspeção de QC e navegação até o próximo problema.
- [x] Correção por arraste, marcação de ponto ausente, anotação manual de rearing e undo por evento reversor.
- [x] Alternância entre dados brutos e revisados.
- [x] Homografia pixel → piso e métricas locais de distância, velocidade, zonas, entradas, latência, cobertura e imobilidade operacional.
- [x] Exportação de `experiment.json`, `poses_reviewed.csv`, `corrections.jsonl` e `metrics.csv`.
- [x] Testes numéricos iniciais para geometria e métricas SCI-001/002/004/005/006.
- [x] Shell Tauri mínimo com CSP e permissões básicas.
- [x] Configuração Google OAuth por perfil: Client ID/estado no SQLite e segredos/tokens no Keychain.
- [x] Fluxo OAuth 2.0 para aplicativo desktop com PKCE/S256 e callback loopback.
- [x] Consulta de assinatura e runtimes elegíveis pela Colab API, com erro do provedor visível na interface.
- [x] Job Colab persistido no SQLite, com progresso, falha terminal e recuperação de jobs interrompidos.
- [x] Criação/reuso de runtime GPU elegível e acompanhamento da operação de criação.
- [x] Upload local e remoto do vídeo em blocos, com validação SHA-256 dentro do runtime.
- [x] Execução remota resumível via MCP, instalação do DeepLabCut e SuperAnimal TopViewMouse.
- [x] Conversão do H5 do DeepLabCut para CSV canônico e importação automática no editor.
- [x] Persistência do CSV retornado no diretório de dados e restauração ao reabrir o experimento.

## Implementado como protótipo, ainda não validado para uso científico

- Experimentos ainda usam `localStorage`; somente a configuração Google OAuth já usa SQLite e Keychain. O produto final deve migrar os projetos para SQLite e arquivos versionados.
- A captura de frame usa o decoder do WebView; o backend deve integrar ffprobe/FFmpeg, PTS real, VFR e rotação.
- O CSV é deliberadamente simples e não suporta campos com vírgula arbitrária nem HDF5 do DeepLabCut.
- O conjunto sintético demonstra a interface, mas nunca deve ser usado como resultado experimental.
- As metas de desempenho com vídeo 1080p/30 FPS ainda precisam de benchmark.
- O fluxo Colab compila e possui testes locais de contrato, mas ainda precisa completar o gate P0 com um vídeo real e evidências sanitizadas da conta alvo.
- A primeira execução instala o DeepLabCut no runtime e pode demorar; runtimes existentes são reutilizados, sem fallback pago automático.

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

