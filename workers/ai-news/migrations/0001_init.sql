PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_author TEXT,
  source_url TEXT NOT NULL,
  raw_title TEXT NOT NULL,
  raw_text TEXT NOT NULL DEFAULT '',
  ai_headline TEXT NOT NULL,
  ai_summary TEXT NOT NULL DEFAULT '',
  company TEXT,
  model_names TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT 'general',
  verification_status TEXT NOT NULL DEFAULT 'community'
    CHECK (verification_status IN ('official', 'confirmed', 'community', 'unverified')),
  importance_score INTEGER NOT NULL DEFAULT 50
    CHECK (importance_score BETWEEN 0 AND 100),
  dedupe_key TEXT NOT NULL,
  published_at TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(source_platform, external_id),
  UNIQUE(source_url),
  UNIQUE(dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_news_items_published_at
  ON news_items(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_items_verification
  ON news_items(verification_status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_items_company
  ON news_items(company, published_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  fetched_count INTEGER NOT NULL DEFAULT 0,
  stored_count INTEGER NOT NULL DEFAULT 0,
  error_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_completed_at
  ON ingestion_runs(completed_at DESC);
