# Bloqueio ao abrir análise local — 25/11/2026

## Causa e correção

`AnalysisWorkspace` mantém `local.panel` dentro de `details.analysis-settings`, fechado por padrão. O diálogo de `LocalAnalysisPanel` era descendente desse elemento. Ao clicar em **Analisar**, `showModal()` tornava o restante da página inerte, mas o histórico fechado impedia a renderização do diálogo. Na reprodução, o diálogo tinha `open=true`, correspondia a `:modal` e media **0 × 0 px**. Não houve exceção JavaScript.

O diálogo agora usa `createPortal(..., document.body)`. Seu ciclo de vida e estado continuam pertencendo a `LocalAnalysisPanel`, mas sua exibição independe do histórico e dos painéis ocultos. Não houve alteração do processamento de tracking para corrigir este bloqueio.

## Verificação

- Chromium, aplicação com backend Tauri simulado e dados fictícios: janela visível com histórico fechado nas larguras 1440, 1180, 980 e 390 px; Cancelar recebe cliques; Escape fecha; abas funcionam após o fechamento; reabertura funciona; nenhuma exceção JavaScript.
- WebKit nativo do macOS Intel (`WKWebView`), com os mesmos dados fictícios: verificado tanto com Vite dev quanto com os arquivos de produção. Diálogo de 480 × 546 px, diretamente no `body`, botão Cancelar alcançável, histórico fechado; Cancelar e troca de aba funcionaram.
- Recuperação da versão antiga: reprodução do diálogo invisível seguida de Escape fechou o modal e liberou a página no Chromium.
- `npm test`: 170 testes passaram em 26 arquivos.
- `npm run build`: passou, com o aviso já existente de tamanho do bundle.
- `git diff --check`: passou.
- `PATH=/Users/gabrielsantos/.cargo/bin:$PATH npm run tauri -- build --debug --bundles app --no-sign --ci`: passou; gerou `src-tauri/target/debug/bundle/macos/Behavior Tracker.app` (222,79 MiB), build local de teste sem assinatura. A interação dentro desse pacote não foi automatizada; a verificação de interface usou o WebKit isolado descrito acima.

Esses testes verificam a interface e o motor WebKit; não executam uma análise científica nem demonstram interação com a cópia já instalada. A geração release exige `BEHAVETRACKER_GOOGLE_CLIENT_ID` e `BEHAVETRACKER_GOOGLE_CLIENT_SECRET`, ausentes no terminal desta execução. Nenhuma cópia em `/Applications` foi substituída.

## Reprodução manual

1. Abrir os resultados de um experimento de campo aberto no desktop.
2. Selecionar **Análise** e **Máquina local**.
3. Manter **Configuração e histórico de execuções** fechado.
4. Clicar em **Analisar**. A confirmação deve aparecer imediatamente.
5. Fechar com **Cancelar**, reabrir e fechar com **Escape**.
6. Trocar de aba e voltar. A navegação e a reabertura devem continuar funcionando.
