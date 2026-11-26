# Qualidade antes de commit e distribuição

O erro de análise local era um diálogo modal invisível dentro de um histórico fechado. Testes de funções e renderização sem layout não detectam esse defeito. Por isso, a barreira executa também a aplicação com os arquivos de produção em navegadores reais, usando cliques e teclado, sem forçar cliques em controles ocultos.

## Preparação local

Requisitos: Node 22.15+ compatível com as dependências do projeto, Rust e dependências nativas do Tauri, Python 3.12 ou 3.13 de 64 bits. O OpenCV fixado exige macOS 14+ em Intel. FFmpeg/FFprobe devem estar disponíveis no PATH ou preparados em `src-tauri/binaries` pelo fluxo de build. O ambiente de teste não instala PyTorch nem requer GPU ou credenciais OAuth.

```sh
npm ci
npm run test:setup
npm run verify
```

`npm ci`/`npm install` ativa `.githooks/pre-commit` por meio de `prepare`. Hooks personalizados existentes são preservados; a preparação falha com instrução para integração, em vez de sobrescrevê-los. Os navegadores e o ambiente `.venv-test` são dependências de desenvolvimento. A preparação requer internet; o commit não instala dependências automaticamente.

## O que bloqueia um commit

O hook exporta o conteúdo do índice para um diretório temporário, respeitando arquivos parcialmente preparados. Uma correção ainda fora do índice não pode aprovar o código antigo que será commitado. Arquivos de teste não preparados também não entram na verificação. O índice e os arquivos de trabalho são preservados. Nenhum commit é criado pelo gate.

O lock preparado é comparado às dependências instaladas; divergências exigem `npm ci`. Os binários de vídeo são copiados para o ambiente temporário. O cache de compilação Rust é reaproveitado, mas os testes sempre executam. Falta de ferramentas, falha de TypeScript, falha de teste ou ausência de dependências reprova a verificação. Não há aprovação em cache nem opção automática para pular os navegadores.

1. Testes da barreira e dos workflows: YAML válido, distribuição condicionada à qualidade nos três sistemas, interrupção na primeira falha, ferramenta ausente, índice diferente do worktree, dependências divergentes, preservação de hooks personalizados e invocação real do hook pelo Git sem criar commits. A regressão do comando `npm run tauri dev` verifica o carregamento de `.env.local`, prioridade do terminal, falha antes de iniciar o app quando faltam credenciais, preservação de argumentos/código de saída e isolamento dos builds de CI em relação ao arquivo local.
2. Vitest: regras de domínio existentes e componentes React. Novos casos cobrem cancelamento sem iniciar trabalho, ambiente indisponível, falha de staging/SHA, falha ao abrir resultados, bloqueio durante execução e prevenção de submissões durante `loading`.
3. TypeScript da aplicação e dos testes; build de produção.
4. Playwright em Chromium e WebKit: confirmação com histórico fechado, Cancelar, Escape, retorno de foco, reabertura, tamanhos mínimo/amplo, troca de método/largura, modelo opcional lento/indisponível, falhas visíveis com possibilidade de nova tentativa, uma confirmação por job, bloqueio durante execução, alternância Colab/local e anotação humana com desfazer e liberação da navegação.
5. Contrato OAuth do build: execução do `build.rs` real com credenciais fictícias, rejeição de pares ausentes/inválidos antes do empacotamento e compilação do módulo de runtime com o par repassado. A variável local do usuário não substitui o par embarcado. Os contratos dos workflows exigem o secret do repositório nos instaladores; o CI de qualidade usa um par fictício.
6. Registro de modelos, regressões Python de Campo Aberto/FST/RAM, scripts auxiliares, backend Rust e migrações SQLite. Testes Python ignorados por dependências ausentes reprovam o gate; a única exceção fora do Windows é o teste de bloqueio de arquivo específico desse sistema.

Os testes de interface simulam apenas a fronteira IPC do Tauri. A aplicação, rotas, store, CSS, mídia sintética, foco e comportamento nativo de diálogos são reais. Comandos IPC inesperados e exceções JavaScript reprovam os testes. Não são testes de interação com um aplicativo já instalado, de OAuth real, de Colab/GPU ou de precisão científica.

O worker de interface é único para evitar concorrência entre decodificação de vídeo e WebKit em máquinas Intel. Falhas não são escondidas por tentativas automáticas. `test.only`/`describe.only` são recusados. Relatórios, screenshots, vídeos e traces de falhas ficam em `playwright-report/` e `test-results/`; o hook copia essas evidências antes de remover a fonte temporária.

## Comandos úteis

| Comando | Verificação |
| --- | --- |
| `npm test` | Testes Vitest de lógica e componentes |
| `npm run test:gate` | A própria barreira, inclusive o hook real em repositório temporário |
| `npm run test:oauth-build` | Propagação de credenciais fictícias do build ao runtime; exige Rust, sem credenciais reais |
| `npm run test:ui` | Build e interface em Chromium/WebKit |
| `npm run verify:frontend` | Barreira de frontend completa |
| `npm run verify` | Todas as etapas, incluindo Python/Rust |
| `npm run verify:staged` | Exatamente o conteúdo preparado para commit |
| `npm run test:regression-proof` | Restaura o defeito original em uma cópia isolada e exige reprovação por modal invisível |

O controle negativo não altera o código de trabalho. Falhar por indisponibilidade do navegador ou por outro erro não conta como comprovação da regressão.

## CI e limites da obrigatoriedade

`Required quality checks` executa a barreira em Linux, macOS Intel e Windows para pull requests, pushes em `main` e chamadas de outros workflows. A geração de instaladores e o deploy web dependem desse workflow. A publicação de releases exige também encontrar os três jobs de qualidade bem-sucedidos na execução que gerou os instaladores; builds antigos sem esses jobs são recusados.

Os workflows só estarão ativos remotamente depois que o responsável enviar estas alterações. Para impedir merges mesmo quando alguém desativa o hook local, o administrador deve tornar os três checks `Quality (...)` obrigatórios nas regras de proteção de `main`. Essa configuração remota não é feita por estes arquivos e não foi alterada nesta implementação. Hooks locais podem ser contornados intencionalmente pelo Git; por isso existe uma segunda barreira na distribuição. Não foi feito commit, push, publicação ou alteração na VPS.

Nenhuma suíte garante ausência de todos os defeitos. Cada erro novo deve entrar como um caso que falha com o defeito e passa com a correção, incluindo os caminhos de erro e a possibilidade de o usuário recuperar o controle da aplicação.
