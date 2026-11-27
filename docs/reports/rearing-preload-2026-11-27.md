# Carregamento da aba Rearing — 27/11/2026

## Mudança

A aba recriava seu estado a cada visita, consultava o ambiente Python novamente e relia contexto, anotações e tracking. O contexto verifica o SHA-256 do vídeo original, lê os timestamps do JSONL e consulta a duração com FFprobe. Essas operações começam durante a inicialização autenticada, em paralelo à animação de loading, sem bloquear a entrada no aplicativo. O mesmo pré-carregamento começa após um novo login Google. A animação tem exibição mínima de 600 ms, limite de espera da imagem de 1,5 s e saída de segurança em 2,5 s; dados de análise não participam da condição para liberar o painel.

O cache da sessão compartilha requisições simultâneas, inclusive no modo de desenvolvimento com React StrictMode. As telas usam os dados já disponíveis na primeira renderização. Os resultados locais completos também são compartilhados com a aba Análise. Novas seleções de vídeo ou execução são preparadas em segundo plano.

Salvar anotações e revisões atualiza o histórico em memória somente depois da confirmação nativa. Falhas não são guardadas como resultados válidos. Sair da conta ou excluir um experimento limpa os caches; requisições antigas e suas cadeias de pré-carregamento não podem repopular a sessão seguinte. A chave do contexto inclui experimento, tracking e SHA-256.

A consulta opcional do modelo tem limite de cinco segundos, com nova tentativa disponível na interface. Uma fonte indisponível não bloqueia o acesso ao restante do aplicativo. O estúdio só libera a edição depois de receber contexto, tracking e histórico humano completos; uma falha permite tentar carregar novamente.

No código nativo, a leitura dos resultados locais, históricos de tracking e classificação, anotações e revisões passou para `spawn_blocking`. A leitura do relógio usa uma estrutura com índice e timestamp, evitando alocar todos os campos de contornos e características. O JSON inteiro continua sendo validado, assim como a sequência de índices e a monotonicidade dos PTS. A verificação SHA-256 do contexto permanece no backend.

## Limites de memória e escopo

São preparados no máximo dois experimentos simultaneamente. Contextos, históricos e resumos têm cache de até 128 recursos. Até três trackings completos são antecipados e mantidos em memória; os demais são carregados quando escolhidos, aproveitando seu contexto e suas anotações já preparados. Resultados antigos podem ser removidos do cache para conter o uso de RAM. Vídeos completos e pesos não são decodificados nem carregados integralmente na memória pelo pré-carregamento.

O pré-carregamento usa execuções OpenCV concluídas de Campo Aberto compatíveis com o vídeo salvo. A seleção explícita de execução comportamental é respeitada. O processo não altera anotações salvas, arquivos originais, métricas de locomoção ou pesos dos modelos.

## Verificação

- Build TypeScript/Vite aprovado. Permanece o aviso existente sobre tamanho do bundle.
- 249 testes de frontend aprovados, incluindo cache, isolamento de origem, falhas, invalidação durante requisições, atualização do histórico e espera por histórico parcialmente carregado.
- 110 testes Rust aprovados, incluindo validação do relógio otimizado. Após a conversão da consulta de revisões, os oito testes comportamentais foram repetidos e aprovados.
- 32 testes de interface aprovados em Chromium e WebKit. As regressões incluem leituras de vídeo, tracking, histórico e consulta do modelo que nunca respondem. O acesso ao painel e a navegação devem continuar disponíveis. Também são verificados imagem de loading travada, primeiro login Google, falha de fonte e reutilização dos dados após sua chegada.

Os testes de interface executam componentes, navegação, diálogos e mídia sintética reais com IPC Tauri simulado. A contagem de leituras demonstra a reutilização dos dados; não mede a latência do vídeo do pesquisador nem constitui validação em um aplicativo desktop instalado ou no Colab. Os logs da correção de inicialização ficam em `/tmp/rearing-startup-unblock-*.log`; os testes de frontend finais usam `npx vitest run --maxWorkers=2` para limitar a concorrência nesta máquina. A rodada anterior em paralelo com compilação e navegadores atingiu o limite de cinco segundos em um teste de edição. Não houve commit, publicação ou mudança em VPS.

A primeira implementação aguardava todos os dados antes de liberar o painel. Após relato de loading permanente, essa dependência foi removida. O carregamento de rearing permanece antecipado e compartilhado; quando uma fonte ainda não está pronta, somente o estúdio mostra seu estado de carregamento e permite fechar e continuar navegando.
