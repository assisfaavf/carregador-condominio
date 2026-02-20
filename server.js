// 1) Carrega as variáveis do .env PRIMEIRO
require("dotenv").config();

// 2) Importa bibliotecas externas
const express = require("express");

// 3) Importa arquivos do seu projeto (que usam process.env)
const { getDeviceStatus, sendCommands } = require("./tuya_api");
const db = require("./db");

//Importa o JWT (token) e cookies (para guardar o token no navegador)
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

// 4) Cria o aplicativo (servidor)
const app = express();

// 5) Biblioteca para gerar hash de senha
const bcrypt = require("bcryptjs");
const { Users } = require("@azure/cosmos");

// Função auxiliar: acha um DP específico dentro do array "result" do /status
function findDp(statusData, code) {
  const arr = statusData?.result || [];
  return arr.find((x) => x.code === code);
}

//Cria um token JWT com os daods básicos do usuário
function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN || "7d";
  return jwt.sign(payload, secret, { expiresIn });
}

//Salvar o token em cookie httpOnly 
function setAuthCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, //Quando for usar https mudar para true
  });
}

//MiddleWare: Exige estar logado
function requireAuth(req, res, next){
  try{
    const token = req.cookies?.token;

    if(!token){
      return res.status(401).json({ success: false, message: "Não autenticado."});
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    next();
  } catch (err){
    return res.status(401).json({ success: false, message: "Token invalido ou expirado."});
  }
}

//Middleware: Exige ser admin
function requiresAdmin(req, res, next){
  if (req.user?.role !== "admin"){
    return res.status(403).json({success: false, message: "Acesso restrito a administradores."});
  }
  next();
}

// Middlewares
app.use(express.json()); //Ativa o express
app.use(cookieParser()); //Ativa o cookie parser
app.use(express.static("public"));


// Rota principal (home)
app.get("/", (req, res) => {
  res.send("Servidor do Carregador rodando! Acesse /health para testar.");
});

// Rota para criar uma sessão manualmente
app.get("/sessions", (req, res) => {
  try {
    // Puxa as sessões sem assumir colunas específicas
    // (Assim, mesmo se você adicionar/remover colunas, não quebra o painel)
    const sessions = db.prepare(`
      SELECT *
      FROM sessions
      ORDER BY id DESC
      LIMIT 50
    `).all();

    res.json(sessions);
  } catch (error) {
    // Se der erro SQL, devolve JSON (não HTML) para o front conseguir mostrar a mensagem
    res.status(500).json({
      success: false,
      message: "Erro ao listar sessões",
      error: String(error.message || error),
    });
  }
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

// Inicia uma sessão no banco + tenta iniciar carregamento (safe)
app.post("/session/start", async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    
    // 1) Pega usuário do corpo da requisição
    const user = (req.body?.user || "").trim();
    if (!user) {
      return res.status(400).json({ success: false, message: "Informe o usuário (ex: Apto 301)." });
    }

    // Bloqueia se já existir uma sessão em andamento
    const existing = db.prepare(`
      SELECT id, user, start_time
      FROM sessions
      WHERE status = 'running'
      ORDER BY id DESC
      LIMIT 1
    `).get();

    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Já existe uma sessão em andamento (ID ${existing.id}, usuário ${existing.user}). Pare a sessão atual antes de iniciar outra.`,
        existing,
      });
    }

    // 2) Consulta status atual na Tuya
    const status = await getDeviceStatus(deviceId);
    // Guarda o valor atual do DP "charge_energy_once".
    // Importante: durante a carga ele pode mostrar o valor da sessão ANTERIOR.
    // Vamos salvar isso no banco para usar como "baseline" na hora do STOP.
    const onceRawBefore = findDp(status, "charge_energy_once")?.value;
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
      INSERT INTO sessions (user, status, start_time, start_energy_total, start_once_raw)
      VALUES (?, ?, datetime('now','localtime'), ?, ?)
      `);
      const result = stmt.run(user, "running", startEnergyTotal, (typeof onceRawBefore === "number" ? onceRawBefore : null));
      
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

    const baseline = running.start_once_raw;

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

    // A Tuya pode atualizar o charge_energy_once em "etapas" após o stop.
    // Então: esperamos ele mudar do baseline E ficar estável (sem mudar) por alguns ciclos.

    let status = null;
    let onceRaw = null;

    let lastOnceRaw = null;
    let stableCount = 0;

    // vamos dar mais tempo: até 60 segundos (alguns EVSE demoram)
    for (let i = 0; i < 60; i++) {
      await sleep(1000);

      status = await getDeviceStatus(deviceId);

      const sw = findDp(status, "switch")?.value;
      const ws = findDp(status, "work_state")?.value;
      onceRaw = findDp(status, "charge_energy_once")?.value;

      // Só começamos a considerar quando:
      // - já está parado (switch false)
      // - e está em estado de fim/idle
      const stoppedOk = (sw === false) && (ws === "charger_end" || ws === "charger_free");

      if (!stoppedOk) continue;

      // Se ainda não é número, continua esperando
      if (typeof onceRaw !== "number") continue;

      // Se baseline existir, esperamos mudar do baseline
      if (baseline != null && onceRaw === baseline) continue;

      // Agora já mudou do baseline: precisamos esperar estabilizar
      if (lastOnceRaw === null) {
        lastOnceRaw = onceRaw;
        stableCount = 0;
        continue;
      }

      if (onceRaw === lastOnceRaw) {
        stableCount += 1;
      } else {
        // mudou de novo -> zera estabilidade e atualiza last
        lastOnceRaw = onceRaw;
        stableCount = 0;
      }

      // Considera estável quando ficar igual por 3 leituras seguidas (~3s)
      if (stableCount >= 3) {
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
          end_time = datetime('now', 'localtime'),
          energy_once = ?,
          end_once_raw = ?
      WHERE id = ?
    `).run(energyOnce,
      (typeof onceRaw === "number" ? onceRaw : null),
      running.id);

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
    const allowedRoles = ["resident", "visitor", "admin"];
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

//Rota para o Auth - Login
app.post("/auth/login", (req, res) => {
  try {
    let { emailOrCpf, password } = req.body || {};

    emailOrCpf = String(emailOrCpf || "").trim().toLowerCase();
    password = String(password || "");

    if (!emailOrCpf) {
      return res.status(400).json({ success: false, message: "Informe email ou CPF."});
    }
    if (!password) {
      return res.status(400).json({ success: false, message: "Informe a senha."});
    }

    //Se vier CPF com pontos e traços, remove tudo e fica só os números
    const cpfOnly = emailOrCpf.replace(/\D/g, "");
    
    // Buscar por email ou CPF
    const user = db.prepare(`
      SELECT id, name, email, cpf, password_hash, role,tower, apartment
      FROM users
      WHERE email = ? OR cpf = ?
      LIMIT 1
       `).get(emailOrCpf, cpfOnly);

    if (!user) {
      return res.status(401).json({ success: false, message: "Credenciais inválidas."});
    }

    //Confere senha
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, message: "Credenciais inválidas."})
    }

    //Criar token com dados mínimos do usuário
    const token = signToken({
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      tower: user.tower,
      apartment: user.apartment,
    });

    //Salva token em cookie
    setAuthCookie(res, token);

    //Retorna dados (sem password_hash)
    res.json({
      success: true,
      message: "Login ok",
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        tower: user.tower,
        apartment: user.apartment,
      },
    });
  } catch (error) {
    res.status(500),express.json({
      success: false,
      message: "Erro no login",
      error: String(error.message || error),
    });
  }
});

//Quem está logando ? (usatoken do cookie)
app.get("/auth/me", requireAuth, (req,res) => {
  res.json({ success: true, user: req.user});
});

//Logout (apag cookie)
app.post("/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true, message: "Logout ok" });
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



