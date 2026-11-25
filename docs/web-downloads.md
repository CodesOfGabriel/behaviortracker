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
