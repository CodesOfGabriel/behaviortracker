//! Referência humana separada das correções e métricas do rastreamento.
use crate::{colab::validate_local_id, oauth::{open_database, CommandResult}};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationInput {
    id: String,
    experiment_id: String,
    video_sha256: String,
    frame_index: i64,
    timestamp_sec: f64,
    animal_id: String,
    keypoint: String,
    x_px: Option<f64>,
    y_px: Option<f64>,
    visibility: String,
    annotator_id: String,
    submit_for_review: bool,
    expected_revision: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    id: String,
    experiment_id: String,
    video_sha256: String,
    frame_index: i64,
    timestamp_sec: f64,
    animal_id: String,
    keypoint: String,
    x_px: Option<f64>,
    y_px: Option<f64>,
    visibility: String,
    annotator_id: String,
    status: String,
    reviewer_id: Option<String>,
    revision: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRevision {
    #[serde(flatten)]
    annotation: Annotation,
    superseded_at: String,
}

fn sha(value: &str) -> CommandResult<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("SHA-256 do vídeo inválido".into());
    }
    Ok(())
}

fn label(value: &str, name: &str) -> CommandResult<()> {
    if value.trim().is_empty() || value.len() > 100 || value.chars().any(char::is_control) {
        return Err(format!("{name} inválido"));
    }
    Ok(())
}

fn validate(input: &AnnotationInput) -> CommandResult<()> {
    validate_local_id(&input.id, "Anotação")?;
    validate_local_id(&input.experiment_id, "Experimento")?;
    sha(&input.video_sha256)?;
    label(&input.animal_id, "Animal")?;
    label(&input.keypoint, "Ponto")?;
    label(&input.annotator_id, "Anotador")?;
    if input.expected_revision.is_some_and(|revision| revision < 1) {
        return Err("Revisão esperada inválida".into());
    }
    if input.frame_index < 0 || !input.timestamp_sec.is_finite() || input.timestamp_sec < 0. {
        return Err("Frame ou tempo inválido".into());
    }
    if !["visible", "occluded", "not_visible", "uncertain"].contains(&input.visibility.as_str()) {
        return Err("Visibilidade inválida".into());
    }
    if input.visibility == "visible" {
        if !input.x_px.is_some_and(f64::is_finite) || !input.y_px.is_some_and(f64::is_finite)
            || input.x_px.unwrap() < 0. || input.y_px.unwrap() < 0. {
            return Err("Coordenada visível inválida".into());
        }
    } else if input.x_px.is_some() || input.y_px.is_some() {
        return Err("Ponto não visível não pode ter coordenada".into());
    }
    Ok(())
}

fn save(connection: &Connection, input: &AnnotationInput) -> CommandResult<()> {
    validate(input)?;
    let changed = connection.execute(
        "INSERT INTO validation_annotations (
           id, experiment_id, video_sha256, frame_index, timestamp_sec, animal_id,
           keypoint, x_px, y_px, visibility, annotator_id, status
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (experiment_id, video_sha256, frame_index, animal_id, keypoint, annotator_id)
         DO UPDATE SET timestamp_sec=excluded.timestamp_sec, x_px=excluded.x_px,
           y_px=excluded.y_px, visibility=excluded.visibility, status=excluded.status,
           reviewer_id=NULL, revision=validation_annotations.revision+1,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE validation_annotations.revision=?13",
        params![input.id, input.experiment_id, input.video_sha256.to_ascii_lowercase(),
                input.frame_index, input.timestamp_sec, input.animal_id.trim(), input.keypoint.trim(),
                input.x_px, input.y_px, input.visibility, input.annotator_id.trim(),
                if input.submit_for_review { "submitted" } else { "draft" },
                input.expected_revision],
    ).map_err(|_| "Não foi possível salvar a anotação humana".to_string())?;
    if changed != 1 { return Err("Anotação alterada por outra revisão; recarregue antes de salvar".into()); }
    Ok(())
}

fn review(connection: &Connection, id: &str, reviewer_id: &str, approved: bool, expected_revision: i64) -> CommandResult<()> {
    validate_local_id(id, "Anotação")?;
    label(reviewer_id, "Revisor")?;
    if expected_revision < 1 { return Err("Revisão esperada inválida".into()); }
    let changed = connection.execute(
        "UPDATE validation_annotations SET status=?2, reviewer_id=?3, revision=revision+1,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id=?1 AND status='submitted' AND revision=?4 AND annotator_id<>?3",
        params![id, if approved { "approved" } else { "rejected" }, reviewer_id.trim(), expected_revision],
    ).map_err(|_| "Não foi possível revisar a anotação".to_string())?;
    if changed != 1 { return Err("Revisão indisponível: confira o status, a revisão e a identidade do revisor".into()); }
    Ok(())
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get(0)?, experiment_id: row.get(1)?, video_sha256: row.get(2)?,
        frame_index: row.get(3)?, timestamp_sec: row.get(4)?,
        animal_id: row.get(5)?, keypoint: row.get(6)?, x_px: row.get(7)?, y_px: row.get(8)?,
        visibility: row.get(9)?, annotator_id: row.get(10)?, status: row.get(11)?,
        reviewer_id: row.get(12)?, revision: row.get(13)?, created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

fn list(connection: &Connection, experiment_id: &str, video_sha256: &str) -> CommandResult<Vec<Annotation>> {
    validate_local_id(experiment_id, "Experimento")?;
    sha(video_sha256)?;
    let mut statement = connection.prepare(
        "SELECT id, experiment_id, video_sha256, frame_index, timestamp_sec, animal_id,
                keypoint, x_px, y_px, visibility, annotator_id, status, reviewer_id,
                revision, created_at, updated_at
         FROM validation_annotations WHERE experiment_id=?1 AND video_sha256=?2
         ORDER BY frame_index, animal_id, keypoint, annotator_id"
    ).map_err(|_| "Anotações indisponíveis".to_string())?;
    let rows = statement.query_map(params![experiment_id, video_sha256.to_ascii_lowercase()], from_row)
        .map_err(|_| "Anotações indisponíveis".to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "Anotações inválidas".to_string())
}

fn list_history(connection: &Connection, experiment_id: &str, video_sha256: &str) -> CommandResult<Vec<AnnotationRevision>> {
    validate_local_id(experiment_id, "Experimento")?;
    sha(video_sha256)?;
    let mut statement = connection.prepare(
        "SELECT id, experiment_id, video_sha256, frame_index, timestamp_sec, animal_id,
                keypoint, x_px, y_px, visibility, annotator_id, status, reviewer_id,
                revision, created_at, updated_at, superseded_at
         FROM validation_annotation_history WHERE experiment_id=?1 AND video_sha256=?2
         ORDER BY frame_index, animal_id, keypoint, annotator_id, revision"
    ).map_err(|_| "Histórico de anotações indisponível".to_string())?;
    let rows = statement.query_map(params![experiment_id, video_sha256.to_ascii_lowercase()], |row| {
        Ok(AnnotationRevision { annotation: from_row(row)?, superseded_at: row.get(16)? })
    }).map_err(|_| "Histórico de anotações indisponível".to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "Histórico inválido".to_string())
}

#[tauri::command]
pub fn save_validation_annotation(app: AppHandle, annotation: AnnotationInput) -> CommandResult<()> {
    save(&open_database(&app)?, &annotation)
}

#[tauri::command]
pub fn review_validation_annotation(app: AppHandle, id: String, reviewer_id: String, approved: bool, expected_revision: i64) -> CommandResult<()> {
    review(&open_database(&app)?, &id, &reviewer_id, approved, expected_revision)
}

#[tauri::command]
pub fn list_validation_annotations(app: AppHandle, experiment_id: String, video_sha256: String) -> CommandResult<Vec<Annotation>> {
    list(&open_database(&app)?, &experiment_id, &video_sha256)
}

#[tauri::command]
pub fn list_validation_annotation_history(app: AppHandle, experiment_id: String, video_sha256: String) -> CommandResult<Vec<AnnotationRevision>> {
    list_history(&open_database(&app)?, &experiment_id, &video_sha256)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> AnnotationInput {
        AnnotationInput { id: "annotation-1".into(), experiment_id: "experiment-1".into(),
            video_sha256: "a".repeat(64), frame_index: 10, timestamp_sec: 0.4,
            animal_id: "animal_1".into(), keypoint: "mouse_center".into(),
            x_px: Some(12.), y_px: Some(13.), visibility: "visible".into(),
            annotator_id: "observer_1".into(), submit_for_review: true,
            expected_revision: None }
    }

    #[test]
    fn keeps_independent_observers_and_archives_revisions() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::database::migrate(&mut connection).unwrap();
        let first = input();
        save(&connection, &first).unwrap();
        let mut second = input();
        second.id = "annotation-2".into();
        second.annotator_id = "observer_2".into();
        second.x_px = Some(15.);
        save(&connection, &second).unwrap();
        review(&connection, "annotation-1", "reviewer", true, 1).unwrap();
        let mut revision = input();
        revision.x_px = Some(14.);
        revision.expected_revision = Some(2);
        save(&connection, &revision).unwrap();
        let rows = list(&connection, "experiment-1", &"a".repeat(64)).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].x_px, Some(14.));
        assert_eq!(rows[0].status, "submitted");
        assert_eq!(rows[0].revision, 3);
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM validation_annotation_history", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
        let history = list_history(&connection, "experiment-1", &"a".repeat(64)).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].annotation.status, "approved");
    }

    #[test]
    fn rejects_hidden_coordinates_and_unsubmitted_approval() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::database::migrate(&mut connection).unwrap();
        let mut invalid = input();
        invalid.visibility = "occluded".into();
        assert!(save(&connection, &invalid).is_err());
        let mut draft = input();
        draft.submit_for_review = false;
        save(&connection, &draft).unwrap();
        assert!(review(&connection, &draft.id, "reviewer", true, 1).is_err());
    }

    #[test]
    fn rejects_stale_edit_and_self_review_without_losing_the_approved_value() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::database::migrate(&mut connection).unwrap();
        let first = input();
        save(&connection, &first).unwrap();
        assert!(review(&connection, &first.id, &first.annotator_id, true, 1).is_err());
        review(&connection, &first.id, "reviewer", true, 1).unwrap();
        let mut stale = input();
        stale.x_px = Some(20.);
        stale.expected_revision = Some(1);
        assert!(save(&connection, &stale).is_err());
        let rows = list(&connection, &first.experiment_id, &first.video_sha256).unwrap();
        assert_eq!(rows[0].x_px, first.x_px);
        assert_eq!(rows[0].status, "approved");
    }
}
