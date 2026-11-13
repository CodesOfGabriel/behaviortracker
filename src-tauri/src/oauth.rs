use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use rand::{distributions::Alphanumeric, Rng};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const COLAB_SCOPE: &str = "https://www.googleapis.com/auth/colaboratory";
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);
const CLIENT_SECRET_SERVICE: &str = "com.behavetracker.desktop.google-oauth-client";
const REFRESH_TOKEN_SERVICE: &str = "com.behavetracker.desktop.google-oauth-refresh";
const OAUTH_STATUS_EVENT: &str = "google-oauth-status";
const BUNDLED_CLIENT_ID: Option<&str> = option_env!("BEHAVETRACKER_GOOGLE_CLIENT_ID");

pub(crate) type CommandResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthProfileSummary {
    pub profile_id: String,
    pub client_id: String,
    pub managed_client: bool,
    pub has_client_secret: bool,
    pub connected: bool,
    pub account_email: Option<String>,
    pub subscription_tier: Option<String>,
    pub eligible_runtime_count: i64,
    pub eligible_gpu_count: i64,
    pub provider_error: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    email: String,
}

#[derive(Debug, Deserialize)]
struct SubscriptionResponse {
    tier: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSpecsResponse {
    #[serde(default)]
    runtime_specs: Vec<RuntimeSpec>,
}

#[derive(Debug, Deserialize)]
struct RuntimeSpec {
    #[serde(default)]
    eligible: bool,
    #[serde(default)]
    key: RuntimeSpecKey,
}

#[derive(Debug, Default, Deserialize)]
struct RuntimeSpecKey {
    #[serde(default)]
    variant: String,
}

#[derive(Debug)]
struct ColabStatus {
    tier: String,
    eligible_runtime_count: i64,
    eligible_gpu_count: i64,
}

fn validate_profile_id(profile_id: &str) -> CommandResult<&str> {
    if profile_id.is_empty()
        || profile_id.len() > 80
        || !profile_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Perfil local inválido.".into());
    }
    Ok(profile_id)
}

fn validate_client_id(client_id: &str) -> CommandResult<String> {
    let value = client_id.trim();
    if value.is_empty() || value.len() > 512 || !value.ends_with(".apps.googleusercontent.com") {
        return Err(
            "Client ID inválido. Use uma credencial Google OAuth do tipo Desktop app.".into(),
        );
    }
    if value.chars().any(char::is_whitespace) {
        return Err("O Client ID não pode conter espaços.".into());
    }
    Ok(value.to_string())
}

fn validate_client_secret(client_secret: &str) -> CommandResult<String> {
    let value = client_secret.trim();
    if value.is_empty() {
        return Err("O Client secret informado está vazio.".into());
    }
    if value.len() > 2048 || value.contains('\n') || value.contains('\r') {
        return Err("Client secret inválido.".into());
    }
    Ok(value.to_string())
}

fn bundled_client_id() -> Option<String> {
    BUNDLED_CLIENT_ID.and_then(|value| validate_client_id(value).ok())
}

fn token_entry(profile_id: &str) -> CommandResult<Entry> {
    Entry::new(REFRESH_TOKEN_SERVICE, profile_id)
        .map_err(|_| "Não foi possível abrir o cofre de credenciais do sistema.".to_string())
}

fn read_keyring_token(profile_id: &str) -> CommandResult<Option<String>> {
    match token_entry(profile_id)?.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Não foi possível ler a autorização Google no cofre do sistema.".into()),
    }
}

fn save_keyring_token(profile_id: &str, token: &str) -> CommandResult<()> {
    token_entry(profile_id)?.set_password(token).map_err(|_| {
        "Não foi possível salvar a autorização Google no cofre do sistema.".to_string()
    })
}

fn delete_keyring_token(profile_id: &str) -> CommandResult<()> {
    match token_entry(profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Não foi possível remover a autorização Google do cofre do sistema.".into()),
    }
}

pub(crate) fn open_database(app: &AppHandle) -> CommandResult<Connection> {
    let data_dir = app.path().app_data_dir().map_err(|_| {
        "Não foi possível localizar o diretório de dados do aplicativo.".to_string()
    })?;
    fs::create_dir_all(&data_dir)
        .map_err(|_| "Não foi possível criar o diretório de dados do aplicativo.".to_string())?;
    let mut connection = Connection::open(data_dir.join("behavetracker.sqlite3"))
        .map_err(|_| "Não foi possível abrir o banco local do Behavior Tracker.".to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(|_| "Não foi possível preparar o banco local do Behavior Tracker.".to_string())?;
    crate::database::migrate(&mut connection)?;
    Ok(connection)
}

pub(crate) fn migrate_credential_state(connection: &Connection) -> CommandResult<()> {
    let has_column = |name: &str| -> CommandResult<bool> {
        connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM pragma_table_info('google_oauth_profiles') WHERE name = ?1
                 )",
                params![name],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|_| "Não foi possível inspecionar o banco local.".to_string())
    };

    if !has_column("has_client_secret")? {
        connection
            .execute_batch(
                "ALTER TABLE google_oauth_profiles
                   ADD COLUMN has_client_secret INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|_| "Não foi possível preparar o estado da credencial Google.".to_string())?;
    }
    if !has_column("has_refresh_token")? {
        connection
            .execute_batch(
                "ALTER TABLE google_oauth_profiles
                   ADD COLUMN has_refresh_token INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|_| "Não foi possível preparar o estado da autorização Google.".to_string())?;
    }
    if !has_column("client_secret")? {
        connection
            .execute_batch(
                "ALTER TABLE google_oauth_profiles
                   ADD COLUMN client_secret TEXT;
                 UPDATE google_oauth_profiles
                    SET has_client_secret = 0;",
            )
            .map_err(|_| {
                "Não foi possível migrar a credencial Google para o banco local.".to_string()
            })?;
    }
    if !has_column("refresh_token")? {
        connection
            .execute_batch(
                "ALTER TABLE google_oauth_profiles
                   ADD COLUMN refresh_token TEXT;
                 UPDATE google_oauth_profiles
                    SET has_refresh_token = 0,
                        account_email = NULL,
                        subscription_tier = NULL,
                        eligible_runtime_count = 0,
                        eligible_gpu_count = 0,
                        provider_error = NULL,
                        connected_at = NULL;",
            )
            .map_err(|_| {
                "Não foi possível migrar a autorização Google para o banco local.".to_string()
            })?;
    }
    Ok(())
}

fn credentials_from_database(
    app: &AppHandle,
    profile_id: &str,
) -> CommandResult<(Option<String>, Option<String>)> {
    let connection = open_database(app)?;
    let (client_secret, legacy_token): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT client_secret, refresh_token
               FROM google_oauth_profiles WHERE profile_id = ?1",
            params![profile_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "As credenciais OAuth não foram encontradas neste dispositivo.".to_string())?;
    let token = read_or_migrate_token(
        &connection,
        profile_id,
        legacy_token,
        || read_keyring_token(profile_id),
        |token| save_keyring_token(profile_id, token),
    )?;
    Ok((client_secret, token))
}

fn read_or_migrate_token(
    connection: &Connection,
    profile_id: &str,
    legacy_token: Option<String>,
    read_token: impl Fn() -> CommandResult<Option<String>>,
    save_token: impl Fn(&str) -> CommandResult<()>,
) -> CommandResult<Option<String>> {
    let token = match read_token()? {
        Some(token) => Some(token),
        None => {
            if let Some(token) = legacy_token.as_deref() {
                save_token(token)?;
            }
            legacy_token
        }
    };
    if token.is_some() {
        connection.execute(
            "UPDATE google_oauth_profiles SET refresh_token = NULL, has_refresh_token = 1 WHERE profile_id = ?1",
            params![profile_id],
        ).map_err(|_| "Não foi possível concluir a migração da autorização Google.".to_string())?;
    }
    Ok(token)
}

fn publish_connection(app: &AppHandle, summary: &OAuthProfileSummary) {
    let _ = app.emit(OAUTH_STATUS_EVENT, summary);
}

fn persist_google_session(
    connection: &Connection,
    profile_id: &str,
    client_id: &str,
    email: &str,
    refresh_token: Option<&str>,
) -> CommandResult<()> {
    persist_google_session_with_store(
        connection,
        profile_id,
        client_id,
        email,
        refresh_token,
        |token| save_keyring_token(profile_id, token),
        || Ok(read_keyring_token(profile_id)?.is_some()),
    )
}

fn persist_google_session_with_store(
    connection: &Connection,
    profile_id: &str,
    client_id: &str,
    email: &str,
    refresh_token: Option<&str>,
    save_token: impl Fn(&str) -> CommandResult<()>,
    has_token: impl Fn() -> CommandResult<bool>,
) -> CommandResult<()> {
    let matching_profile: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM google_oauth_profiles WHERE profile_id = ?1 AND google_client_id = ?2)",
            params![profile_id, client_id],
            |row| row.get(0),
        )
        .map_err(|_| "Não foi possível confirmar a configuração OAuth local.".to_string())?;
    if !matching_profile {
        return Err("A configuração OAuth mudou durante a conexão. Conecte novamente.".into());
    }
    let available_token = if let Some(token) = refresh_token.filter(|token| !token.is_empty()) {
        save_token(token)?;
        true
    } else {
        has_token()?
    };
    if !available_token {
        return Err("O Google não retornou uma autorização persistente. Conecte novamente.".into());
    }
    let affected = connection
        .execute(
            "UPDATE google_oauth_profiles
            SET refresh_token = NULL,
                has_refresh_token = 1,
                account_email = ?3,
                provider_error = NULL,
                subscription_tier = NULL,
                eligible_runtime_count = 0,
                eligible_gpu_count = 0,
                connected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE profile_id = ?1 AND google_client_id = ?2",
            params![profile_id, client_id, email],
        )
        .map_err(|_| "Não foi possível salvar a conexão Google neste dispositivo.".to_string())?;
    if affected != 1 {
        return Err("A conexão não foi salva: a configuração mudou ou o Google não retornou autorização persistente. Conecte novamente.".into());
    }
    Ok(())
}

fn configure_bundled_client(
    connection: &Connection,
    profile_id: &str,
    client_id: &str,
    delete_token: impl Fn() -> CommandResult<()>,
) -> CommandResult<()> {
    let previous: Option<String> = connection
        .query_row(
            "SELECT google_client_id FROM google_oauth_profiles WHERE profile_id = ?1",
            params![profile_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Não foi possível ler o cliente OAuth anterior.".to_string())?;
    match previous {
        None => {
            connection.execute(
                    "INSERT INTO google_oauth_profiles (profile_id, google_client_id) VALUES (?1, ?2)",
                    params![profile_id, client_id],
                ).map_err(|_| "Não foi possível configurar o OAuth do aplicativo.".to_string())?;
        }
        Some(previous) if previous != client_id => {
            delete_token()?;
            connection
                .execute(
                    "UPDATE google_oauth_profiles SET google_client_id = ?2,
                        client_secret = NULL, has_client_secret = 0,
                        refresh_token = NULL, has_refresh_token = 0,
                        account_email = NULL, subscription_tier = NULL,
                        eligible_runtime_count = 0, eligible_gpu_count = 0,
                        provider_error = NULL, connected_at = NULL,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                      WHERE profile_id = ?1",
                    params![profile_id, client_id],
                )
                .map_err(|_| "Não foi possível ativar o OAuth do aplicativo.".to_string())?;
        }
        _ => {}
    }
    Ok(())
}

fn summary_from_database(app: &AppHandle, profile_id: &str) -> CommandResult<OAuthProfileSummary> {
    validate_profile_id(profile_id)?;
    let connection = open_database(app)?;
    if let Some(client_id) = bundled_client_id() {
        configure_bundled_client(&connection, profile_id, &client_id, || {
            delete_keyring_token(profile_id)
        })?;
    }
    let has_profile: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM google_oauth_profiles WHERE profile_id = ?1)",
            params![profile_id],
            |row| row.get(0),
        )
        .map_err(|_| "Não foi possível ler o perfil Google local.".to_string())?;
    let token_available = has_profile && credentials_from_database(app, profile_id)?.1.is_some();
    let summary = connection
        .query_row(
            "SELECT profile_id, google_client_id,
                    COALESCE(length(client_secret) > 0, 0),
                    COALESCE(length(refresh_token) > 0, 0),
                    account_email, subscription_tier, eligible_runtime_count,
                    eligible_gpu_count, provider_error, updated_at
               FROM google_oauth_profiles
              WHERE profile_id = ?1",
            params![profile_id],
            |row| {
                let has_client_secret: bool = row.get(2)?;
                let _has_refresh_token: bool = row.get(3)?;
                let account_email: Option<String> = row.get(4)?;
                Ok(OAuthProfileSummary {
                    profile_id: row.get(0)?,
                    client_id: row.get(1)?,
                    managed_client: bundled_client_id().as_deref()
                        == Some(row.get::<_, String>(1)?.as_str()),
                    has_client_secret,
                    connected: account_email.is_some() && token_available,
                    account_email,
                    subscription_tier: row.get(5)?,
                    eligible_runtime_count: row.get(6)?,
                    eligible_gpu_count: row.get(7)?,
                    provider_error: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|_| "Não foi possível ler a configuração OAuth local.".to_string())?;

    Ok(summary.unwrap_or_else(|| OAuthProfileSummary {
        profile_id: profile_id.to_string(),
        client_id: String::new(),
        managed_client: false,
        has_client_secret: false,
        connected: false,
        account_email: None,
        subscription_tier: None,
        eligible_runtime_count: 0,
        eligible_gpu_count: 0,
        provider_error: None,
        updated_at: None,
    }))
}

#[tauri::command]
pub fn get_google_oauth_config(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<OAuthProfileSummary> {
    summary_from_database(&app, &profile_id)
}

#[tauri::command]
pub fn save_google_oauth_config(
    app: AppHandle,
    profile_id: String,
    client_id: String,
    client_secret: Option<String>,
) -> CommandResult<OAuthProfileSummary> {
    validate_profile_id(&profile_id)?;
    let client_id = validate_client_id(&client_id)?;
    let connection = open_database(&app)?;
    let previous_configuration = connection
        .query_row(
            "SELECT google_client_id, has_client_secret
               FROM google_oauth_profiles WHERE profile_id = ?1",
            params![&profile_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()
        .map_err(|_| "Não foi possível verificar a configuração OAuth existente.".to_string())?;
    let client_changed = previous_configuration
        .as_ref()
        .is_some_and(|(previous, _)| previous != &client_id);
    let client_secret = client_secret
        .as_deref()
        .filter(|secret| !secret.trim().is_empty())
        .map(validate_client_secret)
        .transpose()?;
    let has_client_secret = client_secret.is_some()
        || (!client_changed
            && previous_configuration
                .as_ref()
                .is_some_and(|(_, has_secret)| *has_secret));

    connection
        .execute(
            "INSERT INTO google_oauth_profiles
             (profile_id, google_client_id, client_secret, has_client_secret)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(profile_id) DO UPDATE SET
               google_client_id = excluded.google_client_id,
               client_secret = CASE
                 WHEN google_oauth_profiles.google_client_id = excluded.google_client_id
                 THEN COALESCE(excluded.client_secret, google_oauth_profiles.client_secret)
                 ELSE excluded.client_secret END,
               has_client_secret = excluded.has_client_secret,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![&profile_id, &client_id, client_secret, has_client_secret],
        )
        .map_err(|_| "Não foi possível salvar o Client ID no banco local.".to_string())?;

    if client_changed {
        delete_keyring_token(&profile_id)?;
        connection
            .execute(
                "UPDATE google_oauth_profiles
                    SET account_email = NULL,
                        subscription_tier = NULL,
                        eligible_runtime_count = 0,
                        eligible_gpu_count = 0,
                        provider_error = NULL,
                        connected_at = NULL,
                        has_refresh_token = 0,
                        refresh_token = NULL
                  WHERE profile_id = ?1",
                params![&profile_id],
            )
            .map_err(|_| "Não foi possível invalidar a conexão anterior.".to_string())?;
    }

    summary_from_database(&app, &profile_id)
}

fn random_string(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn send_browser_response(stream: &mut TcpStream, success: bool) {
    let title = if success {
        "Conta conectada"
    } else {
        "Autorização não concluída"
    };
    let message = if success {
        "Você pode fechar esta aba e voltar ao Behavior Tracker."
    } else {
        "Volte ao Behavior Tracker para consultar o erro."
    };
    let body = format!(
        "<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{font-family:system-ui;background:#f5f6f2;color:#153c32;display:grid;place-items:center;min-height:100vh;margin:0}}main{{max-width:440px;background:white;border:1px solid #dfe4dd;border-radius:16px;padding:32px;box-shadow:0 12px 35px #153c3218}}h1{{font-size:24px}}p{{color:#65706b;line-height:1.6}}</style><main><h1>{title}</h1><p>{message}</p></main></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn wait_for_authorization_code(
    listener: TcpListener,
    expected_state: &str,
) -> CommandResult<(String, TcpStream)> {
    listener
        .set_nonblocking(true)
        .map_err(|_| "Não foi possível preparar o callback OAuth local.".to_string())?;
    let started = Instant::now();
    while started.elapsed() < AUTH_TIMEOUT {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .map_err(|_| {
                        "Não foi possível preparar a leitura do callback OAuth.".to_string()
                    })?;
                let mut buffer = [0_u8; 8192];
                let bytes_read = stream
                    .read(&mut buffer)
                    .map_err(|_| "Não foi possível ler o callback do Google.".to_string())?;
                let request = String::from_utf8_lossy(&buffer[..bytes_read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .ok_or_else(|| "Callback OAuth inválido.".to_string())?;
                let callback = Url::parse(&format!("http://127.0.0.1{path}"))
                    .map_err(|_| "Callback OAuth inválido.".to_string())?;
                let query: std::collections::HashMap<String, String> =
                    callback.query_pairs().into_owned().collect();

                if callback.path() != "/" {
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                }

                if query.get("state").map(String::as_str) != Some(expected_state) {
                    send_browser_response(&mut stream, false);
                    return Err("A validação de segurança do OAuth falhou. Tente novamente.".into());
                }
                if let Some(error) = query.get("error") {
                    send_browser_response(&mut stream, false);
                    return Err(match error.as_str() {
                        "access_denied" => "A autorização foi cancelada no navegador.".into(),
                        _ => "O Google recusou a autorização OAuth.".into(),
                    });
                }
                let Some(code) = query.get("code").filter(|code| !code.is_empty()).cloned() else {
                    send_browser_response(&mut stream, false);
                    return Err("O Google não retornou um código de autorização.".into());
                };
                return Ok((code, stream));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(120));
            }
            Err(_) => return Err("O listener OAuth local falhou.".into()),
        }
    }
    Err("A autorização expirou após 3 minutos. Tente novamente.".into())
}

fn token_error_message(status: u16, body: &str, context: &str) -> String {
    let value: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let code = value
        .get("error")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let description = value
        .get("error_description")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let detail = match code {
        "invalid_request" if description.contains("client_secret") =>
            "O Google exige a credencial deste cliente. Use Recuperar conexão anterior para importar a configuração já salva neste Mac.",
        "invalid_client" =>
            "O Google não reconheceu as credenciais deste aplicativo. Recupere a configuração anterior e tente conectar novamente.",
        "invalid_grant" =>
            "A autorização expirou ou foi revogada. Conecte a conta Google novamente.",
        "access_denied" => "O Google recusou a permissão solicitada.",
        _ => "O Google recusou a solicitação de autorização. Tente conectar novamente.",
    };
    format!("{context} (HTTP {status}). {detail}")
}

fn parse_token_response(
    response: reqwest::blocking::Response,
    context: &str,
) -> CommandResult<TokenResponse> {
    let status = response.status();
    let body = response
        .text()
        .map_err(|_| "Não foi possível ler a resposta de autorização Google.".to_string())?;
    if !status.is_success() {
        return Err(token_error_message(status.as_u16(), &body, context));
    }
    serde_json::from_str(&body).map_err(|_| "A resposta de token do Google é inválida.".to_string())
}

fn exchange_authorization_code(
    client: &Client,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> CommandResult<TokenResponse> {
    let mut form = vec![
        ("client_id", client_id.to_string()),
        ("code", code.to_string()),
        ("code_verifier", verifier.to_string()),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri.to_string()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret.to_string()));
    }
    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .map_err(|_| "Falha de rede durante a troca do código OAuth.".to_string())?;
    parse_token_response(response, "A conexão Google não foi concluída")
}

fn refresh_access_token(
    client: &Client,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> CommandResult<String> {
    let mut form = vec![
        ("client_id", client_id.to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret.to_string()));
    }
    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .map_err(|_| "Falha de rede ao renovar a autorização Google.".to_string())?;
    parse_token_response(response, "Não foi possível renovar a conexão Google")
        .map(|token| token.access_token)
}

pub(crate) fn google_access_token(app: &AppHandle, profile_id: &str) -> CommandResult<String> {
    let configuration = summary_from_database(app, profile_id)?;
    let (client_secret, refresh_token) = credentials_from_database(app, profile_id)?;
    let refresh_token =
        refresh_token.ok_or_else(|| "Conecte novamente a Conta Google.".to_string())?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Não foi possível iniciar o cliente HTTP seguro.".to_string())?;
    refresh_access_token(
        &client,
        &configuration.client_id,
        client_secret.as_deref(),
        &refresh_token,
    )
}

fn legacy_keychain_secret(service: &str, profile_id: &str) -> CommandResult<Option<String>> {
    let entry = Entry::new(service, profile_id)
        .map_err(|_| "Não foi possível abrir a credencial antiga no Keychain.".to_string())?;
    match entry.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("O macOS não liberou o acesso à credencial antiga. Permita uma vez para migrar a conexão.".into()),
    }
}

fn restore_legacy_google_session_blocking(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<OAuthProfileSummary> {
    validate_profile_id(&profile_id)?;
    let existing = summary_from_database(&app, &profile_id)?;
    if existing.connected {
        return Ok(existing);
    }
    if existing.client_id.is_empty() {
        return Err("Salve o Client ID antes de recuperar a conexão anterior.".into());
    }
    let (client_secret, refresh_token) = credentials_from_database(&app, &profile_id)?;
    let legacy_client_secret = if client_secret.is_none() {
        legacy_keychain_secret(CLIENT_SECRET_SERVICE, &profile_id)?
    } else {
        None
    };
    let legacy_refresh_token = if refresh_token.is_none() {
        legacy_keychain_secret(REFRESH_TOKEN_SERVICE, &profile_id)?
    } else {
        None
    };
    if let Some(token) = legacy_refresh_token.as_deref() {
        save_keyring_token(&profile_id, token)?;
    }
    let connection = open_database(&app)?;
    connection
        .execute(
            "UPDATE google_oauth_profiles
                SET client_secret = COALESCE(?2, client_secret),
                    has_client_secret = CASE WHEN ?2 IS NULL THEN has_client_secret ELSE 1 END,
                    refresh_token = NULL,
                    has_refresh_token = CASE WHEN ?3 IS NULL THEN has_refresh_token ELSE 1 END,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE profile_id = ?1",
            params![&profile_id, legacy_client_secret, legacy_refresh_token],
        )
        .map_err(|_| "Não foi possível migrar a conexão antiga para o banco local.".to_string())?;
    let (_, recovered_token) = credentials_from_database(&app, &profile_id)?;
    if recovered_token.is_none() {
        return summary_from_database(&app, &profile_id);
    }
    let access_token = google_access_token(&app, &profile_id)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Não foi possível iniciar o cliente HTTP seguro.".to_string())?;
    let email = fetch_account_email(&client, &access_token)?;
    persist_google_session(&connection, &profile_id, &existing.client_id, &email, None)?;
    publish_connection(&app, &summary_from_database(&app, &profile_id)?);
    let status = fetch_colab_status(&client, &access_token);
    store_connected_account(&app, &profile_id, &email, status)?;
    let summary = summary_from_database(&app, &profile_id)?;
    publish_connection(&app, &summary);
    Ok(summary)
}

#[tauri::command]
pub async fn restore_legacy_google_session(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<OAuthProfileSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        restore_legacy_google_session_blocking(app, profile_id)
    })
    .await
    .map_err(|_| "A recuperação da conexão foi interrompida.".to_string())?
}

fn fetch_account_email(client: &Client, access_token: &str) -> CommandResult<String> {
    let response = client
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Não foi possível consultar a identidade da Conta Google.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "A identidade da Conta Google não pôde ser confirmada (HTTP {}).",
            response.status().as_u16()
        ));
    }
    response
        .json::<UserInfo>()
        .map(|user| user.email)
        .map_err(|_| "A resposta de identidade do Google é inválida.".to_string())
}

fn fetch_colab_status(client: &Client, access_token: &str) -> CommandResult<ColabStatus> {
    let subscription_response = client
        .get("https://colaboratory.googleapis.com/v1beta/subscription")
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Não foi possível consultar a assinatura do Colab.".to_string())?;
    if !subscription_response.status().is_success() {
        return Err(format!(
            "A Colab API recusou a consulta de assinatura (HTTP {}). Verifique se a API está habilitada.",
            subscription_response.status().as_u16()
        ));
    }
    let subscription = subscription_response
        .json::<SubscriptionResponse>()
        .map_err(|_| "A resposta de assinatura do Colab é inválida.".to_string())?;

    let specs_response = client
        .get("https://colaboratory.googleapis.com/v1beta/runtimespecs")
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Não foi possível consultar os runtimes elegíveis do Colab.".to_string())?;
    if !specs_response.status().is_success() {
        return Err(format!(
            "A Colab API recusou a consulta de runtimes (HTTP {}).",
            specs_response.status().as_u16()
        ));
    }
    let specs = specs_response
        .json::<RuntimeSpecsResponse>()
        .map_err(|_| "A resposta de runtimes do Colab é inválida.".to_string())?;
    let eligible: Vec<&RuntimeSpec> = specs
        .runtime_specs
        .iter()
        .filter(|spec| spec.eligible)
        .collect();
    let eligible_gpu_count = eligible
        .iter()
        .filter(|spec| spec.key.variant == "VARIANT_GPU")
        .count() as i64;
    Ok(ColabStatus {
        tier: subscription.tier,
        eligible_runtime_count: eligible.len() as i64,
        eligible_gpu_count,
    })
}

fn store_connected_account(
    app: &AppHandle,
    profile_id: &str,
    email: &str,
    status: Result<ColabStatus, String>,
) -> CommandResult<()> {
    let connection = open_database(app)?;
    match status {
        Ok(status) => connection.execute(
            "UPDATE google_oauth_profiles
                SET account_email = ?2,
                    subscription_tier = ?3,
                    eligible_runtime_count = ?4,
                    eligible_gpu_count = ?5,
                    provider_error = NULL,
                    has_refresh_token = 1,
                    connected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE profile_id = ?1",
            params![
                profile_id,
                email,
                status.tier,
                status.eligible_runtime_count,
                status.eligible_gpu_count
            ],
        ),
        Err(error) => connection.execute(
            "UPDATE google_oauth_profiles
                SET account_email = ?2,
                    subscription_tier = NULL,
                    eligible_runtime_count = 0,
                    eligible_gpu_count = 0,
                    provider_error = ?3,
                    has_refresh_token = 1,
                    connected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE profile_id = ?1",
            params![profile_id, email, error],
        ),
    }
    .map_err(|_| "Não foi possível registrar a Conta Google conectada.".to_string())?;
    Ok(())
}

fn authorize_blocking(app: AppHandle, profile_id: String) -> CommandResult<OAuthProfileSummary> {
    let configuration = summary_from_database(&app, &profile_id)?;
    if configuration.client_id.is_empty() {
        return Err("Salve o Client ID antes de conectar a Conta Google.".into());
    }
    let (client_secret, _) = credentials_from_database(&app, &profile_id)?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Não foi possível abrir o callback OAuth local.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Não foi possível determinar a porta OAuth local.".to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let verifier = random_string(86);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_string(48);

    let mut authorize_url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|_| "Não foi possível montar a URL OAuth.".to_string())?;
    authorize_url
        .query_pairs_mut()
        .append_pair("client_id", &configuration.client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &format!("openid email {COLAB_SCOPE}"))
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");

    app.opener()
        .open_url(authorize_url.as_str(), None::<&str>)
        .map_err(|_| "Não foi possível abrir o navegador padrão.".to_string())?;
    let (code, mut callback_stream) = wait_for_authorization_code(listener, &state)?;
    let connected = (|| -> CommandResult<(Client, TokenResponse)> {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "Não foi possível iniciar o cliente HTTP seguro.".to_string())?;
        let token = exchange_authorization_code(
            &client,
            &configuration.client_id,
            client_secret.as_deref(),
            &code,
            &verifier,
            &redirect_uri,
        )?;
        let email = fetch_account_email(&client, &token.access_token)?;
        persist_google_session(
            &open_database(&app)?,
            &profile_id,
            &configuration.client_id,
            &email,
            token.refresh_token.as_deref(),
        )?;
        Ok((client, token))
    })();
    send_browser_response(&mut callback_stream, connected.is_ok());
    let (client, token) = connected?;
    let summary = summary_from_database(&app, &profile_id)?;
    publish_connection(&app, &summary);
    let status = fetch_colab_status(&client, &token.access_token);
    let email = summary
        .account_email
        .as_deref()
        .ok_or_else(|| "Não foi possível confirmar a conta salva.".to_string())?;
    store_connected_account(&app, &profile_id, email, status)?;
    let summary = summary_from_database(&app, &profile_id)?;
    publish_connection(&app, &summary);
    Ok(summary)
}

#[tauri::command]
pub async fn start_google_auth(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<OAuthProfileSummary> {
    tauri::async_runtime::spawn_blocking(move || authorize_blocking(app, profile_id))
        .await
        .map_err(|_| "A tarefa de autenticação foi interrompida.".to_string())?
}

fn check_eligibility_blocking(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<OAuthProfileSummary> {
    let configuration = summary_from_database(&app, &profile_id)?;
    let (client_secret, refresh_token) = credentials_from_database(&app, &profile_id)?;
    let refresh_token =
        refresh_token.ok_or_else(|| "Conecte novamente a Conta Google.".to_string())?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Não foi possível iniciar o cliente HTTP seguro.".to_string())?;
    let access_token = refresh_access_token(
        &client,
        &configuration.client_id,
        client_secret.as_deref(),
        &refresh_token,
    )?;
    let email = configuration
        .account_email
        .clone()
        .unwrap_or_else(|| "Conta Google".to_string());
    let status = fetch_colab_status(&client, &access_token);
    store_connected_account(&app, &profile_id, &email, status)?;
    summary_from_database(&app, &profile_id)
}

fn revoke_refresh_token(refresh_token: String) {
    if let Ok(client) = Client::builder().timeout(Duration::from_secs(15)).build() {
        let _ = client
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", refresh_token)])
            .send();
    }
}

#[tauri::command]
pub async fn check_colab_eligibility(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<OAuthProfileSummary> {
    tauri::async_runtime::spawn_blocking(move || check_eligibility_blocking(app, profile_id))
        .await
        .map_err(|_| "A consulta de elegibilidade foi interrompida.".to_string())?
}

#[tauri::command]
pub async fn disconnect_google_account(
    app: AppHandle,
    profile_id: String,
) -> CommandResult<OAuthProfileSummary> {
    let app_for_task = app.clone();
    let profile_for_task = profile_id.clone();
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<()> {
        validate_profile_id(&profile_for_task)?;
        let (_, refresh_token) = credentials_from_database(&app_for_task, &profile_for_task)?;
        if let Some(refresh_token) = refresh_token {
            revoke_refresh_token(refresh_token);
        }
        delete_keyring_token(&profile_for_task)?;
        let connection = open_database(&app_for_task)?;
        connection
            .execute(
                "UPDATE google_oauth_profiles
                    SET account_email = NULL,
                        subscription_tier = NULL,
                        eligible_runtime_count = 0,
                        eligible_gpu_count = 0,
                        provider_error = NULL,
                        connected_at = NULL,
                        has_refresh_token = 0,
                        refresh_token = NULL,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  WHERE profile_id = ?1",
                params![&profile_for_task],
            )
            .map_err(|_| "Não foi possível desconectar a Conta Google.".to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "A desconexão foi interrompida.".to_string())??;
    summary_from_database(&app, &profile_id)
}

#[tauri::command]
pub async fn delete_google_oauth_config(app: AppHandle, profile_id: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_profile_id(&profile_id)?;
        let (_, refresh_token) = credentials_from_database(&app, &profile_id)?;
        if let Some(refresh_token) = refresh_token {
            revoke_refresh_token(refresh_token);
        }
        delete_keyring_token(&profile_id)?;
        let connection = open_database(&app)?;
        connection
            .execute(
                "DELETE FROM google_oauth_profiles WHERE profile_id = ?1",
                params![profile_id],
            )
            .map_err(|_| "Não foi possível remover a configuração OAuth local.".to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "A remoção da configuração foi interrompida.".to_string())?
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        thread,
        time::Duration,
    };

    use super::{
        configure_bundled_client, migrate_credential_state, persist_google_session_with_store,
        read_or_migrate_token, send_browser_response, token_error_message, validate_client_id,
        validate_client_secret, validate_profile_id, wait_for_authorization_code,
    };

    #[test]
    fn accepts_a_desktop_oauth_client_id() {
        assert!(validate_client_id("123-example.apps.googleusercontent.com").is_ok());
    }

    #[test]
    fn rejects_non_google_or_spaced_client_ids() {
        assert!(validate_client_id("client.example.com").is_err());
        assert!(validate_client_id("123 example.apps.googleusercontent.com").is_err());
    }

    #[test]
    fn validates_local_profile_and_secret_boundaries() {
        assert!(validate_profile_id("local-default").is_ok());
        assert!(validate_profile_id("perfil com espaco").is_err());
        assert!(validate_client_secret("secret-value").is_ok());
        assert!(validate_client_secret("secret\nvalue").is_err());
    }

    #[test]
    fn legacy_profiles_require_a_fresh_database_authorization() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE google_oauth_profiles (
                   profile_id TEXT PRIMARY KEY NOT NULL,
                   google_client_id TEXT NOT NULL,
                   account_email TEXT,
                   subscription_tier TEXT,
                   eligible_runtime_count INTEGER NOT NULL DEFAULT 0,
                   eligible_gpu_count INTEGER NOT NULL DEFAULT 0,
                   provider_error TEXT,
                   connected_at TEXT,
                   updated_at TEXT
                 );
                 INSERT INTO google_oauth_profiles
                   (profile_id, google_client_id, account_email)
                 VALUES ('local-default', 'client.apps.googleusercontent.com', 'user@example.com');",
            )
            .unwrap();

        migrate_credential_state(&connection).unwrap();
        let flags: (bool, bool) = connection
            .query_row(
                "SELECT has_client_secret, has_refresh_token
                   FROM google_oauth_profiles WHERE profile_id = ?1",
                params!["local-default"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(flags, (false, false));
    }

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE google_oauth_profiles (
                profile_id TEXT PRIMARY KEY, google_client_id TEXT NOT NULL,
                account_email TEXT, refresh_token TEXT, client_secret TEXT,
                has_client_secret INTEGER DEFAULT 0, has_refresh_token INTEGER DEFAULT 0,
                subscription_tier TEXT, eligible_runtime_count INTEGER DEFAULT 0,
                eligible_gpu_count INTEGER DEFAULT 0, provider_error TEXT,
                connected_at TEXT, updated_at TEXT
             );
             INSERT INTO google_oauth_profiles (profile_id, google_client_id)
             VALUES ('local-default', 'client.apps.googleusercontent.com');",
            )
            .unwrap();
        connection
    }

    #[test]
    fn saves_identity_without_writing_the_refresh_token_to_sqlite() {
        let connection = test_connection();
        let saved_token = std::cell::RefCell::new(None::<String>);
        persist_google_session_with_store(
            &connection,
            "local-default",
            "client.apps.googleusercontent.com",
            "user@example.com",
            Some("test-refresh-token"),
            |token| {
                *saved_token.borrow_mut() = Some(token.to_string());
                Ok(())
            },
            || Ok(saved_token.borrow().is_some()),
        )
        .unwrap();
        migrate_credential_state(&connection).unwrap();
        let saved: (String, Option<String>, bool) = connection
            .query_row(
                "SELECT account_email, refresh_token, has_refresh_token FROM google_oauth_profiles",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(saved, ("user@example.com".into(), None, true));
        assert_eq!(saved_token.borrow().as_deref(), Some("test-refresh-token"));
        persist_google_session_with_store(
            &connection,
            "local-default",
            "client.apps.googleusercontent.com",
            "user@example.com",
            None,
            |_| Ok(()),
            || Ok(saved_token.borrow().is_some()),
        )
        .unwrap();
    }

    #[test]
    fn migrates_legacy_token_only_after_secure_storage_succeeds() {
        let connection = test_connection();
        connection.execute(
            "UPDATE google_oauth_profiles SET refresh_token = 'legacy-token' WHERE profile_id = 'local-default'",
            [],
        ).unwrap();
        assert!(read_or_migrate_token(
            &connection,
            "local-default",
            Some("legacy-token".into()),
            || Ok(None),
            |_| Err("cofre indisponível".into()),
        )
        .is_err());
        let retained: Option<String> = connection.query_row(
            "SELECT refresh_token FROM google_oauth_profiles WHERE profile_id = 'local-default'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(retained.as_deref(), Some("legacy-token"));
        let migrated = read_or_migrate_token(
            &connection,
            "local-default",
            retained,
            || Ok(None),
            |token| {
                assert_eq!(token, "legacy-token");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(migrated.as_deref(), Some("legacy-token"));
        let cleared: Option<String> = connection.query_row(
            "SELECT refresh_token FROM google_oauth_profiles WHERE profile_id = 'local-default'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(cleared, None);
    }

    #[test]
    fn bundled_client_replaces_a_different_local_client_and_requires_reconnection() {
        let connection = test_connection();
        connection.execute(
            "UPDATE google_oauth_profiles SET account_email = 'user@example.com', refresh_token = 'old-token' WHERE profile_id = 'local-default'",
            [],
        ).unwrap();
        let deleted = std::cell::Cell::new(false);
        configure_bundled_client(
            &connection,
            "local-default",
            "official.apps.googleusercontent.com",
            || {
                deleted.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert!(deleted.get());
        let state: (String, Option<String>, Option<String>) = connection.query_row(
            "SELECT google_client_id, account_email, refresh_token FROM google_oauth_profiles WHERE profile_id = 'local-default'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(
            state,
            ("official.apps.googleusercontent.com".into(), None, None)
        );
    }

    #[test]
    fn does_not_claim_connected_without_a_token_or_for_a_changed_client() {
        let connection = test_connection();
        assert!(persist_google_session_with_store(
            &connection,
            "local-default",
            "client.apps.googleusercontent.com",
            "user@example.com",
            None,
            |_| Ok(()),
            || Ok(false),
        )
        .is_err());
        assert!(persist_google_session_with_store(
            &connection,
            "local-default",
            "another.apps.googleusercontent.com",
            "user@example.com",
            Some("test-refresh-token"),
            |_| Ok(()),
            || Ok(true),
        )
        .is_err());
        let connected: bool = connection.query_row(
            "SELECT account_email IS NOT NULL OR refresh_token IS NOT NULL FROM google_oauth_profiles",
            [], |row| row.get(0),
        ).unwrap();
        assert!(!connected);
    }

    #[test]
    fn explains_missing_client_credentials_without_exposing_oauth_payloads() {
        let message = token_error_message(
            400,
            r#"{"error":"invalid_request","error_description":"client_secret is missing.","access_token":"do-not-display"}"#,
            "Conexão não concluída",
        );
        assert!(message.contains("Recuperar conexão anterior"));
        assert!(!message.contains("do-not-display"));
    }

    #[test]
    fn browser_success_waits_for_the_app_to_complete_authentication() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let browser = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .write_all(
                    b"GET /?state=test-state&code=test-code HTTP/1.1\r\nHost: localhost\r\n\r\n",
                )
                .unwrap();
            stream
        });
        let (code, mut callback_stream) =
            wait_for_authorization_code(listener, "test-state").unwrap();
        assert_eq!(code, "test-code");
        let mut browser_stream = browser.join().unwrap();
        browser_stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let mut buffer = [0_u8; 4096];
        let error = browser_stream.read(&mut buffer).unwrap_err();
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ));
        send_browser_response(&mut callback_stream, true);
        let bytes = browser_stream.read(&mut buffer).unwrap();
        assert!(String::from_utf8_lossy(&buffer[..bytes]).contains("Conta conectada"));
    }
}
