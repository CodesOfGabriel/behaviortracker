CREATE TABLE IF NOT EXISTS google_oauth_profiles (
  profile_id TEXT PRIMARY KEY NOT NULL,
  google_client_id TEXT NOT NULL,
  client_secret TEXT,
  refresh_token TEXT,
  has_client_secret INTEGER NOT NULL DEFAULT 0,
  has_refresh_token INTEGER NOT NULL DEFAULT 0,
  account_email TEXT,
  subscription_tier TEXT,
  eligible_runtime_count INTEGER NOT NULL DEFAULT 0,
  eligible_gpu_count INTEGER NOT NULL DEFAULT 0,
  provider_error TEXT,
  connected_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS video_staging (
  upload_id TEXT PRIMARY KEY NOT NULL,
  experiment_id TEXT NOT NULL,
  local_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  received_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  ready INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS colab_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  progress INTEGER NOT NULL,
  message TEXT NOT NULL,
  runtime_name TEXT,
  session_name TEXT,
  result_path TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_colab_jobs_experiment
  ON colab_jobs(experiment_id, created_at);

CREATE TABLE IF NOT EXISTS colab_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES colab_jobs(job_id),
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_colab_events_job ON colab_job_events(job_id, id);

CREATE TABLE IF NOT EXISTS video_preparations (
  original_upload_id TEXT PRIMARY KEY REFERENCES video_staging(upload_id),
  prepared_upload_id TEXT NOT NULL REFERENCES video_staging(upload_id),
  report_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS colab_job_artifacts (
  job_id TEXT PRIMARY KEY REFERENCES colab_jobs(job_id),
  labeled_video_path TEXT,
  video_error TEXT
);
CREATE TABLE IF NOT EXISTS colab_job_diagnostics (
  job_id TEXT PRIMARY KEY REFERENCES colab_jobs(job_id),
  range_json TEXT NOT NULL,
  report_path TEXT,
  raw_pose_path TEXT
);
CREATE TABLE IF NOT EXISTS colab_job_geometry (
  job_id TEXT PRIMARY KEY REFERENCES colab_jobs(job_id),
  geometry_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS training_frames (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  video_sha256 TEXT NOT NULL,
  frame_index INTEGER NOT NULL,
  annotation_json TEXT NOT NULL,
  UNIQUE(video_sha256, frame_index, experiment_id)
);
CREATE TABLE IF NOT EXISTS training_intervals (
  experiment_id TEXT PRIMARY KEY,
  intervals_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS training_runs (
  job_id TEXT PRIMARY KEY REFERENCES colab_jobs(job_id),
  dataset_path TEXT NOT NULL,
  dataset_sha256 TEXT NOT NULL,
  report_json TEXT,
  model_path TEXT,
  model_sha256 TEXT,
  epochs INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS training_selection (
  profile TEXT PRIMARY KEY,
  job_id TEXT REFERENCES training_runs(job_id)
);
CREATE TABLE IF NOT EXISTS custom_analysis_models (
  job_id TEXT PRIMARY KEY REFERENCES colab_jobs(job_id),
  model_job_id TEXT NOT NULL REFERENCES training_runs(job_id)
);

CREATE TABLE IF NOT EXISTS local_tracking_jobs (
  job_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  video_sha256 TEXT NOT NULL,
  config_json TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
