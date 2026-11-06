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
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const CLIENT_SECRET_SERVICE: &str = "com.behavetracker.desktop.google-oauth-client";
const REFRESH_TOKEN_SERVICE: &str = "com.behavetracker.desktop.google-oauth-refresh";
const COLAB_SCOPE: &str = "https://www.googleapis.com/auth/colaboratory";
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);

pub(crate) type CommandResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthProfileSummary {
    pub profile_id: String,
    pub client_id: String,
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

pub(crate) fn open_database(app: &AppHandle) -> CommandResult<Connection> {
    let data_dir = app.path().app_data_dir().map_err(|_| {
        "Não foi possível localizar o diretório de dados do aplicativo.".to_string()
    })?;
    fs::create_dir_all(&data_dir)
        .map_err(|_| "Não foi possível criar o diretório de dados do aplicativo.".to_string())?;
    let connection = Connection::open(data_dir.join("behavetracker.sqlite3"))
        .map_err(|_| "Não foi possível abrir o banco local do BehaveTracker.".to_string())?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS google_oauth_profiles (
               profile_id TEXT PRIMARY KEY NOT NULL,
               google_client_id TEXT NOT NULL,
               has_client_secret INTEGER NOT NULL DEFAULT 0,
               has_refresh_token INTEGER NOT NULL DEFAULT 0,
               account_email TEXT,
               subscription_tier TEXT,
               eligible_runtime_count INTEGER NOT NULL DEFAULT 0,
               eligible_gpu_count INTEGER NOT NULL DEFAULT 0,
               provider_error TEXT,
               connected_at TEXT,
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );",
        )
        .map_err(|_| "Não foi possível preparar o banco local do BehaveTracker.".to_string())?;
    migrate_credential_state(&connection)?;
    Ok(connection)
}

fn migrate_credential_state(connection: &Connection) -> CommandResult<()> {
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
                   ADD COLUMN has_client_secret INTEGER NOT NULL DEFAULT 0;
                 UPDATE google_oauth_profiles
                    SET has_client_secret = CASE WHEN google_client_id <> '' THEN 1 ELSE 0 END;",
            )
            .map_err(|_| "Não foi possível migrar o estado da credencial Google.".to_string())?;
    }
    if !has_column("has_refresh_token")? {
        connection
            .execute_batch(
                "ALTER TABLE google_oauth_profiles
                   ADD COLUMN has_refresh_token INTEGER NOT NULL DEFAULT 0;
                 UPDATE google_oauth_profiles
                    SET has_refresh_token = CASE WHEN account_email IS NOT NULL THEN 1 ELSE 0 END;",
            )
            .map_err(|_| "Não foi possível migrar o estado da autorização Google.".to_string())?;
    }
    Ok(())
}

fn secret_entry(service: &str, profile_id: &str) -> CommandResult<Entry> {
    Entry::new(service, profile_id)
        .map_err(|_| "O armazenamento seguro do sistema não está disponível.".to_string())
}

fn read_secret(service: &str, profile_id: &str) -> Option<String> {
    secret_entry(service, profile_id)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

fn write_secret(service: &str, profile_id: &str, value: &str) -> CommandResult<()> {
    secret_entry(service, profile_id)?
        .set_password(value)
        .map_err(|_| "Não foi possível salvar a credencial no armazenamento seguro.".to_string())
}

fn delete_secret(service: &str, profile_id: &str) {
    if let Ok(entry) = secret_entry(service, profile_id) {
        let _ = entry.delete_credential();
    }
}

fn summary_from_database(app: &AppHandle, profile_id: &str) -> CommandResult<OAuthProfileSummary> {
    validate_profile_id(profile_id)?;
    let connection = open_database(app)?;
    let summary = connection
        .query_row(
            "SELECT profile_id, google_client_id, has_client_secret, has_refresh_token,
                    account_email, subscription_tier, eligible_runtime_count,
                    eligible_gpu_count, provider_error, updated_at
               FROM google_oauth_profiles
              WHERE profile_id = ?1",
            params![profile_id],
            |row| {
                let has_client_secret: bool = row.get(2)?;
                let has_refresh_token: bool = row.get(3)?;
                let account_email: Option<String> = row.get(4)?;
                Ok(OAuthProfileSummary {
                    profile_id: row.get(0)?,
                    client_id: row.get(1)?,
                    has_client_secret,
                    connected: account_email.is_some() && has_refresh_token,
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
    let previously_had_secret = previous_configuration
        .as_ref()
        .is_some_and(|(_, has_secret)| *has_secret);

    let client_secret = client_secret
        .as_deref()
        .filter(|secret| !secret.trim().is_empty())
        .map(validate_client_secret)
        .transpose()?;
    if client_changed && client_secret.is_none() {
        return Err("O Client ID mudou. Informe também o Client secret correspondente.".into());
    }
    if client_secret.is_none() && !previously_had_secret {
        return Err("Informe o Client secret antes de salvar a configuração.".into());
    }

    if let Some(secret) = client_secret.as_deref() {
        write_secret(CLIENT_SECRET_SERVICE, &profile_id, secret)?;
    }

    connection
        .execute(
            "INSERT INTO google_oauth_profiles
             (profile_id, google_client_id, has_client_secret)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(profile_id) DO UPDATE SET
               google_client_id = excluded.google_client_id,
               has_client_secret = excluded.has_client_secret,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![
                &profile_id,
                &client_id,
                client_secret.is_some() || previously_had_secret
            ],
        )
        .map_err(|_| "Não foi possível salvar o Client ID no banco local.".to_string())?;

    if client_changed {
        delete_secret(REFRESH_TOKEN_SERVICE, &profile_id);
        connection
            .execute(
                "UPDATE google_oauth_profiles
                    SET account_email = NULL,
                        subscription_tier = NULL,
                        eligible_runtime_count = 0,
                        eligible_gpu_count = 0,
                        provider_error = NULL,
                        connected_at = NULL,
                        has_refresh_token = 0
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
        "Você pode fechar esta aba e voltar ao BehaveTracker."
    } else {
        "Volte ao BehaveTracker para consultar o erro."
    };
    let body = format!(
        "<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{font-family:system-ui;background:#f5f6f2;color:#153c32;display:grid;place-items:center;min-height:100vh;margin:0}}main{{max-width:440px;background:white;border:1px solid #dfe4dd;border-radius:16px;padding:32px;box-shadow:0 12px 35px #153c3218}}h1{{font-size:24px}}p{{color:#65706b;line-height:1.6}}</style><main><h1>{title}</h1><p>{message}</p></main></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn wait_for_authorization_code(
    listener: TcpListener,
    expected_state: &str,
) -> CommandResult<String> {
    listener
        .set_nonblocking(true)
        .map_err(|_| "Não foi possível preparar o callback OAuth local.".to_string())?;
    let started = Instant::now();
    while started.elapsed() < AUTH_TIMEOUT {
        match listener.accept() {
            Ok((mut stream, _)) => {
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
                let code = query
                    .get("code")
                    .cloned()
                    .ok_or_else(|| "O Google não retornou um código de autorização.".to_string())?;
                send_browser_response(&mut stream, true);
                return Ok(code);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(120));
            }
            Err(_) => return Err("O listener OAuth local falhou.".into()),
        }
    }
    Err("A autorização expirou após 3 minutos. Tente novamente.".into())
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
    if !response.status().is_success() {
        return Err(format!(
            "O Google recusou a troca do código OAuth (HTTP {}).",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .map_err(|_| "A resposta de token do Google é inválida.".to_string())
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
    if !response.status().is_success() {
        return Err(format!(
            "A autorização Google precisa ser refeita (HTTP {}).",
            response.status().as_u16()
        ));
    }
    response
        .json::<TokenResponse>()
        .map(|token| token.access_token)
        .map_err(|_| "A resposta de renovação do Google é inválida.".to_string())
}

pub(crate) fn google_access_token(app: &AppHandle, profile_id: &str) -> CommandResult<String> {
    let configuration = summary_from_database(app, profile_id)?;
    if !configuration.connected {
        return Err("Conecte a Conta Google antes de iniciar a análise.".into());
    }
    let refresh_token = read_secret(REFRESH_TOKEN_SERVICE, profile_id)
        .ok_or_else(|| "Conecte novamente a Conta Google.".to_string())?;
    let client_secret = read_secret(CLIENT_SECRET_SERVICE, profile_id);
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
    let client_secret = read_secret(CLIENT_SECRET_SERVICE, &profile_id);
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
    let code = wait_for_authorization_code(listener, &state)?;
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
    if let Some(refresh_token) = token.refresh_token.as_deref() {
        write_secret(REFRESH_TOKEN_SERVICE, &profile_id, refresh_token)?;
    } else if !configuration.connected {
        return Err(
            "O Google não retornou autorização persistente. Revogue o acesso do app e tente novamente."
                .into(),
        );
    }
    let email = fetch_account_email(&client, &token.access_token)?;
    let status = fetch_colab_status(&client, &token.access_token);
    store_connected_account(&app, &profile_id, &email, status)?;
    summary_from_database(&app, &profile_id)
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
    let refresh_token = read_secret(REFRESH_TOKEN_SERVICE, &profile_id)
        .ok_or_else(|| "Conecte novamente a Conta Google.".to_string())?;
    let client_secret = read_secret(CLIENT_SECRET_SERVICE, &profile_id);
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
        if let Some(refresh_token) = read_secret(REFRESH_TOKEN_SERVICE, &profile_for_task) {
            revoke_refresh_token(refresh_token);
        }
        delete_secret(REFRESH_TOKEN_SERVICE, &profile_for_task);
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
        if let Some(refresh_token) = read_secret(REFRESH_TOKEN_SERVICE, &profile_id) {
            revoke_refresh_token(refresh_token);
        }
        delete_secret(CLIENT_SECRET_SERVICE, &profile_id);
        delete_secret(REFRESH_TOKEN_SERVICE, &profile_id);
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

    use super::{
        migrate_credential_state, validate_client_id, validate_client_secret,
        validate_profile_id,
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
    fn migrates_keychain_presence_without_reading_the_keychain() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE google_oauth_profiles (
                   profile_id TEXT PRIMARY KEY NOT NULL,
                   google_client_id TEXT NOT NULL,
                   account_email TEXT
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
        assert_eq!(flags, (true, true));
    }
}
