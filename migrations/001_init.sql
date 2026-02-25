CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  cpf TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  tower TEXT,
  apartment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS addresses (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  street TEXT,
  number TEXT,
  complement TEXT,
  neighborhood TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_addresses_one_default_per_user
  ON addresses(user_id) WHERE is_default = TRUE;

CREATE TABLE IF NOT EXISTS stations (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  location_label TEXT,
  tuya_device_id TEXT NOT NULL UNIQUE,
  max_current_a INTEGER NOT NULL DEFAULT 32,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  address_id BIGINT NOT NULL REFERENCES addresses(id),
  station_id BIGINT NOT NULL REFERENCES stations(id),
  status TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  duration_seconds INTEGER,
  start_energy_total NUMERIC,
  end_energy_total NUMERIC,
  energy_once NUMERIC,
  energy_kwh NUMERIC,
  energy_source TEXT,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  tariff_per_kwh NUMERIC,
  price_calculated NUMERIC,
  price_override NUMERIC,
  payment_status TEXT NOT NULL DEFAULT 'pendente',
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_start_time
  ON sessions(user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_station_start_time
  ON sessions(station_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_one_running_per_station
  ON sessions(station_id) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_one_running_per_user
  ON sessions(user_id) WHERE status = 'running';
