use rusqlite::Connection;

use crate::oauth::{migrate_credential_state, CommandResult};

const MIGRATIONS: [&str; 1] = [include_str!("../migrations/001_initial.sql")];

pub(crate) fn migrate(connection: &mut Connection) -> CommandResult<()> {
    let current_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| "Não foi possível ler a versão do banco local.".to_string())?;
    if current_version > MIGRATIONS.len() as i64 {
        return Err(
            "Este banco local foi criado por uma versão mais recente do aplicativo.".into(),
        );
    }

    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let version = (index + 1) as i64;
        if current_version >= version {
            continue;
        }
        let transaction = connection
            .transaction()
            .map_err(|_| "Não foi possível iniciar a atualização do banco local.".to_string())?;
        transaction.execute_batch(sql).map_err(|_| {
            format!("Não foi possível aplicar a migration {version} do banco local.")
        })?;
        if version == 1 {
            // Instalações antigas não tinham user_version nem todas as colunas OAuth.
            migrate_credential_state(&transaction)?;
        }
        transaction
            .pragma_update(None, "user_version", version)
            .map_err(|_| {
                format!("Não foi possível registrar a migration {version} do banco local.")
            })?;
        transaction.commit().map_err(|_| {
            format!("Não foi possível concluir a migration {version} do banco local.")
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn version(connection: &Connection) -> i64 {
        connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn fresh_database_creates_all_tables_and_rejects_orphan_rows() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .unwrap();
        migrate(&mut connection).unwrap();
        assert_eq!(version(&connection), 1);

        let names: Vec<String> = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            names,
            [
                "colab_job_artifacts",
                "colab_job_diagnostics",
                "colab_job_events",
                "colab_job_geometry",
                "colab_jobs",
                "custom_analysis_models",
                "google_oauth_profiles",
                "local_tracking_jobs",
                "training_frames",
                "training_intervals",
                "training_runs",
                "training_selection",
                "video_preparations",
                "video_staging",
            ]
        );
        assert!(connection.execute(
            "INSERT INTO colab_job_events (job_id, stage, status, progress, message) VALUES ('missing', 'upload', 'running', 1, 'test')",
            [],
        ).is_err());
    }

    #[test]
    fn upgrades_unversioned_database_without_losing_existing_rows() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE google_oauth_profiles (
               profile_id TEXT PRIMARY KEY NOT NULL, google_client_id TEXT NOT NULL,
               account_email TEXT, subscription_tier TEXT,
               eligible_runtime_count INTEGER NOT NULL DEFAULT 0,
               eligible_gpu_count INTEGER NOT NULL DEFAULT 0,
               provider_error TEXT, connected_at TEXT, updated_at TEXT
             );
             CREATE TABLE colab_jobs (
               job_id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL,
               experiment_id TEXT NOT NULL, upload_id TEXT NOT NULL,
               status TEXT NOT NULL, stage TEXT NOT NULL, progress INTEGER NOT NULL,
               message TEXT NOT NULL, runtime_name TEXT, session_name TEXT,
               result_path TEXT, error TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );
             INSERT INTO google_oauth_profiles (profile_id, google_client_id, account_email)
             VALUES ('local-default', 'client.apps.googleusercontent.com', 'old@example.com');
             INSERT INTO colab_jobs (job_id, profile_id, experiment_id, upload_id, status, stage, progress, message)
             VALUES ('job-1', 'local-default', 'exp-1', 'video-1', 'succeeded', 'done', 100, 'Concluído');"
        ).unwrap();

        migrate(&mut connection).unwrap();
        migrate(&mut connection).unwrap();
        assert_eq!(version(&connection), 1);
        let (client, has_token, email): (String, bool, Option<String>) = connection.query_row(
            "SELECT google_client_id, has_refresh_token, account_email FROM google_oauth_profiles WHERE profile_id = ?1",
            params!["local-default"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(client, "client.apps.googleusercontent.com");
        assert!(!has_token);
        assert_eq!(email, None);
        let job_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM colab_jobs WHERE job_id = 'job-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(job_count, 1);
        let index_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_colab_jobs_experiment'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(index_count, 1);
    }

    #[test]
    fn failed_migration_rolls_back_and_leaves_version_unchanged() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE colab_jobs (job_id TEXT PRIMARY KEY)")
            .unwrap();
        assert!(migrate(&mut connection).is_err());
        assert_eq!(version(&connection), 0);
        let oauth_table_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='google_oauth_profiles'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(oauth_table_count, 0);
    }

    #[test]
    fn refuses_database_from_newer_app_without_changes() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA user_version = 2").unwrap();
        assert!(migrate(&mut connection).is_err());
        assert_eq!(version(&connection), 2);
    }
}
