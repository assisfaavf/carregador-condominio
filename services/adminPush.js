const { telemetrySnapshot, transitions } = require('./pushTelemetry');

function validSubscription(subscription) {
  try {
    const url = new URL(subscription?.endpoint);
    const host = url.hostname;
    const provider = host === 'fcm.googleapis.com' || host.endsWith('.push.apple.com')
      || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com')
      || host.endsWith('.notify.windows.com');
    return provider && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && subscription.endpoint.length <= 4096 && /^[A-Za-z0-9_-]{87}$/.test(subscription.keys?.p256dh || '')
      && /^[A-Za-z0-9_-]{22}$/.test(subscription.keys?.auth || '');
  } catch { return false; }
}

function createAdminPush({ db, webpush, config, logger }) {
  const configured = () => Boolean(config.publicKey && config.privateKey && /^(mailto:|https:\/\/)/.test(config.subject));
  let busy = false;
  let dueAt = 0;
  let loaded = false;
  const stationStates = new Map();
  const pendingSamples = new Map();

  function wake() {
    if (configured()) dueAt = 0;
  }

  async function load() {
    for (const state of await db.query('SELECT * FROM push_station_state')) {
      const key = String(state.station_id);
      if (!stationStates.has(key)) stationStates.set(key, state);
    }
    loaded = true;
  }

  async function persistObservation(stationId, sample) {
    const state = await db.withTransaction(async (tx) => {
      const [previous] = await tx.query('SELECT * FROM push_station_state WHERE station_id=$1 FOR UPDATE', [stationId]);
      if (sample.charging == null && sample.waiting && previous.charging !== true) sample.charging = false;
      if (sample.observedAt <= new Date(previous.observed_at)) return previous;
      const events = transitions(previous, sample);
      const [state] = await tx.query(`UPDATE push_station_state SET connected=COALESCE($2,connected), charging=COALESCE($3,charging),
        connection_cycle=connection_cycle+$5, charging_cycle=charging_cycle+$6, observed_at=$4 WHERE station_id=$1 RETURNING *`,
      [stationId, sample.connected, sample.charging, sample.observedAt, events.includes('connected') ? 1 : 0, events.includes('started') ? 1 : 0]);
      for (const kind of events) {
        const cycle = kind === 'connected' ? state.connection_cycle : state.charging_cycle;
        await tx.query(`INSERT INTO push_events(event_key,station_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [`${kind}:${stationId}:${cycle}`, stationId, kind]);
      }
      return state;
    });
    // A retry may encounter a transition that committed before its response was lost.
    wake();
    return state;
  }

  async function observe(stationId, status) {
    if (!configured()) return;
    const key = String(stationId);
    let previous = stationStates.get(key);
    if (pendingSamples.has(key)) {
      previous = await persistObservation(stationId, pendingSamples.get(key));
      pendingSamples.delete(key);
      stationStates.set(key, previous);
    }
    const sample = telemetrySnapshot(status);
    if (sample.charging == null && sample.waiting && previous?.charging !== true) sample.charging = false;
    if (sample.connected == null && sample.charging == null) return;
    if (!previous) {
      // Persist a new station's first usable baseline so a connection during
      // a later restart can still be recognized. This runs once per station.
      const [state] = await db.query(`INSERT INTO push_station_state(station_id,connected,charging,observed_at)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,
      [stationId, sample.connected, sample.charging, sample.observedAt]);
      if (state) {
        stationStates.set(key, state);
        return;
      }
      [previous] = await db.query('SELECT * FROM push_station_state WHERE station_id=$1', [stationId]);
      stationStates.set(key, previous);
    }
    if (sample.observedAt <= new Date(previous.observed_at)) return;
    if ((sample.connected == null || sample.connected === previous.connected)
      && (sample.charging == null || sample.charging === previous.charging)) return;
    pendingSamples.set(key, sample);
    // A lost commit response can leave a durable event even if the next sample
    // finds it already recorded. Signal the worker before attempting the write.
    wake();
    stationStates.set(key, await persistObservation(stationId, sample));
    pendingSamples.delete(key);
  }

  async function subscribe(authSessionId, subscription) {
    if (!configured()) { const error = new Error('Notificações ainda não configuradas no servidor.'); error.statusCode = 503; throw error; }
    if (!validSubscription(subscription)) { const error = new Error('Inscrição Push inválida ou provedor não permitido.'); error.statusCode = 400; throw error; }
    await db.withTransaction(async (tx) => {
      const [session] = await tx.query(`SELECT a.id FROM auth_sessions a JOIN users u ON u.id=a.user_id
        WHERE a.id=$1 AND a.revoked_at IS NULL AND a.expires_at>NOW() AND u.is_admin=TRUE AND u.approval_status IS DISTINCT FROM 'rejected' FOR UPDATE OF a`, [authSessionId]);
      if (!session) { const error = new Error('Sessão administrativa inválida.'); error.statusCode = 403; throw error; }
      await tx.query('UPDATE push_subscriptions SET enabled=FALSE WHERE auth_session_id=$1 AND endpoint<>$2', [authSessionId, subscription.endpoint]);
      await tx.query(`INSERT INTO push_subscriptions(auth_session_id,endpoint,subscription) VALUES($1,$2,$3)
        ON CONFLICT(endpoint) DO UPDATE SET auth_session_id=EXCLUDED.auth_session_id,subscription=EXCLUDED.subscription,
          enabled=TRUE,enabled_at=NOW()`, [authSessionId, subscription.endpoint, { endpoint: subscription.endpoint, keys: subscription.keys }]);
    });
  }

  async function tick() {
    if (dueAt <= Date.now()) await dispatch();
  }

  async function dispatch() {
    if (busy || !configured()) return;
    busy = true;
    dueAt = Infinity;
    try {
      if (!loaded) await load();
      // Recover durable events on startup and materialize newly validated sessions.
      const finished = await db.query(`INSERT INTO push_events(event_key,station_id,session_id,kind,created_at)
        SELECT 'finished:'||s.id,s.station_id,s.id,'finished',s.push_validated_at FROM sessions s
        WHERE s.status='done' AND s.reconciliation->>'status'='validated'
          AND s.push_validated_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM push_events e WHERE e.event_key='finished:'||s.id)
        ORDER BY s.id LIMIT 50 ON CONFLICT DO NOTHING RETURNING id`);
      await db.query(`UPDATE push_subscriptions p SET enabled=FALSE FROM auth_sessions a,users u
        WHERE p.auth_session_id=a.id AND u.id=a.user_id AND p.enabled=TRUE
          AND (a.revoked_at IS NOT NULL OR a.expires_at<=NOW() OR u.is_admin IS NOT TRUE OR u.approval_status='rejected')`);
      await db.query(`INSERT INTO push_deliveries(event_id,subscription_id)
        SELECT e.id,p.id FROM push_events e JOIN push_subscriptions p ON p.enabled=TRUE AND p.enabled_at<=e.created_at
          JOIN auth_sessions a ON a.id=p.auth_session_id JOIN users u ON u.id=a.user_id
        WHERE e.created_at>NOW()-INTERVAL '15 minutes' AND a.revoked_at IS NULL AND a.expires_at>NOW() AND u.is_admin=TRUE AND u.approval_status IS DISTINCT FROM 'rejected'
        ON CONFLICT DO NOTHING`);
      const pending = await db.query(`SELECT event_id,subscription_id FROM push_deliveries
        WHERE state='pending' AND (claimed_at IS NULL OR claimed_at<=NOW())
        ORDER BY event_id,subscription_id LIMIT 20`);
      for (const delivery of pending) {
        // Fresh DB authorization immediately before each individual send, including after logout/role changes.
        const [recipient] = await db.query(`SELECT p.subscription,e.kind,e.event_key,e.station_id,e.session_id,st.name,
            a.expires_at,s.reconciliation->>'reconciled_kwh' AS energy_kwh
          FROM push_subscriptions p JOIN auth_sessions a ON a.id=p.auth_session_id JOIN users u ON u.id=a.user_id
          JOIN push_events e ON e.id=$1 JOIN stations st ON st.id=e.station_id LEFT JOIN sessions s ON s.id=e.session_id
          WHERE p.id=$2 AND p.enabled=TRUE AND p.enabled_at<=e.created_at AND a.revoked_at IS NULL AND a.expires_at>NOW() AND u.is_admin=TRUE AND u.approval_status IS DISTINCT FROM 'rejected'
            AND e.created_at>NOW()-INTERVAL '15 minutes'
            AND (e.kind<>'finished' OR (s.status='done' AND s.reconciliation->>'status'='validated'))`, [delivery.event_id, delivery.subscription_id]);
        // Claim only the delivery about to be sent. A restart before this
        // point leaves it pending. After the claim an ambiguous send is never replayed.
        const [claim] = await db.query(`UPDATE push_deliveries SET state='claimed',claimed_at=NOW()
          WHERE event_id=$1 AND subscription_id=$2 AND state='pending' AND (claimed_at IS NULL OR claimed_at<=NOW())
          RETURNING event_id`, [delivery.event_id,delivery.subscription_id]);
        if (!claim) continue;
        let state = 'skipped'; let errorCode = null;
        if (recipient) {
          try {
            const titles = { connected: 'Carro conectado', started: 'Recarga iniciada', finished: 'Recarga finalizada' };
            const payload = { title: `SPATE Charge — ${titles[recipient.kind]}`, body: recipient.name,
              tag: recipient.event_key, url: recipient.kind === 'finished' ? '/admin/history' : `/admin/dashboard?station_id=${recipient.station_id}` };
            if (recipient.kind === 'finished') payload.body += ` • ${Number(recipient.energy_kwh).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kWh`;
            await webpush.sendNotification(recipient.subscription, JSON.stringify(payload), {
              vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
              TTL: Math.max(0, Math.min(300, Math.floor((new Date(recipient.expires_at)-Date.now())/1000))), timeout: 5000,
            });
            state = 'sent';
          } catch (error) {
            state = [429, 503].includes(error.statusCode) ? 'pending' : 'failed';
            errorCode = String(error.statusCode || 'push_failed');
            logger.warn({ event_id: delivery.event_id, subscription_id: delivery.subscription_id, code: errorCode }, 'Falha no envio Web Push.');
            if ([404,410].includes(error.statusCode)) await db.query('UPDATE push_subscriptions SET enabled=FALSE WHERE id=$1', [delivery.subscription_id]);
          }
        }
        await db.query(`UPDATE push_deliveries SET state=$3,error_code=$4,
          completed_at=CASE WHEN $3='pending' THEN NULL ELSE NOW() END,
          claimed_at=CASE WHEN $3='pending' THEN NOW()+INTERVAL '1 minute' ELSE claimed_at END
          WHERE event_id=$1 AND subscription_id=$2`, [delivery.event_id,delivery.subscription_id,state,errorCode]);
      }
      if (finished.length === 50 || pending.length === 20) {
        wake();
      } else {
        const [next] = await db.query(`SELECT MIN(claimed_at) AS due_at FROM push_deliveries WHERE state='pending'`);
        if (next?.due_at) dueAt = Math.min(dueAt, new Date(next.due_at).getTime());
      }
    } catch {
      wake();
      logger.warn('Falha no processamento Web Push; monitoramento preservado.');
    }
    finally { busy = false; }
  }
  return { configured, observe, subscribe, dispatch, tick, wake };
}
module.exports = { createAdminPush, validSubscription };
