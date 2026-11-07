//! Jobs locais isolados do Colab e dos resultados científicos selecionados.
use crate::{
    colab::{new_uuid_v4, validate_local_id},
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
    open_database(app)?.execute_batch("CREATE TABLE IF NOT EXISTS local_tracking_jobs(job_id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,upload_id TEXT NOT NULL,video_sha256 TEXT NOT NULL,config_json TEXT NOT NULL,state TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));").map_err(|_|"Armazenamento local indisponível".into())
}
fn python(app: &AppHandle) -> CommandResult<PathBuf> {
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
            "import cv2,json; print(json.dumps({'ready':True,'version':cv2.__version__}))",
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
    if !["light", "dark", "background"].contains(&config["mode"].as_str().unwrap_or("")) {
        return Err("Modo de segmentação inválido".into());
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
    config: Value,
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
        let (path,digest,size):(String,String,i64)=connection.query_row("SELECT local_path,sha256,expected_size FROM video_staging WHERE upload_id=?1 AND experiment_id=?2 AND ready=1",params![upload_id,experiment_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"Selecione o vídeo original")?;
        if size<=0||fs::metadata(&path).map_err(|_|"Cache do vídeo ausente")?.len()!=size as u64||video::sha256(std::path::Path::new(&path))?!=digest{return Err("Cache do vídeo alterado; selecione novamente o original".into());}
        if let Some(guidance) = config.get("guidance").filter(|value| !value.is_null()) {
            let source = guidance["sourceJobId"].as_str().ok_or("Execução de origem ausente")?;
            let (state,source_digest):(String,String)=connection.query_row(
                "SELECT state,video_sha256 FROM local_tracking_jobs WHERE job_id=?1 AND experiment_id=?2",
                params![source,experiment_id],|r|Ok((r.get(0)?,r.get(1)?)))
                .map_err(|_|"Execução manual de origem não encontrada")?;
            if state!="succeeded" || source_digest!=digest {return Err("A revisão manual não pertence a uma execução concluída deste vídeo".into());}
            verify_guidance_frames(&folder(&app,source)?.join("samples.jsonl"),guidance["anchors"].as_array().unwrap())?;
        }
        let id=new_uuid_v4();let directory=folder(&app,&id)?;fs::create_dir_all(&directory).map_err(|_|"Pasta da execução indisponível")?;
        let request=json!({"video":path,"config":config,"ffprobe":ffprobe,"ffmpeg":ffmpeg});
        fs::write(directory.join("request.json"),request.to_string()).map_err(|_|"Solicitação local indisponível")?;
        fs::write(directory.join("engine.py"),include_str!("../python/opencv_engine.py")).map_err(|_|"Motor local indisponível")?;
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
        Ok(json!({"jobId":id,"state":"queued","config":config,"videoSha256":digest,"experimentId":experiment_id,"createdAt":created_at}))
    }).await.map_err(|_|"Inicialização interrompida".to_string())?
}
#[tauri::command]
pub fn list_local_tracking_jobs(
    app: AppHandle,
    experiment_id: String,
) -> CommandResult<Vec<Value>> {
    validate_local_id(&experiment_id, "Experimento")?;
    prepare_tables(&app)?;
    let db = open_database(&app)?;
    let mut query=db.prepare("SELECT job_id,state,error,video_sha256,config_json,created_at FROM local_tracking_jobs WHERE experiment_id=?1 ORDER BY created_at DESC,rowid DESC").map_err(|_|"Histórico local indisponível")?;
    let rows = query
        .query_map([&experiment_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|_| "Histórico local indisponível")?;
    rows.map(|row|{let(id,state,error,sha,config,date)=row.map_err(|_|"Registro local inválido")?;let report=read_json(&folder(&app,&id)?.join("status.json")).unwrap_or(json!({}));Ok(json!({"jobId":id,"state":if ["queued","running"].contains(&state.as_str()){report["state"].as_str().unwrap_or(&state)}else{&state},"error":error.or_else(||report["error"].as_str().map(str::to_owned)),"report":report,"config":serde_json::from_str::<Value>(&config).unwrap_or(json!({})),"videoSha256":sha,"createdAt":date,"experimentId":experiment_id}))}).collect()
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
    Ok(json!({"offset":cursor,"samples":samples}))
}
#[tauri::command]
pub fn get_local_tracking_result(app: AppHandle, job_id: String) -> CommandResult<Vec<Value>> {
    let directory = folder(&app, &job_id)?;
    let report = read_json(&directory.join("status.json")).ok_or("Resultado ainda indisponível")?;
    if report["state"] != "succeeded" {
        return Err("Somente execuções concluídas podem ser usadas como resultado".into());
    }
    let file = File::open(directory.join("samples.jsonl")).map_err(|_| "Resultado indisponível")?;
    if file.metadata().map_err(|_| "Resultado indisponível")?.len() > 256 * 1024 * 1024 {
        return Err("Resultado excede 256 MiB".into());
    }
    BufReader::new(file)
        .lines()
        .map(|line| {
            serde_json::from_str(&line.map_err(|_| "Resultado interrompido")?)
                .map_err(|_| "Frame inválido".into())
        })
        .collect()
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
#[cfg(test)]
mod tests {
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
