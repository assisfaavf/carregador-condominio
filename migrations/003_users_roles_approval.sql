ALTER TABLE users
ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved';

ALTER TABLE users
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE users
ALTER COLUMN role SET DEFAULT 'morador';

UPDATE users
SET role = CASE
  WHEN COALESCE(role, '') IN ('visitor', 'visitante') THEN 'visitante'
  ELSE 'morador'
END;

UPDATE users
SET approval_status = CASE
  WHEN approval_status IN ('pending', 'approved', 'rejected') THEN approval_status
  WHEN is_admin = TRUE THEN 'approved'
  ELSE 'approved'
END;

UPDATE users
SET approved_at = COALESCE(approved_at, created_at, NOW())
WHERE approval_status = 'approved';
