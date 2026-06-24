ALTER TABLE stations
DROP CONSTRAINT IF EXISTS stations_phase_count_check;

ALTER TABLE stations
DROP COLUMN IF EXISTS phase_count;
