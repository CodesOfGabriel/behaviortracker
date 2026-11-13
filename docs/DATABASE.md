# Armazenamento local

O aplicativo não usa um servidor de banco de dados. Cada instalação tem um arquivo SQLite `behavetracker.sqlite3` no diretório de dados do aplicativo do usuário. As conexões Rust ativam chaves estrangeiras e o modo WAL. Nas conexões novas, o token de renovação Google fica no cofre de credenciais do sistema; o SQLite mantém o perfil e o estado da conexão. Tokens antigos no SQLite são transferidos ao cofre quando o perfil OAuth é aberto.

| Dados | Armazenamento |
| --- | --- |
| Experimentos e perfil do pesquisador | `localStorage` do WebView, nas chaves `behavetracker.experiments.v1` e `behavetracker.researcher.v1` |
| Perfil Google | `google_oauth_profiles` |
| Upload e preparação de vídeo | `video_staging`, `video_preparations` |
| Jobs Colab e resultados associados | `colab_jobs`, `colab_job_events`, `colab_job_artifacts`, `colab_job_diagnostics`, `colab_job_geometry` |
| Anotações e modelos de treinamento | `training_frames`, `training_intervals`, `training_runs`, `training_selection`, `custom_analysis_models` |
| Histórico de rastreamento local | `local_tracking_jobs` |

Vídeos temporários, resultados e arquivos de treinamento também ficam em diretórios de cache e dados do aplicativo. A versão `1.0` no JSON dos experimentos é diferente de `PRAGMA user_version` do SQLite. Ao carregar os experimentos, `migrateExperiment` ajusta campos legados em memória e os grava na próxima alteração; eles ainda não têm uma sequência própria de migrations persistentes.

Não existe uma tabela de experimentos. Por isso, `experiment_id` nas tabelas SQLite não possui chave estrangeira para um experimento, e a exclusão de um experimento no `localStorage` não remove automaticamente seus jobs ou arquivos. Essa integração precisa de uma operação de exclusão própria antes de ser considerada completa.

## Migrations SQLite

`src-tauri/migrations/001_initial.sql` contém o esquema atual. `src-tauri/src/database.rs` aplica as migrations pendentes em transações, em ordem, e grava a versão em `PRAGMA user_version` somente após cada sucesso. Um banco antigo sem versão é atualizado sem apagar linhas; a adaptação das colunas OAuth antigas ocorre na mesma transação. Um banco com versão mais nova que o aplicativo é recusado.

Para alterar tabelas depois desta versão, adicione uma nova migration numerada, registre-a em `MIGRATIONS` e inclua um teste de atualização a partir do esquema anterior. Não modifique `001_initial.sql` depois de distribuir a versão que o utiliza. Antes de atualizar uma instalação com dados importantes, faça uma cópia do diretório de dados do aplicativo com o aplicativo fechado, incluindo o arquivo SQLite e os arquivos de resultados.

## Verificação

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm test
npm run build
```

Os testes Rust cobrem criação das tabelas, upgrade de banco antigo sem versão, preservação dos jobs, rollback de uma migration que falha, recusa de versão futura e regras de chaves estrangeiras. Os testes TypeScript cobrem funções de análise e fluxos da interface. Essas suítes não substituem um teste manual de abertura e atualização de uma instalação real, nem uma execução real com vídeo e Colab.
