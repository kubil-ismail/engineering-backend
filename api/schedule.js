import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";

const partPhotoDirectory = fileURLToPath(new URL("./uploads/schedule-parts", import.meta.url));
await mkdir(partPhotoDirectory, { recursive: true });

const partPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: partPhotoDirectory,
    filename: (req, file, callback) => {
      callback(null, `${Date.now()}-${randomUUID()}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    callback(null, file.mimetype.startsWith("image/"));
  },
}).single("photo");

const designTypes = new Set(["construction_design", "detail_2d", "data_3d"]);
const designTypeSequence = ["construction_design", "detail_2d", "data_3d"];
const scheduleStatuses = new Set(["not_started", "on_progress", "completed"]);

function validateProgress(item, prefix, errors) {
  const progress = Number(item.progressPercent);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    errors.push(`${prefix}: progress must be a whole number from 0 to 100.`);
  }
  if (!scheduleStatuses.has(item.status)) {
    errors.push(`${prefix}: status is not valid.`);
  }
}

function isValidDate(value, required = true) {
  if (!value) return !required;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateDateRange(item, prefix, errors) {
  const hasPlannedStart = Boolean(item.plannedStartDate);
  const hasPlannedEnd = Boolean(item.plannedEndDate);

  if (hasPlannedStart !== hasPlannedEnd) {
    errors.push(`${prefix}: planned start and end dates must be filled together.`);
  } else if (
    hasPlannedStart
    && (!isValidDate(item.plannedStartDate) || !isValidDate(item.plannedEndDate))
  ) {
    errors.push(`${prefix}: planned dates are not valid.`);
  } else if (hasPlannedStart && item.plannedEndDate < item.plannedStartDate) {
    errors.push(`${prefix}: planned end date cannot be before planned start date.`);
  }

  const hasActualStart = Boolean(item.actualStartDate);
  const hasActualEnd = Boolean(item.actualEndDate);

  if (hasActualStart !== hasActualEnd) {
    errors.push(`${prefix}: actual start and end dates must be filled together.`);
  } else if (
    hasActualStart
    && (!isValidDate(item.actualStartDate) || !isValidDate(item.actualEndDate))
  ) {
    errors.push(`${prefix}: actual dates are not valid.`);
  } else if (hasActualStart && item.actualEndDate < item.actualStartDate) {
    errors.push(`${prefix}: actual end date cannot be before actual start date.`);
  }
}

function validatePartPayload(body, photo, photoRequired = true) {
  const errors = [];
  const partName = String(body.partName || "").trim();
  const partId = String(body.partId || "").trim();
  const material = String(body.material || "").trim();
  const thickness = Number(body.thickness);
  let processes = [];

  try {
    processes = JSON.parse(body.processes || "[]");
  } catch {
    errors.push("Process data is not valid JSON.");
  }

  if (!partName || partName.length > 150) errors.push("Part name is required and maximum 150 characters.");
  if (!partId || partId.length > 100) errors.push("Part ID is required and maximum 100 characters.");
  if (!material || material.length > 150) errors.push("Material is required and maximum 150 characters.");
  if (!Number.isFinite(thickness) || thickness <= 0) errors.push("Thickness must be greater than zero.");
  if (photoRequired && !photo) errors.push("Part photo is required and must be an image under 5 MB.");
  if (!Array.isArray(processes) || processes.length !== 1) errors.push("Exactly one Main Process is required for each part.");

  if (Array.isArray(processes)) {
    processes.forEach((process, processIndex) => {
      const processLabel = `Process ${processIndex + 1}`;
      if (!String(process.processName || "").trim()) errors.push(`${processLabel}: name is required.`);
      if (!designTypes.has(process.designType)) errors.push(`${processLabel}: design type is not valid.`);
      if (!/^\d+$/.test(String(process.designPicUserId || ""))) errors.push(`${processLabel}: Plan PIC is required.`);
      if (process.actualPicUserId && !/^\d+$/.test(String(process.actualPicUserId))) {
        errors.push(`${processLabel}: Actual PIC is not valid.`);
      }
      if ((process.actualStartDate || process.actualEndDate) && !process.actualPicUserId) {
        errors.push(`${processLabel}: Actual PIC is required when actual dates are filled.`);
      }
      validateDateRange(process, processLabel, errors);
      validateProgress(process, processLabel, errors);

      if (!Array.isArray(process.subProcesses) || process.subProcesses.length === 0) {
        errors.push(`${processLabel}: at least one sub process is required.`);
        return;
      }

      process.subProcesses.forEach((subProcess, subProcessIndex) => {
        const subProcessLabel = `${processLabel}, Sub Process ${subProcessIndex + 1}`;
        if (!String(subProcess.subProcessName || "").trim()) errors.push(`${subProcessLabel}: name is required.`);
        validateProgress(subProcess, subProcessLabel, errors);
        if (!Array.isArray(subProcess.stages) || subProcess.stages.length === 0) {
          errors.push(`${subProcessLabel}: at least one design type is required.`);
          return;
        }

        const selectedTypes = new Set();
        subProcess.stages.forEach((stage, stageIndex) => {
          const stageLabel = `${subProcessLabel}, Stage ${stageIndex + 1}`;
          if (!designTypes.has(stage.designType)) errors.push(`${stageLabel}: design type is not valid.`);
          if (selectedTypes.has(stage.designType)) errors.push(`${stageLabel}: design type cannot be duplicated.`);
          selectedTypes.add(stage.designType);
          if (!/^\d+$/.test(String(stage.picUserId || ""))) errors.push(`${stageLabel}: Plan PIC is required.`);
          if (stage.actualPicUserId && !/^\d+$/.test(String(stage.actualPicUserId))) {
            errors.push(`${stageLabel}: Actual PIC is not valid.`);
          }
          if ((stage.actualStartDate || stage.actualEndDate) && !stage.actualPicUserId) {
            errors.push(`${stageLabel}: Actual PIC is required when actual dates are filled.`);
          }
          validateDateRange(stage, stageLabel, errors);
        });

        const orderedStages = [...subProcess.stages].sort(
          (left, right) => designTypeSequence.indexOf(left.designType) - designTypeSequence.indexOf(right.designType),
        );
        orderedStages.forEach((stage, stageIndex) => {
          if (stageIndex === 0) return;
          const previousStage = orderedStages[stageIndex - 1];
          if (stage.plannedStartDate && previousStage.plannedEndDate && stage.plannedStartDate < previousStage.plannedEndDate) {
            errors.push(`${subProcessLabel}: ${stage.designType} plan cannot start before the previous design stage ends.`);
          }
          if (
            stage.actualStartDate
            && previousStage.actualEndDate
            && stage.actualStartDate < previousStage.actualEndDate
          ) {
            errors.push(`${subProcessLabel}: ${stage.designType} actual cannot start before the previous design stage ends.`);
          }
        });
      });
    });
  }

  return {
    errors,
    values: { partName, partId, material, thickness, processes },
  };
}

async function insertDesignProcesses(client, partId, processes) {
  const idMappings = {
    process: new Map(),
    subProcess: new Map(),
    stage: new Map(),
  };

  for (const process of processes) {
    const processResult = await client.query(
      `INSERT INTO schedule_design_processes
         (part_id, process_name, design_type, design_pic_user_id, actual_pic_user_id, planned_start_date, planned_end_date, actual_start_date, actual_end_date, progress_percent, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        partId,
        String(process.processName).trim(),
        process.designType,
        process.designPicUserId,
        process.actualPicUserId || null,
        process.plannedStartDate || null,
        process.plannedEndDate || null,
        process.actualStartDate || null,
        process.actualEndDate || null,
        Number(process.progressPercent),
        process.status,
      ],
    );
    if (process.id) idMappings.process.set(String(process.id), processResult.rows[0].id);

    for (const subProcess of process.subProcesses) {
      const orderedStages = [...subProcess.stages].sort(
        (left, right) => designTypeSequence.indexOf(left.designType) - designTypeSequence.indexOf(right.designType),
      );
      const firstStage = orderedStages[0];
      const subProcessResult = await client.query(
        `INSERT INTO schedule_design_sub_processes
           (process_id, sub_process_name, design_type, pic_user_id, actual_pic_user_id, planned_start_date, planned_end_date, actual_start_date, actual_end_date, progress_percent, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          processResult.rows[0].id,
          String(subProcess.subProcessName).trim(),
          firstStage.designType,
          firstStage.picUserId,
          firstStage.actualPicUserId || null,
          firstStage.plannedStartDate || null,
          firstStage.plannedEndDate || null,
          firstStage.actualStartDate || null,
          firstStage.actualEndDate || null,
          Number(subProcess.progressPercent),
          subProcess.status,
        ],
      );
      if (subProcess.id) idMappings.subProcess.set(String(subProcess.id), subProcessResult.rows[0].id);

      for (const [stageIndex, stage] of orderedStages.entries()) {
        const stageResult = await client.query(
          `INSERT INTO schedule_design_sub_process_stages
             (sub_process_id, design_type, sequence_order, pic_user_id, actual_pic_user_id, planned_start_date, planned_end_date, actual_start_date, actual_end_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            subProcessResult.rows[0].id,
            stage.designType,
            stageIndex + 1,
            stage.picUserId,
            stage.actualPicUserId || null,
            stage.plannedStartDate || null,
            stage.plannedEndDate || null,
            stage.actualStartDate || null,
            stage.actualEndDate || null,
          ],
        );
        if (stage.id) idMappings.stage.set(String(stage.id), stageResult.rows[0].id);
      }
    }
  }

  return idMappings;
}

async function restoreTimelineRemarks(client, remarks, idMappings) {
  for (const remark of remarks) {
    let targetColumn;
    let targetId;

    if (remark.process_id) {
      targetColumn = "process_id";
      targetId = idMappings.process.get(String(remark.process_id));
    } else if (remark.stage_id) {
      targetColumn = "stage_id";
      targetId = idMappings.stage.get(String(remark.stage_id));
    } else {
      targetColumn = "sub_process_id";
      targetId = idMappings.subProcess.get(String(remark.sub_process_id));
    }

    if (!targetId) continue;
    await client.query(
      `INSERT INTO schedule_design_timeline_remarks
         (${targetColumn}, schedule_date, remark_mode, remark, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        targetId,
        remark.schedule_date,
        remark.remark_mode,
        remark.remark,
        remark.created_by,
        remark.created_at,
        remark.updated_at,
      ],
    );
  }
}

async function restoreTimelineRanges(client, ranges, idMappings) {
  for (const range of ranges) {
    const targetColumn = range.process_id ? "process_id" : "stage_id";
    const targetId = range.process_id
      ? idMappings.process.get(String(range.process_id))
      : idMappings.stage.get(String(range.stage_id));

    if (!targetId) continue;
    await client.query(
      `INSERT INTO schedule_design_timeline_ranges
         (${targetColumn}, range_mode, start_date, end_date, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        targetId,
        range.range_mode,
        range.start_date,
        range.end_date,
        range.created_by,
        range.created_at,
        range.updated_at,
      ],
    );
  }
}

function toPublicProject(project) {
  return {
    id: project.id,
    projectName: project.project_name,
    customer: project.customer,
    projectDate: project.project_date,
    createdBy: project.created_by,
    createdByUsername: project.created_by_username,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

function validateProject({ projectName, customer, projectDate }) {
  const errors = {};
  const normalizedName = String(projectName || "").trim();
  const normalizedCustomer = String(customer || "").trim();
  const normalizedDate = String(projectDate || "").trim();
  const parsedDate = new Date(`${normalizedDate}T00:00:00Z`);

  if (!normalizedName) {
    errors.projectName = "Project name is required.";
  } else if (normalizedName.length > 150) {
    errors.projectName = "Project name maximum 150 characters.";
  }

  if (!normalizedCustomer) {
    errors.customer = "Customer is required.";
  } else if (normalizedCustomer.length > 150) {
    errors.customer = "Customer maximum 150 characters.";
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)
    || Number.isNaN(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== normalizedDate
  ) {
    errors.projectDate = "Project date is not valid.";
  }

  return {
    errors,
    values: {
      projectName: normalizedName,
      customer: normalizedCustomer,
      projectDate: normalizedDate,
    },
  };
}

function validateMachineItem({ itemName, machineId, quantity, programPicUserId, operatorPicUserId, plannedStartDate, plannedEndDate }) {
  const errors = {};
  const normalizedName = String(itemName || "").trim();
  const normalizedMachineId = String(machineId || "");
  const normalizedQuantity = Number(quantity);

  if (!normalizedName) {
    errors.itemName = "Item name is required.";
  } else if (normalizedName.length > 150) {
    errors.itemName = "Item name maximum 150 characters.";
  }
  if (!/^\d+$/.test(normalizedMachineId)) {
    errors.machineId = "Machine is required.";
  }
  if (!Number.isSafeInteger(normalizedQuantity) || normalizedQuantity < 1) {
    errors.quantity = "Quantity must be a whole number greater than zero.";
  }
  if (!/^\d+$/.test(String(programPicUserId || ""))) {
    errors.programPicUserId = "Program PIC is required.";
  }
  if (!/^\d+$/.test(String(operatorPicUserId || ""))) {
    errors.operatorPicUserId = "Operator PIC is required.";
  }
  if (!isValidDate(plannedStartDate)) {
    errors.plannedStartDate = "Plan start date is required.";
  }
  if (!isValidDate(plannedEndDate)) {
    errors.plannedEndDate = "Plan end date is required.";
  } else if (isValidDate(plannedStartDate) && plannedEndDate < plannedStartDate) {
    errors.plannedEndDate = "Plan end date cannot be before the start date.";
  }

  return {
    errors,
    values: {
      itemName: normalizedName,
      machineId: normalizedMachineId,
      quantity: normalizedQuantity,
      programPicUserId: String(programPicUserId || ""),
      operatorPicUserId: String(operatorPicUserId || ""),
      plannedStartDate: String(plannedStartDate || ""),
      plannedEndDate: String(plannedEndDate || ""),
    },
  };
}

function toPublicMachineItem(item) {
  return {
    id: item.id,
    machineId: item.machine_id,
    machineName: item.machine_name,
    itemName: item.item_name,
    quantity: item.quantity,
    programPicUserId: item.program_pic_user_id,
    programPicUsername: item.program_pic_username,
    operatorPicUserId: item.operator_pic_user_id,
    operatorPicUsername: item.operator_pic_username,
    plannedStartDate: item.planned_start_date,
    plannedEndDate: item.planned_end_date,
    actualStartDate: item.actual_start_date,
    actualEndDate: item.actual_end_date,
    remarks: item.remarks || [],
    createdBy: item.created_by,
    createdByUsername: item.created_by_username,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export default function createScheduleRouter({ pool }) {
  const router = Router();

  router.get("/", (req, res) => {
    res.json({
      service: "schedule",
      message: "Schedule service is ready.",
      userId: req.auth.sub,
    });
  });

  router.get("/health", async (req, res, next) => {
    try {
      await pool.query("SELECT 1");
      return res.json({
        service: "schedule",
        status: "healthy",
        database: "connected",
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/overview", async (req, res, next) => {
    try {
      const [
        summaryResult,
        projectProgressResult,
        machineHoursResult,
      ] = await Promise.all([
        pool.query(
          `WITH project_progress AS (
             SELECT projects.id,
                    COALESCE(ROUND(AVG(sub_processes.progress_percent)::numeric, 0), 0) AS progress_percent
             FROM schedule_projects AS projects
             LEFT JOIN schedule_designs AS designs ON designs.project_id = projects.id
             LEFT JOIN schedule_design_parts AS parts ON parts.design_id = designs.id
             LEFT JOIN schedule_design_processes AS processes ON processes.part_id = parts.id
             LEFT JOIN schedule_design_sub_processes AS sub_processes ON sub_processes.process_id = processes.id
             GROUP BY projects.id
           )
           SELECT COUNT(DISTINCT projects.id)::int AS total_projects,
                  COUNT(DISTINCT parts.id)::int AS total_design_parts,
                  COUNT(DISTINCT machine_items.id)::int AS total_machine_items,
                  COALESCE(ROUND(AVG(project_progress.progress_percent)::numeric, 0), 0)::int AS project_progress
           FROM schedule_projects AS projects
           LEFT JOIN project_progress ON project_progress.id = projects.id
           LEFT JOIN schedule_designs AS designs ON designs.project_id = projects.id
           LEFT JOIN schedule_design_parts AS parts ON parts.design_id = designs.id
           LEFT JOIN schedule_machine_items AS machine_items ON machine_items.project_id = projects.id`,
        ),
        pool.query(
          `WITH project_progress AS (
             SELECT projects.id,
                    projects.project_name,
                    projects.customer,
                    projects.project_date,
                    projects.created_at,
                    COUNT(DISTINCT parts.id)::int AS design_part_count,
                    COUNT(DISTINCT machine_items.id)::int AS machine_item_count,
                    COALESCE(ROUND(AVG(sub_processes.progress_percent)::numeric, 0), 0)::int AS progress_percent
             FROM schedule_projects AS projects
             LEFT JOIN schedule_designs AS designs ON designs.project_id = projects.id
             LEFT JOIN schedule_design_parts AS parts ON parts.design_id = designs.id
             LEFT JOIN schedule_design_processes AS processes ON processes.part_id = parts.id
             LEFT JOIN schedule_design_sub_processes AS sub_processes ON sub_processes.process_id = processes.id
             LEFT JOIN schedule_machine_items AS machine_items ON machine_items.project_id = projects.id
             GROUP BY projects.id, projects.project_name, projects.customer, projects.project_date, projects.created_at
           )
           SELECT id,
                  project_name,
                  customer,
                  project_date,
                  design_part_count,
                  machine_item_count,
                  progress_percent
           FROM project_progress
           ORDER BY project_date DESC, created_at DESC
           LIMIT 5`,
        ),
        pool.query(
          `SELECT machines.id,
                  machines.name,
                  COALESCE(SUM(remarks.time_process) FILTER (WHERE remarks.remark_mode = 'plan'), 0)::float AS plan_hours,
                  COALESCE(SUM(remarks.time_process) FILTER (WHERE remarks.remark_mode = 'actual'), 0)::float AS actual_hours
           FROM machines
           LEFT JOIN schedule_machine_items AS items ON items.machine_id = machines.id
           LEFT JOIN schedule_machine_timeline_remarks AS remarks
             ON remarks.item_id = items.id
            AND remarks.schedule_date = CURRENT_DATE
            AND remarks.time_process IS NOT NULL
           GROUP BY machines.id, machines.name
           HAVING COALESCE(SUM(remarks.time_process), 0) > 0
           ORDER BY machines.name ASC
           LIMIT 12`,
        ),
      ]);

      const summary = summaryResult.rows[0] || {};
      const machineHours = machineHoursResult.rows.map((machine) => ({
        id: machine.id,
        name: machine.name,
        planHours: Number(machine.plan_hours || 0),
        actualHours: Number(machine.actual_hours || 0),
      }));

      return res.json({
        summary: {
          totalProjects: Number(summary.total_projects || 0),
          projectProgress: Number(summary.project_progress || 0),
          totalDesignParts: Number(summary.total_design_parts || 0),
          totalMachineItems: Number(summary.total_machine_items || 0),
          todayMachineHours: machineHours.reduce((total, machine) => total + machine.planHours + machine.actualHours, 0),
        },
        recentProjects: projectProgressResult.rows.map((project) => ({
          id: project.id,
          projectName: project.project_name,
          customer: project.customer,
          projectDate: project.project_date,
          progressPercent: Number(project.progress_percent || 0),
          designPartCount: Number(project.design_part_count || 0),
          machineItemCount: Number(project.machine_item_count || 0),
        })),
        machineHoursToday: machineHours,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/projects", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT projects.id,
                projects.project_name,
                projects.customer,
                projects.project_date,
                projects.created_by,
                projects.created_at,
                projects.updated_at,
                users.username AS created_by_username
         FROM schedule_projects AS projects
         JOIN users ON users.id = projects.created_by
         ORDER BY projects.project_date DESC, projects.created_at DESC
         LIMIT 100`,
      );

      return res.json({ projects: result.rows.map(toPublicProject) });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/projects", async (req, res, next) => {
    try {
      const { errors, values } = validateProject(req.body);

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ message: "Project data is not valid.", errors });
      }

      const result = await pool.query(
        `WITH inserted AS (
           INSERT INTO schedule_projects (project_name, customer, project_date, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, project_name, customer, project_date, created_by, created_at, updated_at
         )
         SELECT inserted.*, users.username AS created_by_username
         FROM inserted
         JOIN users ON users.id = inserted.created_by`,
        [values.projectName, values.customer, values.projectDate, req.auth.sub],
      );

      return res.status(201).json({
        message: "Project created successfully.",
        project: toPublicProject(result.rows[0]),
      });
    } catch (error) {
      if (error.code === "23503") {
        return res.status(401).json({ message: "User is no longer available." });
      }

      return next(error);
    }
  });

  router.patch("/projects/:projectId", async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.projectId)) {
        return res.status(400).json({ message: "Project ID is not valid." });
      }

      const { errors, values } = validateProject(req.body);
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ message: "Project data is not valid.", errors });
      }

      const result = await pool.query(
        `WITH updated AS (
           UPDATE schedule_projects
           SET project_name = $1,
               customer = $2,
               project_date = $3,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4
           RETURNING id, project_name, customer, project_date, created_by, created_at, updated_at
         )
         SELECT updated.*, users.username AS created_by_username
         FROM updated
         JOIN users ON users.id = updated.created_by`,
        [values.projectName, values.customer, values.projectDate, req.params.projectId],
      );

      if (!result.rows[0]) {
        return res.status(404).json({ message: "Project was not found." });
      }

      return res.json({
        message: "Project updated successfully.",
        project: toPublicProject(result.rows[0]),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.delete("/projects/:projectId", async (req, res, next) => {
    const client = await pool.connect();

    try {
      if (!/^\d+$/.test(req.params.projectId)) {
        return res.status(400).json({ message: "Project ID is not valid." });
      }

      await client.query("BEGIN");
      const photosResult = await client.query(
        `SELECT parts.photo_filename
         FROM schedule_design_parts AS parts
         JOIN schedule_designs AS designs ON designs.id = parts.design_id
         WHERE designs.project_id = $1 AND parts.photo_filename IS NOT NULL`,
        [req.params.projectId],
      );
      const deleteResult = await client.query(
        "DELETE FROM schedule_projects WHERE id = $1 RETURNING id",
        [req.params.projectId],
      );

      if (!deleteResult.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Project was not found." });
      }

      await client.query("COMMIT");
      await Promise.all(
        photosResult.rows.map((photo) => unlink(resolve(partPhotoDirectory, photo.photo_filename)).catch(() => {})),
      );
      return res.json({ message: "Project deleted successfully." });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get("/machine-tasks", async (req, res, next) => {
    try {
      const [machinesResult, itemsResult, remarksResult] = await Promise.all([
        pool.query(
          `SELECT id, name
           FROM machines
           ORDER BY name ASC`,
        ),
        pool.query(
          `SELECT items.*,
                  projects.project_name,
                  projects.customer,
                  machines.name AS machine_name,
                  program_users.username AS program_pic_username,
                  operator_users.username AS operator_pic_username
           FROM schedule_machine_items AS items
           JOIN schedule_projects AS projects ON projects.id = items.project_id
           JOIN machines ON machines.id = items.machine_id
           LEFT JOIN users AS program_users ON program_users.id = items.program_pic_user_id
           LEFT JOIN users AS operator_users ON operator_users.id = items.operator_pic_user_id
           ORDER BY machines.name ASC, projects.project_date DESC, items.created_at ASC`,
        ),
        pool.query(
          `SELECT remarks.id,
                  remarks.item_id,
                  remarks.schedule_date,
                  remarks.remark_mode,
                  remarks.remark,
                  remarks.time_process
           FROM schedule_machine_timeline_remarks AS remarks
           JOIN schedule_machine_items AS items ON items.id = remarks.item_id
           WHERE items.machine_id IS NOT NULL
           ORDER BY remarks.schedule_date ASC`,
        ),
      ]);

      const remarksByItem = new Map();
      remarksResult.rows.forEach((remark) => {
        const itemId = String(remark.item_id);
        const current = remarksByItem.get(itemId) || [];
        current.push({
          id: remark.id,
          scheduleDate: remark.schedule_date,
          mode: remark.remark_mode,
          remark: remark.remark,
          timeProcess: remark.time_process === null || remark.time_process === undefined ? null : Number(remark.time_process),
        });
        remarksByItem.set(itemId, current);
      });

      const machines = machinesResult.rows.map((machine) => ({
        id: machine.id,
        name: machine.name,
        items: [],
      }));
      const machinesById = new Map(machines.map((machine) => [String(machine.id), machine]));

      itemsResult.rows.forEach((item) => {
        const machine = machinesById.get(String(item.machine_id));
        if (!machine) return;
        machine.items.push({
          ...toPublicMachineItem(item),
          projectId: item.project_id,
          projectName: item.project_name,
          customer: item.customer,
          remarks: remarksByItem.get(String(item.id)) || [],
        });
      });

      return res.json({ machines });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/projects/:projectId/machine/items", async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.projectId)) {
        return res.status(400).json({ message: "Project ID is not valid." });
      }

      const [projectResult, itemsResult, remarksResult] = await Promise.all([
        pool.query(
          `SELECT projects.*, users.username AS created_by_username
           FROM schedule_projects AS projects
           JOIN users ON users.id = projects.created_by
           WHERE projects.id = $1`,
          [req.params.projectId],
        ),
        pool.query(
          `SELECT items.*,
                  users.username AS created_by_username,
                  machines.name AS machine_name,
                  program_users.username AS program_pic_username,
                  operator_users.username AS operator_pic_username
           FROM schedule_machine_items AS items
           JOIN users ON users.id = items.created_by
           LEFT JOIN machines ON machines.id = items.machine_id
           LEFT JOIN users AS program_users ON program_users.id = items.program_pic_user_id
           LEFT JOIN users AS operator_users ON operator_users.id = items.operator_pic_user_id
           WHERE items.project_id = $1
           ORDER BY items.created_at ASC`,
          [req.params.projectId],
        ),
        pool.query(
          `SELECT remarks.id,
                  remarks.item_id,
                  remarks.schedule_date,
                  remarks.remark_mode,
                  remarks.remark,
                  remarks.time_process,
                  users.username AS created_by_username
           FROM schedule_machine_timeline_remarks AS remarks
           JOIN schedule_machine_items AS items ON items.id = remarks.item_id
           JOIN users ON users.id = remarks.created_by
           WHERE items.project_id = $1
           ORDER BY remarks.schedule_date ASC`,
          [req.params.projectId],
        ),
      ]);

      if (!projectResult.rows[0]) {
        return res.status(404).json({ message: "Project was not found." });
      }

      const remarksByItem = new Map();
      remarksResult.rows.forEach((remark) => {
        const itemId = String(remark.item_id);
        const current = remarksByItem.get(itemId) || [];
        current.push({
          id: remark.id,
          scheduleDate: remark.schedule_date,
          mode: remark.remark_mode,
          remark: remark.remark,
          timeProcess: remark.time_process === null || remark.time_process === undefined ? null : Number(remark.time_process),
          createdByUsername: remark.created_by_username,
        });
        remarksByItem.set(itemId, current);
      });

      return res.json({
        project: toPublicProject(projectResult.rows[0]),
        items: itemsResult.rows.map((item) => ({
          ...toPublicMachineItem(item),
          remarks: remarksByItem.get(String(item.id)) || [],
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/projects/:projectId/machine/items", async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.projectId)) {
        return res.status(400).json({ message: "Project ID is not valid." });
      }
      const { errors, values } = validateMachineItem(req.body);
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ message: "Machine item data is not valid.", errors });
      }

      const result = await pool.query(
        `WITH inserted AS (
           INSERT INTO schedule_machine_items
             (project_id, machine_id, item_name, quantity, program_pic_user_id, operator_pic_user_id, planned_start_date, planned_end_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *
         )
         SELECT inserted.*,
                users.username AS created_by_username,
                machines.name AS machine_name,
                program_users.username AS program_pic_username,
                operator_users.username AS operator_pic_username
         FROM inserted
         JOIN users ON users.id = inserted.created_by
         JOIN machines ON machines.id = inserted.machine_id
         JOIN users AS program_users ON program_users.id = inserted.program_pic_user_id
         JOIN users AS operator_users ON operator_users.id = inserted.operator_pic_user_id`,
        [
          req.params.projectId,
          values.machineId,
          values.itemName,
          values.quantity,
          values.programPicUserId,
          values.operatorPicUserId,
          values.plannedStartDate,
          values.plannedEndDate,
          req.auth.sub,
        ],
      );

      return res.status(201).json({
        message: "Machine item created successfully.",
        item: toPublicMachineItem(result.rows[0]),
      });
    } catch (error) {
      if (error.code === "23503") {
        return res.status(404).json({ message: "Project or user was not found." });
      }
      return next(error);
    }
  });

  router.patch("/projects/:projectId/machine/items/:itemId", async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.projectId) || !/^\d+$/.test(req.params.itemId)) {
        return res.status(400).json({ message: "Project or item ID is not valid." });
      }
      const { errors, values } = validateMachineItem(req.body);
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ message: "Machine item data is not valid.", errors });
      }

      const result = await pool.query(
        `WITH updated AS (
           UPDATE schedule_machine_items
           SET machine_id = $1,
               item_name = $2,
               quantity = $3,
               program_pic_user_id = $4,
               operator_pic_user_id = $5,
               planned_start_date = $6,
               planned_end_date = $7,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $8 AND project_id = $9
           RETURNING *
         )
         SELECT updated.*,
                users.username AS created_by_username,
                machines.name AS machine_name,
                program_users.username AS program_pic_username,
                operator_users.username AS operator_pic_username
         FROM updated
         JOIN users ON users.id = updated.created_by
         JOIN machines ON machines.id = updated.machine_id
         JOIN users AS program_users ON program_users.id = updated.program_pic_user_id
         JOIN users AS operator_users ON operator_users.id = updated.operator_pic_user_id`,
        [
          values.machineId,
          values.itemName,
          values.quantity,
          values.programPicUserId,
          values.operatorPicUserId,
          values.plannedStartDate,
          values.plannedEndDate,
          req.params.itemId,
          req.params.projectId,
        ],
      );

      if (!result.rows[0]) {
        return res.status(404).json({ message: "Machine item was not found." });
      }
      return res.json({
        message: "Machine item updated successfully.",
        item: toPublicMachineItem(result.rows[0]),
      });
    } catch (error) {
      if (error.code === "23503") {
        return res.status(400).json({ message: "One of the selected PIC users is not valid." });
      }
      return next(error);
    }
  });

  router.put("/projects/:projectId/machine/items/:itemId/timeline-range", async (req, res, next) => {
    try {
      const mode = String(req.body.mode || "");
      const startDate = String(req.body.startDate || "");
      const endDate = String(req.body.endDate || "");

      if (!/^\d+$/.test(req.params.projectId) || !/^\d+$/.test(req.params.itemId)) {
        return res.status(400).json({ message: "Project or item ID is not valid." });
      }
      if (!new Set(["plan", "actual"]).has(mode)) {
        return res.status(400).json({ message: "Machine timeline mode is not valid." });
      }
      if (!isValidDate(startDate) || !isValidDate(endDate) || endDate < startDate) {
        return res.status(400).json({ message: "Machine timeline date range is not valid." });
      }

      const startColumn = mode === "plan" ? "planned_start_date" : "actual_start_date";
      const endColumn = mode === "plan" ? "planned_end_date" : "actual_end_date";
      const result = await pool.query(
        `UPDATE schedule_machine_items
         SET ${startColumn} = $1, ${endColumn} = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND project_id = $4
         RETURNING id`,
        [startDate, endDate, req.params.itemId, req.params.projectId],
      );

      if (!result.rows[0]) {
        return res.status(404).json({ message: "Machine item was not found." });
      }
      return res.json({
        message: `${mode === "plan" ? "Plan" : "Actual"} range updated successfully.`,
        range: { mode, startDate, endDate },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.put("/projects/:projectId/machine/items/:itemId/remarks", async (req, res, next) => {
    try {
      const mode = String(req.body.mode || "");
      const scheduleDate = String(req.body.scheduleDate || "");
      const remark = String(req.body.remark || "").trim();
      const rawTimeProcess = req.body.timeProcess;
      const hasTimeProcess = rawTimeProcess !== undefined && rawTimeProcess !== null && String(rawTimeProcess).trim() !== "";
      const timeProcess = hasTimeProcess ? Number(rawTimeProcess) : null;

      if (!/^\d+$/.test(req.params.projectId) || !/^\d+$/.test(req.params.itemId)) {
        return res.status(400).json({ message: "Project or item ID is not valid." });
      }
      if (!new Set(["plan", "actual"]).has(mode)) {
        return res.status(400).json({ message: "Machine remark mode is not valid." });
      }
      if (!isValidDate(scheduleDate)) {
        return res.status(400).json({ message: "Machine remark date is not valid." });
      }
      if (remark.length > 300) {
        return res.status(400).json({ message: "Remark maximum 300 characters." });
      }
      if (hasTimeProcess && (!Number.isFinite(timeProcess) || timeProcess < 0)) {
        return res.status(400).json({ message: "Process time must be zero or greater." });
      }

      const itemResult = await pool.query(
        "SELECT id FROM schedule_machine_items WHERE id = $1 AND project_id = $2",
        [req.params.itemId, req.params.projectId],
      );
      if (!itemResult.rows[0]) {
        return res.status(404).json({ message: "Machine item was not found." });
      }

      if (!remark && timeProcess === null) {
        await pool.query(
          `DELETE FROM schedule_machine_timeline_remarks
           WHERE item_id = $1 AND schedule_date = $2 AND remark_mode = $3`,
          [req.params.itemId, scheduleDate, mode],
        );
        return res.json({ message: "Machine remark deleted successfully.", remark: null });
      }

      const result = await pool.query(
        `INSERT INTO schedule_machine_timeline_remarks
           (item_id, schedule_date, remark_mode, remark, time_process, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (item_id, schedule_date, remark_mode)
         DO UPDATE SET remark = EXCLUDED.remark, time_process = EXCLUDED.time_process, updated_at = CURRENT_TIMESTAMP
         RETURNING id, schedule_date, remark_mode, remark, time_process`,
        [req.params.itemId, scheduleDate, mode, remark, timeProcess, req.auth.sub],
      );
      const saved = result.rows[0];
      return res.json({
        message: "Machine process time saved successfully.",
        remark: {
          id: saved.id,
          scheduleDate: saved.schedule_date,
          mode: saved.remark_mode,
          remark: saved.remark,
          timeProcess: saved.time_process === null || saved.time_process === undefined ? null : Number(saved.time_process),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.delete("/projects/:projectId/machine/items/:itemId", async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.projectId) || !/^\d+$/.test(req.params.itemId)) {
        return res.status(400).json({ message: "Project or item ID is not valid." });
      }
      const result = await pool.query(
        "DELETE FROM schedule_machine_items WHERE id = $1 AND project_id = $2 RETURNING id",
        [req.params.itemId, req.params.projectId],
      );
      if (!result.rows[0]) {
        return res.status(404).json({ message: "Machine item was not found." });
      }
      return res.json({ message: "Machine item deleted successfully." });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/machine-options", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, name
         FROM machines
         ORDER BY name ASC`,
      );

      return res.json({
        machines: result.rows.map((machine) => ({ id: machine.id, name: machine.name })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/pic-users", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, username, email, position, department
         FROM users
         WHERE is_active = TRUE
         ORDER BY username ASC`,
      );

      return res.json({
        users: result.rows.map((user) => ({
          id: user.id,
          username: user.username,
          email: user.email,
          position: user.position,
          department: user.department,
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/part-photos/:filename", (req, res) => {
    const filename = basename(req.params.filename);

    if (filename !== req.params.filename) {
      return res.status(400).json({ message: "Photo filename is not valid." });
    }

    return res.sendFile(resolve(partPhotoDirectory, filename), (error) => {
      if (error && !res.headersSent) {
        res.status(error.statusCode || 404).json({ message: "Part photo was not found." });
      }
    });
  });

  router.get("/projects/:projectId/design", async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.projectId)) {
        return res.status(400).json({ message: "Project ID is not valid." });
      }

      const projectResult = await pool.query(
        `SELECT projects.id,
                projects.project_name,
                projects.customer,
                projects.project_date,
                designs.id AS design_id,
                designs.created_at AS design_created_at,
                designs.updated_at AS design_updated_at
         FROM schedule_projects AS projects
         LEFT JOIN schedule_designs AS designs ON designs.project_id = projects.id
         WHERE projects.id = $1
         LIMIT 1`,
        [req.params.projectId],
      );
      const project = projectResult.rows[0];

      if (!project) {
        return res.status(404).json({ message: "Project was not found." });
      }

      if (!project.design_id) {
        return res.status(409).json({ message: "Design Schedule is not available for this project." });
      }

      const [partsResult, processesResult, subProcessesResult, stagesResult, remarksResult, rangesResult] = await Promise.all([
        pool.query(
          `SELECT parts.id,
                  parts.part_name,
                  parts.part_number,
                  parts.material,
                  parts.thickness_mm,
                  parts.photo_filename,
                  parts.photo_original_name,
                  parts.created_at,
                  users.username AS created_by_username
           FROM schedule_design_parts AS parts
           JOIN users ON users.id = parts.created_by
           WHERE parts.design_id = $1
           ORDER BY parts.created_at DESC`,
          [project.design_id],
        ),
        pool.query(
          `SELECT processes.*,
                  planned_users.username AS design_pic_username,
                  actual_users.username AS actual_pic_username
           FROM schedule_design_processes AS processes
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN users AS planned_users ON planned_users.id = processes.design_pic_user_id
           LEFT JOIN users AS actual_users ON actual_users.id = processes.actual_pic_user_id
           WHERE parts.design_id = $1
           ORDER BY processes.id ASC`,
          [project.design_id],
        ),
        pool.query(
          `SELECT sub_processes.*,
                  planned_users.username AS pic_username,
                  actual_users.username AS actual_pic_username
           FROM schedule_design_sub_processes AS sub_processes
           JOIN schedule_design_processes AS processes ON processes.id = sub_processes.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN users AS planned_users ON planned_users.id = sub_processes.pic_user_id
           LEFT JOIN users AS actual_users ON actual_users.id = sub_processes.actual_pic_user_id
           WHERE parts.design_id = $1
           ORDER BY sub_processes.id ASC`,
          [project.design_id],
        ),
        pool.query(
          `SELECT stages.*,
                  planned_users.username AS pic_username,
                  actual_users.username AS actual_pic_username
           FROM schedule_design_sub_process_stages AS stages
           JOIN schedule_design_sub_processes AS sub_processes ON sub_processes.id = stages.sub_process_id
           JOIN schedule_design_processes AS processes ON processes.id = sub_processes.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN users AS planned_users ON planned_users.id = stages.pic_user_id
           LEFT JOIN users AS actual_users ON actual_users.id = stages.actual_pic_user_id
           WHERE parts.design_id = $1
           ORDER BY stages.sub_process_id ASC, stages.sequence_order ASC`,
          [project.design_id],
        ),
        pool.query(
          `SELECT remarks.id,
                  remarks.process_id,
                  remarks.sub_process_id,
                  remarks.stage_id,
                  remarks.schedule_date,
                  remarks.remark_mode,
                  remarks.remark,
                  users.username AS created_by_username
           FROM schedule_design_timeline_remarks AS remarks
           LEFT JOIN schedule_design_processes AS direct_process ON direct_process.id = remarks.process_id
           LEFT JOIN schedule_design_sub_processes AS sub_process ON sub_process.id = remarks.sub_process_id
           LEFT JOIN schedule_design_sub_process_stages AS stage ON stage.id = remarks.stage_id
           LEFT JOIN schedule_design_sub_processes AS stage_sub_process ON stage_sub_process.id = stage.sub_process_id
           LEFT JOIN schedule_design_processes AS parent_process ON parent_process.id = COALESCE(sub_process.process_id, stage_sub_process.process_id)
           JOIN users ON users.id = remarks.created_by
           JOIN schedule_design_parts AS parts ON parts.id = COALESCE(direct_process.part_id, parent_process.part_id)
           WHERE parts.design_id = $1
           ORDER BY remarks.schedule_date ASC`,
          [project.design_id],
        ),
        pool.query(
          `SELECT ranges.id,
                  ranges.process_id,
                  ranges.stage_id,
                  ranges.range_mode,
                  ranges.start_date,
                  ranges.end_date
           FROM schedule_design_timeline_ranges AS ranges
           LEFT JOIN schedule_design_processes AS direct_process ON direct_process.id = ranges.process_id
           LEFT JOIN schedule_design_sub_process_stages AS stage ON stage.id = ranges.stage_id
           LEFT JOIN schedule_design_sub_processes AS sub_process ON sub_process.id = stage.sub_process_id
           LEFT JOIN schedule_design_processes AS parent_process ON parent_process.id = sub_process.process_id
           JOIN schedule_design_parts AS parts ON parts.id = COALESCE(direct_process.part_id, parent_process.part_id)
           WHERE parts.design_id = $1
           ORDER BY ranges.start_date ASC`,
          [project.design_id],
        ),
      ]);

      const remarksByProcess = new Map();
      const remarksBySubProcess = new Map();
      const remarksByStage = new Map();
      remarksResult.rows.forEach((remark) => {
        const targetMap = remark.process_id
          ? remarksByProcess
          : remark.stage_id ? remarksByStage : remarksBySubProcess;
        const targetId = String(remark.process_id || remark.stage_id || remark.sub_process_id);
        const current = targetMap.get(targetId) || [];
        current.push({
          id: remark.id,
          scheduleDate: remark.schedule_date,
          mode: remark.remark_mode,
          remark: remark.remark,
          createdByUsername: remark.created_by_username,
        });
        targetMap.set(targetId, current);
      });

      const rangesByProcess = new Map();
      const rangesByStage = new Map();
      rangesResult.rows.forEach((range) => {
        const targetMap = range.process_id ? rangesByProcess : rangesByStage;
        const targetId = String(range.process_id || range.stage_id);
        const current = targetMap.get(targetId) || [];
        current.push({
          id: range.id,
          mode: range.range_mode,
          startDate: range.start_date,
          endDate: range.end_date,
        });
        targetMap.set(targetId, current);
      });

      const stagesBySubProcess = new Map();
      stagesResult.rows.forEach((stage) => {
        const current = stagesBySubProcess.get(String(stage.sub_process_id)) || [];
        current.push({
          id: stage.id,
          designType: stage.design_type,
          sequenceOrder: stage.sequence_order,
          picUserId: stage.pic_user_id,
          picUsername: stage.pic_username,
          actualPicUserId: stage.actual_pic_user_id,
          actualPicUsername: stage.actual_pic_username,
          plannedStartDate: stage.planned_start_date,
          plannedEndDate: stage.planned_end_date,
          actualStartDate: stage.actual_start_date,
          actualEndDate: stage.actual_end_date,
          timelineRanges: rangesByStage.get(String(stage.id)) || [],
          revisionRange: (rangesByStage.get(String(stage.id)) || []).find((range) => range.mode === "revision") || null,
          revisions: remarksByStage.get(String(stage.id)) || [],
        });
        stagesBySubProcess.set(String(stage.sub_process_id), current);
      });

      const subProcessesByProcess = new Map();
      subProcessesResult.rows.forEach((subProcess) => {
        const current = subProcessesByProcess.get(String(subProcess.process_id)) || [];
        current.push({
          id: subProcess.id,
          subProcessName: subProcess.sub_process_name,
          designType: subProcess.design_type,
          picUserId: subProcess.pic_user_id,
          picUsername: subProcess.pic_username,
          actualPicUserId: subProcess.actual_pic_user_id,
          actualPicUsername: subProcess.actual_pic_username,
          plannedStartDate: subProcess.planned_start_date,
          plannedEndDate: subProcess.planned_end_date,
          actualStartDate: subProcess.actual_start_date,
          actualEndDate: subProcess.actual_end_date,
          progressPercent: subProcess.progress_percent,
          status: subProcess.status,
          revisions: remarksBySubProcess.get(String(subProcess.id)) || [],
          stages: stagesBySubProcess.get(String(subProcess.id)) || [],
        });
        subProcessesByProcess.set(String(subProcess.process_id), current);
      });

      const processesByPart = new Map();
      processesResult.rows.forEach((process) => {
        const current = processesByPart.get(String(process.part_id)) || [];
        current.push({
          id: process.id,
          processName: process.process_name,
          designType: process.design_type,
          designPicUserId: process.design_pic_user_id,
          designPicUsername: process.design_pic_username,
          actualPicUserId: process.actual_pic_user_id,
          actualPicUsername: process.actual_pic_username,
          plannedStartDate: process.planned_start_date,
          plannedEndDate: process.planned_end_date,
          actualStartDate: process.actual_start_date,
          actualEndDate: process.actual_end_date,
          progressPercent: process.progress_percent,
          status: process.status,
          timelineRanges: rangesByProcess.get(String(process.id)) || [],
          revisionRange: (rangesByProcess.get(String(process.id)) || []).find((range) => range.mode === "revision") || null,
          revisions: remarksByProcess.get(String(process.id)) || [],
          subProcesses: subProcessesByProcess.get(String(process.id)) || [],
        });
        processesByPart.set(String(process.part_id), current);
      });

      return res.json({
        design: {
          id: project.design_id,
          project: {
            id: project.id,
            projectName: project.project_name,
            customer: project.customer,
            projectDate: project.project_date,
          },
          createdAt: project.design_created_at,
          updatedAt: project.design_updated_at,
          parts: partsResult.rows.map((part) => ({
            id: part.id,
            partName: part.part_name,
            partId: part.part_number,
            material: part.material,
            thickness: Number(part.thickness_mm),
            photoUrl: part.photo_filename ? `/api/schedule/part-photos/${part.photo_filename}` : null,
            photoOriginalName: part.photo_original_name,
            createdByUsername: part.created_by_username,
            createdAt: part.created_at,
            processes: processesByPart.get(String(part.id)) || [],
          })),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.put("/projects/:projectId/design/progress", async (req, res, next) => {
    try {
      const projectId = String(req.params.projectId || "");
      const targetType = String(req.body.targetType || "");
      const targetId = String(req.body.targetId || "");
      const progressPercent = Number(req.body.progressPercent);
      const status = String(req.body.status || "");

      if (!/^\d+$/.test(projectId) || !/^\d+$/.test(targetId)) {
        return res.status(400).json({ message: "Project or schedule item ID is not valid." });
      }
      if (!new Set(["process", "sub_process"]).has(targetType)) {
        return res.status(400).json({ message: "Progress can only be updated for a Process or Sub Process." });
      }
      if (!Number.isInteger(progressPercent) || progressPercent < 0 || progressPercent > 100) {
        return res.status(400).json({ message: "Progress must be a whole number from 0 to 100." });
      }
      if (!scheduleStatuses.has(status)) {
        return res.status(400).json({ message: "Status is not valid." });
      }

      const result = targetType === "process"
        ? await pool.query(
          `UPDATE schedule_design_processes AS target
           SET progress_percent = $1, status = $2, updated_at = CURRENT_TIMESTAMP
           FROM schedule_design_parts AS parts, schedule_designs AS designs
           WHERE target.id = $3
             AND parts.id = target.part_id
             AND designs.id = parts.design_id
             AND designs.project_id = $4
           RETURNING target.id, designs.id AS design_id`,
          [progressPercent, status, targetId, projectId],
        )
        : await pool.query(
          `UPDATE schedule_design_sub_processes AS target
           SET progress_percent = $1, status = $2, updated_at = CURRENT_TIMESTAMP
           FROM schedule_design_processes AS processes, schedule_design_parts AS parts, schedule_designs AS designs
           WHERE target.id = $3
             AND processes.id = target.process_id
             AND parts.id = processes.part_id
             AND designs.id = parts.design_id
             AND designs.project_id = $4
           RETURNING target.id, designs.id AS design_id`,
          [progressPercent, status, targetId, projectId],
        );

      if (!result.rows[0]) {
        return res.status(404).json({ message: "Schedule item was not found in this project." });
      }

      await pool.query(
        "UPDATE schedule_designs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [result.rows[0].design_id],
      );
      return res.json({
        message: "Progress and status updated successfully.",
        item: { targetType, targetId: Number(targetId), progressPercent, status },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.put("/projects/:projectId/design/remarks", async (req, res, next) => {
    try {
      const projectId = String(req.params.projectId || "");
      const targetType = String(req.body.targetType || "");
      const targetId = String(req.body.targetId || "");
      const scheduleDate = String(req.body.scheduleDate || "");
      const mode = String(req.body.mode || "");
      const remark = String(req.body.remark || "").trim();

      if (!/^\d+$/.test(projectId) || !/^\d+$/.test(targetId)) {
        return res.status(400).json({ message: "Project or timeline item ID is not valid." });
      }
      if (!new Set(["process", "sub_process", "sub_process_stage"]).has(targetType)) {
        return res.status(400).json({ message: "Timeline item type is not valid." });
      }
      if (!new Set(["plan", "actual", "revision"]).has(mode)) {
        return res.status(400).json({ message: "Remark mode is not valid." });
      }
      if (!isValidDate(scheduleDate)) {
        return res.status(400).json({ message: "Remark date is not valid." });
      }
      if (remark.length > 300) {
        return res.status(400).json({ message: "Remark maximum 300 characters." });
      }

      let targetResult;
      if (targetType === "process") {
        targetResult = await pool.query(
          `SELECT processes.id, parts.design_id
           FROM schedule_design_processes AS processes
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           WHERE processes.id = $1 AND designs.project_id = $2`,
          [targetId, projectId],
        );
      } else if (targetType === "sub_process") {
        targetResult = await pool.query(
          `SELECT sub_processes.id, parts.design_id
           FROM schedule_design_sub_processes AS sub_processes
           JOIN schedule_design_processes AS processes ON processes.id = sub_processes.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           WHERE sub_processes.id = $1 AND designs.project_id = $2`,
          [targetId, projectId],
        );
      } else {
        targetResult = await pool.query(
          `SELECT stages.id, parts.design_id
           FROM schedule_design_sub_process_stages AS stages
           JOIN schedule_design_sub_processes AS sub_processes ON sub_processes.id = stages.sub_process_id
           JOIN schedule_design_processes AS processes ON processes.id = sub_processes.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           WHERE stages.id = $1 AND designs.project_id = $2`,
          [targetId, projectId],
        );
      }

      if (!targetResult.rows[0]) {
        return res.status(404).json({ message: "Timeline item was not found in this project." });
      }

      const targetColumn = targetType === "process"
        ? "process_id"
        : targetType === "sub_process_stage" ? "stage_id" : "sub_process_id";

      if (!remark) {
        await pool.query(
          `DELETE FROM schedule_design_timeline_remarks
           WHERE ${targetColumn} = $1 AND schedule_date = $2 AND remark_mode = $3`,
          [targetId, scheduleDate, mode],
        );
        await pool.query("UPDATE schedule_designs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [targetResult.rows[0].design_id]);
        return res.json({ message: "Timeline remark deleted successfully." });
      }

      const conflictTarget = targetType === "process"
        ? "(process_id, schedule_date, remark_mode) WHERE process_id IS NOT NULL"
        : targetType === "sub_process_stage"
          ? "(stage_id, schedule_date, remark_mode) WHERE stage_id IS NOT NULL"
          : "(sub_process_id, schedule_date, remark_mode) WHERE sub_process_id IS NOT NULL";
      await pool.query(
        `INSERT INTO schedule_design_timeline_remarks (${targetColumn}, schedule_date, remark_mode, remark, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ${conflictTarget}
         DO UPDATE SET remark = EXCLUDED.remark, updated_at = CURRENT_TIMESTAMP`,
        [targetId, scheduleDate, mode, remark, req.auth.sub],
      );
      await pool.query("UPDATE schedule_designs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [targetResult.rows[0].design_id]);
      return res.json({ message: "Timeline remark saved successfully." });
    } catch (error) {
      if (error.code === "23503") {
        return res.status(400).json({ message: "Remark user is not valid." });
      }
      return next(error);
    }
  });

  router.post("/projects/:projectId/design/timeline-conflicts", async (req, res, next) => {
    try {
      const projectId = String(req.params.projectId || "");
      const targetType = String(req.body.targetType || "");
      const targetId = String(req.body.targetId || "");
      const mode = String(req.body.mode || "");
      const startDate = String(req.body.startDate || "");
      const endDate = String(req.body.endDate || "");

      if (!/^\d+$/.test(projectId) || !/^\d+$/.test(targetId)) {
        return res.status(400).json({ message: "Project or timeline item ID is not valid." });
      }
      if (!new Set(["process", "sub_process_stage"]).has(targetType)) {
        return res.status(400).json({ message: "Timeline item type is not valid." });
      }
      if (!new Set(["plan", "actual", "revision"]).has(mode)) {
        return res.status(400).json({ message: "Timeline range mode is not valid." });
      }
      if (!isValidDate(startDate) || !isValidDate(endDate) || endDate < startDate) {
        return res.status(400).json({ message: "Timeline date range is not valid." });
      }
      if (mode === "revision") {
        return res.json({ picUsername: null, conflicts: [] });
      }

      const picColumn = mode === "plan" ? "pic_user_id" : "actual_pic_user_id";
      const processPicColumn = mode === "plan" ? "design_pic_user_id" : "actual_pic_user_id";
      const startColumn = mode === "plan" ? "planned_start_date" : "actual_start_date";
      const endColumn = mode === "plan" ? "planned_end_date" : "actual_end_date";
      const targetResult = targetType === "process"
        ? await pool.query(
          `SELECT processes.${processPicColumn} AS pic_user_id, users.username AS pic_username
           FROM schedule_design_processes AS processes
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           LEFT JOIN users ON users.id = processes.${processPicColumn}
           WHERE processes.id = $1 AND designs.project_id = $2`,
          [targetId, projectId],
        )
        : await pool.query(
          `SELECT stages.${picColumn} AS pic_user_id, users.username AS pic_username
           FROM schedule_design_sub_process_stages AS stages
           JOIN schedule_design_sub_processes AS sub_processes ON sub_processes.id = stages.sub_process_id
           JOIN schedule_design_processes AS processes ON processes.id = sub_processes.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           LEFT JOIN users ON users.id = stages.${picColumn}
           WHERE stages.id = $1 AND designs.project_id = $2`,
          [targetId, projectId],
        );
      const target = targetResult.rows[0];

      if (!target) {
        return res.status(404).json({ message: "Timeline item was not found in this project." });
      }
      if (!target.pic_user_id) {
        return res.json({ picUsername: null, conflicts: [] });
      }

      const conflictsResult = await pool.query(
        `SELECT * FROM (
           SELECT 'process' AS target_type,
                  processes.id AS target_id,
                  projects.project_name,
                  parts.part_name,
                  processes.process_name AS job_name,
                  processes.design_type,
                  processes.${startColumn} AS start_date,
                  processes.${endColumn} AS end_date
           FROM schedule_design_processes AS processes
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           JOIN schedule_projects AS projects ON projects.id = designs.project_id
           WHERE processes.${processPicColumn} = $1
             AND processes.${startColumn} IS NOT NULL
             AND processes.${endColumn} IS NOT NULL
             AND processes.${endColumn} >= $2
             AND processes.${startColumn} <= $3
             AND NOT ($4 = 'process' AND processes.id = $5)
           UNION ALL
           SELECT 'process' AS target_type,
                  processes.id AS target_id,
                  projects.project_name,
                  parts.part_name,
                  processes.process_name AS job_name,
                  processes.design_type,
                  ranges.start_date,
                  ranges.end_date
           FROM schedule_design_timeline_ranges AS ranges
           JOIN schedule_design_processes AS processes ON processes.id = ranges.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           JOIN schedule_projects AS projects ON projects.id = designs.project_id
           WHERE ranges.range_mode = $6
             AND processes.${processPicColumn} = $1
             AND ranges.end_date >= $2
             AND ranges.start_date <= $3
             AND NOT ($4 = 'process' AND processes.id = $5)
           UNION ALL
           SELECT 'sub_process_stage' AS target_type,
                  stages.id AS target_id,
                  projects.project_name,
                  parts.part_name,
                  sub_processes.sub_process_name AS job_name,
                  stages.design_type,
                  stages.${startColumn} AS start_date,
                  stages.${endColumn} AS end_date
           FROM schedule_design_sub_process_stages AS stages
           JOIN schedule_design_sub_processes AS sub_processes ON sub_processes.id = stages.sub_process_id
           JOIN schedule_design_processes AS processes ON processes.id = sub_processes.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           JOIN schedule_projects AS projects ON projects.id = designs.project_id
           WHERE stages.${picColumn} = $1
             AND stages.${startColumn} IS NOT NULL
             AND stages.${endColumn} IS NOT NULL
             AND stages.${endColumn} >= $2
             AND stages.${startColumn} <= $3
             AND NOT ($4 = 'sub_process_stage' AND stages.id = $5)
           UNION ALL
           SELECT 'sub_process_stage' AS target_type,
                  stages.id AS target_id,
                  projects.project_name,
                  parts.part_name,
                  sub_processes.sub_process_name AS job_name,
                  stages.design_type,
                  ranges.start_date,
                  ranges.end_date
           FROM schedule_design_timeline_ranges AS ranges
           JOIN schedule_design_sub_process_stages AS stages ON stages.id = ranges.stage_id
           JOIN schedule_design_sub_processes AS sub_processes ON sub_processes.id = stages.sub_process_id
           JOIN schedule_design_processes AS processes ON processes.id = sub_processes.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           JOIN schedule_projects AS projects ON projects.id = designs.project_id
           WHERE ranges.range_mode = $6
             AND stages.${picColumn} = $1
             AND ranges.end_date >= $2
             AND ranges.start_date <= $3
             AND NOT ($4 = 'sub_process_stage' AND stages.id = $5)
         ) AS conflicts
         ORDER BY start_date ASC, project_name ASC, part_name ASC`,
        [target.pic_user_id, startDate, endDate, targetType, targetId, mode],
      );

      return res.json({
        picUsername: target.pic_username,
        conflicts: conflictsResult.rows.map((conflict) => ({
          targetType: conflict.target_type,
          targetId: conflict.target_id,
          projectName: conflict.project_name,
          partName: conflict.part_name,
          jobName: conflict.job_name,
          designType: conflict.design_type,
          startDate: conflict.start_date,
          endDate: conflict.end_date,
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.put("/projects/:projectId/design/timeline-range", async (req, res, next) => {
    const client = await pool.connect();

    try {
      const projectId = String(req.params.projectId || "");
      const targetType = String(req.body.targetType || "");
      const targetId = String(req.body.targetId || "");
      const mode = String(req.body.mode || "");
      const startDate = String(req.body.startDate || "");
      const endDate = String(req.body.endDate || "");
      const rangeId = req.body.rangeId === "primary" ? "primary" : String(req.body.rangeId || "");

      if (!/^\d+$/.test(projectId) || !/^\d+$/.test(targetId)) {
        return res.status(400).json({ message: "Project or timeline item ID is not valid." });
      }
      if (!new Set(["process", "sub_process_stage"]).has(targetType)) {
        return res.status(400).json({ message: "Only a Process or Sub Process design stage can receive a date range." });
      }
      if (!new Set(["plan", "actual", "revision"]).has(mode)) {
        return res.status(400).json({ message: "Timeline range mode is not valid." });
      }
      if (!isValidDate(startDate) || !isValidDate(endDate) || endDate < startDate) {
        return res.status(400).json({ message: "Timeline date range is not valid." });
      }

      await client.query("BEGIN");
      let designId;
      let previousStartDate = null;
      let previousEndDate = null;
      let remarkTargetColumn;

      if (targetType === "process") {
        const targetResult = await client.query(
          `SELECT processes.id, processes.actual_pic_user_id,
                  processes.planned_start_date, processes.planned_end_date,
                  processes.actual_start_date, processes.actual_end_date,
                  parts.design_id
           FROM schedule_design_processes AS processes
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           WHERE processes.id = $1 AND designs.project_id = $2
           FOR UPDATE OF processes`,
          [targetId, projectId],
        );
        const target = targetResult.rows[0];

        if (!target) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Process was not found in this project." });
        }
        if (mode === "actual" && !target.actual_pic_user_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "Set the Process Actual PIC before assigning Actual dates." });
        }
        remarkTargetColumn = "process_id";

        const startColumn = mode === "plan" ? "planned_start_date" : "actual_start_date";
        const endColumn = mode === "plan" ? "planned_end_date" : "actual_end_date";
        const primaryStart = mode === "plan" ? target.planned_start_date : target.actual_start_date;
        const primaryEnd = mode === "plan" ? target.planned_end_date : target.actual_end_date;

        if (rangeId && rangeId !== "primary") {
          const rangeResult = await client.query(
            `WITH previous AS (
               SELECT start_date, end_date
               FROM schedule_design_timeline_ranges
               WHERE id = $3 AND process_id = $4 AND range_mode = $5
             )
             UPDATE schedule_design_timeline_ranges AS ranges
             SET start_date = $1, end_date = $2, updated_at = CURRENT_TIMESTAMP
             FROM previous
             WHERE ranges.id = $3 AND ranges.process_id = $4 AND ranges.range_mode = $5
             RETURNING previous.start_date AS previous_start_date,
                       previous.end_date AS previous_end_date`,
            [startDate, endDate, rangeId, targetId, mode],
          );
          if (!rangeResult.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Timeline segment was not found." });
          }
          previousStartDate = rangeResult.rows[0].previous_start_date;
          previousEndDate = rangeResult.rows[0].previous_end_date;
        } else if (mode !== "revision" && (rangeId === "primary" || !primaryStart || !primaryEnd)) {
          previousStartDate = primaryStart;
          previousEndDate = primaryEnd;
          await client.query(
            `UPDATE schedule_design_processes
             SET ${startColumn} = $1, ${endColumn} = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [startDate, endDate, targetId],
          );
        } else {
          await client.query(
            `INSERT INTO schedule_design_timeline_ranges
               (process_id, range_mode, start_date, end_date, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [targetId, mode, startDate, endDate, req.auth.sub],
          );
        }
        designId = target.design_id;
      } else {
        const targetResult = await client.query(
          `SELECT stages.id, stages.sub_process_id, stages.sequence_order,
                  stages.design_type, stages.actual_pic_user_id,
                  stages.planned_start_date, stages.planned_end_date,
                  stages.actual_start_date, stages.actual_end_date,
                  parts.design_id
           FROM schedule_design_sub_process_stages AS stages
           JOIN schedule_design_sub_processes AS sub_processes ON sub_processes.id = stages.sub_process_id
           JOIN schedule_design_processes AS processes ON processes.id = sub_processes.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           WHERE stages.id = $1 AND designs.project_id = $2
           FOR UPDATE OF stages`,
          [targetId, projectId],
        );
        const target = targetResult.rows[0];

        if (!target) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Sub Process design stage was not found in this project." });
        }
        if (mode === "actual" && !target.actual_pic_user_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "Set the stage Actual PIC before assigning Actual dates." });
        }
        remarkTargetColumn = "stage_id";

        if (mode === "revision" && (!rangeId || rangeId === "primary")) {
          const conflictResult = await client.query(
            `SELECT EXISTS (
               SELECT 1
               FROM schedule_design_timeline_ranges AS ranges
               JOIN schedule_design_sub_process_stages AS sibling ON sibling.id = ranges.stage_id
               WHERE sibling.sub_process_id = $1
                 AND sibling.id <> $2
                 AND ranges.range_mode = 'revision'
                 AND ranges.end_date >= $3
                 AND ranges.start_date <= $4
             ) AS conflicts_stage`,
            [target.sub_process_id, targetId, startDate, endDate],
          );
          if (conflictResult.rows[0].conflicts_stage) {
            await client.query("ROLLBACK");
            return res.status(409).json({ message: "Revision range overlaps another Design Type in this Sub Process." });
          }

        }

        const startColumn = mode === "plan" ? "planned_start_date" : "actual_start_date";
        const endColumn = mode === "plan" ? "planned_end_date" : "actual_end_date";
        const primaryStart = mode === "plan" ? target.planned_start_date : target.actual_start_date;
        const primaryEnd = mode === "plan" ? target.planned_end_date : target.actual_end_date;

        if (rangeId && rangeId !== "primary") {
          const rangeResult = await client.query(
            `WITH previous AS (
               SELECT start_date, end_date
               FROM schedule_design_timeline_ranges
               WHERE id = $3 AND stage_id = $4 AND range_mode = $5
             )
             UPDATE schedule_design_timeline_ranges AS ranges
             SET start_date = $1, end_date = $2, updated_at = CURRENT_TIMESTAMP
             FROM previous
             WHERE ranges.id = $3 AND ranges.stage_id = $4 AND ranges.range_mode = $5
             RETURNING previous.start_date AS previous_start_date,
                       previous.end_date AS previous_end_date`,
            [startDate, endDate, rangeId, targetId, mode],
          );
          if (!rangeResult.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Timeline segment was not found." });
          }
          previousStartDate = rangeResult.rows[0].previous_start_date;
          previousEndDate = rangeResult.rows[0].previous_end_date;
        } else if (mode !== "revision" && (rangeId === "primary" || !primaryStart || !primaryEnd)) {
          previousStartDate = primaryStart;
          previousEndDate = primaryEnd;
          await client.query(
            `UPDATE schedule_design_sub_process_stages
             SET ${startColumn} = $1, ${endColumn} = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [startDate, endDate, targetId],
          );
          if (Number(target.sequence_order) === 1) {
            await client.query(
              `UPDATE schedule_design_sub_processes
               SET ${startColumn} = $1, ${endColumn} = $2, updated_at = CURRENT_TIMESTAMP
               WHERE id = $3`,
              [startDate, endDate, target.sub_process_id],
            );
          }
        } else {
          await client.query(
            `INSERT INTO schedule_design_timeline_ranges
               (stage_id, range_mode, start_date, end_date, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [targetId, mode, startDate, endDate, req.auth.sub],
          );
        }
        designId = target.design_id;
      }

      let movedRemarks = 0;
      if (previousStartDate && String(previousStartDate).slice(0, 10) !== startDate) {
        const movedRemarksResult = await client.query(
          `WITH moved AS (
             DELETE FROM schedule_design_timeline_remarks
             WHERE ${remarkTargetColumn} = $1
               AND remark_mode = $2
               AND schedule_date BETWEEN $4::date AND $5::date
             RETURNING process_id, sub_process_id, stage_id, schedule_date, remark_mode,
                       remark, created_by, created_at
           )
           INSERT INTO schedule_design_timeline_remarks
             (process_id, sub_process_id, stage_id, schedule_date, remark_mode, remark, created_by, created_at, updated_at)
           SELECT process_id, sub_process_id, stage_id,
                  schedule_date + ($3::date - $4::date), remark_mode, remark, created_by, created_at,
                  CURRENT_TIMESTAMP
           FROM moved
           RETURNING id`,
          [
            targetId,
            mode,
            startDate,
            String(previousStartDate).slice(0, 10),
            String(previousEndDate || previousStartDate).slice(0, 10),
          ],
        );
        movedRemarks = movedRemarksResult.rowCount;
      }

      await client.query(
        "UPDATE schedule_designs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [designId],
      );
      await client.query("COMMIT");
      return res.json({
        message: "Timeline range updated successfully.",
        range: { targetType, targetId: Number(targetId), mode, startDate, endDate },
        movedRemarks,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.delete("/projects/:projectId/design/timeline-range", async (req, res, next) => {
    const client = await pool.connect();

    try {
      const projectId = String(req.params.projectId || "");
      const targetType = String(req.body.targetType || "");
      const targetId = String(req.body.targetId || "");
      const mode = String(req.body.mode || "");
      const rangeId = req.body.rangeId === "primary" ? "primary" : String(req.body.rangeId || "");

      if (!/^\d+$/.test(projectId) || !/^\d+$/.test(targetId)) {
        return res.status(400).json({ message: "Project or timeline item ID is not valid." });
      }
      if (!new Set(["process", "sub_process_stage"]).has(targetType)) {
        return res.status(400).json({ message: "Only a Process or Sub Process design stage can delete a date range." });
      }
      if (!new Set(["plan", "actual", "revision"]).has(mode)) {
        return res.status(400).json({ message: "Timeline range mode is not valid." });
      }
      if (!rangeId) {
        return res.status(400).json({ message: "Select an existing timeline range to delete." });
      }

      await client.query("BEGIN");
      let designId;
      let deletedStartDate = null;
      let deletedEndDate = null;
      let remarkTargetColumn;

      if (targetType === "process") {
        const targetResult = await client.query(
          `SELECT processes.id,
                  processes.planned_start_date, processes.planned_end_date,
                  processes.actual_start_date, processes.actual_end_date,
                  parts.design_id
           FROM schedule_design_processes AS processes
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           WHERE processes.id = $1 AND designs.project_id = $2
           FOR UPDATE OF processes`,
          [targetId, projectId],
        );
        const target = targetResult.rows[0];

        if (!target) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Process was not found in this project." });
        }

        remarkTargetColumn = "process_id";
        designId = target.design_id;

        if (rangeId === "primary") {
          if (mode === "revision") {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Revision ranges must be deleted by segment." });
          }
          const startColumn = mode === "plan" ? "planned_start_date" : "actual_start_date";
          const endColumn = mode === "plan" ? "planned_end_date" : "actual_end_date";
          deletedStartDate = mode === "plan" ? target.planned_start_date : target.actual_start_date;
          deletedEndDate = mode === "plan" ? target.planned_end_date : target.actual_end_date;

          await client.query(
            `UPDATE schedule_design_processes
             SET ${startColumn} = NULL, ${endColumn} = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [targetId],
          );
        } else {
          const deletedResult = await client.query(
            `DELETE FROM schedule_design_timeline_ranges
             WHERE id = $1 AND process_id = $2 AND range_mode = $3
             RETURNING start_date, end_date`,
            [rangeId, targetId, mode],
          );
          if (!deletedResult.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Timeline segment was not found." });
          }
          deletedStartDate = deletedResult.rows[0].start_date;
          deletedEndDate = deletedResult.rows[0].end_date;
        }
      } else {
        const targetResult = await client.query(
          `SELECT stages.id, stages.sub_process_id, stages.sequence_order,
                  stages.planned_start_date, stages.planned_end_date,
                  stages.actual_start_date, stages.actual_end_date,
                  parts.design_id
           FROM schedule_design_sub_process_stages AS stages
           JOIN schedule_design_sub_processes AS sub_processes ON sub_processes.id = stages.sub_process_id
           JOIN schedule_design_processes AS processes ON processes.id = sub_processes.process_id
           JOIN schedule_design_parts AS parts ON parts.id = processes.part_id
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           WHERE stages.id = $1 AND designs.project_id = $2
           FOR UPDATE OF stages`,
          [targetId, projectId],
        );
        const target = targetResult.rows[0];

        if (!target) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Sub Process design stage was not found in this project." });
        }

        remarkTargetColumn = "stage_id";
        designId = target.design_id;

        if (rangeId === "primary") {
          if (mode === "revision") {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Revision ranges must be deleted by segment." });
          }
          const startColumn = mode === "plan" ? "planned_start_date" : "actual_start_date";
          const endColumn = mode === "plan" ? "planned_end_date" : "actual_end_date";
          deletedStartDate = mode === "plan" ? target.planned_start_date : target.actual_start_date;
          deletedEndDate = mode === "plan" ? target.planned_end_date : target.actual_end_date;

          await client.query(
            `UPDATE schedule_design_sub_process_stages
             SET ${startColumn} = NULL, ${endColumn} = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [targetId],
          );
          if (Number(target.sequence_order) === 1) {
            await client.query(
              `UPDATE schedule_design_sub_processes
               SET ${startColumn} = NULL, ${endColumn} = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [target.sub_process_id],
            );
          }
        } else {
          const deletedResult = await client.query(
            `DELETE FROM schedule_design_timeline_ranges
             WHERE id = $1 AND stage_id = $2 AND range_mode = $3
             RETURNING start_date, end_date`,
            [rangeId, targetId, mode],
          );
          if (!deletedResult.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Timeline segment was not found." });
          }
          deletedStartDate = deletedResult.rows[0].start_date;
          deletedEndDate = deletedResult.rows[0].end_date;
        }
      }

      let deletedRemarks = 0;
      if (deletedStartDate && deletedEndDate) {
        const deletedRemarksResult = await client.query(
          `DELETE FROM schedule_design_timeline_remarks
           WHERE ${remarkTargetColumn} = $1
             AND remark_mode = $2
             AND schedule_date BETWEEN $3::date AND $4::date`,
          [
            targetId,
            mode,
            String(deletedStartDate).slice(0, 10),
            String(deletedEndDate).slice(0, 10),
          ],
        );
        deletedRemarks = deletedRemarksResult.rowCount;
      }

      await client.query(
        "UPDATE schedule_designs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [designId],
      );
      await client.query("COMMIT");
      return res.json({
        message: "Timeline range deleted successfully.",
        deletedRemarks,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post(
    "/projects/:projectId/design/parts",
    (req, res, next) => {
      partPhotoUpload(req, res, (error) => {
        if (error) {
          return res.status(400).json({ message: error.message || "Part photo could not be uploaded." });
        }
        return next();
      });
    },
    async (req, res, next) => {
      const client = await pool.connect();
      const uploadedPhotoPath = req.file?.path;
      let keepUploadedPhoto = false;

      try {
        if (!/^\d+$/.test(req.params.projectId)) {
          return res.status(400).json({ message: "Project ID is not valid." });
        }

        const { errors, values } = validatePartPayload(req.body, req.file);

        if (errors.length > 0) {
          return res.status(400).json({ message: errors[0], errors });
        }

        await client.query("BEGIN");
        const designResult = await client.query(
          `SELECT designs.id
           FROM schedule_designs AS designs
           JOIN schedule_projects AS projects ON projects.id = designs.project_id
           WHERE projects.id = $1
           LIMIT 1`,
          [req.params.projectId],
        );

        if (!designResult.rows[0]) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Design Schedule was not found." });
        }

        const partResult = await client.query(
          `INSERT INTO schedule_design_parts
             (design_id, part_name, part_number, material, thickness_mm, photo_filename, photo_original_name, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            designResult.rows[0].id,
            values.partName,
            values.partId,
            values.material,
            values.thickness,
            req.file.filename,
            req.file.originalname,
            req.auth.sub,
          ],
        );

        await insertDesignProcesses(client, partResult.rows[0].id, values.processes);

        await client.query(
          "UPDATE schedule_designs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [designResult.rows[0].id],
        );
        await client.query("COMMIT");
        keepUploadedPhoto = true;
        return res.status(201).json({
          message: "Part and Design Schedule processes created successfully.",
          partId: partResult.rows[0].id,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});

        if (error.code === "23505") {
          return res.status(409).json({ message: "Part ID already exists in this Design Schedule." });
        }

        if (error.code === "23503") {
          return res.status(400).json({ message: "One of the selected PIC users is not valid." });
        }

        return next(error);
      } finally {
        client.release();

        if (!keepUploadedPhoto && uploadedPhotoPath) {
          await unlink(uploadedPhotoPath).catch(() => {});
        }
      }
    },
  );

  router.patch(
    "/projects/:projectId/design/parts/:partId",
    (req, res, next) => {
      partPhotoUpload(req, res, (error) => {
        if (error) {
          return res.status(400).json({ message: error.message || "Part photo could not be uploaded." });
        }
        return next();
      });
    },
    async (req, res, next) => {
      const client = await pool.connect();
      const uploadedPhotoPath = req.file?.path;
      let keepUploadedPhoto = false;
      let previousPhotoFilename = null;

      try {
        if (!/^\d+$/.test(req.params.projectId) || !/^\d+$/.test(req.params.partId)) {
          return res.status(400).json({ message: "Project or Part ID is not valid." });
        }

        const { errors, values } = validatePartPayload(req.body, req.file, false);

        if (errors.length > 0) {
          return res.status(400).json({ message: errors[0], errors });
        }

        await client.query("BEGIN");
        const currentPartResult = await client.query(
          `SELECT parts.id, parts.design_id, parts.photo_filename, parts.photo_original_name
           FROM schedule_design_parts AS parts
           JOIN schedule_designs AS designs ON designs.id = parts.design_id
           WHERE parts.id = $1 AND designs.project_id = $2
           FOR UPDATE`,
          [req.params.partId, req.params.projectId],
        );
        const currentPart = currentPartResult.rows[0];

        if (!currentPart) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Part was not found in this Design Schedule." });
        }

        previousPhotoFilename = currentPart.photo_filename;
        await client.query(
          `UPDATE schedule_design_parts
           SET part_name = $1,
               part_number = $2,
               material = $3,
               thickness_mm = $4,
               photo_filename = $5,
               photo_original_name = $6,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $7`,
          [
            values.partName,
            values.partId,
            values.material,
            values.thickness,
            req.file?.filename || currentPart.photo_filename,
            req.file?.originalname || currentPart.photo_original_name,
            currentPart.id,
          ],
        );
        const remarksResult = await client.query(
          `SELECT remarks.*
           FROM schedule_design_timeline_remarks AS remarks
           LEFT JOIN schedule_design_processes AS direct_process ON direct_process.id = remarks.process_id
           LEFT JOIN schedule_design_sub_processes AS direct_sub_process ON direct_sub_process.id = remarks.sub_process_id
           LEFT JOIN schedule_design_sub_process_stages AS stage ON stage.id = remarks.stage_id
           LEFT JOIN schedule_design_sub_processes AS stage_sub_process ON stage_sub_process.id = stage.sub_process_id
           LEFT JOIN schedule_design_processes AS parent_process
             ON parent_process.id = COALESCE(direct_sub_process.process_id, stage_sub_process.process_id)
           WHERE COALESCE(direct_process.part_id, parent_process.part_id) = $1`,
          [currentPart.id],
        );
        const rangesResult = await client.query(
          `SELECT ranges.*
           FROM schedule_design_timeline_ranges AS ranges
           LEFT JOIN schedule_design_processes AS direct_process ON direct_process.id = ranges.process_id
           LEFT JOIN schedule_design_sub_process_stages AS stage ON stage.id = ranges.stage_id
           LEFT JOIN schedule_design_sub_processes AS sub_process ON sub_process.id = stage.sub_process_id
           LEFT JOIN schedule_design_processes AS parent_process ON parent_process.id = sub_process.process_id
           WHERE COALESCE(direct_process.part_id, parent_process.part_id) = $1`,
          [currentPart.id],
        );
        await client.query("DELETE FROM schedule_design_processes WHERE part_id = $1", [currentPart.id]);
        const idMappings = await insertDesignProcesses(client, currentPart.id, values.processes);
        await restoreTimelineRemarks(client, remarksResult.rows, idMappings);
        await restoreTimelineRanges(client, rangesResult.rows, idMappings);
        await client.query(
          "UPDATE schedule_designs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [currentPart.design_id],
        );
        await client.query("COMMIT");
        keepUploadedPhoto = Boolean(req.file);

        if (req.file && previousPhotoFilename) {
          await unlink(resolve(partPhotoDirectory, previousPhotoFilename)).catch(() => {});
        }

        return res.json({ message: "Part and Design Schedule updated successfully." });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});

        if (error.code === "23505") {
          return res.status(409).json({ message: "Part ID already exists in this Design Schedule." });
        }

        if (error.code === "23503") {
          return res.status(400).json({ message: "One of the selected PIC users is not valid." });
        }

        return next(error);
      } finally {
        client.release();

        if (!keepUploadedPhoto && uploadedPhotoPath) {
          await unlink(uploadedPhotoPath).catch(() => {});
        }
      }
    },
  );

  router.delete("/projects/:projectId/design/parts/:partId", async (req, res, next) => {
    const client = await pool.connect();
    let photoFilename = null;

    try {
      if (!/^\d+$/.test(req.params.projectId) || !/^\d+$/.test(req.params.partId)) {
        return res.status(400).json({ message: "Project or Part ID is not valid." });
      }

      await client.query("BEGIN");
      const partResult = await client.query(
        `SELECT parts.id, parts.design_id, parts.photo_filename
         FROM schedule_design_parts AS parts
         JOIN schedule_designs AS designs ON designs.id = parts.design_id
         WHERE parts.id = $1 AND designs.project_id = $2
         FOR UPDATE`,
        [req.params.partId, req.params.projectId],
      );
      const part = partResult.rows[0];

      if (!part) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Part was not found in this Design Schedule." });
      }

      photoFilename = part.photo_filename;
      await client.query("DELETE FROM schedule_design_parts WHERE id = $1", [part.id]);
      await client.query(
        "UPDATE schedule_designs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [part.design_id],
      );
      await client.query("COMMIT");

      if (photoFilename) {
        await unlink(resolve(partPhotoDirectory, photoFilename)).catch(() => {});
      }

      return res.json({ message: "Part deleted successfully." });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}
