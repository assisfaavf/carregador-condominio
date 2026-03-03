const crypto = require("crypto");
const config = require("./config");

const BASE_URL = config.tuya.endpoint;
const ACCESS_ID = config.tuya.clientId;
const ACCESS_SECRET = config.tuya.clientSecret;

let cachedToken = null;
let cachedTokenExpireAt = 0;
let tokenRequestInFlight = null;

class TuyaRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TuyaRequestError";
    this.status = details.status ?? null;
    this.response = details.response ?? null;
    this.code = details.code ?? null;
  }
}

function hmacSha256HexUpper(key, content) {
  return crypto
    .createHmac("sha256", key)
    .update(content, "utf8")
    .digest("hex")
    .toUpperCase();
}

function buildSignature({ method, pathWithQuery, bodyText, token, t }) {
  const bodyHash = crypto
    .createHash("sha256")
    .update(bodyText || "", "utf8")
    .digest("hex");

  const stringToSign = [
    method.toUpperCase(),
    bodyHash,
    "",
    pathWithQuery,
  ].join("\n");

  const signContent = `${ACCESS_ID}${token || ""}${t}${stringToSign}`;
  return hmacSha256HexUpper(ACCESS_SECRET, signContent);
}

async function tuyaRequest({ method, path, body, token }) {
  if (!BASE_URL || !ACCESS_ID || !ACCESS_SECRET) {
    throw new Error(
      "Faltam variáveis Tuya no .env (TUYA_ENDPOINT/TUYA_BASE_URL, TUYA_CLIENT_ID/TUYA_ACCESS_ID, TUYA_CLIENT_SECRET/TUYA_ACCESS_SECRET)."
    );
  }

  const t = Date.now().toString();
  const bodyText = body ? JSON.stringify(body) : "";

  const sign = buildSignature({
    method,
    pathWithQuery: path,
    bodyText,
    token,
    t,
  });

  const headers = {
    client_id: ACCESS_ID,
    t,
    sign_method: "HMAC-SHA256",
    sign,
  };

  if (token) headers.access_token = token;
  if (body) headers["Content-Type"] = "application/json";

  const url = `${BASE_URL}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let res = null;
  let data = null;

  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? bodyText : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const code = error?.name === "AbortError" ? "ETIMEDOUT" : "NETWORK_ERROR";
    throw new TuyaRequestError(`Tuya network error: ${String(error.message || error)}`, { code });
  } finally {
    clearTimeout(timeout);
  }

  data = await res.json().catch(() => ({}));

  if (!res.ok || data?.success === false) {
    throw new TuyaRequestError(`Tuya error: HTTP ${res.status} - ${JSON.stringify(data)}`, {
      status: res.status,
      response: data,
      code: data?.code ? String(data.code) : null,
    });
  }

  return data;
}

function resetCachedToken() {
  cachedToken = null;
  cachedTokenExpireAt = 0;
}

function isTuyaTokenError(error) {
  if (!error) return false;

  const code = String(error.code || "");
  const responseCode = String(error.response?.code || "");
  const msg = String(error.message || "").toLowerCase();

  if (code === "1010" || code === "1011" || responseCode === "1010" || responseCode === "1011") {
    return true;
  }

  if (msg.includes("token") && (msg.includes("invalid") || msg.includes("expired"))) {
    return true;
  }

  return false;
}

function isRetryableTuyaError(error) {
  if (!error) return false;
  if (isTuyaTokenError(error)) return true;

  const code = String(error.code || "");
  const msg = String(error.message || "").toLowerCase();

  if (code === "NETWORK_ERROR" || code === "ETIMEDOUT") return true;
  if (msg.includes("fetch failed") || msg.includes("network")) return true;

  return false;
}

async function getAccessToken() {
  const now = Date.now();

  if (cachedToken && now < cachedTokenExpireAt) {
    return cachedToken;
  }

  if (tokenRequestInFlight) {
    return tokenRequestInFlight;
  }

  tokenRequestInFlight = (async () => {
    const data = await tuyaRequest({
      method: "GET",
      path: "/v1.0/token?grant_type=1",
      token: null,
    });

    const token = data?.result?.access_token;
    const expire = Number(data?.result?.expire_time);

    if (!token || !Number.isFinite(expire) || expire <= 0) {
      throw new Error(`Nao consegui obter access_token: ${JSON.stringify(data)}`);
    }

    cachedToken = token;
    cachedTokenExpireAt = Date.now() + (expire * 1000) - 30000;
    return token;
  })();

  try {
    return await tokenRequestInFlight;
  } finally {
    tokenRequestInFlight = null;
  }
}

async function runWithTokenAndRetry(fn) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const token = await getAccessToken();
      return await fn(token);
    } catch (error) {
      lastError = error;

      if (!isRetryableTuyaError(error) || attempt === 1) {
        throw error;
      }

      if (isTuyaTokenError(error)) {
        resetCachedToken();
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  throw lastError;
}

async function getDeviceStatus(deviceId) {
  return runWithTokenAndRetry((token) => (
    tuyaRequest({
      method: "GET",
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      token,
    })
  ));
}

async function sendCommands(deviceId, commands) {
  return runWithTokenAndRetry((token) => (
    tuyaRequest({
      method: "POST",
      path: `/v1.0/iot-03/devices/${deviceId}/commands`,
      token,
      body: { commands },
    })
  ));
}

module.exports = { getDeviceStatus, sendCommands };
