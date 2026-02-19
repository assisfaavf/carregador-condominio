const Database = require("better-sqlite3");
const db = new Database("database.sqlite");

// Tabela mais completa para controlar sessões reais
db.prepare(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user TEXT NOT NULL,                -- quem iniciou (depois será login/QR)
    status TEXT NOT NULL,              -- "running" ou "done"

    start_time TEXT DEFAULT CURRENT_TIMESTAMP,
    end_time TEXT,

    start_energy_total REAL,           -- total no início (ex: 248.23)
    end_energy_total REAL,             -- total no fim (opcional)

    energy_once REAL                   -- energia da sessão (ex: 37.35)
  )
`).run();

// ===============================
// MIGRAÇÃO SIMPLES (ALTER TABLE)
// ===============================
// Como você já tinha uma tabela sessions antiga, precisamos adicionar colunas novas.
// O SQLite não tem "ADD COLUMN IF NOT EXISTS", então usamos try/catch.
// Se a coluna já existir, dá erro e a gente ignora.

function addColumnIfNotExists(sql) {
  try {
    db.prepare(sql).run();
  } catch (e) {
    // ignora erro (provavelmente coluna já existe)
  }
}

// Adiciona colunas novas se ainda não existirem
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN status TEXT`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN start_time TEXT`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN end_time TEXT`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN start_energy_total REAL`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN end_energy_total REAL`);
addColumnIfNotExists(`ALTER TABLE sessions ADD COLUMN energy_once REAL`);


module.exports = db;
