const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL não definido. Configure no .env antes de iniciar o servidor.");
}

const pool = new Pool({ connectionString });

async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

async function withTransaction(fn) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tx = {
      query: async (text, params = []) => {
        const result = await client.query(text, params);
        return result.rows;
      },
    };

    const value = await fn(tx);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function healthcheck() {
  await pool.query("SELECT 1");
  return true;
}

module.exports = {
  query,
  withTransaction,
  healthcheck,
};
