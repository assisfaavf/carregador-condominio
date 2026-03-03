const pgDb = require("../db/pg");

function mapSetting(row) {
  if (!row) return null;
  return {
    key: row.key,
    value: row.value,
    updated_at: row.updated_at ?? null,
  };
}

async function getAll() {
  const rows = await pgDb.query(
    `
      SELECT key, value, updated_at
      FROM system_settings
      ORDER BY key ASC
    `
  );

  return rows.map(mapSetting);
}

async function getByKey(key) {
  const rows = await pgDb.query(
    `
      SELECT key, value, updated_at
      FROM system_settings
      WHERE key = $1
      LIMIT 1
    `,
    [key]
  );

  return mapSetting(rows[0]);
}

async function setValue(key, value) {
  const rows = await pgDb.query(
    `
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      RETURNING key, value, updated_at
    `,
    [key, String(value)]
  );

  return mapSetting(rows[0]);
}

async function setMany(entries) {
  const results = [];
  for (const [key, value] of Object.entries(entries)) {
    results.push(await setValue(key, value));
  }
  return results;
}

module.exports = {
  getAll,
  getByKey,
  setMany,
  setValue,
};
