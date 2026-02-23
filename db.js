// db.js
const Database = require("better-sqlite3");
const db = new Database("database.sqlite");

// ===============================
// Migração segura: ADD COLUMN via try/catch
// ===============================
function addColumnIfNotExists(sql) {
  try {
    db.prepare(sql).run();
  } catch (e) {
    // ignora (coluna já existe)
  }
}

// ===============================
// Tabela SESSIONS
// ===============================
db.prepare(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user TEXT,                 -- legado (apenas um rótulo)
    user_id INTEGER,

    status TEXT NOT NULL,      -- running | done

    start_time TEXT DEFAULT CURRENT_TIMESTAMP,
    end_time TEXT,

    start_energy_total REAL,
    end_energy_total REAL,

    energy_once REAL,

    start_once_raw INTEGER,
    end_once_raw INTEGER,

    duration_seconds INTEGER,  -- NOVO: duração

    price_calculated REAL,     -- NOVO: valor calculado (tarifa * kWh)
    price_override REAL,       -- NOVO: admin pode sobrescrever depois

    paid INTEGER DEFAULT 0,    -- NOVO: 0/1
    paid_at TEXT               -- NOVO: data/hora do pagamento
  )
`).run();

// Garante colunas em bancos antigos
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN user TEXT`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN user_id INTEGER`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN status TEXT`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN start_time TEXT`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN end_time TEXT`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN start_energy_total REAL`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN end_energy_total REAL`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN energy_once REAL`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN start_once_raw INTEGER`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN end_once_raw INTEGER`);

addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN duration_seconds INTEGER`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN price_calculated REAL`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN price_override REAL`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN paid INTEGER DEFAULT 0`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN paid_at TEXT`);

// ===============================
// Tabela USERS
// ===============================
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    cpf TEXT NOT NULL UNIQUE,

    password_hash TEXT NOT NULL,

    role TEXT NOT NULL,       -- resident | visitor | admin
    tower TEXT NOT NULL,      -- mississipi | missouri
    apartment TEXT NOT NULL,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`).run();

module.exports = db;