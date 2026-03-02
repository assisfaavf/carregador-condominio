const pgDb = require("../db/pg");

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    cpf: row.cpf ?? null,
    tower: row.tower ?? null,
    apartment: row.apartment ?? null,
    role: row.role ?? "morador",
    is_admin: row.is_admin === true,
    approval_status: row.approval_status ?? "approved",
    approved_at: row.approved_at ?? null,
    last_login_at: row.last_login_at ?? null,
    created_at: row.created_at ?? null,
  };
}

function getUserSelectFields(includePasswordHash = false) {
  const fields = [
    "id",
    "name",
    "email",
    "cpf",
    "role",
    "tower",
    "apartment",
    "is_admin",
    "approval_status",
    "approved_at",
    "last_login_at",
    "created_at",
  ];

  if (includePasswordHash) {
    fields.splice(4, 0, "password_hash");
  }

  return fields.join(",\n        ");
}

async function findByEmail(email) {
  const rows = await pgDb.query(
    `
      SELECT
        ${getUserSelectFields(true)}
      FROM users
      WHERE email = $1
      LIMIT 1
    `,
    [email]
  );

  if (!rows[0]) return null;
  return {
    ...mapUser(rows[0]),
    password_hash: rows[0].password_hash,
  };
}

async function findById(id) {
  const rows = await pgDb.query(
    `
      SELECT
        ${getUserSelectFields(false)}
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return mapUser(rows[0]);
}

async function create({
  name,
  email,
  password_hash,
  is_admin,
  cpf,
  role,
  tower,
  apartment,
  approval_status,
  approved_at,
}) {
  try {
    const rows = await pgDb.query(
      `
        INSERT INTO users (
          name,
          email,
          password_hash,
          is_admin,
          cpf,
          role,
          tower,
          apartment,
          approval_status,
          approved_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING
          ${getUserSelectFields(false)}
      `,
      [
        name,
        email,
        password_hash,
        is_admin === true,
        cpf ?? null,
        role ?? "morador",
        tower ?? null,
        apartment ?? null,
        approval_status ?? "approved",
        approved_at ?? null,
      ]
    );

    return mapUser(rows[0]);
  } catch (error) {
    if (
      error &&
      error.code === "23505" &&
      (error.constraint === "users_email_key" || String(error.detail || "").includes("(email)"))
    ) {
      const duplicateError = new Error("Email ja cadastrado");
      duplicateError.code = "DUPLICATE_EMAIL";
      throw duplicateError;
    }
    throw error;
  }
}

async function setLastLoginAt(id) {
  const rows = await pgDb.query(
    `
      UPDATE users
      SET last_login_at = NOW()
      WHERE id = $1
      RETURNING
        ${getUserSelectFields(false)}
    `,
    [id]
  );

  return mapUser(rows[0]);
}

async function listBasic() {
  const rows = await pgDb.query(
    `
      SELECT id, name, email, is_admin, role, approval_status
      FROM users
      ORDER BY name ASC
    `
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    is_admin: row.is_admin === true,
    role: row.role ?? "morador",
    approval_status: row.approval_status ?? "approved",
  }));
}

async function listAdminUsers({ status, role, q, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const values = [];

  if (status) {
    values.push(status);
    conditions.push(`approval_status = $${values.length}`);
  }

  if (role) {
    values.push(role);
    conditions.push(`role = $${values.length}`);
  }

  if (q) {
    values.push(`%${q}%`);
    conditions.push(`(name ILIKE $${values.length} OR email ILIKE $${values.length})`);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  values.push(limit);
  const limitParam = values.length;
  values.push(offset);
  const offsetParam = values.length;

  const rows = await pgDb.query(
    `
      SELECT
        id,
        name,
        email,
        role,
        is_admin,
        approval_status,
        created_at,
        last_login_at,
        COUNT(*) OVER()::int AS total_count
      FROM users
      ${whereSql}
      ORDER BY
        CASE WHEN approval_status = 'pending' THEN 0 ELSE 1 END,
        created_at DESC,
        id DESC
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `,
    values
  );

  return {
    users: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role ?? "morador",
      is_admin: row.is_admin === true,
      approval_status: row.approval_status ?? "approved",
      created_at: row.created_at ?? null,
      last_login_at: row.last_login_at ?? null,
    })),
    total: Number(rows[0]?.total_count || 0),
  };
}

async function updateAdminUser(id, payload) {
  const updates = [];
  const values = [];

  const setField = (sqlExpression, value) => {
    values.push(value);
    updates.push(`${sqlExpression} = $${values.length}`);
  };

  if (Object.prototype.hasOwnProperty.call(payload, "name")) {
    setField("name", payload.name);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "role")) {
    setField("role", payload.role);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "is_admin")) {
    setField("is_admin", payload.is_admin === true);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "approval_status")) {
    setField("approval_status", payload.approval_status);
    if (payload.approval_status === "approved") {
      updates.push("approved_at = COALESCE(approved_at, NOW())");
    } else {
      updates.push("approved_at = NULL");
    }
  }

  if (updates.length === 0) {
    return findById(id);
  }

  values.push(id);
  const rows = await pgDb.query(
    `
      UPDATE users
      SET ${updates.join(", ")}
      WHERE id = $${values.length}
      RETURNING
        ${getUserSelectFields(false)}
    `,
    values
  );

  return mapUser(rows[0]);
}

module.exports = {
  create,
  findByEmail,
  findById,
  listAdminUsers,
  listBasic,
  setLastLoginAt,
  updateAdminUser,
};
