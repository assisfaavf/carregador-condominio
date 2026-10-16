ALTER TABLE charging_clients
ADD COLUMN IF NOT EXISTS tariff_per_kwh NUMERIC CHECK (tariff_per_kwh >= 0);
-- NULL keeps the session's default tariff. Existing history is not repriced.
