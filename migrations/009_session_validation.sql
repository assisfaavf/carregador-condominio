-- Preserve historic sessions: NULL means legacy/unreviewed, never auto-approve.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reconciliation JSONB;
CREATE TABLE IF NOT EXISTS session_energy_readings (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES sessions(id),
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  total_kwh NUMERIC,
  once_kwh NUMERIC,
  power_kw NUMERIC,
  current_a NUMERIC,
  voltage_v NUMERIC,
  work_state TEXT,
  charging BOOLEAN NOT NULL,
  raw_fields JSONB NOT NULL,
  UNIQUE(session_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_energy_readings_session_time ON session_energy_readings(session_id, observed_at);
CREATE TABLE IF NOT EXISTS session_revisions (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES sessions(id),
  actor_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL,
  before_values JSONB NOT NULL,
  after_values JSONB NOT NULL,
  reason TEXT NOT NULL
);
