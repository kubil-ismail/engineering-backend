CREATE TABLE IF NOT EXISTS working_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date DATE NOT NULL DEFAULT CURRENT_DATE,
  activity VARCHAR(150) NOT NULL,
  description TEXT NOT NULL,
  importance VARCHAR(20) NOT NULL DEFAULT 'neutral',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  is_closed BOOLEAN NOT NULL DEFAULT FALSE,
  admin_comment TEXT,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT working_logs_importance_check
    CHECK (importance IN ('urgent', 'important', 'neutral'))
);

ALTER TABLE IF EXISTS working_logs
  ADD COLUMN IF NOT EXISTS log_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_closed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_comment TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

UPDATE working_logs
SET importance = 'neutral'
WHERE importance = 'other';

ALTER TABLE IF EXISTS working_logs
  DROP CONSTRAINT IF EXISTS working_logs_importance_check;

ALTER TABLE IF EXISTS working_logs
  ADD CONSTRAINT working_logs_importance_check
  CHECK (importance IN ('urgent', 'important', 'neutral'));

CREATE INDEX IF NOT EXISTS idx_working_logs_user_created
  ON working_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_working_logs_log_date
  ON working_logs (log_date DESC);

CREATE INDEX IF NOT EXISTS idx_working_logs_importance_created
  ON working_logs (importance, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_working_logs_created
  ON working_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS working_log_comments (
  id BIGSERIAL PRIMARY KEY,
  log_id BIGINT NOT NULL REFERENCES working_logs(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_working_log_comments_log_created
  ON working_log_comments (log_id, created_at ASC);
