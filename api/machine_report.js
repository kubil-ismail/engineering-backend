import { Router } from "express";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function toPublicMachine(machine) {
  return {
    id: machine.id,
    name: machine.name,
    type: machine.type,
    location: machine.location,
    createdAt: machine.created_at,
  };
}

function validateMachine({ name, type, location }) {
  const errors = {};
  const values = {
    name: normalizeText(name),
    type: normalizeText(type),
    location: normalizeText(location),
  };

  if (!values.name) {
    errors.name = "Machine name is required.";
  } else if (values.name.length > 150) {
    errors.name = "Machine name maximum 150 characters.";
  }

  if (!values.type) {
    errors.type = "Machine type is required.";
  } else if (values.type.length > 100) {
    errors.type = "Machine type maximum 100 characters.";
  }

  if (!values.location) {
    errors.location = "Location is required.";
  } else if (values.location.length > 150) {
    errors.location = "Location maximum 150 characters.";
  }

  return { errors, values };
}

export default function createMachineReportRouter({ pool }) {
  const router = Router();

  router.get("/", (req, res) => {
    res.json({
      service: "machine_report",
      message: "Machine Report service is ready.",
      userId: req.auth.sub,
    });
  });

  router.get("/health", async (req, res, next) => {
    try {
      await pool.query("SELECT 1");
      return res.json({
        service: "machine_report",
        status: "healthy",
        database: "connected",
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/machines", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, name, type, location, created_at
         FROM machines
         ORDER BY name ASC`,
      );

      return res.json({ machines: result.rows.map(toPublicMachine) });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/machine-locations", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT DISTINCT location
         FROM machines
         WHERE location IS NOT NULL AND BTRIM(location) <> ''
         ORDER BY location ASC`,
      );

      return res.json({ locations: result.rows.map((row) => row.location) });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/machines", async (req, res, next) => {
    try {
      const { errors, values } = validateMachine(req.body);

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ message: "Machine data is not valid.", errors });
      }

      const result = await pool.query(
        `INSERT INTO machines (name, type, location)
         VALUES ($1, $2, $3)
         RETURNING id, name, type, location, created_at`,
        [values.name, values.type, values.location],
      );

      return res.status(201).json({
        message: "Machine created successfully.",
        machine: toPublicMachine(result.rows[0]),
      });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ message: "Machine name is already registered." });
      }

      return next(error);
    }
  });

  router.put("/machines/:id", async (req, res, next) => {
    try {
      const machineId = Number(req.params.id);

      if (!Number.isInteger(machineId) || machineId <= 0) {
        return res.status(400).json({ message: "Machine id is not valid." });
      }

      const { errors, values } = validateMachine(req.body);

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ message: "Machine data is not valid.", errors });
      }

      const result = await pool.query(
        `UPDATE machines
            SET name = $1, type = $2, location = $3
          WHERE id = $4
          RETURNING id, name, type, location, created_at`,
        [values.name, values.type, values.location, machineId],
      );

      if (!result.rows[0]) {
        return res.status(404).json({ message: "Machine not found." });
      }

      return res.json({
        message: "Machine updated successfully.",
        machine: toPublicMachine(result.rows[0]),
      });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ message: "Machine name is already registered." });
      }

      return next(error);
    }
  });

  router.delete("/machines/:id", async (req, res, next) => {
    let client;

    try {
      const machineId = Number(req.params.id);

      if (!Number.isInteger(machineId) || machineId <= 0) {
        return res.status(400).json({ message: "Machine id is not valid." });
      }

      client = await pool.connect();

      const machineResult = await client.query(
        "SELECT name FROM machines WHERE id = $1 LIMIT 1",
        [machineId],
      );

      if (!machineResult.rows[0]) {
        return res.status(404).json({ message: "Machine not found." });
      }

      await client.query("BEGIN");

      const depCosts = await client.query(
        "SELECT COUNT(*)::int AS n FROM machine_report_consumable_costs WHERE machine_id = $1",
        [machineId],
      );
      const depUploads = await client.query(
        "SELECT COUNT(*)::int AS n FROM machine_report_uploads WHERE machine_id = $1",
        [machineId],
      );
      const depSchedule = await client.query(
        "SELECT COUNT(*)::int AS n FROM schedule_machine_items WHERE machine_id = $1",
        [machineId],
      );

      const dependencies = {
        costEntries: depCosts.rows[0].n,
        uploads: depUploads.rows[0].n,
        scheduleItems: depSchedule.rows[0].n,
      };

      const forceDelete = req.query.cascade === "1" || req.body?.cascade === true;

      if (!forceDelete && (dependencies.costEntries > 0 || dependencies.uploads > 0 || dependencies.scheduleItems > 0)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: `"${machineResult.rows[0].name}" still has machine reports, cost entries, or schedule items. Delete with cascade=1 to remove them as well.`,
          cascade: true,
          dependencies,
        });
      }

      await client.query("DELETE FROM machine_report_consumable_costs WHERE machine_id = $1", [machineId]);
      await client.query("DELETE FROM machine_report_uploads WHERE machine_id = $1", [machineId]);
      await client.query("UPDATE schedule_machine_items SET machine_id = NULL WHERE machine_id = $1", [machineId]);
      await client.query("DELETE FROM machines WHERE id = $1", [machineId]);

      await client.query("COMMIT");

      return res.json({ message: "Machine deleted successfully.", dependencies });
    } catch (error) {
      try {
        await client?.query("ROLLBACK");
      } catch {
      }

      return next(error);
    } finally {
      client?.release();
    }
  });

  router.get("/costs", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT entries.id,
                entries.machine_id,
                machines.name   AS machine_name,
                machines.type   AS machine_type,
                to_char(entries.report_period, 'YYYY-MM') AS period,
                entries.consumables,
                entries.quantity,
                entries.unit,
                entries.unit_price,
                entries.line_total,
                entries.created_at,
                entries.updated_at
         FROM machine_report_consumable_costs AS entries
         JOIN machines ON machines.id = entries.machine_id
         ORDER BY entries.report_period DESC, machines.name ASC, entries.id ASC`,
      );

      return res.json({
        costs: result.rows.map((row) => ({
          id: row.id,
          machineId: row.machine_id,
          machineName: row.machine_name,
          machineType: row.machine_type,
          period: row.period,
          consumables: row.consumables,
          quantity: Number(row.quantity),
          unit: row.unit,
          unitPrice: Number(row.unit_price),
          lineTotal: Number(row.line_total),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/costs/:id", async (req, res, next) => {
    try {
      const costId = Number(req.params.id);

      if (!Number.isInteger(costId) || costId <= 0) {
        return res.status(400).json({ message: "Cost id is not valid." });
      }

      const result = await pool.query(
        `SELECT entries.id,
                entries.machine_id,
                machines.name   AS machine_name,
                machines.type   AS machine_type,
                to_char(entries.report_period, 'YYYY-MM') AS period,
                entries.consumables,
                entries.quantity,
                entries.unit,
                entries.unit_price,
                entries.line_total,
                entries.created_at,
                entries.updated_at
         FROM machine_report_consumable_costs AS entries
         JOIN machines ON machines.id = entries.machine_id
         WHERE entries.id = $1
         LIMIT 1`,
        [costId],
      );
      const row = result.rows[0];

      if (!row) {
        return res.status(404).json({ message: "Cost item not found." });
      }

      return res.json({
        id: row.id,
        machineId: row.machine_id,
        machineName: row.machine_name,
        machineType: row.machine_type,
        period: row.period,
        consumables: row.consumables,
        quantity: Number(row.quantity),
        unit: row.unit,
        unitPrice: Number(row.unit_price),
        lineTotal: Number(row.line_total),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } catch (error) {
      return next(error);
    }
  });

  function toPositiveNumber(value) {
    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function parseConsumableItems(raw) {
    if (!Array.isArray(raw)) {
      return null;
    }

    const items = [];

    for (const item of raw) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const consumables = String(item.consumables ?? item.description ?? "").trim().slice(0, 150);

      if (!consumables) {
        continue;
      }

      const quantity = toPositiveNumber(item.quantity) ?? 1;
      const unitPrice = toPositiveNumber(item.unitPrice ?? item.price);

      if (unitPrice === null) {
        continue;
      }

      const lineTotal = Math.round(quantity * unitPrice * 100) / 100;

      items.push({
        consumables,
        unit: String(item.unit ?? "").trim().slice(0, 20) || "unit",
        quantity,
        unitPrice,
        lineTotal,
      });
    }

    return { items };
  }

  router.post("/costs", async (req, res, next) => {
    let client;

    try {
      const machineId = Number(req.body.machineId);

      if (!Number.isInteger(machineId) || machineId <= 0) {
        return res.status(400).json({ message: "Machine id is not valid." });
      }

      const periodRaw = normalizeText(req.body.period || req.body.reportPeriod);

      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodRaw)) {
        return res.status(400).json({ message: "Period must be in YYYY-MM format." });
      }

      const parsed = parseConsumableItems(req.body.items);

      if (parsed === null) {
        return res.status(400).json({ message: "Consumable cost items are not valid." });
      }

      client = await pool.connect();

      const machineResult = await client.query(
        "SELECT id, name, type FROM machines WHERE id = $1 LIMIT 1",
        [machineId],
      );
      const machine = machineResult.rows[0];

      if (!machine) {
        return res.status(400).json({ message: "Machine not found." });
      }

      const isWireCut = /wirecut/i.test(machine.type || machine.name);

      if (isWireCut) {
        const hasWireCost = parsed.items.some(
          (item) => String(item.consumables).toLowerCase() === "wire cost" && Number(item.unitPrice) > 0,
        );

        if (!hasWireCost) {
          return res.status(400).json({ message: "Wire Cost with a price is required for a wire-cut machine." });
        }
      }

      const periodStart = `${periodRaw}-01`;

      await client.query(
        "DELETE FROM machine_report_consumable_costs WHERE machine_id = $1 AND report_period = $2",
        [machineId, periodStart],
      );

      const rows = [];
      for (const item of parsed.items) {
        const insertResult = await client.query(
          `INSERT INTO machine_report_consumable_costs
             (machine_id, report_period, consumables, quantity, unit, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING
             id,
             machine_id,
             to_char(report_period, 'YYYY-MM') AS period,
             consumables,
             quantity,
             unit,
             unit_price,
             line_total`,
          [machineId, periodStart, item.consumables, item.quantity, item.unit, item.unitPrice, item.lineTotal],
        );
        rows.push(insertResult.rows[0]);
      }

      return res.status(201).json({
        message: "Consumable costs saved successfully.",
        costs: rows.map((row) => ({
          id: row.id,
          machineId: row.machine_id,
          machineName: machine.name,
          machineType: machine.type,
          period: row.period,
          consumables: row.consumables,
          quantity: Number(row.quantity),
          unit: row.unit,
          unitPrice: Number(row.unit_price),
          lineTotal: Number(row.line_total),
        })),
      });
    } catch (error) {
      return next(error);
    } finally {
      if (client) {
        client.release();
      }
    }
  });

  router.delete("/costs/:id", async (req, res, next) => {
    try {
      const costId = Number(req.params.id);

      if (!Number.isInteger(costId) || costId <= 0) {
        return res.status(400).json({ message: "Cost id is not valid." });
      }

      const result = await pool.query(
        "DELETE FROM machine_report_consumable_costs WHERE id = $1 RETURNING id",
        [costId],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Cost item not found." });
      }

      return res.json({ message: "Cost item deleted successfully." });
    } catch (error) {
      return next(error);
    }
  });

  function toPublicSharedCost(row) {
    return {
      id: row.id,
      location: row.location,
      period: row.period,
      description: row.description,
      quantity: Number(row.quantity),
      unit: row.unit,
      unitPrice: Number(row.unit_price),
      lineTotal: Number(row.line_total),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function parseSharedCostItems(raw) {
    if (!Array.isArray(raw)) {
      return null;
    }

    const items = [];

    for (const item of raw) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const description = String(item.description ?? "").trim().slice(0, 150);

      if (!description) {
        continue;
      }

      const quantity = toPositiveNumber(item.quantity) ?? 1;
      const unitPrice = toPositiveNumber(item.unitPrice ?? item.price);

      if (unitPrice === null) {
        continue;
      }

      const lineTotal = Math.round(quantity * unitPrice * 100) / 100;

      items.push({
        description,
        unit: String(item.unit ?? "").trim().slice(0, 20) || "unit",
        quantity,
        unitPrice,
        lineTotal,
      });
    }

    return { items };
  }

  router.get("/shared-costs", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id,
                location,
                to_char(report_period, 'YYYY-MM') AS period,
                description,
                quantity,
                unit,
                unit_price,
                line_total,
                created_at,
                updated_at
         FROM machine_report_shared_cost_items
         ORDER BY report_period DESC, location ASC, id ASC`,
      );

      return res.json({ sharedCosts: result.rows.map(toPublicSharedCost) });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/shared-costs", async (req, res, next) => {
    let client;

    try {
      const location = normalizeText(req.body.location);

      if (!location) {
        return res.status(400).json({ message: "Location is required." });
      }

      const periodRaw = normalizeText(req.body.period || req.body.reportPeriod);

      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodRaw)) {
        return res.status(400).json({ message: "Period must be in YYYY-MM format." });
      }

      const parsed = parseSharedCostItems(req.body.items);

      if (parsed === null) {
        return res.status(400).json({ message: "Shared cost items are not valid." });
      }

      if (parsed.items.length === 0) {
        return res.status(400).json({ message: "At least one shared cost is required." });
      }

      client = await pool.connect();

      const periodStart = `${periodRaw}-01`;

      await client.query(
        "DELETE FROM machine_report_shared_cost_items WHERE location = $1 AND report_period = $2",
        [location, periodStart],
      );

      const rows = [];
      for (const item of parsed.items) {
        const insertResult = await client.query(
          `INSERT INTO machine_report_shared_cost_items
             (location, report_period, description, quantity, unit, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING
             id,
             location,
             to_char(report_period, 'YYYY-MM') AS period,
             description,
             quantity,
             unit,
             unit_price,
             line_total`,
          [location, periodStart, item.description, item.quantity, item.unit, item.unitPrice, item.lineTotal],
        );
        rows.push(insertResult.rows[0]);
      }

      return res.status(201).json({
        message: "Shared costs saved successfully.",
        sharedCosts: rows.map(toPublicSharedCost),
      });
    } catch (error) {
      return next(error);
    } finally {
      if (client) {
        client.release();
      }
    }
  });

  router.delete("/shared-costs/:id", async (req, res, next) => {
    try {
      const sharedCostId = Number(req.params.id);

      if (!Number.isInteger(sharedCostId) || sharedCostId <= 0) {
        return res.status(400).json({ message: "Shared cost id is not valid." });
      }

      const result = await pool.query(
        "DELETE FROM machine_report_shared_cost_items WHERE id = $1 RETURNING id",
        [sharedCostId],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Shared cost item not found." });
      }

      return res.json({ message: "Shared cost item deleted successfully." });
    } catch (error) {
      return next(error);
    }
  });

  function toNullableInt(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }

  function toNullableNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  function toPublicUpload(row) {
    return {
      id: row.id,
      machineId: row.machine_id,
      period: row.period,
      fileName: row.file_name,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
    };
  }

  router.get("/uploads", async (req, res, next) => {
    try {
      const periodRaw = normalizeText(req.query.period);

      if (periodRaw && !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodRaw)) {
        return res.status(400).json({ message: "Period must be in YYYY-MM format." });
      }

      const result = periodRaw
        ? await pool.query(
            `SELECT id, user_id, machine_id, period, file_name, started_at, ended_at, created_at
             FROM machine_report_uploads
             WHERE user_id = $1 AND period = $2
             ORDER BY created_at DESC, id DESC`,
            [req.auth.sub, periodRaw],
          )
        : await pool.query(
            `SELECT id, user_id, machine_id, period, file_name, started_at, ended_at, created_at
             FROM machine_report_uploads
             WHERE user_id = $1
             ORDER BY created_at DESC, id DESC`,
            [req.auth.sub],
          );

      return res.json({ uploads: result.rows.map(toPublicUpload) });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/uploads", async (req, res, next) => {
    let client;

    try {
      const machineId = Number(req.body.machineId);

      if (!Number.isInteger(machineId) || machineId <= 0) {
        return res.status(400).json({ message: "Machine id is not valid." });
      }

      const periodRaw = normalizeText(req.body.period);

      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodRaw)) {
        return res.status(400).json({ message: "Period must be in YYYY-MM format." });
      }

      const fileName = normalizeText(req.body.fileName);

      if (!fileName) {
        return res.status(400).json({ message: "File name is required." });
      }

      if (fileName.length > 255) {
        return res.status(400).json({ message: "File name maximum 255 characters." });
      }

      const startedAt = normalizeText(req.body.startedAt) || null;
      const endedAt = normalizeText(req.body.endedAt) || null;
      const runs = Array.isArray(req.body.runs) ? req.body.runs : [];

      client = await pool.connect();

      const machineResult = await client.query(
        "SELECT id FROM machines WHERE id = $1 LIMIT 1",
        [machineId],
      );

      if (!machineResult.rows[0]) {
        return res.status(400).json({ message: "Machine not found." });
      }

      await client.query("BEGIN");

      const insertResult = await client.query(
        `INSERT INTO machine_report_uploads
           (user_id, machine_id, period, file_name, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, user_id, machine_id, period, file_name, started_at, ended_at, created_at`,
        [req.auth.sub, machineId, periodRaw, fileName, startedAt, endedAt],
      );

      const upload = insertResult.rows[0];
      const runCount = { value: 0 };

      if (runs.length > 0) {
        for (const run of runs) {
          if (!run || typeof run !== "object") continue;

          const runStartedAt = normalizeText(run.startedAt) || null;
          if (!runStartedAt || String(runStartedAt).slice(0, 7) !== periodRaw) continue;

          const insertedRun = await client.query(
            `INSERT INTO machine_report_runs
               (upload_id, started_at, program_comment,
                run_time_seconds, total_time_seconds, workpiece_material,
                workpiece_thickness, wire_weight_grams, wire_breaks, cut_length)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              upload.id,
              runStartedAt,
              normalizeText(run.programComment) || null,
              toNullableInt(run.runTimeSeconds),
              toNullableInt(run.totalTimeSeconds),
              normalizeText(run.workpieceMaterial) || null,
              toNullableNumber(run.workpieceThickness),
              toNullableNumber(run.wireWeightGrams),
              toNullableInt(run.wireBreaks),
              toNullableNumber(run.cutLength),
            ],
          );
          runCount.value += insertedRun.rowCount;
        }
      }

      await client.query("COMMIT");

      return res.status(201).json({
        message: "Upload registered successfully.",
        upload: toPublicUpload(upload),
        runCount: runCount.value,
      });
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch {
        }
      }

      return next(error);
    } finally {
      if (client) {
        client.release();
      }
    }
  });

  router.delete("/uploads/:id", async (req, res, next) => {
    try {
      const uploadId = Number(req.params.id);

      if (!Number.isInteger(uploadId) || uploadId <= 0) {
        return res.status(400).json({ message: "Upload id is not valid." });
      }

      const result = await pool.query(
        "DELETE FROM machine_report_uploads WHERE id = $1 AND user_id = $2 RETURNING id",
        [uploadId, req.auth.sub],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Upload not found." });
      }

      return res.json({ message: "Upload deleted successfully." });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/runs", async (req, res, next) => {
    try {
      const periodRaw = normalizeText(req.query.period);
      const location = normalizeText(req.query.location);
      const machineId = req.query.machineId ? Number(req.query.machineId) : NaN;

      if (periodRaw && !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodRaw)) {
        return res.status(400).json({ message: "Period must be in YYYY-MM format." });
      }

      const conditions = [];
      const params = [];

      if (periodRaw) {
        params.push(periodRaw);
        conditions.push(`uploads.period = $${params.length}`);
      }
      if (location) {
        params.push(location);
        conditions.push(`machines.location = $${params.length}`);
      }
      if (Number.isInteger(machineId) && machineId > 0) {
        params.push(machineId);
        conditions.push(`machines.id = $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const result = await pool.query(
        `SELECT runs.id,
                runs.started_at,
                runs.program_comment,
                runs.run_time_seconds,
                runs.total_time_seconds,
                runs.workpiece_material,
                runs.workpiece_thickness,
                runs.wire_weight_grams,
                runs.wire_breaks,
                runs.cut_length,
                uploads.period,
                machines.id   AS machine_id,
                machines.name AS machine_name,
                machines.type AS machine_type,
                machines.location AS machine_location
         FROM machine_report_runs AS runs
         JOIN machine_report_uploads AS uploads ON uploads.id = runs.upload_id
         JOIN machines ON machines.id = uploads.machine_id
         ${whereClause}
         ORDER BY machines.name ASC, runs.started_at ASC, runs.id ASC`,
        params,
      );

      return res.json({
        runs: result.rows.map((row) => ({
          id: row.id,
          machineId: row.machine_id,
          machineName: row.machine_name,
          machineType: row.machine_type,
          machineLocation: row.machine_location,
          period: row.period,
          day: String(row.started_at ?? "").slice(8, 10) || null,
          startedAt: row.started_at,
          program: row.program_comment,
          runTimeSeconds: toNullableInt(row.run_time_seconds),
          totalTimeSeconds: toNullableInt(row.total_time_seconds),
          workpieceMaterial: row.workpiece_material,
          workpieceThickness: toNullableNumber(row.workpiece_thickness),
          wireWeightGrams: toNullableNumber(row.wire_weight_grams),
          wireBreaks: toNullableInt(row.wire_breaks),
          cutLength: toNullableNumber(row.cut_length),
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

