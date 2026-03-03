CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value)
VALUES
  ('price_per_kwh', '2.50'),
  ('default_charge_current_a', '32')
ON CONFLICT (key) DO NOTHING;
