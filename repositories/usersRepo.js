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
    role: row.role ?? "user",
    is_admin: row.is_admin === true,
    created_at: row.created_at ?? null,
  };
}

async function findByEmail(email) {
  const rows = await pgDb.query(
    `
      SELECT
        id,
        name,
        email,
        cpf,
        password_hash,
        role,
        tower,
        apartment,
        is_admin,
        created_at
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
        id,
        name,
        email,
        cpf,
        role,
        tower,
        apartment,
        is_admin,
        created_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return mapUser(rows[0]);
}

async function create({ name, email, password_hash, is_admin, cpf, role, tower, apartment }) {
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
          apartment
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING
          id,
          name,
          email,
          cpf,
          role,
          tower,
          apartment,
          is_admin,
          created_at
      `,
      [
        name,
        email,
        password_hash,
        is_admin === true,
        cpf ?? null,
        role ?? "user",
        tower ?? null,
        apartment ?? null,
      ]
    );

    return mapUser(rows[0]);
  } catch (error) {
    if (
      error &&
      error.code === "23505" &&
      (error.constraint === "users_email_key" || String(error.detail || "").includes("(email)"))
    ) {
      const duplicateError = new Error("Email já cadastrado");
      duplicateError.code = "DUPLICATE_EMAIL";
      throw duplicateError;
    }
    throw error;
  }
}

async function listBasic() {
  const rows = await pgDb.query(
    `
      SELECT id, name, email, is_admin
      FROM users
      ORDER BY name ASC
    `
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    is_admin: row.is_admin === true,
  }));
}

module.exports = {
  findByEmail,
  findById,
  create,
  listBasic,
};
