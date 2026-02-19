// 1) Carrega as variáveis do .env PRIMEIRO
require("dotenv").config();

// 2) Importa bibliotecas externas
const express = require("express");

// 3) Importa arquivos do seu projeto (que usam process.env)
const { getDeviceStatus, sendCommands } = require("./tuya_api");
const db = require("./db");

// 4) Cria o aplicativo (servidor)
const app = express();

// Função auxiliar: acha um DP específico dentro do array "result" do /status
function findDp(statusData, code) {
  const arr = statusData?.result || [];
  return arr.find((x) => x.code === code);
}

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

// Start "seguro": só tenta iniciar se o carro estiver conectado
app.post("/tuya/start-safe", async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;

    // 1) Lê o status atual do carregador na Tuya
    const status = await getDeviceStatus(deviceId);

    // Pega alguns estados importantes
    const workState = findDp(status, "work_state")?.value;
    const connectionState = findDp(status, "connection_state")?.value;

    // 2) Regra inicial: se estiver no estado "controlpi_12v", assumimos que NÃO tem carro conectado
    // (Depois vamos refinar quando você conectar um carro e ver quais estados mudam.)
    const connected = connectionState && connectionState !== "controlpi_12v";

    // 3) Se não estiver conectado, não inicia (evita cobrar sessão fantasma)
    if (!connected) {
      return res.status(409).json({
        success: false,
        message: "Carro não conectado. Conecte o veículo antes de iniciar.",
        work_state: workState,
        connection_state: connectionState,
      });
    }

    // 4) Se conectado, envia comandos para iniciar carregamento
    const result = await sendCommands(deviceId, [
      { code: "work_mode", value: "charge_now" },
      { code: "charge_cur_set", value: 32 },
      { code: "switch", value: true },
    ]);

    res.json({
      success: true,
      message: "Comando de início enviado (start-safe).",
      tuya: result,
      work_state: workState,
      connection_state: connectionState,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erro no start-safe",
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

// Inicia uma sessão no banco + tenta iniciar carregamento (safe)
app.post("/session/start", async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;

    // 1) Pega usuário do corpo da requisição
    const user = (req.body?.user || "").trim();
    if (!user) {
      return res.status(400).json({ success: false, message: "Informe o usuário (ex: Apto 301)." });
    }

    // 2) Consulta status atual na Tuya
    const status = await getDeviceStatus(deviceId);
    const workState = findDp(status, "work_state")?.value;
    const connectionState = findDp(status, "connection_state")?.value;

    // 3) Regra inicial: se estiver "controlpi_12v", assumimos que não há carro conectado
    const connected = connectionState && connectionState !== "controlpi_12v";
    if (!connected) {
      return res.status(409).json({
        success: false,
        message: "Carro não conectado. Conecte o veículo antes de iniciar.",
        work_state: workState,
        connection_state: connectionState,
      });
    }

    // 4) Lê energia total para salvar como energia inicial
    const totalRaw = findDp(status, "forward_energy_total")?.value;

    // Muitos DPs vêm com scale 2 (centésimos). Vamos converter: 24823 -> 248.23
    const startEnergyTotal = (typeof totalRaw === "number") ? totalRaw / 100 : null;

    // 5) Cria sessão no banco como "running"
    const stmt = db.prepare(`
      INSERT INTO sessions (user, status, start_time, start_energy_total)
      VALUES (?, ?, datetime('now'), ?)
    `);
    const result = stmt.run(user, "running", startEnergyTotal);

    const sessionId = result.lastInsertRowid;

    // 6) Envia comandos para iniciar
    const tuyaResult = await sendCommands(deviceId, [
      { code: "work_mode", value: "charge_now" },
      { code: "charge_cur_set", value: 32 },
      { code: "switch", value: true },
    ]);

    res.json({
      success: true,
      message: "Sessão iniciada e comando enviado.",
      sessionId,
      start_energy_total: startEnergyTotal,
      tuya: tuyaResult,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erro ao iniciar sessão",
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



