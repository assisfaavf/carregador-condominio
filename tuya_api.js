// tuya_api.js
// Aqui ficam as funções que conversam com a Tuya Cloud.
// A ideia é deixar a "parte chata" (assinatura, token) isolada,
// para o resto do projeto ficar simples.

const crypto = require("crypto");

// Lê as credenciais do .env (carregado no server.js via dotenv)
const BASE_URL = process.env.TUYA_BASE_URL;
const ACCESS_ID = process.env.TUYA_ACCESS_ID;
const ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET;

// Cache simples do token na memória (para não pedir token toda hora)
let cachedToken = null;
let cachedTokenExpireAt = 0;

/**
 * Gera HMAC-SHA256 em HEX maiúsculo (formato exigido pela Tuya).
 */
function hmacSha256HexUpper(key, content) {
  return crypto
    .createHmac("sha256", key)
    .update(content, "utf8")
    .digest("hex")
    .toUpperCase();
}

/**
 * Monta a assinatura da Tuya.
 * A Tuya pede uma assinatura baseada em:
 * - método HTTP (GET/POST)
 * - hash do body (SHA256)
 * - caminho da URL (path + query)
 * - timestamp
 * - e seu Access ID/Secret
 */
function buildSignature({ method, pathWithQuery, bodyText, token, t }) {
  // Hash SHA256 do corpo (mesmo que esteja vazio)
  const bodyHash = crypto
    .createHash("sha256")
    .update(bodyText || "", "utf8")
    .digest("hex");

  // canonicalHeaders vazio (aqui estamos usando o mínimo necessário)
  const stringToSign = [
    method.toUpperCase(),
    bodyHash,
    "",
    pathWithQuery
  ].join("\n");

  // Conteúdo final que será assinado
  const signContent = `${ACCESS_ID}${token || ""}${t}${stringToSign}`;

  // Assina com o Access Secret
  return hmacSha256HexUpper(ACCESS_SECRET, signContent);
}

/**
 * Função base para fazer request na Tuya.
 */
async function tuyaRequest({ method, path, body, token }) {
  if (!BASE_URL || !ACCESS_ID || !ACCESS_SECRET) {
    throw new Error("Faltam variáveis Tuya no .env (TUYA_BASE_URL, TUYA_ACCESS_ID, TUYA_ACCESS_SECRET).");
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

  // Headers obrigatórios
  const headers = {
    client_id: ACCESS_ID,
    t,
    sign_method: "HMAC-SHA256",
    sign,
  };

  // Se já tiver token, manda também
  if (token) headers.access_token = token;

  // Se tiver body, define content-type
  if (body) headers["Content-Type"] = "application/json";

  const url = `${BASE_URL}${path}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? bodyText : undefined,
  });

  const data = await res.json().catch(() => ({}));

  // Se der erro, joga um erro com detalhes para facilitar debug
  if (!res.ok || data?.success === false) {
    throw new Error(`Tuya error: HTTP ${res.status} - ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Pega o access_token e guarda em cache.
 */
async function getAccessToken() {
  const now = Date.now();

  // Reaproveita token se ainda estiver válido
  if (cachedToken && now < cachedTokenExpireAt) {
    return cachedToken;
  }

  // Endpoint do token: GET /v1.0/token?grant_type=1
  const data = await tuyaRequest({
    method: "GET",
    path: "/v1.0/token?grant_type=1",
    token: null,
  });

  const token = data?.result?.access_token;
  const expire = data?.result?.expire_time; // em segundos

  if (!token) {
    throw new Error(`Não consegui obter access_token: ${JSON.stringify(data)}`);
  }

  cachedToken = token;
  // expira 30s antes do tempo real, por segurança
  cachedTokenExpireAt = now + (expire * 1000) - 30000;

  return token;
}

/**
 * Busca status do dispositivo (lista de DPs).
 */
async function getDeviceStatus(deviceId) {
  const token = await getAccessToken();
  return tuyaRequest({
    method: "GET",
    path: `/v1.0/iot-03/devices/${deviceId}/status`,
    token,
  });
}

// Envia comandos para o carregador (ex.: switch, work_mode, corrente)
async function sendCommands(deviceId, commands) {
  const token = await getAccessToken();
  return tuyaRequest({
    method: "POST",
    path: `/v1.0/iot-03/devices/${deviceId}/commands`,
    token,
    body: { commands },
  });
}


// No final:

module.exports = { getDeviceStatus, sendCommands };

