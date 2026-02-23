// server.js
// ===============================
// 1) Carrega .env primeiro
// ===============================
require("dotenv").config();

// ===============================
// 2) Imports externos
// ===============================
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

// ===============================
// 3) Imports do projeto
// ===============================
const { getDeviceStatus, sendCommands } = require("./tuya_api");
const db = require("./db");

// ===============================
// 4) App
// ===============================
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

// ===============================
// Helpers
// ===============================

// Acha um DP específico dentro do array "result"
function findDp(statusData, code) {
  const arr = statusData?.result || [];
  return arr.find((x) => x.code === code);
}

// scale2 (ex.: 202 => 2.02 kWh)
function scale2ToKwh(raw) {
  return typeof raw === "number" ? raw / 100 : null;
}

function toFiniteNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readDpNumber(statusData, code) {
  return toFiniteNumber(findDp(statusData, code)?.value);
}

function pickPowerKwFromStatus(statusData) {
  // Alguns modelos usam códigos diferentes para potência instantânea.
  const raw =
    readDpNumber(statusData, "power_total") ??
    readDpNumber(statusData, "cur_power") ??
    readDpNumber(statusData, "charge_power") ??
    readDpNumber(statusData, "power");

  if (raw == null) return null;
  if (raw <= 0) return 0;

  // Normalmente vem em watts; em alguns firmwares pode já vir em kW.
  return raw > 30 ? (raw / 1000) : raw;
}

function estimatePowerKwFromSession(kwhEstimated, elapsedSeconds) {
  const kwh = toFiniteNumber(kwhEstimated);
  const sec = toFiniteNumber(elapsedSeconds);
  if (kwh == null || sec == null || sec <= 0) return null;
  const kw = kwh / (sec / 3600);
  if (!Number.isFinite(kw) || kw < 0) return null;
  return kw;
}

// sleep (para polling)
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Token JWT
function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET não configurado no .env");
  const expiresIn = process.env.JWT_EXPIRES_IN || "7d";
  return jwt.sign(payload, secret, { expiresIn });
}

// Cookie httpOnly
function setAuthCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // quando usar HTTPS de verdade, mude para true
  });
}

// Auth middleware
function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ success: false, message: "Não autenticado." });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Token inválido ou expirado." });
  }
}

// Admin middleware
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Acesso restrito a administradores." });
  }
  return next();
}

// Tarifa (R$/kWh) - por enquanto simples (pode trocar depois)
function getTariffPerKwh() {
  const raw = process.env.PRICE_PER_KWH;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1.0; // default 1.00 se não setar
}

// Calcula duração em segundos, baseado em start_time (SQLite localtime)
function calcDurationSeconds(startTimeText) {
  if (!startTimeText) return 0;
  // start_time vem tipo "YYYY-MM-DD HH:MM:SS"
  const start = new Date(startTimeText.replace(" ", "T") + "-03:00"); // Fortaleza
  const now = new Date();
  const sec = Math.floor((now.getTime() - start.getTime()) / 1000);
  return Math.max(0, sec);
}

function toIsoLocalFortaleza(sqliteText) {
  if (!sqliteText) return null;
  return sqliteText.replace(" ", "T") + "-03:00";
}

function calcElapsedSecondsFromSqlite(startTimeText) {
  if (!startTimeText) return 0;
  const start = new Date(toIsoLocalFortaleza(startTimeText));
  const now = new Date();
  return Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
}

function pickChargerStateLabel(workState, sw) {
  if (sw === true || workState === "charger_charging") return "Carregando";
  if (workState === "charger_end") return "Finalizado (carro ainda conectado)";
  if (workState === "charger_free") return "Livre";
  return `Estado: ${workState || "desconhecido"}`;
}

// Diagnóstico simples para falha no START
function diagnoseStartFailure(statusData) {
  if (!statusData) {
    return {
      reasonCode: "no_status_after_start",
      reasonMessage: "Não foi possível confirmar status do carregador após iniciar.",
    };
  }

  const workState = findDp(statusData, "work_state")?.value || null;
  const connectionState = findDp(statusData, "connection_state")?.value || null;
  const sw = findDp(statusData, "switch")?.value ?? null;
  const connected = Boolean(connectionState && connectionState !== "controlpi_12v");

  if (!connected) {
    return {
      reasonCode: "vehicle_not_connected",
      reasonMessage: "Carro não detectado pelo carregador (cabo/plug/estado do veículo).",
    };
  }

  if (sw !== true) {
    return {
      reasonCode: "switch_not_on",
      reasonMessage: "Comando de ligar não foi mantido pelo carregador.",
    };
  }

  if (workState && workState !== "charger_charging") {
    return {
      reasonCode: "not_in_charging_state",
      reasonMessage: `Carregador ligado, mas ainda fora de charging (work_state=${workState}).`,
    };
  }

  return {
    reasonCode: "start_not_confirmed",
    reasonMessage: "Não foi possível confirmar o início da carga dentro do tempo esperado.",
  };
}

// ===============================
// Rotas básicas
// ===============================
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/", (req, res) => {
  res.send("Servidor do Carregador rodando. Use /health para testar.");
});

// ===============================
// AUTH
// ===============================

// Cadastro
app.post("/auth/register", (req, res) => {
  try {
    let { name, email, cpf, password, role, tower, apartment } = req.body || {};

    name = (name || "").trim();
    email = (email || "").trim().toLowerCase();
    cpf = (cpf || "").replace(/\D/g, "");
    apartment = (apartment || "").trim();
    role = (role || "").trim().toLowerCase();
    tower = (tower || "").trim().toLowerCase();
    password = String(password || "");

    if (!name) return res.status(400).json({ success: false, message: "Nome é obrigatório." });
    if (!email) return res.status(400).json({ success: false, message: "Email é obrigatório." });
    if (!cpf || cpf.length !== 11) return res.status(400).json({ success: false, message: "CPF inválido (11 números)." });
    if (!apartment) return res.status(400).json({ success: false, message: "Apartamento é obrigatório." });
    if (!password || password.length < 8) return res.status(400).json({ success: false, message: "Senha deve ter no mínimo 8 caracteres." });

    const allowedRoles = ["resident", "visitor", "admin"];
    const allowedTowers = ["mississipi", "missouri"];

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "role inválido. Use resident|visitor|admin." });
    }
    if (!allowedTowers.includes(tower)) {
      return res.status(400).json({ success: false, message: "tower inválida. Use mississipi|missouri." });
    }

    const password_hash = bcrypt.hashSync(password, 10);

    const stmt = db.prepare(`
      INSERT INTO users (name, email, cpf, password_hash, role, tower, apartment)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(name, email, cpf, password_hash, role, tower, apartment);

    return res.json({ success: true, message: "Usuário cadastrado.", userId: result.lastInsertRowid });
  } catch (error) {
    const msg = String(error.message || error);
    if (msg.includes("UNIQUE")) {
      return res.status(409).json({ success: false, message: "Email ou CPF já cadastrado." });
    }
    return res.status(500).json({ success: false, message: "Erro ao cadastrar usuário.", error: msg });
  }
});

// Login
app.post("/auth/login", (req, res) => {
  try {
    let { emailOrCpf, password } = req.body || {};
    emailOrCpf = String(emailOrCpf || "").trim().toLowerCase();
    password = String(password || "");

    if (!emailOrCpf) return res.status(400).json({ success: false, message: "Informe email ou CPF." });
    if (!password) return res.status(400).json({ success: false, message: "Informe a senha." });

    const cpfOnly = emailOrCpf.replace(/\D/g, "");

    const user = db.prepare(`
      SELECT id, name, email, cpf, password_hash, role, tower, apartment
      FROM users
      WHERE email = ? OR cpf = ?
      LIMIT 1
    `).get(emailOrCpf, cpfOnly);

    if (!user) return res.status(401).json({ success: false, message: "Credenciais inválidas." });

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ success: false, message: "Credenciais inválidas." });

    const token = signToken({
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      tower: user.tower,
      apartment: user.apartment,
    });

    setAuthCookie(res, token);

    return res.json({
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
    return res.status(500).json({
      success: false,
      message: "Erro no login",
      error: String(error.message || error),
    });
  }
});

// Quem está logado
app.get("/auth/me", requireAuth, (req, res) => {
  return res.json({ success: true, user: req.user });
});

// Logout
app.post("/auth/logout", (req, res) => {
  res.clearCookie("token");
  return res.json({ success: true, message: "Logout ok" });
});

// ===============================
// TUYA - Admin (JSON cru)
// ===============================
app.get("/tuya/status", requireAuth, requireAdmin, async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    if (!deviceId) return res.status(400).json({ success: false, message: "TUYA_DEVICE_ID não está no .env" });

    const data = await getDeviceStatus(deviceId);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ success: false, message: "Falha ao consultar Tuya", error: String(err.message || err) });
  }
});

// ===============================
// API LIVE (usuário) - telemetria
// ===============================
app.get("/api/live", requireAuth, async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    if (!deviceId) return res.status(400).json({ success: false, message: "TUYA_DEVICE_ID não está no .env" });

    const status = await getDeviceStatus(deviceId);

    const connectionState = findDp(status, "connection_state")?.value || null;
    const workState = findDp(status, "work_state")?.value || null;
    const sw = findDp(status, "switch")?.value ?? false;

    const charging = (workState === "charger_charging") || (sw === true);

    // DPs úteis
    const currentSet = readDpNumber(status, "charge_cur_set"); // A
    const totalRaw = readDpNumber(status, "forward_energy_total"); // scale2

    const totalKwh = scale2ToKwh(totalRaw);
    let powerKw = pickPowerKwFromStatus(status);

    // Sessão running do usuário (para não mostrar kWh fantasma)
    const running = db.prepare(`
      SELECT id, start_time, start_energy_total
      FROM sessions
      WHERE status = 'running' AND user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(req.user.id);

    let kwhEstimated = 0;
    let sessionId = null;
    let elapsedSeconds = 0;

    if (running && typeof running.start_energy_total === "number" && typeof totalKwh === "number") {
      sessionId = running.id;
      kwhEstimated = Math.max(0, totalKwh - running.start_energy_total);
      elapsedSeconds = calcDurationSeconds(running.start_time);
    }

    if (powerKw == null || powerKw <= 0) {
      const estimatedPower = estimatePowerKwFromSession(kwhEstimated, elapsedSeconds);
      if (estimatedPower != null) powerKw = estimatedPower;
    }

    const tariff = getTariffPerKwh();
    const priceEstimated = Number.isFinite(tariff)
      ? Number((kwhEstimated * tariff).toFixed(2))
      : null;

    return res.json({
      success: true,
      charging,
      workState,
      connectionState,
      switch: sw,

      sessionId,
      kwhEstimated: Number(kwhEstimated.toFixed(2)),
      priceEstimated,
      elapsedSeconds,

      powerKw: powerKw != null ? Number(powerKw.toFixed(2)) : null,
      currentSetA: currentSet != null ? currentSet : null,
      totalKwh: totalKwh != null ? Number(totalKwh.toFixed(2)) : null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Erro ao consultar dados ao vivo",
      error: String(error.message || error),
    });
  }
});

app.get("/api/admin/live", requireAuth, requireAdmin, async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    if (!deviceId) {
      return res.status(400).json({ success: false, message: "TUYA_DEVICE_ID não está no .env" });
    }

    const status = await getDeviceStatus(deviceId);
    const workState = findDp(status, "work_state")?.value || null;
    const sw = findDp(status, "switch")?.value ?? false;

    const currentSet = readDpNumber(status, "charge_cur_set");
    const totalRaw = readDpNumber(status, "forward_energy_total");

    const totalKwh = scale2ToKwh(totalRaw);
    let powerKw = pickPowerKwFromStatus(status);
    const charging = (workState === "charger_charging") || (sw === true);

    const running = db.prepare(`
      SELECT
        s.id,
        s.user_id,
        s.start_time,
        s.start_energy_total,
        s.status,
        u.name,
        u.email,
        u.cpf,
        u.role,
        u.tower,
        u.apartment
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.status = 'running'
      ORDER BY s.id DESC
      LIMIT 1
    `).get();

    let session = null;
    if (running) {
      const elapsedSeconds = calcElapsedSecondsFromSqlite(running.start_time);
      let kwhEstimated = 0;

      if (typeof running.start_energy_total === "number" && typeof totalKwh === "number") {
        kwhEstimated = Math.max(0, totalKwh - running.start_energy_total);
      }

      const tariff = getTariffPerKwh();
      const priceEstimated = Number.isFinite(tariff)
        ? Number((kwhEstimated * tariff).toFixed(2))
        : null;

      session = {
        id: running.id,
        user_id: running.user_id,
        start_time: running.start_time,
        elapsedSeconds,
        kwhEstimated: Number(kwhEstimated.toFixed(2)),
        priceEstimated,
        user: running.user_id ? {
          name: running.name,
          email: running.email,
          cpf: running.cpf,
          role: running.role,
          tower: running.tower,
          apartment: running.apartment,
        } : null,
      };
    }

    if ((powerKw == null || powerKw <= 0) && session) {
      const estimatedPower = estimatePowerKwFromSession(session.kwhEstimated, session.elapsedSeconds);
      if (estimatedPower != null) powerKw = estimatedPower;
    }

    const stateLabel = pickChargerStateLabel(workState, sw);

    return res.json({
      success: true,
      stateLabel,
      charging,
      workState,
      switch: sw,
      powerKw: powerKw != null ? Number(powerKw.toFixed(2)) : null,
      currentSetA: currentSet != null ? currentSet : null,
      totalKwh: totalKwh != null ? Number(totalKwh.toFixed(2)) : null,
      runningSession: session,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Erro ao consultar painel admin",
      error: String(error.message || error),
    });
  }
});
// ===============================
// HISTÓRICO DO USUÁRIO
// ===============================
app.get("/api/my-sessions", requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        id,
        status,
        start_time,
        end_time,
        energy_once,
        price_calculated,
        price_override,
        paid,
        paid_at,
        duration_seconds
      FROM sessions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(req.user.id);

    return res.json({ success: true, sessions: rows });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Erro ao buscar histórico",
      error: String(error.message || error),
    });
  }
});

// ===============================
// ADMIN - listar todas as sessões
// ===============================
app.get("/sessions", requireAuth, requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT *
      FROM sessions
      ORDER BY id DESC
      LIMIT 100
    `).all();
    return res.json({ success: true, sessions: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar sessões", error: String(error.message || error) });
  }
});

// ADMIN: sessões running
app.get("/admin/running-sessions", requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT id, user_id, status, start_time
    FROM sessions
    WHERE status = 'running'
    ORDER BY id DESC
  `).all();

  return res.json({ success: true, running: rows });
});

app.get("/admin/users", requireAuth, requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, name, role, tower, apartment, email
      FROM users
      ORDER BY tower, apartment, name
    `).all();

    return res.json({ success: true, users: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar usuários", error: String(error.message || error) });
  }
});

// ADMIN: força fechar running
app.post("/admin/force-close-running", requireAuth, requireAdmin, (req, res) => {
  const result = db.prepare(`
    UPDATE sessions
    SET status = 'done',
        end_time = datetime('now','localtime')
    WHERE status = 'running'
  `).run();

  return res.json({ success: true, closed: result.changes });
});

// ADMIN: marcar pago/não pago
app.post("/admin/set-paid", requireAuth, requireAdmin, (req, res) => {
  try {
    const { sessionId, paid } = req.body || {};
    const id = Number(sessionId);
    const p = paid ? 1 : 0;

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "sessionId inválido" });
    }

    db.prepare(`
      UPDATE sessions
      SET paid = ?,
          paid_at = CASE WHEN ? = 1 THEN datetime('now','localtime') ELSE NULL END
      WHERE id = ?
    `).run(p, p, id);

    return res.json({ success: true, message: "Atualizado." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao atualizar pago", error: String(error.message || error) });
  }
});

app.post("/admin/session/start", requireAuth, requireAdmin, async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    if (!deviceId) return res.status(400).json({ success: false, message: "TUYA_DEVICE_ID não está no .env" });

    const userId = Number(req.body?.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: "Envie { userId } válido." });
    }

    const anyRunning = db.prepare(`
      SELECT id, user_id FROM sessions
      WHERE status='running'
      ORDER BY id DESC LIMIT 1
    `).get();

    if (anyRunning) {
      return res.status(409).json({
        success: false,
        message: `Já existe uma sessão em andamento (ID ${anyRunning.id}).`,
      });
    }

    const user = db.prepare(`
      SELECT id, name, apartment, tower
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: "Usuário não encontrado." });
    }

    const statusBefore = await getDeviceStatus(deviceId);
    const onceRawBefore = findDp(statusBefore, "charge_energy_once")?.value;
    const totalRawBefore = findDp(statusBefore, "forward_energy_total")?.value;
    const startEnergyTotal = scale2ToKwh(totalRawBefore);

    const userLabel = `Apto ${user.apartment} (${user.tower}) - ${user.name}`;

    const result = db.prepare(`
      INSERT INTO sessions (user, user_id, status, start_time, start_energy_total, start_once_raw, paid)
      VALUES (?, ?, 'running', datetime('now','localtime'), ?, ?, 0)
    `).run(
      userLabel,
      user.id,
      startEnergyTotal,
      (typeof onceRawBefore === "number" ? onceRawBefore : null)
    );

    const sessionId = result.lastInsertRowid;

    await sendCommands(deviceId, [{ code: "switch", value: false }]);
    await sleep(300);
    await sendCommands(deviceId, [{ code: "clear_energy", value: true }]);
    await sleep(500);
    await sendCommands(deviceId, [{ code: "clear_energy", value: false }]);
    await sleep(300);
    await sendCommands(deviceId, [{ code: "work_mode", value: "charge_now" }]);
    await sleep(200);
    await sendCommands(deviceId, [{ code: "charge_cur_set", value: 32 }]);
    await sleep(200);
    await sendCommands(deviceId, [{ code: "switch", value: true }]);

    let started = false;
    let lastStatus = null;

    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      lastStatus = await getDeviceStatus(deviceId);
      const ws = findDp(lastStatus, "work_state")?.value;
      const sw = findDp(lastStatus, "switch")?.value;
      if (ws === "charger_charging" || sw === true) {
        started = true;
        break;
      }
    }

    if (!started) {
      await sendCommands(deviceId, [{ code: "switch", value: false }]);
      db.prepare(`
        UPDATE sessions
        SET status='done', end_time=datetime('now','localtime')
        WHERE id=?
      `).run(sessionId);

      const diag = diagnoseStartFailure(lastStatus);

      return res.status(409).json({
        success: false,
        message: diag.reasonMessage,
        reasonCode: diag.reasonCode,
        sessionId,
        debug: {
          work_state: findDp(lastStatus, "work_state")?.value || null,
          connection_state: findDp(lastStatus, "connection_state")?.value || null,
          switch: findDp(lastStatus, "switch")?.value ?? null,
        },
      });
    }

    return res.json({ success: true, message: "Sessão iniciada (admin).", sessionId });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao iniciar (admin)", error: String(error.message || error) });
  }
});

app.post("/admin/session/stop", requireAuth, requireAdmin, async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    if (!deviceId) return res.status(400).json({ success: false, message: "TUYA_DEVICE_ID não está no .env" });

    const running = db.prepare(`
      SELECT *
      FROM sessions
      WHERE status='running'
      ORDER BY id DESC
      LIMIT 1
    `).get();

    if (!running) {
      return res.status(400).json({ success: false, message: "Nenhuma sessão running no momento." });
    }

    await sendCommands(deviceId, [{ code: "switch", value: false }]);

    let status = null;
    let onceRaw = null;
    let lastOnceRaw = null;
    let stableCount = 0;

    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      status = await getDeviceStatus(deviceId);

      const sw = findDp(status, "switch")?.value;
      const ws = findDp(status, "work_state")?.value;
      onceRaw = findDp(status, "charge_energy_once")?.value;

      const stoppedOk = (sw === false) && (ws === "charger_end" || ws === "charger_free");
      if (!stoppedOk) continue;
      if (typeof onceRaw !== "number") continue;
      if (running.start_once_raw != null && onceRaw === running.start_once_raw) continue;

      if (lastOnceRaw === null) {
        lastOnceRaw = onceRaw;
        stableCount = 0;
        continue;
      }

      if (onceRaw === lastOnceRaw) stableCount += 1;
      else {
        lastOnceRaw = onceRaw;
        stableCount = 0;
      }

      if (stableCount >= 3) break;
    }

    const energyOnce = (typeof onceRaw === "number") ? onceRaw / 100 : null;
    const durationSeconds = calcDurationSeconds(running.start_time);

    const tariff = getTariffPerKwh();
    const priceCalculated = (typeof energyOnce === "number")
      ? Number((energyOnce * tariff).toFixed(2))
      : null;

    db.prepare(`
      UPDATE sessions
      SET status='done',
          end_time=datetime('now','localtime'),
          energy_once=?,
          end_once_raw=?,
          duration_seconds=?,
          price_calculated=?
      WHERE id=?
    `).run(
      energyOnce,
      (typeof onceRaw === "number" ? onceRaw : null),
      durationSeconds,
      priceCalculated,
      running.id
    );

    return res.json({
      success: true,
      message: "Sessão finalizada (admin).",
      sessionId: running.id,
      energy_once: energyOnce,
      duration_seconds: durationSeconds,
      price_calculated: priceCalculated,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao parar (admin)", error: String(error.message || error) });
  }
});

// ===============================
// Sessão START (usuário)
// ===============================
app.post("/session/start", requireAuth, async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    if (!deviceId) {
      return res.status(400).json({ success: false, message: "TUYA_DEVICE_ID não estão no .env" });
    }

    const userId = req.user.id;

    // BLOQUEIO GLOBAL: só 1 sessão no condomínio
    const anyRunning = db.prepare(`
      SELECT id, user_id
      FROM sessions
      WHERE status = 'running'
      ORDER BY id DESC
      LIMIT 1
    `).get();

    if (anyRunning) {
      return res.status(409).json({
        success: false,
        message: `Já existe uma sessão em andamento (ID ${anyRunning.id}). Pare a sessão atual antes de iniciar outra.`,
      });
    }

    // Status antes (baseline)
    const statusBefore = await getDeviceStatus(deviceId);

    const onceRawBefore = findDp(statusBefore, "charge_energy_once")?.value;
    const totalRawBefore = findDp(statusBefore, "forward_energy_total")?.value;

    const startEnergyTotal = scale2ToKwh(totalRawBefore);

    // userLabel (legado)
    const userLabel =
      req.user.apartment ? `Apto ${req.user.apartment}` :
      req.user.name ? req.user.name :
      `User ${req.user.id}`;

    // cria sessão running
    const insert = db.prepare(`
      INSERT INTO sessions (user, user_id, status, start_time, start_energy_total, start_once_raw, paid)
      VALUES (?, ?, 'running', datetime('now','localtime'), ?, ?, 0)
    `);

    const result = insert.run(
      userLabel,
      userId,
      startEnergyTotal,
      typeof onceRawBefore === "number" ? onceRawBefore : null
    );

    const sessionId = result.lastInsertRowid;

    // ===============================
    // START robusto (reset + start)
    // ===============================

    // 1) garante OFF
    await sendCommands(deviceId, [{ code: "switch", value: false }]);
    await sleep(300);

    // 2) pulso clear_energy (ajuda a "destravar")
    await sendCommands(deviceId, [{ code: "clear_energy", value: true }]);
    await sleep(500);
    await sendCommands(deviceId, [{ code: "clear_energy", value: false }]);
    await sleep(300);

    // 3) seta modo e corrente (separado é mais confiável em alguns EVSE)
    await sendCommands(deviceId, [{ code: "work_mode", value: "charge_now" }]);
    await sleep(200);

    await sendCommands(deviceId, [{ code: "charge_cur_set", value: 32 }]);
    await sleep(200);

    // 4) liga
    await sendCommands(deviceId, [{ code: "switch", value: true }]);

    // 5) polling para confirmar
    let started = false;
    let lastStatus = null;

    for (let i = 0; i < 15; i++) { // ~15s
      await sleep(1000);
      lastStatus = await getDeviceStatus(deviceId);

      const ws = findDp(lastStatus, "work_state")?.value;
      const sw = findDp(lastStatus, "switch")?.value;

      if (ws === "charger_charging" || sw === true) {
        started = true;
        break;
      }
    }

    if (!started) {
      // desfaz
      await sendCommands(deviceId, [{ code: "switch", value: false }]);

      db.prepare(`
        UPDATE sessions
        SET status = 'done',
            end_time = datetime('now','localtime')
        WHERE id = ?
      `).run(sessionId);

      const diag = diagnoseStartFailure(lastStatus);
      const debug = {
        work_state: findDp(lastStatus, "work_state")?.value || null,
        connection_state: findDp(lastStatus, "connection_state")?.value || null,
        switch: findDp(lastStatus, "switch")?.value ?? null,
      };

      return res.status(409).json({
        success: false,
        message: diag.reasonMessage,
        reasonCode: diag.reasonCode,
        sessionId,
        debug,
      });
    }

    return res.json({
      success: true,
      message: "Sessão iniciada com sucesso.",
      sessionId,
    });

  } catch (error) {
    console.error("ERRO /session/start:", error);
    return res.status(500).json({
      success: false,
      message: "Erro ao iniciar a sessão",
      error: String(error.message || error),
    });
  }
});

// ===============================
// Sessão STOP (usuário)
// ===============================
app.post("/session/stop", requireAuth, async (req, res) => {
  try {
    const deviceId = process.env.TUYA_DEVICE_ID;
    if (!deviceId) return res.status(400).json({ success: false, message: "TUYA_DEVICE_ID não está no .env" });

    // sessão running do usuário
    const running = db.prepare(`
      SELECT *
      FROM sessions
      WHERE status = 'running' AND user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(req.user.id);

    if (!running) {
      return res.status(400).json({ success: false, message: "Nenhuma sessão em andamento encontrada." });
    }

    const baseline = running.start_once_raw;

    // manda STOP
    await sendCommands(deviceId, [{ code: "switch", value: false }]);

    // polling: espera charge_energy_once "atualizar e estabilizar"
    let status = null;
    let onceRaw = null;
    let lastOnceRaw = null;
    let stableCount = 0;

    for (let i = 0; i < 60; i++) {
      await sleep(1000);

      status = await getDeviceStatus(deviceId);

      const sw = findDp(status, "switch")?.value;
      const ws = findDp(status, "work_state")?.value;
      onceRaw = findDp(status, "charge_energy_once")?.value;

      const stoppedOk = (sw === false) && (ws === "charger_end" || ws === "charger_free");
      if (!stoppedOk) continue;

      if (typeof onceRaw !== "number") continue;

      if (baseline != null && onceRaw === baseline) continue;

      if (lastOnceRaw === null) {
        lastOnceRaw = onceRaw;
        stableCount = 0;
        continue;
      }

      if (onceRaw === lastOnceRaw) stableCount += 1;
      else {
        lastOnceRaw = onceRaw;
        stableCount = 0;
      }

      if (stableCount >= 3) break; // ~3s estável
    }

    const energyOnce = typeof onceRaw === "number" ? onceRaw / 100 : null;

    const durationSeconds = calcDurationSeconds(running.start_time);

    // preço (tarifa * kWh)
    const tariff = getTariffPerKwh();
    const priceCalculated = (typeof energyOnce === "number") ? Number((energyOnce * tariff).toFixed(2)) : null;

    db.prepare(`
      UPDATE sessions
      SET status = 'done',
          end_time = datetime('now','localtime'),
          energy_once = ?,
          end_once_raw = ?,
          duration_seconds = ?,
          price_calculated = ?
      WHERE id = ?
    `).run(
      energyOnce,
      (typeof onceRaw === "number" ? onceRaw : null),
      durationSeconds,
      priceCalculated,
      running.id
    );

    return res.json({
      success: true,
      message: "Sessão finalizada.",
      sessionId: running.id,
      energy_once: energyOnce,
      duration_seconds: durationSeconds,
      price_calculated: priceCalculated,
      end_work_state: findDp(status, "work_state")?.value || null,
      end_connection_state: findDp(status, "connection_state")?.value || null,
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Erro ao finalizar sessão",
      error: String(error.message || error),
    });
  }
});

// ===============================
// Start server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
