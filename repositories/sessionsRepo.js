const pgDb = require("../db/pg");

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(",", ".");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function mapSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    address_id: row.address_id,
    station_id: row.station_id,
    status: row.status,
    start_time: row.start_time ?? null,
    end_time: row.end_time ?? null,
    duration_seconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    start_energy_total: toFiniteNumber(row.start_energy_total),
    end_energy_total: toFiniteNumber(row.end_energy_total),
    energy_once: toFiniteNumber(row.energy_once),
    energy_kwh: toFiniteNumber(row.energy_kwh),
    energy_source: row.energy_source ?? null,
    origin: row.origin ?? "program",
    authorization_method: row.authorization_method ?? "program",
    detected_at: row.detected_at ?? null,
    needs_review: row.needs_review === true,
    notes: row.notes ?? null,
    tariff_per_kwh: toFiniteNumber(row.tariff_per_kwh),
    price_calculated: toFiniteNumber(row.price_calculated),
    price_override: toFiniteNumber(row.price_override),
    payment_status: row.payment_status ?? null,
    paid_at: row.paid_at ?? null,
  };
}

function mapSessionWithRelations(row) {
  if (!row) return null;
  return {
    ...mapSessionRow(row),
    user: row.u_id == null ? null : {
      id: row.u_id,
      name: row.u_name,
      email: row.u_email,
      cpf: row.u_cpf ?? null,
      tower: row.u_tower ?? null,
      apartment: row.u_apartment ?? null,
      is_admin: row.u_is_admin === true,
    },
    station: row.st_id == null ? null : {
      id: row.st_id,
      name: row.st_name,
      location_label: row.st_location_label ?? null,
      tuya_device_id: row.st_tuya_device_id,
      max_current_a: row.st_max_current_a,
      is_active: row.st_is_active === true,
    },
    address: row.ad_id == null ? null : {
      id: row.ad_id,
      label: row.ad_label,
      street: row.ad_street ?? null,
      number: row.ad_number ?? null,
      neighborhood: row.ad_neighborhood ?? null,
      city: row.ad_city ?? null,
      state: row.ad_state ?? null,
      zip: row.ad_zip ?? null,
      is_default: row.ad_is_default === true,
    },
  };
}

function getExecutor(tx) {
  return tx && typeof tx.query === "function" ? tx : pgDb;
}

function normalizeLimit(value, fallback = 50, max = 500) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeOffset(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

async function getRunningByStation(stationId, tx) {
  const db = getExecutor(tx);
  const rows = await db.query(
    `
      SELECT
        id,
        user_id,
        address_id,
        station_id,
        status,
        start_time,
        end_time,
        duration_seconds,
        start_energy_total,
        end_energy_total,
        energy_once,
        energy_kwh,
        energy_source,
        origin,
        authorization_method,
        detected_at,
        needs_review,
        notes,
        tariff_per_kwh,
        price_calculated,
        price_override,
        payment_status,
        paid_at
      FROM sessions
      WHERE station_id = $1 AND status = 'running'
      ORDER BY start_time DESC, id DESC
      LIMIT 1
    `,
    [stationId]
  );

  return mapSessionRow(rows[0]);
}

async function getRunningByUser(userId, tx) {
  const db = getExecutor(tx);
  const rows = await db.query(
    `
      SELECT
        id,
        user_id,
        address_id,
        station_id,
        status,
        start_time,
        end_time,
        duration_seconds,
        start_energy_total,
        end_energy_total,
        energy_once,
        energy_kwh,
        energy_source,
        origin,
        authorization_method,
        detected_at,
        needs_review,
        notes,
        tariff_per_kwh,
        price_calculated,
        price_override,
        payment_status,
        paid_at
      FROM sessions
      WHERE user_id = $1 AND status = 'running'
      ORDER BY start_time DESC, id DESC
      LIMIT 1
    `,
    [userId]
  );

  return mapSessionRow(rows[0]);
}

async function getById(sessionId, tx) {
  const db = getExecutor(tx);
  const rows = await db.query(
    `
      SELECT
        id,
        user_id,
        address_id,
        station_id,
        status,
        start_time,
        end_time,
        duration_seconds,
        start_energy_total,
        end_energy_total,
        energy_once,
        energy_kwh,
        energy_source,
        origin,
        authorization_method,
        detected_at,
        needs_review,
        notes,
        tariff_per_kwh,
        price_calculated,
        price_override,
        payment_status,
        paid_at
      FROM sessions
      WHERE id = $1
      LIMIT 1
    `,
    [sessionId]
  );

  return mapSessionRow(rows[0]);
}

async function createRunning(payload, tx) {
  const db = getExecutor(tx);
  const {
    user_id,
    address_id,
    station_id,
    start_energy_total,
    tariff_per_kwh,
    notes,
    start_time,
    origin,
    authorization_method,
    detected_at,
  } = payload;

  const rows = await db.query(
    `
      INSERT INTO sessions (
        user_id,
        address_id,
        station_id,
        status,
        start_time,
        start_energy_total,
        tariff_per_kwh,
        notes,
        origin,
        authorization_method,
        detected_at
      )
      VALUES ($1, $2, $3, 'running', COALESCE($4, NOW()), $5, $6, $7, $8, $9, $10)
      RETURNING
        id,
        user_id,
        address_id,
        station_id,
        status,
        start_time,
        end_time,
        duration_seconds,
        start_energy_total,
        end_energy_total,
        energy_once,
        energy_kwh,
        energy_source,
        origin,
        authorization_method,
        detected_at,
        needs_review,
        notes,
        tariff_per_kwh,
        price_calculated,
        price_override,
        payment_status,
        paid_at
    `,
    [
      user_id,
      address_id,
      station_id,
      start_time ?? null,
      start_energy_total == null ? null : start_energy_total,
      tariff_per_kwh == null ? null : tariff_per_kwh,
      notes ?? null,
      origin ?? "program",
      authorization_method ?? "program",
      detected_at ?? null,
    ]
  );

  return mapSessionRow(rows[0]);
}

async function finishSession(sessionId, patch, tx) {
  const db = getExecutor(tx);
  const updates = [];
  const values = [];
  let idx = 1;

  const allowedFields = [
    "status",
    "end_time",
    "duration_seconds",
    "end_energy_total",
    "energy_once",
    "energy_kwh",
    "energy_source",
    "needs_review",
    "notes",
    "tariff_per_kwh",
    "price_calculated",
    "price_override",
    "payment_status",
    "paid_at",
  ];

  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    updates.push(`${field} = $${idx}`);
    values.push(patch[field]);
    idx += 1;
  }

  if (updates.length === 0) {
    return getById(sessionId, tx);
  }

  const whereIdx = idx;
  const rows = await db.query(
    `
      UPDATE sessions
      SET ${updates.join(", ")}
      WHERE id = $${whereIdx} AND status = 'running'
      RETURNING
        id,
        user_id,
        address_id,
        station_id,
        status,
        start_time,
        end_time,
        duration_seconds,
        start_energy_total,
        end_energy_total,
        energy_once,
        energy_kwh,
        energy_source,
        origin,
        authorization_method,
        detected_at,
        needs_review,
        notes,
        tariff_per_kwh,
        price_calculated,
        price_override,
        payment_status,
        paid_at
    `,
    [...values, sessionId]
  );

  return mapSessionRow(rows[0]);
}

async function listByUser(userId, limit = 50, offset = 0) {
  const rows = await pgDb.query(
    `
      SELECT
        s.id,
        s.user_id,
        s.address_id,
        s.station_id,
        s.status,
        s.start_time,
        s.end_time,
        s.duration_seconds,
        s.start_energy_total,
        s.end_energy_total,
        s.energy_once,
        s.energy_kwh,
        s.energy_source,
        s.origin,
        s.authorization_method,
        s.detected_at,
        s.needs_review,
        s.notes,
        s.tariff_per_kwh,
        s.price_calculated,
        s.price_override,
        s.payment_status,
        s.paid_at,
        st.name AS station_name,
        st.location_label AS station_location_label,
        ad.label AS address_label
      FROM sessions s
      LEFT JOIN stations st ON st.id = s.station_id
      LEFT JOIN addresses ad ON ad.id = s.address_id
      WHERE s.user_id = $1
      ORDER BY s.start_time DESC, s.id DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, normalizeLimit(limit, 50, 200), normalizeOffset(offset, 0)]
  );

  return rows.map((row) => ({
    ...mapSessionRow(row),
    station_name: row.station_name ?? null,
    station_location_label: row.station_location_label ?? null,
    address_label: row.address_label ?? null,
    station: {
      name: row.station_name ?? null,
      location_label: row.station_location_label ?? null,
    },
    address: {
      label: row.address_label ?? null,
    },
  }));
}

async function listAdmin(filters = {}) {
  const clauses = [];
  const values = [];
  let idx = 1;

  if (filters.id != null) {
    clauses.push(`s.id = $${idx}`);
    values.push(filters.id);
    idx += 1;
  }
  if (filters.user_id != null) {
    clauses.push(`s.user_id = $${idx}`);
    values.push(filters.user_id);
    idx += 1;
  }
  if (filters.station_id != null) {
    clauses.push(`s.station_id = $${idx}`);
    values.push(filters.station_id);
    idx += 1;
  }
  if (filters.status) {
    clauses.push(`s.status = $${idx}`);
    values.push(String(filters.status));
    idx += 1;
  }
  if (filters.payment_status) {
    clauses.push(`s.payment_status = $${idx}`);
    values.push(String(filters.payment_status));
    idx += 1;
  }
  if (filters.date_from) {
    clauses.push(`s.start_time >= $${idx}`);
    values.push(filters.date_from);
    idx += 1;
  }
  if (filters.date_to) {
    clauses.push(`s.start_time <= $${idx}`);
    values.push(filters.date_to);
    idx += 1;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const limit = normalizeLimit(filters.limit, 100, 500);
  const offset = normalizeOffset(filters.offset, 0);
  const limitParam = idx;
  const offsetParam = idx + 1;

  const rows = await pgDb.query(
    `
      SELECT
        s.id,
        s.user_id,
        s.address_id,
        s.station_id,
        s.status,
        s.start_time,
        s.end_time,
        s.duration_seconds,
        s.start_energy_total,
        s.end_energy_total,
        s.energy_once,
        s.energy_kwh,
        s.energy_source,
        s.origin,
        s.authorization_method,
        s.detected_at,
        s.needs_review,
        s.notes,
        s.tariff_per_kwh,
        s.price_calculated,
        s.price_override,
        s.payment_status,
        s.paid_at,
        u.id AS u_id,
        u.name AS u_name,
        u.email AS u_email,
        u.cpf AS u_cpf,
        u.tower AS u_tower,
        u.apartment AS u_apartment,
        u.is_admin AS u_is_admin,
        st.id AS st_id,
        st.name AS st_name,
        st.location_label AS st_location_label,
        st.tuya_device_id AS st_tuya_device_id,
        st.max_current_a AS st_max_current_a,
        st.is_active AS st_is_active,
        ad.id AS ad_id,
        ad.label AS ad_label,
        ad.street AS ad_street,
        ad.number AS ad_number,
        ad.neighborhood AS ad_neighborhood,
        ad.city AS ad_city,
        ad.state AS ad_state,
        ad.zip AS ad_zip,
        ad.is_default AS ad_is_default
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN stations st ON st.id = s.station_id
      LEFT JOIN addresses ad ON ad.id = s.address_id
      ${where}
      ORDER BY s.start_time DESC, s.id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `,
    [...values, limit, offset]
  );

  return rows.map(mapSessionWithRelations);
}

async function listCurrentRunning() {
  return listAdmin({ status: "running", limit: 1000, offset: 0 });
}

async function updateAdminFields(sessionId, patch, tx) {
  const db = getExecutor(tx);
  const updates = [];
  const values = [];
  let idx = 1;

  const setField = (field, value) => {
    updates.push(`${field} = $${idx}`);
    values.push(value);
    idx += 1;
  };

  if (Object.prototype.hasOwnProperty.call(patch, "payment_status")) {
    const paymentStatus = patch.payment_status == null ? null : String(patch.payment_status);
    setField("payment_status", paymentStatus);
    if (paymentStatus === "pago") {
      updates.push("paid_at = NOW()");
    } else if (paymentStatus) {
      setField("paid_at", null);
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "price_override")) {
    setField("price_override", patch.price_override == null ? null : patch.price_override);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "notes")) {
    setField("notes", patch.notes == null ? null : String(patch.notes));
  }

  if (Object.prototype.hasOwnProperty.call(patch, "needs_review")) {
    setField("needs_review", patch.needs_review === true);
  }

  if (updates.length === 0) {
    return getById(sessionId, tx);
  }

  const whereIdx = idx;
  const rows = await db.query(
    `
      UPDATE sessions
      SET ${updates.join(", ")}
      WHERE id = $${whereIdx}
      RETURNING
        id,
        user_id,
        address_id,
        station_id,
        status,
        start_time,
        end_time,
        duration_seconds,
        start_energy_total,
        end_energy_total,
        energy_once,
        energy_kwh,
        energy_source,
        origin,
        authorization_method,
        detected_at,
        needs_review,
        notes,
        tariff_per_kwh,
        price_calculated,
        price_override,
        payment_status,
        paid_at
    `,
    [...values, sessionId]
  );

  return mapSessionRow(rows[0]);
}

module.exports = {
  getRunningByStation,
  getRunningByUser,
  getById,
  createRunning,
  finishSession,
  listByUser,
  listAdmin,
  listCurrentRunning,
  updateAdminFields,
};
