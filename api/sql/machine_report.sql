CREATE TABLE IF NOT EXISTS machines (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  type VARCHAR(100) NOT NULL,
  location VARCHAR(150) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS machine_report_consumable_costs (
  id BIGSERIAL PRIMARY KEY,
  machine_id BIGINT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  report_period DATE NOT NULL,
  consumables VARCHAR(150) NOT NULL,
  quantity NUMERIC(15,4) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit VARCHAR(20) NOT NULL DEFAULT 'unit',
  unit_price NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_machine_report_consumable_costs_machine
  ON machine_report_consumable_costs (machine_id);

CREATE INDEX IF NOT EXISTS idx_machine_report_consumable_costs_period
  ON machine_report_consumable_costs (report_period DESC);

CREATE TABLE IF NOT EXISTS machine_report_shared_cost_items (
  id BIGSERIAL PRIMARY KEY,
  location VARCHAR(150) NOT NULL,
  report_period DATE NOT NULL,
  description VARCHAR(150) NOT NULL,
  quantity NUMERIC(15,4) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit VARCHAR(20) NOT NULL DEFAULT 'unit',
  unit_price NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_machine_report_shared_cost_items_location
  ON machine_report_shared_cost_items (location);

CREATE INDEX IF NOT EXISTS idx_machine_report_shared_cost_items_period
  ON machine_report_shared_cost_items (report_period DESC);

CREATE TABLE IF NOT EXISTS machine_report_uploads (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  machine_id BIGINT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  period TEXT NOT NULL,
  file_name TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_machine_report_uploads_user
  ON machine_report_uploads (user_id);

CREATE INDEX IF NOT EXISTS idx_machine_report_uploads_period
  ON machine_report_uploads (period DESC);

CREATE INDEX IF NOT EXISTS idx_machine_report_uploads_machine
  ON machine_report_uploads (machine_id);

CREATE TABLE IF NOT EXISTS machine_report_runs (
  id BIGSERIAL PRIMARY KEY,
  upload_id BIGINT NOT NULL REFERENCES machine_report_uploads(id) ON DELETE CASCADE,
  started_at TEXT,
  program_comment TEXT,
  run_time_seconds DOUBLE PRECISION,
  total_time_seconds DOUBLE PRECISION,
  workpiece_material TEXT,
  workpiece_thickness DOUBLE PRECISION,
  wire_weight_grams DOUBLE PRECISION,
  wire_breaks DOUBLE PRECISION,
  cut_length DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_machine_report_runs_upload
  ON machine_report_runs (upload_id);
