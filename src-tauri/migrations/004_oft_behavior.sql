CREATE TABLE behavior_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    experiment_id TEXT NOT NULL,
    tracking_job_id TEXT NOT NULL REFERENCES local_tracking_jobs(job_id) ON DELETE CASCADE,
    video_sha256 TEXT NOT NULL CHECK(length(video_sha256) = 64),
    model_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    config_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','preparing','extracting','classifying','decoding','succeeded','cancelled','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT
);
CREATE INDEX idx_behavior_tracking ON behavior_jobs(tracking_job_id, created_at);
CREATE TABLE behavior_annotations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    tracking_job_id TEXT NOT NULL REFERENCES local_tracking_jobs(job_id) ON DELETE CASCADE,
    video_sha256 TEXT NOT NULL CHECK(length(video_sha256) = 64),
    annotation_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_behavior_annotations_tracking ON behavior_annotations(tracking_job_id, sequence);
CREATE TABLE behavior_review_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL REFERENCES behavior_jobs(job_id) ON DELETE CASCADE,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_behavior_review_job ON behavior_review_events(job_id, sequence);
