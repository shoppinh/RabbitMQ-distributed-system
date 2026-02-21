const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const { parseNumber } = require("../shared/utils/parseNumber");

function getMigrationFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    console.log(`[migrate] migrations directory does not exist: ${dirPath}`);
    return [];
  }
  return fs
    .readdirSync(dirPath)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

async function main() {
  // Support MIGRATIONS_DIR env var for multi-service migrations
  const defaultMigrationsDir = path.join(__dirname, "..", "database", "migrations");
  const migrationsDir = process.env.MIGRATIONS_DIR || defaultMigrationsDir;

  const pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: parseNumber(process.env.DB_PORT, 5432),
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "password",
    database: process.env.DB_NAME || "orders_db",
  });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationFiles = getMigrationFiles(migrationsDir);

    if (migrationFiles.length === 0) {
      console.log(`[migrate] no migrations found in ${migrationsDir}`);
    }

    for (const file of migrationFiles) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [file],
      );

      if (alreadyApplied.rowCount > 0) {
        console.log(`[migrate] skip ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      console.log(`[migrate] apply ${file}`);
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [file],
      );
    }

    await client.query("COMMIT");
    console.log("[migrate] done");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[migrate] failed", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error("[migrate] fatal", error);
    process.exit(1);
  }
})();
