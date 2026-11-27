# Página web de downloads

O navegador abre a página de downloads em `/`. O ícone **Entrar** abre a tela de login existente em `/#/login`, com navegação de volta para downloads. O fragmento da URL permite abrir e recarregar o login com o nginx estático do `docker-compose.live.yml`, sem regra de fallback no servidor. O aplicativo Tauri continua abrindo diretamente no fluxo de autenticação desktop.

A página usa a logo da aplicação, cards e abas de shadcn/ui já presentes no projeto. Oferece macOS Intel e Apple Silicon, Windows x64 e Linux x64 (AppImage ou Debian). Os links apontam diretamente para os assets dos instaladores publicados no GitHub Releases.

A identidade visual usa fundo grafite, cinzas neutros e botões em azul acinzentado. As marcas da UFPel, NeuroCell e NeuroLab aparecem em uma faixa discreta abaixo dos downloads, reutilizando os arquivos de `public/` e mantendo textos alternativos e adaptação para telas pequenas.

## Atualizar os downloads

Em `src/features/web/downloads.ts`, atualize `desktopRelease.version` somente depois de publicar e conferir os cinco instaladores da versão correspondente. O padrão de nomes é o mesmo de `.github/workflows/publish-desktop-release.yml`. A versão de desenvolvimento do `package.json` não é usada para anunciar um instalador ainda não publicado. A página não depende de consultas à API do GitHub durante a visita.

Os links correspondem à versão pública `v0.1.5`, cujos cinco assets foram conferidos via API do GitHub em 24/11/2026.

## Build e serviço

Execute `npm run build` para gerar `dist`, diretório montado como somente leitura pelo serviço `behaviortracker-web`. O Compose existente atende a nova página sem alterações. O build local não publica os arquivos na VPS.

O link de login abre a página de autenticação existente. A autorização Google continua disponível no aplicativo desktop; esta alteração não implementa OAuth para navegador.

## Qualidade, builds e publicação

Um push na `main` inicia automaticamente **Deploy Behavior Tracker website** quando altera páginas web, login, componentes de UI compartilhados, estilos, arquivos públicos ou dependências e configuração da build e do deploy web. O filtro completo está em `.github/workflows/deploy-web.yml`. Alterações apenas no backend Python/Rust, nos modelos, nos testes ou na documentação não iniciam o deploy web. Um push misto, com alterações do website e de outras áreas, inicia o fluxo normalmente.

Pull requests não disparam esses workflows, e as builds e publicações desktop continuam manuais. A qualidade não tem um workflow independente por push: ela roda dentro do fluxo de build acionado. O hook local verifica apenas espaços em branco e marcadores de conflito nos arquivos preparados, sem executar testes da aplicação. A suíte completa permanece disponível por `npm run verify`; `npm run verify:staged` verifica manualmente o conteúdo preparado para commit.

No GitHub Actions, acione **Build desktop installers** quando quiser gerar instaladores. O workflow executa a qualidade em Linux, macOS Intel e Windows antes de liberar as builds. **Publish desktop release** recebe o `source_run_id` dessa execução aprovada e publica os artefatos existentes, sem repetir a suíte nem recompilar os instaladores.

O deploy automático do site executa a qualidade antes da build web e só publica após a aprovação. Também é possível acionar **Deploy Behavior Tracker website** manualmente. Nesse caso, se já houver uma build desktop aprovada para o mesmo commit, informe seu ID em `source_run_id`: a aplicação confere o SHA, o resultado da build e a aprovação da qualidade nos três sistemas antes de reutilizá-la. Uma execução de outro commit, incompleta ou reprovada bloqueia o deploy. Deixe o campo vazio para executar a qualidade antes da build web. A etapa de deploy não repete os testes unitários já executados pela qualidade.

Selecione a mesma revisão usada na build ao reutilizar uma execução; apenas ter os mesmos arquivos ou a mesma versão não substitui a igualdade do SHA. Uma nova alteração exige nova validação. Para retomar uma publicação que falhou, use **Re-run failed jobs**, preservando os jobs já aprovados.

Se a falha ocorreu na reutilização por ID ou commit incompatível, use **Run workflow** para iniciar outra execução e corrigir `source_run_id` ou deixá-lo vazio. **Re-run failed jobs** mantém os inputs e o commit originais, portanto repetiria a mesma incompatibilidade. O ID esperado é o da execução **Build desktop installers**, e não o de **Required quality checks**.
