PRAGMA foreign_keys = ON;

-- Independent fenced leases for the two hourly intelligence products.
CREATE TABLE IF NOT EXISTS intelligence_pipeline_leases (
  pipeline TEXT PRIMARY KEY
    CHECK (pipeline IN ('news-hourly', 'benchmarks-hourly')),
  run_key TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  last_completed_run_key TEXT,
  last_completed_at TEXT,
  last_status TEXT
    CHECK (last_status IN ('success', 'partial', 'failed', 'skipped')),
  last_error_code TEXT,
  skip_count INTEGER NOT NULL DEFAULT 0 CHECK (skip_count >= 0)
);

CREATE TABLE IF NOT EXISTS intelligence_pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline TEXT NOT NULL
    CHECK (pipeline IN ('news-hourly', 'benchmarks-hourly')),
  run_key TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
  fetched_count INTEGER NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
  stored_count INTEGER NOT NULL DEFAULT 0 CHECK (stored_count >= 0),
  succeeded_sources INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_sources >= 0),
  failed_sources INTEGER NOT NULL DEFAULT 0 CHECK (failed_sources >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (pipeline, run_key)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_pipeline_runs_latest
  ON intelligence_pipeline_runs(pipeline, completed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS intelligence_news_sources (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  source_type TEXT NOT NULL
    CHECK (source_type IN ('rss', 'atom', 'github_releases', 'youtube_feed', 'x', 'official_site')),
  endpoint TEXT,
  official_site TEXT,
  x_handle TEXT,
  verification TEXT NOT NULL DEFAULT 'official'
    CHECK (verification IN ('official', 'confirmed')),
  rotation_group INTEGER NOT NULL DEFAULT 0 CHECK (rotation_group >= 0),
  last_verified_at TEXT,
  disabled_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_news_sources_endpoint
  ON intelligence_news_sources(endpoint)
  WHERE endpoint IS NOT NULL;

CREATE TABLE IF NOT EXISTS intelligence_news_source_health (
  source_id TEXT PRIMARY KEY
    REFERENCES intelligence_news_sources(id) ON DELETE CASCADE,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_item_at TEXT,
  status TEXT NOT NULL DEFAULT 'never'
    CHECK (status IN ('never', 'healthy', 'degraded', 'failed', 'unavailable', 'disabled')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error_code TEXT,
  last_error_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_intelligence_news_source_health_status
  ON intelligence_news_source_health(status, last_success_at DESC);

CREATE TABLE IF NOT EXISTS intelligence_news_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  primary_url TEXT NOT NULL,
  company TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  verification TEXT NOT NULL
    CHECK (verification IN ('official', 'confirmed')),
  importance_score INTEGER NOT NULL DEFAULT 50
    CHECK (importance_score BETWEEN 0 AND 100),
  published_at TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  image_url TEXT,
  image_credit TEXT,
  video_url TEXT,
  media_type TEXT NOT NULL DEFAULT 'none'
    CHECK (media_type IN ('none', 'image', 'video')),
  media_source TEXT,
  model_names TEXT NOT NULL DEFAULT '[]',
  source_count INTEGER NOT NULL DEFAULT 1 CHECK (source_count >= 1),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_news_events_primary_url
  ON intelligence_news_events(primary_url);

CREATE INDEX IF NOT EXISTS idx_intelligence_news_events_published
  ON intelligence_news_events(published_at DESC, importance_score DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_news_events_company
  ON intelligence_news_events(company, published_at DESC);

CREATE TABLE IF NOT EXISTS intelligence_news_event_sources (
  event_id TEXT NOT NULL
    REFERENCES intelligence_news_events(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL
    REFERENCES intelligence_news_sources(id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  verification TEXT NOT NULL
    CHECK (verification IN ('official', 'confirmed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (event_id, source_id, external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_news_event_sources_url
  ON intelligence_news_event_sources(url);

CREATE TABLE IF NOT EXISTS benchmark_datasets_v2 (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'Artificial Analysis'
    CHECK (source = 'Artificial Analysis'),
  metric TEXT NOT NULL DEFAULT 'Artificial Analysis Intelligence Index'
    CHECK (metric = 'Artificial Analysis Intelligence Index'),
  source_url TEXT NOT NULL,
  methodology_version TEXT,
  source_observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  status TEXT NOT NULL
    CHECK (status IN ('candidate', 'current', 'superseded', 'rejected')),
  checksum TEXT,
  error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_benchmark_datasets_v2_status
  ON benchmark_datasets_v2(status, ingested_at DESC);

CREATE TABLE IF NOT EXISTS benchmark_rows_v2 (
  dataset_id TEXT NOT NULL
    REFERENCES benchmark_datasets_v2(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  variant_label TEXT,
  effort TEXT,
  intelligence_index REAL NOT NULL
    CHECK (intelligence_index >= 0 AND intelligence_index < 200),
  output_tokens_per_second REAL CHECK (output_tokens_per_second IS NULL OR output_tokens_per_second >= 0),
  time_to_first_token_seconds REAL CHECK (time_to_first_token_seconds IS NULL OR time_to_first_token_seconds >= 0),
  end_to_end_seconds REAL CHECK (end_to_end_seconds IS NULL OR end_to_end_seconds >= 0),
  input_price_per_1m_usd REAL CHECK (input_price_per_1m_usd IS NULL OR input_price_per_1m_usd >= 0),
  output_price_per_1m_usd REAL CHECK (output_price_per_1m_usd IS NULL OR output_price_per_1m_usd >= 0),
  cache_write_price_per_1m_usd REAL CHECK (cache_write_price_per_1m_usd IS NULL OR cache_write_price_per_1m_usd >= 0),
  cache_hit_price_per_1m_usd REAL CHECK (cache_hit_price_per_1m_usd IS NULL OR cache_hit_price_per_1m_usd >= 0),
  cost_per_task_usd REAL CHECK (cost_per_task_usd IS NULL OR cost_per_task_usd >= 0),
  context_window_tokens INTEGER CHECK (context_window_tokens IS NULL OR context_window_tokens >= 0),
  open_weights INTEGER CHECK (open_weights IS NULL OR open_weights IN (0, 1)),
  release_date TEXT,
  price_provenance_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (dataset_id, row_id),
  UNIQUE (dataset_id, rank)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_rows_v2_rank
  ON benchmark_rows_v2(dataset_id, rank ASC);

CREATE TABLE IF NOT EXISTS benchmark_current_v2 (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  dataset_id TEXT NOT NULL
    REFERENCES benchmark_datasets_v2(id) ON DELETE RESTRICT,
  promoted_at TEXT NOT NULL
);
