# Seletores, espaçamento dos cards e fallback de GPU

## Alterações

A auditoria dos formulários em `src` encontrou 14 seletores HTML nativos em dez arquivos, além de um `datalist` para pontos anatômicos. Todos foram migrados para `SelectMenu`, que reutiliza as primitivas shadcn/Radix já presentes no projeto. A entrada de nomes personalizados de pontos continua disponível em “Outro ponto…”.

As telas afetadas são configuração local, estúdio e revisão de rearing, seleção de tracking e execução comportamental, configuração do RAM, geometria de eventos, restauração de geometrias, histórico Colab RAM e anotação de referência humana. Não foram adicionadas dependências.

O componente compartilhado mantém nomes acessíveis, placeholder, opções desabilitadas, seleção por teclado, retorno de foco e Escape. Opções com valor vazio são traduzidas internamente para permitir retornar à execução mais recente sem enviar esse valor interno à aplicação. Em um `dialog` nativo, o portal fica dentro da janela para permanecer visível e interativo na camada modal. Os atalhos de rearing ignoram os controles do seletor.

Cards `.panel` simples passam a ter espaçamento interno de 16 a 24 px. Os painéis com cabeçalho/conteúdo próprios conservam seus recuos existentes. O estado vazio dos resultados recebeu espaçamento de 16 px entre texto e botão. As capturas e testes medem os recuos nas larguras de 980 e 1440 px.

## Colab

Foi removido o limite de duas classes de GPU. A criação percorre todas as classes elegíveis retornadas pela conta, pela prioridade H100, A100, L4, T4 e outras classes elegíveis. Formatos diferentes da mesma classe não geram tentativas duplicadas; CPU e opções inelegíveis ficam excluídas.

Falta de capacidade pode chegar como operação de criação encerrada com erro ou resposta HTTP de capacidade. Ambos os caminhos permitem tentar a próxima classe. Entre tentativas, a aplicação verifica se existe um runtime aproveitável antes de solicitar outro. Erros de permissão ou quota continuam interrompendo a criação; falhas de rede com resultado de criação desconhecido não disparam uma nova solicitação possivelmente duplicada.

O Teste B de adaptação conserva a exigência de A100/H100 por seu orçamento de memória. Não foi alterada essa compatibilidade para forçar execução em GPUs menores.

Se todas as classes elegíveis estiverem sem capacidade, a interface apresenta uma mensagem com as classes tentadas, sem o erro gRPC bruto. A disponibilidade de GPU continua dependendo do Google.

## Verificação

- `npm run test:unit`: 209 testes aprovados, em 34 arquivos.
- `npm run build`: aprovado; aviso existente sobre tamanho do bundle.
- `npx tsc -p tsconfig.tests.json`: aprovado.
- `cargo test --manifest-path src-tauri/Cargo.toml colab::tests:: -- --nocapture`: 49 testes aprovados.
- Playwright: 72 testes aprovados entre Chromium e WebKit, executados em grupos de 26, 44 e 2.
- `git diff --check`: aprovado.

As regressões HTTP exercitam a função real de alocação com servidor local: A100 indisponível, L4 recusada por HTTP 429, T4 criada após acompanhamento da operação; esgotamento das três classes; recusa por quota/permissão; reutilização após falha. Os testes de interface cobrem os dois cards apresentados, menus em janelas modais, teclado, Escape, foco, seleção da largura enviada ao backend, velocidade do vídeo e proteção dos atalhos de anotação. Uma verificação de fonte impede novos `<select>` e `<datalist>` nativos nos componentes da aplicação.

O IPC é simulado nos testes de navegador. Não houve autenticação real, alocação de GPU, execução remota de Colab ou validação do aplicativo Tauri empacotado nesta mudança.

## Referências e capturas

Referências oficiais: [Select shadcn/Radix](https://ui.shadcn.com/docs/components/radix/select) e [Card shadcn](https://ui.shadcn.com/docs/components/radix/card). A origem dos componentes e sua licença estão em [shadcn-results-ui.md](../shadcn-results-ui.md).

- [Seletor de rearing no WebKit, 980 px](../../artifacts/ui-selects-gpu-fallback-2026-11-26/rearing-webkit-980.png).
- [Card vazio no Chromium, 980 px](../../artifacts/ui-selects-gpu-fallback-2026-11-26/empty-chromium-980.png).
- [Menu aberto no estúdio, Chromium](../../artifacts/ui-selects-gpu-fallback-2026-11-26/menu-chromium.png).
- [Menu aberto no estúdio, WebKit](../../artifacts/ui-selects-gpu-fallback-2026-11-26/menu-webkit.png).

As capturas usam dados genéricos de teste. Nenhum commit, publicação ou deploy foi realizado.
