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
const FAST_REMOTE_CHUNK_SIZE: usize = 4 * 1024 * 1024;
const MAX_VIDEO_SIZE: i64 = 20 * 1024 * 1024 * 1024;
const MAX_EXECUTION_ATTEMPTS: usize = 5;
const BACKGROUND_POLL_INTERVAL_SECS: u64 = 12;
const MCP_RETRY_BASE_SECS: u64 = 10;
const MCP_RETRY_MAX_SECS: u64 = 60;
const WISTAR_V2_RELEASE: &str = "https://github.com/CodesOfGabriel/behaviortracker/releases/download/models-wistar-df-v2-r1";
const HYBRID_COMMON_FILES: [(&str, u64, &str); 2] = [
    ("snapshot-hrnet_w32-001.pt", 118196193, "d81c8f18ba0729263168b96eab3e09b6bc3d0ee194b131fb381d2526266ff215"),
    ("pytorch_config.yaml", 5996, "847076c1253f53816155fe247ca1448a13039498d902c2d75b24dac9d800f907"),
];

fn hybrid_bundle_files(bundle_id: &str) -> CommandResult<[(&'static str, u64, &'static str); 3]> {
    let detector = match bundle_id {
        "wistar_df_v1" => ("best_detector.pth", 173406835, "efc08b431067384e46acee488a4d9173d3cf9c1b5c9158dc0606e7371a51dbc2"),
        "wistar_df_v2" => ("best_detector.pth", 173392347, "211891e0ec5f5b3f56d0f0be5b9255319ce9857284e72e558ccfc9f4ca93eef0"),
        _ => return Err("Modelo de análise não reconhecido.".into()),
    };
    Ok([detector, HYBRID_COMMON_FILES[0], HYBRID_COMMON_FILES[1]])
}

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
    diagnostic: Option<DiagnosticRange>,
    results_ready: bool,
    training: bool,
    custom_model: bool,
    engine_id: Option<String>,
    model_bundle_id: Option<String>,
    protocol: Option<String>,
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
    #[serde(default = "default_engine_id")]
    engine_id: String,
    #[serde(default)]
    model_bundle_id: Option<String>,
    #[serde(default)]
    workload: AnalysisWorkload,
    #[serde(default)]
    arena: Option<AnalysisArena>,
    #[serde(default)]
    fst: Option<FstConfiguration>,
    #[serde(default)]
    diagnostic: Option<DiagnosticRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FstSubject { animal_id: String, subject_id: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FstRoi { x: f64, y: f64, width: f64, height: f64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FstTank { tank_id: String, animal_id: String, subject_id: String, roi_px: FstRoi, revision: u32 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FstConfiguration {
    #[serde(default)] title: Option<String>,
    #[serde(default)] group: Option<String>,
    #[serde(default)] notes: Option<String>,
    subjects: Vec<FstSubject>, tanks: Vec<FstTank>,
}

impl FstConfiguration {
    fn validate(&self, workload: &AnalysisWorkload) -> CommandResult<()> {
        if self.subjects.is_empty() || self.subjects.len() > 2 || self.subjects.len() != self.tanks.len() {
            return Err("O FST requer um ou dois sujeitos e um cilindro por sujeito.".into());
        }
        for (index, (subject, tank)) in self.subjects.iter().zip(&self.tanks).enumerate() {
            let roi = &tank.roi_px;
            if subject.animal_id != format!("animal_{}", index + 1)
                || tank.animal_id != subject.animal_id || tank.subject_id != subject.subject_id
                || subject.subject_id.trim().is_empty() || tank.tank_id.trim().is_empty() || tank.revision < 1
                || ![roi.x, roi.y, roi.width, roi.height].iter().all(|v| v.is_finite() && v.fract() == 0.0)
                || roi.x < 0.0 || roi.y < 0.0 || roi.width < 80.0 || roi.height < 80.0
                || roi.x + roi.width > f64::from(workload.width) || roi.y + roi.height > f64::from(workload.height)
                || roi.height < f64::from(workload.height) * 0.55 {
                return Err("Sujeito ou região fixa do cilindro inválidos para este vídeo.".into());
            }
        }
        if self.subjects.len() == 2 {
            if self.subjects[0].subject_id == self.subjects[1].subject_id
                || self.tanks[0].tank_id == self.tanks[1].tank_id { return Err("Identificadores FST duplicados.".into()); }
            let a = &self.tanks[0].roi_px; let b = &self.tanks[1].roi_px;
            let overlap_x = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
            let overlap_y = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
            if overlap_x > 0.0 && overlap_y > 0.0 { return Err("Os cilindros FST não podem se sobrepor.".into()); }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRange { start_sec: f64, end_sec: f64 }

impl DiagnosticRange {
    fn validate(&self, duration: f64) -> CommandResult<()> {
        if !self.start_sec.is_finite() || !self.end_sec.is_finite() || self.start_sec < 0.0
            || self.end_sec <= self.start_sec || self.end_sec - self.start_sec > 60.0 || self.end_sec > duration + 0.001 {
            return Err("Selecione um trecho válido de até 60 segundos dentro do vídeo.".into());
        }
        Ok(())
    }
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
    #[serde(default)]
    occlusion_polygons_px: Vec<Vec<ImagePoint>>,
    #[serde(default)]
    calibration_version: Option<String>,
    #[serde(default)]
    reference_frame_sec: Option<f64>,
}

fn default_engine_id() -> String {
    "superanimal_video_adapt_b_legacy".to_string()
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
        for polygon in &self.occlusion_polygons_px {
            if polygon.len() < 3 || polygon.iter().any(|p| {
                !p.x.is_finite() || !p.y.is_finite() || p.x < 0.0 || p.y < 0.0
                    || p.x > self.video_width as f64 || p.y > self.video_height as f64
            }) {
                return Err("Os polígonos de oclusão devem ter ao menos três vértices dentro do vídeo.".into());
            }
        }
        if self.reference_frame_sec.is_some_and(|value| !value.is_finite() || value < 0.0) {
            return Err("O frame de referência da calibração é inválido.".into());
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
            "vídeo 4K ou longo: melhor GPU disponível"
        } else {
            "inferência de um animal: melhor GPU disponível"
        }
    }
}

fn accelerator_rank(accelerator: &str, _workload: &AnalysisWorkload) -> u8 {
    let accelerator = accelerator.to_ascii_uppercase();
    let order = ["H100", "A100", "L4", "T4"];
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

fn supports_adaptation_gpu(spec: &RuntimeSpecKey) -> bool {
    spec.variant == "VARIANT_GPU"
        && ["A100", "H100"].iter().any(|name| spec.accelerator.to_ascii_uppercase().contains(name))
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

fn ranked_eligible_specs(specs: Vec<RuntimeSpec>, workload: &AnalysisWorkload) -> Vec<RuntimeSpec> {
    let mut specs: Vec<_> = specs
        .into_iter()
        .filter(|spec| spec.eligible && spec.key.variant == "VARIANT_GPU")
        .collect();
    specs.sort_by_key(|spec| {
        (
            runtime_rank(&spec.key, workload),
            spec.key.accelerator.clone(),
            spec.key.shape.clone(),
        )
    });
    specs
}

#[cfg(test)]
fn preferred_spec(specs: Vec<RuntimeSpec>, workload: &AnalysisWorkload) -> Option<RuntimeSpec> {
    ranked_eligible_specs(specs, workload).into_iter().next()
}

fn runtime_attempt_specs(specs: Vec<RuntimeSpec>, workload: &AnalysisWorkload) -> Vec<RuntimeSpec> {
    let mut seen_accelerators = std::collections::HashSet::new();
    ranked_eligible_specs(specs, workload)
        .into_iter()
        .filter(|spec| seen_accelerators.insert(spec.key.accelerator.to_ascii_uppercase()))
        .take(2)
        .collect()
}

fn is_assignment_capacity_error(error: &Value) -> bool {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let exhausted = error.get("code").and_then(Value::as_i64) == Some(8)
        || message.contains("resource_exhausted");
    exhausted && !message.contains("quota")
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

pub(crate) fn new_uuid_v4() -> String {
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

pub(crate) fn validate_local_id(value: &str, label: &str) -> CommandResult<()> {
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

pub(crate) fn prepare_tables(app: &AppHandle) -> CommandResult<()> {
    open_database(app).map(|_| ())
}

pub(crate) fn staging_directory(app: &AppHandle) -> CommandResult<PathBuf> {
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
    append_video_staging_bytes(&app, &upload_id, offset, &bytes)
}

#[tauri::command]
pub fn append_video_staging_raw(app: AppHandle, request: tauri::ipc::Request<'_>) -> CommandResult<VideoStaging> {
    let upload_id = request.headers().get("x-upload-id")
        .and_then(|value| value.to_str().ok())
        .ok_or("ID do upload ausente")?;
    let offset = request.headers().get("x-offset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or("Offset do vídeo inválido")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Bloco binário do vídeo ausente".into());
    };
    append_video_staging_bytes(&app, upload_id, offset, bytes)
}

fn append_video_staging_bytes(app: &AppHandle, upload_id: &str, offset: i64, bytes: &[u8]) -> CommandResult<VideoStaging> {
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
        upload_id: upload_id.to_string(),
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

#[tauri::command]
pub fn get_video_staging_sha256(app: AppHandle, upload_id: String) -> CommandResult<String> {
    validate_local_id(&upload_id, "Upload")?;
    prepare_tables(&app)?;
    open_database(&app)?.query_row("SELECT sha256 FROM video_staging WHERE upload_id=?1 AND ready=1", [&upload_id], |row| row.get(0))
        .map_err(|_| "SHA-256 do vídeo preparado indisponível.".into())
}

#[tauri::command]
pub fn get_staged_video_path(app: AppHandle, experiment_id: String, upload_id: String) -> CommandResult<String> {
    validate_local_id(&experiment_id, "Experimento")?;
    validate_local_id(&upload_id, "Upload")?;
    prepare_tables(&app)?;
    let path: String = open_database(&app)?.query_row(
        "SELECT local_path FROM video_staging WHERE upload_id=COALESCE((SELECT original_upload_id FROM video_preparations WHERE prepared_upload_id=?1),?1) AND experiment_id=?2 AND ready=1",
        params![&upload_id,&experiment_id],|row|row.get(0))
        .map_err(|_| "Vídeo deste experimento não está mais no cache local.".to_string())?;
    let canonical = Path::new(&path).canonicalize().map_err(|_| "Vídeo local indisponível.")?;
    let root = staging_directory(&app)?.canonicalize().map_err(|_| "Cache de vídeo indisponível.")?;
    if !canonical.starts_with(root) { return Err("Caminho do vídeo fora do cache do aplicativo.".into()); }
    Ok(canonical.to_string_lossy().into_owned())
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
        diagnostic: None,
        results_ready: false,
        training: false,
        custom_model: false,
        engine_id: None,
        model_bundle_id: None,
        protocol: None,
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
    enrich_job(&connection, &mut job)?;
    Ok(job)
}

fn enrich_job(connection: &Connection, job: &mut ColabJob) -> CommandResult<()> {
    job.training=connection.query_row("SELECT EXISTS(SELECT 1 FROM training_runs WHERE job_id=?1)",[&job.job_id],|r|r.get(0)).map_err(|_|"Não foi possível consultar o tipo de job")?;
    job.custom_model=connection.query_row("SELECT EXISTS(SELECT 1 FROM custom_analysis_models WHERE job_id=?1)",[&job.job_id],|r|r.get(0)).map_err(|_|"Não foi possível consultar o modelo")?;
    let range: Option<String> = connection.query_row("SELECT range_json FROM colab_job_diagnostics WHERE job_id=?1", [&job.job_id], |row| row.get(0))
        .optional().map_err(|_| "Não foi possível consultar o tipo da execução")?;
    job.diagnostic = range.map(|text| serde_json::from_str(&text).map_err(|_| "Trecho diagnóstico inválido")).transpose()?;
    job.results_ready = connection.query_row("SELECT result_path IS NOT NULL FROM colab_jobs WHERE job_id=?1", [&job.job_id], |row| row.get(0)).map_err(|_| "Não foi possível consultar as poses")?;
    let geometry: Option<String> = connection.query_row("SELECT geometry_json FROM colab_job_geometry WHERE job_id=?1", [&job.job_id], |row| row.get(0))
        .optional().map_err(|_| "Não foi possível consultar o bundle da execução")?;
    if let Some(geometry) = geometry {
        let value: Value = serde_json::from_str(&geometry).map_err(|_| "Geometria da execução inválida")?;
        job.engine_id = value["engineId"].as_str().map(str::to_owned);
        job.model_bundle_id = value["modelBundleId"].as_str().map(str::to_owned);
        job.protocol = value["protocol"].as_str().map(str::to_owned);
    }
    Ok(())
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

fn record_timing(app: &AppHandle, job_id: &str, phase: &str, started: Instant) {
    if let Ok(connection) = open_database(app) {
        let message = format!("Tempo {phase}: {:.1} s", started.elapsed().as_secs_f64());
        let _ = connection.execute(
            "INSERT INTO colab_job_events(job_id,stage,status,progress,message)
             SELECT job_id,'timing',status,progress,?2 FROM colab_jobs WHERE job_id=?1",
            params![job_id, message],
        );
    }
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

fn find_allocated_runtime(
    client: &Client,
    access_token: &str,
    workload: &AnalysisWorkload,
    adaptation: bool,
) -> CommandResult<Option<Runtime>> {
    let response = client
        .get(format!("{COLAB_API}/v1beta/runtimes"))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Falha de rede ao listar runtimes Colab.".to_string())?;
    let value = response_json(response, "Não foi possível listar os runtimes Colab")?;
    let runtimes: RuntimesResponse = serde_json::from_value(value)
        .map_err(|_| "A lista de runtimes Colab é inválida.".to_string())?;
    let allocated = runtimes.runtimes.into_iter().filter(|runtime| {
        !adaptation || supports_adaptation_gpu(&runtime.runtime_spec)
    }).collect();
    preferred_runtime(allocated, workload)
        .map(|runtime| get_runtime(client, access_token, &runtime.name))
        .transpose()
}

fn choose_or_create_runtime(
    access_token: &str,
    workload: &AnalysisWorkload,
    adaptation: bool,
    on_progress: &mut dyn FnMut(&str) -> CommandResult<()>,
) -> CommandResult<(Runtime, String)> {
    let client = api_client()?;
    if let Some(runtime) = find_allocated_runtime(&client, access_token, workload, adaptation)? {
        let accelerator = runtime.runtime_spec.accelerator.clone();
        return Ok((
            runtime,
            format!(
                "Reutilizando GPU já alocada ({}) · {}. Nenhum runtime adicional foi criado.",
                accelerator,
                if adaptation { "A100/H100 para adaptação B" } else { workload.description() }
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
    let eligible = specs.runtime_specs.into_iter().filter(|spec| !adaptation ||
        supports_adaptation_gpu(&spec.key)).collect();
    let options = runtime_attempt_specs(eligible, workload);
    if options.is_empty() {
        return Err({
            if adaptation { "O Teste B precisa de A100 ou H100 (34 GiB de VRAM reservada no teste). Nenhum runtime compatível está disponível nesta conta agora." }
            else { "A conta não possui um runtime GPU elegível agora. Verifique a disponibilidade no Colab e tente novamente." }
                .to_string()
        });
    }
    let mut capacity_failure = String::new();
    for (attempt, spec) in options.iter().enumerate() {
        if attempt > 0 {
            thread::sleep(Duration::from_secs(10));
        }
        on_progress(&format!("Solicitando GPU {} ao Colab (tentativa {}/{})", spec.key.accelerator, attempt + 1, options.len()))?;
        let request_id = new_uuid_v4();
        let runtime_id = format!("behavetracker-{}", request_id.split('-').next().unwrap_or("job"));
        let response = client
            .post(format!("{COLAB_API}/v1beta/runtimes"))
            .query(&[("requestId", request_id.as_str()), ("runtimeId", runtime_id.as_str())])
            .bearer_auth(access_token)
            .json(&json!({ "runtimeSpec": &spec.key }))
            .send()
            .map_err(|_| "Falha de rede ao criar o runtime Colab.".to_string())?;
        let mut operation = response_json(response, "Não foi possível criar o runtime Colab")?;
        let operation_name = operation.get("name").and_then(Value::as_str)
            .ok_or_else(|| "A Colab API não retornou a operação de criação.".to_string())?
            .to_string();

        let mut finished = false;
        for _ in 0..150 {
            if operation.get("done").and_then(Value::as_bool) == Some(true) {
                finished = true;
                if let Some(error) = operation.get("error") {
                    let message = error.get("message").and_then(Value::as_str).unwrap_or("erro sem detalhes");
                    if !is_assignment_capacity_error(error) {
                        return Err(format!("A criação do runtime Colab falhou: {message}"));
                    }
                    capacity_failure = message.to_string();
                    break;
                }
                let name = operation.pointer("/response/name").and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("runtimes/{runtime_id}"));
                return Ok((
                    get_runtime(&client, access_token, &name)?,
                    format!("Runtime criado com {} · {} · selecionado entre as opções elegíveis da conta",
                        spec.key.accelerator,
                        if adaptation { "A100/H100 para adaptação B" } else { workload.description() }),
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
        if !finished {
            return Err("O runtime Colab não ficou pronto em 5 minutos.".into());
        }
        if let Some(runtime) = find_allocated_runtime(&client, access_token, workload, adaptation)? {
            let accelerator = runtime.runtime_spec.accelerator.clone();
            return Ok((runtime, format!("Reutilizando GPU alocada ({accelerator}) após a falha. Nenhuma nova solicitação de runtime foi feita.")));
        }
        if let Some(next) = options.get(attempt + 1) {
            on_progress(&format!("Colab não alocou {}. Aguardando 10 s para tentar {}.", spec.key.accelerator, next.key.accelerator))?;
        }
    }
    let attempted = options.iter().map(|spec| spec.key.accelerator.as_str()).collect::<Vec<_>>().join(", ");
    Err(format!("O Colab não conseguiu alocar GPU ({attempted}) agora. Aguarde e tente novamente; os arquivos do job ainda não foram enviados ao runtime. Detalhe do Colab: {capacity_failure}"))
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
        let chunk = model.get("chunk").and_then(Value::as_i64)
            .map(|value| format!(" bloco {value}"))
            .unwrap_or_default();
        return Err(format!(
            "O Jupyter recusou o upload de {remote_path}{chunk} (HTTP {status}): {}",
            if detail.is_empty() { "resposta vazia do proxy".to_string() }
            else { detail.chars().take(240).collect::<String>() }
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
    match upload_video_chunks(app, job_id, connection, local_path, remote_file, size, FAST_REMOTE_CHUNK_SIZE) {
        Ok(()) => Ok(()),
        Err(error) if ["HTTP 408", "HTTP 413", "HTTP 429", "HTTP 502", "HTTP 503", "HTTP 504", "Falha de rede durante o upload"].iter().any(|code| error.contains(code)) => {
            update_job(app, job_id, "running", "uploading", 20,
                "O proxy não aceitou blocos de 4 MiB · reiniciando o arquivo com blocos de 1 MiB")?;
            upload_video_chunks(app, job_id, connection, local_path, remote_file, size, REMOTE_CHUNK_SIZE)
        }
        Err(error) => Err(error),
    }
}

fn upload_video_chunks(
    app: &AppHandle,
    job_id: &str,
    connection: &ConnectionInfo,
    local_path: &Path,
    remote_file: &str,
    size: i64,
    chunk_size: usize,
) -> CommandResult<()> {
    let client = api_client()?;
    let mut file = File::open(local_path)
        .map_err(|_| "O vídeo temporário não está mais disponível.".to_string())?;
    let mut buffer = vec![0_u8; chunk_size];
    let mut sent = 0_i64;
    let mut chunk_number = 1_i64;
    let chunked = size > chunk_size as i64;
    let display_name = remote_file.rsplit('/').next().unwrap_or("arquivo");
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
                "Enviando {display_name} ao Colab · {}%",
                ((sent * 100) / size).min(100)
            ),
        )?;
    }
    if sent != size {
        return Err("O upload remoto terminou com tamanho incorreto.".into());
    }
    Ok(())
}

fn reuse_cached_video(app: &AppHandle, job: &str, session: &str, video: &str, digest: &str) -> Result<bool, AnalysisFailure> {
    let cache = format!("/content/behavetracker/videos/{digest}");
    let code = format!(
        "import hashlib,os,shutil\nfrom pathlib import Path\nsrc=Path({cache:?});dst=Path({video:?})\nif src.is_file():\n    h=hashlib.sha256()\n    with src.open('rb') as f:\n        for block in iter(lambda:f.read(1048576),b''): h.update(block)\n    if h.hexdigest()=={digest:?}:\n        dst.parent.mkdir(parents=True,exist_ok=True)\n        dst.unlink(missing_ok=True)\n        try: os.link(src,dst)\n        except OSError: shutil.copyfile(src,dst)\n        print('BEHAVETRACKER_VIDEO_CACHED')"
    );
    let result = execute_job_code(app, job, &google_access_token(app, PROFILE_ID)?, session, &code)?;
    Ok(result["stdout"].as_str().unwrap_or("").contains("BEHAVETRACKER_VIDEO_CACHED"))
}

fn cache_verified_video(app: &AppHandle, job: &str, session: &str, video: &str, digest: &str) -> Result<(), AnalysisFailure> {
    let cache = format!("/content/behavetracker/videos/{digest}");
    let code = format!(
        "import os,shutil\nfrom pathlib import Path\nsrc=Path({video:?});dst=Path({cache:?})\ndst.parent.mkdir(parents=True,exist_ok=True)\ndst.unlink(missing_ok=True)\ntry: os.link(src,dst)\nexcept OSError: shutil.copyfile(src,dst)\nprint('BEHAVETRACKER_VIDEO_CACHE_READY')"
    );
    let result = execute_job_code(app, job, &google_access_token(app, PROFILE_ID)?, session, &code)?;
    if !result["stdout"].as_str().unwrap_or("").contains("BEHAVETRACKER_VIDEO_CACHE_READY") {
        return Err("O runtime não confirmou o cache do vídeo.".into());
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
        |attempt| {
            let multiplier = 1_u64 << attempt.saturating_sub(1);
            thread::sleep(Duration::from_secs(
                MCP_RETRY_BASE_SECS
                    .saturating_mul(multiplier)
                    .min(MCP_RETRY_MAX_SECS),
            ));
        },
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
        if task.starts_with("model_") {
            "Baixando e validando pesos do modelo"
        } else if task == "setup" {
            if job.training||job.custom_model {"Preparando ambiente PyTorch"}else{"Preparando DeepLabCut"}
        } else if job.training {
            "Treinando detector e pontos personalizados"
        } else if task == "render" {
            "Gerando vídeo rotulado · poses já disponíveis"
        } else if job.protocol.as_deref() == Some("forced_swim") {
            "FST em execução"
        } else if job.custom_model {
            "Modelo personalizado experimental em execução"
        } else if job.diagnostic.is_some() {
            "Diagnóstico curto do detector e da pose"
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
        |message| {
            let stage = if job.protocol.as_deref() == Some("forced_swim") {
                ["validating_tanks","inference","presence","indicators","rendering"]
                    .iter().find(|stage| message.contains(&format!("FST_STAGE={stage}")))
                    .copied().unwrap_or(&job.stage)
            } else { &job.stage };
            update_job(app, job_id, "running", stage, job.progress, message)
        },
        |report| {
            let temporary = log_path.with_extension("tmp");
            fs::write(
                &temporary,
                serde_json::to_vec(report).map_err(|_| "Não foi possível serializar o log.")?,
            )
            .and_then(|_| fs::rename(temporary, &log_path))
            .map_err(|_| "Não foi possível salvar o log técnico da execução.".into())
        },
        || thread::sleep(Duration::from_secs(if task.starts_with("model_") { 2 } else { BACKGROUND_POLL_INTERVAL_SECS })),
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

fn diagnostic_code(video: &str, output: &str, csv: &str, arena: Option<&AnalysisArena>, range: &DiagnosticRange) -> String {
    format!(r#"import json, runpy
from pathlib import Path
output = Path({output:?})
output.mkdir(parents=True, exist_ok=True)
if not (Path({csv:?} + '.complete').is_file() and (output / 'diagnostic_report.json').is_file()):
    (output / 'arena_helpers.py').write_text({geometry:?}, encoding='utf-8')
    (output / 'diagnostic_helpers.py').write_text({diagnostic:?}, encoding='utf-8')
    runpy.run_path(str(output / 'diagnostic_helpers.py'))['run_diagnostic']({video:?}, str(output), {csv:?}, json.loads({arena:?}), runpy.run_path(str(output / 'arena_helpers.py')), json.loads({selection:?}))
"#, geometry = include_str!("../python/arena.py"), diagnostic = include_str!("../python/diagnostic.py"), arena = serde_json::to_string(&arena).unwrap(), selection = serde_json::to_string(range).unwrap())
}

fn render_code(output: &str) -> String {
    format!(r#"import json, runpy, time
from pathlib import Path
output = Path({output:?})
helper = output / 'labeled_video_helpers.py'
helper.write_text({helper:?}, encoding='utf-8')
request = json.loads((output / 'render_request.json').read_text())
started = time.perf_counter()
runpy.run_path(str(helper))['render_labeled_video'](request['video'], request['h5'], request['fps'], request['geometry'], str(output), request['frames'])
print('BEHAVETRACKER_RENDER_SEC=' + str(time.perf_counter() - started), flush=True)
"#, helper = include_str!("../python/labeled_video.py"))
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
import time
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
recovery_helpers = Path(output_dir) / "recovery_helpers.py"
recovery_helpers.write_text({recovery_helpers:?}, encoding="utf-8")
recovery_api = runpy.run_path(str(recovery_helpers))
postprocess_helpers = Path(output_dir) / "trajectory_postprocess.py"
postprocess_helpers.write_text({postprocess_helpers:?}, encoding="utf-8")
postprocess_api = runpy.run_path(str(postprocess_helpers))
capture = cv2.VideoCapture(video_path)
fps = float(capture.get(cv2.CAP_PROP_FPS))
video_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
video_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
video_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
capture.release()
if not math.isfinite(fps) or fps <= 0:
    raise RuntimeError("O vídeo não informou FPS válido; não é seguro inventar timestamps para a análise")
geometry = geometry_api["prepare_geometry"](json.loads({arena_json:?}), video_width, video_height)
geometry["poseAdapterVersion"] = "superanimal-adapted-quality-1"
geometry["recoveryPolicy"] = recovery_api["POLICY"]
geometry["trajectoryPostprocessPolicy"] = postprocess_api["POLICY"]
Path(output_dir, "arena_geometry.json").write_text(json.dumps(geometry, ensure_ascii=False, indent=2), encoding="utf-8")
print("BEHAVETRACKER_GEOMETRY=" + json.dumps(geometry), flush=True)

inference_started = time.perf_counter()
video_inference_superanimal(
    videos=video_path,
    superanimal_name="superanimal_topviewmouse",
    model_name="hrnet_w32",
    detector_name="fasterrcnn_resnet50_fpn_v2",
    video_adapt=True,
    max_individuals=1,
    dest_folder=output_dir,
    create_labeled_video=False,
    plot_bboxes=True,
    plot_trajectories=False,
    cropping=geometry["cropping"],
    device="cuda:0",
    batch_size=4,
    detector_batch_size=2,
    pcutoff=0.05,
    pseudo_threshold=0.1,
    bbox_threshold=0.9,
    detector_epochs=1,
    pose_epochs=1,
)
inference_sec = time.perf_counter() - inference_started

h5_files = glob.glob(os.path.join(output_dir, "*.h5"))
adapted_h5 = [path for path in h5_files if "snapshot-" in os.path.basename(path)]
if len(adapted_h5) != 1:
    raise RuntimeError(f"Esperado um HDF5 após adaptação; encontrados {{len(adapted_h5)}}. Saída bruta anterior à adaptação não será importada")
pose_h5 = adapted_h5[0]
poses = pd.read_hdf(pose_h5)
if not isinstance(poses.columns, pd.MultiIndex):
    raise RuntimeError("Formato de colunas do DeepLabCut não reconhecido")
if video_frames > 0 and len(poses.index) != video_frames:
    raise RuntimeError(f"O HDF5 adaptado tem {{len(poses.index)}} frames, mas o vídeo tem {{video_frames}}. Reencodifique o vídeo antes de medir tempo ou trajetória")

available = {{}}
for column in poses.columns:
    parts = [str(value) for value in column]
    coord_index = next((i for i, value in enumerate(parts) if value.lower() in {{"x", "y", "likelihood"}}), None)
    if coord_index is None or coord_index == 0:
        continue
    coordinate = parts[coord_index].lower()
    bodypart = parts[coord_index - 1].lower().replace("-", "_").replace(" ", "_")
    available.setdefault((bodypart, coordinate), poses[column])

def find_bodypart(aliases, excluded=()):
    normalized = [value.lower().replace("-", "_").replace(" ", "_") for value in aliases]
    for alias in normalized:
        if (alias, "x") in available and (alias, "y") in available and not any(token in alias for token in excluded):
            return alias
    for bodypart, coordinate in available:
        if coordinate == "x" and not any(token in bodypart for token in excluded) and any(alias in bodypart or bodypart in alias for alias in normalized):
            if (bodypart, "y") in available:
                return bodypart
    return None

aliases = {{
    "nose": ["nose", "snout", "muzzle"],
    "tail_base": ["tail_base", "tailbase", "tail_root", "tailroot"],
    "left_ear": ["left_ear", "leftear", "ear_left"],
    "right_ear": ["right_ear", "rightear", "ear_right"],
    "left_forepaw": ["left_forepaw", "left_front_paw", "left_frontpaw", "left_hand"],
    "right_forepaw": ["right_forepaw", "right_front_paw", "right_frontpaw", "right_hand"],
}}

selected = {{name: find_bodypart(values) for name, values in aliases.items()}}
selected = {{name: part for name, part in selected.items() if part or name not in ("left_forepaw", "right_forepaw")}}
all_bodyparts = sorted({{bodypart for bodypart, coordinate in available if coordinate == "x" and (bodypart, "y") in available}})
torso = list(dict.fromkeys(filter(None, (
    find_bodypart(["spine2", "spine_mid", "mid_back", "back_center", "body_center", "center", "centre", "spine1", "back"], ("tail", "paw", "ear", "nose", "snout")),
    find_bodypart(["spine3", "spine_hind", "hip", "hips", "rump", "pelvis"], ("tail", "paw", "ear", "nose", "snout")),
    selected.get("tail_base"),
))))
if len(torso) < 2:
    raise RuntimeError(f"O HDF5 adaptado não contém dois pontos corporais reconhecidos. Partes disponíveis: {{all_bodyparts}}")
def raw_point(bodypart, position):
    score = available.get((bodypart, "likelihood"))
    try:
        return tuple(float(value) for value in (available[(bodypart, "x")].iloc[position],
            available[(bodypart, "y")].iloc[position], score.iloc[position] if score is not None else -1))
    except (TypeError, ValueError):
        return (-1.0, -1.0, -1.0)

def point_at(bodypart, points):
    if bodypart is None:
        return (None, None, 0.0, "missing")
    return geometry_api["restore_point"](*points[bodypart], geometry)

raw_frames = [{{name: raw_point(name, position) for name in all_bodyparts}} for position in range(len(poses.index))]
if any(int(frame) != position for position, frame in enumerate(poses.index)):
    raise RuntimeError("Índices de frames não consecutivos: recuperação temporal cancelada para preservar sincronização")
recovery = recovery_api["VisualRecovery"](video_path, geometry)
recovery.attempt_limit = min(recovery_api["POLICY"]["maxAttempts"], max(1, math.ceil(len(raw_frames) * recovery_api["POLICY"]["maxRetryFraction"])))
print("Recuperando detecções parciais com evidência visual e histórico curto", flush=True)
print(f"BEHAVETRACKER_RECOVERY_PROGRESS=0/{{len(raw_frames)}}", flush=True)
recovery_started = time.perf_counter()
recovered_frames = recovery_api["recover_frames"](raw_frames, fps, geometry, recovery.retry)

def append_row(frame, name, point, original, support, total, recovered, original_support):
    x, y, score, status = point
    ox, oy, oscore, ostatus = original
    rows.append([frame, frame / fps, "animal_1", name, x, y, score, status,
        geometry_api["spatial_region"](x, y, geometry), support, total,
        "recovered" if recovered else "detected", ox, oy, oscore, ostatus,
        geometry_api["spatial_region"](ox, oy, geometry), original_support, total])

rows = []
center_row_indices = []
for numeric_frame, (points, recovered_names) in enumerate(recovered_frames):
    raw = raw_frames[numeric_frame]
    torso_points = [point_at(bodypart, points) for bodypart in torso]
    original_torso = [point_at(name, raw) for name in torso]
    max_body_span = 0.30 * min(video_width, video_height)
    original_center = geometry_api["torso_center"](original_torso, max_body_span)
    center = geometry_api["torso_center"](torso_points, max_body_span)
    support = len(geometry_api["reliable_torso_points"](torso_points, max_body_span))
    center_row_indices.append(len(rows))
    append_row(numeric_frame, "body_center", center, original_center, support, len(torso_points),
        any(name in recovered_names for name in torso), len(geometry_api["reliable_torso_points"](original_torso, max_body_span)))

    for canonical_name, bodypart in selected.items():
        point = point_at(bodypart, points)
        if point[3] == "valid" and center[3] == "valid" and math.dist(point[:2], center[:2]) > max_body_span * 1.5:
            point = (*point[:3], "jump")
        append_row(numeric_frame, canonical_name, point, point_at(bodypart, raw), int(point[3] != "missing"), 1,
            bodypart in recovered_names, int(point_at(bodypart, raw)[3] != "missing"))
recovery.close()
recovery_sec = time.perf_counter() - recovery_started
postprocess_started = time.perf_counter()
centers = [(rows[index][4], rows[index][5], rows[index][6], rows[index][7]) for index in center_row_indices]
sources = [rows[index][11] for index in center_row_indices]
processed_centers, postprocess_stats = postprocess_api["postprocess_centers"](
    centers, sources, video_width, video_height)
center_reasons = {{}}
for row_index, original, processed in zip(center_row_indices, centers, processed_centers):
    rows[row_index][4], rows[row_index][5], rows[row_index][6], rows[row_index][7] = processed
    rows[row_index][8] = geometry_api["spatial_region"](processed[0], processed[1], geometry)
    if original[3] == "valid" and processed[3] == "jump":
        center_reasons[row_index] = "statistical_outlier"
    elif original[:2] != processed[:2]:
        center_reasons[row_index] = "temporal_smoothing"
postprocess_sec = time.perf_counter() - postprocess_started
export_started = time.perf_counter()
print(f"BEHAVETRACKER_RECOVERY_PROGRESS={{len(raw_frames)}}/{{len(raw_frames)}}", flush=True)
print("BEHAVETRACKER_RECOVERY=" + json.dumps({{"attempted": recovery.attempted, "accepted": recovery.accepted,
    "unavailable": recovery.disabled_reason, "skippedBudget": recovery.skipped_budget, "policy": recovery_api["POLICY"]}}), flush=True)

recovery_state = "unavailable" if recovery.disabled_reason else "limited" if recovery.skipped_budget else "ready" if recovery.attempted else "not_needed"
canonical = pd.DataFrame([row + [recovery_state, postprocess_api["POLICY"]["version"], center_reasons.get(index, "")] for index, row in enumerate(rows)], columns=["frame_index", "timestamp_sec", "animal_id", "keypoint", "x_px", "y_px", "likelihood", "status", "spatial_region", "support_count", "support_total", "source", "raw_x_px", "raw_y_px", "raw_likelihood", "raw_status", "raw_spatial_region", "raw_support_count", "raw_support_total", "recovery_state", "processing_version", "tracking_reason"])
canonical.to_csv(canonical_path, index=False)
Path(output_dir, "render_request.json").write_text(json.dumps({{"video": video_path, "h5": pose_h5, "fps": fps, "geometry": geometry, "frames": len(poses.index)}}), encoding="utf-8")
Path(output_dir, "analysis_profile.json").write_text(json.dumps({{"inferenceSec": inference_sec, "recoverySec": recovery_sec, "postprocessSec": postprocess_sec, "postprocessVersion": postprocess_api["POLICY"]["version"], "postprocessStats": postprocess_stats, "exportSec": time.perf_counter() - export_started, "recoveryAttempts": recovery.attempted, "recoveryAccepted": recovery.accepted, "recoverySkippedBudget": recovery.skipped_budget}}), encoding="utf-8")
print(f"BEHAVETRACKER_TIMINGS inference={{inference_sec:.2f}}s recovery={{recovery_sec:.2f}}s postprocess={{postprocess_sec:.2f}}s export={{time.perf_counter() - export_started:.2f}}s", flush=True)
Path(canonical_path + ".complete").write_text("ok", encoding="utf-8")
print(f"BEHAVETRACKER_RESULT={{canonical_path}}|rows={{len(canonical)}}|fps={{fps:.6f}}")
"#,
        remote_video = remote_video,
        remote_output = remote_output,
        canonical_csv = canonical_csv,
        arena_helpers = include_str!("../python/arena.py"),
        recovery_helpers = include_str!("../python/recovery.py"),
        postprocess_helpers = include_str!("../python/trajectory_postprocess.py"),
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
    let mut attempted = Vec::new();
    for candidate in jupyter_path_candidates(remote_path) {
        attempted.push(candidate.clone());
        let response = client
            .get(jupyter_url(connection, &format!("files/{candidate}")))
            .header("X-Colab-Runtime-Proxy-Token", &connection.token)
            .send()
            .map_err(|_| "Falha de rede ao baixar o resultado do Colab.".to_string())?;
        if response.status().is_success() {
            let mut output = File::create(local_path)
                .map_err(|_| "Não foi possível criar o resultado local.".to_string())?;
            let mut response = response;
            std::io::copy(&mut response, &mut output)
                .map_err(|_| "Falha ao salvar o resultado retornado pelo Colab.".to_string())?;
            break;
        }
        if response.status() != reqwest::StatusCode::NOT_FOUND {
            return Err(format!(
                "O Jupyter recusou o download do resultado (HTTP {}).",
                response.status().as_u16()
            ));
        }
        let contents = client
            .get(jupyter_url(
                connection,
                &format!("api/contents/{candidate}?content=1"),
            ))
            .header("X-Colab-Runtime-Proxy-Token", &connection.token)
            .send()
            .map_err(|_| "Falha de rede ao consultar o resultado no Jupyter.".to_string())?;
        if contents.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        if !contents.status().is_success() {
            return Err(format!(
                "O Jupyter recusou a leitura do resultado (HTTP {}).",
                contents.status().as_u16()
            ));
        }
        let model = response_json(contents, "Não foi possível ler o resultado no Jupyter")?;
        let content = model
            .get("content")
            .and_then(Value::as_str)
            .ok_or("O Jupyter retornou um resultado sem conteúdo.")?;
        let bytes = if model.get("format").and_then(Value::as_str) == Some("base64") {
            STANDARD
                .decode(content)
                .map_err(|_| "O conteúdo base64 retornado pelo Jupyter é inválido.")?
        } else {
            content.as_bytes().to_vec()
        };
        fs::write(local_path, bytes)
            .map_err(|_| "Falha ao salvar o resultado retornado pelo Jupyter.".to_string())?;
        break;
    }
    if !local_path.is_file() {
        return Err(format!(
            "O Jupyter não encontrou o resultado nos caminhos: {}.",
            attempted.join(", ")
        ));
    }
    if fs::metadata(local_path)
        .map_err(|_| "Não foi possível validar o CSV retornado.".to_string())?
        .len()
        == 0
    {
        return Err("O Colab retornou um CSV vazio.".into());
    }
    Ok(())
}

fn jupyter_path_candidates(path: &str) -> Vec<String> {
    let normalized = path.trim_matches('/');
    let without_content = normalized.strip_prefix("content/").unwrap_or(normalized);
    let mut candidates = Vec::new();
    for candidate in [normalized, without_content, &format!("/content/{without_content}")] {
        let candidate = candidate.trim_matches('/').to_string();
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn download_remote_artifact(
    app: &AppHandle,
    job_id: &str,
    session: &str,
    connection: &ConnectionInfo,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), AnalysisFailure> {
    let path_literal = format!("{remote_path:?}");
    let metadata_payload = execute_job_code(
        app,
        job_id,
        &google_access_token(app, PROFILE_ID)?,
        session,
        &format!(
            "import hashlib,json\nfrom pathlib import Path\np=Path({path_literal})\nif not p.is_file(): raise FileNotFoundError(str(p))\nh=hashlib.sha256()\nwith p.open('rb') as f:\n    for block in iter(lambda:f.read(1048576),b''): h.update(block)\nprint('BEHAVETRACKER_FILE_META='+json.dumps(dict(size=p.stat().st_size,sha256=h.hexdigest())))"
        ),
    )?;
    let metadata = metadata_payload
        .get("stdout")
        .and_then(Value::as_str)
        .and_then(|stdout| stdout.lines().find_map(|line| line.strip_prefix("BEHAVETRACKER_FILE_META=")))
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .ok_or_else(|| {
            format!("O runtime não publicou o artefato esperado: {remote_path}. A execução Python foi marcada como concluída, mas o arquivo não existe no output.")
        })?;
    let size = metadata["size"].as_u64().ok_or("Tamanho do artefato remoto inválido")?;
    let digest = metadata["sha256"].as_str().filter(|value| value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("SHA-256 do artefato remoto inválido")?;
    publish_verified_artifact(connection, remote_path, local_path, size, digest).map_err(Into::into)
}

fn publish_verified_artifact(connection: &ConnectionInfo, remote_path: &str, local_path: &Path, size: u64, digest: &str) -> CommandResult<()> {
    let filename = local_path.file_name().and_then(|name| name.to_str()).ok_or("Nome do artefato local inválido")?;
    let temporary = local_path.with_file_name(format!("{filename}.partial"));
    let _ = fs::remove_file(&temporary);
    let result = (|| -> CommandResult<()> {
        let client = Client::builder().timeout(Duration::from_secs(600)).build()
            .map_err(|_| "Não foi possível iniciar o download do artefato")?;
        let mut found = false;
        for candidate in jupyter_path_candidates(remote_path) {
            let mut response = client.get(jupyter_url(connection, &format!("files/{candidate}")))
                .header("X-Colab-Runtime-Proxy-Token", &connection.token).send()
                .map_err(|_| "Falha de rede ao baixar o artefato")?;
            if response.status() == reqwest::StatusCode::NOT_FOUND { continue; }
            if !response.status().is_success() {
                return Err(format!("O Jupyter recusou o artefato (HTTP {})", response.status().as_u16()));
            }
            let mut output = File::create(&temporary).map_err(|_| "Não foi possível salvar o artefato temporário")?;
            std::io::copy(&mut response, &mut output).map_err(|_| "Download do artefato interrompido")?;
            found = true;
            break;
        }
        if !found { return Err("O Jupyter não disponibilizou o artefato pela rota binária /files".into()); }
        if fs::metadata(&temporary).map_err(|_| "Artefato local indisponível")?.len() != size
            || crate::video::sha256(&temporary)? != digest {
            return Err("Integridade SHA-256 do artefato recebido não confirmada".into());
        }
        fs::rename(&temporary, local_path).map_err(|_| "Não foi possível publicar o artefato local".to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn download_labeled_video(connection: &ConnectionInfo, remote_output: &str, directory: &Path, job_id: &str) -> CommandResult<PathBuf> {
    let client = Client::builder().timeout(Duration::from_secs(600)).build().map_err(|_| "Não foi possível iniciar o download do vídeo")?;
    let response = client.get(jupyter_url(connection, &format!("files/{remote_output}/video_artifact.json")))
        .header("X-Colab-Runtime-Proxy-Token", &connection.token).send().map_err(|_| "Falha ao consultar o vídeo do DeepLabCut")?;
    if !response.status().is_success() { return Err("O runtime não publicou o manifesto do vídeo rotulado".into()); }
    let mut manifest = String::new();
    response.take(16 * 1024).read_to_string(&mut manifest).map_err(|_| "Manifesto de vídeo ilegível")?;
    let manifest: Value = serde_json::from_str(&manifest).map_err(|_| "Manifesto de vídeo inválido")?;
    if manifest["available"].as_bool() != Some(true) {
        return Err(manifest["error"].as_str().unwrap_or("O vídeo do DeepLabCut não foi gerado").chars().take(1500).collect());
    }
    if manifest["filename"].as_str() != Some("dlc_labeled.mp4") || ![Some("deeplabcut_raw_h5"),Some("behavetracker-keypoint-rcnn-v1"),Some("behavetracker-hybrid-df-v2"),Some("behavetracker-fst-v1")].contains(&manifest["source"].as_str()) {
        return Err("Origem do vídeo de resultado não reconhecida".into());
    }
    let bytes = manifest["sizeBytes"].as_u64().filter(|size| *size > 0 && *size <= MAX_VIDEO_SIZE as u64).ok_or("Tamanho inválido do vídeo rotulado")?;
    let digest = manifest["sha256"].as_str().filter(|value| value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())).ok_or("Hash do vídeo não informado")?;
    let path = directory.join(format!("{job_id}-dlc.mp4"));
    let temporary = directory.join(format!("{job_id}-dlc.mp4.partial"));
    let result = (|| {
        let response = client.get(jupyter_url(connection, &format!("files/{remote_output}/dlc_labeled.mp4")))
            .header("X-Colab-Runtime-Proxy-Token", &connection.token).send().map_err(|_| "Falha de rede ao baixar o vídeo rotulado")?;
        if !response.status().is_success() { return Err("O runtime recusou o download do vídeo rotulado".into()); }
        let mut file = File::create(&temporary).map_err(|_| "Não foi possível salvar o vídeo rotulado")?;
        let received = std::io::copy(&mut response.take(bytes + 1), &mut file).map_err(|_| "Download do vídeo interrompido")?;
        if received != bytes || crate::video::sha256(&temporary)? != digest { return Err("Integridade do vídeo rotulado não confirmada; arquivo não publicado".into()); }
        fs::rename(&temporary, &path).map_err(|_| "Não foi possível publicar o vídeo local")?;
        Ok(path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn custom_code(video:&str,model:&str,output:&str,csv:&str,arena:Option<&AnalysisArena>,range:Option<&DiagnosticRange>)->String {
    format!(r#"import json,runpy
from pathlib import Path
root=Path({output:?});root.mkdir(parents=True,exist_ok=True)
if not Path({csv:?}+'.complete').is_file():
    (root/'custom_model.py').write_text({source:?},encoding='utf-8')
    (root/'arena_helpers.py').write_text({geometry:?},encoding='utf-8')
    runpy.run_path(str(root/'custom_model.py'))['infer']({video:?},{model:?},str(root),{csv:?},json.loads({arena:?}),runpy.run_path(str(root/'arena_helpers.py')),json.loads({range:?}))
"#,source=include_str!("../python/custom_model.py"),geometry=include_str!("../python/arena.py"),arena=serde_json::to_string(&arena).unwrap(),range=serde_json::to_string(&range).unwrap())
}

fn validate_hybrid_directory(root: &Path, bundle_id: &str) -> CommandResult<Vec<(String, String)>> {
    hybrid_bundle_files(bundle_id)?.iter().map(|(filename, size, expected)| {
        let path = root.join(filename);
        let metadata = fs::metadata(&path).map_err(|_| format!("Arquivo do bundle {bundle_id} ausente: {filename}"))?;
        if metadata.len() != *size || crate::video::sha256(&path)? != *expected {
            return Err(format!("Integridade inválida no bundle {bundle_id}: {filename}"));
        }
        Ok((filename.to_string(), path.to_string_lossy().into_owned()))
    }).collect()
}

fn hybrid_bundle_paths(app: &AppHandle, bundle_id: &str) -> CommandResult<Vec<(String, String)>> {
    hybrid_bundle_files(bundle_id)?;
    let packaged = app.path().resource_dir().ok().map(|root| root.join("models").join(bundle_id));
    let installed = app.path().app_data_dir().map_err(|_| "Diretório do app indisponível")?.join("models").join(bundle_id);
    let mut roots = Vec::new();
    if bundle_id == "wistar_df_v2" { roots.extend(packaged.clone()); }
    roots.push(installed);
    if bundle_id != "wistar_df_v2" { roots.extend(packaged); }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("models").join(bundle_id));
    let mut invalid = None;
    for root in roots {
        if root.is_dir() {
            match validate_hybrid_directory(&root, bundle_id) {
                Ok(files) => return Ok(files),
                Err(error) => invalid = Some(error),
            }
        }
    }
    if let Some(error) = invalid { return Err(error); }
    Err(format!("Bundle {bundle_id} ausente. Instale os três arquivos verificados antes de enviar o vídeo."))
}

#[tauri::command]
pub async fn hybrid_bundle_status(app: AppHandle, bundle_id: String) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        hybrid_bundle_files(&bundle_id)?;
        match hybrid_bundle_paths(&app, &bundle_id) {
            Ok(_) => Ok(json!({"bundleId": bundle_id, "installed": true, "error": null})),
            Err(error) => Ok(json!({"bundleId": bundle_id, "installed": false, "error": error})),
        }
    }).await.map_err(|_| "Falha ao verificar o bundle em segundo plano".to_string())?
}

#[tauri::command]
pub async fn hybrid_bundle_available(app: AppHandle, bundle_id: String) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = hybrid_bundle_files(&bundle_id)?;
        let packaged = app.path().resource_dir().ok().map(|root| root.join("models").join(&bundle_id));
        let installed = app.path().app_data_dir().map_err(|_| "Diretório do app indisponível")?.join("models").join(&bundle_id);
        let mut roots = Vec::new();
        if bundle_id == "wistar_df_v2" { roots.extend(packaged.clone()); }
        roots.push(installed);
        if bundle_id != "wistar_df_v2" { roots.extend(packaged); }
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("models").join(&bundle_id));
        let available = roots.iter().any(|root| files.iter().all(|(filename, size, _)| {
            fs::metadata(root.join(filename)).is_ok_and(|metadata| metadata.is_file() && metadata.len() == *size)
        }));
        Ok(json!({"bundleId": bundle_id, "installed": available, "error": if available { None } else { Some("Arquivos do modelo ausentes ou incompletos. Instale o bundle antes de continuar.") }}))
    }).await.map_err(|_| "Falha ao localizar o bundle em segundo plano".to_string())?
}

#[tauri::command]
pub async fn import_hybrid_bundle(app: AppHandle, bundle_id: String, source_directory: String) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || import_hybrid_bundle_blocking(&app, &bundle_id, &source_directory))
        .await.map_err(|_| "Falha ao importar o bundle em segundo plano".to_string())?
}

fn import_hybrid_bundle_blocking(app: &AppHandle, bundle_id: &str, source_directory: &str) -> CommandResult<Value> {
    hybrid_bundle_files(&bundle_id)?;
    let source = Path::new(&source_directory);
    validate_hybrid_directory(source, &bundle_id)?;
    let destination = app.path().app_data_dir().map_err(|_| "Diretório do app indisponível")?
        .join("models").join(&bundle_id);
    fs::create_dir_all(&destination).map_err(|_| "Não foi possível criar a pasta dos modelos")?;
    for (filename, _, _) in hybrid_bundle_files(&bundle_id)? {
        let temporary = destination.join(format!("{filename}.partial"));
        fs::copy(source.join(filename), &temporary).map_err(|_| format!("Não foi possível copiar {filename}"))?;
        if let Err(error) = validate_hybrid_file(&temporary, filename, &bundle_id) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        let installed = destination.join(filename);
        if installed.is_file() && validate_hybrid_file(&installed, filename, &bundle_id).is_ok() {
            fs::remove_file(&temporary).map_err(|_| format!("Não foi possível limpar {filename}"))?;
            continue;
        }
        if installed.exists() { fs::remove_file(&installed).map_err(|_| format!("Não foi possível substituir {filename}"))?; }
        fs::rename(&temporary, &installed).map_err(|_| format!("Não foi possível instalar {filename}"))?;
    }
    validate_hybrid_directory(&destination, &bundle_id)?;
    Ok(json!({"bundleId": bundle_id, "installed": true, "error": null}))
}

fn validate_hybrid_file(path: &Path, filename: &str, bundle_id: &str) -> CommandResult<()> {
    let (_, size, expected) = hybrid_bundle_files(bundle_id)?.into_iter()
        .find(|(name, _, _)| *name == filename).ok_or("Arquivo do bundle desconhecido")?;
    if fs::metadata(path).map_err(|_| "Arquivo do bundle ausente")?.len() != size
        || crate::video::sha256(path)? != expected {
        return Err(format!("Integridade inválida no bundle {bundle_id}: {filename}"));
    }
    Ok(())
}

fn release_model_task(filename: &str) -> Option<&'static str> {
    match filename {
        "best_detector.pth" => Some("model_detector"),
        "snapshot-hrnet_w32-001.pt" => Some("model_hrnet"),
        "pytorch_config.yaml" => Some("model_config"),
        _ => None,
    }
}

fn release_model_code(filename: &str, destination: &str, size: u64, digest: &str) -> String {
    let url = format!("{WISTAR_V2_RELEASE}/{filename}");
    format!("{}\nfetch_model({url:?}, {destination:?}, {size}, {digest:?})\n", include_str!("../python/model_delivery.py"))
}

fn upload_hybrid_bundle(
    app: &AppHandle,
    job: &str,
    connection: &ConnectionInfo,
    session: &str,
    remote_directory: &str,
    bundle_id: Option<&str>,
) -> Result<Option<String>, AnalysisFailure> {
    let bundle_id = bundle_id.ok_or("Modelo de análise não informado.")?;
    let files = hybrid_bundle_paths(app, bundle_id)?;
    let parent = remote_directory.rsplit_once('/').map(|(value, _)| value)
        .ok_or("Pasta remota inválida")?;
    let remote_root = format!("{parent}/models/{bundle_id}");
    let remote_root_absolute = format!("/content/behavetracker/models/{bundle_id}");
    let mkdir_code = format!(
        "from pathlib import Path\nPath({remote_root_absolute:?}).mkdir(parents=True, exist_ok=True)\nprint('BEHAVETRACKER_HYBRID_DIR_READY')"
    );
    let mkdir_result = execute_job_code(
        app,
        job,
        &google_access_token(app, PROFILE_ID)?,
        session,
        &mkdir_code,
    )?;
    if !mkdir_result["stdout"]
        .as_str()
        .unwrap_or("")
        .contains("BEHAVETRACKER_HYBRID_DIR_READY")
    {
        return Err("O Colab não conseguiu preparar a pasta remota do modelo.".into());
    }
    let mut upload_connection = connection.clone();
    let mut release_available = bundle_id == "wistar_df_v2";
    for (filename, path) in files {
        let local = Path::new(&path);
        let size = fs::metadata(local).map_err(|_| format!("Arquivo do bundle indisponível: {filename}"))?.len() as i64;
        let digest = crate::video::sha256(local)?;
        let remote = format!("{remote_root}/{filename}");
        let destination = format!("/content/behavetracker/models/{bundle_id}/{filename}");
        let cache_check = format!(
            "from pathlib import Path\nimport hashlib\np=Path({destination:?})\nh=hashlib.sha256()\nif p.is_file():\n    with p.open('rb') as f:\n        for b in iter(lambda:f.read(1048576),b''): h.update(b)\nprint('BEHAVETRACKER_HYBRID_CACHED' if p.is_file() and h.hexdigest()=={digest:?} else 'BEHAVETRACKER_HYBRID_MISSING')"
        );
        let response = execute_job_code(app, job, &google_access_token(app, PROFILE_ID)?, session, &cache_check)?;
        if !response["stdout"].as_str().unwrap_or("").contains("BEHAVETRACKER_HYBRID_CACHED") {
            if release_available {
                let task = release_model_task(&filename).ok_or("Arquivo desconhecido na release do modelo")?;
                update_job(app, job, "running", "uploading", 20,
                    &format!("Baixando {filename} da release versionada diretamente no Colab"))?;
                let code = release_model_code(&filename, &destination, size as u64, &digest);
                match run_background_task(app, job, session, &format!("/content/behavetracker/{job}"), task, &code) {
                    Ok(()) => {
                        verify_remote_file(app, job, session, &destination, &digest)?;
                        update_job(app, job, "running", "uploading", 20,
                            &format!("{filename} baixado e validado no Colab · SHA-256 confirmado"))?;
                        continue;
                    }
                    Err(error) if error.preserve_session => return Err(error),
                    Err(error) => {
                        release_available = false;
                        update_job(app, job, "running", "uploading", 20,
                            &format!("Download da release indisponível para {filename} ({}) · usando o envio local", error.message.chars().take(180).collect::<String>()))?;
                    }
                }
            }
            update_job(app, job, "running", "uploading", 20,
                &format!("Enviando {filename} do bundle {bundle_id} ao Colab"))?;
            let mut retried = false;
            loop {
                match upload_video(app, job, &upload_connection, local, &remote, size) {
                    Ok(()) => break,
                    Err(error) if !retried && error.contains("HTTP 404") => {
                        retried = true;
                        update_job(app, job, "running", "uploading", 20,
                            &format!("A rota do Jupyter falhou durante {filename}; renovando a conexão da mesma GPU"))?;
                        let runtime_name = session.split("/sessions/").next().ok_or("Sessão Colab inválida")?;
                        let token = google_access_token(app, PROFILE_ID)?;
                        let refreshed = get_runtime(&api_client()?, &token, runtime_name)?;
                        let fresh_connection = refreshed.connection_info
                            .ok_or("O runtime não forneceu uma nova conexão para o upload")?;
                        let workspace = format!("/content/behavetracker/{job}");
                        let mapped = resolve_jupyter_workspace(&fresh_connection, &workspace, job)?;
                        if mapped != remote_directory {
                            return Err("A rota do Jupyter mudou durante o upload. O job foi preservado sem enviar o vídeo; tente novamente.".into());
                        }
                        let ready = execute_job_code(app, job, &token, session, &mkdir_code)?;
                        if !ready["stdout"].as_str().unwrap_or("").contains("BEHAVETRACKER_HYBRID_DIR_READY") {
                            return Err("O runtime não confirmou a pasta do bundle após renovar a conexão.".into());
                        }
                        upload_connection = fresh_connection;
                    }
                    Err(error) => return Err(format!("Falha no upload de {filename} do bundle {bundle_id}: {error}").into()),
                }
            }
            verify_remote_file(app, job, session, &destination, &digest)?;
        }
    }
    Ok(Some(format!("/content/behavetracker/models/{bundle_id}")))
}

fn prepare_hybrid_environment(app: &AppHandle, job: &str, session: &str, directory: &str) -> Result<(), AnalysisFailure> {
    update_job(app, job, "running", "environment_check", 52, "Validando PyTorch, TorchVision, DeepLabCut e CUDA para o rastreamento")?;
    run_background_task(app, job, session, directory, "setup", &format!(
        "import importlib.util,subprocess,sys\nif importlib.util.find_spec('deeplabcut') is None:\n    subprocess.check_call([sys.executable,'-m','pip','install','-q','--pre','deeplabcut[modelzoo]>=3.0,<4'])\nimport torch,torchvision\nif not torch.cuda.is_available(): raise RuntimeError('CUDA não está disponível para o rastreamento')\ntorchvision.ops.nms(torch.zeros((0,4),device='cuda'),torch.zeros(0,device='cuda'),0.5)\nimport deeplabcut\nimport deeplabcut.pose_estimation_pytorch as pep\nfrom deeplabcut.pose_estimation_pytorch.config import PoseConfig\nfrom deeplabcut.pose_estimation_pytorch.apis.videos import create_df_from_prediction\nrequired=['get_pose_inference_runner','VideoIterator','video_inference']\nmissing=[name for name in required if not hasattr(pep,name)]\nif missing: raise RuntimeError('API DLC ausente: '+', '.join(missing))\nprint('BEHAVETRACKER_HYBRID_ENV_OK '+torch.__version__+' '+torchvision.__version__+' '+deeplabcut.__version__)"
    ))?;
    update_job(app, job, "running", "environment_ready", 60, "Ambiente de rastreamento validado")?;
    Ok(())
}

fn prepare_fst_environment(app: &AppHandle, job: &str, session: &str, directory: &str) -> Result<(), AnalysisFailure> {
    update_job(app, job, "running", "environment_check", 52, "Validando DeepLabCut 3.0.2, HRNet-w32 e CUDA para FST")?;
    let code = "import os,sys,subprocess,importlib.metadata\nos.environ['HF_HUB_DISABLE_XET']='1'\nos.environ['HF_HUB_DOWNLOAD_TIMEOUT']='120'\nos.environ['HF_HUB_ETAG_TIMEOUT']='30'\ntry:\n    version=importlib.metadata.version('deeplabcut')\nexcept importlib.metadata.PackageNotFoundError:\n    version=None\nif version!='3.0.2': subprocess.check_call([sys.executable,'-m','pip','install','-q','deeplabcut==3.0.2'])\nimport torch,cv2,numpy,pandas,deeplabcut\nimport deeplabcut.pose_estimation_pytorch as pep\nfrom deeplabcut.pose_estimation_pytorch.modelzoo.inference_helpers import create_superanimal_inference_runners\nif not torch.cuda.is_available(): raise RuntimeError('CUDA indisponível para FST')\nif not hasattr(pep,'VideoIterator') or not hasattr(pep,'video_inference'): raise RuntimeError('API DLC 3 incompatível')\nprint('BEHAVETRACKER_FST_ENV_OK '+deeplabcut.__version__+' '+torch.cuda.get_device_name(0))";
    run_background_task(app, job, session, directory, "setup", code)?;
    update_job(app, job, "running", "environment_ready", 60, "Ambiente FST validado · detector desativado")?;
    Ok(())
}

fn fst_code(video: &str, output: &str, fst: &FstConfiguration, workload: &AnalysisWorkload, digest: &str, original_digest: &str, filename: &str, run_id: &str) -> String {
    let config = json!({"protocol":"forced_swim","engineId":"fst_superanimal_quadruped_v1",
        "runId":run_id,"title":&fst.title,"group":&fst.group,"notes":&fst.notes,
        "subjects":&fst.subjects,"tanks":&fst.tanks,
        "video":{"sha256":digest,"originalSha256":original_digest,"filename":filename,"width":workload.width,"height":workload.height}});
    let config_json = config.to_string();
    let source = include_str!("../python/fst_pipeline.py");
    let presence = include_str!("../python/fst_presence.py");
    format!("import json,runpy,sys\nfrom pathlib import Path\np=Path({output:?})\np.mkdir(parents=True,exist_ok=True)\n(p/'fst_presence.py').write_text({presence:?},encoding='utf-8')\n(p/'fst_pipeline.py').write_text({source:?},encoding='utf-8')\nsys.path.insert(0,str(p))\nrunpy.run_path(str(p/'fst_pipeline.py'))['run']({video:?},{output:?},json.loads({config_json:?}))")
}

fn hybrid_code(video: &str, output: &str, csv: &str, arena: Option<&AnalysisArena>, models: &str, bundle_id: &str) -> String {
    let files = hybrid_bundle_files(bundle_id).expect("bundle validado antes da execução");
    let arena_literal = match serde_json::to_string(&arena).unwrap() {
        value if value == "null" => "None".to_string(),
        value => format!("json.loads({value:?})"),
    };
    let source = include_str!("../python/hybrid_pipeline.py")
        .replace("__VIDEO__", &serde_json::to_string(video).unwrap())
        .replace("__OUTPUT__", &serde_json::to_string(output).unwrap())
        .replace("__CSV__", &serde_json::to_string(csv).unwrap())
        .replace("__MODELS__", &serde_json::to_string(models).unwrap())
        .replace("__MODEL_BUNDLE_ID__", &serde_json::to_string(bundle_id).unwrap())
        .replace("__DETECTOR_SHA256__", &format!("{:?}", files[0].2))
        .replace("__POSE_SHA256__", &format!("{:?}", files[1].2))
        .replace("__CONFIG_SHA256__", &format!("{:?}", files[2].2))
        .replace("__ARENA__", &arena_literal);
    let detector_source = include_str!("../python/hybrid/detector_wistar.py");
    format!("import runpy,sys\nfrom pathlib import Path\np=Path({output:?})/'hybrid_pipeline.py'\np.parent.mkdir(parents=True, exist_ok=True)\nh=p.parent/'hybrid'\nh.mkdir(exist_ok=True)\n(h/'__init__.py').write_text('')\n(h/'detector_wistar.py').write_text({detector_source:?},encoding='utf-8')\np.write_text({source:?},encoding='utf-8')\nsys.path.insert(0,str(p.parent))\nrunpy.run_path(str(p), run_name='__main__')\n")
}
fn hybrid_render_code(video: &str, output: &str, arena: Option<&AnalysisArena>) -> String {
    let source = include_str!("../python/hybrid_render.py");
    let geometry = serde_json::to_string(&arena).expect("arena serializável");
    format!("import json,runpy\nfrom pathlib import Path\np=Path({output:?})/'hybrid_render.py'\np.write_text({source:?},encoding='utf-8')\nrunpy.run_path(str(p))['render']({video:?},{output:?},json.loads({geometry:?}))\n")
}
fn custom_environment_code()->String {"import torch,torchvision,cv2\nfrom PIL import Image\nif not torch.cuda.is_available(): raise RuntimeError('CUDA não está disponível no runtime. Selecione uma sessão GPU.')\ntorchvision.ops.nms(torch.zeros((0,4),device='cuda'),torch.zeros(0,device='cuda'),0.5)\nprint('BEHAVETRACKER_CUSTOM_ENV_OK '+torch.__version__+' '+torchvision.__version__)".into()}
fn prepare_custom_environment(app:&AppHandle,job:&str,session:&str,directory:&str)->Result<(),AnalysisFailure>{
    update_job(app,job,"running","environment_check",52,"Verificando PyTorch, TorchVision, OpenCV e CUDA · não é necessário instalar DeepLabCut para o modelo personalizado")?;
    run_background_task(app,job,session,directory,"setup",&custom_environment_code())?;
    update_job(app,job,"running","environment_ready",60,"Ambiente PyTorch/CUDA pronto para o modelo personalizado")?;Ok(())
}
fn ensure_remote_model(app:&AppHandle,job:&str,session:&str,connection:&ConnectionInfo,remote_directory:&str,absolute_directory:&str)->Result<Option<String>,AnalysisFailure>{
    let row:Option<(String,String)>=open_database(app)?.query_row("SELECT r.job_id,r.model_sha256 FROM custom_analysis_models a JOIN training_runs r ON r.job_id=a.model_job_id WHERE a.job_id=?1",[job],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|"Modelo do job indisponível")?;
    let Some((id,digest))=row else{return Ok(None);};let path=crate::training::model_path(app,&id)?;
    if crate::video::sha256(&path)?!=digest{return Err("Modelo foi alterado ou removido; selecione novamente uma versão válida".into());}
    let _=absolute_directory;
    let destination=format!("/content/behavetracker/models/{digest}.pt");
    let cache_check=format!("import hashlib\nfrom pathlib import Path\np=Path({destination:?})\np.parent.mkdir(parents=True,exist_ok=True)\nh=hashlib.sha256()\nif p.is_file():\n    with p.open('rb') as f:\n        for b in iter(lambda:f.read(1048576),b''): h.update(b)\nif p.is_file() and h.hexdigest()=={digest:?}: print('BEHAVETRACKER_MODEL_CACHED')");
    let response=execute_job_code(app,job,&google_access_token(app,PROFILE_ID)?,session,&cache_check)?;
    if response["stdout"].as_str().unwrap_or("").contains("BEHAVETRACKER_MODEL_CACHED"){
        update_job(app,job,"running","uploading",45,"Reutilizando o checkpoint personalizado já verificado neste runtime")?;
        return Ok(Some(destination));
    }
    update_job(app,job,"running","uploading",45,"Enviando a versão congelada do modelo personalizado")?;
    let parent=remote_directory.rsplit_once('/').map(|(parent,_)|parent).ok_or("Pasta remota inválida")?;
    upload_video(app,job,connection,&path,&format!("{parent}/models/{digest}.pt"),fs::metadata(&path).map_err(|_|"Modelo indisponível")?.len() as i64)?;
    verify_remote_file(app,job,session,&destination,&digest)?;Ok(Some(destination))
}
fn verify_remote_file(app:&AppHandle,job:&str,session:&str,path:&str,digest:&str)->Result<(),AnalysisFailure>{
    let code=format!("import hashlib\nfrom pathlib import Path\nh=hashlib.sha256()\nwith Path({path:?}).open('rb') as f:\n    for block in iter(lambda:f.read(1048576),b''): h.update(block)\nif h.hexdigest() != {digest:?}: raise RuntimeError('Integridade SHA-256 não confirmada')\nprint('BEHAVETRACKER_FILE_OK')");
    let response=execute_job_code(app,job,&google_access_token(app,PROFILE_ID)?,session,&code)?;
    if !response["stdout"].as_str().unwrap_or("").contains("BEHAVETRACKER_FILE_OK"){return Err("O runtime não confirmou a integridade do arquivo".into());}Ok(())
}

pub(crate) fn start_training(app:AppHandle,experiment_id:String,job_id:String,dataset:PathBuf,digest:String,epochs:u32)->CommandResult<ColabJob>{
    prepare_tables(&app)?;let connection=open_database(&app)?;let tx=connection.unchecked_transaction().map_err(|_|"Não foi possível iniciar o job")?;
    let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM colab_jobs WHERE status IN ('queued','running'))",[],|r|r.get(0)).map_err(|_|"Não foi possível consultar jobs ativos")?;
    if active{return Err("Aguarde as análises/treinamentos ativos antes de iniciar um treino. O modelo não foi alterado".into());}
    tx.execute("INSERT INTO colab_jobs(job_id,profile_id,experiment_id,upload_id,status,stage,progress,message) VALUES (?1,?2,?3,?1,'queued','queued',0,'Snapshot de exemplos humanos preparado')",params![job_id,PROFILE_ID,experiment_id]).map_err(|_|"Não foi possível criar treinamento")?;
    tx.execute("INSERT INTO training_runs(job_id,dataset_path,dataset_sha256,epochs) VALUES (?1,?2,?3,?4)",params![job_id,dataset.to_string_lossy(),digest,epochs]).map_err(|_|"Não foi possível registrar treinamento")?;tx.commit().map_err(|_|"Registro interrompido")?;
    update_job(&app,&job_id,"queued","queued",0,"Treinamento solicitado pelo usuário · dataset imutável; modelo atual preservado")?;
    let job=get_job(&app,&job_id)?;tauri::async_runtime::spawn_blocking(move||{if let Err(error)=run_training(app.clone(),&job_id,&dataset,&digest,epochs){let _=fail_job(&app,&job_id,&error);}});Ok(job)
}
fn run_training(app:AppHandle,job:&str,dataset:&Path,digest:&str,epochs:u32)->CommandResult<()> {
    update_job(&app,job,"running","runtime",10,"Localizando GPU elegível para treinamento experimental")?;
    let token=google_access_token(&app,PROFILE_ID)?;let(runtime,reason)=choose_or_create_runtime(&token,&AnalysisWorkload{width:1280,height:720,duration_sec:0.},false,&mut |message| update_job(&app,job,"running","runtime",10,message))?;
    update_job(&app,job,"running","runtime",12,&reason)?;
    let connection=runtime.connection_info.clone().ok_or("Runtime não informou conexão Jupyter")?;
    let session=format!("{}/sessions/behavetracker-{}",runtime.name,job.split('-').next().unwrap_or("train"));
    let directory=format!("/content/behavetracker/{job}");
    open_database(&app)?.execute("UPDATE colab_jobs SET runtime_name=?2,session_name=?3 WHERE job_id=?1",params![job,runtime.name,session]).map_err(|_|"Não foi possível registrar runtime")?;
    let result=(||->Result<(),AnalysisFailure>{
        update_job(&app,job,"running","workspace",15,"Abrindo sessão de treinamento")?;
        let workspace=execute_job_code(&app,job,&token,&session,&prepare_workspace_code(&directory,job))?;
        update_job(&app,job,"running","gpu_ready",18,&format!("{} encontrada · sessão de treinamento pronta",workspace_gpu(&workspace)?))?;
        let relative=resolve_jupyter_workspace(&connection,&directory,job)?;
        update_job(&app,job,"running","uploading",20,"Enviando somente exemplos humanos revisados e suas imagens")?;
        upload_video(&app,job,&connection,dataset,&format!("{relative}/dataset.jsonl"),fs::metadata(dataset).map_err(|_|"Snapshot indisponível")?.len() as i64)?;
        update_job(&app,job,"running","verifying",47,"Conferindo integridade do snapshot no Colab")?;
        verify_remote_file(&app,job,&session,&format!("{directory}/dataset.jsonl"),digest)?;
        update_job(&app,job,"running","video_ready",50,"Dataset recebido e SHA-256 confirmado")?;
        prepare_custom_environment(&app,job,&session,&directory)?;
        let code=format!("import runpy\nfrom pathlib import Path\np=Path({directory:?})\n(p/'custom_model.py').write_text({source:?},encoding='utf-8')\nrunpy.run_path(str(p/'custom_model.py'))['train'](str(p/'dataset.jsonl'),str(p/'output'),{epochs})",source=include_str!("../python/custom_model.py"));
        update_job(&app,job,"running","training",65,"Ajustando detector e pontos com rótulos humanos · nova versão experimental")?;
        run_background_task(&app,job,&session,&directory,"training",&code)?;
        update_job(&app,job,"running","downloading",93,"Recebendo relatório e checkpoint; modelo atual ainda não foi alterado")?;
        let refreshed=get_runtime(&api_client()?,&google_access_token(&app,PROFILE_ID)?,&runtime.name)?.connection_info.ok_or("Conexão do runtime indisponível")?;
        let report_path=dataset.with_extension("report.json");let manifest_path=dataset.with_extension("model.json");
        download_result(&refreshed,&format!("{relative}/output/training_report.json"),&report_path)?;
        download_result(&refreshed,&format!("{relative}/output/model_artifact.json"),&manifest_path)?;
        let report:Value=serde_json::from_str(&fs::read_to_string(&report_path).map_err(|_|"Relatório indisponível")?).map_err(|_|"Relatório inválido")?;
        let manifest:Value=serde_json::from_str(&fs::read_to_string(&manifest_path).map_err(|_|"Manifesto indisponível")?).map_err(|_|"Manifesto inválido")?;
        let model=crate::training::model_path(&app,job)?;download_model(&refreshed,&format!("{relative}/output/model.pt"),&model,&manifest)?;
        if report["version"]!="behavetracker-keypoint-rcnn-v1" || report["snapshotId"]!=job{return Err("Relatório não corresponde a este treinamento".into());}
        open_database(&app)?.execute("UPDATE training_runs SET report_json=?2,model_path=?3,model_sha256=?4 WHERE job_id=?1",params![job,report.to_string(),model.to_string_lossy(),manifest["sha256"].as_str()]).map_err(|_|"Não foi possível registrar modelo")?;
        update_job(&app,job,"succeeded","completed",100,"Nova versão recebida · seleção para testes é manual; melhora não foi presumida")?;Ok(())
    })();
    if !result.as_ref().err().is_some_and(|e|e.preserve_session){if let Ok(token)=google_access_token(&app,PROFILE_ID){best_effort_delete_session(&token,&session);}}
    result.map_err(|e|e.message)
}
fn download_model(connection:&ConnectionInfo,remote:&str,path:&Path,manifest:&Value)->CommandResult<()> {
    if manifest["version"]!="behavetracker-keypoint-rcnn-v1"||manifest["filename"]!="model.pt"{return Err("Tipo de checkpoint não reconhecido".into());}
    let bytes=manifest["sizeBytes"].as_u64().filter(|n|*n>0&&*n<=500*1024*1024).ok_or("Tamanho do checkpoint inválido")?;
    let digest=manifest["sha256"].as_str().filter(|s|s.len()==64&&s.chars().all(|c|c.is_ascii_hexdigit())).ok_or("Hash do checkpoint inválido")?;
    let client=Client::builder().timeout(Duration::from_secs(600)).build().map_err(|_|"Download indisponível")?;
    let response=client.get(jupyter_url(connection,&format!("files/{remote}"))).header("X-Colab-Runtime-Proxy-Token",&connection.token).send().map_err(|_|"Falha ao baixar checkpoint")?;
    if !response.status().is_success(){return Err("Runtime recusou o checkpoint".into());}
    let temporary=path.with_extension("partial");
    let result=(||{let mut file=File::create(&temporary).map_err(|_|"Checkpoint local indisponível")?;
        if std::io::copy(&mut response.take(bytes+1),&mut file).map_err(|_|"Download interrompido")?!=bytes||crate::video::sha256(&temporary)?!=digest{return Err("Integridade do checkpoint não confirmada".into());}
        fs::rename(&temporary,path).map_err(|_|"Não foi possível publicar o checkpoint")?;Ok(())})();
    if result.is_err(){let _=fs::remove_file(temporary);}result
}

fn run_analysis(
    app: AppHandle,
    job_id: String,
    upload_id: String,
    workload: AnalysisWorkload,
    arena: Option<AnalysisArena>,
    diagnostic: Option<DiagnosticRange>,
    engine_id: String,
    model_bundle_id: Option<String>,
    fst: Option<FstConfiguration>,
) -> CommandResult<()> {
    let preparation_started = Instant::now();
    prepare_tables(&app)?;
    update_job(&app, &job_id, "running", "authorizing", 2, "Preparando o vídeo local sem reduzir resolução ou FPS")?;
    let upload_id = if let Some(range) = &diagnostic {
        let clip = crate::video::prepare_diagnostic_video(&app, &upload_id, &job_id, range.start_sec, range.end_sec, workload.width, workload.height)?;
        update_job(&app, &job_id, "running", "authorizing", 3, "Trecho curto preparado e pixels conferidos; o vídeo completo não será enviado")?;
        clip
    } else {
        let preparation = crate::video::prepare_staged_video(&app, &upload_id, workload.width, workload.height)?;
        update_job(&app, &job_id, "running", "authorizing", 3, &format!("{} · {} → {} bytes", preparation.message, preparation.original_bytes, preparation.upload_bytes))?;
        preparation.upload_id
    };
    let runtime_workload = AnalysisWorkload { duration_sec: diagnostic.as_ref().map_or(workload.duration_sec, |range| range.end_sec - range.start_sec), ..workload };
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
    let original_identity: Option<(String,String)> = if fst.is_some() {
        Some(open_database(&app)?.query_row(
            "SELECT sha256,original_filename FROM video_staging WHERE upload_id=COALESCE((SELECT original_upload_id FROM video_preparations WHERE prepared_upload_id=?1),?1) AND ready=1",
            [&upload_id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_|"Identidade do vídeo original indisponível")?)
    } else { None };
    record_timing(&app, &job_id, "preparo local do job", preparation_started);

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
    let (runtime, selection_message) = choose_or_create_runtime(
        &access_token,
        &runtime_workload,
        diagnostic.is_none() && engine_id == "superanimal_video_adapt_b_legacy",
        &mut |message| update_job(&app, &job_id, "running", "runtime", 10, message),
    )?;
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
        let models_started = Instant::now();
        let hybrid_models = if engine_id == "wistar_superanimal_hybrid_v1" {
            upload_hybrid_bundle(&app, &job_id, &connection, &session, &remote_directory, model_bundle_id.as_deref())?
        } else {
            None
        };
        if hybrid_models.is_some() { record_timing(&app, &job_id, "modelos", models_started); }
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
        let video_digest = sha256.as_deref().ok_or("SHA-256 do vídeo indisponível")?;
        let video_started = Instant::now();
        if reuse_cached_video(&app, &job_id, &session, &absolute_video, video_digest)? {
            update_job(&app, &job_id, "running", "uploading", 45,
                "Vídeo idêntico encontrado e conferido no runtime · reutilizando sem upload")?;
        } else {
            upload_video(&app, &job_id, &connection, Path::new(&local_path), &remote_video, size)?;
        }
        let custom_model=if fst.is_some() { None } else { ensure_remote_model(&app,&job_id,&session,&connection,&remote_directory,&absolute_directory)? };
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
            video_digest
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
        let _ = cache_verified_video(&app, &job_id, &session, &absolute_video, video_digest);
        record_timing(&app, &job_id, "vídeo até SHA-256 remoto", video_started);
        update_job(
            &app,
            &job_id,
            "running",
            "video_ready",
            50,
            "Vídeo recebido e validado · tamanho e SHA-256 conferem",
        )?;

        if fst.is_some() { prepare_fst_environment(&app, &job_id, &session, &absolute_directory)?; }
        else if custom_model.is_some(){prepare_custom_environment(&app,&job_id,&session,&absolute_directory)?;}else if engine_id == "wistar_superanimal_hybrid_v1" { prepare_hybrid_environment(&app, &job_id, &session, &absolute_directory)?; } else {prepare_environment(&app, &job_id, &session, &absolute_directory)?;}

        update_job(
            &app,
            &job_id,
            "running",
            "inference",
            65,
            if fst.is_some() { "FST · inferência HRNet-w32 por cilindro, presença visual e indicadores por animal" } else if engine_id == "wistar_superanimal_hybrid_v1" { "Executando pipeline · detector Wistar + HRNet adaptada · resultados experimentais" } else if custom_model.is_some(){"Executando modelo personalizado experimental · confiança anatômica não calibrada; revise as posições"} else if diagnostic.is_some() { "Diagnóstico curto · medindo detector e pose separadamente, sem recuperação ou adaptação" } else if arena
                .as_ref()
                .is_some_and(|geometry| geometry.rim_corners_px.is_some())
            {
                "Executando adaptação B do SuperAnimal com borda + chão e margem de 5%; paredes preservadas no recorte."
            } else {
                "Executando adaptação B do SuperAnimal no vídeo inteiro · projeto sem borda calibrada"
            },
        )?;
        let code = if let Some(fst) = &fst {
            fst_code(&absolute_video, &remote_output, fst, &workload, video_digest,
                &original_identity.as_ref().ok_or("Identidade do vídeo original ausente")?.0,
                &original_identity.as_ref().ok_or("Nome do vídeo original ausente")?.1, &job_id)
        } else if engine_id == "wistar_superanimal_hybrid_v1" {
            hybrid_code(
                &absolute_video,
                &remote_output,
                &format!("{remote_output}/canonical_pose.csv"),
                arena.as_ref(),
                hybrid_models.as_deref().ok_or("Modelo de análise não enviado")?,
                model_bundle_id.as_deref().ok_or("Modelo de análise não informado")?,
            )
        } else if let Some(model)=&custom_model {custom_code(&absolute_video,model,&remote_output,&remote_csv,arena.as_ref(),diagnostic.as_ref())} else if let Some(range) = &diagnostic {
            diagnostic_code(&absolute_video, &remote_output, &remote_csv, arena.as_ref(), range)
        } else {
            inference_code(&absolute_video, &remote_output, &remote_csv, arena.as_ref())
        };
        let inference_started = Instant::now();
        run_background_task(
            &app,
            &job_id,
            &session,
            &absolute_directory,
            "inference",
            &code,
        )?;
        record_timing(&app, &job_id, "inferência", inference_started);
        update_job(
            &app,
            &job_id,
            "running",
            "downloading",
            93,
            if fst.is_some() { "Baixando resultados FST por animal" } else { "Baixando o CSV canônico" },
        )?;
        let result_directory = app
            .path()
            .app_data_dir()
            .map_err(|_| "Não foi possível localizar os dados do aplicativo.".to_string())?
            .join("results");
        fs::create_dir_all(&result_directory)
            .map_err(|_| "Não foi possível preparar a pasta de resultados.".to_string())?;
        let result_path = result_directory.join(format!("{job_id}.{}", if fst.is_some() { "json" } else { "csv" }));
        let download_token = google_access_token(&app, PROFILE_ID)?;
        let refreshed_runtime = get_runtime(&api_client()?, &download_token, &runtime.name)?;
        let refreshed_connection = refreshed_runtime.connection_info.ok_or_else(|| {
            "O runtime não renovou os dados de conexão para o download.".to_string()
        })?;
        let download_started = Instant::now();
        if fst.is_some() {
            download_remote_artifact(&app,&job_id,&session,&refreshed_connection,
                &format!("{remote_output}/result.json"),&result_path)?;
        } else if engine_id == "wistar_superanimal_hybrid_v1" {
            download_remote_artifact(
                &app,
                &job_id,
                &session,
                &refreshed_connection,
                &format!("{remote_output}/canonical_pose.csv"),
                &result_path,
            )?;
        } else {
            download_result(
                &refreshed_connection,
                &format!("{remote_directory}/canonical_pose.csv"),
                &result_path,
            )?;
        }
        if let Some(fst) = &fst {
            let mut artifacts = vec!["presence.csv".to_string(),"presence_events.csv".to_string(),"presence_summary.csv".to_string(),"activity.csv".to_string(),"boxes.csv".to_string(),
                "activity_windows_1s.csv".to_string(),"activity_windows_3s.csv".to_string(),"review_shortlist.csv".to_string(),
                "run_manifest.json".to_string(),"execution_report.json".to_string()];
            for subject in &fst.subjects {
                artifacts.push(format!("{}_pose_raw.csv", subject.animal_id));
                artifacts.push(format!("{}_pose_raw.npz", subject.animal_id));
            }
            for artifact in artifacts {
                download_remote_artifact(&app,&job_id,&session,&refreshed_connection,
                    &format!("{remote_output}/{artifact}"),
                    &result_directory.join(format!("{job_id}-{artifact}")))?;
            }
        } else if engine_id == "wistar_superanimal_hybrid_v1" {
            for artifact in [
                "detections.csv",
                "pose_raw.csv",
                "pose_raw.h5",
                "pose_filtered.csv",
                "qc_by_frame.csv",
                "run_manifest.json",
            ] {
                let artifact_path = result_directory.join(format!("{job_id}-{artifact}"));
                download_remote_artifact(
                    &app,
                    &job_id,
                    &session,
                    &refreshed_connection,
                    &format!("{remote_output}/{artifact}"),
                    &artifact_path,
                )?;
            }
        }
        record_timing(&app, &job_id, "artefatos", download_started);
        open_database(&app)?
            .execute(
                "UPDATE colab_jobs SET result_path = ?2 WHERE job_id = ?1",
                params![&job_id, result_path.to_string_lossy().as_ref()],
            )
            .map_err(|_| "Não foi possível registrar o resultado do job.".to_string())?;
        if fst.is_some() {
            update_job(&app,&job_id,"running","downloading",96,"Recebendo vídeo FST com presença confirmada")?;
            let video_result=download_labeled_video(&refreshed_connection,&format!("{remote_directory}/output"),&result_directory,&job_id);
            let (video_path,video_error)=match video_result { Ok(path)=>(Some(path.to_string_lossy().into_owned()),None),Err(error)=>(None,Some(error)) };
            open_database(&app)?.execute("INSERT OR REPLACE INTO colab_job_artifacts (job_id,labeled_video_path,video_error) VALUES (?1,?2,?3)",
                params![&job_id,video_path,video_error]).map_err(|_|"Não foi possível registrar o vídeo FST")?;
            update_job(&app,&job_id,"succeeded","completed",100,
                if video_error.is_none(){"FST concluído · presença, poses e vídeo disponíveis"}else{"FST concluído · dados disponíveis; vídeo indisponível"})?;
            return Ok(());
        }
        if engine_id == "wistar_superanimal_hybrid_v1" {
            update_job(&app, &job_id, "running", "rendering", 94, "Poses disponíveis · gerando vídeo de inspeção")?;
            let render_started = Instant::now();
            let render = hybrid_render_code(&absolute_video, &remote_output, arena.as_ref());
            let video_result = match run_background_task(&app, &job_id, &session, &absolute_directory, "render", &render) {
                Ok(_) => {
                    (|| -> CommandResult<PathBuf> {
                        let token = google_access_token(&app, PROFILE_ID)?;
                        let refreshed = get_runtime(&api_client()?, &token, &runtime.name)
                            .map_err(|error| format!("{error:?}"))?;
                        let connection = refreshed.connection_info.ok_or("O runtime não renovou a conexão para receber o vídeo de inspeção")?;
                        download_labeled_video(&connection, &format!("{remote_directory}/output"), &result_directory, &job_id)
                    })()
                },
                Err(error) => Err(format!("Falha ao renderizar o vídeo de inspeção: {error:?}")),
            };
            let (video_path, video_error) = match video_result {
                Ok(path) => (Some(path.to_string_lossy().into_owned()), None),
                Err(error) => (None, Some(error)),
            };
            record_timing(&app, &job_id, "render e vídeo rotulado", render_started);
            open_database(&app)?.execute("INSERT OR REPLACE INTO colab_job_artifacts (job_id,labeled_video_path,video_error) VALUES (?1,?2,?3)",
                params![&job_id, video_path, video_error]).map_err(|_| "Não foi possível registrar o vídeo de inspeção")?;
            update_job(&app, &job_id, "succeeded", "completed", 100,
                if video_error.is_none() { "Rastreamento concluído · vídeo disponível" } else { "Poses disponíveis · vídeo indisponível; consulte o aviso" })?;
            return Ok(());
        }
        if diagnostic.is_some() {
            let report_path = result_directory.join(format!("{job_id}-diagnostic.json"));
            download_result(&refreshed_connection, &format!("{remote_directory}/output/diagnostic_report.json"), &report_path)?;
            let report: Value = serde_json::from_str(&fs::read_to_string(&report_path).map_err(|_| "Não foi possível ler o diagnóstico")?).map_err(|_| "Relatório diagnóstico inválido")?;
            if report["schemaVersion"].as_u64() != Some(1) { return Err("Versão de diagnóstico não reconhecida".into()); }
            open_database(&app)?.execute("UPDATE colab_job_diagnostics SET report_path=?2, raw_pose_path=?3 WHERE job_id=?1",
                params![&job_id, report_path.to_string_lossy().as_ref(), result_path.to_string_lossy().as_ref()]).map_err(|_| "Não foi possível registrar o diagnóstico")?;
            update_job(&app, &job_id, "succeeded", "completed", 100, "Diagnóstico disponível · revise caixas, pontos brutos e tempos; as métricas do experimento não foram alteradas")?;
            return Ok(());
        }
        download_result(&refreshed_connection, &format!("{remote_directory}/output/analysis_profile.json"), &result_directory.join(format!("{job_id}-profile.json")))?;
        update_job(&app, &job_id, "running", "rendering", 94, "Poses disponíveis · gerando o vídeo rotulado em tarefa separada")?;
        let render=if custom_model.is_some(){format!("import runpy\nfrom pathlib import Path\nrunpy.run_path(str(Path({remote_output:?})/'custom_model.py'))['render_custom']({remote_output:?})")}else{render_code(&remote_output)};
        run_background_task(&app, &job_id, &session, &absolute_directory, "render", &render)?;
        let video_token = google_access_token(&app, PROFILE_ID)?;
        let video_runtime = get_runtime(&api_client()?, &video_token, &runtime.name)?;
        let refreshed_connection = video_runtime.connection_info.ok_or("O runtime não renovou a conexão para receber o vídeo")?;
        update_job(&app, &job_id, "running", "downloading", 96, "Recebendo o vídeo rotulado pelo DeepLabCut")?;
        let video_result = download_labeled_video(&refreshed_connection, &format!("{remote_directory}/output"), &result_directory, &job_id);
        let (video_path, video_error) = match video_result {
            Ok(path) => (Some(path.to_string_lossy().into_owned()), None),
            Err(error) => (None, Some(error)),
        };
        open_database(&app)?.execute("INSERT OR REPLACE INTO colab_job_artifacts (job_id,labeled_video_path,video_error) VALUES (?1,?2,?3)",
            params![&job_id, video_path, video_error]).map_err(|_| "Não foi possível registrar o vídeo de resultado")?;
        update_job(
            &app,
            &job_id,
            "succeeded",
            "completed",
            100,
            if video_error.is_none() { "Rastreamento concluído · vídeo do modelo disponível" } else { "Poses recebidas · vídeo rotulado indisponível; consulte o aviso na Análise Completa" },
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
    if request.engine_id == "fst_superanimal_quadruped_v1" {
        if request.arena.is_some() || request.model_bundle_id.is_some() {
            return Err("FST não aceita arena nem bundle de Campo Aberto.".into());
        }
        request.fst.as_ref().ok_or("Configuração dos cilindros FST ausente.")?.validate(&request.workload)?;
    } else if request.engine_id == "wistar_superanimal_hybrid_v1" {
        if request.fst.is_some() { return Err("Configuração FST não corresponde ao motor selecionado.".into()); }
        let bundle_id = request.model_bundle_id.as_deref().ok_or("Modelo de análise não informado.")?;
        hybrid_bundle_paths(&app, bundle_id)?;
    } else if request.engine_id != "superanimal_video_adapt_b_legacy" || request.fst.is_some() {
        return Err("Motor de análise não reconhecido.".into());
    }
    if request.diagnostic.is_some() {
        return Err("O teste de rastreamento foi removido. Use Analisar no Colab para processar o vídeo completo.".into());
    }
    if let Some(arena) = &request.arena {
        arena.validate(&request.workload)?;
    }
    prepare_tables(&app)?;
    let connection = open_database(&app)?;
    let training_active:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM training_runs t JOIN colab_jobs j ON t.job_id=j.job_id WHERE j.status IN ('queued','running'))",[],|r|r.get(0)).map_err(|_|"Não foi possível consultar treinos ativos")?;
    if training_active{return Err("Aguarde o treinamento ativo antes de iniciar outra análise".into());}
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
        let active = get_job(&app, &active.job_id)?;
        if active.training || active.diagnostic != request.diagnostic { return Err("Já existe outra execução ativa neste experimento. Aguarde antes de iniciar este teste.".into()); }
        return Ok(active);
    }
    let job_id = new_uuid_v4();
    // A seleção do bundle pertence ao job e permanece no registro da geometria.
    let selected_model: Option<(String, PathBuf, String)> = None;
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
                serde_json::to_string(&if request.fst.is_some() { json!({
                    "protocol":"forced_swim", "engineId":&request.engine_id,
                    "analysisMethodVersion":"fst-0.1", "fst":&request.fst
                }) } else { json!({
                    "protocol":"open_field", "engineId": &request.engine_id,
                    "modelBundleId": &request.model_bundle_id,
                    "poseAdapterVersion":"superanimal-adapted-quality-1",
                    "trajectoryPostprocessVersion":"dlc-adapted-trajectory-c-1",
                    "recoveryVersion":"visual-recovery-2",
                    "arena": &request.arena
                }) })
                    .map_err(|_| "Não foi possível serializar a geometria.")?
            ],
        )
        .map_err(|_| "Não foi possível registrar a configuração deste job.".to_string())?;
    if let Some(range) = &request.diagnostic {
        transaction.execute("INSERT INTO colab_job_diagnostics(job_id,range_json) VALUES (?1,?2)", params![&job_id, serde_json::to_string(range).map_err(|_| "Intervalo inválido")?]).map_err(|_| "Não foi possível registrar o intervalo diagnóstico")?;
    }
    if let Some((model_id,_,_))=selected_model {transaction.execute("INSERT INTO custom_analysis_models VALUES (?1,?2)",params![&job_id,model_id]).map_err(|_|"Não foi possível registrar a versão do modelo")?;}
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
            request.diagnostic,
            request.engine_id,
            request.model_bundle_id,
            request.fst,
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
    let profile = app.path().app_data_dir().map_err(|_| "Pasta do app indisponível")?.join("results").join(format!("{job_id}-profile.json"));
    if profile.is_file() {
        let body = fs::read_to_string(profile).map_err(|_| "Perfil de tempos indisponível")?;
        sections.push(format!("=== Medições da análise (segundos) ===\n{body}\nrecoverySec inclui recuperação e conversão dos pontos; o vídeo é medido no log render."));
    }
    for task in ["setup", "inference", "render", "training"] {
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
    let (_status, result_path): (String, Option<String>) = open_database(&app)?
        .query_row(
            "SELECT status, result_path FROM colab_jobs WHERE job_id = ?1",
            params![&job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Job Colab não encontrado.".to_string())?;
    if result_path.is_none() {
        return Err("O resultado ainda não está disponível.".into());
    }
    fs::read_to_string(
        result_path.ok_or_else(|| "O job não possui resultado.".to_string())?,
    )
    .map_err(|_| "Não foi possível ler o resultado.".to_string())
}

#[derive(Serialize)]
struct FstArtifact { name: String, path: String }

#[tauri::command]
pub fn get_fst_job_artifacts(app: AppHandle, job_id: String) -> CommandResult<Vec<Value>> {
    validate_local_id(&job_id, "Job")?;
    prepare_tables(&app)?;
    let job = get_job(&app,&job_id)?;
    if job.protocol.as_deref() != Some("forced_swim") || !job.results_ready {
        return Err("Esta execução não possui artefatos FST disponíveis.".into());
    }
    let directory=app.path().app_data_dir().map_err(|_|"Pasta de resultados indisponível")?.join("results");
    let names=["result.json","presence.csv","presence_events.csv","presence_summary.csv","activity.csv","boxes.csv","activity_windows_1s.csv","activity_windows_3s.csv","review_shortlist.csv","run_manifest.json","execution_report.json",
        "animal_1_pose_raw.csv","animal_1_pose_raw.npz","animal_2_pose_raw.csv","animal_2_pose_raw.npz"];
    let mut result=Vec::new();
    for name in names {
        let path=if name=="result.json" { directory.join(format!("{job_id}.json")) }
            else {directory.join(format!("{job_id}-{name}"))};
        if path.is_file() {
            let artifact=FstArtifact{name:name.to_string(),path:path.to_string_lossy().into_owned()};
            result.push(serde_json::to_value(artifact).map_err(|_|"Artefato FST inválido")?);
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn get_fst_job_manifest(app: AppHandle, job_id: String) -> CommandResult<Value> {
    validate_local_id(&job_id, "Job")?;
    prepare_tables(&app)?;
    let job=get_job(&app,&job_id)?;
    if job.protocol.as_deref()!=Some("forced_swim") || !job.results_ready {
        return Err("Manifesto FST indisponível para esta execução.".into());
    }
    let path=app.path().app_data_dir().map_err(|_|"Pasta de resultados indisponível")?
        .join("results").join(format!("{job_id}-run_manifest.json"));
    let body=fs::read_to_string(path).map_err(|_|"Manifesto FST não encontrado")?;
    serde_json::from_str(&body).map_err(|_|"Manifesto FST inválido".into())
}

#[tauri::command]
pub fn get_colab_diagnostic_result(app: AppHandle, job_id: String) -> CommandResult<Value> {
    validate_local_id(&job_id, "Job")?;
    let job = get_job(&app, &job_id)?;
    if job.diagnostic.is_none() || job.status != "succeeded" { return Err("Diagnóstico ainda não disponível".into()); }
    let (report, poses): (Option<String>, Option<String>) = open_database(&app)?.query_row(
        "SELECT report_path,raw_pose_path FROM colab_job_diagnostics WHERE job_id=?1", [&job_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(|_| "Diagnóstico não encontrado")?;
    let directory = app.path().app_data_dir().map_err(|_| "Diretório do app indisponível")?.join("results");
    let expected_report = directory.join(format!("{job_id}-diagnostic.json"));
    let expected_poses = directory.join(format!("{job_id}.csv"));
    if report.as_deref().map(Path::new) != Some(expected_report.as_path()) || poses.as_deref().map(Path::new) != Some(expected_poses.as_path()) { return Err("Arquivos diagnósticos fora da pasta de resultados".into()); }
    let report: Value = serde_json::from_str(&fs::read_to_string(expected_report).map_err(|_| "Relatório diagnóstico indisponível")?).map_err(|_| "Relatório diagnóstico inválido")?;
    let csv = fs::read_to_string(expected_poses).map_err(|_| "Pontos brutos indisponíveis")?;
    let clip = directory.join(format!("{job_id}-clip.mp4"));
    Ok(json!({"report": report, "rawPoseCsv": csv, "clipPath": if clip.is_file() {Some(clip.to_string_lossy().into_owned())} else {None}}))
}

#[tauri::command]
pub fn get_colab_job_video(app: AppHandle, job_id: String) -> CommandResult<Value> {
    validate_local_id(&job_id, "Job")?;
    prepare_tables(&app)?;
    let connection = open_database(&app)?;
    let status: String = connection.query_row("SELECT status FROM colab_jobs WHERE job_id = ?1", [&job_id], |row| row.get(0)).map_err(|_| "Job não encontrado")?;
    let artifact: Option<(Option<String>, Option<String>)> = connection.query_row(
        "SELECT labeled_video_path,video_error FROM colab_job_artifacts WHERE job_id = ?1", [&job_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional().map_err(|_| "Não foi possível consultar o vídeo local")?;
    let absent = if status == "running" || status == "queued" { "O vídeo rotulado ainda está sendo preparado. As poses recebidas aparecem na Análise Completa." }
        else if status == "failed" { "A execução foi interrompida antes de disponibilizar o vídeo. As poses recebidas foram preservadas; consulte o diário." }
        else { "Esta execução não possui vídeo rotulado. Reprocesse no Colab para gerá-lo." };
    let (mut path, mut error) = artifact.unwrap_or((None, Some(absent.into())));
    if let Some(candidate) = &path {
        let expected = app.path().app_data_dir().map_err(|_| "Diretório do app indisponível")?.join("results").join(format!("{job_id}-dlc.mp4"));
        if Path::new(candidate) != expected || !expected.is_file() { path = None; error = Some("O vídeo de resultado não está mais no dispositivo. Reprocesse no Colab.".into()); }
    }
    Ok(json!({"jobId": job_id, "videoPath": path, "videoError": error}))
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
              WHERE experiment_id = ?1 AND NOT EXISTS (SELECT 1 FROM colab_job_diagnostics d WHERE d.job_id = colab_jobs.job_id)
                AND NOT EXISTS (SELECT 1 FROM training_runs t WHERE t.job_id = colab_jobs.job_id)
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
        enrich_job(&connection, job)?;
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
        inference_code, is_assignment_capacity_error, job_events, monitor_background_with,
        new_uuid_v4, parse_mcp_payload, preferred_runtime, preferred_spec,
        prepare_environment_with, read_sse_reply, runtime_attempt_specs,
        record_job_update, resolve_jupyter_workspace, safe_extension, supports_adaptation_gpu, workspace_gpu, download_labeled_video, AnalysisArena,
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
    fn fst_config_requires_distinct_full_cylinders_and_no_oft_geometry() {
        let workload = AnalysisWorkload { width: 800, height: 600, duration_sec: 20.0 };
        let config: super::FstConfiguration = serde_json::from_value(json!({
            "subjects":[{"animalId":"animal_1","subjectId":"R1"},{"animalId":"animal_2","subjectId":"R2"}],
            "tanks":[
                {"tankId":"tank_1","animalId":"animal_1","subjectId":"R1","roiPx":{"x":10,"y":0,"width":350,"height":560},"revision":1},
                {"tankId":"tank_2","animalId":"animal_2","subjectId":"R2","roiPx":{"x":430,"y":0,"width":350,"height":560},"revision":1}
            ]
        })).unwrap();
        config.validate(&workload).unwrap();
        let mut invalid = config.clone();
        invalid.tanks[1].roi_px.x = 300.0;
        assert!(invalid.validate(&workload).is_err());
        invalid = config.clone();
        invalid.tanks[0].roi_px.height = 200.0;
        assert!(invalid.validate(&workload).is_err());
        invalid = config.clone();
        invalid.subjects[1].subject_id = "R1".into();
        assert!(invalid.validate(&workload).is_err());
        let source = super::fst_code("video.mp4","/tmp/fst-output",&config,&workload,&"a".repeat(64),&"b".repeat(64),"fst.mp4","run-1");
        assert!(source.contains("forced_swim"));
        assert!(source.contains("detector_name=None"));
        assert!(!source.contains("wistar_df_v2"));
        use std::process::{Command, Stdio};
        let mut child = Command::new("python3").arg("-c").arg("import ast,sys; ast.parse(sys.stdin.read())")
            .stdin(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(source.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn hybrid_bundle_ids_keep_distinct_detector_hashes() {
        let v1 = super::hybrid_bundle_files("wistar_df_v1").unwrap();
        let v2 = super::hybrid_bundle_files("wistar_df_v2").unwrap();
        assert_ne!(v1[0].2, v2[0].2);
        assert_eq!(&v1[1..], &v2[1..]);
        assert!(super::hybrid_bundle_files("other").is_err());
    }

    #[test]
    fn release_model_script_uses_pinned_asset_and_expected_integrity() {
        let (name, size, digest) = super::hybrid_bundle_files("wistar_df_v2").unwrap()[0];
        let source = super::release_model_code(name, "/content/behavetracker/models/wistar_df_v2/best_detector.pth", size, digest);
        assert!(source.contains("/releases/download/models-wistar-df-v2-r1/best_detector.pth"));
        assert!(source.contains(digest));
        assert!(source.contains(&size.to_string()));
        assert_eq!(super::release_model_task(name), Some("model_detector"));
        assert_eq!(super::release_model_task("unknown"), None);
        use std::process::{Command, Stdio};
        let mut child = Command::new("python3").arg("-c").arg("import ast,sys; ast.parse(sys.stdin.read())")
            .stdin(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(source.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn generated_hybrid_scripts_select_bundle_and_parse() {
        use std::process::{Command, Stdio};
        for bundle in ["wistar_df_v1", "wistar_df_v2"] {
            let source = super::hybrid_code("video.mp4", "/tmp/output", "/tmp/output/canonical_pose.csv", None, "/tmp/models", bundle);
            assert!(source.contains(bundle));
            let mut child = Command::new("python3").arg("-c").arg("import ast,sys; ast.parse(sys.stdin.read())")
                .stdin(Stdio::piped()).spawn().unwrap();
            child.stdin.take().unwrap().write_all(source.as_bytes()).unwrap();
            assert!(child.wait().unwrap().success());
        }
        let render = super::hybrid_render_code("video.mp4", "/tmp/output", None);
        let mut child = Command::new("python3").arg("-c").arg("import ast,sys; ast.parse(sys.stdin.read())")
            .stdin(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(render.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn custom_checkpoint_is_published_only_after_integrity_validation(){
        let directory=std::env::temp_dir().join(format!("behavetracker-model-download-{}",new_uuid_v4()));std::fs::create_dir_all(&directory).unwrap();
        let expected=directory.join("expected.pt");std::fs::write(&expected,b"weights").unwrap();let digest=crate::video::sha256(&expected).unwrap();
        for valid in [true,false]{let listener=TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();let server=thread::spawn(move||{let(mut socket,_)=listener.accept().unwrap();let mut buffer=[0;4096];let _=socket.read(&mut buffer);socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nweights").unwrap();});
            let path=directory.join(if valid{"valid.pt"}else{"invalid.pt"});let manifest=json!({"version":"behavetracker-keypoint-rcnn-v1","filename":"model.pt","sizeBytes":7,"sha256":if valid{digest.clone()}else{"0".repeat(64)}});
            let result=super::download_model(&ConnectionInfo{url:format!("http://{address}"),token:"fake".into()},"model.pt",&path,&manifest);
            assert_eq!(result.is_ok(),valid);assert_eq!(path.exists(),valid);assert!(!path.with_extension("partial").exists());server.join().unwrap();}
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn diagnostic_range_must_be_short_finite_and_inside_the_video() {
        for (start,end,duration) in [(0.,60.,120.),(28./24.,120./24.,306.)] {
            assert!(super::DiagnosticRange { start_sec:start,end_sec:end }.validate(duration).is_ok());
        }
        for (start,end,duration) in [(0.,61.,120.),(-1.,10.,20.),(4.,4.,20.),(10.,9.,20.),(0.,21.,20.),(f64::NAN,10.,20.),(0.,f64::INFINITY,20.)] {
            assert!(super::DiagnosticRange { start_sec:start,end_sec:end }.validate(duration).is_err());
        }
    }

    #[test]
    fn generated_diagnostic_measures_detector_and_pose_without_touching_main_results() {
        use std::process::{Command,Stdio};
        let directory = std::env::temp_dir().join(format!("behavetracker-diagnostic-contract-{}",new_uuid_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let source = super::diagnostic_code("fake.mp4", directory.join("output").to_str().unwrap(), directory.join("canonical.csv").to_str().unwrap(), Some(&calibrated_arena()), &super::DiagnosticRange { start_sec:1.,end_sec:2. });
        let mut child = Command::new("python3").arg("-B").arg(concat!(env!("CARGO_MANIFEST_DIR"),"/python/check_diagnostic_contract.py")).arg(&directory).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(source.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("DIAGNOSTIC_CONTRACT_OK"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn generates_a_uuid_v4_request_id() {
        let value = new_uuid_v4();
        assert_eq!(value.len(), 36);
        assert_eq!(value.as_bytes()[14], b'4');
        assert!(matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }

    #[test]
    fn labeled_video_is_published_only_after_size_and_sha256_validation() {
        use sha2::{Digest, Sha256};
        for correct_digest in [true, false] {
            let video = b"fake mp4 bytes for transport validation";
            let sha = if correct_digest { format!("{:x}", Sha256::digest(video)) } else { "0".repeat(64) };
            let manifest = json!({"available":true,"filename":"dlc_labeled.mp4","source":"deeplabcut_raw_h5","sizeBytes":video.len(),"sha256":sha}).to_string();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                for index in 0..2 {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut request = [0; 4096];
                    let count = stream.read(&mut request).unwrap();
                    let request = String::from_utf8_lossy(&request[..count]);
                    assert!(!request.contains("/content/"));
                    let body = if index == 0 { assert!(request.contains("video_artifact.json")); manifest.as_bytes() }
                        else { assert!(request.contains("dlc_labeled.mp4")); video.as_slice() };
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                    stream.write_all(body).unwrap();
                }
            });
            let directory = std::env::temp_dir().join(format!("behavetracker-video-download-{}", new_uuid_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            let connection = ConnectionInfo { url: format!("http://{address}"), token: "test-proxy-token".into() };
            let result = download_labeled_video(&connection, "behavetracker/job/output", &directory, "test-job");
            if correct_digest { assert_eq!(std::fs::read(result.unwrap()).unwrap(), video); }
            else { assert!(result.is_err()); assert!(!directory.join("test-job-dlc.mp4").exists()); }
            assert!(!directory.join("test-job-dlc.mp4.partial").exists());
            server.join().unwrap();
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn artifact_stream_is_published_only_with_matching_sha256() {
        use sha2::{Digest, Sha256};
        let body = b"frame,x,y\n0,1,2\n";
        for correct_digest in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..count]).contains("/files/behavetracker/job/output/result.csv"));
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(body).unwrap();
            });
            let directory = std::env::temp_dir().join(format!("behavetracker-artifact-download-{}", new_uuid_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            let local = directory.join("result.csv");
            let connection = ConnectionInfo { url: format!("http://{address}"), token: "test-proxy-token".into() };
            let digest = if correct_digest { format!("{:x}", Sha256::digest(body)) } else { "0".repeat(64) };
            let result = super::publish_verified_artifact(&connection, "behavetracker/job/output/result.csv", &local, body.len() as u64, &digest);
            assert_eq!(result.is_ok(), correct_digest);
            assert_eq!(local.exists(), correct_digest);
            assert!(!directory.join("result.csv.partial").exists());
            server.join().unwrap();
            std::fs::remove_dir_all(directory).unwrap();
        }
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
            "NVIDIA_A100"
        );
        let large = AnalysisWorkload {
            width: 3840,
            height: 2160,
            duration_sec: 120.0,
        };
        assert_eq!(
            preferred_spec(specs(), &large).unwrap().key.accelerator,
            "NVIDIA_A100"
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
            "runtimes/a100"
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

    #[test]
    fn retries_only_a_second_eligible_gpu_class_after_assignment_exhaustion() {
        let workload = AnalysisWorkload::default();
        let mut a100_highmem = gpu_spec("NVIDIA_A100", true);
        a100_highmem.key.shape = "SHAPE_HIGHMEM".into();
        let options = runtime_attempt_specs(vec![
            gpu_spec("NVIDIA_T4", true),
            a100_highmem,
            gpu_spec("NVIDIA_L4", false),
            gpu_spec("NVIDIA_A100", true),
            gpu_spec("NVIDIA_H100", true),
        ], &workload);
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].key.accelerator, "NVIDIA_H100");
        assert_eq!(options[1].key.accelerator, "NVIDIA_A100");
        assert_eq!(options[1].key.shape, "SHAPE_STANDARD");

        assert!(is_assignment_capacity_error(&json!({
            "code": 8,
            "message": "CreateAssignment: generic::resource_exhausted: assignWithRetry: context deadline exceeded"
        })));
        assert!(!is_assignment_capacity_error(&json!({
            "code": 8,
            "message": "RESOURCE_EXHAUSTED: quota exceeded"
        })));
        assert!(!is_assignment_capacity_error(&json!({
            "code": 9,
            "message": "FAILED_PRECONDITION: subscription unavailable"
        })));
    }

    #[test]
    fn adaptation_only_accepts_the_gpu_classes_used_for_its_memory_budget() {
        let spec = |accelerator: &str| RuntimeSpecKey {
            variant: "VARIANT_GPU".into(), accelerator: accelerator.into(), shape: "SHAPE_STANDARD".into()
        };
        assert!(supports_adaptation_gpu(&spec("NVIDIA_A100")));
        assert!(supports_adaptation_gpu(&spec("NVIDIA_H100")));
        assert!(!supports_adaptation_gpu(&spec("NVIDIA_T4")));
        assert!(!supports_adaptation_gpu(&spec("NVIDIA_L4")));
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
            super::render_code("/content/output"),
            super::custom_environment_code(),
            super::custom_code("/content/video.mp4","/content/model.pt","/content/output","/content/poses.csv",None,None),
            background_launch_code("/content/behavetracker/job", "render", "print('render')"),
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
