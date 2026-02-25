const pgDb = require("../db/pg");

function mapStation(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    location_label: row.location_label,
    tuya_device_id: row.tuya_device_id,
    max_current_a: row.max_current_a,
    is_active: row.is_active === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listActive() {
  const rows = await pgDb.query(
    `
      SELECT
        id,
        name,
        location_label,
        tuya_device_id,
        max_current_a,
        is_active,
        created_at,
        updated_at
      FROM stations
      WHERE is_active = TRUE
      ORDER BY name ASC, id ASC
    `
  );

  return rows.map(mapStation);
}

async function listAll() {
  const rows = await pgDb.query(
    `
      SELECT
        id,
        name,
        location_label,
        tuya_device_id,
        max_current_a,
        is_active,
        created_at,
        updated_at
      FROM stations
      ORDER BY name ASC, id ASC
    `
  );

  return rows.map(mapStation);
}

async function getById(stationId) {
  const rows = await pgDb.query(
    `
      SELECT
        id,
        name,
        location_label,
        tuya_device_id,
        max_current_a,
        is_active,
        created_at,
        updated_at
      FROM stations
      WHERE id = $1
      LIMIT 1
    `,
    [stationId]
  );

  return mapStation(rows[0]);
}

async function create(payload) {
  const {
    name,
    location_label,
    tuya_device_id,
    max_current_a,
    is_active,
  } = payload;

  try {
    const rows = await pgDb.query(
      `
        INSERT INTO stations (
          name,
          location_label,
          tuya_device_id,
          max_current_a,
          is_active
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
          id,
          name,
          location_label,
          tuya_device_id,
          max_current_a,
          is_active,
          created_at,
          updated_at
      `,
      [
        name,
        location_label ?? null,
        tuya_device_id,
        max_current_a ?? 32,
        is_active !== false,
      ]
    );

    return mapStation(rows[0]);
  } catch (error) {
    if (
      error &&
      error.code === "23505" &&
      (error.constraint === "stations_tuya_device_id_key" || String(error.detail || "").includes("(tuya_device_id)"))
    ) {
      const duplicateError = new Error("tuya_device_id já cadastrado");
      duplicateError.code = "DUPLICATE_TUYA_DEVICE";
      throw duplicateError;
    }
    throw error;
  }
}

async function update(stationId, payload) {
  const updates = [];
  const values = [];
  let idx = 1;

  const setField = (field, value) => {
    updates.push(`${field} = $${idx}`);
    values.push(value);
    idx += 1;
  };

  const allowedFields = [
    "name",
    "location_label",
    "tuya_device_id",
    "max_current_a",
    "is_active",
  ];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      setField(field, payload[field]);
    }
  }

  if (updates.length === 0) {
    const rows = await pgDb.query(
      `
        SELECT
          id,
          name,
          location_label,
          tuya_device_id,
          max_current_a,
          is_active,
          created_at,
          updated_at
        FROM stations
        WHERE id = $1
        LIMIT 1
      `,
      [stationId]
    );
    return mapStation(rows[0]);
  }

  updates.push("updated_at = NOW()");

  const whereParam = idx;
  const sql = `
    UPDATE stations
    SET ${updates.join(", ")}
    WHERE id = $${whereParam}
    RETURNING
      id,
      name,
      location_label,
      tuya_device_id,
      max_current_a,
      is_active,
      created_at,
      updated_at
  `;

  try {
    const rows = await pgDb.query(sql, [...values, stationId]);
    return mapStation(rows[0]);
  } catch (error) {
    if (
      error &&
      error.code === "23505" &&
      (error.constraint === "stations_tuya_device_id_key" || String(error.detail || "").includes("(tuya_device_id)"))
    ) {
      const duplicateError = new Error("tuya_device_id já cadastrado");
      duplicateError.code = "DUPLICATE_TUYA_DEVICE";
      throw duplicateError;
    }
    throw error;
  }
}

async function setActive(stationId, isActive) {
  return update(stationId, { is_active: isActive === true });
}

module.exports = {
  listActive,
  listAll,
  getById,
  create,
  update,
  setActive,
};
