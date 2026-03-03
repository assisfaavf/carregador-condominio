require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const config = require("./config");

const { getDeviceStatus, sendCommands } = require("./tuya_api");
const pgDb = require("./db/pg");
const usersRepo = require("./repositories/usersRepo");
const addressesRepo = require("./repositories/addressesRepo");
const stationsRepo = require("./repositories/stationsRepo");
const sessionsRepo = require("./repositories/sessionsRepo");
const systemSettingsRepo = require("./repositories/systemSettingsRepo");

const app = express();
if (config.isProd) {
  app.set("trust proxy", 1);
}
const legacyPublicDir = path.join(__dirname, "public");
const frontendDistDir = path.join(__dirname, "web", "dist");
const frontendIndexPath = path.join(frontendDistDir, "index.html");
const hasFrontendDist = fs.existsSync(frontendIndexPath);

app.use(express.json());
app.use(cookieParser());

const SESSION_WATCHDOG_INTERVAL_MS = 5000;
const AUTO_END_ZERO_POWER_THRESHOLD_KW = 0.1;
const AUTO_END_CONSECUTIVE_POLLS = 2;
const AUTO_END_MIN_SESSION_AGE_SECONDS = 30;
const ADMIN_SESSION_PAYMENT_STATUSES = new Set(["pendente", "pago", "cortesia", "n/a"]);
const USER_ROLES = new Set(["morador", "visitante"]);
const USER_APPROVAL_STATUSES = new Set(["pending", "approved", "rejected"]);
const USER_LIST_DEFAULT_LIMIT = 50;
const USER_LIST_MAX_LIMIT = 200;
const STATION_MIN_CURRENT_A = 6;
const STATION_MAX_CURRENT_A = 32;
const runningSessionMonitor = new Map();
let sessionWatchdogTimer = null;
let sessionWatchdogRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function parseIntegerInRange(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function normalizeUserRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!role) return null;
  if (role === "resident") return "morador";
  if (role === "visitor") return "visitante";
  if (USER_ROLES.has(role)) return role;
  return null;
}

function normalizeApprovalStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!status) return null;
  if (USER_APPROVAL_STATUSES.has(status)) return status;
  return null;
}

function resolveRegistrationRole(value) {
  const rawRole = String(value || "").trim().toLowerCase();
  if (rawRole === "admin") {
    return { role: "morador", is_admin: true };
  }

  const role = normalizeUserRole(rawRole);
  if (!role) return null;
  return { role, is_admin: false };
}

function normalizeRegisterAddresses(rawAddresses, fallbackTower, fallbackApartment) {
  const source = Array.isArray(rawAddresses) ? rawAddresses : [];
  const normalized = source
    .map((address, index) => {
      const tower = String(address?.tower || "").trim().toLowerCase();
      const apartment = String(address?.apartment || "").trim();
      const label = String(address?.label || "").trim();
      return {
        tower,
        apartment,
        label: label || (index === 0 ? "Principal" : `Endereco ${index + 1}`),
      };
    })
    .filter((address) => address.tower && address.apartment);

  if (normalized.length > 0) return normalized;

  const tower = String(fallbackTower || "").trim().toLowerCase();
  const apartment = String(fallbackApartment || "").trim();
  if (!tower || !apartment) return [];

  return [{ tower, apartment, label: "Principal" }];
}

function mapRegistrationAddressToAddressPayload(address, index) {
  return {
    label: String(address.label || (index === 0 ? "Principal" : `Endereco ${index + 1}`)).trim(),
    street: `Torre ${String(address.tower || "").trim()}`,
    number: String(address.apartment || "").trim(),
    complement: null,
    neighborhood: null,
    city: null,
    state: null,
    zip: null,
    is_default: index === 0,
  };
}

function parseAddressPayload(body, { requireLabel = false } = {}) {
  const payload = {};

  for (const field of ["label", "street", "number", "complement", "neighborhood", "city", "state", "zip"]) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      payload[field] = body[field] == null ? null : String(body[field]).trim();
    }
  }

  if (requireLabel) {
    payload.label = String(body.label || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(payload, "label") && !payload.label) {
    return { error: "label e obrigatorio." };
  }

  if (Object.prototype.hasOwnProperty.call(body, "is_default")) {
    if (typeof body.is_default !== "boolean") {
      return { error: "is_default deve ser boolean." };
    }
    payload.is_default = body.is_default;
  }

  return { payload };
}

async function ensureUserHasAddresses(user) {
  if (!user?.id) return [];

  const existingAddresses = await addressesRepo.listByUser(user.id);
  if (existingAddresses.length > 0) return existingAddresses;
  if (!user.tower || !user.apartment) return existingAddresses;

  await addressesRepo.createForUser(
    user.id,
    mapRegistrationAddressToAddressPayload(
      {
        label: "Principal",
        tower: user.tower,
        apartment: user.apartment,
      },
      0
    )
  );

  return addressesRepo.listByUser(user.id);
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

function readDpString(statusData, code) {
  const value = findDp(statusData, code)?.value;
  if (value == null) return null;
  return String(value);
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

function normalizeStatusToken(value) {
  if (value == null) return null;
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function appendSessionNote(existingNotes, extraNote) {
  const current = String(existingNotes || "").trim();
  const extra = String(extraNote || "").trim();
  if (!extra) return current || null;
  if (!current) return extra;
  return `${current}\n${extra}`;
}

function detectExplicitChargingEnd(statusData) {
  const terminalByCode = {
    work_state: new Set(["charger_end", "charger_finish", "charger_finished"]),
    charge_status: new Set(["charge_completed", "charge_complete", "completed", "complete", "finished", "finish", "end"]),
    charging_state: new Set(["charge_completed", "charge_complete", "completed", "complete", "finished", "finish", "end"]),
  };

  for (const [code, expectedValues] of Object.entries(terminalByCode)) {
    const rawValue = readDpString(statusData, code);
    const token = normalizeStatusToken(rawValue);
    if (!token || !expectedValues.has(token)) continue;
    return { code, value: rawValue };
  }

  return null;
}

function didChargingEnd(statusData, monitorState = {}, runningSession = null) {
  const explicitEnd = detectExplicitChargingEnd(statusData);
  if (explicitEnd) {
    return {
      ended: true,
      reason: `charger reported finished (${explicitEnd.code}=${explicitEnd.value})`,
      source: "explicit_status",
      zeroPowerCount: 0,
      powerKw: pickPowerKwFromStatus(statusData),
    };
  }

  const powerKw = pickPowerKwFromStatus(statusData);
  const elapsedSeconds = runningSession ? calcElapsedSeconds(runningSession.start_time) : null;
  const oldCount = Number.isInteger(monitorState.zeroPowerCount) ? monitorState.zeroPowerCount : 0;
  const eligibleByAge = elapsedSeconds == null || elapsedSeconds >= AUTO_END_MIN_SESSION_AGE_SECONDS;
  const zeroPower = powerKw != null && powerKw <= AUTO_END_ZERO_POWER_THRESHOLD_KW && eligibleByAge;
  const zeroPowerCount = zeroPower ? oldCount + 1 : 0;

  if (zeroPowerCount >= AUTO_END_CONSECUTIVE_POLLS) {
    return {
      ended: true,
      reason: `power stayed at ${AUTO_END_ZERO_POWER_THRESHOLD_KW.toFixed(1)} kW or below for ${zeroPowerCount} polls`,
      source: "power_zero",
      zeroPowerCount,
      powerKw,
    };
  }

  return {
    ended: false,
    reason: null,
    source: null,
    zeroPowerCount,
    powerKw,
  };
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

function isActivelyCharging(workState, sw) {
  if (workState === "charger_end" || workState === "charger_free") return false;
  if (workState === "charger_charging") return true;
  return sw === true && !workState;
}

function pickChargerStateLabel(workState, sw) {
  if (workState === "charger_end") return "Finalizado (carro ainda conectado)";
  if (workState === "charger_free") return "Livre";
  if (workState === "charger_charging" || (sw === true && !workState)) return "Carregando";
  return `Estado: ${workState || "desconhecido"}`;
}

function getEnvTariffPerKwh() {
  const n = Number(config.priceFallback);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function getEnvDefaultChargeCurrentA() {
  const n = parseIntegerInRange(config.defaultChargeCurrentA, STATION_MIN_CURRENT_A, STATION_MAX_CURRENT_A);
  return n ?? 32;
}

async function getSystemSettings() {
  const rows = await systemSettingsRepo.getAll();
  const valuesByKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));

  const pricePerKwh = toFiniteNumber(valuesByKey.price_per_kwh);
  const defaultChargeCurrentA = parseIntegerInRange(
    valuesByKey.default_charge_current_a,
    STATION_MIN_CURRENT_A,
    STATION_MAX_CURRENT_A
  );

  return {
    price_per_kwh: pricePerKwh != null && pricePerKwh > 0 ? pricePerKwh : getEnvTariffPerKwh(),
    default_charge_current_a: defaultChargeCurrentA ?? getEnvDefaultChargeCurrentA(),
  };
}

async function getTariffPerKwh() {
  return (await getSystemSettings()).price_per_kwh;
}

async function getDefaultChargeCurrentA() {
  return (await getSystemSettings()).default_charge_current_a;
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
  const secret = config.jwtSecret;
  if (!secret) throw new Error("JWT_SECRET nao configurado no .env");
  return jwt.sign(payload, secret, { expiresIn: config.jwtExpiresIn });
}

function getAuthCookieOptions() {
  const options = {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    path: config.cookie.path,
  };

  if (config.cookie.domain) {
    options.domain = config.cookie.domain;
  }

  return options;
}

function setAuthCookie(res, token) {
  res.cookie(config.cookie.name, token, getAuthCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(config.cookie.name, getAuthCookieOptions());
}

function toAuthUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    is_admin: user.is_admin === true,
    role: user.role ?? null,
    approval_status: user.approval_status ?? "approved",
    tower: user.tower ?? null,
    apartment: user.apartment ?? null,
  };
}

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[config.cookie.name];
    if (!token) return res.status(401).json({ success: false, message: "Nao autenticado." });

    const decoded = jwt.verify(token, config.jwtSecret);
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

if (!config.isProd) {
  app.get("/api/debug/cookie-config", (_req, res) => {
    return res.json({
      cookieName: config.cookie.name,
      secure: config.cookie.secure,
      sameSite: config.cookie.sameSite,
      domain: config.cookie.domain ?? null,
      path: config.cookie.path,
      nodeEnv: config.nodeEnv,
    });
  });
}

if (!hasFrontendDist) {
  app.use(express.static(legacyPublicDir));

  app.get("/", (req, res) => {
    res.send("Servidor do Carregador rodando. Use /health para testar.");
  });
}

app.post("/auth/register", async (req, res) => {
  try {
    let { name, email, cpf, password, role, tower, apartment, addresses } = req.body || {};

    name = (name || "").trim();
    email = (email || "").trim().toLowerCase();
    cpf = (cpf || "").replace(/\D/g, "");
    role = (role || "").trim().toLowerCase();
    password = String(password || "");

    const normalizedAddresses = normalizeRegisterAddresses(addresses, tower, apartment);
    const primaryAddress = normalizedAddresses[0] || null;
    tower = primaryAddress?.tower || String(tower || "").trim().toLowerCase();
    apartment = primaryAddress?.apartment || String(apartment || "").trim();

    if (!name) return res.status(400).json({ success: false, message: "Nome e obrigatorio." });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Email invalido." });
    }
    if (!cpf || cpf.length !== 11) {
      return res.status(400).json({ success: false, message: "CPF invalido (11 numeros)." });
    }
    if (normalizedAddresses.length === 0) {
      return res.status(400).json({ success: false, message: "Informe ao menos uma unidade valida." });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: "Senha deve ter no minimo 8 caracteres." });
    }

    const allowedTowers = ["mississipi", "missouri"];
    const registrationRole = resolveRegistrationRole(role);

    if (!registrationRole) {
      return res.status(400).json({ success: false, message: "role invalido. Use morador|visitante." });
    }
    if (!allowedTowers.includes(tower)) {
      return res.status(400).json({ success: false, message: "tower invalida. Use mississipi|missouri." });
    }
    if (normalizedAddresses.some((address) => !allowedTowers.includes(address.tower))) {
      return res.status(400).json({ success: false, message: "Cada endereco deve usar mississipi ou missouri como torre." });
    }

    const approvalStatus = registrationRole.is_admin ? "approved" : "pending";
    const approvedAt = approvalStatus === "approved" ? new Date() : null;

    const user = await usersRepo.create({
      name,
      email,
      password_hash: bcrypt.hashSync(password, 10),
      is_admin: registrationRole.is_admin,
      cpf,
      role: registrationRole.role,
      tower,
      apartment,
      approval_status: approvalStatus,
      approved_at: approvedAt,
    });

    for (const [index, address] of normalizedAddresses.entries()) {
      await addressesRepo.createForUser(
        user.id,
        mapRegistrationAddressToAddressPayload(address, index)
      );
    }

    return res.json({
      success: true,
      message: "Usuario cadastrado.",
      user: toAuthUser(user),
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

    if (user.approval_status === "rejected") {
      return res.status(403).json({ success: false, message: "Seu cadastro foi reprovado. Fale com a administracao." });
    }

    const loggedUser = await usersRepo.setLastLoginAt(user.id);

    setAuthCookie(res, signToken({ id: user.id }));
    return res.json({
      success: true,
      message: "Login ok",
      user: toAuthUser(loggedUser || user),
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

app.get("/auth/me", requireAuth, (req, res) => res.json({ success: true, user: toAuthUser(req.user) }));
app.get("/api/me", requireAuth, (req, res) => res.json({ success: true, user: toAuthUser(req.user) }));
app.post("/auth/logout", (req, res) => {
  clearAuthCookie(res);
  return res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  clearAuthCookie(res);
  return res.json({ ok: true });
});

app.get("/api/my/addresses", requireAuth, async (req, res) => {
  try {
    const addresses = await ensureUserHasAddresses(req.user);
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
    return res.json({
      success: true,
      stations: stations.map((station) => ({
        id: station.id,
        name: station.name,
        location_label: station.location_label,
        is_active: station.is_active === true,
        max_current_a: station.max_current_a,
        tuya_device_id: station.tuya_device_id,
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar estacoes", error: String(error.message || error) });
  }
});

app.get("/api/admin/settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const settings = await getSystemSettings();
    return res.json({ success: true, settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao carregar configuracoes", error: String(error.message || error) });
  }
});

app.patch("/api/admin/settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {};

    if (Object.prototype.hasOwnProperty.call(body, "price_per_kwh")) {
      const pricePerKwh = toFiniteNumber(body.price_per_kwh);
      if (pricePerKwh == null || pricePerKwh <= 0) {
        return res.status(400).json({ success: false, message: "price_per_kwh deve ser numero maior que zero." });
      }
      updates.price_per_kwh = String(pricePerKwh);
    }

    if (Object.prototype.hasOwnProperty.call(body, "default_charge_current_a")) {
      const current = parseIntegerInRange(body.default_charge_current_a, STATION_MIN_CURRENT_A, STATION_MAX_CURRENT_A);
      if (current == null) {
        return res.status(400).json({
          success: false,
          message: `default_charge_current_a deve ser inteiro entre ${STATION_MIN_CURRENT_A} e ${STATION_MAX_CURRENT_A}.`,
        });
      }
      updates.default_charge_current_a = String(current);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "Nenhuma configuracao valida enviada." });
    }

    await systemSettingsRepo.setMany(updates);
    const settings = await getSystemSettings();
    return res.json({ ok: true, success: true, settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao salvar configuracoes", error: String(error.message || error) });
  }
});

app.post("/api/admin/stations", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const tuyaDeviceId = String(body.tuya_device_id || "").trim();
    const locationLabel = body.location_label == null ? null : String(body.location_label).trim();
    const defaultChargeCurrentA = await getDefaultChargeCurrentA();
    const maxCurrentA = body.max_current_a == null
      ? defaultChargeCurrentA
      : parseIntegerInRange(body.max_current_a, STATION_MIN_CURRENT_A, STATION_MAX_CURRENT_A);
    const isActive = body.is_active !== false;

    if (!name) return res.status(400).json({ success: false, message: "name e obrigatorio." });
    if (!tuyaDeviceId) return res.status(400).json({ success: false, message: "tuya_device_id e obrigatorio." });
    if (maxCurrentA == null) {
      return res.status(400).json({
        success: false,
        message: `max_current_a invalido. Use inteiro entre ${STATION_MIN_CURRENT_A} e ${STATION_MAX_CURRENT_A}.`,
      });
    }
    if (Object.prototype.hasOwnProperty.call(body, "is_active") && typeof body.is_active !== "boolean") {
      return res.status(400).json({ success: false, message: "is_active deve ser boolean." });
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
      const maxCurrentA = parseIntegerInRange(body.max_current_a, STATION_MIN_CURRENT_A, STATION_MAX_CURRENT_A);
      if (maxCurrentA == null) {
        return res.status(400).json({
          success: false,
          message: `max_current_a invalido. Use inteiro entre ${STATION_MIN_CURRENT_A} e ${STATION_MAX_CURRENT_A}.`,
        });
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
    const status = req.query.status == null || req.query.status === ""
      ? null
      : normalizeApprovalStatus(req.query.status);
    const role = req.query.role == null || req.query.role === ""
      ? null
      : normalizeUserRole(req.query.role);
    const q = req.query.q == null ? "" : String(req.query.q).trim();
    const limit = Math.min(
      parsePositiveInt(req.query.limit) ?? USER_LIST_DEFAULT_LIMIT,
      USER_LIST_MAX_LIMIT
    );
    const offset = parseNonNegativeInt(req.query.offset) ?? 0;

    if (req.query.status && !status) {
      return res.status(400).json({ success: false, message: "status invalido. Use pending|approved|rejected." });
    }
    if (req.query.role && !role) {
      return res.status(400).json({ success: false, message: "role invalido. Use morador|visitante." });
    }

    const result = await usersRepo.listAdminUsers({
      status,
      role,
      q,
      limit,
      offset,
    });

    return res.json({
      success: true,
      users: result.users,
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar usuarios", error: String(error.message || error) });
  }
});

app.patch("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) return res.status(400).json({ success: false, message: "id invalido." });

    const body = req.body || {};
    const payload = {};

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const name = String(body.name || "").trim();
      if (!name) return res.status(400).json({ success: false, message: "name e obrigatorio." });
      payload.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(body, "role")) {
      const role = normalizeUserRole(body.role);
      if (!role) {
        return res.status(400).json({ success: false, message: "role invalido. Use morador|visitante." });
      }
      payload.role = role;
    }

    if (Object.prototype.hasOwnProperty.call(body, "approval_status")) {
      const approvalStatus = normalizeApprovalStatus(body.approval_status);
      if (!approvalStatus) {
        return res.status(400).json({ success: false, message: "approval_status invalido. Use pending|approved|rejected." });
      }
      payload.approval_status = approvalStatus;
    }

    if (Object.prototype.hasOwnProperty.call(body, "is_admin")) {
      if (typeof body.is_admin !== "boolean") {
        return res.status(400).json({ success: false, message: "is_admin deve ser boolean." });
      }
      if (req.user.id === userId && body.is_admin === false) {
        return res.status(400).json({ success: false, message: "Voce nao pode remover seu proprio acesso de administrador." });
      }
      payload.is_admin = body.is_admin;
    }

    const user = await usersRepo.updateAdminUser(userId, payload);
    if (!user) return res.status(404).json({ success: false, message: "Usuario nao encontrado." });

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        is_admin: user.is_admin === true,
        approval_status: user.approval_status,
        created_at: user.created_at,
        last_login_at: user.last_login_at,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao atualizar usuario", error: String(error.message || error) });
  }
});

app.get("/api/admin/users/:id/addresses", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) return res.status(400).json({ success: false, message: "user id invalido." });

    const user = await usersRepo.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "Usuario nao encontrado." });

    const addresses = await ensureUserHasAddresses(user);
    return res.json({
      success: true,
      addresses,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar enderecos do usuario", error: String(error.message || error) });
  }
});

app.post("/api/admin/users/:id/addresses", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parsePositiveInt(req.params.id);
    if (!userId) return res.status(400).json({ success: false, message: "user id invalido." });

    const user = await usersRepo.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "Usuario nao encontrado." });

    const { payload, error } = parseAddressPayload(req.body || {}, { requireLabel: true });
    if (error) return res.status(400).json({ success: false, message: error });

    const address = await addressesRepo.createForUser(userId, payload);
    return res.status(201).json({ success: true, address });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao criar endereco do usuario", error: String(error.message || error) });
  }
});

app.patch("/api/admin/addresses/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const addressId = parsePositiveInt(req.params.id);
    if (!addressId) return res.status(400).json({ success: false, message: "id invalido." });

    const { payload, error } = parseAddressPayload(req.body || {});
    if (error) return res.status(400).json({ success: false, message: error });

    const address = await addressesRepo.updateById(addressId, payload);
    if (!address) return res.status(404).json({ success: false, message: "Endereco nao encontrado." });

    return res.json({ success: true, address });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao atualizar endereco", error: String(error.message || error) });
  }
});

app.delete("/api/admin/addresses/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const addressId = parsePositiveInt(req.params.id);
    if (!addressId) return res.status(400).json({ success: false, message: "id invalido." });

    const deleted = await addressesRepo.deleteById(addressId);
    if (!deleted) return res.status(404).json({ success: false, message: "Endereco nao encontrado." });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao remover endereco", error: String(error.message || error) });
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
  const tariffPerKwh = await getTariffPerKwh();

  const session = await sessionsRepo.createRunning({
    user_id: userId,
    address_id: addressId,
    station_id: station.id,
    start_energy_total: scale2ToKwh(totalRawBefore),
    tariff_per_kwh: tariffPerKwh,
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

async function startSessionAsAdmin(body) {
  const userId = parsePositiveInt(body?.user_id) ?? parsePositiveInt(body?.userId);
  const stationId = parsePositiveInt(body?.station_id);
  const reqAddressId = parsePositiveInt(body?.address_id);

  if (!userId) {
    return {
      ok: false,
      statusCode: 400,
      body: { success: false, message: "user_id e obrigatorio." },
    };
  }
  if (!stationId) {
    return {
      ok: false,
      statusCode: 400,
      body: { success: false, message: "station_id e obrigatorio." },
    };
  }

  const user = await usersRepo.findById(userId);
  if (!user) {
    return {
      ok: false,
      statusCode: 404,
      body: { success: false, message: "Usuario nao encontrado." },
    };
  }

  const station = await getStationForOperation(stationId, true);
  if (!station) {
    return {
      ok: false,
      statusCode: 404,
      body: { success: false, message: "Estacao nao encontrada ou inativa." },
    };
  }

  let address = null;
  if (reqAddressId) {
    address = await addressesRepo.getByIdForUser(reqAddressId, userId);
    if (!address) {
      return {
        ok: false,
        statusCode: 400,
        body: { success: false, message: "address_id nao pertence ao usuario informado." },
      };
    }
  } else {
    const addresses = await addressesRepo.listByUser(userId);
    address = addresses.find((item) => item.is_default) || null;
    if (!address) {
      return {
        ok: false,
        statusCode: 400,
        body: { success: false, message: "Usuario sem endereco cadastrado/default." },
      };
    }
  }

  const userRunning = await sessionsRepo.getRunningByUser(userId);
  if (userRunning) {
    return {
      ok: false,
      statusCode: 409,
      body: { success: false, message: "Usuario ja possui sessao ativa." },
    };
  }

  let started;
  try {
    started = await startSessionFlow({ userId, addressId: address.id, station });
  } catch (error) {
    if (isUniqueRunningByStation(error)) {
      return {
        ok: false,
        statusCode: 409,
        body: { success: false, message: "Estacao ocupada" },
      };
    }
    if (isUniqueRunningByUser(error)) {
      return {
        ok: false,
        statusCode: 409,
        body: { success: false, message: "Usuario ja possui sessao ativa." },
      };
    }
    throw error;
  }

  if (!started.success) {
    return {
      ok: false,
      statusCode: started.statusCode,
      body: started.body,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    body: {
      ...started.body,
      message: "Sessao iniciada (admin).",
      user_id: userId,
      address_id: address.id,
      station_id: station.id,
    },
  };
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
  const tariff = await getTariffPerKwh();
  const priceCalculated = energyKwh != null ? round2(energyKwh * tariff) : null;
  const needsReview = computeNeedsReview(energyOnce, energyFromTotal, energyKwh);
  const patch = {
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
  };

  if (running.auto_end_note) {
    patch.notes = appendSessionNote(running.notes, running.auto_end_note);
  }

  const finished = await pgDb.withTransaction(async (tx) => (
    sessionsRepo.finishSession(running.id, patch, tx)
  ));
  if (!finished) return null;

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
  const tariffPerKwh = await getTariffPerKwh();

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
  const charging = isActivelyCharging(workState, sw);
  const currentSet = readDpNumber(status, "charge_cur_set");
  const totalKwh = scale2ToKwh(readDpNumber(status, "forward_energy_total"));
  const totalKwhRounded = totalKwh != null ? round2(totalKwh) : null;
  let powerKw = pickPowerKwFromStatus(status);

  const running = await sessionsRepo.getRunningByStation(station.id);
  let runningSession = null;
  let sessionEnergyKwh = null;
  let sessionEnergySource = null;

  if (running) {
    const elapsedSeconds = calcElapsedSeconds(running.start_time);
    const startTotal = toFiniteNumber(running.start_energy_total);
    const kwhEstimated = startTotal != null && totalKwh != null ? Math.max(0, totalKwh - startTotal) : null;
    sessionEnergyKwh = kwhEstimated;
    sessionEnergySource = sessionEnergyKwh != null ? "delta_total" : (startTotal == null ? "missing_start_total" : null);

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
      session_energy_kwh: sessionEnergyKwh != null ? round2(sessionEnergyKwh) : null,
      session_energy_source: sessionEnergySource,
      price_estimated: kwhEstimated != null ? round2(kwhEstimated * tariffPerKwh) : null,
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
      total_kwh: totalKwhRounded,
      session_energy_kwh: sessionEnergyKwh != null ? round2(sessionEnergyKwh) : null,
      state_label: pickChargerStateLabel(workState, sw),
    },
    running_session: runningSession,
    charging,
    workState,
    connectionState,
    switch: sw,
    powerKw: powerKw != null ? round2(powerKw) : null,
    currentSetA: currentSet != null ? currentSet : null,
    totalKwh: totalKwhRounded,
    energy_total_kwh: totalKwhRounded,
    session_active: running != null,
    session_id: running?.id || null,
    session_start_time: running?.start_time || null,
    session_energy_kwh: sessionEnergyKwh != null ? round2(sessionEnergyKwh) : null,
    session_energy_source: sessionEnergySource,
    stateLabel: pickChargerStateLabel(workState, sw),
    sessionId: runningSession?.session_id || null,
    elapsedSeconds: runningSession?.elapsed_seconds || 0,
    kwhEstimated: runningSession?.kwh_estimated ?? null,
    priceEstimated: runningSession?.price_estimated ?? null,
    runningSession,
  };
}

async function runSessionWatchdogTick() {
  if (sessionWatchdogRunning) return;
  sessionWatchdogRunning = true;

  try {
    const runningSessions = await sessionsRepo.listCurrentRunning();
    const activeIds = new Set();

    for (const session of runningSessions) {
      activeIds.add(session.id);

      const station = session.station || await stationsRepo.getById(session.station_id);
      if (!station?.tuya_device_id) {
        runningSessionMonitor.delete(session.id);
        continue;
      }

      let status;
      try {
        status = await getDeviceStatus(station.tuya_device_id);
      } catch (error) {
        console.warn(`[watchdog] Falha ao consultar status da estacao ${station.id}: ${String(error.message || error)}`);
        continue;
      }

      const monitorState = runningSessionMonitor.get(session.id) || { zeroPowerCount: 0 };
      const detection = didChargingEnd(status, monitorState, session);

      if (!detection.ended) {
        runningSessionMonitor.set(session.id, { zeroPowerCount: detection.zeroPowerCount });
        continue;
      }

      const latestRunning = await sessionsRepo.getRunningByStation(session.station_id);
      if (!latestRunning || latestRunning.id !== session.id) {
        runningSessionMonitor.delete(session.id);
        continue;
      }

      const autoEndNote = `auto-ended: car reached full / charger reported finished (${detection.reason})`;
      const finalized = await stopSessionFlow({
        running: { ...latestRunning, auto_end_note: autoEndNote },
        station,
      });

      runningSessionMonitor.delete(session.id);
      if (finalized) {
        console.log(`[watchdog] Sessao ${session.id} finalizada automaticamente na estacao ${station.id}.`);
      }
    }

    for (const sessionId of Array.from(runningSessionMonitor.keys())) {
      if (!activeIds.has(sessionId)) {
        runningSessionMonitor.delete(sessionId);
      }
    }
  } catch (error) {
    console.error(`[watchdog] Erro no monitor de sessoes: ${String(error.message || error)}`);
  } finally {
    sessionWatchdogRunning = false;
  }
}

function startSessionWatchdog() {
  if (sessionWatchdogTimer) return;

  sessionWatchdogTimer = setInterval(() => {
    void runSessionWatchdogTick();
  }, SESSION_WATCHDOG_INTERVAL_MS);

  if (typeof sessionWatchdogTimer.unref === "function") {
    sessionWatchdogTimer.unref();
  }

  void runSessionWatchdogTick();
}

async function stopSessionAsAdmin(body) {
  const stationId = parsePositiveInt(body?.station_id);
  if (!stationId) {
    return {
      ok: false,
      statusCode: 400,
      body: { success: false, message: "station_id e obrigatorio." },
    };
  }

  const station = await stationsRepo.getById(stationId);
  if (!station) {
    return {
      ok: false,
      statusCode: 404,
      body: { success: false, message: "Estacao nao encontrada." },
    };
  }

  const running = await sessionsRepo.getRunningByStation(stationId);
  if (!running) {
    return {
      ok: false,
      statusCode: 400,
      body: { success: false, message: "Nenhuma sessao running nesta estacao." },
    };
  }

  const finalized = await stopSessionFlow({ running, station });
  if (!finalized) {
    return {
      ok: false,
      statusCode: 409,
      body: { success: false, message: "A sessao ja foi finalizada." },
    };
  }

  return {
    ok: true,
    statusCode: 200,
    body: {
      success: true,
      message: "Sessao finalizada (admin).",
      ...finalized,
    },
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
      deviceId = config.tuya.deviceId || null;
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
        station_id: session.station_id,
        user_id: session.user_id,
        user_name: session.user?.name ?? null,
        user_email: session.user?.email ?? null,
        address_label: session.address?.label ?? null,
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

function parseOffset(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0
    ? Number(value)
    : 0;
}

function mapUserSessionForUi(session) {
  const energyKwh = session.energy_kwh != null ? session.energy_kwh : session.energy_once;
  return {
    ...session,
    id: session.id,
    start_time: session.start_time,
    end_time: session.end_time,
    duration_seconds: session.duration_seconds,
    energy_kwh: energyKwh,
    energy_once: session.energy_once,
    price_calculated: session.price_calculated,
    price_override: session.price_override,
    payment_status: session.payment_status,
    station_id: session.station_id,
    station_name: session.station_name ?? session.station?.name ?? null,
    station_location_label: session.station_location_label ?? session.station?.location_label ?? null,
    address_id: session.address_id,
    address_label: session.address_label ?? session.address?.label ?? null,
  };
}

function normalizeAdminSessionPaymentStatus(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return ADMIN_SESSION_PAYMENT_STATUSES.has(normalized) ? normalized : null;
}

function normalizeAdminSessionDateQuery(value, endOfDay = false) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed} ${endOfDay ? "23:59:59.999" : "00:00:00.000"}`;
  }
  return trimmed;
}

function normalizeNullableText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function mapAdminSessionForUi(session) {
  const energyKwh = session?.energy_kwh != null ? session.energy_kwh : session?.energy_once;
  return {
    id: session.id,
    user_id: session.user_id ?? session.user?.id ?? null,
    station_id: session.station_id ?? session.station?.id ?? null,
    start_time: session.start_time ?? null,
    end_time: session.end_time ?? null,
    duration_seconds: session.duration_seconds ?? null,
    status: session.status ?? null,
    energy_kwh: energyKwh,
    tariff_per_kwh: session.tariff_per_kwh ?? null,
    price_calculated: session.price_calculated ?? null,
    price_override: session.price_override ?? null,
    payment_status: session.payment_status ?? null,
    notes: session.notes ?? null,
    needs_review: session.needs_review === true,
    user_name: normalizeNullableText(session.user_name ?? session.user?.name),
    user_email: normalizeNullableText(session.user_email ?? session.user?.email),
    station_name: normalizeNullableText(session.station_name ?? session.station?.name),
    address_label: normalizeNullableText(session.address_label ?? session.address?.label),
  };
}

async function handleMySessions(req, res, defaultLimit = 20) {
  try {
    const limit = parsePositiveInt(req.query.limit) || defaultLimit;
    const offset = parseOffset(req.query.offset);

    const sessions = await sessionsRepo.listByUser(req.user.id, limit, offset);
    return res.json({
      success: true,
      limit,
      offset,
      sessions: sessions.map(mapUserSessionForUi),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao buscar historico", error: String(error.message || error) });
  }
}

app.get("/api/my/sessions", requireAuth, async (req, res) => {
  return handleMySessions(req, res, 20);
});

app.get("/api/my-sessions", requireAuth, async (req, res) => {
  return handleMySessions(req, res, 20);
});

app.get("/api/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit) || 20;
    const offset = parseOffset(req.query.offset);
    const paymentStatus = req.query.payment_status == null
      ? undefined
      : normalizeAdminSessionPaymentStatus(String(req.query.payment_status));

    if (req.query.payment_status != null && paymentStatus == null) {
      return res.status(400).json({ success: false, message: "payment_status invalido." });
    }

    const sessions = await sessionsRepo.listAdmin({
      user_id: parsePositiveInt(req.query.user_id),
      station_id: parsePositiveInt(req.query.station_id),
      status: req.query.status ? String(req.query.status).trim() : undefined,
      payment_status: paymentStatus,
      date_from: normalizeAdminSessionDateQuery(req.query.date_from),
      date_to: normalizeAdminSessionDateQuery(req.query.date_to, true),
      limit,
      offset,
    });

    return res.json({
      success: true,
      limit,
      offset,
      sessions: sessions.map(mapAdminSessionForUi),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao listar sessoes", error: String(error.message || error) });
  }
});

app.patch("/api/admin/sessions/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const sessionId = parsePositiveInt(req.params.id);
    if (!sessionId) return res.status(400).json({ success: false, message: "id invalido." });

    const body = req.body || {};
    const patch = {};

    if (Object.prototype.hasOwnProperty.call(body, "payment_status")) {
      const paymentStatus = normalizeAdminSessionPaymentStatus(body.payment_status);
      if (!paymentStatus) {
        return res.status(400).json({ success: false, message: "payment_status invalido." });
      }
      patch.payment_status = paymentStatus;
    }

    if (Object.prototype.hasOwnProperty.call(body, "price_override")) {
      if (body.price_override == null || body.price_override === "") {
        patch.price_override = null;
      } else {
        const priceOverride = toFiniteNumber(body.price_override);
        if (priceOverride == null || priceOverride < 0) {
          return res.status(400).json({ success: false, message: "price_override invalido." });
        }
        patch.price_override = round2(priceOverride);
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "notes")) {
      if (body.notes == null) {
        patch.notes = null;
      } else if (typeof body.notes === "string") {
        patch.notes = body.notes.trim() || null;
      } else {
        return res.status(400).json({ success: false, message: "notes deve ser string ou null." });
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "needs_review")) {
      if (typeof body.needs_review !== "boolean") {
        return res.status(400).json({ success: false, message: "needs_review deve ser boolean." });
      }
      patch.needs_review = body.needs_review;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, message: "Nenhum campo valido para atualizar." });
    }

    const updated = await sessionsRepo.updateAdminFields(sessionId, patch);
    if (!updated) return res.status(404).json({ success: false, message: "Sessao nao encontrada." });

    const [sessionWithRelations] = await sessionsRepo.listAdmin({
      id: sessionId,
      limit: 1,
      offset: 0,
    });

    return res.json({
      success: true,
      session: sessionWithRelations ? mapAdminSessionForUi(sessionWithRelations) : mapAdminSessionForUi(updated),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao atualizar sessao", error: String(error.message || error) });
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
      paymentStatus = normalizeAdminSessionPaymentStatus(req.body.payment_status);
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
    const result = await startSessionAsAdmin(req.body);
    return res.status(result.statusCode).json(result.body);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao iniciar (admin)", error: String(error.message || error) });
  }
});

app.post("/api/admin/start", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await startSessionAsAdmin(req.body);
    return res.status(result.statusCode).json(result.body);
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
    if (!finalized) return res.status(409).json({ success: false, message: "A sessao ja foi finalizada." });
    return res.json({ success: true, message: "Sessao finalizada.", ...finalized });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao finalizar sessao", error: String(error.message || error) });
  }
});

app.post("/admin/session/stop", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await stopSessionAsAdmin(req.body);
    return res.status(result.statusCode).json(result.body);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao parar (admin)", error: String(error.message || error) });
  }
});

app.post("/api/admin/stop", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await stopSessionAsAdmin(req.body);
    return res.status(result.statusCode).json(result.body);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Erro ao parar (admin)", error: String(error.message || error) });
  }
});

if (hasFrontendDist) {
  app.use(express.static(frontendDistDir));

  app.get(/^(?!\/(?:api|session|auth)(?:\/|$)).*/, (_, res) => {
    return res.sendFile(frontendIndexPath);
  });
}

const PORT = config.port;
app.listen(PORT, "0.0.0.0", () => {
  startSessionWatchdog();
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
