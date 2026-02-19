// db.js

// Importa a biblioteca better-sqlite3
// Essa biblioteca cria e gerencia banco SQLite local
const Database = require("better-sqlite3");

// Cria (ou abre) um arquivo chamado database.sqlite
// Se não existir, ele será criado automaticamente
const db = new Database("database.sqlite");

// Cria uma tabela chamada "sessions" se ela ainda não existir
// Essa tabela vai armazenar cada carregamento
db.prepare(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    energy REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// Exporta o banco para ser usado em outros arquivos
module.exports = db;
