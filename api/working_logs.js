import { Router } from "express";

const importanceLevels = new Set(["urgent", "important", "neutral"]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function getTodayDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toPublicLog(log) {
  return {
    id: log.id,
    userId: log.user_id,
    username: log.username,
    logDate: log.log_date,
    activity: log.activity,
    description: log.description,
    importance: log.importance,
    isRead: log.is_read,
    isClosed: log.is_closed,
    adminComment: log.admin_comment,
    reviewedBy: log.reviewed_by,
    reviewedByUsername: log.reviewed_by_username,
    reviewedAt: log.reviewed_at,
    closedBy: log.closed_by,
    closedByUsername: log.closed_by_username,
    closedAt: log.closed_at,
    createdAt: log.created_at,
    comments: log.comments || [],
  };
}

function toPublicComment(comment) {
  return {
    id: comment.id,
    logId: comment.log_id,
    userId: comment.user_id,
    username: comment.username,
    comment: comment.comment,
    createdAt: comment.created_at,
  };
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateLog(body) {
  const values = {
    logDate: normalizeText(body.logDate || getTodayDate()),
    activity: normalizeText(body.activity),
    description: normalizeText(body.description),
    importance: normalizeText(body.importance || "neutral").toLowerCase(),
  };
  const errors = {};

  if (!values.activity) {
    errors.activity = "Activity is required.";
  } else if (values.activity.length > 150) {
    errors.activity = "Activity maximum 150 characters.";
  }

  if (!isValidDate(values.logDate)) {
    errors.logDate = "Log date is not valid.";
  }

  if (!values.description) {
    errors.description = "Description is required.";
  } else if (values.description.length > 1000) {
    errors.description = "Description maximum 1000 characters.";
  }

  if (!importanceLevels.has(values.importance)) {
    errors.importance = "Importance is not valid.";
  }

  return { values, errors };
}

function canViewAllLogs(role) {
  return role === "admin" || role === "super_admin";
}

function requireLogAdmin(req, res, next) {
  if (!canViewAllLogs(req.auth.role)) {
    return res.status(403).json({ message: "Only admins can review working logs." });
  }

  return next();
}

export default function createWorkingLogsRouter({ pool }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const viewAll = canViewAllLogs(req.auth.role);
      const dayLimit = Math.min(Math.max(Number(req.query.days) || 2, 1), 14);
      const beforeDate = normalizeText(req.query.before);

      if (beforeDate && !isValidDate(beforeDate)) {
        return res.status(400).json({ message: "Pagination date is not valid." });
      }

      const [summaryResult, dateResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) FILTER (WHERE is_read = FALSE AND is_closed = FALSE)::int AS unread,
                  COUNT(*) FILTER (WHERE is_closed = FALSE AND importance = 'urgent')::int AS urgent,
                  COUNT(*) FILTER (WHERE is_closed = FALSE AND importance = 'important')::int AS important,
                  COUNT(*) FILTER (WHERE is_closed = FALSE AND importance = 'neutral')::int AS neutral
           FROM working_logs
           WHERE ($1::boolean = TRUE OR user_id = $2)`,
          [viewAll, req.auth.sub],
        ),
        pool.query(
          `SELECT DISTINCT wl.log_date
           FROM working_logs wl
           WHERE ($1::boolean = TRUE OR wl.user_id = $2)
             AND ($3::date IS NULL OR wl.log_date < $3::date)
           ORDER BY wl.log_date DESC
           LIMIT $4`,
          [viewAll, req.auth.sub, beforeDate || null, dayLimit + 1],
        ),
      ]);

      const pageDates = dateResult.rows.slice(0, dayLimit).map((row) => row.log_date);
      const hasMore = dateResult.rows.length > dayLimit;

      if (pageDates.length === 0) {
        return res.json({
          logs: [],
          canViewAll: viewAll,
          summary: summaryResult.rows[0],
          pagination: {
            hasMore: false,
            nextCursor: null,
          },
        });
      }

      const result = await pool.query(
        `SELECT wl.id, wl.user_id, u.username, wl.log_date, wl.activity, wl.description, wl.importance,
                wl.is_read, wl.is_closed, wl.admin_comment, wl.reviewed_by, reviewer.username AS reviewed_by_username,
                wl.reviewed_at, wl.closed_by, closer.username AS closed_by_username, wl.closed_at, wl.created_at
         FROM working_logs wl
         JOIN users u ON u.id = wl.user_id
         LEFT JOIN users reviewer ON reviewer.id = wl.reviewed_by
         LEFT JOIN users closer ON closer.id = wl.closed_by
         WHERE ($1::boolean = TRUE OR wl.user_id = $2)
           AND wl.log_date = ANY($3::date[])
         ORDER BY wl.log_date DESC,
                  wl.is_closed ASC,
                  CASE wl.importance
                    WHEN 'urgent' THEN 1
                    WHEN 'important' THEN 2
                    ELSE 3
                  END,
                  wl.created_at DESC,
                  wl.id DESC
         LIMIT 500`,
        [viewAll, req.auth.sub, pageDates],
      );

      const logIds = result.rows.map((log) => log.id);
      const commentsResult = logIds.length
        ? await pool.query(
          `SELECT comments.id, comments.log_id, comments.user_id, users.username, comments.comment, comments.created_at
           FROM working_log_comments comments
           LEFT JOIN users ON users.id = comments.user_id
           WHERE comments.log_id = ANY($1::bigint[])
           ORDER BY comments.created_at ASC, comments.id ASC`,
          [logIds],
        )
        : { rows: [] };
      const commentsByLog = new Map();
      commentsResult.rows.forEach((comment) => {
        const logId = String(comment.log_id);
        const current = commentsByLog.get(logId) || [];
        current.push(toPublicComment(comment));
        commentsByLog.set(logId, current);
      });

      return res.json({
        logs: result.rows.map((log) => toPublicLog({
          ...log,
          comments: commentsByLog.get(String(log.id)) || [],
        })),
        canViewAll: viewAll,
        summary: summaryResult.rows[0],
        pagination: {
          hasMore,
          nextCursor: hasMore ? pageDates[pageDates.length - 1] : null,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const { values, errors } = validateLog(req.body);

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ message: "Working log is not valid.", errors });
      }

      const result = await pool.query(
        `INSERT INTO working_logs (user_id, log_date, activity, description, importance)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, log_date, activity, description, importance, is_read, is_closed, admin_comment, reviewed_by, reviewed_at, closed_by, closed_at, created_at`,
        [req.auth.sub, values.logDate, values.activity, values.description, values.importance],
      );

      return res.status(201).json({
        message: "Working log submitted successfully.",
        log: toPublicLog({ ...result.rows[0], username: req.auth.username }),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.put("/:logId", async (req, res, next) => {
    try {
      const { values, errors } = validateLog(req.body);

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ message: "Working log is not valid.", errors });
      }

      const result = await pool.query(
        `UPDATE working_logs
         SET log_date = $1,
             activity = $2,
             description = $3,
             importance = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND user_id = $6 AND is_read = FALSE
         RETURNING id, user_id, log_date, activity, description, importance,
                   is_read, is_closed, admin_comment, reviewed_by, reviewed_at, closed_by, closed_at, created_at`,
        [values.logDate, values.activity, values.description, values.importance, req.params.logId, req.auth.sub],
      );

      if (result.rows[0]) {
        return res.json({
          message: "Working log updated successfully.",
          log: toPublicLog({ ...result.rows[0], username: req.auth.username }),
        });
      }

      const existing = await pool.query(
        `SELECT id, is_read
         FROM working_logs
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
        [req.params.logId, req.auth.sub],
      );

      if (!existing.rows[0]) {
        return res.status(404).json({ message: "Working log not found." });
      }

      return res.status(409).json({ message: "Working log has already been read and can no longer be edited." });
    } catch (error) {
      return next(error);
    }
  });

  router.delete("/:logId", async (req, res, next) => {
    try {
      const result = await pool.query(
        `DELETE FROM working_logs
         WHERE id = $1 AND user_id = $2 AND is_read = FALSE
         RETURNING id`,
        [req.params.logId, req.auth.sub],
      );

      if (result.rows[0]) {
        return res.json({ message: "Working log deleted successfully." });
      }

      const existing = await pool.query(
        `SELECT id
         FROM working_logs
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
        [req.params.logId, req.auth.sub],
      );

      if (!existing.rows[0]) {
        return res.status(404).json({ message: "Working log not found." });
      }

      return res.status(409).json({ message: "Working log has already been read and can no longer be deleted." });
    } catch (error) {
      return next(error);
    }
  });

  router.patch("/:logId/review", requireLogAdmin, async (req, res, next) => {
    try {
      const adminComment = normalizeText(req.body.adminComment);
      const isRead = Boolean(req.body.isRead) || Boolean(adminComment);

      if (adminComment.length > 1000) {
        return res.status(400).json({
          message: "Review is not valid.",
          errors: { adminComment: "Comment maximum 1000 characters." },
        });
      }

      const result = await pool.query(
        `UPDATE working_logs wl
         SET is_read = $1,
             admin_comment = $2,
             reviewed_by = $3,
             reviewed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE wl.id = $4
         RETURNING wl.id, wl.user_id, wl.log_date, wl.activity, wl.description, wl.importance,
                   wl.is_read, wl.is_closed, wl.admin_comment, wl.reviewed_by, wl.reviewed_at,
                   wl.closed_by, wl.closed_at, wl.created_at`,
        [isRead, adminComment || null, req.auth.sub, req.params.logId],
      );

      if (!result.rows[0]) {
        return res.status(404).json({ message: "Working log not found." });
      }

      return res.json({
        message: "Working log review updated.",
        log: toPublicLog({ ...result.rows[0], reviewed_by_username: req.auth.username }),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:logId/comments", async (req, res, next) => {
    try {
      const comment = normalizeText(req.body.comment);

      if (!comment || comment.length > 1000) {
        return res.status(400).json({
          message: "Comment is not valid.",
          errors: { comment: !comment ? "Comment is required." : "Comment maximum 1000 characters." },
        });
      }

      const viewAll = canViewAllLogs(req.auth.role);
      const logResult = await pool.query(
        `SELECT id, user_id, is_closed
         FROM working_logs
         WHERE id = $1 AND ($2::boolean = TRUE OR user_id = $3)
         LIMIT 1`,
        [req.params.logId, viewAll, req.auth.sub],
      );

      if (!logResult.rows[0]) {
        return res.status(404).json({ message: "Working log not found." });
      }
      if (logResult.rows[0].is_closed) {
        return res.status(409).json({ message: "Case is already closed." });
      }

      const result = await pool.query(
        `WITH inserted AS (
           INSERT INTO working_log_comments (log_id, user_id, comment)
           VALUES ($1, $2, $3)
           RETURNING id, log_id, user_id, comment, created_at
         ),
         updated AS (
           UPDATE working_logs
           SET is_read = CASE WHEN $4::boolean = TRUE THEN TRUE ELSE is_read END,
               reviewed_by = CASE WHEN $4::boolean = TRUE THEN $2 ELSE reviewed_by END,
               reviewed_at = CASE WHEN $4::boolean = TRUE THEN CURRENT_TIMESTAMP ELSE reviewed_at END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
         )
         SELECT inserted.*, users.username
         FROM inserted
         LEFT JOIN users ON users.id = inserted.user_id`,
        [req.params.logId, req.auth.sub, comment, viewAll],
      );

      return res.status(201).json({
        message: "Comment added successfully.",
        comment: toPublicComment(result.rows[0]),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.patch("/:logId/close", requireLogAdmin, async (req, res, next) => {
    try {
      const result = await pool.query(
        `UPDATE working_logs
         SET is_closed = TRUE,
             is_read = TRUE,
             closed_by = $1,
             closed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING id, user_id, log_date, activity, description, importance,
                   is_read, is_closed, admin_comment, reviewed_by, reviewed_at,
                   closed_by, closed_at, created_at`,
        [req.auth.sub, req.params.logId],
      );

      if (!result.rows[0]) {
        return res.status(404).json({ message: "Working log not found." });
      }

      return res.json({
        message: "Case closed.",
        log: toPublicLog({
          ...result.rows[0],
          closed_by_username: req.auth.username,
        }),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/health", async (req, res, next) => {
    try {
      await pool.query("SELECT 1");
      return res.json({
        service: "working_logs",
        status: "healthy",
        database: "connected",
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
