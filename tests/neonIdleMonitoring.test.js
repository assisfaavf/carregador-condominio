const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const postgres = { skip: !process.env.TEST_DATABASE_URL };
const settings = {
  isProd: false, tuya: {}, jwtSecret: 'monitoring-test-only',
  cookie: { name: 'token' }, pricePerKwh: 1.25,
  push: { publicKey: 'test', privateKey: 'test', subject: 'mailto:test@example.com' },
  energyValidation: { maxGapSeconds: 30, absolute: 0.2, relative: 0.05 },
};

async function database(t) {
  const schema = 'idle_' + randomUUID().replaceAll('-', '');
  const control = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await control.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema });
  t.after(async () => {
    await pool.end();
    await control.query('DROP SCHEMA ' + schema + ' CASCADE');
    await control.end();
  });
  const migrations = path.join(root, 'migrations');
  for (const file of fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrations, file), 'utf8'));
  }

  const calls = [];
  let failure;
  const queryWith = (client) => async (sql, params) => {
    calls.push(sql);
    if (failure?.test(sql)) {
      failure = null;
      throw new Error('PostgreSQL indisponível');
    }
    return (await client.query(sql, params)).rows;
  };
  return {
    calls,
    failNext(matcher) { failure = matcher; },
    query: queryWith(pool),
    healthcheck: () => queryWith(pool)('SELECT 1'),
    async withTransaction(fn) {
      const client = await pool.connect();
      const query = queryWith(client);
      try {
        await query('BEGIN');
        const result = await fn({ query });
        await query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function fakeClock() {
  let now = Date.now();
  const timers = [];
  return {
    get now() { return now; },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setInterval(fn, interval) {
      timers.push({ fn, interval, next: now + interval });
      return { unref() {} };
    },
    clearIntervals() { timers.length = 0; },
    async advance(seconds) {
      const end = now + seconds * 1000;
      while (timers.length) {
        const next = Math.min(...timers.map((timer) => timer.next));
        if (next > end) break;
        now = next;
        for (const timer of timers.filter((timer) => timer.next === next)) {
          timer.next += timer.interval;
          await timer.fn();
        }
      }
      now = end;
    },
  };
}

function fakeTuya(clock) {
  let connected = false;
  let startedAt;
  let endedAt;
  let totalBefore = 10000;
  let failLogs = false;
  const polls = [];
  const logs = [];

  function sample() {
    const work = endedAt ? 'charger_end' : startedAt ? 'charger_charging' : connected ? 'charger_wait' : 'charger_free';
    const charging = work === 'charger_charging';
    const time = endedAt || clock.now;
    const power = Buffer.alloc(8);
    power.writeUInt16BE(2200, 0);
    power.writeUIntBE(charging ? 16000 : 0, 2, 3);
    power.writeUIntBE(charging ? 3600 : 0, 5, 3);
    const once = startedAt ? Math.round((time - startedAt) / 10000) : 0;
    return { result: [
      { code: 'connection_state', value: charging ? 'controlpi_6v' : connected ? 'controlpi_9v' : 'controlpi_12v', time },
      { code: 'work_state', value: work, time },
      { code: 'switch', value: charging, time },
      { code: 'phase_a', value: power.toString('base64'), time },
      { code: 'forward_energy_total', value: totalBefore + once, time },
      { code: 'charge_energy_once', value: once, time },
    ] };
  }

  const device = {
    polls, logs,
    connect() { connected = true; },
    start() {
      connected = true;
      startedAt = clock.now;
      endedAt = null;
    },
    end() { endedAt = clock.now; },
    unplug() {
      if (startedAt && endedAt) totalBefore += Math.round((endedAt - startedAt) / 10000);
      startedAt = undefined;
      endedAt = undefined;
      connected = false;
    },
    failNextHistory() { failLogs = true; },
    async getDeviceShadow(deviceId) { polls.push(deviceId); return sample(); },
    async getDeviceLogs(_deviceId, { code, startTime, endTime }) {
      logs.push(code);
      if (failLogs) { failLogs = false; throw new Error('Histórico indisponível'); }
      const entries = code === 'work_state' && startedAt ? [
        { event_time: startedAt, value: 'charger_charging' },
        ...(endedAt ? [{ event_time: endedAt, value: 'charger_end' }] : []),
      ] : code === 'forward_energy_total' && startedAt ? [{ event_time: startedAt, value: totalBefore }] : [];
      return { result: { logs: entries.filter(({ event_time }) => event_time >= startTime && event_time <= endTime) } };
    },
    async sendCommands(_deviceId, commands) {
      if (commands.some(({ code, value }) => code === 'switch' && value === true)) device.start();
      return { success: true };
    },
  };
  return device;
}

function backend({ db, clock, device, sent = [], send }) {
  const requireFrom = createRequire(path.join(root, 'server.js'));
  const repoModules = new Map();
  function loadRepo(name) {
    if (repoModules.has(name)) return repoModules.get(name);
    const filename = path.join(root, 'repositories', name + '.js');
    const module = { exports: {} };
    const requireRepo = createRequire(filename);
    new Function('require', 'module', fs.readFileSync(filename, 'utf8'))((dependency) => {
      if (dependency === '../db/pg') return db;
      if (dependency === './sessionsRepo') return loadRepo('sessionsRepo');
      return requireRepo(dependency);
    }, module);
    repoModules.set(name, module.exports);
    return module.exports;
  }
  function loadPushModule(name) {
    const filename = path.join(root, 'services', name + '.js');
    const module = { exports: {} };
    new Function('require', 'module', 'Date', fs.readFileSync(filename, 'utf8'))(
      (dependency) => dependency === './pushTelemetry' ? loadPushModule('pushTelemetry') : requireFrom(dependency),
      module,
      clock.Date,
    );
    return module.exports;
  }
  const imports = {
    dotenv: { config() {} },
    './config': settings,
    './services/adminPush': loadPushModule('adminPush'),
    './db/pg': db,
    './tuya_api': device,
    pino: () => requireFrom('pino')({ enabled: false }),
    'web-push': { async sendNotification(_sub, payload) { const message = JSON.parse(payload); await send?.(message); sent.push(message); } },
    './services/authSessions': { validate: async () => 'test-admin' },
  };
  const mockRequire = (name) => imports[name] ?? (name.startsWith('./repositories/')
    ? loadRepo(path.basename(name)) : requireFrom(name));
  const module = { exports: {} };
  new Function('require', '__dirname', 'module', 'Date', 'setInterval', 'setTimeout',
    source.slice(0, source.indexOf('const PORT = config.port;')) +
    '\nmodule.exports = { app, startBackgroundJobs, startSessionFlow };'
  )(mockRequire, root, module, clock.Date, clock.setInterval, queueMicrotask);
  return module.exports;
}

async function station(db, deviceId = 'mock-charger') {
  const [row] = await db.query('INSERT INTO stations(name,tuya_device_id) VALUES($1,$1) RETURNING *', [deviceId]);
  return row;
}

async function administrator(db) {
  const [user] = await db.query("INSERT INTO users(name,email,password_hash,is_admin,approval_status) VALUES('Admin','admin@invalid.local','test',TRUE,'approved') RETURNING id");
  return user;
}

async function pushSubscription(db, userId) {
  await db.query("INSERT INTO auth_sessions(id,user_id,expires_at) VALUES('test-admin',$1,NOW()+INTERVAL '1 hour')", [userId]);
  await db.query("INSERT INTO push_subscriptions(auth_session_id,endpoint,subscription) VALUES('test-admin','mock-push',$1)", [{ endpoint: 'https://web.push.apple.com/mock' }]);
}

test('watchdog, conciliação e Push ociosos: dez minutos de Tuya a cada 5 s e zero consultas PostgreSQL', postgres, async (t) => {
  const db = await database(t);
  await station(db);
  const clock = fakeClock();
  const device = fakeTuya(clock);
  await backend({ db, clock, device }).startBackgroundJobs();
  assert.equal(device.polls.length, 1);
  const startupQueries = db.calls.length;
  assert.ok(startupQueries > 0);

  await clock.advance(600);
  assert.equal(device.polls.length, 121);
  assert.equal(db.calls.length - startupQueries, 0);
});

test('cache acompanha cadastro, edição, ativação e desativação pelas rotas administrativas', postgres, async (t) => {
  const db = await database(t);
  const user = await administrator(db);
  const clock = fakeClock();
  const device = fakeTuya(clock);
  const server = backend({ db, clock, device });
  await server.startBackgroundJobs();
  const listener = server.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const base = 'http://127.0.0.1:' + listener.address().port;
  const queries = db.calls.length;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal(db.calls.length, queries);
  assert.equal((await fetch(base + '/health/db')).status, 200);
  assert.equal(db.calls.length, queries + 1);
  const token = require('jsonwebtoken').sign({ id: user.id }, settings.jwtSecret);
  const request = (method, suffix, body) => fetch(base + '/api/admin/stations' + suffix, {
    method, headers: { Cookie: 'token=' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const created = await request('POST', '', { name: 'Teste', tuya_device_id: 'device-a', max_current_a: 32, is_active: true });
  assert.equal(created.status, 201, await created.clone().text());
  const { station: row } = await created.json();
  await clock.advance(5);
  assert.deepEqual(device.polls, ['device-a']);
  for (const patch of [{ tuya_device_id: 'device-b' }, { is_active: false }, { is_active: true }]) {
    assert.equal((await request('PATCH', '/' + row.id, patch)).status, 200);
    await clock.advance(5);
  }
  assert.deepEqual(device.polls, ['device-a', 'device-b', 'device-b']);
});

test('recarga pelo app sobrevive ao reinício, persiste leituras e finaliza uma única vez', postgres, async (t) => {
  const db = await database(t);
  const charger = await station(db);
  const user = await administrator(db);
  await pushSubscription(db, user.id);
  const [address] = await db.query("INSERT INTO addresses(user_id,label) VALUES($1,'Teste') RETURNING id", [user.id]);
  const clock = fakeClock();
  const device = fakeTuya(clock);
  const sent = [];
  let server = backend({ db, clock, device, sent });
  await server.startBackgroundJobs();
  device.connect();
  await clock.advance(15);
  assert.equal((await db.query('SELECT COUNT(*) FROM sessions'))[0].count, '0');

  db.failNext(/INSERT INTO sessions/);
  const start = { userId: user.id, addressId: address.id, station: charger };
  await assert.rejects(server.startSessionFlow(start), /PostgreSQL/);
  assert.equal((await db.query('SELECT COUNT(*) FROM sessions'))[0].count, '0');
  const result = await server.startSessionFlow(start);
  assert.equal(result.success, true);
  await clock.advance(85);
  const id = result.body.sessionId;
  const mid = await db.query('SELECT * FROM session_energy_readings WHERE session_id=$1', [id]);
  assert.ok(mid.length > 5);

  clock.clearIntervals();
  server = backend({ db, clock, device, sent });
  await server.startBackgroundJobs();
  await clock.advance(110);
  device.end();
  await clock.advance(10);
  db.failNext(/SELECT tariff_per_kwh FROM sessions WHERE id=\$1 FOR UPDATE/);
  await clock.advance(5);
  assert.equal((await db.query('SELECT status FROM sessions WHERE id=$1', [id]))[0].status, 'running');
  device.unplug();
  await clock.advance(30);

  const rows = await db.query('SELECT * FROM sessions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, user.id);
  assert.equal(rows[0].origin, 'program');
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[0].reconciliation.status, 'validated', JSON.stringify(rows[0].reconciliation));
  assert.equal(Number(rows[0].energy_kwh), 0.2);
  assert.equal(Number(rows[0].energy_once), 0.2);
  assert.equal((await db.query("SELECT COUNT(*) FROM session_revisions WHERE action='physical_end'"))[0].count, '1');
  assert.deepEqual(sent.map(({ tag }) => tag.split(':')[0]), ['connected', 'started', 'finished']);
});

test('recarga externa recupera falha na abertura e conciliação persistida após reinício', postgres, async (t) => {
  const db = await database(t);
  await station(db);
  const clock = fakeClock();
  const device = fakeTuya(clock);
  await backend({ db, clock, device }).startBackgroundJobs();
  device.start();
  db.failNext(/INSERT INTO sessions/);
  await clock.advance(5);
  assert.equal((await db.query('SELECT COUNT(*) FROM sessions'))[0].count, '0');
  await clock.advance(190);
  device.end();
  db.failNext(/SELECT \* FROM sessions WHERE id = \$1 FOR UPDATE/);
  await clock.advance(15);
  const [pending] = await db.query('SELECT * FROM sessions');
  assert.equal(pending.status, 'done');
  assert.equal(pending.origin, 'external');
  assert.equal(pending.reconciliation.status, 'pending');

  clock.clearIntervals();
  await backend({ db, clock, device }).startBackgroundJobs();
  device.failNextHistory();
  await clock.advance(60);
  const [retry] = await db.query('SELECT * FROM sessions');
  assert.ok(retry.reconciliation.last_attempt_at);
  assert.equal(retry.reconciliation.status, 'pending');
  await clock.advance(300);
  const rows = await db.query('SELECT * FROM sessions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reconciliation.status, 'validated', JSON.stringify(rows[0].reconciliation));
  assert.equal(Number(rows[0].energy_kwh), 0.2);
  assert.ok(device.logs.includes('phase_a'));
  assert.equal((await db.query("SELECT COUNT(*) FROM session_revisions WHERE action='automatic_reconciliation'"))[0].count, '1');

  const idleQueries = db.calls.length;
  await clock.advance(120);
  assert.equal(db.calls.length, idleQueries);
});

test('Push retenta recusa temporária após reinício e não reenvia uma entrega concluída', postgres, async (t) => {
  const db = await database(t);
  await station(db);
  const user = await administrator(db);
  await pushSubscription(db, user.id);
  const clock = fakeClock();
  const device = fakeTuya(clock);
  const sent = [];
  let attempts = 0;
  const send = async () => {
    if (++attempts === 1) throw Object.assign(new Error('Limite temporário do provedor'), { statusCode: 429 });
  };
  const dependencies = { db, clock, device, sent, send };
  await backend(dependencies).startBackgroundJobs();
  device.connect();
  await clock.advance(15);
  assert.equal(attempts, 1);
  assert.equal(sent.length, 0);
  const [delivery] = await db.query('SELECT * FROM push_deliveries');
  assert.equal(delivery.state, 'pending');
  assert.equal(delivery.error_code, '429');
  assert.ok(delivery.claimed_at > new Date());

  clock.clearIntervals();
  // Let the persisted retry become due in the PostgreSQL clock as well.
  await db.query("UPDATE push_deliveries SET claimed_at=NOW()-INTERVAL '1 second'");
  await backend(dependencies).startBackgroundJobs();
  assert.equal(attempts, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0].tag, /^connected:/);
  assert.equal((await db.query('SELECT state FROM push_deliveries'))[0].state, 'sent');

  clock.clearIntervals();
  await backend(dependencies).startBackgroundJobs();
  const idleQueries = db.calls.length;
  await clock.advance(60);
  assert.equal(db.calls.length, idleQueries);
  assert.equal(attempts, 2);
  assert.equal((await db.query('SELECT COUNT(*) FROM push_deliveries'))[0].count, '1');
});
