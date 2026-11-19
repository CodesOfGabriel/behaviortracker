CREATE TABLE IF NOT EXISTS validation_annotations (
    id TEXT PRIMARY KEY NOT NULL,
    experiment_id TEXT NOT NULL,
    video_sha256 TEXT NOT NULL CHECK (length(video_sha256) = 64),
    run_id TEXT,
    frame_index INTEGER NOT NULL CHECK (frame_index >= 0),
    timestamp_sec REAL NOT NULL CHECK (timestamp_sec >= 0),
    animal_id TEXT NOT NULL,
    keypoint TEXT NOT NULL,
    x_px REAL,
    y_px REAL,
    visibility TEXT NOT NULL CHECK (visibility IN ('visible', 'occluded', 'not_visible', 'uncertain')),
    annotator_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    reviewer_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((visibility = 'visible' AND x_px IS NOT NULL AND y_px IS NOT NULL)
        OR (visibility <> 'visible' AND x_px IS NULL AND y_px IS NULL)),
    UNIQUE (experiment_id, video_sha256, frame_index, animal_id, keypoint, annotator_id)
);

CREATE TABLE IF NOT EXISTS validation_annotation_history (
    history_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    experiment_id TEXT NOT NULL,
    video_sha256 TEXT NOT NULL,
    run_id TEXT,
    frame_index INTEGER NOT NULL,
    timestamp_sec REAL NOT NULL,
    animal_id TEXT NOT NULL,
    keypoint TEXT NOT NULL,
    x_px REAL,
    y_px REAL,
    visibility TEXT NOT NULL,
    annotator_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reviewer_id TEXT,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_validation_annotations_video_frame
ON validation_annotations (video_sha256, frame_index);

CREATE TRIGGER IF NOT EXISTS archive_validation_annotation_before_update
BEFORE UPDATE ON validation_annotations
BEGIN
    INSERT INTO validation_annotation_history (
        id, experiment_id, video_sha256, run_id, frame_index, timestamp_sec,
        animal_id, keypoint, x_px, y_px, visibility, annotator_id, status,
        reviewer_id, revision, created_at, updated_at
    ) VALUES (
        OLD.id, OLD.experiment_id, OLD.video_sha256, OLD.run_id, OLD.frame_index,
        OLD.timestamp_sec, OLD.animal_id, OLD.keypoint, OLD.x_px, OLD.y_px,
        OLD.visibility, OLD.annotator_id, OLD.status, OLD.reviewer_id,
        OLD.revision, OLD.created_at, OLD.updated_at
    );
END;
