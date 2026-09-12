CREATE TABLE IF NOT EXISTS ingestion_leases (
  lock_key TEXT PRIMARY KEY,
  run_key TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  last_completed_at TEXT,
  last_completed_run_key TEXT,
  last_status TEXT CHECK (last_status IN ('success', 'partial', 'failed')),
  last_skipped_at TEXT,
  skip_count INTEGER NOT NULL DEFAULT 0 CHECK (skip_count >= 0)
);
