require("dotenv").config();

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

function normalizeSameSite(value, fallback = "lax") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (["lax", "strict", "none"].includes(normalized)) return normalized;
  return fallback;
}

function optionalText(value) {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

const nodeEnv = String(process.env.NODE_ENV || "development").trim().toLowerCase() || "development";
const isProd = nodeEnv === "production";
const cookieSameSite = normalizeSameSite(process.env.COOKIE_SAMESITE, "lax");
const cookieSecure = parseBoolean(process.env.COOKIE_SECURE, isProd);

if (cookieSameSite === "none" && cookieSecure !== true) {
  throw new Error("COOKIE_SAMESITE=none exige COOKIE_SECURE=true.");
}

const config = {
  nodeEnv,
  isProd,
  port: parsePort(process.env.PORT, 3000),
  jwtSecret: String(process.env.JWT_SECRET || "").trim(),
  jwtExpiresIn: String(process.env.JWT_EXPIRES_IN || "7d").trim() || "7d",
  dbUrl: String(process.env.DATABASE_URL || "").trim(),
  cookie: {
    name: String(process.env.COOKIE_NAME || "token").trim() || "token",
    secure: cookieSecure,
    sameSite: cookieSameSite,
    domain: optionalText(process.env.COOKIE_DOMAIN),
    path: String(process.env.COOKIE_PATH || "/").trim() || "/",
  },
  tuya: {
    clientId: String(process.env.TUYA_CLIENT_ID || process.env.TUYA_ACCESS_ID || "").trim(),
    clientSecret: String(process.env.TUYA_CLIENT_SECRET || process.env.TUYA_ACCESS_SECRET || "").trim(),
    deviceRegion: String(process.env.TUYA_DEVICE_REGION || "").trim(),
    endpoint: String(process.env.TUYA_ENDPOINT || process.env.TUYA_BASE_URL || "").trim(),
    deviceId: String(process.env.TUYA_DEVICE_ID || "").trim(),
  },
  priceFallback: Number.isFinite(Number(process.env.PRICE_PER_KWH))
    ? Number(process.env.PRICE_PER_KWH)
    : 1.2,
  defaultChargeCurrentA: (() => {
    const value = Number(process.env.DEFAULT_CHARGE_CURRENT_A);
    return Number.isInteger(value) && value >= 6 && value <= 32 ? value : 32;
  })(),
};

if (config.isProd) {
  const missing = [];
  if (!config.jwtSecret) missing.push("JWT_SECRET");
  if (!config.dbUrl) missing.push("DATABASE_URL");

  if (missing.length > 0) {
    throw new Error(`Configuração obrigatória ausente em produção: ${missing.join(", ")}.`);
  }
}

module.exports = config;
