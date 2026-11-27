//! Jobs locais isolados do Colab e dos resultados científicos selecionados.
use crate::{
    colab::{hybrid_bundle_files, hybrid_bundle_paths, new_uuid_v4, validate_local_id, AnalysisArena},
    oauth::{open_database, CommandResult},
    video,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager};

static INSTALLING: AtomicBool = AtomicBool::new(false);
static STARTING: AtomicBool = AtomicBool::new(false);
static RENDERING_SAVED_VIDEO: AtomicBool = AtomicBool::new(false);
const AUDIT_VIDEO_SCRIPT: &str = include_str!("../python/local_audit_video.py");
const WISTAR_STRATEGY: &str = "wistar_hrnet";

struct OperationGuard(&'static AtomicBool);
impl OperationGuard {
    fn acquire(flag: &'static AtomicBool) -> CommandResult<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "Outra preparação local está em andamento")?;
        Ok(Self(flag))
    }
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn root(app: &AppHandle) -> CommandResult<PathBuf> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Dados do app indisponíveis")?
        .join("local-tracking");
    fs::create_dir_all(&root).map_err(|_| "Não foi possível preparar os dados locais")?;
    Ok(root)
}
pub(crate) fn prepare_tables(app: &AppHandle) -> CommandResult<()> {
    open_database(app).map(|_| ())
}
pub(crate) fn python(app: &AppHandle) -> CommandResult<PathBuf> {
    if let Some(path) = std::env::var_os("BEHAVETRACKER_PYTHON") {
        return Ok(path.into());
    }
    Ok(root(app)?.join("venv").join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    }))
}
fn environment(app: &AppHandle) -> CommandResult<Value> {
    let path = python(app)?;
    let result = Command::new(path)
        .args([
            "-c",
            "import cv2,json\ncv2.ocl.setUseOpenCL(cv2.ocl.haveOpenCL())\ngpu=bool(cv2.ocl.useOpenCL() and hasattr(cv2.ocl,'Device') and cv2.ocl.Device.getDefault().type() & cv2.ocl.DEVICE_TYPE_GPU)\nprint(json.dumps({'ready':True,'version':cv2.__version__,'openclAvailable':gpu}))",
        ])
        .output();
    Ok(result.ok().filter(|r|r.status.success()).and_then(|r|serde_json::from_slice(&r.stdout).ok()).unwrap_or(json!({"ready":false,"message":"Prepare o ambiente OpenCV local. Python 3 e ffprobe devem estar instalados."})))
}
#[tauri::command]
pub async fn get_local_tracking_environment(app: AppHandle) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || environment(&app))
        .await
        .map_err(|_| "Verificação interrompida".to_string())?
}
#[tauri::command]
pub async fn setup_local_tracking_environment(app: AppHandle) -> CommandResult<Value> {
    let operation = OperationGuard::acquire(&STARTING)?;
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("A preparação do OpenCV já está em andamento".into());
    }
    let result=tauri::async_runtime::spawn_blocking(move||{
        let _operation=operation;
        prepare_tables(&app)?;
        let active:bool=open_database(&app)?.query_row("SELECT EXISTS(SELECT 1 FROM local_tracking_jobs WHERE state IN ('queued','running'))",[],|row|row.get(0)).map_err(|_|"Consulta local indisponível")?;
        if active{return Err("Aguarde ou cancele a análise local antes de preparar o ambiente".into());}
        if std::env::var_os("BEHAVETRACKER_PYTHON").is_some(){return Err("BEHAVETRACKER_PYTHON está configurado: instale opencv-python-headless nesse ambiente, sem modificar o Python global".into());}
        let base=std::env::var_os("BEHAVETRACKER_SYSTEM_PYTHON").map(PathBuf::from).unwrap_or_else(||PathBuf::from(if cfg!(windows){"python"}else{"python3"}));
        let folder=root(&app)?.join("venv");
        let created=Command::new(base).arg("-m").arg("venv").arg(&folder).output().map_err(|_|"Python 3 não encontrado. Instale Python 3 e abra novamente o app")?;
        if !created.status.success(){return Err("Não foi possível criar um ambiente Python isolado para OpenCV".into());}
        let log=File::create(root(&app)?.join("environment.log")).map_err(|_|"Log local indisponível")?;
        let installed=Command::new(python(&app)?).args(["-m","pip","install","--only-binary=:all:","--disable-pip-version-check","opencv-python-headless==4.13.0.92"]).stdout(Stdio::from(log.try_clone().map_err(|_|"Log indisponível")?)).stderr(Stdio::from(log)).status().map_err(|_|"Não foi possível iniciar pip")?;
        if !installed.success(){return Err("Não foi possível instalar OpenCV. Confira a conexão e o log environment.log no diretório de dados; não desative a verificação TLS".into());}
        environment(&app)
    }).await.map_err(|_|"Preparação interrompida".to_string());
    INSTALLING.store(false, Ordering::SeqCst);
    result?
}
fn folder(app: &AppHandle, job: &str) -> CommandResult<PathBuf> {
    validate_local_id(job, "Execução")?;
    Ok(root(app)?.join(job))
}
fn audit_video_path(app: &AppHandle, job_id: &str) -> CommandResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(|_| "Dados do app indisponíveis")?
        .join("results").join(format!("{job_id}-local-audit.mp4")))
}
fn read_json(path: &std::path::Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}
fn validate_config(config: &Value) -> CommandResult<()> {
    let width = config["width"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 16384)
        .ok_or("Largura inválida")?;
    let height = config["height"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 16384)
        .ok_or("Altura inválida")?;
    if !["auto", "light", "dark", "background"].contains(&config["mode"].as_str().unwrap_or("")) {
        return Err("Modo de segmentação inválido".into());
    }
    let strategy = match config.get("strategy") {
        None => "classic",
        Some(value) => value.as_str().ok_or("Estratégia local inválida")?,
    };
    if !["classic", "classical_roi_v1", "hybrid_kalman_v1", "ram_color_geometry_v2"].contains(&strategy) {
        return Err("Estratégia local inválida".into());
    }
    if strategy == "classical_roi_v1" && (config["mode"] != "auto" || config["referenceApproved"] != false
        || !["open_field", "radial_arm_maze"].contains(&config["protocol"].as_str().unwrap_or(""))
        || config.get("guidance").is_some_and(|value| !value.is_null())) {
        return Err("OpenCV rápido exige Campo Aberto ou RAM, referência automática e revisão independente".into());
    }
    if config.get("autorotate").is_some_and(|value| !value.is_boolean()) {
        return Err("Orientação local inválida".into());
    }
    if strategy == "ram_color_geometry_v2" {
        if config["protocol"] != "radial_arm_maze" || config["referenceApproved"] != false
            || config["walkablePolygonPx"].as_array().is_none_or(|p| p.len() < 3)
            || config.get("guidance").is_some_and(|v| !v.is_null()) {
            return Err("RAM Color exige protocolo RAM, contorno e revisão independente".into());
        }
        for (key, min, max) in [("valueMin",0.,254.),("saturationMin",0.,254.),("labBMin",0.,254.),
            ("minAreaPx",1.,10000000.),("maxAreaPx",2.,10000000.),("minDensity",0.01,1.),
            ("maxSpeedFraction",0.001,10.),("reacquireSec",0.01,2.),("ambiguityMargin",0.,10.)] {
            if !config["ramColor"][key].as_f64().is_some_and(|n| n.is_finite() && n >= min && n <= max) {
                return Err(format!("Parâmetro RAM Color inválido: {key}"));
            }
        }
        if config["ramColor"]["minAreaPx"].as_f64() >= config["ramColor"]["maxAreaPx"].as_f64() {
            return Err("Área corporal RAM inválida".into());
        }
    }
    if strategy == "hybrid_kalman_v1" && (config["mode"] != "background" || config["referenceApproved"] != false
        || config.get("guidance").is_some_and(|value| !value.is_null())) {
        return Err("O teste híbrido exige fundo fixo, revisão obrigatória e não aceita guias de outra execução".into());
    }
    for (key, min, max) in [
        ("threshold", 1., 254.),
        ("minAreaFraction", 0.00001, 0.2),
        ("maxAreaFraction", 0.0001, 0.5),
        ("maxWidth", 160., 4096.),
        ("maxPredictionSec", 0., 0.5),
    ] {
        let n = config[key]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= min && *n <= max)
            .ok_or_else(|| format!("Parâmetro {key} inválido"))?;
        let _ = n;
    }
    if config["minAreaFraction"].as_f64() >= config["maxAreaFraction"].as_f64() {
        return Err("A área mínima deve ser menor que a máxima".into());
    }
    for key in ["cornersPx", "rimCornersPx"] {
        if config["arena"][key].is_null() && key == "rimCornersPx" {
            continue;
        }
        let points = config["arena"][key]
            .as_array()
            .filter(|p| p.len() == 4)
            .ok_or("Calibre os quatro vértices da arena")?;
        for p in points {
            if !p["x"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0. && n <= width as f64)
                || !p["y"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n >= 0. && n <= height as f64)
            {
                return Err("Arena fora da imagem".into());
            }
        }
        let mut sign = 0.;
        for index in 0..4 {
            let a = &points[index];
            let b = &points[(index + 1) % 4];
            let c = &points[(index + 2) % 4];
            let cross = (b["x"].as_f64().unwrap() - a["x"].as_f64().unwrap())
                * (c["y"].as_f64().unwrap() - b["y"].as_f64().unwrap())
                - (b["y"].as_f64().unwrap() - a["y"].as_f64().unwrap())
                    * (c["x"].as_f64().unwrap() - b["x"].as_f64().unwrap());
            if cross.abs() < 1. || (sign != 0. && cross.signum() != sign) {
                return Err(
                    "Arena deve formar um quadrilátero convexo, sem vértices cruzados".into(),
                );
            }
            sign = cross.signum();
        }
    }
    if let Some(polygon) = config.get("walkablePolygonPx") {
        let points = polygon.as_array().filter(|p| (3..=256).contains(&p.len()))
            .ok_or("Contorno RAM inválido")?;
        for point in points {
            if !point["x"].as_f64().is_some_and(|n| n.is_finite() && n >= 0. && n <= width as f64)
                || !point["y"].as_f64().is_some_and(|n| n.is_finite() && n >= 0. && n <= height as f64) {
                return Err("Contorno RAM fora do vídeo".into());
            }
        }
    }
    if let Some(points) = config["walkablePolygonPx"].as_array() {
        let coords: Vec<(f64,f64)> = points.iter().map(|p| (p["x"].as_f64().unwrap(),p["y"].as_f64().unwrap())).collect();
        let turn = |a:(f64,f64), b:(f64,f64), c:(f64,f64)| (b.0-a.0)*(c.1-a.1)-(b.1-a.1)*(c.0-a.0);
        let area: f64 = coords.iter().enumerate().map(|(i,a)| { let b=coords[(i+1)%coords.len()]; a.0*b.1-b.0*a.1 }).sum();
        if area.abs() < 20. { return Err("Contorno RAM sem área suficiente".into()); }
        for i in 0..coords.len() {
            if coords[i] == coords[(i+1)%coords.len()] { return Err("Contorno RAM com vértices repetidos".into()); }
            for j in i+1..coords.len() {
                if j==i+1 || (i==0 && j==coords.len()-1) { continue; }
                let (a,b,c,d)=(coords[i],coords[(i+1)%coords.len()],coords[j],coords[(j+1)%coords.len()]);
                if turn(a,b,c)*turn(a,b,d) < 0. && turn(c,d,a)*turn(c,d,b) < 0. {
                    return Err("Contorno RAM com lados cruzados".into());
                }
            }
        }
    }
    if let Some(seed) = config.get("seed").filter(|s| !s.is_null()) {
        if !seed["x"]
            .as_f64()
            .is_some_and(|n| n >= 0. && n <= width as f64)
            || !seed["y"]
                .as_f64()
                .is_some_and(|n| n >= 0. && n <= height as f64)
        {
            return Err("Posição inicial fora da imagem".into());
        }
    }
    if let Some(b) = config.get("initialBox").filter(|b| !b.is_null()) {
        let x = b["x"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.)
            .ok_or("Caixa inicial inválida")?;
        let y = b["y"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.)
            .ok_or("Caixa inicial inválida")?;
        let w = b["width"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 3.)
            .ok_or("Caixa inicial muito pequena")?;
        let h = b["height"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 3.)
            .ok_or("Caixa inicial muito pequena")?;
        if x + w > width as f64 || y + h > height as f64 {
            return Err("Caixa inicial fora da imagem".into());
        }
    }
    if strategy == "hybrid_kalman_v1" && config.get("initialBox").is_none_or(|value| value.is_null()) {
        return Err("Marque a caixa do animal no primeiro frame do teste híbrido".into());
    }
    if let Some(guidance) = config.get("guidance").filter(|value| !value.is_null()) {
        let source = guidance["sourceJobId"].as_str().ok_or("Execução de origem ausente")?;
        validate_local_id(source, "Execução de origem")?;
        let anchors = guidance["anchors"].as_array().filter(|items| (2..=5000).contains(&items.len()))
            .ok_or("A continuação precisa de 2 a 5000 caixas humanas")?;
        let mut previous_frame = None;
        let mut previous_time = None;
        for anchor in anchors {
            let frame = anchor["frameIndex"].as_u64().filter(|value| *value <= 2_000_000).ok_or("Frame manual inválido")?;
            let time = anchor["timestampSec"].as_f64().filter(|value| value.is_finite() && *value >= 0.).ok_or("Tempo manual inválido")?;
            if previous_frame.is_some_and(|value| frame <= value) || previous_time.is_some_and(|value| time <= value) {
                return Err("Caixas humanas devem estar em frames e tempos crescentes".into());
            }
            validate_local_id(anchor["eventId"].as_str().ok_or("ID da correção ausente")?, "Correção")?;
            let b = &anchor["box"];
            let x = b["x"].as_f64().filter(|value| value.is_finite() && *value >= 0.).ok_or("Caixa humana inválida")?;
            let y = b["y"].as_f64().filter(|value| value.is_finite() && *value >= 0.).ok_or("Caixa humana inválida")?;
            let w = b["width"].as_f64().filter(|value| value.is_finite() && *value >= 3.).ok_or("Caixa humana muito pequena")?;
            let h = b["height"].as_f64().filter(|value| value.is_finite() && *value >= 3.).ok_or("Caixa humana muito pequena")?;
            if x + w > width as f64 || y + h > height as f64 { return Err("Caixa humana fora da imagem".into()); }
            previous_frame = Some(frame);
            previous_time = Some(time);
        }
        if previous_time.unwrap() - anchors[0]["timestampSec"].as_f64().unwrap() < 1. {
            return Err("Marque ao menos 1 segundo de caixas humanas".into());
        }
    }
    if config["mode"] == "background"
        && !config["backgroundFrameIndex"]
            .as_u64()
            .is_some_and(|n| n <= 2_000_000)
    {
        return Err("Selecione um frame de fundo vazio".into());
    }
    if !config["referenceApproved"].is_boolean() {
        return Err("Confirme a política da referência 2D".into());
    }
    Ok(())
}
fn verify_guidance_frames(path: &std::path::Path, anchors: &[Value]) -> CommandResult<()> {
    let file = File::open(path).map_err(|_| "Resultado de origem indisponível")?;
    let mut next = 0;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|_| "Resultado de origem ilegível")?;
        let sample: Value = serde_json::from_str(&line).map_err(|_| "Resultado de origem inválido")?;
        let frame = sample["frameIndex"].as_u64().ok_or("Frame da origem inválido")?;
        let expected = anchors[next]["frameIndex"].as_u64().unwrap();
        if frame > expected { return Err("Caixa manual aponta para um frame ausente na origem".into()); }
        if frame == expected {
            let time = sample["timestampSec"].as_f64().ok_or("Tempo da origem inválido")?;
            let annotated = anchors[next]["timestampSec"].as_f64().unwrap();
            if sample["keypoint"]!="box_center" || !time.is_finite() || (time-annotated).abs() > 0.002 {
                return Err("Caixa manual não corresponde ao relógio do vídeo de origem".into());
            }
            next += 1;
            if next == anchors.len() { return Ok(()); }
        }
    }
    Err("Caixa manual aponta para além do vídeo de origem".into())
}
#[tauri::command]
pub async fn start_local_tracking(
    app: AppHandle,
    experiment_id: String,
    upload_id: String,
    mut config: Value,
    optimize_video: Option<bool>,
    expected_video_sha256: Option<String>,
) -> CommandResult<Value> {
    validate_local_id(&experiment_id, "Experimento")?;
    validate_local_id(&upload_id, "Upload")?;
    validate_config(&config)?;
    prepare_tables(&app)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=OperationGuard::acquire(&STARTING)?;
        if INSTALLING.load(Ordering::SeqCst)||environment(&app)?["ready"]!=true{return Err("Prepare o OpenCV local antes de iniciar".into());}
        let ffprobe=video::binary("ffprobe").ok_or("ffprobe não encontrado. Instale FFmpeg para preservar os timestamps")?;
        let ffmpeg=video::binary("ffmpeg").ok_or("FFmpeg não encontrado. Instale FFmpeg para decodificar o vídeo")?;
        let connection=open_database(&app)?;
        let active:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM local_tracking_jobs WHERE state IN ('queued','running'))",[],|r|r.get(0)).map_err(|_|"Consulta local indisponível")?;
        if active{return Err("Aguarde ou cancele a análise local ativa".into());}
        let optimize_video = optimize_video.unwrap_or(false);
        let requested_id = upload_id;
        let upload_id = if optimize_video {
            video::original_upload_id(&connection, &requested_id)?
        } else {
            requested_id.clone()
        };
        let (mut path,digest,size):(String,String,i64)=connection.query_row("SELECT local_path,sha256,expected_size FROM video_staging WHERE upload_id=?1 AND experiment_id=?2 AND ready=1",params![upload_id,experiment_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"Selecione o vídeo original")?;
        if size<=0||fs::metadata(&path).map_err(|_|"Cache do vídeo ausente")?.len()!=size as u64||video::sha256(std::path::Path::new(&path))?!=digest{return Err("Cache do vídeo alterado; selecione novamente o original".into());}
        if expected_video_sha256.is_some_and(|expected| expected != digest) {
            return Err("O SHA-256 não corresponde ao vídeo original do experimento.".into());
        }
        if let Some(guidance) = config.get("guidance").filter(|value| !value.is_null()) {
            let source = guidance["sourceJobId"].as_str().ok_or("Execução de origem ausente")?;
            let (state,source_digest):(String,String)=connection.query_row(
                "SELECT state,video_sha256 FROM local_tracking_jobs WHERE job_id=?1 AND experiment_id=?2",
                params![source,experiment_id],|r|Ok((r.get(0)?,r.get(1)?)))
                .map_err(|_|"Execução manual de origem não encontrada")?;
            if state!="succeeded" || source_digest!=digest {return Err("A revisão manual não pertence a uma execução concluída deste vídeo".into());}
            verify_guidance_frames(&folder(&app,source)?.join("samples.jsonl"),guidance["anchors"].as_array().unwrap())?;
        }
        if optimize_video && size as u64 > video::QUALITY_THRESHOLD_BYTES {
            let width = config["width"].as_u64().unwrap() as u32;
            let height = config["height"].as_u64().unwrap() as u32;
            let prepared = video::prepare_staged_video_with_progress(
                &app, &upload_id, width, height, false, &mut |phase, percent, remaining_sec| {
                    video::emit_preparation_progress(&app, &requested_id, phase, percent, remaining_sec);
                },
            )?;
            if prepared.status == "optimized" {
                let (prepared_path, prepared_digest): (String, String) = connection.query_row(
                    "SELECT local_path,sha256 FROM video_staging WHERE upload_id=?1 AND experiment_id=?2 AND ready=1",
                    params![prepared.upload_id,experiment_id], |row| Ok((row.get(0)?,row.get(1)?)),
                ).map_err(|_| "Cópia otimizada indisponível")?;
                if video::sha256(std::path::Path::new(&prepared_path))? != prepared_digest {
                    return Err("O cache da cópia otimizada está alterado.".into());
                }
                path = prepared_path;
            }
            config["videoPreparation"] = json!(prepared);
        }
        let id=new_uuid_v4();let directory=folder(&app,&id)?;fs::create_dir_all(&directory).map_err(|_|"Pasta da execução indisponível")?;
        let mut request=json!({"video":path,"config":config,"ffprobe":ffprobe,"ffmpeg":ffmpeg,"auditVideo":audit_video_path(&app,&id)?});
        if config["protocol"] == "open_field" {
            request["rearingModelDirectory"] = json!(crate::local_behavior::apex_model_path(&app)?);
        }
        fs::write(directory.join("request.json"),request.to_string()).map_err(|_|"Solicitação local indisponível")?;
        fs::write(directory.join("local_audit_video.py"), AUDIT_VIDEO_SCRIPT).map_err(|_|"Gerador de vídeo de auditoria indisponível")?;
        fs::write(directory.join("engine.py"),include_str!("../python/opencv_engine.py")).map_err(|_|"Motor local indisponível")?;
        crate::local_behavior::materialize_tracking_quality(&directory)?;
        fs::write(directory.join("ram_color.py"), include_str!("../python/ram_color.py"))
            .map_err(|_| "Motor RAM Color indisponível")?;
        connection.execute("INSERT INTO local_tracking_jobs(job_id,experiment_id,upload_id,video_sha256,config_json,state) VALUES (?1,?2,?3,?4,?5,'queued')",params![id,experiment_id,upload_id,digest,config.to_string()]).map_err(|_|"Não foi possível registrar a execução")?;
        let created_at:String=connection.query_row("SELECT created_at FROM local_tracking_jobs WHERE job_id=?1",[&id],|row|row.get(0)).map_err(|_|"Data da execução indisponível")?;
        let task_app=app.clone();let task_id=id.clone();
        tauri::async_runtime::spawn_blocking(move||{
            let work=(||->CommandResult<()>{
                let log=File::create(directory.join("engine.log")).map_err(|_|"Log indisponível")?;
                open_database(&task_app)?.execute("UPDATE local_tracking_jobs SET state='running' WHERE job_id=?1",[&task_id]).map_err(|_|"Estado indisponível")?;
                let status=Command::new(python(&task_app)?).arg("-u").arg(directory.join("engine.py")).arg(directory.join("request.json")).stdout(Stdio::from(log.try_clone().map_err(|_|"Log indisponível")?)).stderr(Stdio::from(log)).status().map_err(|_|"Não foi possível iniciar o motor local")?;
                let report=read_json(&directory.join("status.json")).ok_or("Motor terminou sem confirmar resultado")?;
                let state=report["state"].as_str().filter(|s|["succeeded","cancelled","failed"].contains(s)).ok_or("Estado terminal local inválido")?;
                if !status.success()&&state!="failed"{return Err("Motor local interrompido".into());}
                open_database(&task_app)?.execute("UPDATE local_tracking_jobs SET state=?2,error=?3 WHERE job_id=?1",params![task_id,state,report["error"].as_str()]).map_err(|_|"Não foi possível salvar resultado")?;Ok(())
            })();
            if let Err(error)=work {if let Ok(db)=open_database(&task_app){let _=db.execute("UPDATE local_tracking_jobs SET state='failed',error=?2 WHERE job_id=?1",params![task_id,error]);}}
        });
        Ok(json!({"jobId":id,"state":"queued","config":config,"videoSha256":digest,"experimentId":experiment_id,"createdAt":created_at,"uploadId":upload_id}))
    }).await.map_err(|_|"Inicialização interrompida".to_string())?
}

fn wistar_python(app: &AppHandle) -> CommandResult<PathBuf> {
    if let Some(path) = std::env::var_os("BEHAVETRACKER_WISTAR_PYTHON") {
        return Ok(path.into());
    }
    Ok(root(app)?.join("wistar-venv").join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    }))
}

#[tauri::command]
pub async fn start_local_wistar(
    app: AppHandle,
    experiment_id: String,
    upload_id: String,
    original_sha256: String,
    width: u32,
    height: u32,
    arena: AnalysisArena,
    model_bundle_id: String,
) -> CommandResult<Value> {
    validate_local_id(&experiment_id, "Experimento")?;
    validate_local_id(&upload_id, "Upload")?;
    let model_hashes = hybrid_bundle_files(&model_bundle_id)?
        .into_iter().map(|(name, _, digest)| (name, digest)).collect::<std::collections::BTreeMap<_, _>>();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = OperationGuard::acquire(&STARTING)?;
        let connection = open_database(&app)?;
        let active: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_tracking_jobs WHERE state IN ('queued','running'))",
            [], |row| row.get(0),
        ).map_err(|_| "Consulta local indisponível")?;
        if active { return Err("Aguarde ou cancele a análise local ativa".into()); }
        let original_id = video::original_upload_id(&connection, &upload_id)?;
        let (path, size, digest, source_digest, report): (String, i64, String, String, String) = connection.query_row(
            "SELECT s.local_path,s.expected_size,s.sha256,o.sha256,p.report_json
             FROM video_preparations p
             JOIN video_staging s ON s.upload_id=p.prepared_upload_id
             JOIN video_staging o ON o.upload_id=p.original_upload_id
             WHERE p.original_upload_id=?1 AND s.upload_id=?2 AND s.experiment_id=?3
               AND o.experiment_id=?3 AND s.ready=1 AND o.ready=1",
            params![original_id, upload_id, experiment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).map_err(|_| "Vídeo preparado do experimento indisponível")?;
        if original_sha256 != source_digest {
            return Err("O SHA-256 não corresponde ao vídeo original do experimento.".into());
        }
        if size <= 0 || fs::metadata(&path).map_err(|_| "Cache do vídeo ausente")?.len() != size as u64
            || video::sha256(std::path::Path::new(&path))? != digest {
            return Err("O cache do vídeo preparado foi alterado.".into());
        }
        let preparation: video::VideoPreparation = serde_json::from_str(&report)
            .map_err(|_| "Metadados do vídeo preparado inválidos")?;
        let upload_width = preparation.upload_width.unwrap_or(width);
        let upload_height = preparation.upload_height.unwrap_or(height);
        if width > 16384 || height > 16384 || upload_width > width || upload_height > height {
            return Err("Resolução do vídeo preparado inválida".into());
        }
        arena.validate_geometry(upload_width, upload_height)?;
        let ffmpeg = video::binary("ffmpeg").ok_or("FFmpeg não encontrado. Instale FFmpeg para gerar o vídeo anotado.")?;
        let directory = root(&app)?;
        let config = json!({"strategy": WISTAR_STRATEGY, "modelBundleId": model_bundle_id,
            "width": width, "height": height, "arena": arena, "videoPreparation": preparation});
        let id = new_uuid_v4();
        let job_directory = folder(&app, &id)?;
        fs::create_dir_all(job_directory.join("hybrid")).map_err(|_| "Pasta da execução indisponível")?;
        for (filename, content) in [
            ("local_wistar.py", include_str!("../python/local_wistar.py")),
            ("hybrid_pipeline.py", include_str!("../python/hybrid_pipeline.py")),
            ("hybrid/detector_wistar.py", include_str!("../python/hybrid/detector_wistar.py")),
            ("hybrid_render.py", include_str!("../python/hybrid_render.py")),
            ("model_delivery.py", include_str!("../python/model_delivery.py")),
            ("bundle.json", include_str!("../../models/wistar_df_v2/manifest.json")),
            ("pytorch_config.yaml", include_str!("../../models/wistar_df_v2/pytorch_config.yaml")),
            ("engine.py", include_str!("../python/opencv_engine.py")),
        ] {
            fs::write(job_directory.join(filename), content).map_err(|_| "Motor Wistar local indisponível")?;
        }
        crate::local_behavior::materialize_tracking_quality(&job_directory)?;
        connection.execute(
            "INSERT INTO local_tracking_jobs(job_id,experiment_id,upload_id,video_sha256,config_json,state) VALUES (?1,?2,?3,?4,?5,'queued')",
            params![id, experiment_id, original_id, source_digest, config.to_string()],
        ).map_err(|_| "Não foi possível registrar a execução Wistar")?;
        let created_at: String = connection.query_row(
            "SELECT created_at FROM local_tracking_jobs WHERE job_id=?1", [&id], |row| row.get(0),
        ).map_err(|_| "Data da execução indisponível")?;
        let task_id = id.clone();
        let task_config = config.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let work = (|| -> CommandResult<()> {
                let db = open_database(&app)?;
                db.execute("UPDATE local_tracking_jobs SET state='running' WHERE job_id=?1", [&task_id])
                    .map_err(|_| "Estado da análise Wistar indisponível")?;
                let models = hybrid_bundle_paths(&app, &model_bundle_id);
                let model_dir = match models {
                    Ok(files) => std::path::Path::new(&files[0].1).parent().map(std::path::Path::to_path_buf),
                    Err(error) if model_bundle_id != "wistar_df_v2" => return Err(error),
                    Err(_) => None,
                };
                let request = json!({"video": path, "config": task_config, "preparedSha256": digest,
                    "appData": app.path().app_data_dir().map_err(|_| "Dados do app indisponíveis")?,
                    "runtime": directory.join("wistar-venv"), "models": model_dir, "modelHashes": model_hashes,
                    "rearingModelDirectory": crate::local_behavior::apex_model_path(&app)?,
                    "ffmpeg": ffmpeg, "auditVideo": audit_video_path(&app, &task_id)?});
                let request_file = job_directory.join("request.json");
                fs::write(&request_file, request.to_string()).map_err(|_| "Solicitação Wistar indisponível")?;
                let log = File::create(job_directory.join("engine.log")).map_err(|_| "Log indisponível")?;
                let override_python = std::env::var_os("BEHAVETRACKER_WISTAR_PYTHON");
                let (program, mode) = match override_python {
                    Some(python) => (python, "analyze"),
                    None => (std::env::var_os("BEHAVETRACKER_BOOTSTRAP_PYTHON").unwrap_or_else(|| {
                        if cfg!(windows) { "python".into() } else { "python3".into() }
                    }), "prepare"),
                };
                let status = Command::new(program).args(["-X", "utf8", "-u"])
                    .arg(job_directory.join("local_wistar.py")).arg(request_file).arg(mode)
                    .stdout(Stdio::from(log.try_clone().map_err(|_| "Log indisponível")?))
                    .stderr(Stdio::from(log)).status()
                    .map_err(|_| "Python não encontrado. Instale Python 3.10 a 3.13 de 64 bits para usar Wistar local.")?;
                if !status.success() { return Err("O processo Wistar local foi interrompido. Consulte engine.log.".into()); }
                let report = read_json(&job_directory.join("status.json")).ok_or("O motor Wistar terminou sem confirmar resultado")?;
                let state = report["state"].as_str().filter(|state| ["succeeded", "cancelled", "failed"].contains(state))
                    .ok_or("Estado terminal Wistar inválido")?;
                db.execute("UPDATE local_tracking_jobs SET state=?2,error=?3 WHERE job_id=?1",
                    params![task_id, state, report["error"].as_str()]).map_err(|_| "Não foi possível salvar resultado Wistar")?;
                Ok(())
            })();
            if let Err(error) = work {
                if let Ok(db) = open_database(&app) {
                    let _ = db.execute("UPDATE local_tracking_jobs SET state='failed',error=?2 WHERE job_id=?1", params![task_id, error]);
                }
            }
        });
        Ok(json!({"jobId": id, "state": "queued", "config": config, "videoSha256": source_digest,
            "experimentId": experiment_id, "createdAt": created_at, "uploadId": original_id}))
    }).await.map_err(|_| "Inicialização Wistar interrompida".to_string())?
}

#[tauri::command]
pub async fn get_local_wistar_result(app: AppHandle, job_id: String) -> CommandResult<Option<Value>> {
    let directory = folder(&app, &job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let db = open_database(&app)?;
        let (state, config): (String, String) = db.query_row(
            "SELECT state,config_json FROM local_tracking_jobs WHERE job_id=?1", [&job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "Execução local não encontrada")?;
        let config: Value = serde_json::from_str(&config).map_err(|_| "Configuração local inválida")?;
        if config["strategy"] != WISTAR_STRATEGY { return Ok(None); }
        let report = read_json(&directory.join("status.json")).ok_or("Resultado Wistar ainda indisponível")?;
        if !["succeeded", "running"].contains(&state.as_str()) || report["state"] != "succeeded" {
            return Err("Somente execuções concluídas podem ser usadas como resultado".into());
        }
        let path = directory.join("canonical_pose.csv");
        if fs::metadata(&path).map_err(|_| "CSV Wistar indisponível")?.len() > 256 * 1024 * 1024 {
            return Err("O resultado Wistar excede 256 MiB".into());
        }
        let csv = fs::read_to_string(path).map_err(|_| "CSV Wistar indisponível")?;
        Ok(Some(json!({"csv": csv, "width": config["width"], "height": config["height"],
            "preparation": config["videoPreparation"]})))
    }).await.map_err(|_| "Leitura Wistar interrompida".to_string())?
}

fn validate_fst_config(config: &Value) -> CommandResult<()> {
    if config["protocol"] != "forced_swim" { return Err("Protocolo local FST inválido".into()); }
    let width = config["width"].as_u64().filter(|n| (80..=16384).contains(n)).ok_or("Largura inválida")?;
    let height = config["height"].as_u64().filter(|n| (80..=16384).contains(n)).ok_or("Altura inválida")?;
    let tanks = config["tanks"].as_array().filter(|items| (1..=2).contains(&items.len())).ok_or("Informe um ou dois cilindros")?;
    let subjects = config["subjects"].as_array().filter(|items| items.len() == tanks.len()).ok_or("Sujeitos e cilindros não correspondem")?;
    for (tank, subject) in tanks.iter().zip(subjects) {
        let animal_id = tank["animalId"].as_str().filter(|s| !s.is_empty() && s.len() < 80).ok_or("Animal FST inválido")?;
        let subject_id = tank["subjectId"].as_str().filter(|s| !s.is_empty() && s.len() < 80).ok_or("Sujeito FST inválido")?;
        if subject["animalId"].as_str() != Some(animal_id) || subject["subjectId"].as_str() != Some(subject_id) {
            return Err("Sujeitos e cilindros não correspondem".into());
        }
        let roi = &tank["roiPx"];
        let x = roi["x"].as_u64().ok_or("ROI FST inválida")?;
        let y = roi["y"].as_u64().ok_or("ROI FST inválida")?;
        let w = roi["width"].as_u64().filter(|n| *n >= 80).ok_or("ROI FST muito pequena")?;
        let h = roi["height"].as_u64().filter(|n| *n >= 80).ok_or("ROI FST muito pequena")?;
        if x.checked_add(w).is_none_or(|right| right > width)
            || y.checked_add(h).is_none_or(|bottom| bottom > height)
            || h as f64 / (height as f64) < 0.55 {
            return Err("ROI FST fora do cilindro ou do vídeo".into());
        }
    }
    if tanks.len() == 2 {
        if tanks[0]["animalId"] == tanks[1]["animalId"] || tanks[0]["subjectId"] == tanks[1]["subjectId"] {
            return Err("Cilindros FST precisam de sujeitos distintos".into());
        }
        let a = &tanks[0]["roiPx"]; let b = &tanks[1]["roiPx"];
        let overlap_x = (a["x"].as_u64().unwrap() + a["width"].as_u64().unwrap()).min(b["x"].as_u64().unwrap() + b["width"].as_u64().unwrap())
            .saturating_sub(a["x"].as_u64().unwrap().max(b["x"].as_u64().unwrap()));
        let overlap_y = (a["y"].as_u64().unwrap() + a["height"].as_u64().unwrap()).min(b["y"].as_u64().unwrap() + b["height"].as_u64().unwrap())
            .saturating_sub(a["y"].as_u64().unwrap().max(b["y"].as_u64().unwrap()));
        if overlap_x > 0 && overlap_y > 0 { return Err("Cilindros FST sobrepostos".into()); }
    }
    Ok(())
}

#[tauri::command]
pub async fn start_local_fst(app: AppHandle, experiment_id: String, upload_id: String, config: Value) -> CommandResult<Value> {
    validate_local_id(&experiment_id, "Experimento")?;
    validate_local_id(&upload_id, "Upload")?;
    validate_fst_config(&config)?;
    prepare_tables(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = OperationGuard::acquire(&STARTING)?;
        if INSTALLING.load(Ordering::SeqCst) || environment(&app)?["ready"] != true {
            return Err("Prepare o OpenCV local antes de iniciar".into());
        }
        let ffprobe = video::binary("ffprobe").ok_or("ffprobe não encontrado")?;
        let ffmpeg = video::binary("ffmpeg").ok_or("FFmpeg não encontrado")?;
        let db = open_database(&app)?;
        let active: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM local_tracking_jobs WHERE state IN ('queued','running'))", [], |r| r.get(0))
            .map_err(|_| "Consulta local indisponível")?;
        if active { return Err("Aguarde ou cancele a análise local ativa".into()); }
        let (path, digest, size): (String, String, i64) = db.query_row(
            "SELECT local_path,sha256,expected_size FROM video_staging WHERE upload_id=?1 AND experiment_id=?2 AND ready=1",
            params![upload_id, experiment_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|_| "Selecione o vídeo original")?;
        if size <= 0 || fs::metadata(&path).map_err(|_| "Vídeo local ausente")?.len() != size as u64
            || video::sha256(std::path::Path::new(&path))? != digest {
            return Err("Vídeo local alterado; selecione novamente o original".into());
        }
        let id = new_uuid_v4();
        let directory = folder(&app, &id)?;
        fs::create_dir_all(&directory).map_err(|_| "Pasta local indisponível")?;
        let mut run_config = config;
        run_config["jobId"] = json!(id);
        run_config["videoSha256"] = json!(digest);
        let request = json!({"video":path,"config":run_config,"ffprobe":ffprobe,"ffmpeg":ffmpeg,"auditVideo":audit_video_path(&app,&id)?});
        fs::write(directory.join("request.json"), request.to_string()).map_err(|_| "Solicitação local indisponível")?;
        fs::write(directory.join("local_audit_video.py"), AUDIT_VIDEO_SCRIPT).map_err(|_|"Gerador de vídeo de auditoria indisponível")?;
        fs::write(directory.join("fst_engine.py"), include_str!("../python/local_fst_engine.py")).map_err(|_| "Motor FST indisponível")?;
        fs::write(directory.join("fst_presence.py"), include_str!("../python/fst_presence.py")).map_err(|_| "Presença FST indisponível")?;
        fs::write(directory.join("engine.py"), include_str!("../python/opencv_engine.py")).map_err(|_| "Leitura de vídeo indisponível")?;
        crate::local_behavior::materialize_tracking_quality(&directory)?;
        db.execute("INSERT INTO local_tracking_jobs(job_id,experiment_id,upload_id,video_sha256,config_json,state) VALUES (?1,?2,?3,?4,?5,'queued')",
            params![id, experiment_id, upload_id, digest, run_config.to_string()]).map_err(|_| "Não foi possível registrar FST local")?;
        let created_at: String = db.query_row("SELECT created_at FROM local_tracking_jobs WHERE job_id=?1", [&id], |r| r.get(0))
            .map_err(|_| "Data da execução indisponível")?;
        let task_app = app.clone(); let task_id = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let work = (|| -> CommandResult<()> {
                let log = File::create(directory.join("engine.log")).map_err(|_| "Log indisponível")?;
                open_database(&task_app)?.execute("UPDATE local_tracking_jobs SET state='running' WHERE job_id=?1", [&task_id])
                    .map_err(|_| "Estado local indisponível")?;
                let status = Command::new(python(&task_app)?).arg("-u").arg(directory.join("fst_engine.py"))
                    .arg(directory.join("request.json"))
                    .stdout(Stdio::from(log.try_clone().map_err(|_| "Log indisponível")?)).stderr(Stdio::from(log))
                    .status().map_err(|_| "Não foi possível iniciar FST local")?;
                let report = read_json(&directory.join("status.json")).ok_or("Motor FST terminou sem estado")?;
                let state = report["state"].as_str().filter(|s| ["succeeded","cancelled","failed"].contains(s)).ok_or("Estado FST inválido")?;
                if !status.success() && state != "failed" { return Err("Motor FST interrompido".into()); }
                open_database(&task_app)?.execute("UPDATE local_tracking_jobs SET state=?2,error=?3 WHERE job_id=?1",
                    params![task_id, state, report["error"].as_str()]).map_err(|_| "Não foi possível salvar FST local")?;
                Ok(())
            })();
            if let Err(error) = work { if let Ok(db) = open_database(&task_app) {
                let _ = db.execute("UPDATE local_tracking_jobs SET state='failed',error=?2 WHERE job_id=?1", params![task_id,error]);
            }}
        });
        Ok(json!({"jobId":id,"state":"queued","config":run_config,"videoSha256":digest,"experimentId":experiment_id,"createdAt":created_at}))
    }).await.map_err(|_| "Inicialização FST interrompida".to_string())?
}

#[tauri::command]
pub fn get_local_fst_result(app: AppHandle, job_id: String) -> CommandResult<Value> {
    let directory = folder(&app, &job_id)?;
    let db = open_database(&app)?;
    let config: String = db.query_row("SELECT config_json FROM local_tracking_jobs WHERE job_id=?1", [&job_id],
        |r| r.get(0)).map_err(|_| "Execução FST não encontrada")?;
    let saved: Value = serde_json::from_str(&config).map_err(|_| "Configuração FST inválida")?;
    let report = read_json(&directory.join("status.json")).ok_or("Estado FST indisponível")?;
    if saved["protocol"] != "forced_swim" || report["state"] != "succeeded" { return Err("Resultado FST ainda indisponível".into()); }
    let file = directory.join("result.json");
    if fs::metadata(&file).map_err(|_| "Resultado FST ausente")?.len() > 256 * 1024 * 1024 {
        return Err("Resultado FST excede 256 MiB".into());
    }
    let value = read_json(&file).ok_or("Resultado FST inválido")?;
    if value["schemaVersion"] != "fst-local-presence-1" || value["runId"] != job_id {
        return Err("Contrato FST local inválido".into());
    }
    Ok(value)
}
#[tauri::command]
pub async fn get_local_audit_video(app: AppHandle, job_id: String, render: bool) -> CommandResult<Value> {
    validate_local_id(&job_id, "Execução")?;
    tauri::async_runtime::spawn_blocking(move || {
        let db = open_database(&app)?;
        let (experiment_id, upload_id, config, state): (String, String, String, String) = db.query_row(
            "SELECT experiment_id,upload_id,config_json,state FROM local_tracking_jobs WHERE job_id=?1", [&job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(|_| "Execução local não encontrada")?;
        let directory = folder(&app, &job_id)?;
        let destination = audit_video_path(&app, &job_id)?;
        let report = read_json(&directory.join("status.json")).ok_or("Estado da execução indisponível")?;
        if report["state"] != "succeeded" || !["running", "succeeded"].contains(&state.as_str()) {
            return Err("O vídeo fica disponível após a conclusão da análise local.".into());
        }
        let config: Value = serde_json::from_str(&config).map_err(|_| "Configuração local inválida")?;
        if destination.is_file() && !render {
            let overlay = read_json(&directory.join("video_overlay.json")).unwrap_or(Value::Null);
            let needs_refresh = if config["strategy"] == WISTAR_STRATEGY {
                let artifact=read_json(&directory.join("video_artifact.json")).unwrap_or(Value::Null);
                artifact["visualization"]["version"] != "oft-layered-video-8"
            } else {
                overlay["version"] != "local-audit-11" || overlay["skeletonMethod"] != "body-axis-2"
            };
            return Ok(json!({"videoPath": destination, "videoError": null, "needsRefresh": needs_refresh}));
        }
        if !render {
            return Ok(json!({"videoPath": null, "videoError": report["videoError"]}));
        }

        let _guard = OperationGuard::acquire(&RENDERING_SAVED_VIDEO)?;
        let request_file = directory.join("request.json");
        let request = read_json(&request_file).ok_or("Solicitação original da análise indisponível")?;
        let preparation = &config["videoPreparation"];
        let source_id = if preparation["status"] == "optimized" {
            preparation["uploadId"].as_str().ok_or("Cópia otimizada indisponível")?
        } else { &upload_id };
        let (path, digest): (String, String) = db.query_row(
            "SELECT local_path,sha256 FROM video_staging WHERE upload_id=?1 AND experiment_id=?2 AND ready=1",
            params![source_id, experiment_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "O vídeo usado na análise saiu do cache. Analise novamente com o arquivo original.")?;
        drop(db);
        if request["video"] != path || request["config"] != config {
            return Err("A solicitação salva diverge da execução selecionada.".into());
        }
        let source = std::path::Path::new(&path);
        if !source.is_file() || video::sha256(source)? != digest {
            return Err("A cópia do vídeo está ausente ou foi alterada. Analise novamente com o arquivo original.".into());
        }
        let ffmpeg = video::binary("ffmpeg").ok_or("FFmpeg não encontrado")?;
        fs::write(directory.join("body_axis.py"), include_str!("../python/body_axis.py"))
            .map_err(|_| "Filtro de orientação indisponível")?;
        let output = if config["strategy"] == WISTAR_STRATEGY {
            if request["preparedSha256"] != digest || request["auditVideo"] != json!(destination) {
                return Err("O vídeo preparado diverge do registro da inferência Wistar.".into());
            }
            crate::local_behavior::materialize_tracking_quality(&directory)?;
            fs::write(directory.join("hybrid_render.py"),include_str!("../python/hybrid_render.py"))
                .map_err(|_| "Renderizador Wistar indisponível")?;
            fs::write(directory.join("local_wistar.py"),include_str!("../python/local_wistar.py"))
                .map_err(|_| "Renderizador Wistar indisponível")?;
            Command::new(wistar_python(&app)?)
                .args(["-X", "utf8"]).arg(directory.join("local_wistar.py"))
                .arg(request_file).arg("render").arg(ffmpeg).output()
        } else {
            Command::new(python(&app)?)
                .current_dir(&directory)
                .args(["-X", "utf8", "-c", AUDIT_VIDEO_SCRIPT])
                .arg(request_file).arg(&destination).arg(ffmpeg).output()
        }.map_err(|_| "Não foi possível iniciar a renderização do vídeo")?;
        if !output.status.success() || !destination.is_file() {
            let details: String = String::from_utf8_lossy(&output.stderr).trim().chars().take(1500).collect();
            return Err(if details.is_empty() { "Não foi possível renderizar o vídeo".into() } else { details });
        }
        Ok(json!({"videoPath": destination, "videoError": null}))
    }).await.map_err(|_| "Renderização do vídeo interrompida".to_string())?
}

#[tauri::command]
pub async fn list_local_tracking_jobs(
    app: AppHandle,
    experiment_id: String,
) -> CommandResult<Vec<Value>> {
    tauri::async_runtime::spawn_blocking(move || read_local_tracking_jobs(app, experiment_id))
        .await.map_err(|_| "Carregamento do histórico interrompido".to_string())?
}

fn read_local_tracking_jobs(app: AppHandle, experiment_id: String) -> CommandResult<Vec<Value>> {
    validate_local_id(&experiment_id, "Experimento")?;
    prepare_tables(&app)?;
    let db = open_database(&app)?;
    let mut query=db.prepare("SELECT job_id,state,error,video_sha256,config_json,created_at,upload_id FROM local_tracking_jobs WHERE experiment_id=?1 ORDER BY created_at DESC,rowid DESC").map_err(|_|"Histórico local indisponível")?;
    let rows = query
        .query_map([&experiment_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|_| "Histórico local indisponível")?;
    rows.map(|row|{let(id,state,error,sha,config,date,upload_id)=row.map_err(|_|"Registro local inválido")?;let report=read_json(&folder(&app,&id)?.join("status.json")).unwrap_or(json!({}));Ok(json!({"jobId":id,"state":if ["queued","running"].contains(&state.as_str()){report["state"].as_str().unwrap_or(&state)}else{&state},"error":error.or_else(||report["error"].as_str().map(str::to_owned)),"report":report,"config":serde_json::from_str::<Value>(&config).unwrap_or(json!({})),"videoSha256":sha,"createdAt":date,"experimentId":experiment_id,"uploadId":upload_id}))}).collect()
}
#[tauri::command]
pub fn get_local_tracking_updates(
    app: AppHandle,
    job_id: String,
    offset: u64,
) -> CommandResult<Value> {
    let directory = folder(&app, &job_id)?;
    read_updates(&directory.join("samples.jsonl"), offset)
}

fn attach_layer_predictions(directory: &std::path::Path, samples: &mut [Value]) -> CommandResult<()> {
    let path = directory.join("rearing_predictions.jsonl");
    if !path.exists() { return Ok(()); }
    let file = File::open(path).map_err(|_| "Propostas de rearing indisponíveis")?;
    if file.metadata().map_err(|_| "Propostas indisponíveis")?.len() > 128*1024*1024 {
        return Err("Propostas de rearing excedem o limite".into());
    }
    let mut predictions = std::collections::HashMap::new();
    for line in BufReader::new(file).lines() {
        let value: Value = serde_json::from_str(&line.map_err(|_| "Propostas interrompidas")?).map_err(|_| "Proposta inválida")?;
        let index = value["frameIndex"].as_u64().ok_or("Proposta sem quadro")?;
        if predictions.insert(index, value).is_some() { return Err("Quadros de rearing duplicados".into()); }
    }
    for sample in samples {
        if sample["oftLayers"]["version"] != "oft-layers-1" { continue; }
        if let Some(prediction) = sample["frameIndex"].as_u64().and_then(|index| predictions.get(&index)) {
            let a=sample["timestampSec"].as_f64().ok_or("Quadro sem tempo")?;
            let b=prediction["timestampSec"].as_f64().ok_or("Proposta sem tempo")?;
            if (a-b).abs()>1e-6 || prediction["metricEligible"] != false || prediction["reviewStatus"] != "pending" {
                return Err("Proposta de rearing diverge do quadro de origem".into());
            }
            sample["oftLayers"]["rearing"] = prediction.clone();
        }
    }
    Ok(())
}

fn read_updates(path: &std::path::Path, offset: u64) -> CommandResult<Value> {
    if !path.exists() {
        return Ok(json!({"offset":0,"samples":[]}));
    }
    let mut file = File::open(path).map_err(|_| "Pontos locais indisponíveis")?;
    if offset > file.metadata().map_err(|_| "Resultado indisponível")?.len() {
        return Err("Cursor fora do resultado".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "Cursor inválido")?;
    let mut reader = BufReader::new(file);
    let mut samples = Vec::new();
    let mut cursor = offset;
    for _ in 0..256 {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|_| "Resultado interrompido")?;
        if bytes == 0 || !line.ends_with('\n') {
            break;
        }
        if line.len() > 1024 * 1024 {
            return Err("Frame local excede o limite".into());
        }
        samples.push(serde_json::from_str::<Value>(&line).map_err(|_| "Frame local inválido")?);
        cursor += bytes as u64;
    }
    // Completed predictions are merged on result retrieval. Streaming frames
    // remain UNKNOWN while the independent classifier stage is in progress.
    Ok(json!({"offset":cursor,"samples":samples}))
}
#[tauri::command]
pub async fn get_local_tracking_result(app: AppHandle, job_id: String) -> CommandResult<Vec<Value>> {
    tauri::async_runtime::spawn_blocking(move || {
        read_local_tracking_result(&folder(&app, &job_id)?)
    })
    .await
    .map_err(|_| "Carregamento do tracking interrompido".to_string())?
}

fn read_local_tracking_result(directory: &std::path::Path) -> CommandResult<Vec<Value>> {
    let report = read_json(&directory.join("status.json")).ok_or("Resultado ainda indisponível")?;
    if report["state"] != "succeeded" {
        return Err("Somente execuções concluídas podem ser usadas como resultado".into());
    }
    let file = File::open(directory.join("samples.jsonl")).map_err(|_| "Resultado indisponível")?;
    if file.metadata().map_err(|_| "Resultado indisponível")?.len() > 256 * 1024 * 1024 {
        return Err("Resultado excede 256 MiB".into());
    }
    let mut samples: Vec<Value> = BufReader::new(file)
        .lines()
        .map(|line| {
            serde_json::from_str(&line.map_err(|_| "Resultado interrompido")?)
                .map_err(|_| "Frame inválido".into())
        })
        .collect::<CommandResult<_>>()?;
    attach_layer_predictions(directory, &mut samples)?;
    Ok(samples)
}
#[tauri::command]
pub fn cancel_local_tracking(app: AppHandle, job_id: String) -> CommandResult<()> {
    fs::write(folder(&app, &job_id)?.join("cancel"), b"cancel")
        .map_err(|_| "Não foi possível solicitar cancelamento".into())
}
#[tauri::command]
pub async fn local_frame_index(
    app: AppHandle,
    experiment_id: String,
    upload_id: String,
    time: f64,
) -> CommandResult<u64> {
    validate_local_id(&experiment_id, "Experimento")?;
    validate_local_id(&upload_id, "Upload")?;
    tauri::async_runtime::spawn_blocking(move||{let path:String=open_database(&app)?.query_row("SELECT local_path FROM video_staging WHERE experiment_id=?1 AND upload_id=?2 AND ready=1",params![experiment_id,upload_id],|r|r.get(0)).map_err(|_|"Selecione o vídeo original")?;video::frame_at_time(std::path::Path::new(&path),time)}).await.map_err(|_|"Indexação interrompida".to_string())?
}
pub(crate) fn recover(app: &AppHandle) -> CommandResult<()> {
    prepare_tables(app)?;
    let db = open_database(app)?;
    let ids: Vec<String> = db
        .prepare("SELECT job_id FROM local_tracking_jobs WHERE state IN ('queued','running')")
        .map_err(|_| "Recuperação local indisponível")?
        .query_map([], |r| r.get(0))
        .map_err(|_| "Recuperação indisponível")?
        .collect::<Result<_, _>>()
        .map_err(|_| "Recuperação indisponível")?;
    for id in ids {
        let directory = folder(app, &id)?;
        let report = read_json(&directory.join("status.json")).unwrap_or(json!({}));
        if let Some(state) = report["state"]
            .as_str()
            .filter(|state| ["succeeded", "cancelled", "failed"].contains(state))
        {
            db.execute(
                "UPDATE local_tracking_jobs SET state=?2,error=?3 WHERE job_id=?1",
                params![id, state, report["error"].as_str()],
            )
            .map_err(|_| "Recuperação local indisponível")?;
        } else {
            let _ = fs::write(directory.join("cancel"), b"app-restarted");
            db.execute("UPDATE local_tracking_jobs SET state='failed',error='Aplicativo reiniciado; execução interrompida. Resultados anteriores preservados.' WHERE job_id=?1",[id]).map_err(|_|"Recuperação local indisponível")?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_ram_review_events(app: AppHandle, job_id: String) -> CommandResult<Vec<Value>> {
    validate_local_id(&job_id, "Execução")?;
    let db = open_database(&app)?;
    let mut query = db.prepare("SELECT event_json FROM ram_review_events WHERE job_id=?1 ORDER BY sequence")
        .map_err(|_| "Histórico RAM indisponível")?;
    let rows = query.query_map([job_id], |r| r.get::<_, String>(0)).map_err(|_| "Histórico RAM indisponível")?;
    rows.map(|r| serde_json::from_str(&r.map_err(|_| "Evento RAM ilegível")?).map_err(|_| "Evento RAM inválido".into())).collect()
}

fn store_ram_review(db: &rusqlite::Connection, job_id: &str, event: &Value, sample: &Value, config: &Value, digest: &str) -> CommandResult<()> {
    let id = event["id"].as_str().ok_or("Evento sem ID")?;
    validate_local_id(id, "Evento")?;
    if config["protocol"] != "radial_arm_maze" || event["runId"] != job_id || event["sourceVideoSha256"] != digest
        || event["source"] != "manual" || event["keypoint"] != "box_center"
        || event["frameIndex"] != sample["frameIndex"] || event["timestampSec"] != sample["timestampSec"] {
        return Err("Proveniência da revisão RAM incompatível".into());
    }
    match event["type"].as_str().unwrap_or("") {
        "MOVE_POINT" => {
            for (key, limit) in [("x", "width"), ("y", "height")] {
                if !event["after"][key].as_f64().is_some_and(|n| n.is_finite() && n >= 0. && n <= config[limit].as_f64().unwrap_or(0.)) {
                    return Err("Centro corrigido fora do vídeo".into());
                }
            }
        },
        "SET_BOX" => {
            let b = &event["afterBox"];
            for (position, extent, limit) in [("x", "width", "width"), ("y", "height", "height")] {
                let a = b[position].as_f64().ok_or("Caixa inválida")?;
                let size = b[extent].as_f64().ok_or("Caixa inválida")?;
                if !a.is_finite() || !size.is_finite() || a < 0. || size <= 0. || a+size > config[limit].as_f64().unwrap_or(0.) {
                    return Err("Caixa corrigida fora do vídeo".into());
                }
            }
        },
        "CONFIRM_POINT" | "MARK_MISSING" => (),
        "REVERT_EVENT" => {
            let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM ram_review_events WHERE job_id=?1 AND id=?2)",
                params![job_id, event["targetEventId"].as_str()], |r| r.get(0)).map_err(|_| "Evento de origem ausente")?;
            if !exists { return Err("Evento de origem ausente".into()); }
        },
        _ => return Err("Tipo de revisão RAM inválido".into()),
    }
    let serialized = event.to_string();
    if serialized.len() > 16384 { return Err("Evento RAM excede o limite".into()); }
    db.execute("INSERT INTO ram_review_events(id,job_id,event_json) VALUES (?1,?2,?3)", params![id,job_id,serialized])
        .map_err(|_| "Não foi possível registrar a revisão RAM")?;
    Ok(())
}

#[tauri::command]
pub fn append_ram_review_event(app: AppHandle, job_id: String, event: Value) -> CommandResult<()> {
    let directory = folder(&app, &job_id)?;
    let db = open_database(&app)?;
    let (config, digest, state): (String, String, String) = db.query_row(
        "SELECT config_json,video_sha256,state FROM local_tracking_jobs WHERE job_id=?1", [&job_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_| "Execução RAM ausente")?;
    if state != "succeeded" { return Err("Conclua o tracking antes de revisar".into()); }
    let config: Value = serde_json::from_str(&config).map_err(|_| "Configuração RAM inválida")?;
    let index = event["frameIndex"].as_u64().ok_or("Frame RAM inválido")?;
    let mut sample = None;
    for line in BufReader::new(File::open(directory.join("samples.jsonl")).map_err(|_| "Observações RAM ausentes")?).lines() {
        let value: Value = serde_json::from_str(&line.map_err(|_| "Observações RAM ilegíveis")?).map_err(|_| "Frame RAM inválido")?;
        if value["frameIndex"].as_u64() == Some(index) { sample = Some(value); break; }
    }
    store_ram_review(&db, &job_id, &event, &sample.ok_or("Frame inexistente")?, &config, &digest)
}

#[cfg(test)]
mod tests {
    #[test]
    fn completed_layer_predictions_merge_without_promoting_metrics_or_changing_geometry() {
        let directory=std::env::temp_dir().join(format!("layer-predictions-{}",crate::colab::new_uuid_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut samples=vec![serde_json::json!({"frameIndex":0,"timestampSec":0.,"xPx":12,"oftLayers":{"version":"oft-layers-1"}})];
        let prediction=serde_json::json!({"frameIndex":0,"timestampSec":0.,"classification":"REARING_UNSPECIFIED","reviewStatus":"pending","metricEligible":false});
        std::fs::write(directory.join("rearing_predictions.jsonl"),format!("{prediction}\n")).unwrap();
        super::attach_layer_predictions(&directory,&mut samples).unwrap();
        assert_eq!(samples[0]["xPx"],12);
        assert_eq!(samples[0]["oftLayers"]["rearing"]["metricEligible"],false);
        let mut invalid=prediction.clone();invalid["timestampSec"]=serde_json::json!(1.);
        std::fs::write(directory.join("rearing_predictions.jsonl"),format!("{invalid}\n")).unwrap();
        assert!(super::attach_layer_predictions(&directory,&mut samples).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    use super::*;
    #[test]
    fn rejects_unbounded_or_incomplete_requests() {
        assert!(validate_config(&json!({})).is_err());
    }
    #[test]
    fn identifiers_cannot_escape_job_directory() {
        assert!(validate_local_id("../../secrets", "job").is_err());
    }
    fn valid_config() -> Value {
        json!({"width":320,"height":240,"mode":"light","threshold":190,
            "minAreaFraction":0.001,"maxAreaFraction":0.12,"maxWidth":1280,"maxPredictionSec":0.25,"referenceApproved":false,
            "arena":{"cornersPx":[{"x":10,"y":10},{"x":310,"y":10},{"x":310,"y":230},{"x":10,"y":230}]},
            "initialBox":{"x":80,"y":80,"width":40,"height":40}})
    }
    #[test]
    fn validates_geometry_and_initial_box_without_accepting_crossed_vertices() {
        assert!(validate_config(&valid_config()).is_ok());
        let mut automatic = valid_config();
        automatic["mode"] = json!("auto");
        assert!(validate_config(&automatic).is_ok());
        let mut config = valid_config();
        config["initialBox"]["width"] = json!(500);
        assert!(validate_config(&config).is_err());
        let mut config = valid_config();
        config["arena"]["cornersPx"]
            .as_array_mut()
            .unwrap()
            .swap(1, 2);
        assert!(validate_config(&config).is_err());
        let mut config = valid_config();
        config["maxAreaFraction"] = json!(0.0001);
        assert!(validate_config(&config).is_err());
        let mut config = valid_config();
        config["mode"] = json!("background");
        assert!(validate_config(&config).is_err());
    }
    #[test]
    fn fst_local_requires_paired_full_tanks_and_keeps_protocol_separate() {
        let mut config = json!({"protocol":"forced_swim","width":320,"height":240,
            "subjects":[{"animalId":"animal_1","subjectId":"subject_1"}],
            "tanks":[{"animalId":"animal_1","subjectId":"subject_1",
                "roiPx":{"x":10,"y":10,"width":150,"height":200}}]});
        assert!(validate_fst_config(&config).is_ok());
        config["tanks"][0]["roiPx"]["height"] = json!(100);
        assert!(validate_fst_config(&config).is_err());
        config["tanks"][0]["roiPx"]["height"] = json!(200);
        config["subjects"][0]["animalId"] = json!("other");
        assert!(validate_fst_config(&config).is_err());
        config["subjects"][0]["animalId"] = json!("animal_1");
        config["protocol"] = json!("open_field");
        assert!(validate_fst_config(&config).is_err());
    }
    #[test]
    fn ram_polygon_must_stay_inside_video() {
        let mut config = valid_config();
        config["walkablePolygonPx"] = json!([{"x":10,"y":10},{"x":300,"y":20},{"x":310,"y":220},{"x":10,"y":230}]);
        assert!(validate_config(&config).is_ok());
        config["walkablePolygonPx"][2]["x"] = json!(400);
        assert!(validate_config(&config).is_err());
    }
    #[test]
    fn hybrid_requires_empty_background_human_seed_and_unapproved_metrics() {
        let mut config=valid_config();
        config["strategy"]=json!("hybrid_kalman_v1");
        assert!(validate_config(&config).is_err());
        config["mode"]=json!("background");
        config["backgroundFrameIndex"]=json!(7);
        assert!(validate_config(&config).is_ok());
        config["referenceApproved"]=json!(true);
        assert!(validate_config(&config).is_err());
        config["referenceApproved"]=json!(false);
        config["initialBox"]=Value::Null;
        assert!(validate_config(&config).is_err());
        config["initialBox"]=json!({"x":80,"y":80,"width":40,"height":40});
        config["strategy"]=json!("unknown");
        assert!(validate_config(&config).is_err());
    }
    #[test]
    fn classical_reference_requires_review_and_an_explicit_supported_protocol() {
        let mut config = valid_config();
        config["strategy"] = json!("classical_roi_v1");
        config["mode"] = json!("auto");
        assert!(validate_config(&config).is_err());
        for protocol in ["open_field", "radial_arm_maze"] {
            config["protocol"] = json!(protocol);
            assert!(validate_config(&config).is_ok());
        }
        config["protocol"] = json!("forced_swim");
        assert!(validate_config(&config).is_err());
        config["protocol"] = json!("open_field");
        config["referenceApproved"] = json!(true);
        assert!(validate_config(&config).is_err());
        config["referenceApproved"] = json!(false);
        config["mode"] = json!("background");
        config["backgroundFrameIndex"] = json!(0);
        assert!(validate_config(&config).is_err());
    }
    #[test]
    fn validates_manual_guidance_and_source_frame_clock() {
        let anchors=json!([
            {"frameIndex":0,"timestampSec":0.0,"eventId":"event-0","box":{"x":40,"y":80,"width":30,"height":20}},
            {"frameIndex":20,"timestampSec":1.0,"eventId":"event-20","box":{"x":60,"y":80,"width":30,"height":20}}
        ]);
        let mut config=valid_config();
        config["guidance"]=json!({"sourceJobId":"prior-job","anchors":anchors});
        assert!(validate_config(&config).is_ok());
        let directory=std::env::temp_dir().join(format!("behavetracker-guidance-test-{}",new_uuid_v4()));
        fs::create_dir(&directory).unwrap();
        let path=directory.join("samples.jsonl");
        let lines=(0..=20).map(|frame|json!({"frameIndex":frame,"timestampSec":frame as f64/20.,"keypoint":"box_center"}).to_string()).collect::<Vec<_>>().join("\n");
        fs::write(&path,lines).unwrap();
        assert!(verify_guidance_frames(&path,config["guidance"]["anchors"].as_array().unwrap()).is_ok());
        config["guidance"]["anchors"][1]["timestampSec"]=json!(1.01);
        assert!(verify_guidance_frames(&path,config["guidance"]["anchors"].as_array().unwrap()).is_err());
        config["guidance"]["anchors"][1]["timestampSec"]=json!(1.0);
        config["guidance"]["anchors"][1]["box"]["x"]=json!(310);
        assert!(validate_config(&config).is_err());
        config["guidance"]["anchors"][1]["box"]["x"]=json!(60);
        config["guidance"]["anchors"][1]["frameIndex"]=json!(0);
        assert!(validate_config(&config).is_err());
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn ram_color_requires_session_parameters_and_cannot_run_as_oft() {
        let mut c = valid_config();
        c["strategy"] = json!("ram_color_geometry_v2");
        c["protocol"] = json!("radial_arm_maze");
        c["walkablePolygonPx"] = c["arena"]["cornersPx"].clone();
        c["ramColor"] = json!({"valueMin":80,"saturationMin":25,"labBMin":135,"minAreaPx":280,"maxAreaPx":72000,
            "minDensity":0.12,"maxSpeedFraction":0.21,"reacquireSec":0.5,"ambiguityMargin":0.4});
        assert!(validate_config(&c).is_ok());
        c["protocol"] = json!("open_field");
        assert!(validate_config(&c).is_err());
        c["protocol"] = json!("radial_arm_maze");
        c["ramColor"]["maxAreaPx"] = json!(1);
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn ram_review_is_append_only_and_checks_source_clock_and_video() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::database::migrate(&mut db).unwrap();
        db.execute("INSERT INTO local_tracking_jobs(job_id,experiment_id,upload_id,video_sha256,config_json,state) VALUES ('job','experiment','upload',?1,'{}','succeeded')", ["a".repeat(64)]).unwrap();
        let c=json!({"protocol":"radial_arm_maze","width":320,"height":240});
        let sample=json!({"frameIndex":7,"timestampSec":0.28});
        let mut event=json!({"id":"edit-1","type":"SET_BOX","runId":"job","sourceVideoSha256":"a".repeat(64),
            "frameIndex":7,"timestampSec":0.28,"source":"manual","keypoint":"box_center",
            "afterBox":{"x":20,"y":30,"width":40,"height":50}});
        assert!(store_ram_review(&db,"job",&event,&sample,&c,&"a".repeat(64)).is_ok());
        assert!(store_ram_review(&db,"job",&event,&sample,&c,&"a".repeat(64)).is_err());
        event["id"]=json!("edit-2"); event["timestampSec"]=json!(0.3);
        assert!(store_ram_review(&db,"job",&event,&sample,&c,&"a".repeat(64)).is_err());
        event["timestampSec"]=json!(0.28); event["sourceVideoSha256"]=json!("b".repeat(64));
        assert!(store_ram_review(&db,"job",&event,&sample,&c,&"a".repeat(64)).is_err());
        event["sourceVideoSha256"]=json!("a".repeat(64)); event["type"]=json!("REVERT_EVENT"); event["targetEventId"]=json!("edit-1");
        assert!(store_ram_review(&db,"job",&event,&sample,&c,&"a".repeat(64)).is_ok());
        assert_eq!(db.query_row("SELECT count(*) FROM ram_review_events",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        db.execute("DELETE FROM local_tracking_jobs WHERE job_id='job'",[]).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM ram_review_events",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn incremental_reads_wait_for_complete_lines_and_limit_each_batch() {
        let directory =
            std::env::temp_dir().join(format!("behavetracker-stream-test-{}", new_uuid_v4()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("samples.jsonl");
        fs::write(&path, b"{\"frameIndex\":0}\n{\"frameIndex\":1}").unwrap();
        let first = read_updates(&path, 0).unwrap();
        assert_eq!(first["samples"].as_array().unwrap().len(), 1);
        assert_eq!(
            read_updates(&path, first["offset"].as_u64().unwrap()).unwrap()["samples"],
            json!([])
        );
        assert!(read_updates(&path, 1000).is_err());
        fs::write(&path, "{}\n".repeat(300)).unwrap();
        let batch = read_updates(&path, 0).unwrap();
        assert_eq!(batch["samples"].as_array().unwrap().len(), 256);
        assert_eq!(
            read_updates(&path, batch["offset"].as_u64().unwrap()).unwrap()["samples"]
                .as_array()
                .unwrap()
                .len(),
            44
        );
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
