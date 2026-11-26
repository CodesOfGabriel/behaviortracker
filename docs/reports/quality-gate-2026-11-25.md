# Barreira de qualidade — evidências locais de 25/11/2026

O hook `pre-commit` está ativo neste checkout por `core.hooksPath=.githooks`. A preparação via npm reaplica essa configuração em novos checkouts e preserva hooks personalizados. Não foi criado commit nem executado push, publicação ou operação na VPS.

| Verificação | Resultado local |
| --- | --- |
| Vitest, lógica e componentes React | 180 passaram em 28 arquivos |
| Testes da barreira e dos workflows, `npm run test:gate` | 12 passaram |
| Playwright sobre o frontend de produção | 30 passaram: 15 cenários em Chromium e WebKit |
| TypeScript da aplicação e dos testes | Passou |
| Build de produção | Passou; aviso existente de bundle acima de 500 kB |
| Python de Campo Aberto/FST/RAM | 209 passaram; 1 teste específico de Windows não se aplica no macOS |
| Scripts Python auxiliares | 13 passaram |
| Rust, backend e migrações SQLite | 95 passaram, sem testes ignorados |
| Integridade do registro de modelos | Passou |
| `git diff --check` | Passou |

## Comprovação do bloqueio

- O controle negativo removeu o portal do diálogo em uma cópia isolada da aplicação. O teste obrigatório de confirmação com histórico fechado reprovou por `toBeVisible`: o diálogo estava `open`, mas permanecia oculto. O código de trabalho foi preservado.
- O teste do hook pelo próprio Git recusou código defeituoso preparado para commit mesmo quando havia uma correção no worktree. Depois de preparar a correção, liberou a verificação. Esses testes usam repositórios temporários sem criar commits.
- A execução integral do hook foi feita com `GIT_INDEX_FILE` temporário, contendo a árvore de trabalho preparada somente nesse índice alternativo. A verificação terminou aprovada em aproximadamente 323 segundos, incluindo compilação Rust. A comparação do índice real e do HEAD antes/depois confirmou preservação de ambos.
- O primeiro ensaio integral recusou dois testes FST porque o novo ambiente não tinha pandas. A dependência foi fixada em `scripts/quality/requirements.txt`, acrescentada à checagem inicial e a execução integral posterior passou. Nenhum teste obrigatório foi dispensado para obter aprovação.
- O filtro de publicação aceitou os três jobs de qualidade bem-sucedidos e recusou fixtures com job ausente, reprovado ou ignorado.

Os testes revelaram também perda do foco de retorno ao fechar a confirmação no WebKit. O botão Analisar agora recebe foco antes da abertura, e a regressão verifica o retorno após Escape. Os seletores de método e largura têm nomes acessíveis explícitos.

## Limites e estado remoto

Os testes de interface executam a aplicação, CSS, roteamento, store e diálogos nativos em navegadores reais, com a fronteira IPC simulada e vídeo sintético. Os testes Python/Rust validam o backend separadamente. Essa execução não demonstra interação com o instalador real, OAuth real, Colab/GPU ou precisão científica de rearing.

Os workflows de qualidade foram preparados para Linux, macOS Intel e Windows; geração de instaladores e deploy dependem deles, e a publicação exige os três jobs aprovados da execução de origem. Esses workflows ainda não foram executados remotamente nesta tarefa. Ativação remota depende do envio das alterações pelo responsável. Regras de proteção da branch não foram modificadas.

Consulte [QUALITY_GATE.md](../QUALITY_GATE.md) para preparação, comandos e limites da obrigatoriedade.
