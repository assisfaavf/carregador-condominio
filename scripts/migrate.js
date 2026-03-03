const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const config = require("../config");

const databaseUrl = config.dbUrl;
if (!databaseUrl) {
  throw new Error("DATABASE_URL não definido. Configure no .env antes de rodar as migrações.");
}

const pool = new Pool({ connectionString: databaseUrl });

async function ensureSchemaMigrations(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function getMigrationFiles() {
  const migrationsDir = path.resolve(__dirname, "..", "migrations");
  if (!fs.existsSync(migrationsDir)) return [];

  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

async function getAppliedMigrations(client) {
  const result = await client.query("SELECT filename FROM schema_migrations");
  return new Set(result.rows.map((row) => row.filename));
}

async function applyMigration(client, filename) {
  const filePath = path.resolve(__dirname, "..", "migrations", filename);
  const sql = fs.readFileSync(filePath, "utf8");

  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      [filename]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function run() {
  const client = await pool.connect();
  try {
    await ensureSchemaMigrations(client);

    const files = getMigrationFiles();
    const applied = await getAppliedMigrations(client);

    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`- skip ${filename}`);
        continue;
      }

      console.log(`- apply ${filename}`);
      await applyMigration(client, filename);
    }

    console.log("Migrações finalizadas.");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Falha ao executar migrações:", error.message);
  process.exit(1);
});
