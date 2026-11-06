use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore;
use reqwest::blocking::{Client, Response};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::oauth::{google_access_token, open_database, CommandResult};

const PROFILE_ID: &str = "local-default";
const COLAB_API: &str = "https://colaboratory.googleapis.com";
const MCP_ENDPOINT: &str = "https://colaboratory.googleapis.com/mcp";
const LOCAL_CHUNK_LIMIT: usize = 8 * 1024 * 1024;
const REMOTE_CHUNK_SIZE: usize = 1024 * 1024;
const MAX_VIDEO_SIZE: i64 = 20 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStaging {
    upload_id: String,
    expected_size: i64,
    received_size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColabJob {
    job_id: String,
    experiment_id: String,
    status: String,
    stage: String,
    progress: i64,
    message: String,
    runtime_name: Option<String>,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAnalysisRequest {
    experiment_id: String,
    upload_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeSpecKey {
    #[serde(default)]
    variant: String,
    #[serde(default)]
    accelerator: String,
    #[serde(default)]
    shape: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeSpec {
    #[serde(default)]
    eligible: bool,
    #[serde(default)]
    key: RuntimeSpecKey,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeSpecsResponse {
    #[serde(default)]
    runtime_specs: Vec<RuntimeSpec>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    #[serde(default)]
    token: String,
    #[serde(default)]
    url: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Runtime {
    #[serde(default)]
    name: String,
    #[serde(default)]
    runtime_spec: RuntimeSpecKey,
    connection_info: Option<ConnectionInfo>,
}

#[derive(Debug, Deserialize, Default)]
struct RuntimesResponse {
    #[serde(default)]
    runtimes: Vec<Runtime>,
}

fn new_uuid_v4() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn validate_local_id(value: &str, label: &str) -> CommandResult<()> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!("{label} inválido."));
    }
    Ok(())
}

fn safe_extension(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 8
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_else(|| ".mp4".to_string())
}

fn prepare_tables(app: &AppHandle) -> CommandResult<()> {
    open_database(app)?
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS video_staging (
               upload_id TEXT PRIMARY KEY NOT NULL,
               experiment_id TEXT NOT NULL,
               local_path TEXT NOT NULL,
               original_filename TEXT NOT NULL,
               expected_size INTEGER NOT NULL,
               received_size INTEGER NOT NULL DEFAULT 0,
               sha256 TEXT,
               ready INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );
             CREATE TABLE IF NOT EXISTS colab_jobs (
               job_id TEXT PRIMARY KEY NOT NULL,
               profile_id TEXT NOT NULL,
               experiment_id TEXT NOT NULL,
               upload_id TEXT NOT NULL,
               status TEXT NOT NULL,
               stage TEXT NOT NULL,
               progress INTEGER NOT NULL,
               message TEXT NOT NULL,
               runtime_name TEXT,
               session_name TEXT,
               result_path TEXT,
               error TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );
             CREATE INDEX IF NOT EXISTS idx_colab_jobs_experiment
               ON colab_jobs(experiment_id, created_at);",
        )
        .map_err(|_| "Não foi possível preparar o armazenamento dos jobs Colab.".to_string())?;
    Ok(())
}

fn staging_directory(app: &AppHandle) -> CommandResult<PathBuf> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Não foi possível localizar o cache do aplicativo.".to_string())?
        .join("video-staging");
    fs::create_dir_all(&directory)
        .map_err(|_| "Não foi possível preparar o cache temporário de vídeo.".to_string())?;
    Ok(directory)
}

#[tauri::command]
pub fn begin_video_staging(
    app: AppHandle,
    experiment_id: String,
    filename: String,
    expected_size: i64,
) -> CommandResult<VideoStaging> {
    validate_local_id(&experiment_id, "Experimento")?;
    if expected_size <= 0 || expected_size > MAX_VIDEO_SIZE {
        return Err("O vídeo deve ter entre 1 byte e 20 GB.".into());
    }
    if filename.trim().is_empty() || filename.len() > 512 {
        return Err("Nome de vídeo inválido.".into());
    }
    prepare_tables(&app)?;
    let upload_id = new_uuid_v4();
    let path = staging_directory(&app)?.join(format!("{upload_id}{}", safe_extension(&filename)));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Não foi possível criar o arquivo temporário do vídeo.".to_string())?;
    open_database(&app)?
        .execute(
            "INSERT INTO video_staging
             (upload_id, experiment_id, local_path, original_filename, expected_size)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &upload_id,
                &experiment_id,
                path.to_string_lossy().as_ref(),
                &filename,
                expected_size
            ],
        )
        .map_err(|_| "Não foi possível registrar o upload temporário.".to_string())?;
    Ok(VideoStaging {
        upload_id,
        expected_size,
        received_size: 0,
    })
}

#[tauri::command]
pub fn append_video_staging_chunk(
    app: AppHandle,
    upload_id: String,
    offset: i64,
    bytes: Vec<u8>,
) -> CommandResult<VideoStaging> {
    validate_local_id(&upload_id, "Upload")?;
    if bytes.is_empty() || bytes.len() > LOCAL_CHUNK_LIMIT {
        return Err("Bloco de vídeo inválido.".into());
    }
    prepare_tables(&app)?;
    let connection = open_database(&app)?;
    let (path, expected_size, received_size, ready): (String, i64, i64, i64) = connection
        .query_row(
            "SELECT local_path, expected_size, received_size, ready
               FROM video_staging WHERE upload_id = ?1",
            params![&upload_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "Upload temporário não encontrado.".to_string())?;
    if ready != 0 || offset != received_size {
        return Err("A sequência dos blocos do vídeo é inválida.".into());
    }
    let next_size = received_size + bytes.len() as i64;
    if next_size > expected_size {
        return Err("O vídeo recebido é maior que o tamanho declarado.".into());
    }
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|_| "Não foi possível abrir o vídeo temporário.".to_string())?;
    file.write_all(&bytes)
        .map_err(|_| "Falha ao gravar um bloco do vídeo.".to_string())?;
    connection
        .execute(
            "UPDATE video_staging
                SET received_size = ?2,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE upload_id = ?1",
            params![&upload_id, next_size],
        )
        .map_err(|_| "Não foi possível atualizar o upload temporário.".to_string())?;
    Ok(VideoStaging {
        upload_id,
        expected_size,
        received_size: next_size,
    })
}

#[tauri::command]
pub fn finish_video_staging(app: AppHandle, upload_id: String) -> CommandResult<VideoStaging> {
    validate_local_id(&upload_id, "Upload")?;
    prepare_tables(&app)?;
    let connection = open_database(&app)?;
    let (path, expected_size, received_size): (String, i64, i64) = connection
        .query_row(
            "SELECT local_path, expected_size, received_size
               FROM video_staging WHERE upload_id = ?1",
            params![&upload_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "Upload temporário não encontrado.".to_string())?;
    let actual_size = fs::metadata(&path)
        .map_err(|_| "O vídeo temporário não está disponível.".to_string())?
        .len() as i64;
    if received_size != expected_size || actual_size != expected_size {
        return Err(format!(
            "Upload incompleto: recebidos {received_size} de {expected_size} bytes."
        ));
    }
    let mut file = File::open(&path)
        .map_err(|_| "Não foi possível validar o vídeo temporário.".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; REMOTE_CHUNK_SIZE];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Falha ao validar o vídeo temporário.".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let sha256 = format!("{:x}", hasher.finalize());
    connection
        .execute(
            "UPDATE video_staging
                SET sha256 = ?2, ready = 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE upload_id = ?1",
            params![&upload_id, &sha256],
        )
        .map_err(|_| "Não foi possível finalizar o upload temporário.".to_string())?;
    Ok(VideoStaging {
        upload_id,
        expected_size,
        received_size,
    })
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<ColabJob> {
    Ok(ColabJob {
        job_id: row.get(0)?,
        experiment_id: row.get(1)?,
        status: row.get(2)?,
        stage: row.get(3)?,
        progress: row.get(4)?,
        message: row.get(5)?,
        runtime_name: row.get(6)?,
        error: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn get_job(app: &AppHandle, job_id: &str) -> CommandResult<ColabJob> {
    open_database(app)?
        .query_row(
            "SELECT job_id, experiment_id, status, stage, progress, message,
                    runtime_name, error, created_at, updated_at
               FROM colab_jobs WHERE job_id = ?1",
            params![job_id],
            row_to_job,
        )
        .map_err(|_| "Job Colab não encontrado.".to_string())
}

#[tauri::command]
pub fn get_colab_job(app: AppHandle, job_id: String) -> CommandResult<ColabJob> {
    validate_local_id(&job_id, "Job")?;
    prepare_tables(&app)?;
    get_job(&app, &job_id)
}

fn update_job(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    stage: &str,
    progress: i64,
    message: &str,
) -> CommandResult<()> {
    open_database(app)?
        .execute(
            "UPDATE colab_jobs
                SET status = ?2, stage = ?3, progress = ?4, message = ?5,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE job_id = ?1",
            params![job_id, status, stage, progress.clamp(0, 100), message],
        )
        .map_err(|_| "Não foi possível atualizar o job Colab.".to_string())?;
    Ok(())
}

fn response_json(response: Response, context: &str) -> CommandResult<Value> {
    let status = response.status();
    let body = response
        .text()
        .map_err(|_| format!("{context}: resposta ilegível."))?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_else(|| body.chars().take(300).collect());
        return Err(format!("{context} (HTTP {}): {detail}", status.as_u16()));
    }
    serde_json::from_str(&body).map_err(|_| format!("{context}: JSON inválido."))
}

fn api_client() -> CommandResult<Client> {
    Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "Não foi possível iniciar o cliente da Colab API.".to_string())
}

fn get_runtime(client: &Client, access_token: &str, name: &str) -> CommandResult<Runtime> {
    let response = client
        .get(format!("{COLAB_API}/v1beta/{name}"))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Falha de rede ao consultar o runtime Colab.".to_string())?;
    let value = response_json(response, "Não foi possível consultar o runtime Colab")?;
    serde_json::from_value(value).map_err(|_| "Runtime Colab inválido.".to_string())
}

fn choose_or_create_runtime(access_token: &str) -> CommandResult<Runtime> {
    let client = api_client()?;
    let response = client
        .get(format!("{COLAB_API}/v1beta/runtimes"))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Falha de rede ao listar runtimes Colab.".to_string())?;
    let value = response_json(response, "Não foi possível listar os runtimes Colab")?;
    let mut runtimes: RuntimesResponse = serde_json::from_value(value)
        .map_err(|_| "A lista de runtimes Colab é inválida.".to_string())?;
    if let Some(runtime) = runtimes
        .runtimes
        .drain(..)
        .find(|runtime| runtime.runtime_spec.variant == "VARIANT_GPU")
    {
        return get_runtime(&client, access_token, &runtime.name);
    }

    let response = client
        .get(format!("{COLAB_API}/v1beta/runtimespecs"))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Falha de rede ao consultar runtimes elegíveis.".to_string())?;
    let value = response_json(response, "Não foi possível consultar os runtimes elegíveis")?;
    let specs: RuntimeSpecsResponse = serde_json::from_value(value)
        .map_err(|_| "A lista de runtimes elegíveis é inválida.".to_string())?;
    let spec = specs
        .runtime_specs
        .into_iter()
        .filter(|spec| spec.eligible && spec.key.variant == "VARIANT_GPU")
        .min_by_key(|spec| if spec.key.shape == "SHAPE_STANDARD" { 0 } else { 1 })
        .ok_or_else(|| {
            "A conta não possui um runtime GPU elegível agora. Verifique a disponibilidade no Colab e tente novamente."
                .to_string()
        })?;
    let request_id = new_uuid_v4();
    let runtime_id = format!(
        "behavetracker-{}",
        request_id.split('-').next().unwrap_or("job")
    );
    let response = client
        .post(format!("{COLAB_API}/v1beta/runtimes"))
        .query(&[
            ("requestId", request_id.as_str()),
            ("runtimeId", runtime_id.as_str()),
        ])
        .bearer_auth(access_token)
        .json(&json!({ "runtimeSpec": spec.key }))
        .send()
        .map_err(|_| "Falha de rede ao criar o runtime Colab.".to_string())?;
    let mut operation = response_json(response, "Não foi possível criar o runtime Colab")?;
    let operation_name = operation
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "A Colab API não retornou a operação de criação.".to_string())?
        .to_string();

    for _ in 0..150 {
        if operation.get("done").and_then(Value::as_bool) == Some(true) {
            if let Some(message) = operation.pointer("/error/message").and_then(Value::as_str) {
                return Err(format!("A criação do runtime Colab falhou: {message}"));
            }
            let runtime_name = operation
                .pointer("/response/name")
                .and_then(Value::as_str)
                .unwrap_or_else(|| {
                    // The requested runtime name is deterministic even when the operation omits response.
                    ""
                });
            let name = if runtime_name.is_empty() {
                format!("runtimes/{runtime_id}")
            } else {
                runtime_name.to_string()
            };
            return get_runtime(&client, access_token, &name);
        }
        thread::sleep(Duration::from_secs(2));
        let response = client
            .get(format!("{COLAB_API}/v1/{operation_name}"))
            .bearer_auth(access_token)
            .send()
            .map_err(|_| "Falha de rede ao aguardar o runtime Colab.".to_string())?;
        operation = response_json(response, "Não foi possível acompanhar a criação do runtime")?;
    }
    Err("O runtime Colab não ficou pronto em 5 minutos.".into())
}

fn jupyter_url(connection: &ConnectionInfo, path: &str) -> String {
    format!(
        "{}/{}",
        connection.url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn put_jupyter_model(
    client: &Client,
    connection: &ConnectionInfo,
    remote_path: &str,
    model: &Value,
) -> CommandResult<()> {
    let response = client
        .put(jupyter_url(
            connection,
            &format!("api/contents/{remote_path}"),
        ))
        .header("X-Colab-Runtime-Proxy-Token", &connection.token)
        .json(model)
        .send()
        .map_err(|_| "Falha de rede durante o upload ao runtime.".to_string())?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let detail = response.text().unwrap_or_default();
        return Err(format!(
            "O Jupyter recusou o upload (HTTP {status}): {}",
            detail.chars().take(240).collect::<String>()
        ));
    }
    Ok(())
}

fn ensure_jupyter_directory(
    client: &Client,
    connection: &ConnectionInfo,
    remote_path: &str,
) -> CommandResult<()> {
    let response = client
        .get(jupyter_url(
            connection,
            &format!("api/contents/{remote_path}?content=0"),
        ))
        .header("X-Colab-Runtime-Proxy-Token", &connection.token)
        .send()
        .map_err(|_| "Falha de rede ao verificar a pasta remota.".to_string())?;
    if response.status().is_success() {
        return Ok(());
    }
    put_jupyter_model(
        client,
        connection,
        remote_path,
        &json!({ "type": "directory" }),
    )
}

fn upload_video(
    app: &AppHandle,
    job_id: &str,
    connection: &ConnectionInfo,
    local_path: &Path,
    remote_directory: &str,
    remote_file: &str,
    size: i64,
) -> CommandResult<()> {
    let client = api_client()?;
    ensure_jupyter_directory(&client, connection, "behavetracker")?;
    ensure_jupyter_directory(&client, connection, remote_directory)?;
    let mut file = File::open(local_path)
        .map_err(|_| "O vídeo temporário não está mais disponível.".to_string())?;
    let mut buffer = vec![0_u8; REMOTE_CHUNK_SIZE];
    let mut sent = 0_i64;
    let mut chunk_number = 1_i64;
    let chunked = size > REMOTE_CHUNK_SIZE as i64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Falha ao ler o vídeo durante o upload.".to_string())?;
        if read == 0 {
            break;
        }
        sent += read as i64;
        let last = sent == size;
        let mut model = json!({
            "type": "file",
            "format": "base64",
            "content": STANDARD.encode(&buffer[..read])
        });
        if chunked {
            model["chunk"] = json!(if last { -1 } else { chunk_number });
        }
        put_jupyter_model(&client, connection, remote_file, &model)?;
        chunk_number += 1;
        let progress = 20 + ((sent as f64 / size as f64) * 25.0).round() as i64;
        update_job(
            app,
            job_id,
            "running",
            "uploading",
            progress,
            &format!(
                "Enviando vídeo ao Colab · {}%",
                ((sent * 100) / size).min(100)
            ),
        )?;
    }
    if sent != size {
        return Err("O upload remoto terminou com tamanho incorreto.".into());
    }
    Ok(())
}

fn parse_mcp_payload(body: &str) -> CommandResult<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return Ok(value);
    }
    let mut final_value = None;
    for line in body.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                if value.get("id").is_some() {
                    final_value = Some(value);
                }
            }
        }
    }
    final_value.ok_or_else(|| "A resposta MCP do Colab é inválida.".to_string())
}

fn mcp_request(
    access_token: &str,
    tool: &str,
    arguments: Value,
    timeout: Duration,
) -> CommandResult<Value> {
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|_| "Não foi possível iniciar o cliente MCP do Colab.".to_string())?;
    let response = client
        .post(MCP_ENDPOINT)
        .bearer_auth(access_token)
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": tool, "arguments": arguments }
        }))
        .send()
        .map_err(|error| format!("Falha ao chamar o Colab MCP: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|_| "A resposta MCP do Colab não pôde ser lida.".to_string())?;
    if !status.is_success() {
        return Err(format!(
            "O Colab MCP recusou a execução (HTTP {}): {}",
            status.as_u16(),
            body.chars().take(400).collect::<String>()
        ));
    }
    let value = parse_mcp_payload(&body)?;
    if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
        return Err(format!("O Colab MCP retornou um erro: {message}"));
    }
    let result = value
        .get("result")
        .cloned()
        .ok_or_else(|| "O Colab MCP não retornou um resultado.".to_string())?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        let text = result
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(if text.is_empty() {
            "A execução no Colab falhou sem detalhes.".to_string()
        } else {
            text
        });
    }
    Ok(result)
}

fn execute_code(access_token: &str, session: &str, code: &str) -> CommandResult<Value> {
    let execution_id = new_uuid_v4();
    let arguments = json!({
        "session": session,
        "code": code,
        "executionId": execution_id
    });
    let mut last_error = None;
    for _ in 0..5 {
        match mcp_request(
            access_token,
            "execute_code",
            arguments.clone(),
            Duration::from_secs(620),
        ) {
            Ok(result) => {
                let structured = result
                    .get("structuredContent")
                    .or_else(|| result.get("structured_content"))
                    .cloned()
                    .or_else(|| {
                        result
                            .get("content")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .find_map(|item| {
                                item.get("text")
                                    .and_then(Value::as_str)
                                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                            })
                    });
                if let Some(execution_error) = structured
                    .as_ref()
                    .and_then(|value| value.get("executionError"))
                    .filter(|value| !value.is_null())
                {
                    let name = execution_error
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("Erro Python");
                    let message = execution_error
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or("A célula executada no Colab falhou.");
                    let stderr = structured
                        .as_ref()
                        .and_then(|value| value.get("stderr"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    return Err(format!("{name}: {message}\n{stderr}"));
                }
                return Ok(result);
            }
            Err(error)
                if error.contains("DEADLINE_EXCEEDED")
                    || error.contains("HTTP 504")
                    || error.contains("timed out") =>
            {
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "A execução no Colab excedeu o tempo permitido.".to_string()))
}

fn best_effort_delete_session(access_token: &str, session: &str) {
    let _ = mcp_request(
        access_token,
        "delete_session",
        json!({ "name": session }),
        Duration::from_secs(30),
    );
}

fn inference_code(remote_video: &str, remote_output: &str, canonical_csv: &str) -> String {
    format!(
        r#"import glob
import math
import os
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
from deeplabcut.modelzoo.video_inference import video_inference_superanimal

video_path = {remote_video:?}
output_dir = {remote_output:?}
canonical_path = {canonical_csv:?}
os.makedirs(output_dir, exist_ok=True)

video_inference_superanimal(
    videos=video_path,
    superanimal_name="superanimal_topviewmouse",
    model_name="hrnet_w32",
    detector_name="fasterrcnn_resnet50_fpn_v2",
    video_adapt=False,
    max_individuals=1,
    dest_folder=output_dir,
    create_labeled_video=False,
    plot_trajectories=False,
)

h5_files = sorted(glob.glob(os.path.join(output_dir, "*.h5")), key=os.path.getmtime)
if not h5_files:
    raise RuntimeError("DeepLabCut terminou sem produzir o arquivo H5 de poses")
poses = pd.read_hdf(h5_files[-1])
if not isinstance(poses.columns, pd.MultiIndex):
    raise RuntimeError("Formato de colunas do DeepLabCut não reconhecido")

available = {{}}
for column in poses.columns:
    parts = [str(value) for value in column]
    coord_index = next((i for i, value in enumerate(parts) if value.lower() in {{"x", "y", "likelihood"}}), None)
    if coord_index is None or coord_index == 0:
        continue
    coordinate = parts[coord_index].lower()
    bodypart = parts[coord_index - 1].lower().replace("-", "_").replace(" ", "_")
    available.setdefault((bodypart, coordinate), poses[column])

def find_bodypart(aliases):
    normalized = [value.lower().replace("-", "_").replace(" ", "_") for value in aliases]
    for alias in normalized:
        if (alias, "x") in available and (alias, "y") in available:
            return alias
    for bodypart, coordinate in available:
        if coordinate == "x" and any(alias in bodypart or bodypart in alias for alias in normalized):
            if (bodypart, "y") in available:
                return bodypart
    return None

aliases = {{
    "nose": ["nose", "snout", "muzzle"],
    "tail_base": ["tail_base", "tailbase", "tail_root", "tailroot"],
    "left_ear": ["left_ear", "leftear", "ear_left"],
    "right_ear": ["right_ear", "rightear", "ear_right"],
}}

selected = {{name: find_bodypart(values) for name, values in aliases.items()}}
all_bodyparts = sorted({{bodypart for bodypart, coordinate in available if coordinate == "x" and (bodypart, "y") in available}})
torso = [
    bodypart for bodypart in all_bodyparts
    if any(token in bodypart for token in ("spine", "body", "center", "centre", "shoulder", "hip", "back"))
    and not any(token in bodypart for token in ("tail", "paw", "ear", "nose", "snout"))
]
if not torso:
    torso = [bodypart for bodypart in all_bodyparts if not any(token in bodypart for token in ("tail", "paw", "ear", "nose", "snout"))]
if not torso:
    torso = all_bodyparts

capture = cv2.VideoCapture(video_path)
fps = float(capture.get(cv2.CAP_PROP_FPS))
capture.release()
if not math.isfinite(fps) or fps <= 0:
    fps = 30.0

rows = []
for frame_position, frame_index in enumerate(poses.index):
    try:
        numeric_frame = int(frame_index)
    except Exception:
        numeric_frame = frame_position
    timestamp = numeric_frame / fps

    values = []
    likelihoods = []
    for bodypart in torso:
        x = available[(bodypart, "x")].iloc[frame_position]
        y = available[(bodypart, "y")].iloc[frame_position]
        likelihood = available.get((bodypart, "likelihood"))
        likelihood = likelihood.iloc[frame_position] if likelihood is not None else 1.0
        if pd.notna(x) and pd.notna(y):
            values.append((float(x), float(y)))
            likelihoods.append(float(likelihood) if pd.notna(likelihood) else 0.0)
    center_x = float(np.mean([value[0] for value in values])) if values else None
    center_y = float(np.mean([value[1] for value in values])) if values else None
    center_likelihood = float(np.mean(likelihoods)) if likelihoods else 0.0
    status = "missing" if center_x is None or center_y is None or center_likelihood < 0.1 else ("low_confidence" if center_likelihood < 0.6 else "valid")
    rows.append([numeric_frame, timestamp, "animal_1", "body_center", center_x, center_y, center_likelihood, status])

    for canonical_name, bodypart in selected.items():
        if bodypart is None:
            rows.append([numeric_frame, timestamp, "animal_1", canonical_name, None, None, 0.0, "missing"])
            continue
        x = available[(bodypart, "x")].iloc[frame_position]
        y = available[(bodypart, "y")].iloc[frame_position]
        likelihood_series = available.get((bodypart, "likelihood"))
        likelihood = likelihood_series.iloc[frame_position] if likelihood_series is not None else 1.0
        likelihood = float(likelihood) if pd.notna(likelihood) else 0.0
        valid_point = pd.notna(x) and pd.notna(y)
        status = "missing" if not valid_point or likelihood < 0.1 else ("low_confidence" if likelihood < 0.6 else "valid")
        rows.append([numeric_frame, timestamp, "animal_1", canonical_name, float(x) if valid_point else None, float(y) if valid_point else None, likelihood, status])

canonical = pd.DataFrame(rows, columns=["frame_index", "timestamp_sec", "animal_id", "keypoint", "x_px", "y_px", "likelihood", "status"])
canonical.to_csv(canonical_path, index=False)
print(f"BEHAVETRACKER_RESULT={{canonical_path}}|rows={{len(canonical)}}|fps={{fps:.6f}}")
"#,
        remote_video = remote_video,
        remote_output = remote_output,
        canonical_csv = canonical_csv,
    )
}

fn download_result(
    connection: &ConnectionInfo,
    remote_path: &str,
    local_path: &Path,
) -> CommandResult<()> {
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| "Não foi possível iniciar o download do resultado.".to_string())?;
    let mut response = client
        .get(jupyter_url(connection, &format!("files/{remote_path}")))
        .header("X-Colab-Runtime-Proxy-Token", &connection.token)
        .send()
        .map_err(|_| "Falha de rede ao baixar o CSV do Colab.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "O Jupyter recusou o download do resultado (HTTP {}).",
            response.status().as_u16()
        ));
    }
    let mut output = File::create(local_path)
        .map_err(|_| "Não foi possível criar o CSV local de resultado.".to_string())?;
    std::io::copy(&mut response, &mut output)
        .map_err(|_| "Falha ao salvar o CSV retornado pelo Colab.".to_string())?;
    if output
        .metadata()
        .map_err(|_| "Não foi possível validar o CSV retornado.".to_string())?
        .len()
        == 0
    {
        return Err("O Colab retornou um CSV vazio.".into());
    }
    Ok(())
}

fn run_analysis(app: AppHandle, job_id: String, upload_id: String) -> CommandResult<()> {
    prepare_tables(&app)?;
    let (local_path, original_filename, size, sha256, ready): (
        String,
        String,
        i64,
        Option<String>,
        i64,
    ) = open_database(&app)?
        .query_row(
            "SELECT local_path, original_filename, expected_size, sha256, ready
                   FROM video_staging WHERE upload_id = ?1",
            params![&upload_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|_| "Upload temporário não encontrado.".to_string())?;
    if ready == 0 || sha256.is_none() {
        return Err("Finalize o envio local do vídeo antes de iniciar a análise.".into());
    }

    update_job(
        &app,
        &job_id,
        "running",
        "authorizing",
        5,
        "Renovando autorização Google",
    )?;
    let access_token = google_access_token(&app, PROFILE_ID)?;
    update_job(
        &app,
        &job_id,
        "running",
        "runtime",
        10,
        "Localizando um runtime GPU elegível",
    )?;
    let runtime = choose_or_create_runtime(&access_token)?;
    if runtime.name.is_empty() {
        return Err("O Colab retornou um runtime sem identificador.".into());
    }
    let connection = runtime
        .connection_info
        .clone()
        .ok_or_else(|| "O runtime Colab não retornou dados de conexão Jupyter.".to_string())?;
    if connection.url.is_empty() || connection.token.is_empty() {
        return Err("Os dados de conexão do runtime Colab estão incompletos.".into());
    }
    open_database(&app)?
        .execute(
            "UPDATE colab_jobs SET runtime_name = ?2 WHERE job_id = ?1",
            params![&job_id, &runtime.name],
        )
        .map_err(|_| "Não foi possível registrar o runtime do job.".to_string())?;

    let short_job = job_id.split('-').next().unwrap_or("job");
    let remote_directory = format!("behavetracker/{short_job}");
    let remote_video = format!(
        "{remote_directory}/input{}",
        safe_extension(&original_filename)
    );
    let remote_output = format!("/content/{remote_directory}/output");
    let remote_csv = format!("/content/{remote_directory}/canonical_pose.csv");
    upload_video(
        &app,
        &job_id,
        &connection,
        Path::new(&local_path),
        &remote_directory,
        &remote_video,
        size,
    )?;

    let session = format!("{}/sessions/behavetracker-{short_job}", runtime.name);
    open_database(&app)?
        .execute(
            "UPDATE colab_jobs SET session_name = ?2 WHERE job_id = ?1",
            params![&job_id, &session],
        )
        .map_err(|_| "Não foi possível registrar a sessão do job.".to_string())?;
    let session_result = (|| -> CommandResult<()> {
        update_job(
            &app,
            &job_id,
            "running",
            "verifying",
            47,
            "Validando o vídeo dentro do runtime",
        )?;
        let verification = format!(
            "import hashlib, os\np={:?}\nassert os.path.getsize(p)=={}\nh=hashlib.sha256()\nwith open(p,'rb') as f:\n    for b in iter(lambda:f.read(1048576), b''): h.update(b)\nassert h.hexdigest()=={:?}\nprint('BEHAVETRACKER_VIDEO_OK')",
            format!("/content/{remote_video}"),
            size,
            sha256.unwrap_or_default()
        );
        execute_code(&access_token, &session, &verification)?;

        update_job(
            &app,
            &job_id,
            "running",
            "installing",
            52,
            "Preparando o DeepLabCut no Colab",
        )?;
        let install_code = r#"import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "--pre", "deeplabcut"], check=True)
print("BEHAVETRACKER_SETUP_OK")"#;
        execute_code(&access_token, &session, install_code)?;

        update_job(
            &app,
            &job_id,
            "running",
            "inference",
            65,
            "Executando SuperAnimal TopViewMouse",
        )?;
        execute_code(
            &access_token,
            &session,
            &inference_code(
                &format!("/content/{remote_video}"),
                &remote_output,
                &remote_csv,
            ),
        )?;
        Ok(())
    })();
    if let Err(error) = session_result {
        best_effort_delete_session(&access_token, &session);
        return Err(error);
    }

    update_job(
        &app,
        &job_id,
        "running",
        "downloading",
        93,
        "Baixando o CSV canônico",
    )?;
    let result_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Não foi possível localizar os dados do aplicativo.".to_string())?
        .join("results");
    fs::create_dir_all(&result_directory)
        .map_err(|_| "Não foi possível preparar a pasta de resultados.".to_string())?;
    let result_path = result_directory.join(format!("{job_id}.csv"));
    let refreshed_runtime = get_runtime(&api_client()?, &access_token, &runtime.name)?;
    let refreshed_connection = refreshed_runtime
        .connection_info
        .ok_or_else(|| "O runtime não renovou os dados de conexão para o download.".to_string())?;
    download_result(
        &refreshed_connection,
        &format!("{remote_directory}/canonical_pose.csv"),
        &result_path,
    )?;
    best_effort_delete_session(&access_token, &session);
    open_database(&app)?
        .execute(
            "UPDATE colab_jobs SET result_path = ?2 WHERE job_id = ?1",
            params![&job_id, result_path.to_string_lossy().as_ref()],
        )
        .map_err(|_| "Não foi possível registrar o resultado do job.".to_string())?;
    update_job(
        &app,
        &job_id,
        "succeeded",
        "completed",
        100,
        "Rastreamento concluído",
    )?;
    let _ = fs::remove_file(local_path);
    Ok(())
}

#[tauri::command]
pub fn start_colab_analysis(
    app: AppHandle,
    request: StartAnalysisRequest,
) -> CommandResult<ColabJob> {
    validate_local_id(&request.experiment_id, "Experimento")?;
    validate_local_id(&request.upload_id, "Upload")?;
    prepare_tables(&app)?;
    let connection = open_database(&app)?;
    let staging_experiment: Option<String> = connection
        .query_row(
            "SELECT experiment_id FROM video_staging WHERE upload_id = ?1 AND ready = 1",
            params![&request.upload_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Não foi possível validar o upload local.".to_string())?;
    if staging_experiment.as_deref() != Some(request.experiment_id.as_str()) {
        return Err("O vídeo preparado não pertence a este experimento.".into());
    }
    if let Some(active) = connection
        .query_row(
            "SELECT job_id, experiment_id, status, stage, progress, message,
                    runtime_name, error, created_at, updated_at
               FROM colab_jobs
              WHERE experiment_id = ?1 AND status IN ('queued', 'running')
              ORDER BY created_at DESC LIMIT 1",
            params![&request.experiment_id],
            row_to_job,
        )
        .optional()
        .map_err(|_| "Não foi possível verificar jobs ativos.".to_string())?
    {
        return Ok(active);
    }
    let job_id = new_uuid_v4();
    connection
        .execute(
            "INSERT INTO colab_jobs
             (job_id, profile_id, experiment_id, upload_id, status, stage, progress, message)
             VALUES (?1, ?2, ?3, ?4, 'queued', 'queued', 0, 'Job criado')",
            params![
                &job_id,
                PROFILE_ID,
                &request.experiment_id,
                &request.upload_id
            ],
        )
        .map_err(|_| "Não foi possível criar o job Colab.".to_string())?;
    let job = get_job(&app, &job_id)?;
    let task_app = app.clone();
    let task_job_id = job_id.clone();
    let task_upload_id = request.upload_id;
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = run_analysis(task_app.clone(), task_job_id.clone(), task_upload_id) {
            let _ = open_database(&task_app).and_then(|connection| {
                connection
                    .execute(
                        "UPDATE colab_jobs
                            SET status = 'failed', stage = 'failed', error = ?2,
                                message = 'A análise falhou',
                                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                          WHERE job_id = ?1",
                        params![&task_job_id, &error],
                    )
                    .map(|_| ())
                    .map_err(|_| "Não foi possível registrar a falha do job.".to_string())
            });
        }
    });
    Ok(job)
}

#[tauri::command]
pub fn get_colab_job_result(app: AppHandle, job_id: String) -> CommandResult<String> {
    validate_local_id(&job_id, "Job")?;
    prepare_tables(&app)?;
    let (status, result_path): (String, Option<String>) = open_database(&app)?
        .query_row(
            "SELECT status, result_path FROM colab_jobs WHERE job_id = ?1",
            params![&job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Job Colab não encontrado.".to_string())?;
    if status != "succeeded" {
        return Err("O resultado ainda não está disponível.".into());
    }
    fs::read_to_string(
        result_path.ok_or_else(|| "O job não possui um CSV de resultado.".to_string())?,
    )
    .map_err(|_| "Não foi possível ler o CSV de resultado.".to_string())
}

#[tauri::command]
pub fn get_latest_colab_job(
    app: AppHandle,
    experiment_id: String,
) -> CommandResult<Option<ColabJob>> {
    validate_local_id(&experiment_id, "Experimento")?;
    prepare_tables(&app)?;
    open_database(&app)?
        .query_row(
            "SELECT job_id, experiment_id, status, stage, progress, message,
                    runtime_name, error, created_at, updated_at
               FROM colab_jobs
              WHERE experiment_id = ?1
              ORDER BY created_at DESC LIMIT 1",
            params![experiment_id],
            row_to_job,
        )
        .optional()
        .map_err(|_| "Não foi possível consultar o último job do experimento.".to_string())
}

#[tauri::command]
pub fn list_colab_jobs(app: AppHandle, experiment_id: String) -> CommandResult<Vec<ColabJob>> {
    validate_local_id(&experiment_id, "Experimento")?;
    prepare_tables(&app)?;
    let connection = open_database(&app)?;
    let mut statement = connection
        .prepare(
            "SELECT job_id, experiment_id, status, stage, progress, message,
                    runtime_name, error, created_at, updated_at
               FROM colab_jobs
              WHERE experiment_id = ?1
              ORDER BY created_at DESC",
        )
        .map_err(|_| "Não foi possível consultar o histórico de análises.".to_string())?;
    let jobs = statement
        .query_map(params![experiment_id], row_to_job)
        .map_err(|_| "Não foi possível ler o histórico de análises.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Não foi possível montar o histórico de análises.".to_string())?;
    Ok(jobs)
}

pub fn recover_interrupted_jobs(app: &AppHandle) -> CommandResult<()> {
    prepare_tables(app)?;
    open_database(app)?
        .execute(
            "UPDATE colab_jobs
                SET status = 'failed', stage = 'failed',
                    message = 'O aplicativo foi encerrado durante a análise',
                    error = 'Job interrompido pelo encerramento do aplicativo. Inicie a análise novamente.',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE status IN ('queued', 'running')",
            [],
        )
        .map_err(|_| "Não foi possível recuperar os jobs interrompidos.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{new_uuid_v4, parse_mcp_payload, safe_extension};

    #[test]
    fn generates_a_uuid_v4_request_id() {
        let value = new_uuid_v4();
        assert_eq!(value.len(), 36);
        assert_eq!(value.as_bytes()[14], b'4');
        assert!(matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }

    #[test]
    fn sanitizes_video_extensions() {
        assert_eq!(safe_extension("arena.MP4"), ".mp4");
        assert_eq!(safe_extension("arena.bad/ext"), ".mp4");
    }

    #[test]
    fn parses_a_final_sse_message() {
        let payload = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
        assert!(parse_mcp_payload(payload).unwrap().get("result").is_some());
    }
}
