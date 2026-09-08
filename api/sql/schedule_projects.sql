CREATE TABLE IF NOT EXISTS schedule_projects (
  id BIGSERIAL PRIMARY KEY,
  project_name VARCHAR(150) NOT NULL,
  customer VARCHAR(150) NOT NULL,
  project_date DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_schedule_projects_project_date
  ON schedule_projects (project_date DESC);

CREATE INDEX IF NOT EXISTS idx_schedule_projects_created_by
  ON schedule_projects (created_by);
