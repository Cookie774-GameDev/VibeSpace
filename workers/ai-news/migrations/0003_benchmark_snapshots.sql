CREATE TABLE IF NOT EXISTS benchmark_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  benchmark_date TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 10 AND 100),
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_benchmark_snapshots_ingested_at
  ON benchmark_snapshots(ingested_at DESC);
