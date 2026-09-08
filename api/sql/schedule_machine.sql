CREATE TABLE IF NOT EXISTS schedule_machine_items (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES schedule_projects(id) ON DELETE CASCADE,
  machine_id BIGINT REFERENCES machines(id) ON DELETE RESTRICT,
  item_name VARCHAR(150) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  program_pic_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  operator_pic_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  planned_start_date DATE,
  planned_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (planned_end_date IS NULL OR planned_start_date IS NULL OR planned_end_date >= planned_start_date),
  CHECK (actual_end_date IS NULL OR actual_start_date IS NULL OR actual_end_date >= actual_start_date)
);

ALTER TABLE schedule_machine_items
  ADD COLUMN IF NOT EXISTS machine_id BIGINT REFERENCES machines(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS program_pic_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS operator_pic_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS planned_start_date DATE,
  ADD COLUMN IF NOT EXISTS planned_end_date DATE,
  ADD COLUMN IF NOT EXISTS actual_start_date DATE,
  ADD COLUMN IF NOT EXISTS actual_end_date DATE;

CREATE INDEX IF NOT EXISTS idx_schedule_machine_items_project_id
  ON schedule_machine_items (project_id);

CREATE INDEX IF NOT EXISTS idx_schedule_machine_items_machine_id
  ON schedule_machine_items (machine_id);

CREATE TABLE IF NOT EXISTS schedule_machine_timeline_remarks (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT NOT NULL REFERENCES schedule_machine_items(id) ON DELETE CASCADE,
  schedule_date DATE NOT NULL,
  remark_mode VARCHAR(20) NOT NULL CHECK (remark_mode IN ('plan', 'actual')),
  remark VARCHAR(300) NOT NULL,
  time_process NUMERIC(10,2),
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (item_id, schedule_date, remark_mode)
);

CREATE INDEX IF NOT EXISTS idx_schedule_machine_remarks_item_id
  ON schedule_machine_timeline_remarks (item_id);

ALTER TABLE schedule_machine_timeline_remarks
  ADD COLUMN IF NOT EXISTS time_process NUMERIC(10,2);
