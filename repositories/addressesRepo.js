const pgDb = require("../db/pg");

function mapAddress(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    label: row.label,
    street: row.street,
    number: row.number,
    complement: row.complement,
    neighborhood: row.neighborhood,
    city: row.city,
    state: row.state,
    zip: row.zip,
    is_default: row.is_default === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listByUser(userId) {
  const rows = await pgDb.query(
    `
      SELECT
        id,
        user_id,
        label,
        street,
        number,
        complement,
        neighborhood,
        city,
        state,
        zip,
        is_default,
        created_at,
        updated_at
      FROM addresses
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at DESC
    `,
    [userId]
  );

  return rows.map(mapAddress);
}

async function getByIdForUser(addressId, userId) {
  const rows = await pgDb.query(
    `
      SELECT
        id,
        user_id,
        label,
        street,
        number,
        complement,
        neighborhood,
        city,
        state,
        zip,
        is_default,
        created_at,
        updated_at
      FROM addresses
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
    [addressId, userId]
  );

  return mapAddress(rows[0]);
}

async function getById(addressId) {
  const rows = await pgDb.query(
    `
      SELECT
        id,
        user_id,
        label,
        street,
        number,
        complement,
        neighborhood,
        city,
        state,
        zip,
        is_default,
        created_at,
        updated_at
      FROM addresses
      WHERE id = $1
      LIMIT 1
    `,
    [addressId]
  );

  return mapAddress(rows[0]);
}

async function setDefault(addressId, userId) {
  return pgDb.withTransaction(async (tx) => {
    const targetRows = await tx.query(
      `
        SELECT id
        FROM addresses
        WHERE id = $1 AND user_id = $2
        LIMIT 1
      `,
      [addressId, userId]
    );

    if (!targetRows[0]) return null;

    await tx.query(
      `
        UPDATE addresses
        SET is_default = FALSE, updated_at = NOW()
        WHERE user_id = $1
      `,
      [userId]
    );

    const updatedRows = await tx.query(
      `
        UPDATE addresses
        SET is_default = TRUE, updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING
          id,
          user_id,
          label,
          street,
          number,
          complement,
          neighborhood,
          city,
          state,
          zip,
          is_default,
          created_at,
          updated_at
      `,
      [addressId, userId]
    );

    return mapAddress(updatedRows[0]);
  });
}

async function createForUser(userId, payload) {
  const {
    label,
    street,
    number,
    complement,
    neighborhood,
    city,
    state,
    zip,
    is_default,
  } = payload;

  return pgDb.withTransaction(async (tx) => {
    const countRows = await tx.query(
      `
        SELECT COUNT(*)::int AS total
        FROM addresses
        WHERE user_id = $1
      `,
      [userId]
    );

    const hasAnyAddress = Number(countRows[0]?.total || 0) > 0;
    const shouldBeDefault = is_default === true || !hasAnyAddress;

    if (shouldBeDefault) {
      await tx.query(
        `
          UPDATE addresses
          SET is_default = FALSE, updated_at = NOW()
          WHERE user_id = $1
        `,
        [userId]
      );
    }

    const insertedRows = await tx.query(
      `
        INSERT INTO addresses (
          user_id,
          label,
          street,
          number,
          complement,
          neighborhood,
          city,
          state,
          zip,
          is_default
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING
          id,
          user_id,
          label,
          street,
          number,
          complement,
          neighborhood,
          city,
          state,
          zip,
          is_default,
          created_at,
          updated_at
      `,
      [
        userId,
        label,
        street ?? null,
        number ?? null,
        complement ?? null,
        neighborhood ?? null,
        city ?? null,
        state ?? null,
        zip ?? null,
        shouldBeDefault,
      ]
    );

    return mapAddress(insertedRows[0]);
  });
}

async function updateForUser(addressId, userId, payload) {
  const updates = [];
  const values = [];
  let idx = 1;

  const setField = (field, value) => {
    updates.push(`${field} = $${idx}`);
    values.push(value);
    idx += 1;
  };

  const allowedFields = [
    "label",
    "street",
    "number",
    "complement",
    "neighborhood",
    "city",
    "state",
    "zip",
  ];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      const rawValue = payload[field];
      setField(field, rawValue == null ? null : String(rawValue).trim());
    }
  }

  if (
    updates.length === 0 &&
    !Object.prototype.hasOwnProperty.call(payload, "is_default")
  ) {
    return getByIdForUser(addressId, userId);
  }

  return pgDb.withTransaction(async (tx) => {
    const targetRows = await tx.query(
      `
        SELECT id
        FROM addresses
        WHERE id = $1 AND user_id = $2
        LIMIT 1
      `,
      [addressId, userId]
    );

    if (!targetRows[0]) return null;

    if (payload.is_default === true) {
      await tx.query(
        `
          UPDATE addresses
          SET is_default = FALSE, updated_at = NOW()
          WHERE user_id = $1
        `,
        [userId]
      );
      setField("is_default", true);
    } else if (payload.is_default === false) {
      setField("is_default", false);
    }

    updates.push("updated_at = NOW()");

    const whereIdParam = idx;
    const whereUserParam = idx + 1;
    const sql = `
      UPDATE addresses
      SET ${updates.join(", ")}
      WHERE id = $${whereIdParam} AND user_id = $${whereUserParam}
      RETURNING
        id,
        user_id,
        label,
        street,
        number,
        complement,
        neighborhood,
        city,
        state,
        zip,
        is_default,
        created_at,
        updated_at
    `;

    const updatedRows = await tx.query(sql, [...values, addressId, userId]);
    return mapAddress(updatedRows[0]);
  });
}

async function deleteForUser(addressId, userId) {
  return pgDb.withTransaction(async (tx) => {
    const deletedRows = await tx.query(
      `
        DELETE FROM addresses
        WHERE id = $1 AND user_id = $2
        RETURNING id, user_id, is_default
      `,
      [addressId, userId]
    );

    const deleted = deletedRows[0];
    if (!deleted) return null;

    if (deleted.is_default === true) {
      const nextRows = await tx.query(
        `
          SELECT id
          FROM addresses
          WHERE user_id = $1
          ORDER BY created_at ASC
          LIMIT 1
        `,
        [userId]
      );

      if (nextRows[0]) {
        await tx.query(
          `
            UPDATE addresses
            SET is_default = TRUE, updated_at = NOW()
            WHERE id = $1 AND user_id = $2
          `,
          [nextRows[0].id, userId]
        );
      }
    }

    return true;
  });
}

async function updateById(addressId, payload) {
  const existing = await getById(addressId);
  if (!existing) return null;
  return updateForUser(addressId, existing.user_id, payload);
}

async function deleteById(addressId) {
  const existing = await getById(addressId);
  if (!existing) return null;
  return deleteForUser(addressId, existing.user_id);
}

module.exports = {
  listByUser,
  getById,
  getByIdForUser,
  createForUser,
  updateForUser,
  updateById,
  deleteForUser,
  deleteById,
  setDefault,
};
