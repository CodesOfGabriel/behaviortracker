//! Compactação local sem perda, com verificação dos pixels e tempos de cada frame.
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
    process::{Command, Stdio},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

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
}

fn binary(name: &str) -> Option<PathBuf> {
    let candidates = std::env::var_os(format!("BEHAVETRACKER_{}", name.to_uppercase()))
        .map(PathBuf::from)
        .into_iter()
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
    let staged: Option<(String,i64,i64)> = connection.query_row(
        "SELECT local_path,expected_size,ready FROM video_staging WHERE upload_id=?1 AND experiment_id=?2",
        params![upload_id,experiment_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()
        .map_err(|_| "Não foi possível consultar o vídeo preparado")?;
    Ok(staged.is_some_and(|(path, size, ready)| {
        size > 0
            && ready == 1
            && fs::metadata(path).is_ok_and(|info| info.is_file() && info.len() == size as u64)
    }))
}

#[tauri::command]
pub fn check_video_staging(
    app: AppHandle,
    experiment_id: String,
    upload_id: String,
) -> CommandResult<bool> {
    validate_local_id(&experiment_id, "Experimento")?;
    validate_local_id(&upload_id, "Upload")?;
    prepare_tables(&app)?;
    staged_video_available(&open_database(&app)?, &experiment_id, &upload_id)
}

// Decodifica em streaming: somente hashes/tempos ficam na memória, não os pixels.
fn fingerprints(program: &Path, input: &Path) -> CommandResult<Vec<(i64, String)>> {
    fingerprints_window(program, input, None)
}

fn fingerprints_window(
    program: &Path,
    input: &Path,
    window: Option<(f64, f64)>,
) -> CommandResult<Vec<(i64, String)>> {
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
            if frames.len() > 2_000_000 {
                return Err("Vídeo excede o limite local de validação de frames".into());
            }
        }
        if frames.is_empty() {
            return Err("Vídeo sem frames decodificáveis".into());
        }
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
) -> CommandResult<()> {
    let mut child = Command::new(program)
        .args(["-v", "error", "-nostdin", "-n", "-noautorotate", "-i"])
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
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Não foi possível iniciar o FFmpeg".to_string())?;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Falha ao acompanhar a compactação")?
        {
            return if status.success() {
                Ok(())
            } else {
                Err("A compactação sem perda não é compatível com este vídeo".into())
            };
        }
        // Não termina uma cópia que já ficou maior que o original.
        if fs::metadata(output).is_ok_and(|file| file.len() > original_bytes) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("A cópia sem perda ficaria maior; o original foi mantido".into());
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn optimize(
    input: &Path,
    output: &Path,
    ffmpeg: &Path,
    ffprobe: &Path,
    width: u32,
    height: u32,
) -> CommandResult<u64> {
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
    encode(ffmpeg, input, output, pixel_format, size)?;
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
    let original = fingerprints(ffmpeg, input)?;
    let compressed = fingerprints(ffmpeg, output)?;
    if !identical_frames(&original, &compressed) {
        return Err("Frames ou timestamps divergiram; original mantido".into());
    }
    Ok(original.len() as u64)
}

pub(crate) fn prepare_staged_video(
    app: &AppHandle,
    upload_id: &str,
    width: u32,
    height: u32,
) -> CommandResult<VideoPreparation> {
    validate_local_id(upload_id, "Upload")?;
    prepare_tables(app)?;
    let connection = open_database(app)?;
    let cached: Option<String> = connection.query_row("SELECT report_json FROM video_preparations WHERE original_upload_id = ?1 OR prepared_upload_id = ?1 LIMIT 1",
        [upload_id], |row| row.get(0)).optional().map_err(|_| "Não foi possível consultar a preparação".to_string())?;
    if let Some(cached) = cached {
        let report: VideoPreparation =
            serde_json::from_str(&cached).map_err(|_| "Preparação local ilegível")?;
        let path: String = connection
            .query_row(
                "SELECT local_path FROM video_staging WHERE upload_id = ?1 AND ready = 1",
                [&report.upload_id],
                |row| row.get(0),
            )
            .map_err(|_| "Cópia preparada não encontrada")?;
        if fs::metadata(&path).is_ok_and(|file| file.len() == report.upload_bytes) {
            return Ok(report);
        }
        return Err(
            "O cache do vídeo não está mais disponível. Selecione novamente o original.".into(),
        );
    }
    let (input, experiment_id, filename, size_sql, ready): (String, String, String, i64, i64) = connection.query_row(
        "SELECT local_path, experiment_id, original_filename, expected_size, ready FROM video_staging WHERE upload_id = ?1", [upload_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).map_err(|_| "Vídeo local não encontrado")?;
    let size = u64::try_from(size_sql).map_err(|_| "Tamanho de vídeo inválido")?;
    if ready != 1
        || fs::metadata(&input)
            .map_err(|_| "Vídeo local indisponível")?
            .len()
            != size
    {
        return Err("Vídeo local incompleto".into());
    }
    let mut report = VideoPreparation {
        upload_id: upload_id.into(),
        original_bytes: size,
        upload_bytes: size,
        status: "original".into(),
        message: "Original mantido".into(),
        policy_version: "lossless-upload-1".into(),
        pixel_verified: false,
        frame_count: None,
    };
    if let (Some(ffmpeg), Some(ffprobe)) = (binary("ffmpeg"), binary("ffprobe")) {
        let prepared_id = new_uuid_v4();
        let output = staging_directory(app)?.join(format!("{prepared_id}.mp4"));
        match optimize(Path::new(&input), &output, &ffmpeg, &ffprobe, width, height) {
            Ok(frames) => {
                let bytes = fs::metadata(&output)
                    .map_err(|_| "Cópia preparada indisponível")?
                    .len();
                let digest = sha256(&output)?;
                connection.execute("INSERT INTO video_staging (upload_id,experiment_id,local_path,original_filename,expected_size,received_size,sha256,ready) VALUES (?1,?2,?3,?4,?5,?5,?6,1)",
                    params![prepared_id, experiment_id, output.to_string_lossy(), format!("{filename}.lossless.mp4"), bytes as i64, digest]).map_err(|_| "Falha ao registrar a cópia preparada")?;
                report.upload_id = prepared_id;
                report.upload_bytes = bytes;
                report.status = "optimized".into();
                report.pixel_verified = true;
                report.frame_count = Some(frames);
                report.message = "Compactação sem perda verificada: mesmos pixels, frames e sincronização (tolerância de 1 ms).".into();
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
) -> CommandResult<VideoPreparation> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_staged_video(&app, &upload_id, width, height)
    })
    .await
    .map_err(|_| "Preparação do vídeo interrompida".to_string())?
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
        assert_eq!(
            optimize(&input, &output, &ffmpeg, &ffprobe, 160, 120).unwrap(),
            24
        );
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
        let frames = fingerprints(&ffmpeg, &output).unwrap();
        assert_eq!(frame_at_time(&input, 0.34).unwrap(), 3); // PTS = n²/24, não frame = t*FPS.
        assert!(frames[3].0 - frames[2].0 > frames[1].0 - frames[0].0);
        fs::remove_dir_all(root).unwrap();
    }
}
