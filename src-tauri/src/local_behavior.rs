//! Behavior jobs, annotations and reviews are isolated from floor tracking metrics.
use crate::{
    colab::{new_uuid_v4, validate_local_id},
    oauth::{open_database, CommandResult},
    video,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const MODULES: &[(&str, &str)] = &[
    ("arena.py", include_str!("../python/arena.py")),
    ("layer_video.py", include_str!("../python/layer_video.py")),
    ("oft_layers.py", include_str!("../python/oft_layers.py")),
    ("oft_continuity.py", include_str!("../python/oft_continuity.py")),
    ("temporal_pose/__init__.py", include_str!("../python/temporal_pose/__init__.py")),
    ("temporal_pose/orientation_viterbi.py", include_str!("../python/temporal_pose/orientation_viterbi.py")),
    ("temporal_pose/kalman_smoother.py", include_str!("../python/temporal_pose/kalman_smoother.py")),
    ("temporal_pose/gap_recovery.py", include_str!("../python/temporal_pose/gap_recovery.py")),
    ("oft_layered_pipeline.py", include_str!("../python/oft_layered_pipeline.py")),
    ("body_axis.py", include_str!("../python/body_axis.py")),
    ("behavior/rearing_evidence.py", include_str!("../python/behavior/rearing_evidence.py")),
    (
        "behavior/export_dataset.py",
        include_str!("../python/behavior/export_dataset.py"),
    ),
    (
        "behavior/__init__.py",
        include_str!("../python/behavior/__init__.py"),
    ),
    (
        "behavior/contracts.py",
        include_str!("../python/behavior/contracts.py"),
    ),
    (
        "behavior/crop_extractor.py",
        include_str!("../python/behavior/crop_extractor.py"),
    ),
    (
        "behavior/event_decoder.py",
        include_str!("../python/behavior/event_decoder.py"),
    ),
    (
        "behavior/metrics.py",
        include_str!("../python/behavior/metrics.py"),
    ),
    (
        "behavior/model_registry.py",
        include_str!("../python/behavior/model_registry.py"),
    ),
    (
        "behavior/motion_features.py",
        include_str!("../python/behavior/motion_features.py"),
    ),
    (
        "behavior/normalization.py",
        include_str!("../python/behavior/normalization.py"),
    ),
    (
        "behavior/observation_quality.py",
        include_str!("../python/behavior/observation_quality.py"),
    ),
    (
        "behavior/intervention.py",
        include_str!("../python/behavior/intervention.py"),
    ),
    (
        "behavior/peak_model.py",
        include_str!("../python/behavior/peak_model.py"),
    ),
    (
        "behavior/onnx_inference.py",
        include_str!("../python/behavior/onnx_inference.py"),
    ),
    (
        "behavior/open_field.py",
        include_str!("../python/behavior/open_field.py"),
    ),
    (
        "behavior/silhouette_features.py",
        include_str!("../python/behavior/silhouette_features.py"),
    ),
    (
        "behavior/temporal_windows.py",
        include_str!("../python/behavior/temporal_windows.py"),
    ),
    ("engine.py", include_str!("../python/opencv_engine.py")),
    (
        "model_delivery.py",
        include_str!("../python/model_delivery.py"),
    ),
    (
        "manifest.json",
        include_str!("../../models/oft_rearing_v1/manifest.json"),
    ),
    (
        "local_audit_video.py",
        include_str!("../python/local_audit_video.py"),
    ),
];
static OPERATING: AtomicBool = AtomicBool::new(false);
struct Operation;
impl Operation {
    fn acquire() -> CommandResult<Self> {
        OPERATING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "Outra preparação comportamental está em andamento")?;
        Ok(Self)
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        OPERATING.store(false, Ordering::SeqCst);
    }
}
fn root(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Dados do app indisponíveis")?
        .join("local-behavior");
    fs::create_dir_all(&path).map_err(|_| "Pasta comportamental indisponível")?;
    Ok(path)
}
fn folder(app: &AppHandle, id: &str) -> CommandResult<PathBuf> {
    validate_local_id(id, "Execução")?;
    Ok(root(app)?.join(id))
}
fn materialize(path: &Path) -> CommandResult<()> {
    fs::create_dir_all(path.join("behavior")).map_err(|_| "Módulo comportamental indisponível")?;
    for (name, body) in MODULES {
        if let Some(parent) = path.join(name).parent() {
            fs::create_dir_all(parent).map_err(|_| "Diretório Python indisponível")?;
        }
        fs::write(path.join(name), body)
            .map_err(|_| format!("Módulo Python indisponível: {name}"))?;
    }
    Ok(())
}
pub(crate) fn materialize_tracking_quality(path: &Path) -> CommandResult<()> {
    fs::create_dir_all(path.join("behavior"))
        .map_err(|_| "Qualidade comportamental indisponível")?;
    for (name, body) in layered_modules() {
        if let Some(parent) = path.join(name).parent() {
            fs::create_dir_all(parent).map_err(|_| "Diretório Python indisponível")?;
        }
        fs::write(path.join(name), body).map_err(|_| "Qualidade comportamental indisponível")?;
    }
    Ok(())
}
pub(crate) fn layered_modules() -> Vec<(&'static str, &'static str)> {
    MODULES.iter().copied().filter(|(name,_)| matches!(*name,
        "arena.py" | "engine.py" | "local_audit_video.py" | "layer_video.py" | "oft_layers.py" | "oft_continuity.py" | "oft_layered_pipeline.py" | "body_axis.py" | "temporal_pose/__init__.py" | "temporal_pose/orientation_viterbi.py" | "temporal_pose/kalman_smoother.py" | "temporal_pose/gap_recovery.py" | "behavior/__init__.py" |
        "behavior/rearing_evidence.py" | "behavior/observation_quality.py" | "behavior/intervention.py" | "behavior/peak_model.py" |
        "behavior/export_dataset.py" | "behavior/contracts.py")).collect()
}
pub(crate) fn apex_model_path(app: &AppHandle) -> CommandResult<Option<PathBuf>> {
    let base = root(app)?;
    let selected = base.join("selected-apex-model.json");
    let directory = if selected.is_file() {
        let value = read(&selected)?;
        let sha = value["sha256"].as_str().ok_or("Modelo selecionado inválido")?;
        if sha.len()!=64 || !sha.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("Modelo selecionado inválido".into()); }
        base.join("models").join(format!("oft_rearing_apex_v1-{sha}"))
    } else { base.join("models/oft_rearing_apex_v1") };
    if !directory.join("manifest.json").is_file() { return Ok(None); }
    validate_apex_model(&directory)?;
    Ok(Some(directory))
}
fn validate_apex_model(directory: &Path) -> CommandResult<Value> {
    let manifest = read(&directory.join("manifest.json"))?;
    let model = directory.join("peak_model.json");
    let size = fs::metadata(&model).map_err(|_| "Modelo de rearing incompleto")?.len();
    if manifest["modelId"] != "oft_rearing_apex_v1" || size > 16*1024*1024 || manifest["sizeBytes"].as_u64() != Some(size)
        || manifest["featureSchema"] != "oft-apex-features-2"
        || manifest["sha256"].as_str() != Some(video::sha256(&model)?.as_str()) {
        return Err("Integridade do modelo de rearing inválida".into());
    }
    let payload=read(&model)?;
    if payload["featureSchema"] != "oft-apex-features-2" { return Err("Modelo de rearing incompatível".into()); }
    Ok(manifest)
}
pub(crate) fn apex_model_payload(app: &AppHandle) -> CommandResult<Option<Value>> {
    let Some(directory) = apex_model_path(app)? else { return Ok(None); };
    // Preserve the exact bytes covered by the model's SHA-256.
    Ok(Some(json!({"manifestText":fs::read_to_string(directory.join("manifest.json")).map_err(|_| "Manifesto indisponível")?,
        "modelText":fs::read_to_string(directory.join("peak_model.json")).map_err(|_| "Modelo indisponível")?})))
}

#[tauri::command]
pub async fn install_local_rearing_apex_model(app: AppHandle, model_directory: String) -> CommandResult<Value> {
    let operation=Operation::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation=operation;
        let source=PathBuf::from(model_directory.trim()).canonicalize().map_err(|_| "Pasta do modelo não encontrada")?;
        let manifest=validate_apex_model(&source)?;
        let base=root(&app)?;
        let destination=base.join("models").join(format!("oft_rearing_apex_v1-{}",manifest["sha256"].as_str().unwrap()));
        if !destination.is_dir() {
            let temporary=base.join(format!("model-import-{}",new_uuid_v4()));
            fs::create_dir_all(&temporary).map_err(|_| "Importação indisponível")?;
            let result=(|| -> CommandResult<()> {
                for name in ["manifest.json","peak_model.json"] { fs::copy(source.join(name),temporary.join(name)).map_err(|_| "Modelo não pôde ser copiado")?; }
                validate_apex_model(&temporary)?;
                fs::create_dir_all(destination.parent().unwrap()).map_err(|_| "Pasta de modelos indisponível")?;
                fs::rename(&temporary,&destination).map_err(|_| "Modelo não pôde ser instalado")?;
                Ok(())
            })();
            let _=fs::remove_dir_all(&temporary); result?;
        }
        validate_apex_model(&destination)?;
        let selected=base.join("selected-apex-model.json");
        let temporary=base.join("selected-apex-model.partial.json");
        fs::write(&temporary,json!({"sha256":manifest["sha256"]}).to_string()).map_err(|_| "Seleção não pôde ser salva")?;
        // The selected record is small and app owned. Keep an existing working
        // selection if replacement fails, including on Windows.
        fs::rename(&temporary,&selected).map_err(|_| "Seleção não pôde ser ativada")?;
        Ok(json!({"manifest":manifest,"directory":destination,"scientificallyValidated":false}))
    }).await.map_err(|_| "Instalação interrompida".to_string())?
}
fn python(app: &AppHandle) -> CommandResult<PathBuf> {
    if let Some(path) = std::env::var_os("BEHAVETRACKER_BEHAVIOR_PYTHON") {
        return Ok(path.into());
    }
    Ok(root(app)?.join("venv").join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    }))
}
fn read(path: &Path) -> CommandResult<Value> {
    serde_json::from_slice(&fs::read(path).map_err(|_| "Artefato comportamental ausente")?)
        .map_err(|_| "Artefato comportamental inválido".into())
}
fn model_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(root(app)?.join("models/oft_rearing_v1"))
}
fn model_manifest(app: &AppHandle, tools: &Path) -> CommandResult<PathBuf> {
    let installed = model_dir(app)?.join("manifest.json");
    Ok(if installed.is_file() {
        installed
    } else {
        tools.join("manifest.json")
    })
}
fn invoke_python(
    app: &AppHandle,
    directory: &Path,
    code: &str,
    args: &[PathBuf],
) -> CommandResult<Value> {
    let output = Command::new(python(app)?)
        .current_dir(directory)
        .args(["-X", "utf8", "-c", code])
        .args(args)
        .output()
        .map_err(|_| "Prepare o ambiente comportamental local")?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1600)
            .collect::<String>();
        return Err(if error.is_empty() {
            "Operação comportamental falhou".into()
        } else {
            error
        });
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .last()
        .unwrap_or("")
        .to_owned();
    serde_json::from_str(&line).map_err(|_| "Resposta comportamental inválida".into())
}
fn idle(app: &AppHandle) -> CommandResult<()> {
    let active: bool = open_database(app)?.query_row("SELECT EXISTS(SELECT 1 FROM behavior_jobs WHERE state NOT IN ('succeeded','failed','cancelled'))", [], |row| row.get(0))
        .map_err(|_| "Consulta comportamental indisponível")?;
    if active {
        return Err("Aguarde ou cancele a análise comportamental ativa".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn get_behavior_model_status(app: AppHandle) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = root(&app)?.join("tools");
        materialize(&directory)?;
        let manifest = model_manifest(&app, &directory)?;
        if !python(&app)?.is_file() && std::env::var_os("BEHAVETRACKER_BEHAVIOR_PYTHON").is_none() {
            return Ok(json!({"environmentReady":false,"installed":false,"remoteAvailable":false,"manifest":read(&manifest)?,"message":"Prepare o ambiente comportamental"}));
        }
        let mut value = invoke_python(&app, &directory,
            "import json,sys; from behavior.model_registry import status; print(json.dumps(status(sys.argv[1],sys.argv[2])))",
            &[manifest, model_dir(&app)?])?;
        value["environmentReady"] = json!(Command::new(python(&app)?).args(["-c", "import cv2,onnxruntime; assert onnxruntime.__version__=='1.20.1'"]).status().is_ok_and(|s| s.success()));
        Ok(value)
    }).await.map_err(|_| "Verificação comportamental interrompida".to_string())?
}
#[tauri::command]
pub async fn setup_behavior_environment(app: AppHandle) -> CommandResult<()> {
    let operation = Operation::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        idle(&app)?;
        if std::env::var_os("BEHAVETRACKER_BEHAVIOR_PYTHON").is_some() {
            return Err("Ambiente externo configurado: instale onnxruntime==1.20.1 e opencv-python-headless==4.13.0.92 nesse ambiente".into());
        }
        let base = std::env::var_os("BEHAVETRACKER_SYSTEM_PYTHON").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(if cfg!(windows) {"python"} else {"python3"}));
        let created = Command::new(base).args(["-m", "venv"]).arg(root(&app)?.join("venv")).status().map_err(|_| "Python 3 não encontrado")?;
        if !created.success() { return Err("Não foi possível criar o ambiente comportamental".into()); }
        let log = File::create(root(&app)?.join("environment.log")).map_err(|_| "Log indisponível")?;
        let installed = Command::new(python(&app)?).args(["-m", "pip", "install", "--only-binary=:all:", "--disable-pip-version-check", "onnxruntime==1.20.1", "opencv-python-headless==4.13.0.92"])
            .stdout(Stdio::from(log.try_clone().map_err(|_| "Log indisponível")?)).stderr(Stdio::from(log)).status().map_err(|_| "Instalador indisponível")?;
        if !installed.success() { return Err("Runtime CPU incompatível ou download indisponível. Consulte local-behavior/environment.log. Confira os wheels disponíveis para seu sistema: o OpenCV fixado exige macOS 14+ em Intel.".into()); }
        Ok(())
    }).await.map_err(|_| "Preparação interrompida".to_string())?
}
#[tauri::command]
pub async fn download_behavior_model(
    app: AppHandle,
    source_directory: Option<String>,
) -> CommandResult<Value> {
    let operation = Operation::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        idle(&app)?;
        let directory = root(&app)?.join("tools");
        materialize(&directory)?;
        let source = source_directory.map(PathBuf::from);
        let manifest = source.as_ref().map(|p| p.join("manifest.json")).unwrap_or(model_manifest(&app, &directory)?);
        // Install into a new directory first; an invalid import cannot overwrite a working bundle.
        let staging = root(&app)?.join(format!("model-{}", new_uuid_v4()));
        let cancel_file = root(&app)?.join("model-download-cancel");
        if cancel_file.exists() {fs::remove_file(&cancel_file).map_err(|_| "Cancelamento indisponível")?;}
        let result = invoke_python(&app, &directory,
            "import json,sys; from pathlib import Path; from behavior.model_registry import install; print(json.dumps(install(sys.argv[1],sys.argv[2],local_source=sys.argv[3] or None,cancelled=lambda:Path(sys.argv[4]).exists())))",
            &[manifest, staging.clone(), source.unwrap_or_default(), cancel_file]);
        let mut value = match result {Ok(value) => value, Err(error) => {let _=fs::remove_dir_all(&staging); return Err(error);}};
        let target = model_dir(&app)?;
        fs::create_dir_all(target.parent().ok_or("Pasta de modelos inválida")?).map_err(|_| "Cache indisponível")?;
        let backup = target.with_extension("previous");
        if backup.exists() { fs::remove_dir_all(&backup).map_err(|_| "Backup do modelo indisponível")?; }
        if target.exists() { fs::rename(&target,&backup).map_err(|_| "Modelo em uso")?; }
        if fs::rename(&staging,&target).is_err() {
            if backup.exists() { let _=fs::rename(&backup,&target); }
            return Err("Não foi possível publicar o modelo".into());
        }
        let _=fs::remove_dir_all(backup);
        value["environmentReady"] = json!(true);
        Ok(value)
    }).await.map_err(|_| "Instalação interrompida".to_string())?
}
#[tauri::command]
pub fn cancel_behavior_model_download(app: AppHandle) -> CommandResult<()> {
    fs::write(root(&app)?.join("model-download-cancel"), b"cancel")
        .map_err(|_| "Cancelamento indisponível".into())
}
fn tracking(
    app: &AppHandle,
    experiment_id: &str,
    tracking_id: &str,
    digest: &str,
) -> CommandResult<(PathBuf, Value, String)> {
    validate_local_id(experiment_id, "Experimento")?;
    validate_local_id(tracking_id, "Tracking")?;
    let db = open_database(app)?;
    let (state, stored_digest, config, upload): (String,String,String,String) = db.query_row(
        "SELECT state,video_sha256,config_json,upload_id FROM local_tracking_jobs WHERE job_id=?1 AND experiment_id=?2", params![tracking_id,experiment_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_| "Tracking não pertence ao experimento")?;
    let config: Value = serde_json::from_str(&config).map_err(|_| "Configuração inválida")?;
    if state != "succeeded"
        || digest != stored_digest
        || config["protocol"] != "open_field"
        || config["videoPreparation"]["status"] == "optimized"
    {
        return Err(
            "Selecione um tracking OpenCV concluído do mesmo vídeo original de Campo Aberto".into(),
        );
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Dados indisponíveis")?
        .join("local-tracking")
        .join(tracking_id);
    if !directory.join("samples.jsonl").is_file() {
        return Err("Observações OpenCV indisponíveis".into());
    }
    let request = read(&directory.join("request.json"))?;
    let path: String = db.query_row("SELECT local_path FROM video_staging WHERE upload_id=?1 AND experiment_id=?2 AND sha256=?3 AND ready=1",params![upload,experiment_id,digest],|r|r.get(0))
        .map_err(|_| "Vídeo original ausente do cache; selecione novamente o arquivo original")?;
    if request["video"] != path || request["config"] != config {
        return Err("Solicitação original diverge do tracking".into());
    }
    Ok((directory, config, path))
}
fn extent(samples: &Path) -> CommandResult<(Vec<f64>, f64)> {
    use std::io::{BufRead, BufReader};
    // Ignore bulky contour/feature arrays while validating the original clock.
    // This still parses the complete JSON and retains frame/PTS integrity checks.
    #[derive(serde::Deserialize)]
    struct ClockRow {
        #[serde(rename = "frameIndex")]
        frame_index: Option<u64>,
        #[serde(rename = "timestampSec")]
        timestamp_sec: Option<f64>,
    }
    let mut times = Vec::new();
    for (index, line) in
        BufReader::new(File::open(samples).map_err(|_| "Observações indisponíveis")?)
            .lines()
            .enumerate()
    {
        let row: ClockRow = serde_json::from_str(&line.map_err(|_| "Observação ilegível")?)
            .map_err(|_| "Observação inválida")?;
        let time = row.timestamp_sec
            .filter(|n| n.is_finite() && *n >= 0.)
            .ok_or("PTS inválido")?;
        if row.frame_index != Some(index as u64)
            || times.last().is_some_and(|old| *old >= time)
        {
            return Err("Relógio do tracking inválido".into());
        }
        times.push(time);
    }
    if times.len() < 2 {
        return Err("Vídeo sem suporte temporal suficiente".into());
    }
    let last = times[times.len() - 1];
    let duration = last + (last - times[times.len() - 2]).min(0.1);
    Ok((times, duration))
}
fn stream_duration(path: &str, fallback: f64, last_pts: f64) -> CommandResult<f64> {
    let probe = video::binary("ffprobe").ok_or("FFprobe ausente")?;
    let output = Command::new(probe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|_| "Duração do vídeo indisponível")?;
    if !output.status.success() {
        return Err("Duração do vídeo indisponível".into());
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Metadados inválidos")?;
    Ok(value["streams"][0]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > last_pts && *d <= 172800.)
        .unwrap_or(fallback))
}
#[tauri::command]
pub async fn get_behavior_annotation_context(
    app: AppHandle,
    experiment_id: String,
    tracking_job_id: String,
    video_sha256: String,
) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let (directory, _, path) = tracking(&app, &experiment_id, &tracking_job_id, &video_sha256)?;
        if video::sha256(Path::new(&path))? != video_sha256 {
            return Err("Vídeo original alterado".into());
        }
        let (times, estimate) = extent(&directory.join("samples.jsonl"))?;
        let duration = stream_duration(&path, estimate, *times.last().ok_or("PTS ausente")?)?;
        Ok(json!({"videoPath":path,"frameTimes":times,"durationSec":duration}))
    })
    .await
    .map_err(|_| "Carregamento interrompido".to_string())?
}
#[tauri::command]
pub async fn start_local_behavior_analysis(
    app: AppHandle,
    experiment_id: String,
    tracking_job_id: String,
    video_sha256: String,
    cpu_threads: u32,
) -> CommandResult<Value> {
    let operation = Operation::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation=operation;
        idle(&app)?;
        if !(1..=8).contains(&cpu_threads) {return Err("Use de 1 a 8 threads CPU".into());}
        let (tracking_dir,config,path)=tracking(&app,&experiment_id,&tracking_job_id,&video_sha256)?;
        if video::sha256(Path::new(&path))? != video_sha256 {return Err("Vídeo original alterado".into());}
        let model=model_dir(&app)?;
        let manifest=read(&model.join("manifest.json"))?;
        if manifest["availability"]!="trained" {return Err("Anote vídeos e instale um modelo supervisionado antes de classificar rearing".into());}
        let id=new_uuid_v4();
        let directory=folder(&app,&id)?;
        materialize(&directory)?;
        let request=json!({"experimentId":experiment_id,"trackingJobId":tracking_job_id,"videoSha256":video_sha256,
            "video":path,"samples":tracking_dir.join("samples.jsonl"),"config":config,"modelManifestSha256":video::sha256(&model.join("manifest.json"))?,"modelDirectory":model,
            "sampleRateHz":manifest["sampleRateHz"],"cpuThreads":cpu_threads,
            "ffmpeg":video::binary("ffmpeg").ok_or("FFmpeg ausente")?,"ffprobe":video::binary("ffprobe").ok_or("FFprobe ausente")?});
        fs::write(directory.join("request.json"),request.to_string()).map_err(|_| "Solicitação indisponível")?;
        let db=open_database(&app)?;
        db.execute("INSERT INTO behavior_jobs(job_id,experiment_id,tracking_job_id,video_sha256,model_id,model_version,config_json,state) VALUES (?1,?2,?3,?4,?5,?6,?7,'queued')",
            params![id,experiment_id,tracking_job_id,video_sha256,manifest["modelId"].as_str(),manifest["modelVersion"].as_str(),request.to_string()]).map_err(|_| "Registro comportamental indisponível")?;
        let task_app=app.clone(); let task_id=id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let work=(|| -> CommandResult<()> {
                let log=File::create(directory.join("engine.log")).map_err(|_| "Log indisponível")?;
                open_database(&task_app)?.execute("UPDATE behavior_jobs SET state='preparing' WHERE job_id=?1",[&task_id]).map_err(|_| "Estado indisponível")?;
                let child=Command::new(python(&task_app)?).current_dir(&directory).args(["-X","utf8","-u","-m","behavior.open_field"]).arg(directory.join("request.json"))
                    .stdout(Stdio::from(log.try_clone().map_err(|_| "Log indisponível")?)).stderr(Stdio::from(log)).status().map_err(|_| "Motor comportamental indisponível")?;
                let report=read(&directory.join("status.json"))?;
                let state=report["state"].as_str().filter(|s|["succeeded","cancelled","failed"].contains(s)).ok_or("Estado terminal inválido")?;
                if !child.success() && state!="failed" {return Err("Motor interrompido".into());}
                open_database(&task_app)?.execute("UPDATE behavior_jobs SET state=?2,error=?3,completed_at=CURRENT_TIMESTAMP WHERE job_id=?1",params![task_id,state,report["error"].as_str()]).map_err(|_| "Estado indisponível")?;
                Ok(())
            })();
            if let Err(error)=work {if let Ok(db)=open_database(&task_app){let _=db.execute("UPDATE behavior_jobs SET state='failed',error=?2,completed_at=CURRENT_TIMESTAMP WHERE job_id=?1",params![task_id,error]);}}
        });
        Ok(json!({"jobId":id,"state":"queued"}))
    }).await.map_err(|_| "Inicialização interrompida".to_string())?
}
#[tauri::command]
pub async fn list_local_behavior_jobs(
    app: AppHandle,
    experiment_id: String,
    tracking_job_id: String,
) -> CommandResult<Vec<Value>> {
    tauri::async_runtime::spawn_blocking(move || read_local_behavior_jobs(app, experiment_id, tracking_job_id))
        .await.map_err(|_| "Carregamento do histórico interrompido".to_string())?
}

fn read_local_behavior_jobs(app: AppHandle, experiment_id: String, tracking_job_id: String) -> CommandResult<Vec<Value>> {
    validate_local_id(&experiment_id, "Experimento")?;
    validate_local_id(&tracking_job_id, "Tracking")?;
    let db = open_database(&app)?;
    let mut query=db.prepare("SELECT job_id,state,error,model_version,video_sha256,created_at FROM behavior_jobs WHERE experiment_id=?1 AND tracking_job_id=?2 ORDER BY created_at DESC,rowid DESC").map_err(|_| "Histórico indisponível")?;
    let rows = query
        .query_map(params![experiment_id, tracking_job_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|_| "Histórico indisponível")?;
    let mut output = Vec::new();
    for row in rows {
        let (id, state, error, version, digest, created) = row.map_err(|_| "Registro inválido")?;
        let report = read(&folder(&app, &id)?.join("status.json")).unwrap_or(json!({}));
        let shown_state = if ["failed", "cancelled", "succeeded"].contains(&state.as_str()) {
            state.as_str()
        } else {
            report["state"].as_str().unwrap_or(&state)
        };
        output.push(json!({"jobId":id,"state":shown_state,"error":error.or_else(||report["error"].as_str().map(String::from)),"modelVersion":version,"videoSha256":digest,"createdAt":created,"report":report}));
    }
    Ok(output)
}
#[tauri::command]
pub fn get_local_behavior_status(app: AppHandle, job_id: String) -> CommandResult<Value> {
    let db = open_database(&app)?;
    let (state, error): (String, Option<String>) = db
        .query_row(
            "SELECT state,error FROM behavior_jobs WHERE job_id=?1",
            [&job_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "Execução ausente")?;
    let mut report = read(&folder(&app, &job_id)?.join("status.json")).unwrap_or(json!({}));
    if ["failed", "cancelled", "succeeded"].contains(&state.as_str()) || report["state"].is_null() {
        report["state"] = json!(state);
    }
    if error.is_some() {
        report["error"] = json!(error);
    }
    Ok(report)
}
#[tauri::command]
pub async fn get_local_behavior_result(app: AppHandle, job_id: String) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || read_local_behavior_result(app, job_id))
        .await.map_err(|_| "Carregamento do resultado interrompido".to_string())?
}

fn read_local_behavior_result(app: AppHandle, job_id: String) -> CommandResult<Value> {
    let db = open_database(&app)?;
    let state: String = db
        .query_row(
            "SELECT state FROM behavior_jobs WHERE job_id=?1",
            [&job_id],
            |r| r.get(0),
        )
        .map_err(|_| "Execução ausente")?;
    if state != "succeeded" {
        return Err("Resultado comportamental ainda não concluído".into());
    }
    let result = folder(&app, &job_id)?.join("result");
    let predictions = fs::read_to_string(result.join("frame_predictions.jsonl"))
        .map_err(|_| "Predições ausentes")?
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Predições inválidas")?;
    Ok(
        json!({"manifest":read(&result.join("run_manifest.json"))?,"metrics":read(&result.join("behavior_metrics.json"))?,"events":read(&result.join("behavior_events.json"))?,"quality":read(&result.join("quality_report.json"))?,"predictions":predictions}),
    )
}
#[tauri::command]
pub fn cancel_local_behavior_analysis(app: AppHandle, job_id: String) -> CommandResult<()> {
    let db = open_database(&app)?;
    let active:bool=db.query_row("SELECT state NOT IN ('succeeded','cancelled','failed') FROM behavior_jobs WHERE job_id=?1",[&job_id],|r|r.get(0)).map_err(|_| "Execução ausente")?;
    if active {
        fs::write(folder(&app, &job_id)?.join("cancel"), b"cancel")
            .map_err(|_| "Cancelamento indisponível")?;
    }
    Ok(())
}
pub(crate) fn recover(app: &AppHandle) -> CommandResult<()> {
    let db = open_database(app)?;
    let mut query=db.prepare("SELECT job_id FROM behavior_jobs WHERE state NOT IN ('succeeded','cancelled','failed')").map_err(|_| "Recuperação indisponível")?;
    let ids = query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| "Recuperação indisponível")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Recuperação indisponível")?;
    for id in ids {
        let directory = folder(app, &id)?;
        let _ = fs::write(directory.join("cancel"), b"restart");
        let report = read(&directory.join("status.json")).unwrap_or(json!({}));
        let state = if report["state"] == "succeeded"
            && directory.join("result/run_manifest.json").is_file()
        {
            "succeeded"
        } else {
            "failed"
        };
        db.execute("UPDATE behavior_jobs SET state=?2,error=?3,completed_at=CURRENT_TIMESTAMP WHERE job_id=?1",params![id,state,if state=="failed" {Some("Aplicativo reiniciado; classificação interrompida")}else{None}]).map_err(|_| "Recuperação indisponível")?;
    }
    Ok(())
}
#[tauri::command]
pub async fn list_behavior_annotations(
    app: AppHandle,
    tracking_job_id: String,
) -> CommandResult<Vec<Value>> {
    tauri::async_runtime::spawn_blocking(move || read_behavior_annotations(app, tracking_job_id))
        .await.map_err(|_| "Carregamento das anotações interrompido".to_string())?
}

fn read_behavior_annotations(app: AppHandle, tracking_job_id: String) -> CommandResult<Vec<Value>> {
    validate_local_id(&tracking_job_id, "Tracking")?;
    let db = open_database(&app)?;
    let mut query=db.prepare("SELECT annotation_json FROM behavior_annotations WHERE tracking_job_id=?1 ORDER BY sequence").map_err(|_| "Anotações indisponíveis")?;
    let strings = query
        .query_map([tracking_job_id], |r| r.get::<_, String>(0))
        .map_err(|_| "Anotações indisponíveis")?;
    strings
        .map(|s| {
            serde_json::from_str(&s.map_err(|_| "Anotação ilegível")?)
                .map_err(|_| "Anotação inválida".to_string())
        })
        .collect()
}
fn validate_interval(value: &Value, duration: f64) -> CommandResult<()> {
    let start = value["startSec"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .ok_or("Início inválido")?;
    let end = value["endSec"]
        .as_f64()
        .filter(|n| n.is_finite() && *n <= duration + 0.001)
        .ok_or("Fim fora do vídeo")?;
    if end <= start
        || ![
            "NON_REARING",
            "REARING_SUPPORTED",
            "REARING_UNSUPPORTED",
            "REARING_UNSPECIFIED",
            "UNKNOWN",
        ]
        .contains(&value["label"].as_str().unwrap_or(""))
    {
        return Err("Intervalo ou comportamento inválido".into());
    }
    Ok(())
}
fn validate_peak(value: &Value, times: &[f64], history: &[Value]) -> CommandResult<()> {
    if !["REARING_SUPPORTED", "REARING_UNSUPPORTED", "REARING_UNSPECIFIED", "UNKNOWN"]
        .contains(&value["label"].as_str().unwrap_or("")) {
        return Err("Tipo de rearing inválido".into());
    }
    if value.get("startSec").is_some() || value.get("endSec").is_some() {
        return Err("Um ápice registra um instante, sem duração".into());
    }
    let active = |id: &str| !history.iter().any(|e| e["type"] == "UNDO" && e["targetId"] == id);
    if value["type"] == "LABEL_PEAK" {
        let target = value["targetId"].as_str().ok_or("Marcação de origem ausente")?;
        if !history.iter().any(|e| e["type"] == "PEAK" && e["id"] == target && active(target)) {
            return Err("Marcação inexistente, desfeita ou de outra execução".into());
        }
        if value.get("timestampSec").is_some() || value.get("frameIndex").is_some() {
            return Err("A alteração de tipo deve preservar o instante original".into());
        }
    } else {
        let frame = value["frameIndex"].as_u64().and_then(|n| usize::try_from(n).ok()).ok_or("Frame inválido")?;
        let time = value["timestampSec"].as_f64().ok_or("Instante inválido")?;
        if !time.is_finite() || !times.get(frame).is_some_and(|pts| (pts-time).abs() <= 1e-6) {
            return Err("O ápice deve coincidir com o timestamp de um frame do vídeo".into());
        }
        if history.iter().any(|e| e["type"] == "PEAK" && e["frameIndex"] == value["frameIndex"] && active(e["id"].as_str().unwrap_or(""))) {
            return Err("Este frame já tem uma marcação; selecione a barra na timeline".into());
        }
    }
    Ok(())
}
fn validate_training_interval(value: &Value, history: &[Value]) -> CommandResult<()> {
    if let Some(kind) = value.get("exampleKind") {
        if !["walking","grooming","turning","wall","reflection","intervention","other"].contains(&kind.as_str().unwrap_or(""))
            || !["NON_REARING","UNKNOWN"].contains(&value["label"].as_str().unwrap_or("")) {
            return Err("Tipo de exemplo incompatível com o intervalo".into());
        }
    }
    if let Some(id) = value.get("peakId") {
        let target = history.iter().find(|e| e["type"] == "PEAK" && e["id"] == *id)
            .filter(|_| !history.iter().any(|e| e["type"] == "UNDO" && e["targetId"] == *id))
            .ok_or("Ápice de origem inexistente ou desfeito")?;
        let time = target["timestampSec"].as_f64().ok_or("Instante do ápice inválido")?;
        if !value["label"].as_str().is_some_and(|s| s.starts_with("REARING_"))
            || !value["startSec"].as_f64().is_some_and(|s| s <= time)
            || !value["endSec"].as_f64().is_some_and(|e| e > time) {
            return Err("O intervalo deve conter o ápice e ter um tipo de rearing".into());
        }
    }
    Ok(())
}
fn validate_pose_annotation(value: &Value, times: &[f64], width: u64, height: u64) -> CommandResult<()> {
    let frame = value["frameIndex"].as_u64().and_then(|n| usize::try_from(n).ok()).ok_or("Frame inválido")?;
    let time = value["timestampSec"].as_f64().ok_or("Instante inválido")?;
    if !time.is_finite() || !times.get(frame).is_some_and(|pts| (pts-time).abs()<=1e-6) {
        return Err("Os pontos devem pertencer ao timestamp original do quadro".into());
    }
    if width==0 || height==0 || value["imageWidth"]!=width || value["imageHeight"]!=height {
        return Err("As dimensões dos pontos divergem do vídeo original".into());
    }
    let points = value["pose"].as_object().ok_or("Pontos corporais ausentes")?;
    let keys = ["nose","left_ear","right_ear","body_center","hip","tail_base"];
    if points.len()!=keys.len() || keys.iter().any(|key| !points.contains_key(*key)) {
        return Err("Marque os seis pontos ou identifique os que não estão visíveis".into());
    }
    let mut visible = 0;
    for point in points.values() {
        match point["visibility"].as_str() {
            Some("visible") => {
                if !point["x"].as_f64().is_some_and(|x| x.is_finite() && x>=0. && x<(width as f64))
                    || !point["y"].as_f64().is_some_and(|y| y.is_finite() && y>=0. && y<(height as f64)) {
                    return Err("Ponto fora das dimensões da imagem".into());
                }
                visible+=1;
            }
            Some("occluded" | "out_of_frame") if point.get("x").is_some_and(Value::is_null) && point.get("y").is_some_and(Value::is_null) => {},
            _ => return Err("Pontos ocultos devem ficar sem coordenadas estimadas".into()),
        }
    }
    if visible==0 { return Err("Anote pelo menos um ponto visível neste quadro".into()); }
    Ok(())
}

// One human decision can create/edit/remove a peak and record the proposal review.
// Both records must commit together; a rejected instant has no invented duration.
fn proposal_review_entries(base: &Value, review: &Value, times: &[f64], history: &[Value]) -> CommandResult<Vec<Value>> {
    let frame = review["frameIndex"].as_u64().and_then(|n| usize::try_from(n).ok()).ok_or("Frame inválido")?;
    let time = review["timestampSec"].as_f64().ok_or("Instante inválido")?;
    if !time.is_finite() || !times.get(frame).is_some_and(|pts| (pts-time).abs()<=1e-6) {
        return Err("A proposta deve coincidir com um frame original do vídeo".into());
    }
    let annotator = review["annotatorId"].as_str().map(str::trim).filter(|s| !s.is_empty() && s.len()<=200)
        .ok_or("Identifique o anotador")?;
    if review.get("startSec").is_some() || review.get("endSec").is_some() {
        return Err("A revisão confirma um instante; anote início e fim separadamente".into());
    }
    let decision = review["decision"].as_str().filter(|s| ["accept","reject"].contains(s)).ok_or("Decisão inválida")?;
    let label = review["label"].as_str().unwrap_or("REARING_UNSPECIFIED");
    if decision=="accept" && !["REARING_SUPPORTED","REARING_UNSUPPORTED","REARING_UNSPECIFIED"].contains(&label) {
        return Err("Tag de rearing inválida".into());
    }
    let active = |id: &Value| !history.iter().any(|e| e["type"]=="UNDO" && e["targetId"]==*id);
    let existing = history.iter().find(|e| e["type"]=="PEAK" && e["frameIndex"]==review["frameIndex"] && active(&e["id"]));
    let make_entry = |kind: &str| {
        let mut entry = base.clone();
        entry["id"]=json!(new_uuid_v4());entry["type"]=json!(kind);entry["annotatorId"]=json!(annotator);
        entry
    };
    let mut entries=Vec::new();
    let mut decision_entry=make_entry("PROPOSAL_REVIEW");
    decision_entry["frameIndex"]=json!(frame);decision_entry["timestampSec"]=json!(time);decision_entry["decision"]=json!(decision);
    if decision=="accept" {
        let mut peak=make_entry(if existing.is_some(){"LABEL_PEAK"}else{"PEAK"});
        peak["label"]=json!(label);
        if let Some(original)=existing {
            peak["targetId"]=original["id"].clone();
            // Changing a tag must not erase a manually entered observation.
            if let Some(note)=history.iter().rev().find(|e| e["type"]=="LABEL_PEAK" && e["targetId"]==original["id"]).unwrap_or(original).get("note") {
                peak["note"]=note.clone();
            }
            decision_entry["peakId"]=original["id"].clone();
        } else {
            peak["frameIndex"]=json!(frame);peak["timestampSec"]=json!(time);
            decision_entry["peakId"]=peak["id"].clone();
        }
        validate_peak(&peak,times,history)?;
        decision_entry["label"]=json!(label);
        entries.push(peak);
    } else if let Some(peak)=existing {
        if history.iter().any(|e| e["type"]=="INTERVAL" && e["peakId"]==peak["id"] && active(&e["id"])) {
            return Err("Este ápice já tem um episódio anotado. Revise e desfaça o intervalo na aba Anotação antes de rejeitá-lo".into());
        }
        let mut undo=make_entry("UNDO");undo["targetId"]=peak["id"].clone();entries.push(undo);
    }
    entries.push(decision_entry);
    Ok(entries)
}

fn save_proposal_review(db: &mut rusqlite::Connection, base: &Value, review: &Value, times: &[f64]) -> CommandResult<Vec<Value>> {
    let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "Gravação da revisão indisponível")?;
    let history={
        let mut query=tx.prepare("SELECT annotation_json FROM behavior_annotations WHERE tracking_job_id=?1 ORDER BY sequence").map_err(|_| "Histórico indisponível")?;
        let rows=query.query_map([base["trackingJobId"].as_str().ok_or("Tracking ausente")?],|r|r.get::<_,String>(0)).map_err(|_| "Histórico indisponível")?;
        rows.map(|row| serde_json::from_str::<Value>(&row.map_err(|_| "Histórico ilegível")?).map_err(|_| "Histórico inválido"))
            .collect::<Result<Vec<_>,_>>()?
    };
    let entries=proposal_review_entries(base,review,times,&history)?;
    for entry in &entries {
        tx.execute("INSERT INTO behavior_annotations(id,tracking_job_id,video_sha256,annotation_json) VALUES (?1,?2,?3,?4)",
            params![entry["id"].as_str(),base["trackingJobId"].as_str(),base["videoSha256"].as_str(),entry.to_string()])
            .map_err(|_| "Não foi possível salvar a revisão; tente novamente")?;
    }
    tx.commit().map_err(|_| "Não foi possível concluir a revisão")?;
    Ok(entries)
}

#[tauri::command]
pub async fn review_behavior_proposal(app: AppHandle, experiment_id: String, tracking_job_id: String, video_sha256: String, review: Value) -> CommandResult<Vec<Value>> {
    tauri::async_runtime::spawn_blocking(move || {
        let (directory,_,_)=tracking(&app,&experiment_id,&tracking_job_id,&video_sha256)?;
        let (times,_)=extent(&directory.join("samples.jsonl"))?;
        let mut db=open_database(&app)?;
        let created_at:String=db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",[],|r|r.get(0)).map_err(|_| "Relógio indisponível")?;
        let base=json!({"schemaVersion":1,"source":"human","experimentId":experiment_id,"trackingJobId":tracking_job_id,"videoSha256":video_sha256,"createdAt":created_at});
        save_proposal_review(&mut db,&base,&review,&times)
    }).await.map_err(|_| "Gravação da revisão interrompida".to_string())?
}
#[tauri::command]
pub async fn append_behavior_annotation(
    app: AppHandle,
    experiment_id: String,
    tracking_job_id: String,
    video_sha256: String,
    annotation: Value,
) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        append_annotation_blocking(app, experiment_id, tracking_job_id, video_sha256, annotation)
    }).await.map_err(|_| "Gravação da anotação interrompida".to_string())?
}
fn append_annotation_blocking(
    app: AppHandle,
    experiment_id: String,
    tracking_job_id: String,
    video_sha256: String,
    mut annotation: Value,
) -> CommandResult<()> {
    let (directory, config, video_path) =
        tracking(&app, &experiment_id, &tracking_job_id, &video_sha256)?;
    let id = annotation["id"]
        .as_str()
        .ok_or("ID da anotação ausente")?
        .to_owned();
    validate_local_id(&id, "Anotação")?;
    let db = open_database(&app)?;
    if annotation["type"] == "UNDO" {
        let target = annotation["targetId"]
            .as_str()
            .ok_or("Anotação de origem ausente")?;
        let body:String=db.query_row("SELECT annotation_json FROM behavior_annotations WHERE tracking_job_id=?1 AND id=?2",params![tracking_job_id,target],|r|r.get(0)).map_err(|_| "Anotação de outra execução ou inexistente")?;
        let original = serde_json::from_str::<Value>(&body).map_err(|_| "Anotação inválida")?;
        if original["type"] != "INTERVAL" && original["type"] != "PEAK" && original["type"] != "POSE_FRAME" {
            return Err("Apenas intervalos, ápices e quadros anotados podem ser desfeitos".into());
        }
    } else if annotation["type"] == "INTERVAL" {
        let (times, estimate) = extent(&directory.join("samples.jsonl"))?;
        validate_interval(
            &annotation,
            stream_duration(&video_path, estimate, *times.last().ok_or("PTS ausente")?)?,
        )?;
        if annotation["annotatorId"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.len() > 200)
        {
            return Err("Identifique o anotador".into());
        }
        let history = read_behavior_annotations(app.clone(), tracking_job_id.clone())?;
        validate_training_interval(&annotation, &history)?;
        let undone: std::collections::HashSet<&str> = history
            .iter()
            .filter(|e| e["type"] == "UNDO")
            .filter_map(|e| e["targetId"].as_str())
            .collect();
        let start = annotation["startSec"].as_f64().ok_or("Início ausente")?;
        let end = annotation["endSec"].as_f64().ok_or("Fim ausente")?;
        if history.iter().any(|e| {
            e["type"] == "INTERVAL"
                && !undone.contains(e["id"].as_str().unwrap_or(""))
                && e["startSec"].as_f64().is_some_and(|a| a < end)
                && e["endSec"].as_f64().is_some_and(|b| b > start)
        }) {
            return Err(
                "Intervalo sobreposto a uma anotação existente; desfaça o intervalo anterior"
                    .into(),
            );
        }
    } else if annotation["type"] == "POSE_FRAME" {
        if annotation["annotatorId"].as_str().is_none_or(|s| s.trim().is_empty() || s.len()>200) {
            return Err("Identifique o anotador".into());
        }
        let (times, _) = extent(&directory.join("samples.jsonl"))?;
        validate_pose_annotation(&annotation, &times, config["width"].as_u64().ok_or("Largura ausente")?, config["height"].as_u64().ok_or("Altura ausente")?)?;
    } else if annotation["type"] == "PEAK" || annotation["type"] == "LABEL_PEAK" {
        if annotation["annotatorId"].as_str().is_none_or(|s| s.trim().is_empty() || s.len() > 200) {
            return Err("Identifique o anotador".into());
        }
        let history = read_behavior_annotations(app.clone(), tracking_job_id.clone())?;
        let (times, _) = extent(&directory.join("samples.jsonl"))?;
        validate_peak(&annotation, &times, &history)?;
    } else {
        return Err("Tipo de anotação inválido".into());
    }
    annotation["schemaVersion"] = json!(1);
    annotation["experimentId"] = json!(experiment_id);
    annotation["trackingJobId"] = json!(tracking_job_id);
    annotation["videoSha256"] = json!(video_sha256);
    annotation["source"] = json!("human");
    db.execute("INSERT INTO behavior_annotations(id,tracking_job_id,video_sha256,annotation_json) VALUES (?1,?2,?3,?4)",params![id,tracking_job_id,video_sha256,annotation.to_string()]).map_err(|_| "Não foi possível salvar a anotação")?;
    Ok(())
}
#[tauri::command]
pub async fn list_behavior_review_events(app: AppHandle, job_id: String) -> CommandResult<Vec<Value>> {
    tauri::async_runtime::spawn_blocking(move || read_behavior_review_events(app, job_id))
        .await.map_err(|_| "Carregamento das revisões interrompido".to_string())?
}

fn read_behavior_review_events(app: AppHandle, job_id: String) -> CommandResult<Vec<Value>> {
    validate_local_id(&job_id, "Execução")?;
    let db = open_database(&app)?;
    let mut query = db
        .prepare("SELECT event_json FROM behavior_review_events WHERE job_id=?1 ORDER BY sequence")
        .map_err(|_| "Revisões indisponíveis")?;
    let rows = query
        .query_map([job_id], |r| r.get::<_, String>(0))
        .map_err(|_| "Revisões indisponíveis")?;
    rows.map(|s| {
        serde_json::from_str(&s.map_err(|_| "Revisão ilegível")?)
            .map_err(|_| "Revisão inválida".to_string())
    })
    .collect()
}
#[tauri::command]
pub fn append_behavior_review_event(
    app: AppHandle,
    job_id: String,
    mut event: Value,
) -> CommandResult<()> {
    let result = read_local_behavior_result(app.clone(), job_id.clone())?;
    let id = event["id"].as_str().ok_or("ID ausente")?.to_owned();
    validate_local_id(&id, "Revisão")?;
    let target = event["eventId"].as_str().ok_or("Episódio ausente")?;
    if !result["events"]
        .as_array()
        .is_some_and(|events| events.iter().any(|e| e["eventId"] == target))
    {
        return Err("Episódio não pertence à execução".into());
    }
    if !["CONFIRM", "REJECT", "CORRECT"].contains(&event["type"].as_str().unwrap_or(""))
        || event["reviewerId"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.len() > 200)
    {
        return Err("Revisão inválida ou revisor ausente".into());
    }
    if event["type"] == "CORRECT" {
        validate_interval(
            &event,
            result["metrics"]["analysisDurationSec"]
                .as_f64()
                .ok_or("Duração ausente")?,
        )?;
    }
    validate_review_overlap(
        &result["events"],
        &read_behavior_review_events(app.clone(), job_id.clone())?,
        &event,
    )?;
    event["schemaVersion"] = json!(1);
    event["jobId"] = json!(job_id);
    event["videoSha256"] = result["manifest"]["videoSha256"].clone();
    open_database(&app)?
        .execute(
            "INSERT INTO behavior_review_events(id,job_id,event_json) VALUES (?1,?2,?3)",
            params![id, job_id, event.to_string()],
        )
        .map_err(|_| "Revisão não salva")?;
    Ok(())
}

fn validate_review_overlap(
    events: &Value,
    history: &[Value],
    proposed: &Value,
) -> CommandResult<()> {
    let mut evaluated = events.as_array().ok_or("Episódios inválidos")?.clone();
    for review in history.iter().chain(std::iter::once(proposed)) {
        let Some(event) = evaluated
            .iter_mut()
            .find(|event| event["eventId"] == review["eventId"])
        else {
            continue;
        };
        match review["type"].as_str() {
            Some("CORRECT") => {
                event["startSec"] = review["startSec"].clone();
                event["endSec"] = review["endSec"].clone();
                event["behavior"] = review["label"].clone();
                event["reviewStatus"] = json!("corrected");
            }
            Some("CONFIRM") => event["reviewStatus"] = json!("confirmed"),
            Some("REJECT") => event["reviewStatus"] = json!("rejected"),
            _ => return Err("Tipo de revisão inválido".into()),
        }
    }
    let rearing = |event: &Value| {
        event["reviewStatus"] != "rejected"
            && event["behavior"]
                .as_str()
                .is_some_and(|label| label.starts_with("REARING_"))
    };
    let target = evaluated
        .iter()
        .find(|event| event["eventId"] == proposed["eventId"])
        .ok_or("Episódio ausente")?;
    if rearing(target) {
        let start = target["startSec"].as_f64().ok_or("Início inválido")?;
        let end = target["endSec"].as_f64().ok_or("Fim inválido")?;
        if evaluated.iter().any(|other| {
            other["eventId"] != target["eventId"]
                && rearing(other)
                && other["startSec"]
                    .as_f64()
                    .is_some_and(|value| value < end - 1e-8)
                && other["endSec"]
                    .as_f64()
                    .is_some_and(|value| value > start + 1e-8)
        }) {
            return Err("A revisão sobrepõe outro episódio de rearing. Ajuste os limites ou rejeite o episódio duplicado.".into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proposal_reviews_validate_source_pts_author_and_decision() {
        let base=json!({"trackingJobId":"t","videoSha256":"hash","source":"human"});
        let review=json!({"frameIndex":2,"timestampSec":0.17,"decision":"accept","annotatorId":" Reviewer "});
        let entries=proposal_review_entries(&base,&review,&[0.,0.04,0.17],&[]).unwrap();
        assert_eq!(entries.len(),2);
        assert_eq!(entries[0]["type"],"PEAK");
        assert_eq!(entries[0]["label"],"REARING_UNSPECIFIED");
        assert_eq!(entries[0]["annotatorId"],"Reviewer");
        assert_eq!(entries[1]["peakId"],entries[0]["id"]);
        assert_eq!(entries[1]["type"],"PROPOSAL_REVIEW");
        for (field,value) in [("timestampSec",json!(0.16)),("frameIndex",json!(99)),("frameIndex",json!(-1)),("annotatorId",json!(" ")),
            ("decision",json!("automatic")),("label",json!("UNKNOWN")),("label",json!("NON_REARING")),("startSec",json!(0.))] {
            let mut invalid=review.clone();invalid[field]=value;
            assert!(proposal_review_entries(&base,&invalid,&[0.,0.04,0.17],&[]).is_err(),"{field}");
        }
    }
    #[test]
    fn proposal_edits_reuse_human_peak_and_rejection_preserves_history() {
        let base=json!({"trackingJobId":"t","videoSha256":"hash","source":"human"});
        let accept=json!({"frameIndex":0,"timestampSec":0.,"decision":"accept","label":"REARING_SUPPORTED","annotatorId":"B"});
        let peak=json!({"id":"original","type":"PEAK","frameIndex":0,"timestampSec":0.,"label":"REARING_UNSPECIFIED","annotatorId":"A","note":"Original note"});
        let mut history=vec![peak.clone()];
        let edit=proposal_review_entries(&base,&accept,&[0.],&history).unwrap();
        assert_eq!(edit[0]["type"],"LABEL_PEAK");assert_eq!(edit[0]["targetId"],"original");
        assert_eq!(edit[0]["note"],"Original note");assert_eq!(peak["annotatorId"],"A");
        history.extend(edit);
        // Build an explicit rejection rather than a negative interval or UNKNOWN peak.
        let mut reject=accept.clone();reject["decision"]=json!("reject");
        let rejected=proposal_review_entries(&base,&reject,&[0.],&history).unwrap();
        assert_eq!(rejected[0]["type"],"UNDO");assert_eq!(rejected[0]["targetId"],"original");
        assert_eq!(rejected[1]["decision"],"reject");assert!(rejected[1].get("label").is_none());
        history.extend(rejected);
        let restored=proposal_review_entries(&base,&accept,&[0.],&history).unwrap();
        assert_eq!(restored[0]["type"],"PEAK");assert_ne!(restored[0]["id"],"original");
        let negative=proposal_review_entries(&base,&reject,&[0.],&[]).unwrap();
        assert_eq!(negative.len(),1);assert!(negative[0].get("startSec").is_none());assert!(negative[0].get("endSec").is_none());
    }
    #[test]
    fn rejecting_a_proposal_cannot_orphan_an_annotated_episode() {
        let peak=json!({"id":"p","type":"PEAK","frameIndex":0,"timestampSec":0.});
        let interval=json!({"id":"i","type":"INTERVAL","peakId":"p"});
        let review=json!({"decision":"reject","frameIndex":0,"timestampSec":0.,"annotatorId":"A"});
        assert!(proposal_review_entries(&json!({}),&review,&[0.],&[peak.clone(),interval.clone()]).unwrap_err().contains("episódio"));
        assert!(proposal_review_entries(&json!({}),&review,&[0.],&[peak,interval,json!({"type":"UNDO","targetId":"i"})]).is_ok());
    }
    #[test]
    fn proposal_decision_and_peak_commit_atomically_and_survive_reload() {
        let mut db=rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE behavior_annotations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,tracking_job_id TEXT,video_sha256 TEXT,annotation_json TEXT);
            CREATE TRIGGER fail_review BEFORE INSERT ON behavior_annotations WHEN json_extract(NEW.annotation_json,'$.type')='PROPOSAL_REVIEW' BEGIN SELECT RAISE(ABORT,'disk error'); END;").unwrap();
        let base=json!({"trackingJobId":"t","videoSha256":"h","source":"human"});
        let review=json!({"frameIndex":0,"timestampSec":0.,"decision":"accept","annotatorId":"A"});
        assert!(save_proposal_review(&mut db,&base,&review,&[0.]).is_err());
        assert_eq!(db.query_row("SELECT count(*) FROM behavior_annotations",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        db.execute_batch("DROP TRIGGER fail_review").unwrap();
        save_proposal_review(&mut db,&base,&review,&[0.]).unwrap();
        let mut retag=review.clone();retag["label"]=json!("REARING_UNSUPPORTED");
        let entries=save_proposal_review(&mut db,&base,&retag,&[0.]).unwrap();
        assert_eq!(entries[0]["type"],"LABEL_PEAK");
        assert_eq!(db.query_row("SELECT count(*) FROM behavior_annotations WHERE json_extract(annotation_json,'$.type')='PEAK'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let mut reject=review;reject["decision"]=json!("reject");
        let entries=save_proposal_review(&mut db,&base,&reject,&[0.]).unwrap();
        assert_eq!(entries[0]["type"],"UNDO");
        let other=json!({"trackingJobId":"other","videoSha256":"otherhash","source":"human"});
        let entries=save_proposal_review(&mut db,&other,&retag,&[0.]).unwrap();
        assert_eq!(entries[0]["type"],"PEAK"); // Never reuse a peak from another tracking run.
    }
    #[test]
    fn annotation_clock_ignores_features_but_rejects_broken_timing_and_json() {
        let path = std::env::temp_dir().join(format!("behavior-clock-{}.jsonl", new_uuid_v4()));
        let valid = "{\"frameIndex\":0,\"timestampSec\":0,\"features\":{\"contour\":[[1,2],[3,4]]}}\n{\"frameIndex\":1,\"timestampSec\":0.04}\n";
        fs::write(&path, valid).unwrap();
        assert_eq!(extent(&path).unwrap(), (vec![0., 0.04], 0.08));
        for invalid in [
            valid.replace("\"frameIndex\":1", "\"frameIndex\":2"),
            valid.replace("\"timestampSec\":0.04", "\"timestampSec\":0"),
            valid.replace("\"timestampSec\":0.04", "\"timestampSec\":-1"),
            valid.replace("\"timestampSec\":0.04", "\"timestampSec\":null"),
            valid.replace("[[1,2],[3,4]]", "[broken]"),
        ] {
            fs::write(&path, invalid).unwrap();
            assert!(extent(&path).is_err());
        }
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn layered_modules_are_shared_and_apex_import_checks_exact_bytes_and_schema() {
        let names:Vec<_>=layered_modules().iter().map(|(name,_)|*name).collect();
        for name in ["arena.py","layer_video.py","oft_layers.py","oft_continuity.py","temporal_pose/__init__.py","temporal_pose/orientation_viterbi.py","temporal_pose/kalman_smoother.py","oft_layered_pipeline.py","body_axis.py","behavior/rearing_evidence.py","behavior/peak_model.py","behavior/intervention.py"] {
            assert!(names.contains(&name));
        }
        let directory=std::env::temp_dir().join(format!("behavior-apex-integrity-{}",new_uuid_v4()));
        fs::create_dir_all(&directory).unwrap();
        let payload=directory.join("peak_model.json");
        fs::write(&payload,"{\n  \"featureSchema\": \"oft-apex-features-2\"\n}\n").unwrap();
        let manifest=directory.join("manifest.json");
        let value=json!({"modelId":"oft_rearing_apex_v1","featureSchema":"oft-apex-features-2",
            "sizeBytes":fs::metadata(&payload).unwrap().len(),"sha256":video::sha256(&payload).unwrap()});
        fs::write(&manifest,value.to_string()).unwrap();
        assert!(validate_apex_model(&directory).is_ok());
        fs::write(&payload,"{}").unwrap();
        assert!(validate_apex_model(&directory).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn all_behavior_modules_are_packaged() {
        assert!(MODULES.iter().any(|(file, _)| *file == "body_axis.py"));
        for name in [
            "contracts",
            "crop_extractor",
            "event_decoder",
            "metrics",
            "model_registry",
            "motion_features",
            "normalization",
            "observation_quality",
            "onnx_inference",
            "open_field",
            "silhouette_features",
            "temporal_windows",
            "intervention",
            "peak_model",
            "export_dataset",
        ] {
            assert!(MODULES
                .iter()
                .any(|(file, _)| *file == format!("behavior/{name}.py")));
        }
    }
    #[test]
    fn interval_validation_rejects_invalid_and_unknown_labels() {
        assert!(validate_interval(
            &json!({"startSec":0.,"endSec":1.,"label":"REARING_UNSPECIFIED"}),
            2.
        )
        .is_ok());
        for value in [
            json!({"startSec":-1.,"endSec":1.,"label":"UNKNOWN"}),
            json!({"startSec":1.,"endSec":1.,"label":"UNKNOWN"}),
            json!({"startSec":0.,"endSec":3.,"label":"UNKNOWN"}),
            json!({"startSec":0.,"endSec":1.,"label":"rearing"}),
        ] {
            assert!(validate_interval(&value, 2.).is_err());
        }
    }
    #[test]
    fn peak_validation_preserves_vfr_pts_and_append_only_history() {
        let times = [0., 0.04, 0.17, 0.20];
        let peak = json!({"type":"PEAK","id":"p","timestampSec":0.17,"frameIndex":2,"label":"REARING_SUPPORTED"});
        assert!(validate_peak(&peak, &times, &[]).is_ok());
        for (field, value) in [("timestampSec",json!(0.16)),("timestampSec",json!(-1)),("frameIndex",json!(9)),("frameIndex",json!(1.2)),("label",json!("NON_REARING")),("startSec",json!(0.))] {
            let mut invalid=peak.clone(); invalid[field]=value;
            assert!(validate_peak(&invalid, &times, &[]).is_err(), "{field}");
        }
        assert!(validate_peak(&peak, &times, &[peak.clone()]).is_err());
        let edit = json!({"type":"LABEL_PEAK","targetId":"p","label":"REARING_UNSUPPORTED"});
        assert!(validate_peak(&edit, &times, &[peak.clone()]).is_ok());
        assert!(validate_peak(&edit, &times, &[]).is_err());
        let undo = json!({"type":"UNDO","targetId":"p"});
        assert!(validate_peak(&edit, &times, &[peak.clone(),undo.clone()]).is_err());
        assert!(validate_peak(&peak, &times, &[peak.clone(),undo]).is_ok());
        let mut moved=edit.clone(); moved["timestampSec"]=json!(0.2);
        assert!(validate_peak(&moved, &times, &[peak]).is_err());
    }
    #[test]
    fn guided_intervals_require_a_live_apex_inside_the_human_interval() {
        let peak=json!({"type":"PEAK","id":"p","timestampSec":0.17});
        let interval=json!({"startSec":0.04,"endSec":0.2,"label":"REARING_SUPPORTED","peakId":"p"});
        assert!(validate_training_interval(&interval,std::slice::from_ref(&peak)).is_ok());
        assert!(validate_training_interval(&interval,&[]).is_err());
        assert!(validate_training_interval(&interval,&[peak.clone(),json!({"type":"UNDO","targetId":"p"})]).is_err());
        for (key,value) in [("startSec",json!(0.18)),("endSec",json!(0.17)),("label",json!("NON_REARING"))] {
            let mut invalid=interval.clone();invalid[key]=value;
            assert!(validate_training_interval(&invalid,std::slice::from_ref(&peak)).is_err());
        }
        assert!(validate_training_interval(&json!({"label":"NON_REARING","exampleKind":"reflection"}),&[]).is_ok());
        assert!(validate_training_interval(&json!({"label":"REARING_SUPPORTED","exampleKind":"reflection"}),&[]).is_err());
    }
    #[test]
    fn human_pose_requires_source_pts_original_dimensions_and_no_guessed_hidden_points() {
        let mut value=json!({"type":"POSE_FRAME","frameIndex":2,"timestampSec":0.17,"imageWidth":640,"imageHeight":480,"pose":{}});
        for key in ["nose","left_ear","right_ear","body_center","hip","tail_base"] {
            value["pose"][key]=json!({"visibility":"visible","x":100.,"y":120.});
        }
        let times=[0.,0.04,0.17,0.2];
        assert!(validate_pose_annotation(&value,&times,640,480).is_ok());
        for (key,wrong) in [("timestampSec",json!(0.16)),("frameIndex",json!(10)),("imageWidth",json!(320))] {
            let mut invalid=value.clone();invalid[key]=wrong;
            assert!(validate_pose_annotation(&invalid,&times,640,480).is_err());
        }
        for point in [json!({"visibility":"visible","x":640.,"y":120.}),json!({"visibility":"visible","x":-1.,"y":120.}),json!({"visibility":"occluded","x":100.,"y":120.})] {
            let mut invalid=value.clone();invalid["pose"]["nose"]=point;
            assert!(validate_pose_annotation(&invalid,&times,640,480).is_err());
        }
        value["pose"]["nose"]=json!({"visibility":"occluded","x":null,"y":null});
        assert!(validate_pose_annotation(&value,&times,640,480).is_ok());
        value["pose"].as_object_mut().unwrap().remove("tail_base");
        assert!(validate_pose_annotation(&value,&times,640,480).is_err());
    }
    #[test]
    fn reviewed_episodes_cannot_overlap_or_reintroduce_a_rejected_duplicate() {
        let events = json!([
            {"eventId":"first","startSec":1.,"endSec":2.,"behavior":"REARING_UNSPECIFIED","reviewStatus":"pending"},
            {"eventId":"second","startSec":3.,"endSec":4.,"behavior":"REARING_UNSPECIFIED","reviewStatus":"pending"}
        ]);
        let overlap = json!({"type":"CORRECT","eventId":"first","startSec":1.,"endSec":3.5,"label":"REARING_SUPPORTED"});
        assert!(validate_review_overlap(&events, &[], &overlap).is_err());
        let rejected = json!({"type":"REJECT","eventId":"second"});
        assert!(
            validate_review_overlap(&events, std::slice::from_ref(&rejected), &overlap).is_ok()
        );
        let confirm = json!({"type":"CONFIRM","eventId":"second"});
        assert!(validate_review_overlap(&events, &[rejected, overlap], &confirm).is_err());
        let adjacent = json!({"type":"CORRECT","eventId":"first","startSec":1.,"endSec":3.,"label":"REARING_UNSPECIFIED"});
        assert!(validate_review_overlap(&events, &[], &adjacent).is_ok());
    }
}

#[tauri::command]
pub async fn render_behavior_audit_video(app: AppHandle, job_id: String) -> CommandResult<Value> {
    let operation = Operation::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation=operation;
        let result=read_local_behavior_result(app.clone(),job_id.clone())?;
        let manifest=&result["manifest"];
        let experiment=manifest["experimentId"].as_str().ok_or("Experimento ausente")?;
        let tracking_id=manifest["trackingJobId"].as_str().ok_or("Tracking ausente")?;
        let digest=manifest["videoSha256"].as_str().ok_or("Hash ausente")?;
        let (tracking_dir,_,path)=tracking(&app,experiment,tracking_id,digest)?;
        if video::sha256(Path::new(&path))? != digest || video::sha256(&tracking_dir.join("samples.jsonl"))? != manifest["samplesSha256"].as_str().ok_or("Hash do tracking ausente")? {
            return Err("Vídeo ou observações alterados desde a classificação".into());
        }
        let directory=folder(&app,&job_id)?;
        let destination=app.path().app_data_dir().map_err(|_| "Dados indisponíveis")?.join("results").join(format!("{job_id}-behavior-audit.mp4"));
        let mut request=read(&tracking_dir.join("request.json"))?;
        request["behaviorPredictions"]=json!(directory.join("result/frame_predictions.jsonl"));
        request["overlayMetadataRoot"]=json!(directory);
        let saved=directory.join("render_request.json");
        fs::write(&saved,request.to_string()).map_err(|_| "Solicitação indisponível")?;
        // Keep the original tracking directory as the renderer's source, without rewriting it.
        let output=Command::new(crate::local_tracking::python(&app)?).args(["-X","utf8","-c",
            "import json,sys,os; from pathlib import Path; namespace={'__name__':'behavior_render'}; exec(compile(Path(sys.argv[1]).read_text(encoding='utf-8'),sys.argv[1],'exec'),namespace); request=json.loads(Path(sys.argv[2]).read_text()); request['ffmpeg']=sys.argv[5]; parent=os.getppid(); namespace['render'](request,Path(sys.argv[3]),Path(sys.argv[4]),lambda:os.getppid()!=parent)"])
            .arg(directory.join("local_audit_video.py")).arg(&saved).arg(&tracking_dir).arg(&destination).arg(video::binary("ffmpeg").ok_or("FFmpeg ausente")?).output().map_err(|_| "Renderização indisponível")?;
        if !output.status.success() {return Err(String::from_utf8_lossy(&output.stderr).chars().take(1500).collect());}
        Ok(json!({"videoPath":destination}))
    }).await.map_err(|_| "Renderização interrompida".to_string())?
}
#[tauri::command]
pub async fn preview_local_rearing_geometry(
    app: AppHandle, experiment_id: String, tracking_job_id: String, video_sha256: String,
) -> CommandResult<Value> {
    let operation = Operation::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let (tracking_dir, config, _) = tracking(&app, &experiment_id, &tracking_job_id, &video_sha256)?;
        let directory = root(&app)?.join(format!("geometry-preview-{}", new_uuid_v4()));
        materialize(&directory)?;
        // Analyze immutable observations only; no video decoding or model download.
        let request = json!({"config":config, "videoSha256":video_sha256,
            "trackingJobId":tracking_job_id,
            "annotations":read_behavior_annotations(app.clone(), tracking_job_id.clone())?,
            "samples":tracking_dir.join("samples.jsonl")});
        let saved = directory.join("request.json");
        fs::write(&saved, request.to_string()).map_err(|_| "Solicitação indisponível")?;
        let output = Command::new(crate::local_tracking::python(&app)?).current_dir(&directory)
            .args(["-X", "utf8", "-c", "import sys; from behavior.rearing_evidence import run; run(*sys.argv[1:])"])
            .arg(saved).arg(directory.join("candidates.json")).output().map_err(|_| "Análise geométrica indisponível; prepare o ambiente local")?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).chars().take(1500).collect()); }
        let mut result = read(&directory.join("candidates.json"))?;
        result["resultDirectory"] = json!(directory);
        Ok(result)
    }).await.map_err(|_| "Análise geométrica interrompida".to_string())?
}

#[tauri::command]
pub async fn preview_local_rearing_peaks(
    app: AppHandle, experiment_id: String, tracking_job_id: String,
    video_sha256: String, model_directory: String,
) -> CommandResult<Value> {
    let operation = Operation::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let (tracking_dir, _, _) = tracking(&app, &experiment_id, &tracking_job_id, &video_sha256)?;
        let source = if model_directory.trim().is_empty() { root(&app)?.join("models/oft_rearing_apex_v1") } else { PathBuf::from(model_directory.trim()) };
        let source = source.canonicalize().map_err(|_| "Pasta do modelo não encontrada; informe o caminho completo")?;
        if !source.join("manifest.json").is_file() { return Err("Informe a pasta do modelo local de ápices treinado".into()); }
        let directory = root(&app)?.join(format!("apex-preview-{}", new_uuid_v4()));
        materialize(&directory)?;
        let mut request = read(&tracking_dir.join("request.json"))?;
        request["videoSha256"] = json!(video_sha256);
        request["samples"] = json!(tracking_dir.join("samples.jsonl"));
        request["trackingDirectory"] = json!(tracking_dir);
        request["ffmpeg"] = json!(video::binary("ffmpeg").ok_or("FFmpeg ausente")?);
        let saved = directory.join("request.json");
        fs::write(&saved, request.to_string()).map_err(|_| "Solicitação indisponível")?;
        let output = Command::new(crate::local_tracking::python(&app)?).current_dir(&directory)
            .args(["-X", "utf8", "-c", "import sys; from behavior.peak_model import run; run(*sys.argv[1:])"])
            .arg(saved).arg(source).arg(directory.join("candidates.json")).output().map_err(|_| "Modelo local indisponível")?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).chars().take(1500).collect()); }
        let mut result = read(&directory.join("candidates.json"))?;
        result["resultDirectory"] = json!(directory);
        Ok(result)
    }).await.map_err(|_| "Análise de ápices interrompida".to_string())?
}

#[tauri::command]
pub async fn export_behavior_annotations(
    app: AppHandle, experiment_id: String, tracking_job_id: String,
    video_sha256: String, kind: String,
) -> CommandResult<Value> {
    let extension = match kind.as_str() {
        "peaks" | "intervals" | "poses" => "csv",
        "history" => "jsonl",
        _ => return Err("Formato de exportação desconhecido".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        tracking(&app, &experiment_id, &tracking_job_id, &video_sha256)?;
        let annotations = read_behavior_annotations(app.clone(), tracking_job_id)?;
        if annotations.is_empty() { return Err("Salve uma marcação antes de exportar".into()); }
        let directory = root(&app)?.join(format!("export-{}", new_uuid_v4()));
        materialize(&directory)?;
        let results = app.path().app_data_dir().map_err(|_| "Dados indisponíveis")?.join("results");
        fs::create_dir_all(&results).map_err(|_| "Pasta de exportação indisponível")?;
        let destination = results.join(format!("{}-{kind}.{extension}", new_uuid_v4()));
        let partial = destination.with_extension("partial");
        let request = directory.join("request.json");
        let work = (|| -> CommandResult<()> {
            fs::write(&request, json!({"experimentId":experiment_id,"annotations":annotations}).to_string()).map_err(|_| "Solicitação indisponível")?;
            let output = Command::new(crate::local_tracking::python(&app)?).current_dir(&directory)
                .args(["-X", "utf8", "-c", "import sys; from behavior.export_dataset import export_annotations; export_annotations(*sys.argv[1:])"])
                .arg(request).arg(&partial).arg(kind).output().map_err(|_| "Exportação indisponível")?;
            if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).chars().take(1500).collect()); }
            fs::rename(&partial, &destination).map_err(|_| "Não foi possível salvar a exportação")?;
            Ok(())
        })();
        let _ = fs::remove_dir_all(directory);
        if let Err(error) = work { let _ = fs::remove_file(partial); return Err(error); }
        Ok(json!({"path":destination}))
    }).await.map_err(|_| "Exportação interrompida".to_string())?
}

#[tauri::command]
pub fn reveal_behavior_export(app: AppHandle, path: String) -> CommandResult<()> {
    let results = app.path().app_data_dir().map_err(|_| "Dados indisponíveis")?.join("results")
        .canonicalize().map_err(|_| "Pasta de exportação indisponível")?;
    let file = PathBuf::from(path).canonicalize().map_err(|_| "Exportação ausente")?;
    if file.parent() != Some(results.as_path()) || !file.is_file() {
        return Err("Selecione um arquivo de exportação deste aplicativo".into());
    }
    app.opener().reveal_item_in_dir(file).map_err(|_| "Não foi possível mostrar o arquivo".into())
}

#[tauri::command]
pub async fn export_behavior_training_package(
    app: AppHandle,
    experiment_id: String,
    tracking_job_id: String,
    video_sha256: String,
    metadata: Value,
    include_video: bool,
) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tracking_dir,config,path)=tracking(&app,&experiment_id,&tracking_job_id,&video_sha256)?;
        if video::sha256(Path::new(&path))? != video_sha256 {return Err("Vídeo original alterado".into());}
        for key in ["animalId","sessionId","arenaId"] {
            if metadata[key].as_str().is_none_or(|v|v.trim().is_empty()||v.len()>200) {return Err(format!("Identificação ausente: {key}"));}
        }
        let annotations=read_behavior_annotations(app.clone(),tracking_job_id.clone())?;
        let directory=root(&app)?.join(format!("export-{}",new_uuid_v4()));
        materialize(&directory)?;
        let request=json!({"experimentId":experiment_id,"trackingJobId":tracking_job_id,"videoSha256":video_sha256,"video":path,"trackingDirectory":tracking_dir,
            "animalId":metadata["animalId"],"sessionId":metadata["sessionId"],"arenaId":metadata["arenaId"],"condition":metadata["condition"],
            "annotations":annotations,"includeVideo":include_video,"config":config,"ffmpeg":video::binary("ffmpeg").ok_or("FFmpeg ausente")?,"annotationProtocol":include_str!("../../docs/OFT_REARING_ANNOTATION_PROTOCOL.md")});
        fs::write(directory.join("request.json"),request.to_string()).map_err(|_| "Solicitação indisponível")?;
        let results=app.path().app_data_dir().map_err(|_| "Dados indisponíveis")?.join("results");fs::create_dir_all(&results).map_err(|_| "Pasta de exportação indisponível")?;
        let destination=results.join(format!("{}-oft-training.zip",new_uuid_v4()));
        let partial=results.join(format!("{}.partial",new_uuid_v4()));
        let work=(|| -> CommandResult<()> {
            let output=Command::new(crate::local_tracking::python(&app)?).current_dir(&directory).args(["-X","utf8","-m","behavior.export_dataset"]).arg(directory.join("request.json")).arg(&partial).output().map_err(|_| "Exportação indisponível")?;
            if !output.status.success() {return Err(String::from_utf8_lossy(&output.stderr).chars().take(1500).collect());}
            fs::rename(&partial,&destination).map_err(|_| "Publicação da exportação indisponível")?;Ok(())
        })();
        let _=fs::remove_dir_all(directory);
        if let Err(error)=work {let _=fs::remove_file(partial);return Err(error);}
        Ok(json!({"path":destination}))
    }).await.map_err(|_| "Exportação interrompida".to_string())?
}

#[tauri::command]
pub async fn export_behavior_results(app: AppHandle, job_id: String) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        read_local_behavior_result(app.clone(),job_id.clone())?;
        let directory=folder(&app,&job_id)?;
        let reviews=read_behavior_review_events(app.clone(),job_id)?;
        let work=root(&app)?.join(format!("result-export-{}",new_uuid_v4()));materialize(&work)?;
        let review_file=work.join("reviews.json");fs::write(&review_file,json!(reviews).to_string()).map_err(|_| "Revisões indisponíveis")?;
        let results=app.path().app_data_dir().map_err(|_| "Dados indisponíveis")?.join("results");fs::create_dir_all(&results).map_err(|_| "Pasta indisponível")?;
        let destination=results.join(format!("{}-behavior-run.zip",new_uuid_v4()));
        let partial=destination.with_extension("partial");
        let output=Command::new(crate::local_tracking::python(&app)?).current_dir(&work).args(["-X","utf8","-c","import sys; from behavior.export_dataset import export_results; export_results(*sys.argv[1:])"])
            .arg(directory).arg(&partial).arg(review_file).output().map_err(|_| "Exportação indisponível")?;
        let _=fs::remove_dir_all(work);
        if !output.status.success() {let _=fs::remove_file(partial);return Err(String::from_utf8_lossy(&output.stderr).chars().take(1500).collect());}
        fs::rename(&partial,&destination).map_err(|_| "Publicação da exportação indisponível")?;
        Ok(json!({"path":destination}))
    }).await.map_err(|_| "Exportação interrompida".to_string())?
}
