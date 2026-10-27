-- Access codes: only the SHA-256 hash of each code is stored.
CREATE TABLE access_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  max_creations INTEGER NOT NULL,
  used_creations INTEGER NOT NULL DEFAULT 0,
  max_sam_images INTEGER NOT NULL,
  used_sam_images INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- One row per routine creation (or repair) in the app; counts its model calls.
CREATE TABLE creations (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES access_codes(id),
  calls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Counts only. Request and response bodies are never stored.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL,
  creation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'segment')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX usage_events_code ON usage_events (code_id);

CREATE TABLE spend_daily (
  day TEXT PRIMARY KEY,
  est_cost_usd REAL NOT NULL DEFAULT 0
);

-- Runtime switches set through the admin API (e.g. pause without redeploying).
CREATE TABLE worker_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
