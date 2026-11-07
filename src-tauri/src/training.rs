//! Exemplos humanos independentes dos resultados científicos e snapshots imutáveis.
use crate::{
    colab::{self, new_uuid_v4, validate_local_id},
    oauth::{open_database, CommandResult},
    video,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub const LANDMARKS: [&str; 9] = [
    "nose",
    "left_ear",
    "right_ear",
    "neck",
    "mid_back",
    "hip",
    "tail_base",
    "left_forepaw",
    "right_forepaw",
];
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PointLabel {
    state: String,
    x: Option<f64>,
    y: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BoxLabel {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameLabel {
    pub id: String,
    pub experiment_id: String,
    subject_id: String,
    video_sha256: String,
    frame_index: u64,
    timestamp_sec: f64,
    width: u32,
    height: u32,
    image_sha256: String,
    bbox: Option<BoxLabel>,
    keypoints: BTreeMap<String, PointLabel>,
    context: String,
    split: String,
    reviewed: bool,
    updated_at: String,
}
pub(crate) fn prepare_tables(connection: &Connection) -> CommandResult<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS training_frames(id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,video_sha256 TEXT NOT NULL,frame_index INTEGER NOT NULL,annotation_json TEXT NOT NULL,UNIQUE(video_sha256,frame_index,experiment_id));
        CREATE TABLE IF NOT EXISTS training_intervals(experiment_id TEXT PRIMARY KEY,intervals_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS training_runs(job_id TEXT PRIMARY KEY REFERENCES colab_jobs(job_id),dataset_path TEXT NOT NULL,dataset_sha256 TEXT NOT NULL,report_json TEXT,model_path TEXT,model_sha256 TEXT,epochs INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS training_selection(profile TEXT PRIMARY KEY,job_id TEXT REFERENCES training_runs(job_id));
        CREATE TABLE IF NOT EXISTS custom_analysis_models(job_id TEXT PRIMARY KEY REFERENCES colab_jobs(job_id),model_job_id TEXT NOT NULL REFERENCES training_runs(job_id));").map_err(|_|"Não foi possível preparar o armazenamento de treinamento".to_string())
}
fn root(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Dados do app indisponíveis")?
        .join("training");
    fs::create_dir_all(path.join("images")).map_err(|_| "Não foi possível preparar as imagens")?;
    fs::create_dir_all(path.join("datasets")).map_err(|_| "Não foi possível preparar datasets")?;
    fs::create_dir_all(path.join("models")).map_err(|_| "Não foi possível preparar modelos")?;
    Ok(path)
}
fn image_path(app: &AppHandle, id: &str) -> CommandResult<PathBuf> {
    validate_local_id(id, "Frame")?;
    Ok(root(app)?.join("images").join(format!("{id}.png")))
}
fn image_url(path: &Path) -> CommandResult<String> {
    let bytes = fs::read(path).map_err(|_| "Imagem anotada indisponível")?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Imagem excede 20 MiB".into());
    }
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}
fn read_frame(connection: &Connection, id: &str) -> CommandResult<FrameLabel> {
    let body: String = connection
        .query_row(
            "SELECT annotation_json FROM training_frames WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| "Frame anotado não encontrado")?;
    serde_json::from_str(&body).map_err(|_| "Anotação salva inválida".into())
}
fn context_valid(value: &str) -> bool {
    ["walking", "rearing", "grooming", "freezing", "other"].contains(&value)
}
fn validate_frame(frame: &FrameLabel) -> CommandResult<()> {
    if !context_valid(&frame.context)
        || !["train", "validation"].contains(&frame.split.as_str())
        || frame.subject_id.trim().is_empty()
        || frame.subject_id.len() > 200
        || frame.keypoints.len() != LANDMARKS.len()
    {
        return Err("Contexto, animal, grupo ou esquema de partes inválido".into());
    }
    if let Some(b) = &frame.bbox {
        if ![b.x, b.y, b.width, b.height].iter().all(|n| n.is_finite())
            || b.x < 0.
            || b.y < 0.
            || b.width < 0.
            || b.height < 0.
            || b.x + b.width > frame.width as f64
            || b.y + b.height > frame.height as f64
        {
            return Err("Caixa fora dos limites da imagem".into());
        }
    }
    if frame.reviewed
        && frame
            .bbox
            .as_ref()
            .is_none_or(|b| b.width < 2. || b.height < 2.)
    {
        return Err("Desenhe a caixa do animal antes de confirmar o exemplo".into());
    }
    let mut visible = 0;
    for name in LANDMARKS {
        let p = frame
            .keypoints
            .get(name)
            .ok_or("Esquema de partes incompleto")?;
        match p.state.as_str() {
            "visible" => {
                let (x, y) = (
                    p.x.ok_or("Ponto visível sem X")?,
                    p.y.ok_or("Ponto visível sem Y")?,
                );
                if !x.is_finite()
                    || !y.is_finite()
                    || x < 0.
                    || y < 0.
                    || x > frame.width as f64
                    || y > frame.height as f64
                {
                    return Err("Ponto fora da imagem".into());
                }
                if frame.reviewed
                    && frame.bbox.as_ref().is_some_and(|b| {
                        x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height
                    })
                {
                    return Err("Todos os pontos visíveis devem estar dentro da caixa".into());
                }
                visible += 1;
            }
            "occluded" => {
                if p.x.is_some() || p.y.is_some() {
                    return Err("Parte não visível não pode conter coordenadas inventadas".into());
                }
            }
            "unlabeled" => {
                if frame.reviewed || p.x.is_some() || p.y.is_some() {
                    return Err("Revise todas as partes antes de confirmar".into());
                }
            }
            _ => return Err("Visibilidade inválida".into()),
        }
    }
    if frame.reviewed && visible == 0 {
        return Err("Marque pelo menos uma parte visível".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn extract_training_frame(
    app: AppHandle,
    experiment_id: String,
    upload_id: String,
    frame_index: u64,
    subject_id: String,
    timestamp_sec: Option<f64>,
) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        extract(
            &app,
            &experiment_id,
            &upload_id,
            frame_index,
            &subject_id,
            timestamp_sec,
        )
    })
    .await
    .map_err(|_| "Extração interrompida".to_string())?
}
fn extract(
    app: &AppHandle,
    experiment_id: &str,
    upload_id: &str,
    frame_index: u64,
    subject_id: &str,
    timestamp_sec: Option<f64>,
) -> CommandResult<Value> {
    validate_local_id(experiment_id, "Experimento")?;
    validate_local_id(upload_id, "Upload")?;
    colab::prepare_tables(app)?;
    let connection = open_database(app)?;
    let(path,digest,expected):(String,Option<String>,i64)=connection.query_row("SELECT local_path,sha256,expected_size FROM video_staging WHERE upload_id=?1 AND experiment_id=?2 AND ready=1",params![upload_id,experiment_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|_|"Selecione o vídeo original deste experimento")?;
    let digest = digest.ok_or("Vídeo não foi validado")?;
    if fs::metadata(&path).is_err()
        || video::sha256(Path::new(&path))? != digest
        || fs::metadata(&path).map_err(|_| "Vídeo indisponível")?.len() != expected as u64
    {
        return Err("Cache do vídeo ausente ou alterado. Selecione novamente o original".into());
    }
    let source_digest:Option<String>=connection.query_row("SELECT s.sha256 FROM video_preparations p JOIN video_staging s ON s.upload_id=p.original_upload_id WHERE p.prepared_upload_id=?1 LIMIT 1",[upload_id],|r|r.get(0)).optional().map_err(|_|"Não foi possível identificar o vídeo de origem")?.flatten();
    let digest = source_digest.unwrap_or(digest);
    let frame_index = if let Some(time) = timestamp_sec {
        video::frame_at_time(Path::new(&path), time)?
    } else {
        frame_index
    };
    if frame_index > 2_000_000 {
        return Err("Índice de frame fora do limite".into());
    }
    let existing:Option<String>=connection.query_row("SELECT id FROM training_frames WHERE video_sha256=?1 AND frame_index=?2 AND experiment_id=?3",params![digest,frame_index as i64,experiment_id],|r|r.get(0)).optional().map_err(|_|"Não foi possível consultar o frame")?;
    if let Some(id) = existing {
        return Ok(
            json!({"frame":read_frame(&connection,&id)?,"imageUrl":image_url(&image_path(app,&id)?)?}),
        );
    }
    if subject_id.trim().is_empty() || subject_id.len() > 200 {
        return Err("Informe o identificador do animal".into());
    }
    let id = new_uuid_v4();
    let output = image_path(app, &id)?;
    let (w, h, pts) = match video::extract_exact_frame(Path::new(&path), &output, frame_index) {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(&output);
            return Err(e);
        }
    };
    let keypoints = LANDMARKS
        .iter()
        .map(|n| {
            (
                n.to_string(),
                PointLabel {
                    state: "unlabeled".into(),
                    x: None,
                    y: None,
                },
            )
        })
        .collect();
    let frame = FrameLabel {
        id: id.clone(),
        experiment_id: experiment_id.into(),
        subject_id: subject_id.into(),
        video_sha256: digest.clone(),
        frame_index,
        timestamp_sec: pts,
        width: w,
        height: h,
        image_sha256: video::sha256(&output)?,
        bbox: None,
        keypoints,
        context: "other".into(),
        split: "train".into(),
        reviewed: false,
        updated_at: String::new(),
    };
    let url = image_url(&output)?;
    connection
        .execute(
            "INSERT INTO training_frames VALUES (?1,?2,?3,?4,?5)",
            params![
                id,
                experiment_id,
                digest,
                frame_index as i64,
                serde_json::to_string(&frame).map_err(|_| "Anotação inválida")?
            ],
        )
        .map_err(|_| "Não foi possível registrar o frame")?;
    Ok(json!({"frame":frame,"imageUrl":url}))
}
#[tauri::command]
pub fn get_training_image(app: AppHandle, id: String) -> CommandResult<String> {
    colab::prepare_tables(&app)?;
    read_frame(&open_database(&app)?, &id)?;
    image_url(&image_path(&app, &id)?)
}
#[tauri::command]
pub fn save_training_frame(app: AppHandle, frame: FrameLabel) -> CommandResult<()> {
    colab::prepare_tables(&app)?;
    validate_local_id(&frame.id, "Frame")?;
    validate_frame(&frame)?;
    let connection = open_database(&app)?;
    let original = read_frame(&connection, &frame.id)?;
    if original.experiment_id != frame.experiment_id
        || original.video_sha256 != frame.video_sha256
        || original.image_sha256 != frame.image_sha256
        || original.frame_index != frame.frame_index
        || original.width != frame.width
        || original.height != frame.height
        || original.timestamp_sec != frame.timestamp_sec
        || original.subject_id != frame.subject_id
    {
        return Err("A origem imutável deste frame não pode ser alterada".into());
    }
    if video::sha256(&image_path(&app, &frame.id)?)? != frame.image_sha256 {
        return Err("Imagem do exemplo foi alterada".into());
    }
    let tx = connection
        .unchecked_transaction()
        .map_err(|_| "Não foi possível iniciar gravação")?;
    tx.execute("UPDATE training_frames SET annotation_json=json_set(annotation_json,'$.split',?2) WHERE video_sha256=?1",params![frame.video_sha256,frame.split]).map_err(|_|"Não foi possível atualizar o grupo do vídeo")?;
    tx.execute(
        "UPDATE training_frames SET annotation_json=?2 WHERE id=?1",
        params![
            frame.id,
            serde_json::to_string(&frame).map_err(|_| "Anotação inválida")?
        ],
    )
    .map_err(|_| "Não foi possível salvar anotação")?;
    tx.commit().map_err(|_| "Gravação interrompida".into())
}
#[tauri::command]
pub fn save_training_intervals(
    app: AppHandle,
    experiment_id: String,
    intervals: Value,
) -> CommandResult<()> {
    validate_local_id(&experiment_id, "Experimento")?;
    colab::prepare_tables(&app)?;
    let list = intervals
        .as_array()
        .filter(|v| v.len() <= 1000)
        .ok_or("Lista de trechos inválida")?;
    for item in list {
        let (a, b) = (
            item["startSec"].as_f64().ok_or("Início inválido")?,
            item["endSec"].as_f64().ok_or("Fim inválido")?,
        );
        if !a.is_finite()
            || !b.is_finite()
            || a < 0.
            || b <= a
            || b > 172800.
            || !context_valid(item["context"].as_str().unwrap_or(""))
        {
            return Err("Trecho inválido".into());
        }
    }
    open_database(&app)?
        .execute(
            "INSERT OR REPLACE INTO training_intervals VALUES (?1,?2)",
            params![experiment_id, intervals.to_string()],
        )
        .map_err(|_| "Não foi possível salvar os trechos")?;
    Ok(())
}
#[tauri::command]
pub fn get_training_state(app: AppHandle, experiment_id: String) -> CommandResult<Value> {
    validate_local_id(&experiment_id, "Experimento")?;
    colab::prepare_tables(&app)?;
    let connection = open_database(&app)?;
    let mut statement=connection.prepare("SELECT annotation_json FROM training_frames WHERE experiment_id=?1 ORDER BY frame_index").map_err(|_|"Anotações indisponíveis")?;
    let frames: Vec<Value> = statement
        .query_map([&experiment_id], |r| r.get::<_, String>(0))
        .map_err(|_| "Anotações indisponíveis")?
        .map(|r| {
            serde_json::from_str(&r.map_err(|_| "Anotação ilegível")?)
                .map_err(|_| "Anotação inválida")
        })
        .collect::<Result<_, _>>()?;
    let intervals: Option<String> = connection
        .query_row(
            "SELECT intervals_json FROM training_intervals WHERE experiment_id=?1",
            [&experiment_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "Trechos indisponíveis")?;
    let active: Option<String> = connection
        .query_row(
            "SELECT job_id FROM training_selection WHERE profile='local-default'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "Modelo indisponível")?
        .flatten();
    let mut statement = connection
        .prepare(
            "SELECT job_id,report_json,model_path FROM training_runs ORDER BY rowid DESC LIMIT 30",
        )
        .map_err(|_| "Treinos indisponíveis")?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|_| "Treinos indisponíveis")?;
    let mut runs = Vec::new();
    for row in rows {
        let (id, report, path) = row.map_err(|_| "Treino ilegível")?;
        runs.push(json!({"job":colab::get_colab_job(app.clone(),id.clone())?,"report":report.and_then(|v|serde_json::from_str::<Value>(&v).ok()),"modelAvailable":path.is_some_and(|p|Path::new(&p).is_file()),"active":active.as_ref()==Some(&id)}));
    }
    Ok(
        json!({"frames":frames,"intervals":intervals.and_then(|v|serde_json::from_str::<Value>(&v).ok()).unwrap_or(json!([])),"runs":runs,"activeModelId":active}),
    )
}

pub(crate) fn snapshot(app: &AppHandle, job_id: &str) -> CommandResult<(PathBuf, String)> {
    let connection = open_database(app)?;
    let mut statement = connection
        .prepare("SELECT annotation_json FROM training_frames ORDER BY id")
        .map_err(|_| "Dataset indisponível")?;
    let frames = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| "Dataset indisponível")?
        .map(|r| {
            serde_json::from_str::<FrameLabel>(&r.map_err(|_| "Anotação ilegível")?)
                .map_err(|_| "Anotação inválida")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let frames: Vec<_> = frames.into_iter().filter(|f| f.reviewed).collect();
    validate_dataset(&frames)?;
    let path = root(app)?.join("datasets").join(format!("{job_id}.jsonl"));
    let mut file = File::create(&path).map_err(|_| "Snapshot indisponível")?;
    writeln!(file,"{}",json!({"schemaVersion":1,"landmarks":LANDMARKS,"frameCount":frames.len(),"purpose":"experimental_detection_and_pose","snapshotId":job_id})).map_err(|_|"Falha ao salvar snapshot")?;
    let mut bytes = 0;
    for frame in frames {
        let image = image_path(app, &frame.id)?;
        let data = fs::read(&image).map_err(|_| "Imagem de treino indisponível")?;
        bytes += data.len();
        if bytes > 200 * 1024 * 1024 {
            return Err(
                "Dataset excede 200 MiB de imagens; reduza os exemplos nesta versão".into(),
            );
        }
        if video::sha256(&image)? != frame.image_sha256 {
            return Err("Imagem anotada foi alterada; snapshot cancelado".into());
        }
        writeln!(
            file,
            "{}",
            json!({"annotation":frame,"imageBase64":STANDARD.encode(data)})
        )
        .map_err(|_| "Snapshot interrompido")?;
    }
    drop(file);
    let digest = video::sha256(&path)?;
    Ok((path, digest))
}
fn validate_dataset(frames: &[FrameLabel]) -> CommandResult<()> {
    if frames.len() < 2 || frames.len() > 500 {
        return Err("Confirme entre 2 e 500 exemplos revisados para treinar. Poucos exemplos produzem apenas um modelo exploratório".into());
    }
    let mut videos = HashMap::new();
    let mut animals = HashMap::new();
    let mut train = 0;
    let mut seen = std::collections::HashSet::new();
    for f in frames {
        validate_frame(f)?;
        if f.split == "train" {
            train += 1;
        }
        if !seen.insert((f.video_sha256.clone(), f.frame_index)) {
            return Err("O mesmo frame aparece em mais de um experimento. Mantenha um único exemplo revisado para evitar duplicação".into());
        }
        for (map, key) in [
            (&mut videos, &f.video_sha256),
            (&mut animals, &f.subject_id),
        ] {
            if map
                .insert(key.clone(), f.split.clone())
                .is_some_and(|v| v != f.split)
            {
                return Err("Separe treino e validação por vídeo e por animal: o mesmo grupo não pode aparecer nos dois conjuntos".into());
            }
        }
    }
    if train < 2 {
        return Err("São necessários pelo menos dois exemplos no grupo de treino".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn start_custom_training(
    app: AppHandle,
    experiment_id: String,
    epochs: u32,
) -> CommandResult<colab::ColabJob> {
    if !(1..=20).contains(&epochs) {
        return Err("Use de 1 a 20 épocas".into());
    }
    validate_local_id(&experiment_id, "Experimento")?;
    colab::prepare_tables(&app)?;
    let active: bool = open_database(&app)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM colab_jobs WHERE status IN ('queued','running'))",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "Não foi possível consultar jobs ativos")?;
    if active {
        return Err("Aguarde as execuções ativas antes de preparar um novo treinamento".into());
    }
    let id = new_uuid_v4();
    let a = app.clone();
    let job = id.clone();
    let (path, sha) = tauri::async_runtime::spawn_blocking(move || snapshot(&a, &job))
        .await
        .map_err(|_| "Snapshot interrompido".to_string())??;
    colab::start_training(app, experiment_id, id, path, sha, epochs)
}
pub(crate) fn model_path(app: &AppHandle, job_id: &str) -> CommandResult<PathBuf> {
    validate_local_id(job_id, "Modelo")?;
    Ok(root(app)?.join("models").join(format!("{job_id}.pt")))
}
pub(crate) fn active_model(app: &AppHandle) -> CommandResult<Option<(String, PathBuf, String)>> {
    let row:Option<(String,String)>=open_database(app)?.query_row("SELECT r.job_id,r.model_sha256 FROM training_selection s JOIN training_runs r ON r.job_id=s.job_id JOIN colab_jobs j ON j.job_id=r.job_id WHERE s.profile='local-default' AND j.status='succeeded' AND r.model_path IS NOT NULL",[],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|"Modelo selecionado indisponível")?;
    row.map(|(id,digest)|{let path=model_path(app,&id)?;if video::sha256(&path)?!=digest{return Err("Modelo selecionado foi alterado ou removido. Volte ao SuperAnimal original ou selecione outra versão".into());}Ok((id,path,digest))}).transpose()
}
#[tauri::command]
pub fn select_custom_model(app: AppHandle, job_id: Option<String>) -> CommandResult<()> {
    colab::prepare_tables(&app)?;
    if let Some(id) = &job_id {
        validate_local_id(id, "Modelo")?;
        let valid:bool=open_database(&app)?.query_row("SELECT EXISTS(SELECT 1 FROM training_runs r JOIN colab_jobs j ON j.job_id=r.job_id WHERE r.job_id=?1 AND r.model_path IS NOT NULL AND j.status='succeeded')",[id],|r|r.get(0)).map_err(|_|"Modelo indisponível")?;
        if !valid {
            return Err("O treinamento ainda não produziu um modelo disponível".into());
        }
    }
    open_database(&app)?
        .execute(
            "INSERT OR REPLACE INTO training_selection VALUES ('local-default',?1)",
            params![job_id],
        )
        .map_err(|_| "Não foi possível selecionar o modelo")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(index: u64, video: &str, animal: &str, split: &str) -> FrameLabel {
        FrameLabel {
            id: new_uuid_v4(),
            experiment_id: "experiment".into(),
            subject_id: animal.into(),
            video_sha256: video.into(),
            frame_index: index,
            timestamp_sec: index as f64 / 24.,
            width: 100,
            height: 100,
            image_sha256: "image".into(),
            bbox: Some(BoxLabel {
                x: 10.,
                y: 10.,
                width: 80.,
                height: 80.,
            }),
            keypoints: LANDMARKS
                .iter()
                .map(|name| {
                    (
                        name.to_string(),
                        if *name == "nose" {
                            PointLabel {
                                state: "visible".into(),
                                x: Some(20.),
                                y: Some(30.),
                            }
                        } else {
                            PointLabel {
                                state: "occluded".into(),
                                x: None,
                                y: None,
                            }
                        },
                    )
                })
                .collect(),
            context: "walking".into(),
            split: split.into(),
            reviewed: true,
            updated_at: "now".into(),
        }
    }
    #[test]
    fn reviewed_labels_require_a_box_all_parts_and_visible_evidence() {
        let mut value = frame(0, "v", "a", "train");
        assert!(validate_frame(&value).is_ok());
        value.bbox = None;
        assert!(validate_frame(&value).is_err());
        let mut value = frame(0, "v", "a", "train");
        value.keypoints.get_mut("hip").unwrap().x = Some(50.);
        assert!(validate_frame(&value).unwrap_err().contains("inventadas"));
        let mut value = frame(0, "v", "a", "train");
        value.keypoints.get_mut("nose").unwrap().x = Some(99.);
        assert!(validate_frame(&value).is_err());
        let mut value = frame(0, "v", "a", "train");
        value.keypoints.get_mut("hip").unwrap().state = "unlabeled".into();
        assert!(validate_frame(&value).is_err());
        value.reviewed = false;
        assert!(validate_frame(&value).is_ok());
    }
    #[test]
    fn dataset_blocks_duplicate_frames_and_video_or_animal_leakage() {
        let a = frame(0, "v", "rat", "train");
        let b = frame(1, "v", "rat", "train");
        assert!(validate_dataset(&[a.clone(), b.clone()]).is_ok());
        assert!(validate_dataset(&[a.clone(), a.clone()]).is_err());
        assert!(
            validate_dataset(&[a.clone(), b.clone(), frame(2, "v", "other", "validation")])
                .is_err()
        );
        assert!(validate_dataset(&[
            a.clone(),
            b.clone(),
            frame(2, "different", "rat", "validation")
        ])
        .is_err());
        assert!(validate_dataset(&[a, b, frame(2, "different", "other", "validation")]).is_ok());
    }
    #[test]
    fn training_schema_does_not_require_or_mutate_scientific_results() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE colab_jobs(job_id TEXT PRIMARY KEY);")
            .unwrap();
        prepare_tables(&connection).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM training_frames", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        prepare_tables(&connection).unwrap();
    }
}
