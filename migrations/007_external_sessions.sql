ALTER TABLE sessions
ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE sessions
ALTER COLUMN address_id DROP NOT NULL;

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'program';

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS authorization_method TEXT NOT NULL DEFAULT 'program';

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ;

ALTER TABLE sessions
DROP CONSTRAINT IF EXISTS sessions_origin_check;

ALTER TABLE sessions
ADD CONSTRAINT sessions_origin_check CHECK (origin IN ('program', 'external'));

UPDATE sessions
SET origin = 'program', authorization_method = 'program'
WHERE origin IS NULL OR authorization_method IS NULL;
