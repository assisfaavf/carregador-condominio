// 1) Carrega as variáveis do .env PRIMEIRO
require("dotenv").config();

// 2) Importa bibliotecas externas
const express = require("express");

// 3) Importa arquivos do seu projeto (que usam process.env)
const { getDeviceStatus, sendCommands } = require("./tuya_api");
const db = require("./db");

// 4) Cria o aplicativo (servidor)
const app = express();

// Middlewares
app.use(express.json());
app.use(express.static("public"));



// Rota principal (home)
app.get("/", (req, res) => {
  res.send("Servidor do Carregador rodando! Acesse /health para testar.");
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

// Rota de teste: mostra o status do carregador vindo da Tuya Cloud
app.get("/tuya/status", async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    
    // Confere se você configurou o device id no .env
    if (!deviceId) {
      return res.status(400).json({ error: "TUYA_DEVICE_ID não está configurado no .env" });
    }
    
    // Pede à Tuya o status do dispositivo (lista de DPs e valores)
    const data = await getDeviceStatus(deviceId);
    
    // Retorna o JSON para o navegador (pra você estudar a estrutura)
    res.json(data);
  } catch (err) {
    // Em caso de erro, devolve uma resposta amigável com detalhes
    res.status(500).json({
      error: "Falha ao consultar a Tuya",
      details: String(err?.message || err),
    });
  }
});

// Rota para iniciar o carregamento
app.post("/tuya/start", async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;

    // Envia três comandos:
    // 1) Define modo "charge_now" (carregar imediatamente)
    // 2) Define corrente 32A (ajustável depois)
    // 3) Liga o switch (true)
    const result = await sendCommands(deviceId, [
      { code: "work_mode", value: "charge_now" },
      { code: "charge_cur_set", value: 32 },
      { code: "switch", value: true },
    ]);

    res.json({
      success: true,
      message: "Carregamento iniciado",
      tuya: result,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erro ao iniciar carregamento",
      error: error.message,
    });
  }
});

// Rota para parar o carregamento
app.post("/tuya/stop", async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    
    // Envia o comando para desligar o switch (false)
    const result = await sendCommands(deviceId, [
      { code: "switch", value: false },
    ]);
    
    res.json({
      success: true,
      message: "Carregamento parado",
      tuya: result,
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erro ao parar carregamento",
      error: error.message,
    });
  }
});

// Rota de teste (para saber se o servidor está vivo)
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

//Declarando a porta
const PORT = process.env.PORT || 3000;
// Inicia o servidor
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});



