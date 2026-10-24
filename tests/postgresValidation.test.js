const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('PostgreSQL: migration, deduplicação, encerramento idempotente, auditoria e cobrança', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  const schema = `validation_test_${Date.now()}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    for (const file of fs.readdirSync(path.join(__dirname, '../migrations')).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
    }
    const tx = { query: async (sql, params) => (await client.query(sql, params)).rows, withTransaction: async (fn) => fn(tx) };
    const cache = {};
    function load(name) {
      if (cache[name]) return cache[name];
      const module = { exports: {} };
      const source = fs.readFileSync(path.join(__dirname, '../repositories', `${name}.js`), 'utf8');
      vm.runInThisContext(`(function(require,module,exports){${source}\n})`)((specifier) => specifier === '../db/pg' ? tx : specifier.startsWith('./') ? load(specifier.slice(2)) : require(specifier), module, module.exports);
      cache[name] = module.exports;
      return module.exports;
    }
    const sessions = load('sessionsRepo');
    const energy = load('energyReadingsRepo');
    const [user] = await tx.query("INSERT INTO users(name,email,password_hash) VALUES ('Teste','teste@invalid.local','ficticio') RETURNING id");
    const [address] = await tx.query("INSERT INTO addresses(user_id,label) VALUES ($1,'Teste') RETURNING id", [user.id]);
    const [station] = await tx.query("INSERT INTO stations(name,tuya_device_id) VALUES ('Teste','mock-only') RETURNING id");
    const session = await sessions.createRunning({ user_id: user.id, address_id: address.id, station_id: station.id, start_energy_total: 0, tariff_per_kwh: 1.2 });
    const reading = { observed_at: new Date().toISOString(), source: 'mock', total_kwh: 1, once_kwh: 1, power_kw: 6, current_a: 27, voltage_v: 220, work_state: 'charger_charging', charging: true, raw_fields: {} };
    await energy.record(session.id, reading); await energy.record(session.id, reading);
    assert.equal((await energy.list(session.id)).length, 1);
    assert.ok(await sessions.finishSession(session.id, { status: 'done', end_time: new Date(), energy_kwh: null }));
    assert.equal(await sessions.finishSession(session.id, { status: 'done' }), null);
    await client.query('SAVEPOINT payment_check');
    await assert.rejects(energy.revise(session.id, user.id, { payment_status: 'pago' }, 'Teste sem validação'), /validado/);
    await client.query('ROLLBACK TO SAVEPOINT payment_check');
    await energy.revise(session.id, user.id, { reconciliation: { status: 'validated', reconciled_kwh: 1, manual: true } }, 'Medição conferida no teste');
    await energy.revise(session.id, user.id, { payment_status: 'pago' }, 'Pagamento de teste');
    const updated = await sessions.getById(session.id);
    assert.equal(updated.energy_kwh, 1); assert.equal(updated.price_calculated, 1.2);
    assert.equal(updated.payment_status, 'pago');
    assert.equal((await tx.query('SELECT * FROM session_revisions')).length, 2);
    const clients = load('chargingClientsRepo');
    const owner = await clients.create({ name: 'Cliente tarifado', tariff_per_kwh: 2.75 });
    const defaultOwner = await clients.create({ name: 'Tarifa padrão' });
    const freeOwner = await clients.create({ name: 'Tarifa zero', tariff_per_kwh: 0 });
    assert.equal((await clients.getById(owner.id)).tariff_per_kwh, 2.75);
    assert.equal(defaultOwner.tariff_per_kwh, null);
    assert.equal(freeOwner.tariff_per_kwh, 0);
    assert.equal((await clients.listAll()).length, 3);
    await client.query('SAVEPOINT invalid_tariff');
    await assert.rejects(clients.create({ name: 'Tarifa inválida', tariff_per_kwh: -1 }));
    await client.query('ROLLBACK TO SAVEPOINT invalid_tariff');

    const provisional = await sessions.createRunning({ user_id: null, address_id: null, station_id: station.id, start_energy_total: 100, tariff_per_kwh: 1.2, origin: 'external' });
    await sessions.finishSession(provisional.id, { status: 'done', end_time: new Date(), end_energy_total: 105 });
    const suggestion = require('../services/energyValidation').reconcile(await sessions.getById(provisional.id), []);
    await energy.revise(provisional.id, null, { reconciliation: suggestion }, 'Consumo provisório do acompanhamento');
    let snapshot = await sessions.getById(provisional.id);
    assert.equal(snapshot.energy_kwh, 5); assert.equal(snapshot.price_calculated, 6);
    assert.equal(require('../services/energyValidation').billingReady(snapshot), false);
    await energy.revise(provisional.id, null, { reconciliation: { status: 'inconclusive' } }, 'Revisão sem novas evidências');
    snapshot = await sessions.getById(provisional.id);
    assert.equal(snapshot.energy_kwh, 5); assert.equal(snapshot.price_calculated, 6);
    await energy.revise(provisional.id, user.id, { client_id: owner.id }, 'Cliente vinculado');
    snapshot = await sessions.getById(provisional.id);
    assert.equal(snapshot.tariff_per_kwh, 2.75); assert.equal(snapshot.price_calculated, 13.75);
    const [withClient] = await sessions.listAdmin({ id: provisional.id });
    assert.equal(withClient.client.tariff_per_kwh, 2.75);
    await tx.query('UPDATE charging_clients SET tariff_per_kwh=3.5 WHERE id=$1', [owner.id]);
    await energy.revise(provisional.id, user.id, { reconciliation: { ...suggestion, status: 'validated', reconciled_kwh: 4, manual: true } }, 'Correção do consumo');
    snapshot = await sessions.getById(provisional.id);
    assert.equal(snapshot.tariff_per_kwh, 2.75); assert.equal(snapshot.price_calculated, 11);
    assert.equal(snapshot.needs_review, false);
    assert.equal(snapshot.reconciliation.status, 'validated');
    assert.equal(snapshot.reconciliation.manual, true);
    await assert.rejects(energy.revise(provisional.id, null, { reconciliation: suggestion }, 'Tentativa automática após correção manual'), /manual/);
    await energy.revise(provisional.id, user.id, { price_override: 9 }, 'Valor manual');
    await energy.revise(provisional.id, user.id, { client_id: freeOwner.id }, 'Troca do cliente');
    snapshot = await sessions.getById(provisional.id);
    assert.equal(snapshot.tariff_per_kwh, 0); assert.equal(snapshot.price_calculated, 0); assert.equal(snapshot.price_override, 9);
    assert.equal((await sessions.getById(session.id)).price_calculated, 1.2);
    await energy.revise(provisional.id, user.id, { payment_status: 'pago' }, 'Pagamento conferido');
    await assert.rejects(energy.revise(provisional.id, user.id, { client_id: owner.id }, 'Repreço indevido'), /sessão paga/);
    await tx.query("UPDATE sessions SET reconciliation=NULL WHERE id=$1", [session.id]);
    await energy.revise(session.id, user.id, { payment_status: 'pendente' }, 'Reabrir pagamento histórico para revisão');
    assert.equal((await sessions.getById(session.id)).payment_status, 'pendente');
  } finally {
    await client.query('ROLLBACK'); await client.end();
  }
});
