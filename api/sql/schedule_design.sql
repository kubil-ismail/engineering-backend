CREATE TABLE IF NOT EXISTS schedule_designs (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT UNIQUE NOT NULL REFERENCES schedule_projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schedule_design_parts (
  id BIGSERIAL PRIMARY KEY,
  design_id BIGINT NOT NULL REFERENCES schedule_designs(id) ON DELETE CASCADE,
  part_name VARCHAR(150) NOT NULL,
  part_number VARCHAR(100) NOT NULL,
  material VARCHAR(150) NOT NULL,
  thickness_mm NUMERIC(10, 3) NOT NULL CHECK (thickness_mm > 0),
  photo_filename TEXT,
  photo_original_name TEXT,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (design_id, part_number)
);

CREATE TABLE IF NOT EXISTS schedule_design_processes (
  id BIGSERIAL PRIMARY KEY,
  part_id BIGINT NOT NULL REFERENCES schedule_design_parts(id) ON DELETE CASCADE,
  process_name VARCHAR(150) NOT NULL,
  design_type VARCHAR(30) CHECK (design_type IN ('construction_design', 'detail_2d', 'data_3d')),
  design_pic_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actual_pic_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  planned_start_date DATE,
  planned_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  progress_percent SMALLINT NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  status VARCHAR(20) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'on_progress', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (planned_end_date >= planned_start_date),
  CHECK (actual_end_date IS NULL OR actual_start_date IS NULL OR actual_end_date >= actual_start_date)
);

CREATE TABLE IF NOT EXISTS schedule_design_sub_processes (
  id BIGSERIAL PRIMARY KEY,
  process_id BIGINT NOT NULL REFERENCES schedule_design_processes(id) ON DELETE CASCADE,
  sub_process_name VARCHAR(150) NOT NULL,
  design_type VARCHAR(30) NOT NULL CHECK (design_type IN ('construction_design', 'detail_2d', 'data_3d')),
  pic_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actual_pic_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  planned_start_date DATE,
  planned_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  progress_percent SMALLINT NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  status VARCHAR(20) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'on_progress', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (planned_end_date >= planned_start_date),
  CHECK (actual_end_date IS NULL OR actual_start_date IS NULL OR actual_end_date >= actual_start_date)
);

CREATE TABLE IF NOT EXISTS schedule_design_sub_process_stages (
  id BIGSERIAL PRIMARY KEY,
  sub_process_id BIGINT NOT NULL REFERENCES schedule_design_sub_processes(id) ON DELETE CASCADE,
  design_type VARCHAR(30) NOT NULL CHECK (design_type IN ('construction_design', 'detail_2d', 'data_3d')),
  sequence_order SMALLINT NOT NULL CHECK (sequence_order BETWEEN 1 AND 3),
  pic_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actual_pic_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  planned_start_date DATE,
  planned_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (sub_process_id, design_type),
  CHECK (planned_end_date >= planned_start_date),
  CHECK (actual_end_date IS NULL OR actual_start_date IS NULL OR actual_end_date >= actual_start_date)
);

CREATE TABLE IF NOT EXISTS schedule_design_timeline_remarks (
  id BIGSERIAL PRIMARY KEY,
  process_id BIGINT REFERENCES schedule_design_processes(id) ON DELETE CASCADE,
  sub_process_id BIGINT REFERENCES schedule_design_sub_processes(id) ON DELETE CASCADE,
  stage_id BIGINT REFERENCES schedule_design_sub_process_stages(id) ON DELETE CASCADE,
  schedule_date DATE NOT NULL,
  remark_mode VARCHAR(20) NOT NULL DEFAULT 'revision' CHECK (remark_mode IN ('plan', 'actual', 'revision')),
  remark VARCHAR(300) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT schedule_design_timeline_remarks_target_check CHECK (num_nonnulls(process_id, sub_process_id, stage_id) = 1)
);

CREATE TABLE IF NOT EXISTS schedule_design_timeline_ranges (
  id BIGSERIAL PRIMARY KEY,
  process_id BIGINT REFERENCES schedule_design_processes(id) ON DELETE CASCADE,
  stage_id BIGINT REFERENCES schedule_design_sub_process_stages(id) ON DELETE CASCADE,
  range_mode VARCHAR(20) NOT NULL CHECK (range_mode IN ('plan', 'actual', 'revision')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT schedule_design_timeline_ranges_target_check CHECK (num_nonnulls(process_id, stage_id) = 1),
  CHECK (end_date >= start_date)
);

ALTER TABLE schedule_design_processes
  ADD COLUMN IF NOT EXISTS design_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS actual_pic_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS progress_percent SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'not_started';

ALTER TABLE schedule_design_sub_processes
  ADD COLUMN IF NOT EXISTS actual_pic_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS progress_percent SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'not_started';

ALTER TABLE schedule_design_processes
  ALTER COLUMN planned_start_date DROP NOT NULL,
  ALTER COLUMN planned_end_date DROP NOT NULL;

ALTER TABLE schedule_design_sub_processes
  ALTER COLUMN planned_start_date DROP NOT NULL,
  ALTER COLUMN planned_end_date DROP NOT NULL;

ALTER TABLE schedule_design_sub_process_stages
  ALTER COLUMN planned_start_date DROP NOT NULL,
  ALTER COLUMN planned_end_date DROP NOT NULL;

ALTER TABLE schedule_design_processes
  DROP CONSTRAINT IF EXISTS schedule_design_processes_progress_percent_check,
  DROP CONSTRAINT IF EXISTS schedule_design_processes_status_check;

ALTER TABLE schedule_design_processes
  ADD CONSTRAINT schedule_design_processes_progress_percent_check CHECK (progress_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT schedule_design_processes_status_check CHECK (status IN ('not_started', 'on_progress', 'completed'));

ALTER TABLE schedule_design_sub_processes
  DROP CONSTRAINT IF EXISTS schedule_design_sub_processes_progress_percent_check,
  DROP CONSTRAINT IF EXISTS schedule_design_sub_processes_status_check;

ALTER TABLE schedule_design_sub_processes
  ADD CONSTRAINT schedule_design_sub_processes_progress_percent_check CHECK (progress_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT schedule_design_sub_processes_status_check CHECK (status IN ('not_started', 'on_progress', 'completed'));

ALTER TABLE schedule_design_timeline_remarks
  ADD COLUMN IF NOT EXISTS remark_mode VARCHAR(20) NOT NULL DEFAULT 'revision',
  ADD COLUMN IF NOT EXISTS stage_id BIGINT REFERENCES schedule_design_sub_process_stages(id) ON DELETE CASCADE;

ALTER TABLE schedule_design_timeline_remarks
  DROP CONSTRAINT IF EXISTS schedule_design_timeline_remarks_check;

ALTER TABLE schedule_design_timeline_remarks
  DROP CONSTRAINT IF EXISTS schedule_design_timeline_remarks_target_check;

ALTER TABLE schedule_design_timeline_remarks
  ADD CONSTRAINT schedule_design_timeline_remarks_target_check
  CHECK (num_nonnulls(process_id, sub_process_id, stage_id) = 1);

ALTER TABLE schedule_design_timeline_ranges
  DROP CONSTRAINT IF EXISTS schedule_design_timeline_ranges_range_mode_check;

ALTER TABLE schedule_design_timeline_ranges
  ADD CONSTRAINT schedule_design_timeline_ranges_range_mode_check
  CHECK (range_mode IN ('plan', 'actual', 'revision'));

INSERT INTO schedule_design_sub_process_stages
  (sub_process_id, design_type, sequence_order, pic_user_id, actual_pic_user_id, planned_start_date, planned_end_date, actual_start_date, actual_end_date)
SELECT id, design_type, 1, pic_user_id, actual_pic_user_id, planned_start_date, planned_end_date, actual_start_date, actual_end_date
FROM schedule_design_sub_processes
ON CONFLICT (sub_process_id, design_type) DO NOTHING;

UPDATE schedule_design_timeline_remarks AS remarks
SET stage_id = (
      SELECT stages.id
      FROM schedule_design_sub_process_stages AS stages
      WHERE stages.sub_process_id = remarks.sub_process_id
      ORDER BY stages.sequence_order ASC
      LIMIT 1
    ),
    sub_process_id = NULL
WHERE remarks.sub_process_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_schedule_design_parts_design_id
  ON schedule_design_parts (design_id);

CREATE INDEX IF NOT EXISTS idx_schedule_design_processes_part_id
  ON schedule_design_processes (part_id);

CREATE INDEX IF NOT EXISTS idx_schedule_design_sub_processes_process_id
  ON schedule_design_sub_processes (process_id);

CREATE INDEX IF NOT EXISTS idx_schedule_design_sub_process_stages_sub_process_id
  ON schedule_design_sub_process_stages (sub_process_id);

DROP INDEX IF EXISTS idx_schedule_design_remarks_process_date;
DROP INDEX IF EXISTS idx_schedule_design_remarks_sub_process_date;
DROP INDEX IF EXISTS idx_schedule_design_remarks_stage_date;

CREATE UNIQUE INDEX idx_schedule_design_remarks_process_date
  ON schedule_design_timeline_remarks (process_id, schedule_date, remark_mode)
  WHERE process_id IS NOT NULL;

CREATE UNIQUE INDEX idx_schedule_design_remarks_sub_process_date
  ON schedule_design_timeline_remarks (sub_process_id, schedule_date, remark_mode)
  WHERE sub_process_id IS NOT NULL;

CREATE UNIQUE INDEX idx_schedule_design_remarks_stage_date
  ON schedule_design_timeline_remarks (stage_id, schedule_date, remark_mode)
  WHERE stage_id IS NOT NULL;

DROP INDEX IF EXISTS idx_schedule_design_ranges_process_mode;
DROP INDEX IF EXISTS idx_schedule_design_ranges_stage_mode;

CREATE INDEX idx_schedule_design_ranges_process_mode
  ON schedule_design_timeline_ranges (process_id, range_mode, start_date)
  WHERE process_id IS NOT NULL;

CREATE INDEX idx_schedule_design_ranges_stage_mode
  ON schedule_design_timeline_ranges (stage_id, range_mode, start_date)
  WHERE stage_id IS NOT NULL;

CREATE OR REPLACE FUNCTION create_design_schedule_for_project()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO schedule_designs (project_id)
  VALUES (NEW.id)
  ON CONFLICT (project_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_create_design_schedule ON schedule_projects;

CREATE TRIGGER trigger_create_design_schedule
AFTER INSERT ON schedule_projects
FOR EACH ROW
EXECUTE FUNCTION create_design_schedule_for_project();

INSERT INTO schedule_designs (project_id)
SELECT projects.id
FROM schedule_projects AS projects
ON CONFLICT (project_id) DO NOTHING;
