import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import pg from "pg";
import createScheduleRouter from "./schedule.js";
import createMachineReportRouter from "./machine_report.js";
import createWorkingLogsRouter from "./working_logs.js";

dotenv.config();

const app = express();
const PORT = process.env.API_PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d";
const SALT_ROUNDS = 12;
const { Pool, types } = pg;

types.setTypeParser(1082, (value) => value);

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
      },
);

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || true,
}));
app.use(express.json());

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    position: user.position,
    department: user.department,
    role: user.role,
    isActive: user.is_active,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

function signToken(user) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }

  return jwt.sign(
    {
      sub: String(user.id),
      username: user.username,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function normalizeOptionalText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeRole(role) {
  return String(role || "user").trim().toLowerCase();
}

function validateUserProfileFields({ position, department, role }) {
  const errors = {};
  const allowedRoles = new Set(["user", "admin", "super_admin"]);
  const normalizedRole = normalizeRole(role);
  const normalizedPosition = normalizeOptionalText(position);
  const normalizedDepartment = normalizeOptionalText(department);

  if (!allowedRoles.has(normalizedRole)) {
    errors.role = "Role is not valid.";
  }

  if (normalizedPosition && normalizedPosition.length > 100) {
    errors.position = "Position maximum 100 characters.";
  }

  if (normalizedDepartment && normalizedDepartment.length > 100) {
    errors.department = "Department maximum 100 characters.";
  }

  return {
    values: {
      position: normalizedPosition,
      department: normalizedDepartment,
      role: normalizedRole,
    },
    errors,
  };
}

function validateRegisterBody({ username, email, password }) {
  const errors = {};

  if (!normalizeUsername(username)) {
    errors.username = "username must be filled.";
  } else if (normalizeUsername(username).length > 50) {
    errors.username = "Username maximum 50 characters.";
  }

  if (!normalizeEmail(email)) {
    errors.email = "Email must be filled.";
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) {
    errors.email = "Invalid email format.";
  }

  if (!password) {
    errors.password = "Password must be filled.";
  } else if (String(password).length < 8) {
    errors.password = "Password minimum 8 characters.";
  }

  return errors;
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Token not found." });
  }

  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ message: "Token is not valid or has expired." });
  }
}

async function requireSuperAdmin(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT id, role
       FROM users
       WHERE id = $1 AND is_active = TRUE
       LIMIT 1`,
      [req.auth.sub],
    );
    const user = result.rows[0];

    if (!user || user.role !== "super_admin") {
      return res.status(403).json({ message: "Only super admins can manage users." });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

async function requireAdminViewer(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT id, role
       FROM users
       WHERE id = $1 AND is_active = TRUE
       LIMIT 1`,
      [req.auth.sub],
    );
    const user = result.rows[0];

    if (!user || !["admin", "super_admin"].includes(user.role)) {
      return res.status(403).json({ message: "Only admins can view users." });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    message: "API server is running",
  });
});

app.use("/api/schedule", authenticateToken, createScheduleRouter({ pool }));
app.use("/api/machine_report", authenticateToken, createMachineReportRouter({ pool }));
app.use("/api/working_logs", authenticateToken, createWorkingLogsRouter({ pool }));

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    const errors = validateRegisterBody({ username, email, password });

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ message: "Data registrasi tidak valid.", errors });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, position, department, role, is_active, created_at, updated_at`,
      [normalizeUsername(username), normalizeEmail(email), passwordHash],
    );

    const user = result.rows[0];

    return res.status(201).json({
      message: "Registrasi berhasil.",
      token: signToken(user),
      user: toPublicUser(user),
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "Username atau email sudah terdaftar." });
    }

    return next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || req.body.email || req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!identifier || !password) {
      return res.status(400).json({ message: "Email/username and password are required." });
    }

    const result = await pool.query(
      `SELECT id, username, email, password_hash, position, role, is_active, created_at, updated_at
       FROM users
       WHERE lower(email) = lower($1) OR username = $1
       LIMIT 1`,
      [identifier],
    );
    const user = result.rows[0];

    if (!user || !user.is_active) {
      return res.status(401).json({ message: "Email/username or password is incorrect." });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({ message: "Email/username or password is incorrect." });
    }

    return res.json({
      message: "Login successful.",
      token: signToken(user),
      user: toPublicUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/auth/me", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, position, department, role, is_active, created_at, updated_at
       FROM users
       WHERE id = $1 AND is_active = TRUE
       LIMIT 1`,
      [req.auth.sub],
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: "User is not active or not found." });
    }

    return res.json({ user: toPublicUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/auth/password", authenticateToken, async (req, res, next) => {
  try {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current password and new password are required." });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters." });
    }

    const result = await pool.query(
      `SELECT id, password_hash
       FROM users
       WHERE id = $1 AND is_active = TRUE
       LIMIT 1`,
      [req.auth.sub],
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    const updateResult = await pool.query(
      `UPDATE users
       SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING updated_at`,
      [passwordHash, req.auth.sub],
    );

    return res.json({
      message: "Password updated successfully.",
      updatedAt: updateResult.rows[0].updated_at,
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/users", authenticateToken, requireAdminViewer, async (req, res, next) => {
  try {
    const [usersResult, totalResult] = await Promise.all([
      pool.query(
        `SELECT id, username, email, position, department, role, is_active, created_at, updated_at
         FROM users
         ORDER BY created_at DESC, id DESC
         LIMIT 100`,
      ),
      pool.query("SELECT COUNT(*)::int AS total FROM users"),
    ]);

    return res.json({
      users: usersResult.rows.map(toPublicUser),
      total: totalResult.rows[0].total,
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/users", authenticateToken, requireSuperAdmin, async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    const errors = validateRegisterBody({ username, email, password });
    const { values: profileValues, errors: profileErrors } = validateUserProfileFields(req.body);
    Object.assign(errors, profileErrors);


    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ message: "User data is not valid.", errors });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, position, department, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, email, position, department, role, is_active, created_at, updated_at`,
      [
        normalizeUsername(username),
        normalizeEmail(email),
        passwordHash,
        profileValues.position,
        profileValues.department,
        profileValues.role,
      ],
    );

    return res.status(201).json({
      message: "User created successfully.",
      user: toPublicUser(result.rows[0]),
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "Username or email is already registered." });
    }

    return next(error);
  }
});

app.patch("/api/users/:userId", authenticateToken, requireSuperAdmin, async (req, res, next) => {
  try {
    const { values, errors } = validateUserProfileFields(req.body);

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ message: "User data is not valid.", errors });
    }

    const result = await pool.query(
      `UPDATE users
       SET position = $1,
           department = $2,
           role = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING id, username, email, position, department, role, is_active, created_at, updated_at`,
      [values.position, values.department, values.role, req.params.userId],
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: "User not found." });
    }

    return res.json({
      message: "User updated successfully.",
      user: toPublicUser(result.rows[0]),
    });
  } catch (error) {
    return next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({ message: "An error occurred on the server." });
});

app.listen(PORT, () => {
  console.log(`API running at http://localhost:${PORT}`);
});
