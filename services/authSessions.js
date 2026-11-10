const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db/pg');
const config = require('../config');

function sessionId(token, claims) {
  return typeof claims.jti === 'string' ? claims.jti : crypto.createHash('sha256').update(token).digest('hex');
}

function issueToken(user, remember, settings = config) {
  const persistent = user.is_admin === true && remember === true;
  const token = jwt.sign({ id: user.id }, settings.jwtSecret, {
    jwtid: crypto.randomUUID(), expiresIn: persistent ? settings.adminRememberExpiresIn : settings.jwtExpiresIn,
  });
  const claims = jwt.decode(token);
  return { token, claims, id: claims.jti, expiresAt: new Date(claims.exp * 1000), persistent,
    maxAge: persistent ? Math.max(0, claims.exp * 1000 - Date.now()) : undefined };
}

async function create(issued, userId, executor = db) {
  await executor.query('INSERT INTO auth_sessions(id,user_id,expires_at,remembered) VALUES($1,$2,$3,$4)', [issued.id, userId, issued.expiresAt, issued.persistent]);
}

async function validate(token, claims, executor = db) {
  if (!claims.exp || claims.exp * 1000 <= Date.now()) return null;
  const id = sessionId(token, claims);
  // Existing signed JWTs are adopted once; ON CONFLICT never undoes a revocation.
  if (!claims.jti) await executor.query(`INSERT INTO auth_sessions(id,user_id,expires_at)
    VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`, [id, claims.id, new Date(claims.exp * 1000)]);
  const [session] = await executor.query(`SELECT id FROM auth_sessions WHERE id=$1 AND user_id=$2
    AND revoked_at IS NULL AND expires_at>NOW()`, [id, claims.id]);
  return session?.id || null;
}

async function revokeToken(token, executor = db, settings = config) {
  if (!token) return;
  let claims;
  try { claims = jwt.verify(token, settings.jwtSecret, { ignoreExpiration: true }); } catch { return; }
  const id = sessionId(token, claims);
  await executor.query(`INSERT INTO auth_sessions(id,user_id,expires_at,revoked_at)
    SELECT $1,id,$3,NOW() FROM users WHERE id=$2
    ON CONFLICT(id) DO UPDATE SET revoked_at=NOW()`, [id, claims.id, new Date(claims.exp * 1000)]);
}

module.exports = { issueToken, sessionId, create, validate, revokeToken };
