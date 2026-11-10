const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const vm = require('node:vm');
const { telemetrySnapshot, transitions } = require('../services/pushTelemetry');
const { validSubscription } = require('../services/adminPush');

function authModule() {
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module){' + fs.readFileSync(require.resolve('../services/authSessions'), 'utf8') + '\n})')((name) => name === '../db/pg' ? {} : name === '../config' ? {} : require(name), module);
  return module.exports;
}
const policy = { jwtSecret: 'push-tests-secret-only', jwtExpiresIn: '1h', adminRememberExpiresIn: '7d' };
test('admin lembrado recebe JWT de 7 dias e cookie persistente alinhado', () => {
  const issued = authModule().issueToken({ id: 1, is_admin: true }, true, policy);
  assert.equal(issued.persistent, true);
  assert.equal(issued.claims.exp-issued.claims.iat, 7*86400);
  assert.ok(Math.abs(Date.now()+issued.maxAge-issued.expiresAt.getTime()) < 1000);
  assert.ok(issued.id);
});
test('admin desmarcado e usuário comum preservam duração e cookie de sessão', () => {
  for (const [admin,remember] of [[true,false],[false,true],[false,false]]) {
    const issued = authModule().issueToken({ id: 1, is_admin: admin }, remember, policy);
    assert.equal(issued.persistent, false); assert.equal(issued.maxAge, undefined);
    assert.equal(issued.claims.exp-issued.claims.iat, 3600);
  }
});
test('validade ampliada é configurável e cada aparelho recebe identificador próprio', () => {
  const auth = authModule();
  const a = auth.issueToken({ id: 1, is_admin: true }, true, { ...policy, adminRememberExpiresIn: '2d' });
  const b = auth.issueToken({ id: 1, is_admin: true }, true, policy);
  assert.notEqual(a.id,b.id); assert.equal(a.claims.exp-a.claims.iat,172800);
});
test('cookie administrativo é HttpOnly/Secure em produção e persistência é opcional', () => {
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const code = source.slice(source.indexOf('function getAuthCookieOptions('),source.indexOf('function hasTuyaCredentials('));
  const context = { config: { isProd: true, cookie: { secure: false, sameSite: 'lax', path: '/', name: 'token' } } };
  vm.createContext(context); vm.runInContext(code,context);
  let options;
  const res = { cookie(_name,_token,value) { options=value; } };
  context.setAuthCookie(res,'mock',60000);
  assert.equal(options.httpOnly,true); assert.equal(options.secure,true); assert.equal(options.maxAge,60000);
  context.setAuthCookie(res,'mock'); assert.equal(options.maxAge,undefined);
});
test('inscrição só aceita serviços Push HTTPS e chaves de formato válido', () => {
  const subscription = { endpoint: 'https://web.push.apple.com/test', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
  assert.equal(validSubscription(subscription),true);
  for (const endpoint of ['http://web.push.apple.com/test','https://localhost/test','https://127.0.0.1/test','https://web.push.apple.com.evil.example/test','https://u:p@web.push.apple.com/test']) assert.equal(validSubscription({ ...subscription,endpoint }),false);
  assert.equal(validSubscription({ ...subscription,keys: {} }),false);
});
test('conexão CP é independente da confirmação de carga', () => {
  const time=Date.now();
  const snapshot=telemetrySnapshot({ result: [{ code:'connection_state',value:'controlpi_9v',time },{ code:'work_state',value:'charger_wait',time }] },time);
  assert.equal(snapshot.connected,true); assert.notEqual(snapshot.charging,true);
  assert.deepEqual(transitions({ connected:false,charging:false,observed_at:new Date(time-1000) },snapshot),['connected']);
});
test('comando switch ligado e corrente baixa não confirmam início', () => {
  const phase=Buffer.alloc(8); phase.writeUIntBE(900,2,3); phase.writeUIntBE(100,5,3);
  const time=Date.now();
  const snapshot=telemetrySnapshot({ result:[{ code:'switch',value:true,time },{ code:'work_state',value:'charger_charging',time },{ code:'phase_a',value:phase.toString('base64'),time }] },time);
  assert.notEqual(snapshot.charging,true);
});
test('estado real e fluxo confirmam início; sem CP conhecido não inventa conexão', () => {
  const phase=Buffer.alloc(8); phase.writeUIntBE(16000,2,3); phase.writeUIntBE(3500,5,3);
  const time=Date.now();
  const snapshot=telemetrySnapshot({ result:[{ code:'work_state',value:'charger_charging',time },{ code:'phase_a',value:phase.toString('base64'),time }] },time);
  assert.equal(snapshot.charging,true); assert.equal(snapshot.connected,null);
  assert.deepEqual(transitions({ connected:null,charging:false,observed_at:new Date(time-1000) },snapshot),['started']);
});
test('leituras repetidas, fora de ordem e primeira observação não criam eventos', () => {
  const now=new Date(); const previous={ connected:true,charging:true,observed_at:now };
  assert.deepEqual(transitions(previous,{ connected:true,charging:true,observedAt:now }),[]);
  assert.deepEqual(transitions(previous,{ connected:false,charging:false,observedAt:new Date(now-1000) }),[]);
  assert.deepEqual(transitions(null,{ connected:true,charging:true,observedAt:now }),[]);
});
test('falha de observação Push é isolada do watchdog', async () => {
  const source=fs.readFileSync(require.resolve('../server'),'utf8');
  const start=source.indexOf('async function observePushSafely(');
  const end=source.indexOf('\nif (config.isProd)',start);
  let logged=false;
  const context={ adminPush:{ observe:async()=>{ throw new Error('database unavailable'); } },appLogger:{ warn:()=>{ logged=true; } } };
  vm.createContext(context); vm.runInContext(source.slice(start,end),context);
  await context.observePushSafely(1,{}); assert.equal(logged,true);
});
