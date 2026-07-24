ALTER TABLE stations
ADD COLUMN IF NOT EXISTS phase_count INTEGER NOT NULL DEFAULT 1;

ALTER TABLE stations
DROP CONSTRAINT IF EXISTS stations_phase_count_check;

ALTER TABLE stations
ADD CONSTRAINT stations_phase_count_check CHECK (phase_count IN (1, 3));
