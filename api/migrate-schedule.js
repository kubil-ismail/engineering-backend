import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;
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

try {
  const migrationFiles = ["schedule_projects.sql", "schedule_design.sql", "schedule_machine.sql", "working_logs.sql"];

  for (const migrationFile of migrationFiles) {
    const migrationPath = fileURLToPath(new URL(`./sql/${migrationFile}`, import.meta.url));
    const migration = await readFile(migrationPath, "utf8");
    await pool.query(migration);
    console.log(`${migrationFile} completed.`);
  }
} catch (error) {
  console.error("Schedule migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
