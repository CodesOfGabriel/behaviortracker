# Credenciais Google no desenvolvimento local

Data: 26/11/2026.

O comando `npm run tauri dev` estava compilando sem `BEHAVETRACKER_GOOGLE_CLIENT_ID` e `BEHAVETRACKER_GOOGLE_CLIENT_SECRET`. A verificação inicial confirmou que as duas variáveis estavam ausentes no terminal e que não havia arquivo de ambiente local na raiz ou em `src-tauri`. O usuário informou não conhecer uma cópia local do segredo.

O secret configurado no GitHub Actions não é injetado nos processos iniciados neste computador. A verificação dos instaladores corrigida anteriormente não fornece, por si só, a credencial ao desenvolvimento local.

## Alteração

- O script npm `tauri` passa por `scripts/tauri.mjs`, que lê somente as duas variáveis OAuth de `.env.local` antes de executar `tauri dev`.
- Valores já exportados prevalecem sobre o arquivo; uma variável explicitamente vazia não é substituída silenciosamente.
- O mesmo validador Node atende ao preflight do CI e ao desenvolvimento. Uma credencial ausente ou malformada interrompe o desenvolvimento no terminal, com instruções, antes de abrir um aplicativo sem acesso Google.
- Outros comandos, incluindo `tauri build`, não carregam o arquivo local. Os instaladores continuam recebendo o segredo pelo ambiente do GitHub Actions.
- Argumentos, código de saída e sinais de interrupção são encaminhados ao processo Tauri. Nenhum valor de credencial é impresso.
- `.env.example` contém o Client ID público do aplicativo e um campo de segredo vazio. Foi criado `.env.local`, ignorado pelo Git, com permissão 0600 e sem sobrescrever arquivo existente. O segredo permanece vazio.

Nenhuma configuração manual de credenciais foi reintroduzida na interface do pesquisador.

## Validação

`npm run test:gate` aprovou 27 testes, sendo 13 novos casos do fluxo de desenvolvimento. Os casos de integração executam o script npm real em diretórios temporários com credenciais fictícias e um substituto da CLI nativa: verificam as variáveis recebidas, os argumentos, a precedência do CI, a ausência de vazamento nos logs e a interrupção antes da CLI quando faltam credenciais. Outros casos verificam a exclusão do arquivo local pelo Git.

`npm run test:oauth-build` aprovou novamente os 14 contratos de compilação OAuth. Esses testes compilam o `build.rs` real com empacotamento Tauri simulado e verificam o módulo de credenciais do runtime.

`npm run tauri -- --version` alcançou a CLI real e retornou `tauri-cli 2.12.4`. A execução real de `npm run tauri dev` sem o segredo terminou com código 1 antes de iniciar o app, identificando `BEHAVETRACKER_GOOGLE_CLIENT_SECRET` e orientando o preenchimento de `.env.local`. `git check-ignore .env.local` confirmou a exclusão; `git diff --check` foi aprovado.

## Pendência para autenticar de verdade

É necessário obter o Client Secret verdadeiro do cliente OAuth usado no GitHub e preencher `BEHAVETRACKER_GOOGLE_CLIENT_SECRET` em `.env.local`, ou exportar o par no terminal. Depois é preciso encerrar o processo anterior e iniciar novamente `npm run tauri dev` para recompilar as credenciais.

O login real não foi validado e continua bloqueado pela ausência desse valor. Os testes não recuperam nem substituem o secret real. Não houve commit, push, publicação, alteração da VPS ou mudança em vídeos e experimentos.
