CREATE TABLE IF NOT EXISTS charging_clients (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  tower TEXT,
  apartment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS client_id BIGINT REFERENCES charging_clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_client_id ON sessions(client_id);
