
// Importa o banco
const db = require("./db");

// server.js
const express = require("express");

// Cria o aplicativo (servidor)
const app = express();

// Permite o servidor entender JSON (vamos usar isso depois)
app.use(express.json());

//Permite que o html seja aberto no navegador
app.use(express.static("public"));

// Rota de teste (para saber se o servidor está vivo)
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Rota principal (home)
app.get("/", (req, res) => {
  res.send("Servidor do Carregador rodando! Acesse /health para testar.");
});

// Porta do servidor
const PORT = 3000;

// Inicia o servidor
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});


// Rota para criar uma sessão manualmente
app.post("/sessions", (req, res) => {
  const { user, energy } = req.body;

  // Verifica se o usuário foi enviado
  if (!user) {
    return res.status(400).json({ error: "Usuário é obrigatório" });
  }

  // Insere no banco
  const stmt = db.prepare(`
    INSERT INTO sessions (user, energy)
    VALUES (?, ?)
  `);

  const result = stmt.run(user, energy || 0);

  res.json({
    message: "Sessão criada",
    id: result.lastInsertRowid
  });
});

// Rota para listar todas as sessões
app.get("/sessions", (req, res) => {
  const sessions = db.prepare("SELECT * FROM sessions").all();
  res.json(sessions);
});

