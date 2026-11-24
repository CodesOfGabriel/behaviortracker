//! Preparação local do vídeo, com verificação de geometria, frames e tempos.
use crate::{
    colab::{new_uuid_v4, prepare_tables, staging_directory, validate_local_id},
    oauth::{open_database, CommandResult},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager};

const VIDEO_PREPARATION_PROGRESS_EVENT: &str = "video-preparation-progress";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoPreparationProgress<'a> {
    upload_id: &'a str,
    phase: &'a str,
    percent: Option<u8>,
    remaining_sec: Option<u64>,
}

pub(crate) fn emit_preparation_progress(app: &AppHandle, upload_id: &str, phase: &str,
    percent: Option<u8>, remaining_sec: Option<u64>) {
    let _ = app.emit(VIDEO_PREPARATION_PROGRESS_EVENT,
        VideoPreparationProgress { upload_id, phase, percent, remaining_sec });
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPreparation {
    pub upload_id: String,
    pub original_bytes: u64,
    pub upload_bytes: u64,
    pub status: String,
    pub message: String,
    pub policy_version: String,
    pub pixel_verified: bool,
    pub frame_count: Option<u64>,
    #[serde(default)]
    pub upload_width: Option<u32>,
    #[serde(default)]
    pub upload_height: Option<u32>,
    #[serde(default)]
    pub encoder: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub preparation_ms: Option<u64>,
    #[serde(default)]
    pub cache_hit: bool,
}

pub(crate) fn binary(name: &str) -> Option<PathBuf> {
    let bundled = std::env::current_exe().ok().and_then(|path| path.parent().map(|dir| dir.join(format!("behavetracker-{name}{}", std::env::consts::EXE_SUFFIX))));
    let candidates = std::env::var_os(format!("BEHAVETRACKER_{}", name.to_uppercase()))
        .map(PathBuf::from)
        .into_iter()
        .chain(bundled)
        .chain([
            PathBuf::from(name),
            PathBuf::from(format!("/opt/homebrew/bin/{name}")),
            PathBuf::from(format!("/usr/local/bin/{name}")),
        ]);
    candidates.into_iter().find(|path| {
        Command::new(path)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

fn probe(program: &Path, input: &Path) -> CommandResult<Value> {
    require_local_video(input)?;
    let result = Command::new(program)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(input)
        .output()
        .map_err(|_| "Não foi possível inspecionar o vídeo.".to_string())?;
    if !result.status.success() {
        return Err("O arquivo existe, mas o ffprobe não conseguiu ler seus metadados. Selecione novamente o vídeo original; ele pode estar incompleto ou em formato incompatível.".into());
    }
    serde_json::from_slice(&result.stdout).map_err(|_| "Metadados de vídeo ilegíveis.".into())
}

pub(crate) fn frame_at_time(input: &Path, time: f64) -> CommandResult<u64> {
    if !time.is_finite() || time < 0. || time > 172800. {
        return Err("Tempo de anotação inválido".into());
    }
    require_local_video(input)?;
    let ffprobe = binary("ffprobe").ok_or("ffprobe necessário para selecionar um frame por PTS")?;
    let mut child = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "compact=p=1:nk=0",
        ])
        .arg(input)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Não foi possível indexar os timestamps")?;
    let result = (|| {
        let reader = BufReader::new(child.stdout.take().ok_or("Índice de frames indisponível")?);
        let mut previous: Option<(u64, f64)> = None;
        let mut index = 0;
        for line in reader.lines() {
            let line = line.map_err(|_| "Leitura dos timestamps interrompida")?;
            if !line.starts_with("frame|") {
                continue;
            }
            let pts = line
                .split('|')
                .find_map(|field| {
                    field
                        .strip_prefix("best_effort_timestamp_time=")
                        .and_then(|s| s.parse::<f64>().ok())
                })
                .filter(|v| v.is_finite())
                .ok_or("Frame sem timestamp; anotação cancelada para não inventar sincronização")?;
            if pts >= time {
                return Ok(if let Some((old, old_pts)) = previous {
                    if time - old_pts <= pts - time {
                        old
                    } else {
                        index
                    }
                } else {
                    index
                });
            }
            previous = Some((index, pts));
            index += 1;
            if index > 2_000_000 {
                return Err("Vídeo excede limite de frames para anotação".into());
            }
        }
        match previous {
            Some((index, pts)) if time - pts <= 0.1 => Ok(index),
            _ => Err("O tempo solicitado está além dos frames do vídeo".into()),
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

pub(crate) fn extract_exact_frame(
    input: &Path,
    output: &Path,
    frame_index: u64,
) -> CommandResult<(u32, u32, f64)> {
    let ffmpeg = binary("ffmpeg").ok_or("FFmpeg é necessário para extrair o frame exato")?;
    let ffprobe = binary("ffprobe").ok_or("ffprobe é necessário para conferir a resolução")?;
    let info = probe(&ffprobe, input)?;
    let stream = &info["streams"][0];
    let width = stream["width"].as_u64().ok_or("Largura não informada")? as u32;
    let height = stream["height"].as_u64().ok_or("Altura não informada")? as u32;
    if width == 0 || height == 0 || width > 8192 || height > 8192 || frame_index > 2_000_000 {
        return Err("Frame fora dos limites de anotação".into());
    }
    if stream["side_data_list"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|v| v["rotation"].as_i64().is_some_and(|v| v != 0))
    }) {
        return Err(
            "Normalize a rotação antes de anotar para não alterar as coordenadas de treinamento"
                .into(),
        );
    }
    let result = Command::new(ffmpeg)
        .args(["-v", "info", "-nostdin", "-n", "-noautorotate", "-i"])
        .arg(input)
        .args([
            "-vf",
            &format!("select=eq(n\\,{frame_index}),showinfo"),
            "-frames:v",
            "1",
            "-fps_mode",
            "passthrough",
            "-c:v",
            "png",
        ])
        .arg(output)
        .output()
        .map_err(|_| "Não foi possível extrair o frame")?;
    if !result.status.success() || !output.is_file() {
        return Err("O vídeo não contém o frame solicitado ou a extração falhou".into());
    }
    let stderr = String::from_utf8_lossy(&result.stderr);
    let timestamp = stderr
        .lines()
        .filter(|line| line.contains("Parsed_showinfo") && line.contains("pts_time:"))
        .find_map(|line| {
            line.split("pts_time:")
                .nth(1)?
                .split_whitespace()
                .next()?
                .parse::<f64>()
                .ok()
        })
        .ok_or("PTS exato do frame não informado; anotação cancelada")?;
    if !timestamp.is_finite() || timestamp < 0.0 {
        return Err("PTS inválido no frame solicitado".into());
    }
    Ok((width, height, timestamp))
}

fn require_local_video(input: &Path) -> CommandResult<()> {
    let metadata = fs::metadata(input).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "O vídeo não está mais no cache deste dispositivo. Selecione novamente o vídeo original; seu experimento e suas correções foram preservados.".to_string()
        } else {
            "Não foi possível acessar o vídeo local. Confira as permissões e selecione novamente o arquivo original.".to_string()
        }
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(
            "O vídeo local está vazio ou incompleto. Selecione novamente o arquivo original."
                .into(),
        );
    }
    Ok(())
}

fn staged_video_available(
    connection: &rusqlite::Connection,
    experiment_id: &str,
    upload_id: &str,
) -> CommandResult<bool> {
    Ok(staged_video_size(connection, experiment_id, upload_id)?.is_some())
}

fn staged_video_size(
    connection: &rusqlite::Connection,
    experiment_id: &str,
    upload_id: &str,
) -> CommandResult<Option<u64>> {
    let staged: Option<(String,i64,i64)> = connection.query_row(
        "SELECT local_path,expected_size,ready FROM video_staging WHERE upload_id=?1 AND experiment_id=?2",
        params![upload_id,experiment_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()
        .map_err(|_| "Não foi possível consultar o vídeo preparado")?;
    Ok(staged.and_then(|(path, size, ready)| {
        (size > 0
            && ready == 1
            && fs::metadata(path).is_ok_and(|info| info.is_file() && info.len() == size as u64))
            .then_some(size as u64)
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedAnalysisVideo {
    original_upload_id: Option<String>,
    original_sha256: String,
    preparation: Option<VideoPreparation>,
}

fn find_staged_analysis_video(
    connection: &rusqlite::Connection,
    experiment_id: &str,
    filename: &str,
    size: u64,
    expected_sha256: Option<&str>,
    preferred_upload_id: Option<&str>,
    adaptive: bool,
) -> CommandResult<Option<StagedAnalysisVideo>> {
    let size_sql = i64::try_from(size).map_err(|_| "Tamanho de vídeo inválido")?;
    let mut statement = connection.prepare(
        "SELECT s.upload_id, s.sha256, p.prepared_upload_id, p.report_json
           FROM video_staging s LEFT JOIN video_preparations p ON p.original_upload_id=s.upload_id
          WHERE s.experiment_id=?1 AND s.original_filename=?2 AND s.expected_size=?3
            AND s.ready=1 AND s.sha256 IS NOT NULL AND s.sha256<>''
            AND (?4 IS NULL OR s.sha256=?4)
            AND NOT EXISTS (SELECT 1 FROM video_preparations derived
              WHERE derived.prepared_upload_id=s.upload_id AND derived.original_upload_id<>s.upload_id)
          ORDER BY CASE WHEN s.upload_id=?5 OR p.prepared_upload_id=?5 THEN 0 ELSE 1 END,
                   s.created_at DESC, s.rowid DESC",
    ).map_err(|_| "Não foi possível consultar o cache do projeto")?;
    let rows = statement.query_map(params![experiment_id, filename, size_sql, expected_sha256, preferred_upload_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?)),
    ).map_err(|_| "Não foi possível localizar a mídia do projeto")?
        .collect::<Result<Vec<_>, _>>().map_err(|_| "O registro da mídia do projeto é inválido")?;
    let Some((first_id, first_sha256, first_prepared, _)) = rows.first() else { return Ok(None); };
    let explicitly_linked = preferred_upload_id.is_some_and(|id| first_id == id || first_prepared.as_deref() == Some(id));
    if !explicitly_linked && rows.iter().any(|(_, digest, _, _)| digest != first_sha256) {
        return Ok(None);
    }
    let mut available_original = None;
    for (id, digest, prepared_id, json) in &rows {
        if digest != first_sha256 { continue; }
        if available_original.is_none() && staged_video_available(connection, experiment_id, id)? {
            available_original = Some(id.clone());
        }
        if let Some(report) = json.as_ref().and_then(|value| serde_json::from_str::<VideoPreparation>(value).ok()) {
            if prepared_id.as_deref() == Some(report.upload_id.as_str())
                && report.original_bytes == size
                && compatible_preparation(&report, adaptive)
                && staged_video_size(connection, experiment_id, &report.upload_id)? == Some(report.upload_bytes)
            {
                return Ok(Some(StagedAnalysisVideo {
                    original_upload_id: available_original,
                    original_sha256: first_sha256.clone(),
                    preparation: Some(report),
                }));
            }
        }
    }
    Ok(available_original.map(|id| StagedAnalysisVideo {
        original_upload_id: Some(id),
        original_sha256: first_sha256.clone(),
        preparation: None,
    }))
}

#[tauri::command]
pub async fn get_staged_analysis_video(
    app: AppHandle,
    experiment_id: String,
    filename: String,
    size: u64,
    expected_sha256: Option<String>,
    preferred_upload_id: Option<String>,
    adaptive: bool,
) -> CommandResult<Option<StagedAnalysisVideo>> {
    validate_local_id(&experiment_id, "Experimento")?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_database(&app)?;
        find_staged_analysis_video(&connection, &experiment_id, &filename, size,
            expected_sha256.as_deref(), preferred_upload_id.as_deref(), adaptive)
    }).await.map_err(|_| "Consulta ao vídeo local interrompida".to_string())?
}

#[tauri::command]
pub fn check_video_staging(
    app: AppHandle,
    experiment_id: String,
    upload_id: String,
    source: Option<bool>,
) -> CommandResult<bool> {
    validate_local_id(&experiment_id, "Experimento")?;
    validate_local_id(&upload_id, "Upload")?;
    prepare_tables(&app)?;
    let connection = open_database(&app)?;
    if !staged_video_available(&connection, &experiment_id, &upload_id)? {
        return Ok(false);
    }
    if source.unwrap_or(false) {
        let source_id = original_upload_id(&connection, &upload_id)?;
        return staged_video_available(&connection, &experiment_id, &source_id);
    }
    Ok(true)
}

pub(crate) fn original_upload_id(connection: &rusqlite::Connection, upload_id: &str) -> CommandResult<String> {
    Ok(connection.query_row(
        "SELECT original_upload_id FROM video_preparations WHERE prepared_upload_id=?1 LIMIT 1",
        [upload_id], |row| row.get(0),
    ).optional().map_err(|_| "Não foi possível identificar o vídeo original")?
        .unwrap_or_else(|| upload_id.into()))
}

// Decodifica em streaming: somente hashes/tempos ficam na memória, não os pixels.
fn fingerprints(program: &Path, input: &Path) -> CommandResult<Vec<(i64, String)>> {
    fingerprints_window(program, input, None)
}

fn fingerprints_with_progress(program: &Path, input: &Path, on_frame: &mut impl FnMut(usize))
    -> CommandResult<Vec<(i64, String)>> {
    fingerprints_window_with_progress(program, input, None, on_frame)
}

fn fingerprints_window(
    program: &Path,
    input: &Path,
    window: Option<(f64, f64)>,
) -> CommandResult<Vec<(i64, String)>> {
    fingerprints_window_with_progress(program, input, window, &mut |_| {})
}

fn fingerprints_window_with_progress(program: &Path, input: &Path, window: Option<(f64, f64)>,
    on_frame: &mut impl FnMut(usize)) -> CommandResult<Vec<(i64, String)>> {
    let mut command = Command::new(program);
    command.args(["-v", "error", "-noautorotate"]);
    if let Some((start, _)) = window {
        command.args(["-ss", &start.to_string()]);
    }
    if let Some((start, end)) = window {
        command.args(["-t", &(end - start).to_string()]);
    }
    command.arg("-i").arg(input);
    let filter = if let Some((start, end)) = window {
        format!(
            "trim=start=0:end={},settb=1/1000000,setpts=PTS-STARTPTS",
            end - start
        )
    } else {
        "settb=1/1000000,setpts=PTS-STARTPTS".into()
    };
    let mut child = command
        .args([
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            &filter,
            "-enc_time_base",
            "1/1000000",
            "-fps_mode",
            "passthrough",
            "-f",
            "framemd5",
            "-hash",
            "sha256",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Falha ao validar frames.".to_string())?;
    let result = (|| {
        let mut frames = Vec::new();
        for line in BufReader::new(child.stdout.take().ok_or("Validação sem saída")?).lines() {
            let line = line.map_err(|_| "Falha ao ler a validação de frames")?;
            if line.starts_with('#') || line.trim().is_empty() {
                continue;
            }
            let fields: Vec<_> = line.split(',').map(str::trim).collect();
            if fields.len() != 6 || fields[5].len() != 64 {
                return Err("Hash de frame inválido".into());
            }
            frames.push((
                fields[2].parse::<i64>().map_err(|_| "Timestamp inválido")?,
                fields[5].to_string(),
            ));
            if frames.len() % 30 == 0 { on_frame(frames.len()); }
            if frames.len() > 2_000_000 {
                return Err("Vídeo excede o limite local de validação de frames".into());
            }
        }
        if frames.is_empty() {
            return Err("Vídeo sem frames decodificáveis".into());
        }
        on_frame(frames.len());
        Ok(frames)
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|_| "A validação de frames foi interrompida".to_string())?;
    if !status.success() {
        return Err("A decodificação completa do vídeo falhou".into());
    }
    result
}

fn identical_frames(first: &[(i64, String)], second: &[(i64, String)]) -> bool {
    !first.is_empty()
        && first.len() == second.len()
        && first
            .iter()
            .zip(second)
            .all(|(a, b)| a.1 == b.1 && (i128::from(a.0) - i128::from(b.0)).abs() <= 1000)
}

fn identical_timing(first: &[(i64, String)], second: &[(i64, String)]) -> bool {
    !first.is_empty() && first.len() == second.len() && first.iter().zip(second)
        .all(|(a, b)| (i128::from(a.0) - i128::from(b.0)).abs() <= 1000)
}

fn frame_timestamps_with_progress(
    ffprobe: &Path,
    input: &Path,
    on_frame: &mut impl FnMut(usize),
) -> CommandResult<Vec<f64>> {
    let mut child = Command::new(ffprobe)
        .args([
            "-v", "error", "-select_streams", "v:0", "-show_frames",
            "-show_entries", "frame=best_effort_timestamp_time",
            "-of", "compact=p=0:nk=1",
        ])
        .arg(input)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Não foi possível verificar os timestamps dos frames".to_string())?;
    let result = read_frame_timestamps(&mut child, on_frame);
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|_| "Não foi possível concluir a leitura dos timestamps")?;
    let timestamps = result?;
    if !status.success() {
        return Err("O ffprobe não conseguiu ler os timestamps dos frames".into());
    }
    on_frame(timestamps.len());
    Ok(timestamps)
}

fn read_frame_timestamps(child: &mut Child, on_frame: &mut impl FnMut(usize)) -> CommandResult<Vec<f64>> {
    let stdout = child.stdout.take().ok_or("Saída do ffprobe indisponível")?;
    let mut timestamps = Vec::new();
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|_| "Falha ao ler os timestamps dos frames")?;
        if line.trim().is_empty() {
            continue;
        }
        let timestamp = line
            .split('|')
            .next()
            .unwrap_or(&line)
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .ok_or("Frame sem timestamp válido")?;
        timestamps.push(timestamp);
        if timestamps.len() % 30 == 0 {
            on_frame(timestamps.len());
        }
        if timestamps.len() > 2_000_000 {
            return Err("Vídeo excede o limite local de validação de frames".into());
        }
    }
    if timestamps.is_empty() {
        return Err("Vídeo sem frames com timestamps decodificáveis".into());
    }
    Ok(timestamps)
}

fn timing_diagnostics(first: &[f64], second: &[f64]) -> (bool, usize, f64) {
    let max_delta = first
        .iter()
        .zip(second)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
    (
        !first.is_empty()
            && first.len() == second.len()
            && first
                .iter()
                .zip(second)
                .all(|(a, b)| (a - b).abs() <= 0.001),
        first.len(),
        max_delta,
    )
}

fn upload_dimensions(width: u32, height: u32) -> (u32, u32) {
    let (max_width, max_height) = if width >= height { (1920, 1080) } else { (1080, 1920) };
    if width <= max_width && height <= max_height { return ((width / 2 * 2).max(2), (height / 2 * 2).max(2)); }
    let scale = (max_width as f64 / width as f64).min(max_height as f64 / height as f64);
    let even = |dimension: u32| ((dimension as f64 * scale).floor() as u32 / 2 * 2).max(2);
    (even(width), even(height))
}

fn source_duration(info: &Value) -> Option<f64> {
    info.pointer("/streams/0/duration").and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| info.pointer("/format/duration").and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok()))
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn source_frame_estimate(info: &Value) -> Option<usize> {
    if let Some(frames) = info.pointer("/streams/0/nb_frames").and_then(Value::as_str)
        .and_then(|value| value.parse::<usize>().ok()).filter(|value| *value > 0) {
        return Some(frames);
    }
    let (num, den) = info.pointer("/streams/0/avg_frame_rate").and_then(Value::as_str)?
        .split_once('/')?;
    let fps = num.parse::<f64>().ok()? / den.parse::<f64>().ok()?;
    let frames = (source_duration(info)? * fps).round();
    if frames.is_finite() && (1.0..=2_000_000.0).contains(&frames) { Some(frames as usize) }
    else { None }
}

fn frame_progress(expected: Option<usize>, start: u8, end: u8,
    progress: &mut impl FnMut(&str, Option<u8>, Option<u64>)) -> impl FnMut(usize) + '_ {
    let mut last_percent = start;
    move |frames| {
        if let Some(expected) = expected.filter(|value| *value > 0) {
            let fraction = (frames as f64 / expected as f64).clamp(0.0, 1.0);
            let percent = start + ((end - start) as f64 * fraction).floor() as u8;
            let percent = percent.min(end - 1);
            if percent > last_percent {
                last_percent = percent;
                progress("verifying", Some(percent), None);
            }
        }
    }
}

fn run_encode_with_progress(mut child: Child, output: &Path, max_bytes: u64,
    duration: Option<f64>, progress: &mut impl FnMut(&str, Option<u8>, Option<u64>))
    -> CommandResult<()> {
    let started = Instant::now();
    let mut position_us = None;
    let read_result: CommandResult<()> = (|| {
        for line in BufReader::new(child.stdout.take().ok_or("Progresso do FFmpeg indisponível")?).lines() {
            let line = line.map_err(|_| "Falha ao acompanhar a compactação")?;
            if let Some(value) = line.strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms=")) {
                position_us = value.parse::<u64>().ok();
            }
            if line == "progress=continue" || line == "progress=end" {
                if fs::metadata(output).is_ok_and(|file| file.len() > max_bytes) {
                    return Err("A cópia preparada ficaria maior que o original".into());
                }
                if let (Some(us), Some(duration)) = (position_us, duration) {
                    let fraction = (us as f64 / 1_000_000.0 / duration).clamp(0.0, 1.0);
                    let percent = ((fraction * 80.0).floor() as u8).min(79);
                    let remaining = if fraction > 0.02 && started.elapsed().as_secs() >= 3 {
                        Some(((started.elapsed().as_secs_f64() / fraction) * (1.0 - fraction)).ceil() as u64)
                    } else { None };
                    progress("encoding", Some(percent), remaining);
                }
            }
        }
        Ok(())
    })();
    if read_result.is_err() { let _ = child.kill(); }
    let status = child.wait().map_err(|_| "Falha ao concluir a compactação")?;
    read_result?;
    if !status.success() { return Err("O FFmpeg não conseguiu preparar este vídeo".into()); }
    Ok(())
}

#[cfg(test)]
fn optimize_quality(input: &Path, output: &Path, ffmpeg: &Path, ffprobe: &Path, width: u32, height: u32) -> CommandResult<(u64, u32, u32)> {
    optimize_quality_with_progress(input, output, ffmpeg, ffprobe, width, height, &mut |_, _, _| {})
}

fn optimize_quality_with_progress(input: &Path, output: &Path, ffmpeg: &Path, ffprobe: &Path,
    width: u32, height: u32, progress: &mut impl FnMut(&str, Option<u8>, Option<u64>))
    -> CommandResult<(u64, u32, u32)> {
    progress("checking", None, None);
    let info = probe(ffprobe, input)?;
    let stream = &info["streams"][0];
    let (source_width, source_height) = display_dimensions(stream)?;
    if (source_width, source_height) != (width.into(), height.into()) {
        return Err("Resolução diferente da calibração: original mantido".into());
    }
    let (out_width, out_height) = upload_dimensions(width, height);
    let size = fs::metadata(input).map_err(|_| "Vídeo indisponível")?.len();
    let scale = format!("scale={out_width}:{out_height}:flags=lanczos");
    progress("encoding", Some(0), None);
    let child = Command::new(ffmpeg)
        .args(["-v", "error", "-nostdin", "-n", "-stats_period", "0.5", "-progress", "pipe:1",
            "-i"]).arg(input)
        .args(["-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-vf", &scale,
            "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-threads", "2", "-fps_mode", "passthrough", "-enc_time_base:v", "1/1000000",
            "-video_track_timescale", "1000000", "-movflags", "+faststart"])
        .arg(output).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
        .map_err(|_| "Não foi possível iniciar o FFmpeg".to_string())?;
    run_encode_with_progress(child, output, size, source_duration(&info), progress)?;
    if fs::metadata(output).map_err(|_| "Cópia indisponível")?.len() >= size {
        return Err("Compactação não reduziu o tamanho; original mantido".into());
    }
    let encoded = probe(ffprobe, output)?;
    if encoded["streams"][0]["width"].as_u64() != Some(out_width.into())
        || encoded["streams"][0]["height"].as_u64() != Some(out_height.into())
        || display_rotation(&encoded["streams"][0]) != 0.0 {
        return Err("Resolução da cópia inesperada; original mantido".into());
    }
    let expected = source_frame_estimate(&info);
    progress("verifying", Some(80), None);
    let original = frame_timestamps_with_progress(ffprobe, input,
        &mut frame_progress(expected, 80, 90, progress))?;
    progress("verifying", Some(90), None);
    let compressed = frame_timestamps_with_progress(ffprobe, output,
        &mut frame_progress(Some(original.len()), 90, 99, progress))?;
    progress("verifying", Some(99), None);
    let (timing_matches, frame_count, max_delta) = timing_diagnostics(&original, &compressed);
    if !timing_matches {
        return Err(format!(
            "Validação rejeitada: frames antes={}; depois={}; divergência máxima de timestamps={:.6} s; motivo=quantidade ou timestamps divergentes (tolerância=0.001 s); original mantido",
            original.len(), compressed.len(), max_delta
        ));
    }
    Ok((frame_count as u64, out_width, out_height))
}

fn display_rotation(stream: &Value) -> f64 {
    stream["side_data_list"].as_array().into_iter().flatten()
        .find_map(|item| item["rotation"].as_f64())
        .unwrap_or(0.0)
        .rem_euclid(360.0)
}

fn display_dimensions(stream: &Value) -> CommandResult<(u64, u64)> {
    let width = stream["width"].as_u64().ok_or("Largura do vídeo indisponível")?;
    let height = stream["height"].as_u64().ok_or("Altura do vídeo indisponível")?;
    match display_rotation(stream) {
        0.0 | 180.0 => Ok((width, height)),
        90.0 | 270.0 => Ok((height, width)),
        _ => Err("Rotação incompatível com a calibração: original mantido".into()),
    }
}

pub(crate) fn sha256(path: &Path) -> CommandResult<String> {
    let mut file =
        fs::File::open(path).map_err(|_| "Não foi possível abrir o vídeo".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Não foi possível validar o vídeo".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn encode(
    program: &Path,
    input: &Path,
    output: &Path,
    pixel_format: &str,
    original_bytes: u64,
    duration: Option<f64>,
    progress: &mut impl FnMut(&str, Option<u8>, Option<u64>),
) -> CommandResult<()> {
    progress("encoding", Some(0), None);
    let child = Command::new(program)
        .args(["-v", "error", "-nostdin", "-n", "-stats_period", "0.5", "-progress", "pipe:1",
            "-noautorotate", "-i"])
        .arg(input)
        .args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "0",
            "-pix_fmt",
            pixel_format,
            "-threads",
            "2",
            "-fps_mode",
            "passthrough",
            "-movflags",
            "+faststart",
        ])
        .arg(output)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Não foi possível iniciar o FFmpeg".to_string())?;
    run_encode_with_progress(child, output, original_bytes, duration, progress)
}

#[cfg(test)]
fn optimize(
    input: &Path,
    output: &Path,
    ffmpeg: &Path,
    ffprobe: &Path,
    width: u32,
    height: u32,
) -> CommandResult<u64> {
    optimize_with_progress(input, output, ffmpeg, ffprobe, width, height, &mut |_, _, _| {})
}

fn optimize_with_progress(input: &Path, output: &Path, ffmpeg: &Path, ffprobe: &Path,
    width: u32, height: u32, progress: &mut impl FnMut(&str, Option<u8>, Option<u64>))
    -> CommandResult<u64> {
    progress("checking", None, None);
    let info = probe(ffprobe, input)?;
    let stream = info
        .pointer("/streams/0")
        .ok_or("Vídeo sem trilha visual")?;
    if stream["width"].as_u64() != Some(u64::from(width))
        || stream["height"].as_u64() != Some(u64::from(height))
    {
        return Err("Resolução diferente da calibração: original mantido".into());
    }
    if stream["side_data_list"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["rotation"].as_i64().is_some_and(|v| v != 0))
    }) || stream
        .pointer("/tags/rotate")
        .and_then(Value::as_str)
        .is_some_and(|v| v != "0")
    {
        return Err("Vídeo com rotação: original mantido para preservar a geometria".into());
    }
    let pixel_format = stream["pix_fmt"]
        .as_str()
        .ok_or("Formato de pixel não informado")?;
    if ![
        "yuv420p",
        "yuv422p",
        "yuv444p",
        "yuv420p10le",
        "yuv422p10le",
        "yuv444p10le",
    ]
    .contains(&pixel_format)
    {
        return Err("Formato de pixel preservado: compactação conservadora indisponível".into());
    }
    let size = fs::metadata(input).map_err(|_| "Vídeo indisponível")?.len();
    encode(ffmpeg, input, output, pixel_format, size, source_duration(&info), progress)?;
    if fs::metadata(output)
        .map_err(|_| "Cópia indisponível")?
        .len()
        >= size
    {
        return Err("Compactação não reduziu o tamanho; original mantido".into());
    }
    let encoded = probe(ffprobe, output)?;
    for field in [
        "width",
        "height",
        "pix_fmt",
        "sample_aspect_ratio",
        "color_range",
        "color_space",
        "color_transfer",
        "color_primaries",
    ] {
        if stream[field] != encoded["streams"][0][field] {
            return Err(format!("Metadado visual {field} mudou; original mantido"));
        }
    }
    let expected = source_frame_estimate(&info);
    progress("verifying", Some(80), None);
    let original = fingerprints_with_progress(ffmpeg, input,
        &mut frame_progress(expected, 80, 90, progress))?;
    progress("verifying", Some(90), None);
    let compressed = fingerprints_with_progress(ffmpeg, output,
        &mut frame_progress(Some(original.len()), 90, 99, progress))?;
    progress("verifying", Some(99), None);
    if !identical_frames(&original, &compressed) {
        return Err("Frames ou timestamps divergiram; original mantido".into());
    }
    Ok(original.len() as u64)
}

const QUALITY_POLICY: &str = "quality-upload-4";
pub(crate) const QUALITY_THRESHOLD_BYTES: u64 = 100_000_000;
const FST_POLICY: &str = "fst-adaptive-2";

fn compatible_preparation(report: &VideoPreparation, adaptive: bool) -> bool {
    let version = report.policy_version.as_str();
    if adaptive {
        return matches!(version, FST_POLICY | "fst-adaptive-1");
    }
    matches!(version, QUALITY_POLICY | "lossless-upload-1")
        || (matches!(version, "quality-upload-2" | "quality-upload-3")
            && report.status == "optimized"
            && matches!((report.upload_width, report.upload_height), (Some(w), Some(h)) if w > 0 && h > 0))
}

#[derive(Debug)]
struct AdaptivePreparation {
    method: &'static str,
    encoder: Option<&'static str>,
    frame_count: Option<u64>,
}

fn valid_adaptive_source(info: &Value, width: u32, height: u32) -> CommandResult<()> {
    let stream = info.pointer("/streams/0").ok_or("Vídeo sem trilha visual")?;
    if stream["width"].as_u64() != Some(u64::from(width))
        || stream["height"].as_u64() != Some(u64::from(height))
        || width == 0 || height == 0 {
        return Err("Resolução diferente da calibração; selecione novamente o vídeo original".into());
    }
    if stream["side_data_list"].as_array().is_some_and(|items| items.iter().any(|item| {
        item["rotation"].as_f64().is_some_and(|value| value.abs() > 0.01)
    })) || stream.pointer("/tags/rotate").and_then(Value::as_str)
        .is_some_and(|value| value != "0") {
        return Err("Vídeo com rotação: normalize a orientação antes de marcar os cilindros".into());
    }
    let duration = stream["duration"].as_str()
        .or_else(|| info.pointer("/format/duration").and_then(Value::as_str))
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0);
    if duration.is_none() { return Err("Duração do vídeo indisponível ou inválida".into()); }
    let start = stream["start_time"].as_str().and_then(|value| value.parse::<f64>().ok())
        .ok_or("Timestamp inicial do vídeo indisponível")?;
    if !start.is_finite() || start.abs() > 0.05 {
        return Err("O vídeo começa fora do tempo zero; normalize os timestamps antes da análise".into());
    }
    let valid_ratio = |field: &str| stream[field].as_str().and_then(|value| {
        let (numerator, denominator) = value.split_once('/')?;
        Some((numerator.parse::<u64>().ok()?, denominator.parse::<u64>().ok()?))
    }).is_some_and(|(numerator, denominator)| numerator > 0 && denominator > 0);
    if !valid_ratio("avg_frame_rate") || !valid_ratio("time_base") {
        return Err("Taxa de frames ou base temporal inválida".into());
    }
    Ok(())
}

fn sample_decode(ffmpeg: &Path, input: &Path, duration: f64) -> CommandResult<()> {
    for position in [0.0, duration * 0.9] {
        let result = Command::new(ffmpeg).args(["-v", "error", "-nostdin", "-noautorotate",
            "-ss", &position.to_string(), "-i"]).arg(input)
            .args(["-map", "0:v:0", "-frames:v", "1", "-f", "framemd5", "-"])
            .output()
            .map_err(|_| "Não foi possível conferir a decodificação do vídeo")?;
        if !result.status.success() || !String::from_utf8_lossy(&result.stdout)
            .lines().any(|line| !line.starts_with('#') && !line.trim().is_empty()) {
            return Err("O vídeo falhou na decodificação de amostra".into());
        }
    }
    Ok(())
}

fn packet_timestamps(ffprobe: &Path, input: &Path) -> CommandResult<Vec<f64>> {
    let mut child = Command::new(ffprobe)
        .args(["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries",
            "packet=pts_time", "-of", "compact=p=1:nk=0"])
        .arg(input).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
        .map_err(|_| "Não foi possível verificar os timestamps do vídeo")?;
    let result = (|| {
        let mut timestamps = Vec::new();
        for line in BufReader::new(child.stdout.take().ok_or("Timestamps indisponíveis")?).lines() {
            let line = line.map_err(|_| "Leitura dos timestamps interrompida")?;
            if !line.starts_with("packet|") { continue; }
            let pts = line.split('|').find_map(|field| field.strip_prefix("pts_time="))
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite())
                .ok_or("Pacote de vídeo sem PTS válido")?;
            timestamps.push(pts);
            if timestamps.len() > 2_000_000 { return Err("Vídeo excede o limite de pacotes".into()); }
        }
        if timestamps.is_empty() { return Err("Vídeo sem pacotes de imagem".into()); }
        Ok(timestamps)
    })();
    if result.is_err() { let _ = child.kill(); }
    if !child.wait().map_err(|_| "Verificação de timestamps interrompida")?.success() {
        return Err("ffprobe não conseguiu ler os pacotes do vídeo".into());
    }
    result
}

fn same_packet_timing(first: &[f64], second: &[f64]) -> bool {
    first.len() == second.len() && first.iter().zip(second)
        .all(|(a, b)| (a - b).abs() <= 0.001)
}

fn same_presentation_timing(first: &[f64], second: &[f64]) -> bool {
    if first.len() != second.len() { return false; }
    let mut first = first.to_vec();
    let mut second = second.to_vec();
    first.sort_by(f64::total_cmp);
    second.sort_by(f64::total_cmp);
    same_packet_timing(&first, &second)
}

#[cfg(test)]
fn adaptive_prepare(input: &Path, output: &Path, ffmpeg: &Path, ffprobe: &Path,
    width: u32, height: u32) -> CommandResult<AdaptivePreparation> {
    adaptive_prepare_with_progress(input, output, ffmpeg, ffprobe, width, height, &mut |_, _, _| {})
}

fn adaptive_prepare_with_progress(input: &Path, output: &Path, ffmpeg: &Path, ffprobe: &Path,
    width: u32, height: u32, progress: &mut impl FnMut(&str, Option<u8>, Option<u64>))
    -> CommandResult<AdaptivePreparation> {
    progress("checking", None, None);
    let info = probe(ffprobe, input)?;
    valid_adaptive_source(&info, width, height)?;
    let duration = info["streams"][0]["duration"].as_str()
        .or_else(|| info.pointer("/format/duration").and_then(Value::as_str))
        .and_then(|value| value.parse::<f64>().ok()).ok_or("Duração inválida")?;
    sample_decode(ffmpeg, input, duration)?;
    let stream = &info["streams"][0];
    let compatible_pixels = stream["codec_name"] == "h264" && stream["pix_fmt"] == "yuv420p";
    let is_mp4 = input.extension().and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
        && info.pointer("/format/format_name").and_then(Value::as_str)
            .is_some_and(|format| format.split(',').any(|part| part == "mp4"));
    if compatible_pixels && is_mp4 {
        return Ok(AdaptivePreparation { method: "passthrough", encoder: None, frame_count: None });
    }
    if compatible_pixels {
        let status = Command::new(ffmpeg).args(["-v", "error", "-nostdin", "-n", "-i"])
            .arg(input).args(["-map", "0:v:0", "-c:v", "copy", "-an", "-sn", "-dn",
                "-movflags", "+faststart"]).arg(output).status()
            .map_err(|_| "Não foi possível remuxar o vídeo")?;
        if status.success() {
            let result = (|| {
                let remuxed = probe(ffprobe, output)?;
                valid_adaptive_source(&remuxed, width, height)?;
                if remuxed["streams"][0]["codec_name"] != stream["codec_name"] {
                    return Err("Codec alterado no remux".into());
                }
                let before = packet_timestamps(ffprobe, input)?;
                let after = packet_timestamps(ffprobe, output)?;
                if !same_packet_timing(&before, &after) {
                    return Err("O remux alterou os timestamps ou a ordem dos pacotes".into());
                }
                Ok(AdaptivePreparation { method: "streamcopy", encoder: None,
                    frame_count: Some(before.len() as u64) })
            })();
            if result.is_ok() { return result; }
        }
        let _ = fs::remove_file(output);
    }
    if width % 2 != 0 || height % 2 != 0 {
        return Err("Vídeo incompatível com H.264 4:2:0 e resolução ímpar; normalize a resolução antes da análise".into());
    }
    let mut encoders: Vec<&'static str> = Vec::new();
    #[cfg(target_os = "macos")]
    { encoders.push("h264_videotoolbox"); }
    #[cfg(target_os = "windows")]
    { encoders.extend(["h264_nvenc", "h264_qsv", "h264_amf"]); }
    #[cfg(target_os = "linux")]
    { encoders.extend(["h264_nvenc", "h264_qsv"]); }
    encoders.push("libx264");
    let before = packet_timestamps(ffprobe, input)?;
    for encoder in encoders {
        progress("encoding", Some(0), None);
        let mut command = Command::new(ffmpeg);
        command.args(["-v", "error", "-nostdin", "-n", "-stats_period", "0.5",
            "-progress", "pipe:1", "-noautorotate", "-i"])
            .arg(input).args(["-map", "0:v:0", "-an", "-sn", "-dn", "-c:v", encoder,
                "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
                "-enc_time_base:v", "1/1000000", "-video_track_timescale", "1000000",
                "-movflags", "+faststart"]);
        if encoder == "libx264" { command.args(["-preset", "fast", "-crf", "18"]); }
        else { command.args(["-b:v", "8M"]); }
        let status = command.arg(output).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
            .and_then(|mut child| {
                let started = Instant::now();
                if let Some(stdout) = child.stdout.take() {
                    let mut position_us = None;
                    for line in BufReader::new(stdout).lines() {
                        let line = line?;
                        if let Some(value) = line.strip_prefix("out_time_us=")
                            .or_else(|| line.strip_prefix("out_time_ms=")) {
                            position_us = value.parse::<u64>().ok();
                        }
                        if line == "progress=continue" || line == "progress=end" {
                            if let Some(us) = position_us {
                                let fraction = (us as f64 / 1_000_000.0 / duration).clamp(0.0, 1.0);
                                let percent = (fraction * 95.0).floor() as u8;
                                let remaining = if fraction > 0.02 && started.elapsed().as_secs() >= 3 {
                                    Some(((started.elapsed().as_secs_f64() / fraction) * (1.0 - fraction)).ceil() as u64)
                                } else { None };
                                progress("encoding", Some(percent), remaining);
                            }
                        }
                    }
                }
                child.wait()
            });
        if status.is_ok_and(|status| status.success()) {
            progress("verifying", Some(95), None);
            let checked = (|| {
                let encoded = probe(ffprobe, output)?;
                valid_adaptive_source(&encoded, width, height)?;
                if encoded["streams"][0]["codec_name"] != "h264"
                    || encoded["streams"][0]["pix_fmt"] != "yuv420p" {
                    return Err("A conversão não produziu H.264 4:2:0".into());
                }
                let after = packet_timestamps(ffprobe, output)?;
                if !same_presentation_timing(&before, &after) {
                    return Err("A conversão alterou frames ou timestamps".into());
                }
                Ok(AdaptivePreparation { method: "transcode", encoder: Some(encoder),
                    frame_count: Some(before.len() as u64) })
            })();
            if checked.is_ok() { return checked; }
        }
        let _ = fs::remove_file(output);
    }
    Err("Nenhum encoder disponível preservou os frames e timestamps; o original não foi substituído".into())
}

pub(crate) fn prepare_staged_video_with_policy(
    app: &AppHandle,
    upload_id: &str,
    width: u32,
    height: u32,
    fst_adaptive: bool,
) -> CommandResult<VideoPreparation> {
    prepare_staged_video_with_progress(app, upload_id, width, height, fst_adaptive, &mut |_, _, _| {})
}

pub(crate) fn prepare_staged_video_with_progress(app: &AppHandle, upload_id: &str, width: u32, height: u32,
    fst_adaptive: bool, progress: &mut impl FnMut(&str, Option<u8>, Option<u64>))
    -> CommandResult<VideoPreparation> {
    validate_local_id(upload_id, "Upload")?;
    prepare_tables(app)?;
    let connection = open_database(app)?;
    let original_id = original_upload_id(&connection, upload_id)?;
    let cached: Option<String> = connection.query_row(
        "SELECT report_json FROM video_preparations WHERE original_upload_id=?1",
        [&original_id], |row| row.get(0),
    ).optional().map_err(|_| "Não foi possível consultar a preparação")?;
    let (input, experiment_id, filename, size_sql, ready): (String, String, String, i64, i64) = connection.query_row(
        "SELECT local_path, experiment_id, original_filename, expected_size, ready FROM video_staging WHERE upload_id = ?1", [&original_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).map_err(|_| "Vídeo local não encontrado")?;
    if let Some(report) = cached.as_ref().and_then(|value| serde_json::from_str::<VideoPreparation>(value).ok()) {
        if compatible_preparation(&report, fst_adaptive)
            && i64::try_from(report.original_bytes).ok() == Some(size_sql)
            && staged_video_size(&connection, &experiment_id, &report.upload_id)? == Some(report.upload_bytes)
        {
            return Ok(report);
        }
    }
    let size = u64::try_from(size_sql).map_err(|_| "Tamanho de vídeo inválido")?;
    if ready != 1
        || fs::metadata(&input)
            .map_err(|_| "Vídeo local indisponível")?
            .len()
            != size
    {
        return Err("Vídeo local incompleto".into());
    }
    let new_original_id;
    let upload_id = if cached.is_some() {
        // Keep the old prepared ID and dimensions available for historical jobs.
        // Register a new preparation against the same original file without copying it.
        new_original_id = new_uuid_v4();
        connection.execute(
            "INSERT INTO video_staging (upload_id,experiment_id,local_path,original_filename,expected_size,received_size,sha256,ready)
             SELECT ?1,experiment_id,local_path,original_filename,expected_size,received_size,sha256,ready
               FROM video_staging WHERE upload_id=?2",
            params![&new_original_id, &original_id],
        ).map_err(|_| "Não foi possível registrar o original para outra preparação")?;
        &new_original_id
    } else {
        &original_id
    };
    let mut report = VideoPreparation {
        upload_id: upload_id.into(),
        original_bytes: size,
        upload_bytes: size,
        status: "original".into(),
        message: "Original mantido".into(),
        policy_version: if size > QUALITY_THRESHOLD_BYTES { QUALITY_POLICY } else { "lossless-upload-1" }.into(),
        pixel_verified: false,
        frame_count: None,
        upload_width: Some(width),
        upload_height: Some(height),
        encoder: None,
        method: None,
        preparation_ms: None,
        cache_hit: false,
    };
    if fst_adaptive {
        progress("checking", None, None);
        let started = Instant::now();
        let original_digest: String = connection.query_row(
            "SELECT sha256 FROM video_staging WHERE upload_id=?1 AND ready=1",
            [upload_id], |row| row.get(0))
            .map_err(|_| "SHA-256 do original indisponível")?;
        let cached_source: Option<(VideoPreparation, String, String)> = {
            let mut statement = connection.prepare(
                "SELECT p.report_json, s.local_path, s.sha256
                   FROM video_preparations p
                   JOIN video_staging o ON o.upload_id=p.original_upload_id
                   JOIN video_staging s ON s.upload_id=p.prepared_upload_id
                  WHERE o.sha256=?1 AND o.expected_size=?2 AND p.original_upload_id<>?3 AND s.ready=1")
                .map_err(|_| "Não foi possível consultar o cache de mídia")?;
            let rows = statement.query_map(params![original_digest, size_sql, upload_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            }).map_err(|_| "Não foi possível ler o cache de mídia")?;
            let mut found = None;
            for row in rows {
                let (json, path, digest) = row.map_err(|_| "Registro de cache inválido")?;
                if let Ok(previous) = serde_json::from_str::<VideoPreparation>(&json) {
                    if previous.policy_version == FST_POLICY && previous.upload_width == Some(width)
                        && previous.upload_height == Some(height)
                        && fs::metadata(&path).is_ok_and(|file| file.is_file() && file.len() == previous.upload_bytes)
                        && sha256(Path::new(&path)).is_ok_and(|actual| actual == digest) {
                        found = Some((previous, path, digest));
                        break;
                    }
                }
            }
            found
        };
        if let Some((previous, cached_path, cached_digest)) = cached_source {
            report = previous;
            report.original_bytes = size;
            report.cache_hit = true;
            if report.method.as_deref() == Some("passthrough") {
                report.upload_id = upload_id.into();
                report.upload_bytes = size;
                report.status = "original".into();
            } else {
                let prepared_id = new_uuid_v4();
                let output = staging_directory(app)?.join(format!("{prepared_id}.mp4"));
                if fs::hard_link(&cached_path, &output).is_err() {
                    fs::copy(&cached_path, &output).map_err(|_| "Falha ao reutilizar a mídia preparada")?;
                }
                connection.execute("INSERT INTO video_staging (upload_id,experiment_id,local_path,original_filename,expected_size,received_size,sha256,ready) VALUES (?1,?2,?3,?4,?5,?5,?6,1)",
                    params![prepared_id, experiment_id, output.to_string_lossy(), format!("{filename}.prepared.mp4"), report.upload_bytes as i64, cached_digest])
                    .map_err(|_| "Falha ao registrar mídia reutilizada")?;
                report.upload_id = prepared_id;
            }
            report.preparation_ms = Some(started.elapsed().as_millis() as u64);
            connection.execute("INSERT INTO video_preparations (original_upload_id,prepared_upload_id,report_json) VALUES (?1,?2,?3)",
                params![upload_id, &report.upload_id, serde_json::to_string(&report).map_err(|_| "Falha ao registrar cache")?])
                .map_err(|_| "Falha ao salvar o cache de mídia")?;
            return Ok(report);
        }
        let ffprobe = binary("ffprobe").ok_or("ffprobe é necessário para validar o vídeo FST")?;
        let ffmpeg = binary("ffmpeg").ok_or("FFmpeg é necessário para preparar o vídeo FST")?;
        let prepared_id = new_uuid_v4();
        let output = staging_directory(app)?.join(format!("{prepared_id}.mp4"));
        let result = adaptive_prepare_with_progress(Path::new(&input), &output, &ffmpeg,
            &ffprobe, width, height, progress);
        let outcome = match result {
            Ok(value) => value,
            Err(error) => { let _ = fs::remove_file(&output); return Err(error); }
        };
        report.policy_version = FST_POLICY.into();
        report.frame_count = outcome.frame_count;
        report.encoder = outcome.encoder.map(str::to_string);
        report.method = Some(outcome.method.into());
        report.message = match outcome.method {
            "passthrough" => "MP4 compatível: original enviado sem recodificação; pixels e timestamps preservados.".into(),
            "streamcopy" => "Contêiner MP4 preparado sem recodificar; pacotes e timestamps conferidos.".into(),
            _ => format!("Vídeo convertido com {} para H.264; pixels alterados, frames e timestamps conferidos.", outcome.encoder.unwrap_or("encoder desconhecido")),
        };
        if outcome.method != "passthrough" {
            let bytes = fs::metadata(&output).map_err(|_| "Vídeo preparado indisponível")?.len();
            let digest = sha256(&output)?;
            connection.execute("INSERT INTO video_staging (upload_id,experiment_id,local_path,original_filename,expected_size,received_size,sha256,ready) VALUES (?1,?2,?3,?4,?5,?5,?6,1)",
                params![prepared_id, experiment_id, output.to_string_lossy(), format!("{filename}.prepared.mp4"), bytes as i64, digest])
                .map_err(|_| "Falha ao registrar o vídeo preparado")?;
            report.upload_id = prepared_id;
            report.upload_bytes = bytes;
            report.status = "optimized".into();
        }
        report.preparation_ms = Some(started.elapsed().as_millis() as u64);
        connection.execute("INSERT INTO video_preparations (original_upload_id,prepared_upload_id,report_json) VALUES (?1,?2,?3)",
            params![upload_id, &report.upload_id, serde_json::to_string(&report).map_err(|_| "Falha ao registrar preparação")?])
            .map_err(|_| "Falha ao salvar preparação do vídeo")?;
        return Ok(report);
    }
    if let (Some(ffmpeg), Some(ffprobe)) = (binary("ffmpeg"), binary("ffprobe")) {
        let prepared_id = new_uuid_v4();
        let output = staging_directory(app)?.join(format!("{prepared_id}.mp4"));
        let quality = size > QUALITY_THRESHOLD_BYTES;
        let result = if quality {
            optimize_quality_with_progress(Path::new(&input), &output, &ffmpeg, &ffprobe,
                width, height, progress)
                .map(|(frames, w, h)| (frames, w, h, false))
        } else {
            optimize_with_progress(Path::new(&input), &output, &ffmpeg, &ffprobe,
                width, height, progress)
                .map(|frames| (frames, width, height, true))
        };
        match result {
            Ok((frames, upload_width, upload_height, pixel_verified)) => {
                let bytes = fs::metadata(&output)
                    .map_err(|_| "Cópia preparada indisponível")?
                    .len();
                let digest = sha256(&output)?;
                connection.execute("INSERT INTO video_staging (upload_id,experiment_id,local_path,original_filename,expected_size,received_size,sha256,ready) VALUES (?1,?2,?3,?4,?5,?5,?6,1)",
                    params![prepared_id, experiment_id, output.to_string_lossy(), format!("{filename}.prepared.mp4"), bytes as i64, digest]).map_err(|_| "Falha ao registrar a cópia preparada")?;
                report.upload_id = prepared_id;
                report.upload_bytes = bytes;
                report.status = "optimized".into();
                report.pixel_verified = pixel_verified;
                report.frame_count = Some(frames);
                report.upload_width = Some(upload_width);
                report.upload_height = Some(upload_height);
                if quality {
                    report.policy_version = QUALITY_POLICY.into();
                    report.message = format!("Cópia otimizada: {upload_width} × {upload_height} px, áudio removido, frames e tempos conferidos. A compactação altera os pixels.");
                } else {
                    report.message = "Compactação sem perda verificada: mesmos pixels, frames e sincronização (tolerância de 1 ms).".into();
                }
            }
            Err(reason) => {
                report.message = reason;
                let _ = fs::remove_file(&output);
            }
        }
    } else {
        report.status = "unavailable".into();
        report.message =
            "FFmpeg/ffprobe não encontrados. Original será enviado sem redução de qualidade."
                .into();
    }
    connection.execute("INSERT INTO video_preparations (original_upload_id,prepared_upload_id,report_json) VALUES (?1,?2,?3)",
        params![upload_id, &report.upload_id, serde_json::to_string(&report).map_err(|_| "Falha ao registrar preparação")?]).map_err(|_| "Falha ao salvar preparação do vídeo")?;
    Ok(report)
}

#[tauri::command]
pub async fn prepare_analysis_video(
    app: AppHandle,
    upload_id: String,
    width: u32,
    height: u32,
    fst_adaptive: Option<bool>,
) -> CommandResult<VideoPreparation> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = prepare_staged_video_with_progress(&app, &upload_id, width, height,
            fst_adaptive.unwrap_or(false), &mut |phase, percent, remaining_sec| {
                emit_preparation_progress(&app, &upload_id, phase, percent, remaining_sec);
            });
        if result.is_ok() { emit_preparation_progress(&app, &upload_id, "complete", Some(100), Some(0)); }
        result
    })
    .await
    .map_err(|_| "Preparação do vídeo interrompida".to_string())?
}

#[tauri::command]
pub fn get_colab_job_preparation(app: AppHandle, experiment_id: String, job_id: String) -> CommandResult<Option<VideoPreparation>> {
    validate_local_id(&experiment_id, "Experimento")?;
    validate_local_id(&job_id, "Execução")?;
    prepare_tables(&app)?;
    let report: Option<String> = open_database(&app)?.query_row(
        "SELECT p.report_json FROM colab_jobs j JOIN video_preparations p ON p.prepared_upload_id=j.upload_id WHERE j.job_id=?1 AND j.experiment_id=?2",
        params![job_id, experiment_id], |row| row.get(0),
    ).optional().map_err(|_| "Não foi possível consultar a preparação da execução")?;
    report.map(|value| serde_json::from_str(&value).map_err(|_| "Preparação da execução ilegível".into())).transpose()
}

fn cut_diagnostic(
    input: &Path,
    output: &Path,
    start: f64,
    end: f64,
    width: u32,
    height: u32,
) -> CommandResult<u64> {
    let ffmpeg = binary("ffmpeg").ok_or("FFmpeg é necessário para preparar somente o trecho diagnóstico; nenhum vídeo completo será enviado como alternativa.")?;
    let ffprobe =
        binary("ffprobe").ok_or("ffprobe é necessário para validar o trecho diagnóstico.")?;
    let info = probe(&ffprobe, input)?;
    let stream = &info["streams"][0];
    let pixel = stream["pix_fmt"]
        .as_str()
        .ok_or("Formato de pixel desconhecido")?;
    if stream["width"].as_u64() != Some(width.into())
        || stream["height"].as_u64() != Some(height.into())
        || ![
            "yuv420p",
            "yuv422p",
            "yuv444p",
            "yuv420p10le",
            "yuv422p10le",
            "yuv444p10le",
        ]
        .contains(&pixel)
    {
        return Err("Formato/resolução incompatível com recorte diagnóstico sem perda.".into());
    }
    if stream["side_data_list"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["rotation"].as_i64().is_some_and(|v| v != 0))
    }) || stream["tags"]["rotate"]
        .as_str()
        .is_some_and(|v| v.parse::<f64>().map_or(true, |v| v != 0.0))
    {
        return Err("Normalize a rotação do vídeo antes de testar; o app não alterará sua calibração automaticamente.".into());
    }
    let status = Command::new(&ffmpeg)
        .args([
            "-v",
            "error",
            "-nostdin",
            "-n",
            "-noautorotate",
            "-ss",
            &start.to_string(),
            "-t",
            &(end - start).to_string(),
            "-i",
        ])
        .arg(input)
        .args([
            "-vf",
            &format!(
                "trim=start=0:end={},settb=1/1000000,setpts=PTS-STARTPTS",
                end - start
            ),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-c:v",
            "libx264",
            "-crf",
            "0",
            "-preset",
            "fast",
            "-threads",
            "2",
            "-pix_fmt",
            pixel,
            "-enc_time_base",
            "1/1000000",
            "-fps_mode",
            "passthrough",
            "-movflags",
            "+faststart",
            "-fs",
            "21474836480",
        ])
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Não foi possível recortar o trecho local")?;
    if !status.success() {
        return Err("O FFmpeg não conseguiu preparar o trecho diagnóstico sem perda.".into());
    }
    let encoded = probe(&ffprobe, output)?;
    for field in [
        "width",
        "height",
        "pix_fmt",
        "sample_aspect_ratio",
        "color_range",
        "color_space",
        "color_transfer",
        "color_primaries",
    ] {
        if stream[field] != encoded["streams"][0][field] {
            return Err(format!(
                "Metadado visual {field} mudou no trecho; envio cancelado."
            ));
        }
    }
    let before = fingerprints_window(&ffmpeg, input, Some((start, end)))?;
    let after = fingerprints(&ffmpeg, output)?;
    if !identical_frames(&before, &after) {
        return Err("O trecho não passou na validação de pixels/tempos; envio cancelado.".into());
    }
    Ok(after.len() as u64)
}

pub(crate) fn prepare_diagnostic_video(
    app: &AppHandle,
    upload_id: &str,
    job_id: &str,
    start: f64,
    end: f64,
    width: u32,
    height: u32,
) -> CommandResult<String> {
    let connection = open_database(app)?;
    let (input, experiment): (String, String) = connection
        .query_row(
            "SELECT local_path,experiment_id FROM video_staging WHERE upload_id=?1 AND ready=1",
            [upload_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Vídeo original não encontrado no cache. Selecione-o novamente.")?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Pasta do aplicativo indisponível")?
        .join("results");
    fs::create_dir_all(&directory)
        .map_err(|_| "Não foi possível preparar os resultados diagnósticos")?;
    let output = directory.join(format!("{job_id}-clip.mp4"));
    if output.exists() {
        return Err("O trecho deste job já existe; não será sobrescrito.".into());
    }
    if let Err(error) = cut_diagnostic(Path::new(&input), &output, start, end, width, height) {
        let _ = fs::remove_file(&output);
        return Err(error);
    }
    let id = new_uuid_v4();
    let size = fs::metadata(&output)
        .map_err(|_| "Trecho diagnóstico indisponível")?
        .len() as i64;
    let digest = sha256(&output)?;
    connection.execute("INSERT INTO video_staging (upload_id,experiment_id,local_path,original_filename,expected_size,received_size,sha256,ready) VALUES (?1,?2,?3,'diagnostic.mp4',?4,?4,?5,1)",
        params![&id,experiment,output.to_string_lossy(),size,digest]).map_err(|_| "Falha ao registrar o trecho diagnóstico")?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colab_reuses_local_preparation_and_falls_back_to_the_cached_original() {
        let root = std::env::temp_dir().join(format!("behavetracker-reuse-{}", new_uuid_v4()));
        fs::create_dir_all(&root).unwrap();
        let original = root.join("video.mov");
        let prepared = root.join("video-prepared.mp4");
        fs::write(&prepared, b"mp4").unwrap();
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(include_str!("../migrations/001_initial.sql")).unwrap();
        for (id, path, name, size, digest) in [
            ("original", &original, "video.mov", 8, "source"),
            ("optimized", &prepared, "video.mov.prepared.mp4", 3, "derived"),
        ] {
            connection.execute(
                "INSERT INTO video_staging (upload_id,experiment_id,local_path,original_filename,expected_size,received_size,sha256,ready)
                 VALUES (?1,'project',?2,?3,?4,?4,?5,1)",
                params![id, path.to_string_lossy(), name, size, digest],
            ).unwrap();
        }
        let report = serde_json::json!({
            "uploadId":"optimized", "originalBytes":8, "uploadBytes":3, "status":"optimized",
            "message":"Vídeo pronto", "policyVersion":"quality-upload-4", "pixelVerified":false,
            "frameCount":12, "uploadWidth":1920, "uploadHeight":1080,
        });
        connection.execute("INSERT INTO video_preparations VALUES ('original','optimized',?1)", [report.to_string()]).unwrap();
        let resolve = |project, hash, adaptive| {
            find_staged_analysis_video(&connection, project, "video.mov", 8, hash, Some("optimized"), adaptive).unwrap()
        };
        let media = resolve("project", Some("source"), false).unwrap();
        assert_eq!(media.preparation.unwrap().upload_id, "optimized");
        assert!(media.original_upload_id.is_none());
        assert!(resolve("another-project", Some("source"), false).is_none());
        assert!(resolve("project", Some("different-video"), false).is_none());
        assert!(resolve("project", Some("source"), true).is_none());
        assert!(find_staged_analysis_video(&connection, "project", "video.mov", 8, None, None, false)
            .unwrap().unwrap().preparation.is_some());

        fs::write(&original, b"original").unwrap();
        fs::remove_file(&prepared).unwrap();
        let fallback = resolve("project", Some("source"), false).unwrap();
        assert!(fallback.preparation.is_none());
        assert_eq!(fallback.original_upload_id.as_deref(), Some("original"));
        fs::remove_file(&original).unwrap();
        fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn adaptive_preparation_passthrough_remux_and_transcode() {
        let (Some(ffmpeg), Some(ffprobe)) = (binary("ffmpeg"), binary("ffprobe")) else { return; };
        let root = std::env::temp_dir().join(format!("behavetracker-adaptive-{}", new_uuid_v4()));
        fs::create_dir_all(&root).unwrap();
        let mp4 = root.join("source.mp4");
        assert!(Command::new(&ffmpeg).args(["-v", "error", "-f", "lavfi", "-i",
            "testsrc2=size=160x120:rate=24", "-frames:v", "24", "-c:v", "libx264",
            "-pix_fmt", "yuv420p"]).arg(&mp4).status().unwrap().success());
        let digest = sha256(&mp4).unwrap();
        let untouched = root.join("unused.mp4");
        let direct = adaptive_prepare(&mp4, &untouched, &ffmpeg, &ffprobe, 160, 120).unwrap();
        assert_eq!(direct.method, "passthrough");
        assert!(!untouched.exists());
        assert_eq!(sha256(&mp4).unwrap(), digest);

        let mkv = root.join("source.mkv");
        assert!(Command::new(&ffmpeg).args(["-v", "error", "-i"]).arg(&mp4)
            .args(["-c:v", "copy"]).arg(&mkv).status().unwrap().success());
        let remuxed = root.join("remuxed.mp4");
        let remux = adaptive_prepare(&mkv, &remuxed, &ffmpeg, &ffprobe, 160, 120).unwrap();
        assert_eq!(remux.method, "streamcopy");
        assert!(same_packet_timing(&packet_timestamps(&ffprobe, &mkv).unwrap(),
            &packet_timestamps(&ffprobe, &remuxed).unwrap()));

        let raw = root.join("source.nut");
        assert!(Command::new(&ffmpeg).args(["-v", "error", "-f", "lavfi", "-i",
            "testsrc2=size=160x120:rate=24", "-frames:v", "24", "-c:v", "rawvideo",
            "-f", "nut"]).arg(&raw).status().unwrap().success());
        let converted = root.join("converted.mp4");
        let transcode = adaptive_prepare(&raw, &converted, &ffmpeg, &ffprobe, 160, 120).unwrap();
        assert_eq!(transcode.method, "transcode");
        assert!(transcode.encoder.is_some());
        assert!(same_presentation_timing(&packet_timestamps(&ffprobe, &raw).unwrap(),
            &packet_timestamps(&ffprobe, &converted).unwrap()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adaptive_preparation_rejects_changed_geometry_and_rotation() {
        let info = serde_json::json!({"streams":[{"width":160,"height":120,
            "side_data_list":[{"rotation":90}]}],"format":{"duration":"1.0"}});
        assert!(valid_adaptive_source(&info, 160, 120).unwrap_err().contains("rotação"));
        assert!(valid_adaptive_source(&info, 320, 240).unwrap_err().contains("Resolução"));
    }
    #[test]
    fn staging_status_requires_a_ready_file_of_the_expected_size_owned_by_the_experiment() {
        let root = std::env::temp_dir().join(format!("behavetracker-cache-test-{}", new_uuid_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("cached.mp4");
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE video_staging(upload_id TEXT,experiment_id TEXT,local_path TEXT,expected_size INTEGER,ready INTEGER);").unwrap();
        connection
            .execute(
                "INSERT INTO video_staging VALUES ('upload','experiment',?1,4,1)",
                [input.to_string_lossy().as_ref()],
            )
            .unwrap();
        // Um registro ready=1 não comprova que o arquivo ainda existe.
        assert!(!staged_video_available(&connection, "experiment", "upload").unwrap());
        fs::write(&input, b"test").unwrap();
        assert!(staged_video_available(&connection, "experiment", "upload").unwrap());
        assert!(!staged_video_available(&connection, "other", "upload").unwrap());
        fs::write(&input, b"bad").unwrap();
        assert!(!staged_video_available(&connection, "experiment", "upload").unwrap());
        fs::write(&input, b"test").unwrap();
        connection
            .execute("UPDATE video_staging SET ready=0", [])
            .unwrap();
        assert!(!staged_video_available(&connection, "experiment", "upload").unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_cache_file_is_reported_before_launching_ffprobe() {
        let input =
            std::env::temp_dir().join(format!("behavetracker-missing-{}.mp4", new_uuid_v4()));
        let error = probe(Path::new("ffprobe-that-must-not-be-called"), &input).unwrap_err();
        assert!(error.contains("cache"));
        assert!(error.contains("Selecione novamente"));
        assert!(!error.contains("ffprobe"));
    }
    #[test]
    fn diagnostic_clip_is_short_pixel_exact_and_does_not_change_the_original() {
        let Some(ffmpeg) = binary("ffmpeg") else {
            return;
        };
        let root = std::env::temp_dir().join(format!("behavetracker-clip-test-{}", new_uuid_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("original.mp4");
        assert!(Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x120:rate=24",
                "-t",
                "3",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p"
            ])
            .arg(&input)
            .status()
            .unwrap()
            .success());
        let digest = sha256(&input).unwrap();
        let (w, h, pts) = extract_exact_frame(&input, &root.join("frame-7.png"), 7).unwrap();
        assert_eq!(frame_at_time(&input, 7. / 24.).unwrap(), 7);
        assert_eq!((w, h), (160, 120));
        assert!((pts - 7. / 24.).abs() < 0.00001);
        let output = root.join("clip.mp4");
        assert_eq!(
            cut_diagnostic(&input, &output, 0.5, 1.5, 160, 120).unwrap(),
            24
        );
        assert_eq!(sha256(&input).unwrap(), digest);
        assert_eq!(fingerprints(&ffmpeg, &output).unwrap().len(), 24);
        assert_eq!(
            cut_diagnostic(&input, &root.join("off-grid.mp4"), 0.13, 1.37, 160, 120).unwrap(),
            29
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn frame_validation_requires_exact_pixels_and_no_missing_frames() {
        let original = vec![(0, "a".into()), (40_000, "b".into())];
        assert!(identical_frames(
            &original,
            &[(0, "a".into()), (40_500, "b".into())]
        ));
        assert!(!identical_frames(
            &original,
            &[(0, "a".into()), (42_000, "b".into())]
        ));
        assert!(!identical_frames(
            &original,
            &[(0, "a".into()), (40_000, "c".into())]
        ));
        assert!(!identical_frames(&original, &original[..1]));
        assert!(!identical_frames(&[], &[]));
    }
    #[test]
    fn quality_preparation_preserves_frame_timing_and_removes_audio() {
        let (Some(ffmpeg), Some(ffprobe)) = (binary("ffmpeg"), binary("ffprobe")) else { return; };
        assert_eq!(upload_dimensions(3840, 2160), (1920, 1080));
        assert_eq!(upload_dimensions(2160, 3840), (1080, 1920));
        assert_eq!(upload_dimensions(1280, 720), (1280, 720));
        assert_eq!(upload_dimensions(1919, 1079), (1918, 1078));
        let root = std::env::temp_dir().join(format!("behavetracker-quality-test-{}", new_uuid_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("source.nut");
        let output = root.join("prepared.mp4");
        let status = Command::new(&ffmpeg).args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24",
            "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000", "-t", "1", "-c:v", "rawvideo",
            "-c:a", "pcm_s16le", "-f", "nut"]).arg(&input).status().unwrap();
        assert!(status.success());
        let mut updates = Vec::new();
        assert_eq!(optimize_quality_with_progress(&input, &output, &ffmpeg, &ffprobe, 160, 120,
            &mut |phase, percent, _| updates.push((phase.to_string(), percent))).unwrap(), (24, 160, 120));
        assert!(updates.iter().any(|(phase, percent)| phase == "encoding" && percent.is_some()));
        assert!(updates.iter().any(|(phase, percent)| phase == "verifying" && *percent == Some(99)));
        assert!(fs::metadata(&output).unwrap().len() < fs::metadata(&input).unwrap().len());
        let streams = Command::new(&ffprobe).args(["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0"])
            .arg(&output).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&streams.stdout).trim(), "video");
        assert!(identical_timing(&fingerprints(&ffmpeg, &input).unwrap(), &fingerprints(&ffmpeg, &output).unwrap()));
        assert!(!identical_frames(&fingerprints(&ffmpeg, &input).unwrap(), &fingerprints(&ffmpeg, &output).unwrap()));
        let high_res = root.join("high-resolution.nut");
        let downscaled = root.join("downscaled.mp4");
        assert!(Command::new(&ffmpeg).args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=2048x1152:rate=2",
            "-frames:v", "2", "-c:v", "rawvideo", "-f", "nut"]).arg(&high_res).status().unwrap().success());
        assert_eq!(optimize_quality(&high_res, &downscaled, &ffmpeg, &ffprobe, 2048, 1152).unwrap(), (2, 1920, 1080));

        let lossless = root.join("lossless.mp4");
        assert!(Command::new(&ffmpeg).args(["-v", "error", "-i"]).arg(&input)
            .args(["-an", "-c:v", "libx264", "-crf", "0"]).arg(&lossless).status().unwrap().success());
        for (angle, width, height) in [("180", 160, 120), ("90", 120, 160)] {
            let rotated = root.join(format!("rotated-{angle}.mov"));
            let normalized = root.join(format!("normalized-{angle}.mp4"));
            assert!(Command::new(&ffmpeg).args(["-v", "error", "-display_rotation:v:0", angle, "-i"])
                .arg(&lossless).args(["-c", "copy"]).arg(&rotated).status().unwrap().success());
            assert_ne!(display_rotation(&probe(&ffprobe, &rotated).unwrap()["streams"][0]), 0.0);
            assert_eq!(optimize_quality(&rotated, &normalized, &ffmpeg, &ffprobe, width, height).unwrap(),
                (24, width, height));
            assert_eq!(display_rotation(&probe(&ffprobe, &normalized).unwrap()["streams"][0]), 0.0);
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn real_ffmpeg_lossless_roundtrip_preserves_decoded_pixels_and_timing() {
        let (Some(ffmpeg), Some(ffprobe)) = (binary("ffmpeg"), binary("ffprobe")) else {
            eprintln!("FFmpeg indisponível: integração não executada");
            return;
        };
        let root = std::env::temp_dir().join(format!("behavetracker-video-test-{}", new_uuid_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("source.nut");
        let output = root.join("lossless.mp4");
        let result = Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x120:rate=24",
                "-t",
                "1",
                "-c:v",
                "rawvideo",
                "-f",
                "nut",
            ])
            .arg(&input)
            .status()
            .unwrap();
        assert!(result.success());
        let mut updates = Vec::new();
        assert_eq!(optimize_with_progress(&input, &output, &ffmpeg, &ffprobe, 160, 120,
            &mut |phase, percent, _| updates.push((phase.to_string(), percent))).unwrap(), 24);
        assert!(updates.iter().any(|(phase, percent)| phase == "encoding" && percent.is_some()));
        assert!(updates.iter().any(|(phase, percent)| phase == "verifying" && *percent == Some(99)));
        assert!(fs::metadata(&output).unwrap().len() < fs::metadata(&input).unwrap().len());
        assert!(optimize(&input, &root.join("wrong.mp4"), &ffmpeg, &ffprobe, 320, 240).is_err());
        let protected_digest = sha256(&output).unwrap();
        let larger = root.join("reencoded.mp4");
        assert!(optimize(&output, &larger, &ffmpeg, &ffprobe, 160, 120).is_err());
        assert_eq!(sha256(&output).unwrap(), protected_digest);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_preparation_preserves_variable_frame_timestamps_without_converting_to_cfr() {
        let (Some(ffmpeg), Some(ffprobe)) = (binary("ffmpeg"), binary("ffprobe")) else {
            return;
        };
        let root = std::env::temp_dir().join(format!("behavetracker-video-vfr-{}", new_uuid_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("variable.nut");
        let output = root.join("lossless.mp4");
        let status = Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x120:rate=24",
                "-frames:v",
                "12",
                "-vf",
                "setpts=N*N/(24*TB)",
                "-fps_mode",
                "passthrough",
                "-c:v",
                "rawvideo",
                "-f",
                "nut",
            ])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            optimize(&input, &output, &ffmpeg, &ffprobe, 160, 120).unwrap(),
            12
        );
        let quality = root.join("quality.mp4");
        assert_eq!(optimize_quality(&input, &quality, &ffmpeg, &ffprobe, 160, 120).unwrap().0, 12);
        assert!(identical_timing(&fingerprints(&ffmpeg, &input).unwrap(), &fingerprints(&ffmpeg, &quality).unwrap()));
        let frames = fingerprints(&ffmpeg, &output).unwrap();
        assert_eq!(frame_at_time(&input, 0.34).unwrap(), 3); // PTS = n²/24, não frame = t*FPS.
        assert!(frames[3].0 - frames[2].0 > frames[1].0 - frames[0].0);
        fs::remove_dir_all(root).unwrap();
    }
}
