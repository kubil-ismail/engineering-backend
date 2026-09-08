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

ALTER TABLE IF EXISTS machine_report_consumable_costs
  ADD COLUMN IF NOT EXISTS machine_id BIGINT,
  ADD COLUMN IF NOT EXISTS report_period DATE,
  ADD COLUMN IF NOT EXISTS consumables VARCHAR(150),
  ADD COLUMN IF NOT EXISTS quantity NUMERIC(15,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit VARCHAR(20) NOT NULL DEFAULT 'unit',
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE IF EXISTS machine_report_consumable_costs
  DROP CONSTRAINT IF EXISTS machine_report_consumable_costs_quantity_check,
  DROP CONSTRAINT IF EXISTS machine_report_consumable_costs_unit_price_check,
  DROP CONSTRAINT IF EXISTS machine_report_consumable_costs_line_total_check,
  DROP CONSTRAINT IF EXISTS machine_report_consumable_costs_machine_id_fkey;

ALTER TABLE IF EXISTS machine_report_consumable_costs
  ADD CONSTRAINT machine_report_consumable_costs_quantity_check CHECK (quantity >= 0),
  ADD CONSTRAINT machine_report_consumable_costs_unit_price_check CHECK (unit_price >= 0),
  ADD CONSTRAINT machine_report_consumable_costs_line_total_check CHECK (line_total >= 0),
  ADD CONSTRAINT machine_report_consumable_costs_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_machine_report_consumable_costs_machine
  ON machine_report_consumable_costs (machine_id);

CREATE INDEX IF NOT EXISTS idx_machine_report_consumable_costs_period
  ON machine_report_consumable_costs (report_period DESC);
