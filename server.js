require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const { getDeviceStatus, sendCommands } = require("./tuya_api");
const pgDb = require("./db/pg");
const usersRepo = require("./repositories/usersRepo");
const addressesRepo = require("./repositories/addressesRepo");
const stationsRepo = require("./repositories/stationsRepo");
const sessionsRepo = require("./repositories/sessionsRepo");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function round2(value) {
  const n = toFiniteNumber(value);
  if (n == null) return null;
  return Number(n.toFixed(2));
}

function findDp(statusData, code) {
  const arr = statusData?.result || [];
  return arr.find((item) => item.code === code);
}

function readDpNumber(statusData, code) {
  return toFiniteNumber(findDp(statusData, code)?.value);
}

function scale2ToKwh(raw) {
  const n = toFiniteNumber(raw);
  if (n == null) return null;
  return n / 100;
}

function pickPowerKwFromStatus(statusData) {
  const raw =
    readDpNumber(statusData, "power_total") ??
    readDpNumber(statusData, "cur_power") ??
    readDpNumber(statusData, "charge_power") ??
    readDpNumber(statusData, "power");

  if (raw == null) return null;
  if (raw <= 0) return 0;
  return raw > 30 ? raw / 1000 : raw;
}

function calcElapsedSeconds(startTimeValue) {
  if (!startTimeValue) return 0;
  const start = startTimeValue instanceof Date ? startTimeValue : new Date(startTimeValue);
  if (Number.isNaN(start.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
}

function estimatePowerKwFromSession(kwhEstimated, elapsedSeconds) {
  const kwh = toFiniteNumber(kwhEstimated);
  const sec = toFiniteNumber(elapsedSeconds);
  if (kwh == null || sec == null || sec <= 0) return null;
  const kw = kwh / (sec / 3600);
  if (!Number.isFinite(kw) || kw < 0) return null;
  return kw;
}

function pickChargerStateLabel(workState, sw) {
  if (sw === true || workState === "charger_charging") return "Carregando";
  if (workState === "charger_end") return "Finalizado (carro ainda conectado)";
  if (workState === "charger_free") return "Livre";
  return `Estado: ${workState || "desconhecido"}`;
}

function getTariffPerKwh() {
  const n = Number(process.env.PRICE_PER_KWH);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function isDatabaseUnavailableError(error) {
  const message = String(error?.message || error || "");
  const code = String(error?.code || "");

  if (message.includes("AggregateError")) return true;
  if (message.includes("ECONNREFUSED")) return true;
  if (message.includes("ENOTFOUND")) return true;
  if (message.includes("ETIMEDOUT")) return true;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") return true;

  return false;
}

function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET nao configurado no .env");
  return jwt.sign(payload, secret, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
}

function setAuthCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
  });
}

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ success: false, message: "Nao autenticado." });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = Number(decoded?.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ success: false, message: "Token invalido." });
    }

    const user = await usersRepo.findById(userId);
    if (!user) return res.status(401).json({ success: false, message: "Usuario nao encontrado." });

    req.user = user;
    return next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Token invalido ou expirado." });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.is_admin !== true) {
    return res.status(403).json({ success: false, message: "Acesso restrito a administradores." });
  }
  return next();
}

function diagnoseStartFailure(statusData) {
  if (!statusData) {
    return {
      reasonCode: "no_status_after_start",
      reasonMessage: "Nao foi possivel confirmar status do carregador apos iniciar.",
    };
  }

  const workState = findDp(statusData, "work_state")?.value || null;
  const connectionState = findDp(statusData, "connection_state")?.value || null;
  const sw = findDp(statusData, "switch")?.value ?? null;
  const connected = Boolean(connectionState && connectionState !== "controlpi_12v");

  if (!connected) {
    return {
      reasonCode: "vehicle_not_connected",
      reasonMessage: "Carro nao detectado pelo carregador (cabo/plug/estado do veiculo).",
    };
  }

  if (sw !== true) {
    return {
      reasonCode: "switch_not_on",
      reasonMessage: "Comando de ligar nao foi mantido pelo carregador.",
    };
  }

  if (workState && workState !== "charger_charging") {
    return {
      reasonCode: "not_in_charging_state",
      reasonMessage: `Carregador ligado, mas fora de charging (work_state=${workState}).`,
    };
  }

  return {
    reasonCode: "start_not_confirmed",
    reasonMessage: "Nao foi possivel confirmar o inicio da carga no tempo esperado.",
  };
}

function isUniqueRunningByStation(error) {
  return error?.code === "23505" && error?.constraint === "ux_sessions_one_running_per_station";
}

function isUniqueRunningByUser(error) {
  return error?.code === "23505" && error?.constraint === "ux_sessions_one_running_per_user";
}

async function getStationForOperation(stationId, requireActive = true) {
  const station = await stationsRepo.getById(stationId);
  if (!station) return null;
  if (requireActive && station.is_active !== true) return null;
  return station;
}

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/health/db", async (req, res) => {
  try {
    await pgDb.healthcheck();
    return res.status(200).json({ ok: true, db: "postgres" });
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return res.status(503).json({
        ok: false,
        error: "Postgres indisponivel",
        message: "Nao foi possivel conectar ao banco. Verifique DATABASE_URL e se o Postgres esta ativo.",
      });
    }
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.get("/", (req, res) => {
  res.send("Servidor do Carregador rodando. Use /health para testar.");
});

app.post("/auth/register", async (req, res) => {
  try {
    let { name, email, cpf, password, role, tower, apartment } = req.body || {};

    name = (name || "").trim();
    email = (email || "").trim().toLowerCase();
    cpf = (cpf || "").replace(/\D/g, "");
    apartment = (apartment || "").trim();
    role = (role || "").trim().toLowerCase();
    tower = (tower || "").trim().toLowerCase();
    password = String(password || "");

    if (!name) return res.status(400).json({ success: false, message: "Nome e obrigatorio." });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Email invalido." });
    }
    if (!cpf || cpf.length !== 11) {
      return res.status(400).json({ success: false, message: "CPF invalido (11 numeros)." });
    }
    if (!apartment) return res.status(400).json({ success: false, message: "Apartamento e obrigatorio." });
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: "Senha deve ter no minimo 8 caracteres." });
    }

    const allowedRoles = ["resident", "visitor", "admin"];
    const allowedTowers = ["mississipi", "missouri"];

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "role invalido. Use resident|visitor|admin." });
    }
    if (!allowedTowers.includes(tower)) {
      return res.status(400).json({ success: false, message: "tower invalida. Use mississipi|missouri." });
    }

    const user = await usersRepo.create({
      name,
      email,
      password_hash: bcrypt.hashSync(password, 10),
      is_admin: role === "admin",
      cpf,
      role,
      tower,
      apartment,
    });

    return res.json({
      success: true,
      message: "Usuario cadastrado.",
      user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin },
    });
  } catch (error) {
    if (error?.code === "DUPLICATE_EMAIL") {
      return res.status(409).json({ success: false, message: "Email ja cadastrado" });
    }
    return res.status(500).json({ success: false, message: "Erro ao cadastrar usuario.", error: String(error.message || error) });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    let { email, emailOrCpf, password } = req.body || {};
    email = String(email || emailOrCpf || "").trim().toLowerCase();
    password = String(password || "");

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Email invalido." });
    }
    if (!password) return res.status(400).json({ success: false, message: "Informe a senha." });

    const user = await usersRepo.findByEmail(email);
    if (!user) return res.status(401).json({ success: false, message: "Credenciais invalidas." });

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ success: false, message: "Credenciais invalidas." });

    setAuthCookie(res, signToken({ id: user.id }));
    return res.json({
      success: true,
      message: "Login ok",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        is_admin: user.is_admin,
        tower: user.tower,
        apartment: user.apartment,
      },
    });
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return res.status(503).json({
        success: false,
        message: "Banco de dados indisponivel. Verifique o Postgres e a DATABASE_URL.",
      });
    }
    return res.status(500).json({ success: false, message: "Erro no login", error: String(error.message || error) });
  }
});

app.get("/auth/me", requireAuth, (req, res) => res.json({ success: true, user: req.user }));
app.post("/auth/logout", (req, res) => {
  res.clearCookie("token");
  return res.json({ success: true, message: "Logout ok" });
});

app.get("/api/my/addresses", requireAuth, async (req, res) => {
  try {
    const addresses = await addressesRepo.listByUser(req.user.id);
    return res.json({ success: true, addresses });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar enderecos", error: String(error.message || error) });
  }
});

app.post("/api/my/addresses", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const label = String(body.label || "").trim();
    if (!label) return res.status(400).json({ success: false, message: "label e obrigatorio." });

    const address = await addressesRepo.createForUser(req.user.id, {
      label,
      street: body.street == null ? null : String(body.street).trim(),
      number: body.number == null ? null : String(body.number).trim(),
      complement: body.complement == null ? null : String(body.complement).trim(),
      neighborhood: body.neighborhood == null ? null : String(body.neighborhood).trim(),
      city: body.city == null ? null : String(body.city).trim(),
      state: body.state == null ? null : String(body.state).trim(),
      zip: body.zip == null ? null : String(body.zip).trim(),
      is_default: body.is_default === true,
    });

    return res.status(201).json({ success: true, address });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao criar endereco", error: String(error.message || error) });
  }
});

app.patch("/api/my/addresses/:id", requireAuth, async (req, res) => {
  try {
    const addressId = parsePositiveInt(req.params.id);
    if (!addressId) return res.status(400).json({ success: false, message: "id invalido." });

    const body = req.body || {};
    const payload = {};
    for (const field of ["label", "street", "number", "complement", "neighborhood", "city", "state", "zip"]) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        payload[field] = body[field] == null ? null : String(body[field]).trim();
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, "label") && !payload.label) {
      return res.status(400).json({ success: false, message: "label e obrigatorio." });
    }
    if (Object.prototype.hasOwnProperty.call(body, "is_default")) {
      if (typeof body.is_default !== "boolean") {
        return res.status(400).json({ success: false, message: "is_default deve ser boolean." });
      }
      payload.is_default = body.is_default;
    }

    const updated = await addressesRepo.updateForUser(addressId, req.user.id, payload);
    if (!updated) return res.status(404).json({ success: false, message: "Endereco nao encontrado." });
    return res.json({ success: true, address: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao atualizar endereco", error: String(error.message || error) });
  }
});

app.delete("/api/my/addresses/:id", requireAuth, async (req, res) => {
  try {
    const addressId = parsePositiveInt(req.params.id);
    if (!addressId) return res.status(400).json({ success: false, message: "id invalido." });

    const deleted = await addressesRepo.deleteForUser(addressId, req.user.id);
    if (!deleted) return res.status(404).json({ success: false, message: "Endereco nao encontrado." });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao remover endereco", error: String(error.message || error) });
  }
});

app.get("/api/stations", requireAuth, async (req, res) => {
  try {
    const stations = await stationsRepo.listActive();
    return res.json({
      success: true,
      stations: stations.map((station) => ({
        id: station.id,
        name: station.name,
        location_label: station.location_label,
        max_current_a: station.max_current_a,
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar estacoes", error: String(error.message || error) });
  }
});

app.get("/api/admin/stations", requireAuth, requireAdmin, async (req, res) => {
  try {
    const stations = await stationsRepo.listAll();
    return res.json({ success: true, stations });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar estacoes", error: String(error.message || error) });
  }
});

app.post("/api/admin/stations", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const tuyaDeviceId = String(body.tuya_device_id || "").trim();
    const locationLabel = body.location_label == null ? null : String(body.location_label).trim();
    const maxCurrentA = body.max_current_a == null ? 32 : Number(body.max_current_a);
    const isActive = body.is_active !== false;

    if (!name) return res.status(400).json({ success: false, message: "name e obrigatorio." });
    if (!tuyaDeviceId) return res.status(400).json({ success: false, message: "tuya_device_id e obrigatorio." });
    if (!Number.isInteger(maxCurrentA) || maxCurrentA <= 0) {
      return res.status(400).json({ success: false, message: "max_current_a invalido." });
    }

    const station = await stationsRepo.create({
      name,
      location_label: locationLabel,
      tuya_device_id: tuyaDeviceId,
      max_current_a: maxCurrentA,
      is_active: isActive,
    });

    return res.status(201).json({ success: true, station });
  } catch (error) {
    if (error?.code === "DUPLICATE_TUYA_DEVICE") {
      return res.status(409).json({ success: false, message: "tuya_device_id ja cadastrado." });
    }
    return res.status(500).json({ success: false, message: "Erro ao criar estacao", error: String(error.message || error) });
  }
});

app.patch("/api/admin/stations/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const stationId = parsePositiveInt(req.params.id);
    if (!stationId) return res.status(400).json({ success: false, message: "id invalido." });

    const body = req.body || {};
    const payload = {};

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      payload.name = String(body.name || "").trim();
      if (!payload.name) return res.status(400).json({ success: false, message: "name e obrigatorio." });
    }
    if (Object.prototype.hasOwnProperty.call(body, "location_label")) {
      payload.location_label = body.location_label == null ? null : String(body.location_label).trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, "tuya_device_id")) {
      payload.tuya_device_id = String(body.tuya_device_id || "").trim();
      if (!payload.tuya_device_id) {
        return res.status(400).json({ success: false, message: "tuya_device_id e obrigatorio." });
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "max_current_a")) {
      const maxCurrentA = Number(body.max_current_a);
      if (!Number.isInteger(maxCurrentA) || maxCurrentA <= 0) {
        return res.status(400).json({ success: false, message: "max_current_a invalido." });
      }
      payload.max_current_a = maxCurrentA;
    }
    if (Object.prototype.hasOwnProperty.call(body, "is_active")) {
      if (typeof body.is_active !== "boolean") {
        return res.status(400).json({ success: false, message: "is_active deve ser boolean." });
      }
      payload.is_active = body.is_active;
    }

    const station = Object.prototype.hasOwnProperty.call(payload, "is_active") && Object.keys(payload).length === 1
      ? await stationsRepo.setActive(stationId, payload.is_active)
      : await stationsRepo.update(stationId, payload);

    if (!station) return res.status(404).json({ success: false, message: "Estacao nao encontrada." });
    return res.json({ success: true, station });
  } catch (error) {
    if (error?.code === "DUPLICATE_TUYA_DEVICE") {
      return res.status(409).json({ success: false, message: "tuya_device_id ja cadastrado." });
    }
    return res.status(500).json({ success: false, message: "Erro ao atualizar estacao", error: String(error.message || error) });
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await usersRepo.listBasic();
    return res.json({ success: true, users });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar usuarios", error: String(error.message || error) });
  }
});

app.get("/api/admin/users/:id/addresses", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) return res.status(400).json({ success: false, message: "user id invalido." });

    const addresses = await addressesRepo.listByUser(userId);
    return res.json({ success: true, addresses });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar enderecos do usuario", error: String(error.message || error) });
  }
});

async function safeSwitchOff(deviceId) {
  try {
    await sendCommands(deviceId, [{ code: "switch", value: false }]);
  } catch (_error) {
    // no-op
  }
}

async function runStartCommands(station) {
  const deviceId = station.tuya_device_id;
  const currentA = Number.isInteger(station.max_current_a) && station.max_current_a > 0
    ? station.max_current_a
    : 32;

  await safeSwitchOff(deviceId);
  await sleep(300);
  await sendCommands(deviceId, [{ code: "work_mode", value: "charge_now" }]);
  await sleep(200);
  await sendCommands(deviceId, [{ code: "charge_cur_set", value: currentA }]);
  await sleep(200);
  await sendCommands(deviceId, [{ code: "switch", value: true }]);

  let started = false;
  let lastStatus = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    lastStatus = await getDeviceStatus(deviceId);
    const workState = findDp(lastStatus, "work_state")?.value;
    const sw = findDp(lastStatus, "switch")?.value;
    if (workState === "charger_charging" || sw === true) {
      started = true;
      break;
    }
  }
  return { started, lastStatus };
}

async function runStopPolling(station) {
  const deviceId = station.tuya_device_id;
  await safeSwitchOff(deviceId);

  let lastStatus = null;
  let lastOnceKwh = null;
  let stableCount = 0;

  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    lastStatus = await getDeviceStatus(deviceId);

    const sw = findDp(lastStatus, "switch")?.value;
    const workState = findDp(lastStatus, "work_state")?.value;
    const powerKw = pickPowerKwFromStatus(lastStatus);
    const onceRaw = readDpNumber(lastStatus, "charge_energy_once");
    const onceKwh = onceRaw == null ? null : onceRaw / 100;

    const stoppedState = sw === false && (
      workState === "charger_end" ||
      workState === "charger_free" ||
      workState === "charger_wait" ||
      workState === "charger_idle"
    );
    const stopped = stoppedState || (powerKw != null && powerKw <= 0.05);

    if (!stopped || onceKwh == null) continue;

    if (lastOnceKwh == null) {
      lastOnceKwh = onceKwh;
      continue;
    }

    const delta = Math.abs(onceKwh - lastOnceKwh);
    stableCount = (delta === 0 || delta < 0.01) ? stableCount + 1 : 0;
    lastOnceKwh = onceKwh;

    if (stableCount >= 1) break;
  }

  if (!lastStatus) {
    lastStatus = await getDeviceStatus(deviceId);
  }
  return lastStatus;
}

async function finalizeSessionAsFailed(sessionId, message) {
  try {
    await sessionsRepo.finishSession(sessionId, {
      status: "failed",
      end_time: new Date(),
      needs_review: true,
      notes: message,
    });
  } catch (_error) {
    // no-op
  }
}

async function startSessionFlow({ userId, addressId, station }) {
  const statusBefore = await getDeviceStatus(station.tuya_device_id);
  const totalRawBefore = readDpNumber(statusBefore, "forward_energy_total");

  const session = await sessionsRepo.createRunning({
    user_id: userId,
    address_id: addressId,
    station_id: station.id,
    start_energy_total: scale2ToKwh(totalRawBefore),
    tariff_per_kwh: getTariffPerKwh(),
  });

  try {
    const { started, lastStatus } = await runStartCommands(station);
    if (!started) {
      await safeSwitchOff(station.tuya_device_id);
      const diag = diagnoseStartFailure(lastStatus);
      await finalizeSessionAsFailed(session.id, diag.reasonMessage);
      return {
        success: false,
        statusCode: 409,
        body: {
          success: false,
          message: diag.reasonMessage,
          reasonCode: diag.reasonCode,
          sessionId: session.id,
        },
      };
    }

    return {
      success: true,
      body: { success: true, message: "Sessao iniciada com sucesso.", sessionId: session.id },
    };
  } catch (error) {
    await safeSwitchOff(station.tuya_device_id);
    await finalizeSessionAsFailed(session.id, `Falha ao enviar comandos Tuya: ${String(error.message || error)}`);
    throw error;
  }
}

function computeNeedsReview(energyOnce, energyFromTotal, energyKwh) {
  if (energyKwh == null || energyKwh < 0) return true;
  if (energyOnce == null || energyFromTotal == null) return false;
  const diff = Math.abs(energyOnce - energyFromTotal);
  return diff > Math.max(0.15, energyKwh * 0.2);
}

async function stopSessionFlow({ running, station }) {
  const finalStatus = await runStopPolling(station);

  const energyOnce = (() => {
    const raw = readDpNumber(finalStatus, "charge_energy_once");
    return raw == null ? null : raw / 100;
  })();
  const endEnergyTotal = scale2ToKwh(readDpNumber(finalStatus, "forward_energy_total"));
  const startEnergyTotal = toFiniteNumber(running.start_energy_total);
  const energyFromTotal = startEnergyTotal != null && endEnergyTotal != null
    ? Math.max(0, endEnergyTotal - startEnergyTotal)
    : null;

  const energyKwh = energyOnce != null ? energyOnce : energyFromTotal;
  const energySource = energyOnce != null ? "once" : (energyFromTotal != null ? "total_delta" : null);
  const durationSeconds = calcElapsedSeconds(running.start_time);
  const tariff = getTariffPerKwh();
  const priceCalculated = energyKwh != null ? round2(energyKwh * tariff) : null;
  const needsReview = computeNeedsReview(energyOnce, energyFromTotal, energyKwh);

  await pgDb.withTransaction(async (tx) => {
    await sessionsRepo.finishSession(running.id, {
      status: "done",
      end_time: new Date(),
      duration_seconds: durationSeconds,
      end_energy_total: endEnergyTotal,
      energy_once: energyOnce,
      energy_kwh: energyKwh,
      energy_source: energySource,
      needs_review: needsReview,
      tariff_per_kwh: tariff,
      price_calculated: priceCalculated,
    }, tx);
  });

  return {
    sessionId: running.id,
    duration_seconds: durationSeconds,
    end_energy_total: endEnergyTotal,
    energy_once: energyOnce,
    energy_kwh: energyKwh,
    energy_source: energySource,
    needs_review: needsReview,
    price_calculated: priceCalculated,
    end_work_state: findDp(finalStatus, "work_state")?.value || null,
    end_connection_state: findDp(finalStatus, "connection_state")?.value || null,
  };
}

async function buildLivePayload(stationId) {
  const station = await getStationForOperation(stationId, true);
  if (!station) return null;

  let status = null;
  let telemetryError = null;

  try {
    status = await getDeviceStatus(station.tuya_device_id);
  } catch (error) {
    telemetryError = String(error?.message || error);
  }

  const workState = findDp(status, "work_state")?.value || null;
  const connectionState = findDp(status, "connection_state")?.value || null;
  const sw = findDp(status, "switch")?.value ?? false;
  const charging = workState === "charger_charging" || sw === true;
  const currentSet = readDpNumber(status, "charge_cur_set");
  const totalKwh = scale2ToKwh(readDpNumber(status, "forward_energy_total"));
  let powerKw = pickPowerKwFromStatus(status);

  const running = await sessionsRepo.getRunningByStation(station.id);
  let runningSession = null;

  if (running) {
    const elapsedSeconds = calcElapsedSeconds(running.start_time);
    const startTotal = toFiniteNumber(running.start_energy_total);
    const kwhEstimated = startTotal != null && totalKwh != null ? Math.max(0, totalKwh - startTotal) : null;

    if ((powerKw == null || powerKw <= 0) && kwhEstimated != null) {
      const estimatedPower = estimatePowerKwFromSession(kwhEstimated, elapsedSeconds);
      if (estimatedPower != null) powerKw = estimatedPower;
    }

    runningSession = {
      session_id: running.id,
      user_id: running.user_id,
      start_time: running.start_time,
      elapsed_seconds: elapsedSeconds,
      kwh_estimated: kwhEstimated != null ? round2(kwhEstimated) : null,
      price_estimated: kwhEstimated != null ? round2(kwhEstimated * getTariffPerKwh()) : null,
    };
  }

  return {
    success: true,
    telemetry_unavailable: telemetryError != null,
    telemetry_error: telemetryError,
    station: {
      id: station.id,
      name: station.name,
      location_label: station.location_label,
      max_current_a: station.max_current_a,
    },
    telemetry: {
      charging,
      work_state: workState,
      connection_state: connectionState,
      switch: sw,
      power_kw: powerKw != null ? round2(powerKw) : null,
      current_set_a: currentSet != null ? currentSet : null,
      total_kwh: totalKwh != null ? round2(totalKwh) : null,
      state_label: pickChargerStateLabel(workState, sw),
    },
    running_session: runningSession,
    charging,
    workState,
    connectionState,
    switch: sw,
    powerKw: powerKw != null ? round2(powerKw) : null,
    currentSetA: currentSet != null ? currentSet : null,
    totalKwh: totalKwh != null ? round2(totalKwh) : null,
    stateLabel: pickChargerStateLabel(workState, sw),
    sessionId: runningSession?.session_id || null,
    elapsedSeconds: runningSession?.elapsed_seconds || 0,
    kwhEstimated: runningSession?.kwh_estimated ?? null,
    priceEstimated: runningSession?.price_estimated ?? null,
    runningSession,
  };
}

app.get("/tuya/status", requireAuth, requireAdmin, async (req, res) => {
  try {
    const stationId = parsePositiveInt(req.query.station_id);
    let deviceId = null;

    if (stationId) {
      const station = await stationsRepo.getById(stationId);
      if (!station) return res.status(404).json({ success: false, message: "Estacao nao encontrada." });
      deviceId = station.tuya_device_id;
    } else {
      deviceId = process.env.TUYA_DEVICE_ID || null;
    }

    if (!deviceId) {
      return res.status(400).json({ success: false, message: "Envie station_id ou configure TUYA_DEVICE_ID para fallback." });
    }

    const data = await getDeviceStatus(deviceId);
    return res.json({ success: true, station_id: stationId || null, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Falha ao consultar Tuya", error: String(error.message || error) });
  }
});

app.get("/api/live", requireAuth, async (req, res) => {
  try {
    const stationId = parsePositiveInt(req.query.station_id);
    if (!stationId) return res.status(400).json({ success: false, message: "station_id e obrigatorio." });

    const payload = await buildLivePayload(stationId);
    if (!payload) return res.status(404).json({ success: false, message: "Estacao nao encontrada ou inativa." });
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao consultar dados ao vivo", error: String(error.message || error) });
  }
});

app.get("/api/admin/live", requireAuth, requireAdmin, async (req, res) => {
  try {
    const stationId = parsePositiveInt(req.query.station_id);
    if (!stationId) return res.status(400).json({ success: false, message: "station_id e obrigatorio." });

    const payload = await buildLivePayload(stationId);
    if (!payload) return res.status(404).json({ success: false, message: "Estacao nao encontrada ou inativa." });
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao consultar dados ao vivo", error: String(error.message || error) });
  }
});

app.get("/api/session/current", requireAuth, async (req, res) => {
  try {
    const stationId = parsePositiveInt(req.query.station_id);
    if (!stationId) return res.status(400).json({ success: false, message: "station_id e obrigatorio." });

    const station = await getStationForOperation(stationId, true);
    if (!station) return res.status(404).json({ success: false, message: "Estacao nao encontrada ou inativa." });

    const running = await sessionsRepo.getRunningByStation(station.id);
    if (!running) return res.json({ success: true, active: false, occupied: false, session: null });

    const active = running.user_id === req.user.id;
    return res.json({
      success: true,
      active,
      occupied: true,
      session: {
        session_id: running.id,
        user_id: running.user_id,
        station_id: running.station_id,
        start_time: running.start_time,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao consultar sessao atual", error: String(error.message || error) });
  }
});

app.get("/api/admin/current-sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await sessionsRepo.listCurrentRunning();
    return res.json({
      success: true,
      running: rows.map((session) => ({
        session_id: session.id,
        user_id: session.user_id,
        address_id: session.address_id,
        station_id: session.station_id,
        start_time: session.start_time,
        elapsed_seconds: calcElapsedSeconds(session.start_time),
        user: session.user,
        station: session.station,
        address: session.address,
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar sessoes em andamento", error: String(error.message || error) });
  }
});

app.get("/api/my-sessions", requireAuth, async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit) || 50;
    const offset = Number.isInteger(Number(req.query.offset)) && Number(req.query.offset) >= 0
      ? Number(req.query.offset)
      : 0;

    const sessions = await sessionsRepo.listByUser(req.user.id, limit, offset);
    return res.json({ success: true, sessions });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao buscar historico", error: String(error.message || error) });
  }
});

app.get("/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const sessions = await sessionsRepo.listAdmin({
      user_id: parsePositiveInt(req.query.user_id),
      station_id: parsePositiveInt(req.query.station_id),
      status: req.query.status ? String(req.query.status) : undefined,
      date_from: req.query.date_from ? String(req.query.date_from) : undefined,
      date_to: req.query.date_to ? String(req.query.date_to) : undefined,
      limit: parsePositiveInt(req.query.limit) || 100,
      offset: Number.isInteger(Number(req.query.offset)) && Number(req.query.offset) >= 0
        ? Number(req.query.offset)
        : 0,
    });
    return res.json({ success: true, sessions });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar sessoes", error: String(error.message || error) });
  }
});

app.get("/admin/running-sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await sessionsRepo.listCurrentRunning();
    return res.json({
      success: true,
      running: rows.map((session) => ({
        id: session.id,
        user_id: session.user_id,
        station_id: session.station_id,
        status: session.status,
        start_time: session.start_time,
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar sessoes running", error: String(error.message || error) });
  }
});

app.post("/admin/force-close-running", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await pgDb.query(
      `
        UPDATE sessions
        SET
          status = 'done',
          end_time = NOW(),
          notes = CASE
            WHEN notes IS NULL OR notes = '' THEN 'Encerrada manualmente pelo admin.'
            ELSE notes || ' | Encerrada manualmente pelo admin.'
          END,
          needs_review = TRUE
        WHERE status = 'running'
        RETURNING id
      `
    );
    return res.json({ success: true, closed: rows.length, session_ids: rows.map((row) => row.id) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao forcar encerramento", error: String(error.message || error) });
  }
});

app.post("/admin/set-paid", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parsePositiveInt(req.body?.sessionId);
    if (!id) return res.status(400).json({ success: false, message: "sessionId invalido" });

    let paymentStatus = null;
    if (typeof req.body?.paid === "boolean") {
      paymentStatus = req.body.paid ? "pago" : "pendente";
    } else if (typeof req.body?.payment_status === "string" && req.body.payment_status.trim()) {
      paymentStatus = req.body.payment_status.trim();
    }
    if (!paymentStatus) {
      return res.status(400).json({ success: false, message: "Informe paid (boolean) ou payment_status (string)." });
    }

    const updated = await sessionsRepo.updateAdminFields(id, { payment_status: paymentStatus });
    if (!updated) return res.status(404).json({ success: false, message: "Sessao nao encontrada." });
    return res.json({ success: true, session: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao atualizar pagamento", error: String(error.message || error) });
  }
});

app.post("/session/start", requireAuth, async (req, res) => {
  try {
    const stationId = parsePositiveInt(req.body?.station_id);
    const addressId = parsePositiveInt(req.body?.address_id);
    if (!stationId) return res.status(400).json({ success: false, message: "station_id e obrigatorio." });
    if (!addressId) return res.status(400).json({ success: false, message: "address_id e obrigatorio." });

    const station = await getStationForOperation(stationId, true);
    if (!station) return res.status(404).json({ success: false, message: "Estacao nao encontrada ou inativa." });

    const address = await addressesRepo.getByIdForUser(addressId, req.user.id);
    if (!address) {
      return res.status(400).json({ success: false, message: "address_id nao pertence ao usuario logado." });
    }

    const userRunning = await sessionsRepo.getRunningByUser(req.user.id);
    if (userRunning) {
      return res.status(409).json({ success: false, message: "Voce ja tem sessao em andamento." });
    }

    let started;
    try {
      started = await startSessionFlow({ userId: req.user.id, addressId: address.id, station });
    } catch (error) {
      if (isUniqueRunningByStation(error)) return res.status(409).json({ success: false, message: "Estacao ocupada" });
      if (isUniqueRunningByUser(error)) return res.status(409).json({ success: false, message: "Voce ja tem sessao em andamento" });
      throw error;
    }

    if (!started.success) return res.status(started.statusCode).json(started.body);
    return res.json(started.body);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao iniciar a sessao", error: String(error.message || error) });
  }
});

app.post("/admin/session/start", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parsePositiveInt(req.body?.userId);
    const stationId = parsePositiveInt(req.body?.station_id);
    const reqAddressId = parsePositiveInt(req.body?.address_id);
    if (!userId) return res.status(400).json({ success: false, message: "userId e obrigatorio." });
    if (!stationId) return res.status(400).json({ success: false, message: "station_id e obrigatorio." });

    const user = await usersRepo.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "Usuario nao encontrado." });

    const station = await getStationForOperation(stationId, true);
    if (!station) return res.status(404).json({ success: false, message: "Estacao nao encontrada ou inativa." });

    let address = null;
    if (reqAddressId) {
      address = await addressesRepo.getByIdForUser(reqAddressId, userId);
    } else {
      const addresses = await addressesRepo.listByUser(userId);
      address = addresses.find((item) => item.is_default) || addresses[0] || null;
    }
    if (!address) {
      return res.status(400).json({ success: false, message: "Selecione um address_id valido para o usuario." });
    }

    const userRunning = await sessionsRepo.getRunningByUser(userId);
    if (userRunning) return res.status(409).json({ success: false, message: "Usuario ja possui sessao running." });

    let started;
    try {
      started = await startSessionFlow({ userId, addressId: address.id, station });
    } catch (error) {
      if (isUniqueRunningByStation(error)) return res.status(409).json({ success: false, message: "Estacao ocupada" });
      if (isUniqueRunningByUser(error)) return res.status(409).json({ success: false, message: "Usuario ja possui sessao em andamento" });
      throw error;
    }

    if (!started.success) return res.status(started.statusCode).json(started.body);
    return res.json({ ...started.body, message: "Sessao iniciada (admin).", user_id: userId, address_id: address.id, station_id: station.id });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao iniciar (admin)", error: String(error.message || error) });
  }
});

app.post("/session/stop", requireAuth, async (req, res) => {
  try {
    const stationId = parsePositiveInt(req.body?.station_id);
    if (!stationId) return res.status(400).json({ success: false, message: "station_id e obrigatorio." });

    const station = await stationsRepo.getById(stationId);
    if (!station) return res.status(404).json({ success: false, message: "Estacao nao encontrada." });

    const running = await sessionsRepo.getRunningByStation(stationId);
    if (!running) return res.status(400).json({ success: false, message: "Nenhuma sessao running nesta estacao." });
    if (running.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "A sessao running desta estacao pertence a outro usuario." });
    }

    const finalized = await stopSessionFlow({ running, station });
    return res.json({ success: true, message: "Sessao finalizada.", ...finalized });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao finalizar sessao", error: String(error.message || error) });
  }
});

app.post("/admin/session/stop", requireAuth, requireAdmin, async (req, res) => {
  try {
    const stationId = parsePositiveInt(req.body?.station_id);
    if (!stationId) return res.status(400).json({ success: false, message: "station_id e obrigatorio." });

    const station = await stationsRepo.getById(stationId);
    if (!station) return res.status(404).json({ success: false, message: "Estacao nao encontrada." });

    const running = await sessionsRepo.getRunningByStation(stationId);
    if (!running) return res.status(400).json({ success: false, message: "Nenhuma sessao running nesta estacao." });

    const finalized = await stopSessionFlow({ running, station });
    return res.json({ success: true, message: "Sessao finalizada (admin).", ...finalized });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao parar (admin)", error: String(error.message || error) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
