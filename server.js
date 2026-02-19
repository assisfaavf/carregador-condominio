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

// 5) Biblioteca para gerar hash de senha
const bcrypt = require("bcryptjs");


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

// Lista sessões (mais recentes primeiro)
app.get("/sessions", (req, res) => {
  const sessions = db.prepare(`
    SELECT
      id,
      user,
      status,
      start_time,
      end_time,
      start_energy_total,
      end_energy_total,
      energy_once
    FROM sessions
    ORDER BY id DESC
    LIMIT 50
  `).all();

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

    // Se o carregador estiver preso em "charger_end", tentamos "limpar" o estado antes de iniciar
    if (workState === "charger_end") {
      // 1) garante que está desligado
      await sendCommands(deviceId, [{ code: "switch", value: false }]);

      // 2) tenta limpar energia/estado da sessão (DP clear_energy)
      await sendCommands(deviceId, [{ code: "clear_energy", value: true }]);

      // 3) espera um pouco e lê status novamente
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(1500);

      const status2 = await getDeviceStatus(deviceId);
      // atualiza variáveis (para seguir o fluxo com o estado atualizado)
      const newWorkState = findDp(status2, "work_state")?.value;
      const newConnectionState = findDp(status2, "connection_state")?.value;

      // se ainda estiver charger_end, a gente continua mesmo assim (alguns ficam assim até desconectar)
      // mas pelo menos tentamos resetar os contadores.
    }

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

// Para carregamento e FINALIZA a sessão "running" salvando a energia da sessão
app.post("/session/stop", async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;

    // 1) Busca a última sessão em andamento
    const running = db.prepare(`
      SELECT * FROM sessions
      WHERE status = 'running'
      ORDER BY id DESC
      LIMIT 1
    `).get();

    if (!running) {
      return res.status(400).json({
        success: false,
        message: "Nenhuma sessão em andamento encontrada."
      });
    }

    // 2) Envia comando STOP
    await sendCommands(deviceId, [{ code: "switch", value: false }]);

    // 3) Faz polling: espera o carregador refletir o estado final
    // (porque alguns DPs atualizam alguns segundos depois do stop)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let lastStatus = null;
    for (let i = 0; i < 10; i++) { // tenta por ~10 segundos
      await sleep(1000);
      lastStatus = await getDeviceStatus(deviceId);

      const sw = findDp(lastStatus, "switch")?.value;
      const ws = findDp(lastStatus, "work_state")?.value;

      // Condição de parada do polling
      if (sw === false || ws === "charger_free") break;
    }

    // 4) Pega energia final da sessão
    const onceRaw = findDp(lastStatus, "charge_energy_once")?.value;

    // scale 2 => 3735 vira 37.35 kWh
    const energyOnce = (typeof onceRaw === "number") ? onceRaw / 100 : null;

    // 5) Atualiza a sessão no banco
    db.prepare(`
      UPDATE sessions
      SET status = 'done',
          end_time = datetime('now'),
          energy_once = ?
      WHERE id = ?
    `).run(energyOnce, running.id);

    res.json({
      success: true,
      message: "Sessão finalizada.",
      sessionId: running.id,
      energy_once: energyOnce
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erro ao finalizar sessão",
      error: error.message
    });
  }
});

// Para o carregamento e FINALIZA a última sessão "running" no banco
app.post("/session/stop", async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;

    // 1) Busca a sessão em andamento
    const running = db.prepare(`
      SELECT * FROM sessions
      WHERE status = 'running'
      ORDER BY id DESC
      LIMIT 1
    `).get();

    if (!running) {
      return res.status(400).json({
        success: false,
        message: "Nenhuma sessão em andamento encontrada."
      });
    }

    // 2) Envia comando STOP para a Tuya
    await sendCommands(deviceId, [{ code: "switch", value: false }]);

    // 3) Aguarda a Tuya atualizar os DPs (charge_energy_once normalmente atualiza após parar)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let status = null;
    let onceRaw = null;

    // Vamos tentar por até ~12 segundos
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      status = await getDeviceStatus(deviceId);

      // Captura o valor do DP
      onceRaw = findDp(status, "charge_energy_once")?.value;

      const sw = findDp(status, "switch")?.value;
      const ws = findDp(status, "work_state")?.value;

      // Condição boa: switch já está false E work_state já está em "charger_end" ou "charger_free"
      if (sw === false && (ws === "charger_end" || ws === "charger_free")) {
        break;
      }
    }

    // 4) Converte energia (scale 2): 202 -> 2.02 kWh
    const energyOnce = (typeof onceRaw === "number") ? onceRaw / 100 : null;

    // 5) Também salva os estados finais úteis (opcional, mas bom para auditoria)
    const endWorkState = findDp(status, "work_state")?.value || null;
    const endConnectionState = findDp(status, "connection_state")?.value || null;

    // 6) Atualiza sessão no banco
    db.prepare(`
      UPDATE sessions
      SET status = 'done',
          end_time = datetime('now'),
          energy_once = ?
      WHERE id = ?
    `).run(energyOnce, running.id);

    res.json({
      success: true,
      message: "Sessão finalizada.",
      sessionId: running.id,
      energy_once: energyOnce,
      end_work_state: endWorkState,
      end_connection_state: endConnectionState
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erro ao finalizar sessão",
      error: error.message
    });
  }
});

// Rota de manutenção: "pulsa" o clear_energy para limpar e volta para false
app.post("/tuya/clear-energy", async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 1) Liga o clear_energy (pulso)
    await sendCommands(deviceId, [{ code: "clear_energy", value: true }]);

    // 2) Espera um pouco
    await sleep(800);

    // 3) Desliga o clear_energy (volta ao normal)
    const result = await sendCommands(deviceId, [{ code: "clear_energy", value: false }]);

    // 4) Mostra status final
    const status = await getDeviceStatus(deviceId);

    res.json({
      success: true,
      message: "clear_energy pulsed (true -> false).",
      tuya: result,
      status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rota para AUTH - CADASTRO
app.post("/auth/register", (req, res) => {
  try {
    // 1) Pega os dados do corpo (JSON)
    let { name, email, cpf, password, role, tower, apartment } = req.body || {};

    // 2) Validações básicas (mínimas)
    name = (name || "").trim();
    email = (email || "").trim().toLowerCase();
    cpf = (cpf || "").replace(/\D/g, ""); // mantém só números
    apartment = (apartment || "").trim();
    role = (role || "").trim().toLowerCase();
    tower = (tower || "").trim().toLowerCase();
    password = String(password || "");

    if (!name) return res.status(400).json({ success: false, message: "Nome é obrigatório." });
    if (!email) return res.status(400).json({ success: false, message: "Email é obrigatório." });
    if (!cpf || cpf.length !== 11) return res.status(400).json({ success: false, message: "CPF inválido (precisa ter 11 números)." });
    if (!apartment) return res.status(400).json({ success: false, message: "Apartamento é obrigatório." });
    if (!password || password.length < 8) return res.status(400).json({ success: false, message: "Senha deve ter no mínimo 8 caracteres." });

    // role/tower com valores fixos (evita erro de digitação)
    const allowedRoles = ["resident", "visitor"];
    const allowedTowers = ["mississipi", "missouri"];

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "role inválido. Use 'resident' ou 'visitor'." });
    }
    if (!allowedTowers.includes(tower)) {
      return res.status(400).json({ success: false, message: "tower inválida. Use 'mississipi' ou 'missouri'." });
    }

    // 3) Gera o hash da senha (NUNCA salvar senha pura)
    const password_hash = bcrypt.hashSync(password, 10); // 10 = custo (bom equilíbrio)

    // 4) Insere no banco (se email/cpf já existirem, vai dar erro UNIQUE)
    const stmt = db.prepare(`
      INSERT INTO users (name, email, cpf, password_hash, role, tower, apartment)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(name, email, cpf, password_hash, role, tower, apartment);

    // 5) Retorna sucesso (não devolvemos password_hash nunca)
    res.json({
      success: true,
      message: "Usuário cadastrado com sucesso.",
      userId: result.lastInsertRowid,
    });

  } catch (error) {
    // Erro de UNIQUE (email/cpf repetido) costuma cair aqui
    const msg = String(error.message || error);

    if (msg.includes("UNIQUE")) {
      return res.status(409).json({
        success: false,
        message: "Email ou CPF já cadastrado.",
      });
    }

    res.status(500).json({
      success: false,
      message: "Erro ao cadastrar usuário.",
      error: msg,
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



