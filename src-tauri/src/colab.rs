use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore;
use reqwest::blocking::{Client, Response};
use rusqlite::{params, Connection, OptionalExtension};
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
const MAX_EXECUTION_ATTEMPTS: usize = 5;

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
    events: Vec<ColabJobEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColabJobEvent {
    id: i64,
    stage: String,
    status: String,
    progress: i64,
    message: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAnalysisRequest {
    experiment_id: String,
    upload_id: String,
    #[serde(default)]
    workload: AnalysisWorkload,
    #[serde(default)]
    arena: Option<AnalysisArena>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImagePoint {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisArena {
    revision: u32,
    video_width: u32,
    video_height: u32,
    corners_px: [ImagePoint; 4],
    #[serde(default)]
    rim_corners_px: Option<[ImagePoint; 4]>,
}

impl AnalysisArena {
    fn validate(&self, workload: &AnalysisWorkload) -> CommandResult<()> {
        if self.video_width == 0
            || self.video_height == 0
            || self.video_width != workload.width
            || self.video_height != workload.height
        {
            return Err("A geometria precisa corresponder à resolução do vídeo.".into());
        }
        for points in std::iter::once(&self.corners_px).chain(self.rim_corners_px.iter()) {
            if points.iter().any(|p| {
                !p.x.is_finite()
                    || !p.y.is_finite()
                    || p.x < 0.0
                    || p.y < 0.0
                    || p.x > self.video_width as f64
                    || p.y > self.video_height as f64
            }) {
                return Err("Os vértices da borda e do chão devem estar dentro do vídeo.".into());
            }
            let turns = (0..4)
                .map(|i| {
                    let (a, b, c) = (&points[i], &points[(i + 1) % 4], &points[(i + 2) % 4]);
                    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
                })
                .collect::<Vec<_>>();
            let area = (0..4)
                .map(|i| points[i].x * points[(i + 1) % 4].y - points[(i + 1) % 4].x * points[i].y)
                .sum::<f64>()
                .abs()
                / 2.0;
            if area < 100.0 || !(turns.iter().all(|v| *v > 0.0) || turns.iter().all(|v| *v < 0.0)) {
                return Err(
                    "A borda e o chão devem ser quadriláteros convexos, sem cruzamentos.".into(),
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisWorkload {
    width: u32,
    height: u32,
    duration_sec: f64,
}

impl AnalysisWorkload {
    fn validate(&self) -> CommandResult<()> {
        if self.width > 16384
            || self.height > 16384
            || !self.duration_sec.is_finite()
            || self.duration_sec < 0.0
            || self.duration_sec > 172800.0
        {
            return Err("Metadados do vídeo inválidos para selecionar a GPU.".into());
        }
        Ok(())
    }

    fn demanding(&self) -> bool {
        u64::from(self.width) * u64::from(self.height) >= 3840 * 2160 || self.duration_sec >= 1800.0
    }

    fn description(&self) -> &'static str {
        if self.demanding() {
            "vídeo 4K ou longo: preferência por L4/A100"
        } else {
            "inferência de um animal: preferência por T4/L4"
        }
    }
}

fn accelerator_rank(accelerator: &str, workload: &AnalysisWorkload) -> u8 {
    let accelerator = accelerator.to_ascii_uppercase();
    let order = if workload.demanding() {
        ["L4", "A100", "H100", "T4"]
    } else {
        ["T4", "L4", "A100", "H100"]
    };
    order
        .iter()
        .position(|name| accelerator.contains(name))
        .map(|index| index as u8)
        .unwrap_or(10)
}

fn runtime_rank(spec: &RuntimeSpecKey, workload: &AnalysisWorkload) -> (u8, u8) {
    (
        accelerator_rank(&spec.accelerator, workload),
        if spec.shape == "SHAPE_STANDARD" { 0 } else { 1 },
    )
}

fn preferred_runtime(runtimes: Vec<Runtime>, workload: &AnalysisWorkload) -> Option<Runtime> {
    runtimes
        .into_iter()
        .filter(|runtime| runtime.runtime_spec.variant == "VARIANT_GPU")
        .min_by_key(|runtime| {
            (
                runtime_rank(&runtime.runtime_spec, workload),
                runtime.name.clone(),
            )
        })
}

fn preferred_spec(specs: Vec<RuntimeSpec>, workload: &AnalysisWorkload) -> Option<RuntimeSpec> {
    specs
        .into_iter()
        .filter(|spec| spec.eligible && spec.key.variant == "VARIANT_GPU")
        .min_by_key(|spec| runtime_rank(&spec.key, workload))
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
               ON colab_jobs(experiment_id, created_at);
             CREATE TABLE IF NOT EXISTS colab_job_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               job_id TEXT NOT NULL REFERENCES colab_jobs(job_id),
               stage TEXT NOT NULL,
               status TEXT NOT NULL,
               progress INTEGER NOT NULL,
               message TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );
             CREATE INDEX IF NOT EXISTS idx_colab_events_job ON colab_job_events(job_id, id);
             CREATE TABLE IF NOT EXISTS colab_job_geometry (
               job_id TEXT PRIMARY KEY REFERENCES colab_jobs(job_id),
               geometry_json TEXT NOT NULL
             );",
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
        events: Vec::new(),
    })
}

fn get_job(app: &AppHandle, job_id: &str) -> CommandResult<ColabJob> {
    let connection = open_database(app)?;
    let mut job = connection
        .query_row(
            "SELECT job_id, experiment_id, status, stage, progress, message,
                    runtime_name, error, created_at, updated_at
               FROM colab_jobs WHERE job_id = ?1",
            params![job_id],
            row_to_job,
        )
        .map_err(|_| "Job Colab não encontrado.".to_string())?;
    job.events = job_events(&connection, job_id)?;
    Ok(job)
}

fn job_events(connection: &Connection, job_id: &str) -> CommandResult<Vec<ColabJobEvent>> {
    let mut statement = connection
        .prepare(
            "SELECT id, stage, status, progress, message, created_at
           FROM colab_job_events WHERE job_id = ?1 ORDER BY id",
        )
        .map_err(|_| "Não foi possível consultar as etapas da análise.".to_string())?;
    let events = statement
        .query_map(params![job_id], |row| {
            Ok(ColabJobEvent {
                id: row.get(0)?,
                stage: row.get(1)?,
                status: row.get(2)?,
                progress: row.get(3)?,
                message: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|_| "Não foi possível ler as etapas da análise.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Não foi possível carregar as etapas da análise.".to_string())?;
    Ok(events)
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
    let mut connection = open_database(app)?;
    record_job_update(&mut connection, job_id, status, stage, progress, message)
}

fn record_job_update(
    connection: &mut Connection,
    job_id: &str,
    status: &str,
    stage: &str,
    progress: i64,
    message: &str,
) -> CommandResult<()> {
    let transaction = connection
        .transaction()
        .map_err(|_| "Não foi possível iniciar o registro da etapa.".to_string())?;
    transaction
        .execute(
            "UPDATE colab_jobs
                SET status = ?2, stage = ?3, progress = ?4, message = ?5,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE job_id = ?1",
            params![job_id, status, stage, progress.clamp(0, 100), message],
        )
        .map_err(|_| "Não foi possível atualizar o job Colab.".to_string())?;
    transaction
        .execute(
            "INSERT INTO colab_job_events(job_id, status, stage, progress, message)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (
           SELECT 1 FROM colab_job_events WHERE id = (
             SELECT MAX(id) FROM colab_job_events WHERE job_id = ?1
           ) AND status = ?2 AND stage = ?3 AND message = ?5
         )",
            params![job_id, status, stage, progress.clamp(0, 100), message],
        )
        .map_err(|_| "Não foi possível registrar a etapa da análise.".to_string())?;
    transaction
        .commit()
        .map_err(|_| "Não foi possível salvar a etapa da análise.".to_string())?;
    Ok(())
}

fn fail_job(app: &AppHandle, job_id: &str, error: &str) -> CommandResult<()> {
    let job = get_job(app, job_id)?;
    open_database(app)?
        .execute(
            "UPDATE colab_jobs SET error = ?2 WHERE job_id = ?1",
            params![job_id, error],
        )
        .map_err(|_| "Não foi possível registrar o erro da análise.".to_string())?;
    update_job(app, job_id, "failed", &job.stage, job.progress, error)
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

fn choose_or_create_runtime(
    access_token: &str,
    workload: &AnalysisWorkload,
) -> CommandResult<(Runtime, String)> {
    let client = api_client()?;
    let response = client
        .get(format!("{COLAB_API}/v1beta/runtimes"))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Falha de rede ao listar runtimes Colab.".to_string())?;
    let value = response_json(response, "Não foi possível listar os runtimes Colab")?;
    let runtimes: RuntimesResponse = serde_json::from_value(value)
        .map_err(|_| "A lista de runtimes Colab é inválida.".to_string())?;
    if let Some(runtime) = preferred_runtime(runtimes.runtimes, workload) {
        let selected = get_runtime(&client, access_token, &runtime.name)?;
        return Ok((
            selected,
            format!(
                "Reutilizando GPU já alocada ({}) · {}. Nenhum runtime adicional foi criado.",
                runtime.runtime_spec.accelerator,
                workload.description()
            ),
        ));
    }

    let response = client
        .get(format!("{COLAB_API}/v1beta/runtimespecs"))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Falha de rede ao consultar runtimes elegíveis.".to_string())?;
    let value = response_json(response, "Não foi possível consultar os runtimes elegíveis")?;
    let specs: RuntimeSpecsResponse = serde_json::from_value(value)
        .map_err(|_| "A lista de runtimes elegíveis é inválida.".to_string())?;
    let spec = preferred_spec(specs.runtime_specs, workload)
        .ok_or_else(|| {
            "A conta não possui um runtime GPU elegível agora. Verifique a disponibilidade no Colab e tente novamente."
                .to_string()
        })?;
    let selection_message = format!(
        "Runtime criado com {} · {} · selecionado entre as opções elegíveis da conta",
        spec.key.accelerator,
        workload.description()
    );
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
            return Ok((
                get_runtime(&client, access_token, &name)?,
                selection_message,
            ));
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

fn workspace_candidates(absolute_directory: &str) -> Vec<String> {
    let parts: Vec<_> = absolute_directory.trim_matches('/').split('/').collect();
    (0..parts.len())
        .map(|index| parts[index..].join("/"))
        .collect()
}

fn resolve_jupyter_workspace(
    connection: &ConnectionInfo,
    absolute_directory: &str,
    marker: &str,
) -> CommandResult<String> {
    let client = api_client()?;
    for candidate in workspace_candidates(absolute_directory) {
        let response = client
            .get(jupyter_url(
                connection,
                &format!("api/contents/{candidate}/workspace.txt?content=1&format=text"),
            ))
            .header("X-Colab-Runtime-Proxy-Token", &connection.token)
            .send()
            .map_err(|_| "Falha ao confirmar a pasta compartilhada com o Colab.".to_string())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        let model = response_json(response, "Não foi possível confirmar a pasta do vídeo")?;
        if model.get("content").and_then(Value::as_str).map(str::trim) == Some(marker) {
            return Ok(candidate);
        }
    }
    Err("A API de upload e a sessão Python não enxergam a mesma pasta. O vídeo não foi enviado. Tente novamente com outro runtime Colab.".into())
}

fn prepare_workspace_code(absolute_directory: &str, marker: &str) -> String {
    format!(
        r#"import json, subprocess
from pathlib import Path
workspace = Path({absolute_directory:?})
workspace.mkdir(parents=True, exist_ok=True)
(workspace / "workspace.txt").write_text({marker:?}, encoding="utf-8")
gpu = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, check=True).stdout.strip()
if not gpu:
    raise RuntimeError("O runtime não reportou uma GPU disponível")
print("BEHAVETRACKER_WORKSPACE=" + json.dumps({{"gpu": gpu}}))
"#
    )
}

fn workspace_gpu(payload: &Value) -> CommandResult<String> {
    payload
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or("")
        .lines()
        .filter_map(|line| line.strip_prefix("BEHAVETRACKER_WORKSPACE="))
        .filter_map(|value| serde_json::from_str::<Value>(value).ok())
        .find_map(|value| {
            value
                .get("gpu")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .map(|name| name.chars().take(200).collect())
        })
        .ok_or_else(|| "A sessão Colab não confirmou a GPU alocada.".to_string())
}

fn upload_video(
    app: &AppHandle,
    job_id: &str,
    connection: &ConnectionInfo,
    local_path: &Path,
    remote_file: &str,
    size: i64,
) -> CommandResult<()> {
    let client = api_client()?;
    let mut file = File::open(local_path)
        .map_err(|_| "O vídeo temporário não está mais disponível.".to_string())?;
    let mut buffer = vec![0_u8; REMOTE_CHUNK_SIZE];
    let mut sent = 0_i64;
    let mut chunk_number = 1_i64;
    let chunked = size > REMOTE_CHUNK_SIZE as i64;
    let mut last_percent = -1;
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
        let percent = ((sent * 100) / size).min(100);
        if percent == last_percent {
            continue;
        }
        last_percent = percent;
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

#[derive(Debug)]
struct McpFailure {
    message: String,
    retryable: bool,
}

impl McpFailure {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
    fn terminal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
}

#[derive(Debug)]
struct AnalysisFailure {
    message: String,
    preserve_session: bool,
}

impl From<String> for AnalysisFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            preserve_session: false,
        }
    }
}

impl From<&str> for AnalysisFailure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

fn read_sse_reply(reader: &mut impl BufRead) -> Result<Value, McpFailure> {
    let mut data = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).map_err(|_| {
            McpFailure::transport(
                "A conexão com o Colab foi interrompida durante a leitura da execução.",
            )
        })?;
        if read == 0 || line.trim().is_empty() {
            if !data.is_empty() {
                let value: Value = serde_json::from_str(data.trim()).map_err(|_| {
                    McpFailure::transport("O Colab enviou uma resposta incompleta da execução.")
                })?;
                data.clear();
                if value.get("id").is_some()
                    && (value.get("result").is_some() || value.get("error").is_some())
                {
                    return Ok(value);
                }
            }
            if read == 0 {
                return Err(McpFailure::transport(
                    "A conexão do Colab terminou antes de confirmar o resultado.",
                ));
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push_str(value.trim_start());
            data.push('\n');
        }
    }
}

fn transient_mcp_message(message: &str) -> bool {
    let message = message.to_ascii_uppercase();
    message.contains("DEADLINE_EXCEEDED")
        || message.contains("UNAVAILABLE")
        || message.contains("TIMED OUT")
        || message.contains("TIMEOUT")
}

fn unwrap_mcp_result(value: Value) -> Result<Value, McpFailure> {
    if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
        return Err(McpFailure {
            message: format!("O Colab MCP retornou um erro: {message}"),
            retryable: transient_mcp_message(message),
        });
    }
    let result = value
        .get("result")
        .cloned()
        .ok_or_else(|| McpFailure::terminal("O Colab MCP não retornou um resultado."))?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        let message = result
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(McpFailure {
            retryable: transient_mcp_message(&message),
            message: if message.is_empty() {
                "A execução no Colab falhou sem detalhes.".into()
            } else {
                message
            },
        });
    }
    Ok(result)
}

fn mcp_request(
    access_token: &str,
    tool: &str,
    arguments: Value,
    timeout: Duration,
) -> Result<Value, McpFailure> {
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|_| McpFailure::terminal("Não foi possível iniciar o cliente MCP do Colab."))?;
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
        .map_err(|_| McpFailure::transport("Não foi possível manter a conexão com o Colab MCP."))?;
    let status = response.status();
    if !status.is_success() {
        return Err(McpFailure {
            message: format!("O Colab MCP recusou a execução (HTTP {}).", status.as_u16()),
            retryable: matches!(status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504),
        });
    }
    let streaming = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    let value = if streaming {
        read_sse_reply(&mut BufReader::new(response))?
    } else {
        let body = response
            .text()
            .map_err(|_| McpFailure::transport("A resposta MCP do Colab não pôde ser lida."))?;
        parse_mcp_payload(&body).map_err(McpFailure::transport)?
    };
    unwrap_mcp_result(value)
}

fn execute_with_recovery(
    session: &str,
    code: &str,
    mut transport: impl FnMut(Value) -> Result<Value, McpFailure>,
    mut on_retry: impl FnMut(usize, &str) -> CommandResult<()>,
    mut wait: impl FnMut(usize),
) -> Result<Value, AnalysisFailure> {
    let execution_id = new_uuid_v4();
    let arguments = json!({
        "session": session,
        "code": code,
        "executionId": execution_id
    });
    let mut last_error = None;
    for attempt in 1..=MAX_EXECUTION_ATTEMPTS {
        match transport(arguments.clone()) {
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
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(if name == "KeyboardInterrupt" {
                            "A célula de controle foi interrompida no Colab."
                        } else {
                            "A célula executada no Colab falhou."
                        });
                    // Avisos de configuração em stderr não são a causa da exceção.
                    return Err(format!("{name}: {message}").into());
                }
                return structured.ok_or_else(|| {
                    AnalysisFailure::from("O Colab não retornou os detalhes da execução Python.")
                });
            }
            Err(error) if error.retryable => {
                if attempt < MAX_EXECUTION_ATTEMPTS {
                    on_retry(attempt + 1, &error.message).map_err(|message| AnalysisFailure {
                        message,
                        preserve_session: true,
                    })?;
                    wait(attempt);
                }
                last_error = Some(error.message);
            }
            Err(error) => {
                return Err(AnalysisFailure {
                    preserve_session: last_error.is_some(),
                    message: if last_error.is_some() {
                        format!("{} A sessão foi preservada porque o resultado da execução ainda não foi confirmado.", error.message)
                    } else {
                        error.message
                    },
                })
            }
        }
    }
    Err(AnalysisFailure { preserve_session: true, message: format!(
        "{} Não foi possível confirmar o resultado após {} tentativas. A sessão foi preservada e pode continuar processando no Colab.",
        last_error.unwrap_or_else(|| "A conexão com o Colab foi interrompida.".into()), MAX_EXECUTION_ATTEMPTS) })
}

fn execute_job_code(
    app: &AppHandle,
    job_id: &str,
    access_token: &str,
    session: &str,
    code: &str,
) -> Result<Value, AnalysisFailure> {
    let job = get_job(app, job_id)?;
    execute_with_recovery(
        session,
        code,
        |arguments| {
            mcp_request(
                access_token,
                "execute_code",
                arguments,
                Duration::from_secs(620),
            )
        },
        |attempt, reason| {
            update_job(app, job_id, "running", &job.stage, job.progress,
            &format!("{reason} Reconectando à mesma execução · tentativa {attempt}/{MAX_EXECUTION_ATTEMPTS}; o processamento não será reiniciado."))
        },
        |attempt| thread::sleep(Duration::from_secs((1_u64 << (attempt - 1)).min(8))),
    )
}

fn best_effort_delete_session(access_token: &str, session: &str) {
    let _ = mcp_request(
        access_token,
        "delete_session",
        json!({ "name": session }),
        Duration::from_secs(30),
    );
}

fn background_launch_code(directory: &str, task: &str, source: &str) -> String {
    format!(
        "import runpy\nfrom pathlib import Path\nworker = Path({directory:?}) / 'worker.py'\nworker.write_text({worker:?})\napi = runpy.run_path(str(worker))\napi['print_report'](api['launch']({directory:?}, {task:?}, {source:?}))\n",
        worker = include_str!("../python/worker.py")
    )
}

fn background_poll_code(directory: &str, task: &str) -> String {
    format!(
        "import json, runpy\nfrom pathlib import Path\nworker = Path({directory:?}) / 'worker.py'\nif worker.is_file():\n    api = runpy.run_path(str(worker))\n    api['print_report'](api['snapshot']({directory:?}, {task:?}))\nelse:\n    print('BEHAVETRACKER_WORKER=' + json.dumps({{'state': 'missing', 'error': 'O runtime perdeu os arquivos desta execução.'}}))\n"
    )
}

fn background_report(payload: &Value) -> Result<Value, AnalysisFailure> {
    let stdout = payload.get("stdout").and_then(Value::as_str).unwrap_or("");
    if let Some(details) = stdout
        .lines()
        .filter_map(|line| line.strip_prefix("BEHAVETRACKER_WORKER_DETAILS="))
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(Value::is_object)
    {
        return Ok(details);
    }
    let mut report: Value = stdout
        .lines()
        .filter_map(|line| line.strip_prefix("BEHAVETRACKER_WORKER="))
        .find_map(|line| serde_json::from_str(line).ok())
        .filter(Value::is_object)
        .ok_or_else(|| AnalysisFailure {
            message: "O runtime não confirmou o estado do processo. O trabalho pode continuar no Colab; a sessão foi preservada.".into(),
            preserve_session: true,
        })?;
    if payload.get("outputTruncated").and_then(Value::as_bool) == Some(true) {
        report["logTail"] = json!("A saída técnica foi truncada pelo MCP. O estado foi recuperado; o log completo permanece na pasta do job no runtime.");
    }
    Ok(report)
}

fn monitor_background_with(
    launch: &str,
    poll: &str,
    label: &str,
    mut execute: impl FnMut(&str) -> Result<Value, AnalysisFailure>,
    mut record: impl FnMut(&str) -> CommandResult<()>,
    mut persist: impl FnMut(&Value) -> CommandResult<()>,
    mut wait: impl FnMut(),
) -> Result<(), AnalysisFailure> {
    // A célula só inicia ou consulta o processo. Nunca aguarda a inferência/pip terminar.
    let started = Instant::now();
    let mut payload = execute(launch).map_err(|error| AnalysisFailure {
        message: format!("{} Não foi possível confirmar o lançamento; a sessão foi preservada porque o processo pode ter iniciado.", error.message),
        preserve_session: true,
    })?;
    let mut previous = String::new();
    let mut heartbeat = Instant::now();
    loop {
        let report = background_report(&payload)?;
        persist(&report).map_err(|message| AnalysisFailure {
            message,
            preserve_session: true,
        })?;
        match report.get("state").and_then(Value::as_str) {
            Some("succeeded") => return Ok(()),
            Some("failed" | "missing") => {
                return Err(format!(
                    "{}: {} · consulte o log técnico desta execução.",
                    report
                        .get("errorType")
                        .and_then(Value::as_str)
                        .unwrap_or("Processo interrompido"),
                    report
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("O runtime não confirmou o resultado.")
                )
                .into());
            }
            Some("starting" | "running") => {}
            _ => {
                return Err(AnalysisFailure {
                    message: "O Colab retornou um estado desconhecido. A sessão foi preservada."
                        .into(),
                    preserve_session: true,
                })
            }
        }
        let message = if let Some(progress) = report.get("progressText").and_then(Value::as_str) {
            format!("{label} · lote atual: {progress} (não é o progresso total da análise)")
        } else {
            format!("{label} · processo ativo no runtime; aguardando avanço reportado")
        };
        if message != previous || heartbeat.elapsed() >= Duration::from_secs(60) {
            record(&message).map_err(|message| AnalysisFailure {
                message,
                preserve_session: true,
            })?;
            previous = message;
            heartbeat = Instant::now();
        }
        if started.elapsed() >= Duration::from_secs(24 * 60 * 60) {
            return Err(AnalysisFailure { message: "O acompanhamento atingiu 24 horas sem confirmar o resultado. O processo não foi cancelado; verifique o runtime Colab.".into(), preserve_session: true });
        }
        wait();
        payload = execute(poll).map_err(|error| AnalysisFailure {
            message: format!("{} O processo é independente desta conexão e pode continuar no runtime; a sessão foi preservada.", error.message),
            preserve_session: true,
        })?;
    }
}

fn job_log_path(app: &AppHandle, job_id: &str, task: &str) -> CommandResult<PathBuf> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Não foi possível localizar os logs do aplicativo.".to_string())?
        .join("colab-logs");
    fs::create_dir_all(&directory)
        .map_err(|_| "Não foi possível criar a pasta de logs.".to_string())?;
    Ok(directory.join(format!("{job_id}-{task}.json")))
}

fn run_background_task(
    app: &AppHandle,
    job_id: &str,
    session: &str,
    directory: &str,
    task: &str,
    source: &str,
) -> Result<(), AnalysisFailure> {
    let job = get_job(app, job_id)?;
    let mut token = google_access_token(app, PROFILE_ID)?;
    let mut renewed = Instant::now();
    let log_path = job_log_path(app, job_id, task)?;
    monitor_background_with(
        &background_launch_code(directory, task, source),
        &background_poll_code(directory, task),
        if task == "setup" {
            "Preparando DeepLabCut"
        } else {
            "SuperAnimal em execução"
        },
        |code| {
            if renewed.elapsed() >= Duration::from_secs(40 * 60) {
                token = google_access_token(app, PROFILE_ID)?;
                renewed = Instant::now();
            }
            execute_job_code(app, job_id, &token, session, code)
        },
        |message| update_job(app, job_id, "running", &job.stage, job.progress, message),
        |report| {
            let temporary = log_path.with_extension("tmp");
            fs::write(
                &temporary,
                serde_json::to_vec(report).map_err(|_| "Não foi possível serializar o log.")?,
            )
            .and_then(|_| fs::rename(temporary, &log_path))
            .map_err(|_| "Não foi possível salvar o log técnico da execução.".into())
        },
        || thread::sleep(Duration::from_secs(5)),
    )
}

fn environment_probe_code() -> String {
    format!("import subprocess, sys\ncheck = subprocess.run([sys.executable, '-c', {:?}], capture_output=True, text=True, check=True)\nprint(check.stdout)\n",
        include_str!("../python/environment.py"))
}

fn environment_install_code() -> String {
    format!(
        r#"import fcntl, json, subprocess, sys
from pathlib import Path
Path("/content/behavetracker").mkdir(parents=True, exist_ok=True)
with open("/content/behavetracker/environment.lock", "a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    probe = subprocess.run([sys.executable, "-c", {probe:?}], capture_output=True, text=True, check=True)
    reports = [line.split("=", 1)[1] for line in probe.stdout.splitlines() if line.startswith("BEHAVETRACKER_ENVIRONMENT=")]
    if not reports:
        raise RuntimeError("O ambiente não respondeu à validação anterior à instalação")
    report = json.loads(reports[-1])
    if not report.get("ready"):
        if not report.get("installNeeded"):
            raise RuntimeError(report.get("reason", "CUDA incompatível"))
        subprocess.run([sys.executable, "-m", "pip", "install", "--pre", "--upgrade", "--upgrade-strategy", "only-if-needed", "deeplabcut[modelzoo]>=3.0.0rc1,<4"], check=True)
    print("BEHAVETRACKER_SETUP_OK")
"#,
        probe = include_str!("../python/environment.py")
    )
}

fn environment_report(payload: &Value) -> CommandResult<Value> {
    payload
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or("")
        .lines()
        .filter_map(|line| line.strip_prefix("BEHAVETRACKER_ENVIRONMENT="))
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .ok_or_else(|| "O runtime não retornou a validação do DeepLabCut.".into())
}

fn prepare_environment(
    app: &AppHandle,
    job_id: &str,
    session: &str,
    directory: &str,
) -> Result<(), AnalysisFailure> {
    prepare_environment_with(
        |code, background| {
            if background {
                run_background_task(app, job_id, session, directory, "setup", code)?;
                Ok(json!({}))
            } else {
                // A preparação inicial pode renovar o token durante uma instalação longa.
                let current_token = google_access_token(app, PROFILE_ID)?;
                execute_job_code(app, job_id, &current_token, session, code)
            }
        },
        |stage, progress, message| update_job(app, job_id, "running", stage, progress, message),
    )
}

fn prepare_environment_with(
    mut execute: impl FnMut(&str, bool) -> Result<Value, AnalysisFailure>,
    mut record: impl FnMut(&str, i64, &str) -> CommandResult<()>,
) -> Result<(), AnalysisFailure> {
    record(
        "environment_check",
        52,
        "Verificando DeepLabCut, SuperAnimal e CUDA já instalados no runtime",
    )?;
    let payload = execute(&environment_probe_code(), false)?;
    let mut report = environment_report(&payload)?;
    let reused = report.get("ready").and_then(Value::as_bool) == Some(true);
    if !reused {
        if report.get("installNeeded").and_then(Value::as_bool) != Some(true) {
            return Err(report
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("O runtime não tem um ambiente CUDA compatível.")
                .into());
        }
        record(
            "installing",
            54,
            &format!(
                "Preparando as dependências ausentes ou incompatíveis · {}",
                report
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("DeepLabCut indisponível")
            ),
        )?;
        execute(&environment_install_code(), true)?;
        let checked = execute(&environment_probe_code(), false)?;
        report = environment_report(&checked)?;
        if report.get("ready").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "A instalação terminou, mas o ambiente não passou na validação: {}",
                report
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("DeepLabCut/CUDA indisponível")
            )
            .into());
        }
    }
    record(
        "environment_ready",
        60,
        &format!(
            "DeepLabCut {} e CUDA {} prontos · {}",
            report
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("3.x"),
            report
                .get("cuda")
                .and_then(Value::as_str)
                .unwrap_or("verificada"),
            if reused {
                "reutilizando a instalação deste runtime, sem executar pip"
            } else {
                "ambiente preparado e validado neste runtime"
            }
        ),
    )?;
    Ok(())
}

fn inference_code(
    remote_video: &str,
    remote_output: &str,
    canonical_csv: &str,
    arena: Option<&AnalysisArena>,
) -> String {
    let source = format!(
        r#"import glob
import math
import os
import json
import runpy
from pathlib import Path

import cv2
import pandas as pd
from deeplabcut.modelzoo.video_inference import video_inference_superanimal

video_path = {remote_video:?}
output_dir = {remote_output:?}
canonical_path = {canonical_csv:?}
os.makedirs(output_dir, exist_ok=True)
helpers = Path(output_dir) / "arena_helpers.py"
helpers.write_text({arena_helpers:?}, encoding="utf-8")
geometry_api = runpy.run_path(str(helpers))
capture = cv2.VideoCapture(video_path)
fps = float(capture.get(cv2.CAP_PROP_FPS))
video_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
video_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
capture.release()
if not math.isfinite(fps) or fps <= 0:
    raise RuntimeError("O vídeo não informou FPS válido; não é seguro inventar timestamps para a análise")
geometry = geometry_api["prepare_geometry"](json.loads({arena_json:?}), video_width, video_height)
Path(output_dir, "arena_geometry.json").write_text(json.dumps(geometry, ensure_ascii=False, indent=2), encoding="utf-8")
print("BEHAVETRACKER_GEOMETRY=" + json.dumps(geometry), flush=True)

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
    cropping=geometry["cropping"],
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
def point_at(bodypart, position):
    if bodypart is None:
        return (None, None, 0.0, "missing")
    likelihood_series = available.get((bodypart, "likelihood"))
    likelihood = likelihood_series.iloc[position] if likelihood_series is not None else None
    return geometry_api["restore_point"](available[(bodypart, "x")].iloc[position],
        available[(bodypart, "y")].iloc[position], likelihood, geometry)

rows = []
for frame_position, frame_index in enumerate(poses.index):
    try:
        numeric_frame = int(frame_index)
    except Exception:
        numeric_frame = frame_position
    timestamp = numeric_frame / fps

    torso_points = [point_at(bodypart, frame_position) for bodypart in torso]
    center_x, center_y, center_likelihood, status = geometry_api["torso_center"](torso_points)
    support = sum(point[3] != "missing" for point in torso_points)
    rows.append([numeric_frame, timestamp, "animal_1", "body_center", center_x, center_y, center_likelihood, status,
        geometry_api["spatial_region"](center_x, center_y, geometry), support, len(torso_points)])

    for canonical_name, bodypart in selected.items():
        x, y, likelihood, status = point_at(bodypart, frame_position)
        rows.append([numeric_frame, timestamp, "animal_1", canonical_name, x, y, likelihood, status,
            geometry_api["spatial_region"](x, y, geometry), int(status != "missing"), 1])

canonical = pd.DataFrame(rows, columns=["frame_index", "timestamp_sec", "animal_id", "keypoint", "x_px", "y_px", "likelihood", "status", "spatial_region", "support_count", "support_total"])
canonical.to_csv(canonical_path, index=False)
Path(canonical_path + ".complete").write_text("ok", encoding="utf-8")
print(f"BEHAVETRACKER_RESULT={{canonical_path}}|rows={{len(canonical)}}|fps={{fps:.6f}}")
"#,
        remote_video = remote_video,
        remote_output = remote_output,
        canonical_csv = canonical_csv,
        arena_helpers = include_str!("../python/arena.py"),
        arena_json = serde_json::to_string(&arena).expect("validated arena is serializable"),
    );
    format!("from pathlib import Path\nif Path({canonical_csv:?}).is_file() and Path({:?}).is_file():\n    print('BEHAVETRACKER_RESULT_CACHED')\nelse:\n{}",
        format!("{canonical_csv}.complete"),
        source.lines().map(|line| format!("    {line}\n")).collect::<String>())
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

fn run_analysis(
    app: AppHandle,
    job_id: String,
    upload_id: String,
    workload: AnalysisWorkload,
    arena: Option<AnalysisArena>,
) -> CommandResult<()> {
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
    let (runtime, selection_message) = choose_or_create_runtime(&access_token, &workload)?;
    update_job(&app, &job_id, "running", "runtime", 12, &selection_message)?;
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
    let absolute_directory = format!("/content/behavetracker/{job_id}");
    let absolute_video = format!(
        "{absolute_directory}/input{}",
        safe_extension(&original_filename)
    );
    let remote_output = format!("{absolute_directory}/output");
    let remote_csv = format!("{absolute_directory}/canonical_pose.csv");
    let session = format!("{}/sessions/behavetracker-{short_job}", runtime.name);
    open_database(&app)?
        .execute(
            "UPDATE colab_jobs SET session_name = ?2 WHERE job_id = ?1",
            params![&job_id, &session],
        )
        .map_err(|_| "Não foi possível registrar a sessão do job.".to_string())?;
    let session_result = (|| -> Result<(), AnalysisFailure> {
        update_job(
            &app,
            &job_id,
            "running",
            "workspace",
            15,
            "Abrindo a sessão e identificando a GPU do Colab",
        )?;
        let workspace = execute_job_code(
            &app,
            &job_id,
            &access_token,
            &session,
            &prepare_workspace_code(&absolute_directory, &job_id),
        )?;
        let gpu = workspace_gpu(&workspace)?;
        update_job(
            &app,
            &job_id,
            "running",
            "gpu_ready",
            18,
            &format!("{gpu} encontrada · sessão pronta"),
        )?;
        update_job(
            &app,
            &job_id,
            "running",
            "uploading",
            19,
            "Confirmando a pasta do vídeo entre a API de upload e a sessão Python",
        )?;
        let remote_directory =
            resolve_jupyter_workspace(&connection, &absolute_directory, &job_id)?;
        update_job(
            &app,
            &job_id,
            "running",
            "uploading",
            20,
            "Pasta compartilhada confirmada · enviando o vídeo ao Colab",
        )?;
        let remote_video = format!(
            "{remote_directory}/input{}",
            safe_extension(&original_filename)
        );
        upload_video(
            &app,
            &job_id,
            &connection,
            Path::new(&local_path),
            &remote_video,
            size,
        )?;
        update_job(
            &app,
            &job_id,
            "running",
            "verifying",
            47,
            "Validando o vídeo dentro do runtime",
        )?;
        let verification = format!(
            "import hashlib\nfrom pathlib import Path\np=Path({:?})\nif not p.is_file():\n    raise RuntimeError('O runtime perdeu o vídeo após o envio. A sessão pode ter reiniciado. Inicie a análise novamente.')\nif p.stat().st_size != {}:\n    raise RuntimeError('O vídeo recebido está incompleto ou foi alterado: tamanho diferente do original.')\nh=hashlib.sha256()\nwith p.open('rb') as f:\n    for b in iter(lambda:f.read(1048576), b''): h.update(b)\nif h.hexdigest() != {:?}:\n    raise RuntimeError('O vídeo recebido não corresponde ao original: SHA-256 diferente.')\nprint('BEHAVETRACKER_VIDEO_OK')",
            absolute_video,
            size,
            sha256.unwrap_or_default()
        );
        let verified = execute_job_code(&app, &job_id, &access_token, &session, &verification)?;
        if !verified
            .get("stdout")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("BEHAVETRACKER_VIDEO_OK")
        {
            return Err("O Colab não confirmou a integridade do vídeo enviado.".into());
        }
        update_job(
            &app,
            &job_id,
            "running",
            "video_ready",
            50,
            "Vídeo recebido e validado · tamanho e SHA-256 conferem",
        )?;

        prepare_environment(&app, &job_id, &session, &absolute_directory)?;

        update_job(
            &app,
            &job_id,
            "running",
            "inference",
            65,
            if arena
                .as_ref()
                .is_some_and(|geometry| geometry.rim_corners_px.is_some())
            {
                "Executando SuperAnimal com borda + chão e margem de 5%; paredes preservadas no recorte. Geometria 2D não classifica rearing."
            } else {
                "Executando SuperAnimal no vídeo inteiro · projeto sem borda calibrada; não será aplicado recorte só no chão"
            },
        )?;
        run_background_task(
            &app,
            &job_id,
            &session,
            &absolute_directory,
            "inference",
            &inference_code(&absolute_video, &remote_output, &remote_csv, arena.as_ref()),
        )?;
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
        let download_token = google_access_token(&app, PROFILE_ID)?;
        let refreshed_runtime = get_runtime(&api_client()?, &download_token, &runtime.name)?;
        let refreshed_connection = refreshed_runtime.connection_info.ok_or_else(|| {
            "O runtime não renovou os dados de conexão para o download.".to_string()
        })?;
        download_result(
            &refreshed_connection,
            &format!("{remote_directory}/canonical_pose.csv"),
            &result_path,
        )?;
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
        Ok(())
    })();
    if !session_result
        .as_ref()
        .err()
        .is_some_and(|error| error.preserve_session)
    {
        if let Ok(current_token) = google_access_token(&app, PROFILE_ID) {
            best_effort_delete_session(&current_token, &session);
        }
    }
    session_result.map_err(|error| error.message)?;
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
    request.workload.validate()?;
    if let Some(arena) = &request.arena {
        arena.validate(&request.workload)?;
    }
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
        return get_job(&app, &active.job_id);
    }
    let job_id = new_uuid_v4();
    let transaction = connection
        .unchecked_transaction()
        .map_err(|_| "Não foi possível iniciar o registro do job.".to_string())?;
    transaction
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
    transaction
        .execute(
            "INSERT INTO colab_job_geometry(job_id, geometry_json) VALUES (?1, ?2)",
            params![
                &job_id,
                serde_json::to_string(&json!({"poseAdapterVersion":"superanimal-canonical-2", "arena": &request.arena}))
                    .map_err(|_| "Não foi possível serializar a geometria.")?
            ],
        )
        .map_err(|_| "Não foi possível registrar a borda e o chão deste job.".to_string())?;
    transaction
        .commit()
        .map_err(|_| "Não foi possível concluir o registro do job.".to_string())?;
    update_job(
        &app,
        &job_id,
        "queued",
        "queued",
        0,
        "Vídeo preparado no desktop · aguardando runtime Colab",
    )?;
    let job = get_job(&app, &job_id)?;
    let task_app = app.clone();
    let task_job_id = job_id.clone();
    let task_upload_id = request.upload_id;
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = run_analysis(
            task_app.clone(),
            task_job_id.clone(),
            task_upload_id,
            request.workload,
            request.arena,
        ) {
            let _ = fail_job(&task_app, &task_job_id, &error);
        }
    });
    Ok(job)
}

#[tauri::command]
pub fn get_colab_job_log(app: AppHandle, job_id: String) -> CommandResult<String> {
    validate_local_id(&job_id, "Job")?;
    get_job(&app, &job_id)?;
    let mut sections = Vec::new();
    for task in ["setup", "inference"] {
        let path = job_log_path(&app, &job_id, task)?;
        if !path.is_file() {
            continue;
        }
        let body = fs::read_to_string(path)
            .map_err(|_| "Não foi possível ler o log técnico.".to_string())?;
        let report: Value = serde_json::from_str(&body)
            .map_err(|_| "O log técnico salvo é inválido.".to_string())?;
        sections.push(format!(
            "=== {task} · {} ===\n{}\n{}",
            report
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("desconhecido"),
            report.get("logTail").and_then(Value::as_str).unwrap_or(""),
            report
                .get("traceback")
                .and_then(Value::as_str)
                .unwrap_or("")
        ));
    }
    Ok(if sections.is_empty() {
        "Esta execução não possui log técnico salvo. Os logs ficam disponíveis nas próximas análises.".into()
    } else {
        format!(
            "Último estado consultado e até 16 KiB finais de saída por tarefa.\n{}",
            sections.join("\n\n")
        )
    })
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
    let latest: Option<String> = open_database(&app)?
        .query_row(
            "SELECT job_id
               FROM colab_jobs
              WHERE experiment_id = ?1
              ORDER BY created_at DESC LIMIT 1",
            params![experiment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Não foi possível consultar o último job do experimento.".to_string())?;
    latest.map(|id| get_job(&app, &id)).transpose()
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
    let mut jobs = statement
        .query_map(params![experiment_id], row_to_job)
        .map_err(|_| "Não foi possível ler o histórico de análises.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Não foi possível montar o histórico de análises.".to_string())?;
    for job in &mut jobs {
        job.events = job_events(&connection, &job.job_id)?;
    }
    Ok(jobs)
}

pub fn recover_interrupted_jobs(app: &AppHandle) -> CommandResult<()> {
    prepare_tables(app)?;
    let connection = open_database(app)?;
    let mut statement = connection
        .prepare("SELECT job_id FROM colab_jobs WHERE status IN ('queued', 'running')")
        .map_err(|_| "Não foi possível consultar jobs interrompidos.".to_string())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "Não foi possível ler jobs interrompidos.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Não foi possível carregar jobs interrompidos.".to_string())?;
    for id in ids {
        fail_job(
            app,
            &id,
            "O aplicativo fechou antes de confirmar o resultado. Um processo independente pode continuar no runtime Colab; verifique-o antes de iniciar outra análise.",
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        background_launch_code, background_poll_code, background_report, execute_with_recovery,
        inference_code, job_events, monitor_background_with, new_uuid_v4, parse_mcp_payload,
        preferred_runtime, preferred_spec, prepare_environment_with, read_sse_reply,
        record_job_update, resolve_jupyter_workspace, safe_extension, workspace_gpu, AnalysisArena,
        AnalysisFailure, AnalysisWorkload, ConnectionInfo, McpFailure, Runtime, RuntimeSpec,
        RuntimeSpecKey, MAX_EXECUTION_ATTEMPTS,
    };
    use rusqlite::Connection;
    use serde_json::json;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn generates_a_uuid_v4_request_id() {
        let value = new_uuid_v4();
        assert_eq!(value.len(), 36);
        assert_eq!(value.as_bytes()[14], b'4');
        assert!(matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }

    fn calibrated_arena() -> AnalysisArena {
        serde_json::from_value(json!({"revision":2,"videoWidth":1000,"videoHeight":1000,
            "cornersPx":[{"x":200,"y":300},{"x":700,"y":300},{"x":700,"y":800},{"x":200,"y":800}],
            "rimCornersPx":[{"x":150,"y":100},{"x":750,"y":100},{"x":750,"y":650},{"x":150,"y":650}]})).unwrap()
    }

    #[test]
    fn validates_both_areas_without_requiring_projected_floor_to_be_inside_rim() {
        let mut arena = calibrated_arena();
        let workload = AnalysisWorkload {
            width: 1000,
            height: 1000,
            duration_sec: 100.0,
        };
        arena.validate(&workload).unwrap();
        arena.rim_corners_px = None;
        arena.validate(&workload).unwrap();
        assert!(arena.validate(&AnalysisWorkload::default()).is_err());
    }

    #[test]
    fn rejects_invalid_areas_before_starting_remote_work() {
        let workload = AnalysisWorkload {
            width: 1000,
            height: 1000,
            duration_sec: 100.0,
        };
        let mut arena = calibrated_arena();
        arena.rim_corners_px.as_mut().unwrap()[0].x = -1.0;
        assert!(arena.validate(&workload).is_err());
        let mut arena = calibrated_arena();
        arena.rim_corners_px.as_mut().unwrap().swap(1, 2);
        assert!(arena.validate(&workload).is_err());
    }

    #[test]
    fn generated_inference_uses_both_areas_restores_coordinates_and_preserves_partial_poses() {
        use std::process::{Command, Stdio};
        let directory = std::env::temp_dir().join(format!(
            "behavetracker-inference-contract-{}",
            new_uuid_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source = inference_code(
            "fake-video.mp4",
            directory.join("output").to_str().unwrap(),
            directory.join("canonical.csv").to_str().unwrap(),
            Some(&calibrated_arena()),
        );
        let mut child = Command::new("python3")
            .arg("-B")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/python/check_inference_contract.py"
            ))
            .arg(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(source.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("INFERENCE_CONTRACT_OK"));
        std::fs::remove_dir_all(directory).unwrap();
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

    fn fake_jupyter(
        responses: Vec<(u16, String)>,
    ) -> (ConnectionInfo, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let connection = ConnectionInfo {
            token: "test-proxy-token".into(),
            url: format!("http://{}", listener.local_addr().unwrap()),
        };
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                requests.push(
                    String::from_utf8(request)
                        .unwrap()
                        .lines()
                        .next()
                        .unwrap()
                        .to_owned(),
                );
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (connection, handle)
    }

    #[test]
    fn maps_the_same_kernel_workspace_for_jupyter_root_slash_or_content() {
        let marker = json!({"type": "file", "format": "text", "content": "job-123"}).to_string();
        let (connection, handle) = fake_jupyter(vec![(200, marker.clone())]);
        assert_eq!(
            resolve_jupyter_workspace(&connection, "/content/behavetracker/job-123", "job-123")
                .unwrap(),
            "content/behavetracker/job-123"
        );
        assert!(handle.join().unwrap()[0]
            .contains("/api/contents/content/behavetracker/job-123/workspace.txt"));

        let (connection, handle) = fake_jupyter(vec![(404, "{}".into()), (200, marker)]);
        assert_eq!(
            resolve_jupyter_workspace(&connection, "/content/behavetracker/job-123", "job-123")
                .unwrap(),
            "behavetracker/job-123"
        );
        assert!(
            handle.join().unwrap()[1].contains("/api/contents/behavetracker/job-123/workspace.txt")
        );
    }

    #[test]
    fn refuses_upload_mapping_when_the_kernel_marker_does_not_match() {
        let unrelated = json!({"content": "another-job"}).to_string();
        let (connection, handle) = fake_jupyter(vec![
            (200, unrelated.clone()),
            (200, unrelated.clone()),
            (200, unrelated),
        ]);
        assert!(resolve_jupyter_workspace(
            &connection,
            "/content/behavetracker/job-123",
            "job-123"
        )
        .is_err());
        assert_eq!(handle.join().unwrap().len(), 3);
    }

    #[test]
    fn reports_only_gpu_names_confirmed_by_python() {
        assert_eq!(
            workspace_gpu(&json!({"stdout": "BEHAVETRACKER_WORKSPACE={\"gpu\":\"Tesla T4\"}\n"}))
                .unwrap(),
            "Tesla T4"
        );
        assert!(workspace_gpu(&json!({"stdout": "starting", "accelerator": "T4"})).is_err());
    }

    #[test]
    fn keeps_failed_checkpoint_and_persists_ordered_events_without_duplicates() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE colab_jobs(job_id TEXT PRIMARY KEY, status TEXT, stage TEXT, progress INTEGER, message TEXT, updated_at TEXT);
             CREATE TABLE colab_job_events(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, status TEXT, stage TEXT,
                 progress INTEGER, message TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
             INSERT INTO colab_jobs(job_id) VALUES ('job-1');"
        ).unwrap();
        record_job_update(
            &mut connection,
            "job-1",
            "running",
            "uploading",
            45,
            "Vídeo enviado",
        )
        .unwrap();
        record_job_update(
            &mut connection,
            "job-1",
            "running",
            "uploading",
            45,
            "Vídeo enviado",
        )
        .unwrap();
        record_job_update(
            &mut connection,
            "job-1",
            "failed",
            "verifying",
            47,
            "Vídeo ausente",
        )
        .unwrap();
        let events = job_events(&connection, "job-1").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].stage, "verifying");
        assert_eq!(events[1].status, "failed");
        let stage: String = connection
            .query_row("SELECT stage FROM colab_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stage, "verifying");
    }

    fn gpu_spec(accelerator: &str, eligible: bool) -> RuntimeSpec {
        RuntimeSpec {
            eligible,
            key: RuntimeSpecKey {
                variant: "VARIANT_GPU".into(),
                accelerator: accelerator.into(),
                shape: "SHAPE_STANDARD".into(),
            },
        }
    }

    #[test]
    fn selects_gpu_by_workload_instead_of_api_order_and_excludes_ineligible_specs() {
        let small = AnalysisWorkload {
            width: 1920,
            height: 1080,
            duration_sec: 120.0,
        };
        let specs = || {
            vec![
                gpu_spec("NVIDIA_A100", true),
                gpu_spec("NVIDIA_L4", true),
                gpu_spec("NVIDIA_T4", true),
            ]
        };
        assert_eq!(
            preferred_spec(specs(), &small).unwrap().key.accelerator,
            "NVIDIA_T4"
        );
        let large = AnalysisWorkload {
            width: 3840,
            height: 2160,
            duration_sec: 120.0,
        };
        assert_eq!(
            preferred_spec(specs(), &large).unwrap().key.accelerator,
            "NVIDIA_L4"
        );
        assert_eq!(
            preferred_spec(
                vec![gpu_spec("NVIDIA_T4", false), gpu_spec("NVIDIA_A100", true)],
                &small
            )
            .unwrap()
            .key
            .accelerator,
            "NVIDIA_A100"
        );
        let existing = vec![
            Runtime {
                name: "runtimes/a100".into(),
                runtime_spec: gpu_spec("NVIDIA_A100", true).key,
                connection_info: None,
            },
            Runtime {
                name: "runtimes/t4".into(),
                runtime_spec: gpu_spec("NVIDIA_T4", true).key,
                connection_info: None,
            },
        ];
        assert_eq!(
            preferred_runtime(existing, &small).unwrap().name,
            "runtimes/t4"
        );
    }

    #[test]
    fn gpu_selection_handles_empty_unknown_and_high_memory_options() {
        let small = AnalysisWorkload::default();
        assert!(preferred_spec(Vec::new(), &small).is_none());
        assert!(preferred_spec(vec![gpu_spec("NVIDIA_T4", false)], &small).is_none());
        let mut high_mem = gpu_spec("NVIDIA_T4", true);
        high_mem.key.shape = "SHAPE_HIGHMEM".into();
        assert_eq!(
            preferred_spec(vec![high_mem, gpu_spec("NVIDIA_T4", true)], &small)
                .unwrap()
                .key
                .shape,
            "SHAPE_STANDARD"
        );
        assert!(AnalysisWorkload {
            width: 20000,
            height: 1,
            duration_sec: 1.0
        }
        .validate()
        .is_err());
        assert!(AnalysisWorkload {
            width: 1,
            height: 1,
            duration_sec: f64::NAN
        }
        .validate()
        .is_err());
    }

    struct InterruptedRead {
        body: std::io::Cursor<Vec<u8>>,
    }
    impl Read for InterruptedRead {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.body.position() == self.body.get_ref().len() as u64 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "connection dropped",
                ));
            }
            self.body.read(buffer)
        }
    }

    #[test]
    fn sse_returns_the_terminal_result_before_waiting_for_connection_close() {
        let body = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\ndata: {\n data: \"id\": 1,\n data: \"result\": {}\n data: }\n\n";
        let body = String::from_utf8_lossy(body).replace("\n data:", "\ndata:");
        let mut reader = std::io::BufReader::new(InterruptedRead {
            body: std::io::Cursor::new(body.into_bytes()),
        });
        assert_eq!(read_sse_reply(&mut reader).unwrap()["id"], 1);
    }

    #[test]
    fn interrupted_sse_is_recoverable_instead_of_a_terminal_python_failure() {
        let mut reader = std::io::BufReader::new(InterruptedRead {
            body: std::io::Cursor::new(
                b"data: {\"method\":\"notifications/progress\"}\n\n".to_vec(),
            ),
        });
        assert!(read_sse_reply(&mut reader).unwrap_err().retryable);
    }

    #[test]
    fn reconnection_reuses_exactly_the_same_execution_id_session_and_code() {
        let mut requests = Vec::new();
        let mut attempts = Vec::new();
        let result = execute_with_recovery(
            "runtimes/gpu/sessions/job",
            "print('done')",
            |arguments| {
                requests.push(arguments);
                if requests.len() == 1 {
                    Err(McpFailure::transport("connection interrupted"))
                } else {
                    Ok(json!({"structuredContent": {"stdout": "done", "executionError": null}}))
                }
            },
            |attempt, _| {
                attempts.push(attempt);
                Ok(())
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(result["stdout"], "done");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
        assert_eq!(attempts, vec![2]);
        assert!(requests[0]["executionId"].as_str().unwrap().len() == 36);
    }

    #[test]
    fn unknown_execution_outcome_preserves_the_session_after_exhausting_retries() {
        let mut calls = 0;
        let error = execute_with_recovery(
            "session",
            "code",
            |_| {
                calls += 1;
                Err(McpFailure::transport("response interrupted"))
            },
            |_, _| Ok(()),
            |_| {},
        )
        .unwrap_err();
        assert_eq!(calls, MAX_EXECUTION_ATTEMPTS);
        assert!(error.preserve_session);
        assert!(error.message.contains("sessão foi preservada"));
    }

    #[test]
    fn actual_python_errors_are_not_retried_as_network_errors() {
        let mut calls = 0;
        let error = execute_with_recovery("session", "code", |_| {
            calls += 1;
            Ok(json!({"structuredContent":{"executionError":{"name":"RuntimeError","value":"CUDA out of memory"}}}))
        }, |_, _| panic!("Python error must not be retried"), |_| {}).unwrap_err();
        assert_eq!(calls, 1);
        assert!(!error.preserve_session);
        assert!(error.message.contains("CUDA out of memory"));
    }

    #[test]
    fn python_configuration_warnings_are_not_presented_as_the_exception_cause() {
        let error = execute_with_recovery("session", "code", |_| {
            Ok(json!({"structuredContent": {"executionError": {"name": "KeyboardInterrupt"},
                "stderr": "WARNING: project_config: Found invalid empty/null/None value for Task"}}))
        }, |_, _| Ok(()), |_| {}).unwrap_err();
        assert!(error.message.starts_with("KeyboardInterrupt:"));
        assert!(!error.message.contains("WARNING"));
    }

    fn worker_payload(state: &str, progress: &str) -> serde_json::Value {
        json!({"stdout": format!("BEHAVETRACKER_WORKER={}\n", json!({"state": state,
            "progressText": progress, "errorType":"KeyboardInterrupt", "error":"Interrompido no runtime"}))})
    }

    #[test]
    fn monitoring_launches_once_and_waits_for_terminal_state_not_detector_percentage() {
        let mut codes = Vec::new();
        let mut messages = Vec::new();
        let mut reports = Vec::new();
        monitor_background_with(
            "launch",
            "poll",
            "SuperAnimal",
            |code| {
                codes.push(code.to_owned());
                Ok(match codes.len() {
                    1 => worker_payload("running", "7356/7356 (100%)"),
                    2 => worker_payload("running", "3633/7356 (49%)"),
                    _ => worker_payload("succeeded", "7356/7356 (100%)"),
                })
            },
            |message| {
                messages.push(message.to_owned());
                Ok(())
            },
            |report| {
                reports.push(report.clone());
                Ok(())
            },
            || {},
        )
        .unwrap();
        assert_eq!(codes, ["launch", "poll", "poll"]);
        assert_eq!(messages.len(), 2);
        assert!(messages[0].contains("não é o progresso total"));
        assert!(messages[1].contains("49%"));
        assert_eq!(reports.len(), 3);
    }

    #[test]
    fn terminal_worker_errors_are_not_relaunched() {
        let mut calls = 0;
        let error = monitor_background_with(
            "launch",
            "poll",
            "SuperAnimal",
            |_| {
                calls += 1;
                Ok(worker_payload("failed", "49%"))
            },
            |_| Ok(()),
            |_| Ok(()),
            || {},
        )
        .unwrap_err();
        assert_eq!(calls, 1);
        assert!(!error.preserve_session);
        assert!(error
            .message
            .contains("KeyboardInterrupt: Interrompido no runtime"));
    }

    #[test]
    fn losing_a_status_reply_preserves_the_independent_process_session() {
        let mut calls = 0;
        let error = monitor_background_with(
            "launch",
            "poll",
            "SuperAnimal",
            |_| {
                calls += 1;
                if calls == 1 {
                    Ok(worker_payload("running", "49%"))
                } else {
                    Err(AnalysisFailure::from("HTTP 403"))
                }
            },
            |_| Ok(()),
            |_| Ok(()),
            || {},
        )
        .unwrap_err();
        assert!(error.preserve_session);
        assert!(error.message.contains("pode continuar"));
        assert_eq!(calls, 2);
    }

    #[test]
    fn unconfirmed_launch_or_invalid_status_never_deletes_the_session() {
        let error = monitor_background_with(
            "launch",
            "poll",
            "SuperAnimal",
            |_| Err(AnalysisFailure::from("KeyboardInterrupt")),
            |_| Ok(()),
            |_| Ok(()),
            || {},
        )
        .unwrap_err();
        assert!(error.preserve_session);
        assert!(
            background_report(&json!({"stdout": "incomplete"}))
                .unwrap_err()
                .preserve_session
        );
    }

    #[test]
    fn truncated_diagnostics_do_not_discard_the_compact_worker_state() {
        let report = background_report(&json!({"stdout":
            "BEHAVETRACKER_WORKER={\"state\":\"running\"}\nBEHAVETRACKER_WORKER_DETAILS={\"logTail\":\"cut off",
            "outputTruncated": true})).unwrap();
        assert_eq!(report["state"], "running");
        assert!(report["logTail"].as_str().unwrap().contains("truncada"));
        assert!(
            background_report(
                &json!({"stdout": "BEHAVETRACKER_WORKER=true", "outputTruncated":true})
            )
            .unwrap_err()
            .preserve_session
        );
    }

    #[test]
    fn generated_launch_and_poll_protocol_runs_a_local_fake_task_without_ml_packages() {
        use std::process::Command;
        let directory =
            std::env::temp_dir().join(format!("behavetracker-protocol-{}", new_uuid_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let launch = background_launch_code(
            directory.to_str().unwrap(),
            "inference",
            "print('fake result')",
        );
        let poll = background_poll_code(directory.to_str().unwrap(), "inference");
        let mut report = json!({});
        for index in 0..50 {
            let result = Command::new("python3")
                .args(["-B", "-c", if index == 0 { &launch } else { &poll }])
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            report = background_report(&json!({"stdout": String::from_utf8_lossy(&result.stdout)}))
                .unwrap();
            if report["state"] == "succeeded" {
                break;
            }
            assert!(
                matches!(report["state"].as_str(), Some("starting" | "running")),
                "{report}"
            );
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(report["state"], "succeeded");
        assert!(report["logTail"].as_str().unwrap().contains("fake result"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn environment_payload(ready: bool) -> serde_json::Value {
        json!({"stdout": format!("BEHAVETRACKER_ENVIRONMENT={}\n", json!({"ready":ready,
            "installNeeded": !ready, "version":"3.0.0", "cuda":"12.1", "reason":"package missing"}))})
    }

    #[test]
    fn ready_environment_is_reused_without_invoking_pip() {
        let mut codes = Vec::new();
        let mut messages = Vec::new();
        prepare_environment_with(
            |code, background| {
                assert!(!background, "Ambiente válido não deve iniciar instalação");
                codes.push(code.to_owned());
                Ok(environment_payload(true))
            },
            |_, _, message| {
                messages.push(message.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(codes.len(), 1);
        assert!(!codes.iter().any(|code| code.contains("\"pip\"")));
        assert!(messages.last().unwrap().contains("sem executar pip"));
    }

    #[test]
    fn missing_environment_is_installed_once_then_validated() {
        let mut codes = Vec::new();
        prepare_environment_with(
            |code, background| {
                codes.push(code.to_owned());
                assert_eq!(
                    background,
                    codes.len() == 2,
                    "Somente pip roda em segundo plano"
                );
                Ok(if codes.len() == 1 {
                    environment_payload(false)
                } else {
                    environment_payload(true)
                })
            },
            |_, _, _| Ok(()),
        )
        .unwrap();
        assert_eq!(codes.len(), 3);
        assert_eq!(
            codes.iter().filter(|code| code.contains("\"pip\"")).count(),
            1
        );
        assert!(codes[1].contains("deeplabcut[modelzoo]>=3.0.0rc1,<4"));
    }

    #[test]
    fn confirmed_results_are_not_processed_again_when_a_reply_is_replayed() {
        let directory =
            std::env::temp_dir().join(format!("behavetracker-cached-test-{}", new_uuid_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let csv = directory.join("pose.csv");
        std::fs::write(&csv, b"frame_index,x_px,y_px\n0,1,1\n").unwrap();
        std::fs::write(directory.join("pose.csv.complete"), b"ok").unwrap();
        let output = std::process::Command::new("python3")
            .arg("-B")
            .arg("-c")
            .arg(inference_code(
                "video-not-needed.mp4",
                directory.to_str().unwrap(),
                csv.to_str().unwrap(),
                None,
            ))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("BEHAVETRACKER_RESULT_CACHED"));
        std::fs::remove_file(&csv).unwrap();
        std::fs::remove_file(directory.join("pose.csv.complete")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn generated_environment_and_inference_scripts_are_valid_python() {
        use std::process::{Command, Stdio};
        for source in [
            super::environment_probe_code(),
            super::environment_install_code(),
            background_launch_code("/content/behavetracker/job", "inference", "print('ready')"),
            background_poll_code("/content/behavetracker/job", "inference"),
            inference_code(
                "/content/video.mp4",
                "/content/output",
                "/content/poses.csv",
                None,
            ),
        ] {
            let mut child = Command::new("python3")
                .arg("-B")
                .arg("-c")
                .arg("import ast, sys; ast.parse(sys.stdin.read())")
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(source.as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn cuda_failure_does_not_trigger_a_package_reinstall_loop() {
        let mut calls = 0;
        let error = prepare_environment_with(|_, _| {
            calls += 1;
            Ok(json!({"stdout": "BEHAVETRACKER_ENVIRONMENT={\"ready\":false,\"installNeeded\":false,\"reason\":\"CUDA indisponível\"}\n"}))
        }, |_, _, _| Ok(())).unwrap_err();
        assert_eq!(calls, 1);
        assert!(error.message.contains("CUDA indisponível"));
    }

    #[test]
    fn permanent_permission_errors_are_not_retried() {
        let mut calls = 0;
        let error = execute_with_recovery(
            "session",
            "code",
            |_| {
                calls += 1;
                Err(McpFailure::terminal("HTTP 403"))
            },
            |_, _| panic!("Permission errors must not be retried"),
            |_| {},
        )
        .unwrap_err();
        assert_eq!(calls, 1);
        assert!(!error.preserve_session);
    }
}
