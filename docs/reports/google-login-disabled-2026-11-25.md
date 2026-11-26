# Login Google com credenciais do build

Início: 25/11/2026. Revisão: 26/11/2026.

O acesso do pesquisador usa exclusivamente a autorização Google. A tela não pede credenciais OAuth, JSON de configuração ou recuperação manual de um cliente OAuth. A orientação de importação adicionada na investigação inicial foi removida, inclusive das configurações do Colab.

## Contrato de distribuição

1. `.github/workflows/build-installers.yml` associa `BEHAVETRACKER_GOOGLE_CLIENT_SECRET` a `${{ secrets.BEHAVETRACKER_GOOGLE_CLIENT_SECRET }}` no ambiente do job de todos os instaladores. O Client ID permanece definido no mesmo job.
2. `scripts/check-google-oauth-env.mjs` verifica as duas variáveis antes da compilação. Credencial ausente, vazia, com espaços nas extremidades, com quebras de linha ou fora dos limites impede o build. O script não exibe valores de credenciais.
3. `src-tauri/build.rs` repete a validação em builds release, independentemente do workflow, e repassa o par validado ao compilador. Mudanças nas duas variáveis invalidam o cache do build script. Builds debug aceitam a ausência de ambas para desenvolvimento; um par parcial também é rejeitado.
4. `src-tauri/google_client.rs`, compartilhado entre build e runtime, lê as credenciais embarcadas via `option_env!`. O computador do pesquisador não precisa definir essas variáveis e uma variável local diferente não substitui o cliente compilado.
5. O backend usa somente o segredo embarcado correspondente ao Client ID do aplicativo. Um segredo antigo no SQLite não é uma alternativa. A troca do código de autorização e a renovação do token sempre recebem esse segredo; se ele não estiver disponível, nenhuma requisição de token é iniciada. A configuração do cliente gerenciado também não pode ser substituída pelo comando legado de gravação.
6. Uma conta só é apresentada como conectada quando o cliente embarcado está disponível e existem identidade e token. O fluxo Google com PKCE, callback local e armazenamento de token no cofre do sistema foi preservado.

A verificação de sessão continua limitada a dez segundos. Erros liberam nova tentativa de entrada; respostas antigas não substituem uma conexão concluída. Cliques simultâneos não iniciam duas autorizações. Falhas não concedem acesso nem abrem configuração manual.

## Regressões executadas

| Verificação | Resultado |
| --- | --- |
| Build frontend de produção e TypeScript da aplicação e dos testes | Aprovados |
| Vitest | 206 testes aprovados |
| Barreira de qualidade e contratos dos workflows | 14 testes aprovados |
| Contrato de build OAuth | 14 testes aprovados |
| Backend OAuth Rust | 16 testes aprovados com par fictício compilado; 16 também aprovados sem variáveis no build debug |
| Interface Chromium e WebKit | 62 testes aprovados, incluindo 20 cenários de login/conta Google |

Os testes de contrato compilam e executam o `build.rs` real, substituindo somente a etapa Tauri de empacotamento por um stub. Exercitam doze entradas inválidas e verificam que a etapa de empacotamento não começa. Com um par válido fictício, extraem as diretivas destinadas ao compilador e compilam um programa que usa o mesmo módulo de credenciais do runtime. Esse programa funciona sem variáveis no processo e ignora substituições locais.

O teste Rust compila o aplicativo com credenciais fictícias e verifica a seleção do segredo embarcado quando o banco está sem segredo ou contém um valor antigo. A execução de qualidade em Linux, Windows e macOS recebe esse mesmo par fictício, sem expor o secret real do repositório. O job dos instaladores recebe separadamente o secret real e exige seu preflight.

Os contratos de workflow impedem a remoção da associação ao secret do repositório, sua substituição por um valor no ambiente de uma etapa e o bypass do preflight. A verificação de publicação continua exigindo uma execução bem-sucedida do workflow de instaladores e dos três jobs de qualidade.

## Evidência e limites

As capturas do layout atual estão em `artifacts/google-login-bundled-2026-11-25/`. As capturas Chromium e WebKit em 980 × 620 foram inspecionadas: botão visível, erro de teste acionável e nenhum painel de credenciais. `git diff --check` e a formatação dos arquivos Rust alterados foram aprovados.

Os testes de interface usam a aplicação compilada com IPC simulado. As credenciais dos testes são fictícias; os testes não consultam a validade do secret real no Google. Não foi executado um workflow remoto, compilado um instalador de produção nem autorizada uma conta real. A validação do build impede distribuir uma versão sem o par obrigatório; não comprova que o Google aceitará um secret revogado ou pertencente a outro cliente.

O secret do GitHub é disponibilizado ao compilador durante o build, não consultado em tempo de execução. Uma instalação anterior precisa receber um novo build para incorporar esta correção. O desenvolvimento local não herda secrets do GitHub: para autenticar de verdade em um build local, o responsável pelo build precisa fornecer o mesmo par válido ao compilador.

Nenhuma credencial real foi lida ou gravada nesta revisão. Dados de experimentos e vídeos foram preservados. Não houve commit, push, publicação ou alteração da VPS.
