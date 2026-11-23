CREATE TABLE ram_review_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL REFERENCES local_tracking_jobs(job_id) ON DELETE CASCADE,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_ram_review_job ON ram_review_events(job_id, sequence);
