const pgDb = require("../db/pg");

function mapClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tower: row.tower ?? null,
    apartment: row.apartment ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listAll() {
  const rows = await pgDb.query(
    `
      SELECT
        id,
        name,
        tower,
        apartment,
        created_at,
        updated_at
      FROM charging_clients
      ORDER BY name ASC, tower ASC, apartment ASC, id ASC
    `
  );

  return rows.map(mapClient);
}

async function getById(clientId) {
  const rows = await pgDb.query(
    `
      SELECT
        id,
        name,
        tower,
        apartment,
        created_at,
        updated_at
      FROM charging_clients
      WHERE id = $1
      LIMIT 1
    `,
    [clientId]
  );

  return mapClient(rows[0]);
}

async function create(payload) {
  const rows = await pgDb.query(
    `
      INSERT INTO charging_clients (
        name,
        tower,
        apartment
      )
      VALUES ($1, $2, $3)
      RETURNING
        id,
        name,
        tower,
        apartment,
        created_at,
        updated_at
    `,
    [
      payload.name,
      payload.tower ?? null,
      payload.apartment ?? null,
    ]
  );

  return mapClient(rows[0]);
}

module.exports = {
  listAll,
  getById,
  create,
};
