CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  remembered BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  auth_session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_push_subscription_session ON push_subscriptions(auth_session_id);
CREATE TABLE push_station_state (
  station_id BIGINT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  connected BOOLEAN,
  charging BOOLEAN,
  connection_cycle BIGINT NOT NULL DEFAULT 0,
  charging_cycle BIGINT NOT NULL DEFAULT 0,
  observed_at TIMESTAMPTZ NOT NULL
);
-- Only validations performed after this migration can produce a finalization notice.
ALTER TABLE sessions ADD COLUMN push_validated_at TIMESTAMPTZ;
CREATE TABLE push_events (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  station_id BIGINT NOT NULL REFERENCES stations(id),
  session_id BIGINT REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('connected','started','finished')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE push_deliveries (
  event_id BIGINT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
  subscription_id BIGINT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','sent','failed','skipped')),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  PRIMARY KEY(event_id, subscription_id)
);
CREATE INDEX idx_push_pending ON push_deliveries(event_id) WHERE state='pending';
CREATE INDEX idx_push_recent_events ON push_events(created_at);
CREATE INDEX idx_push_finished_sessions ON sessions(push_validated_at) WHERE status='done' AND reconciliation->>'status'='validated';
