const POLL_MS = 3000;
const STATION_STORAGE_KEY = "admin_selected_station_id";

const adminState = {
  actionBusy: false,
  actionBusyLabel: "",
  refreshBusy: false,
  pollTimer: null,
  elapsedTimer: null,
  lastRunKwhByStation: {},
  users: [],
  stations: [],
  userAddresses: [],
  live: null,
  currentSessions: [],
  chargingSessions: [],
  chargingClients: [],
  modalResolve: null,
  modalBusy: false,
};

function setMsg(text, type = "") {
  const msg = document.getElementById("msg");
  msg.textContent = text || "";
  msg.className = type ? `message ${type}` : "message";
}

function setStationMsg(text, type = "") {
  const msg = document.getElementById("stationMsg");
  msg.textContent = text || "";
  msg.className = type ? `message ${type}` : "message";
}

function setSessionsMsg(text, type = "") {
  const msg = document.getElementById("sessionsMsg");
  if (!msg) return;
  msg.textContent = text || "";
  msg.className = type ? `message ${type}` : "message";
}

function setClientMsg(text, type = "") {
  const msg = document.getElementById("clientMsg");
  if (!msg) return;
  msg.textContent = text || "";
  msg.className = type ? `message ${type}` : "message";
}

function formatElapsed(sec) {
  const s = Number(sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function getRunningElapsedSecondsNow() {
  const running = getRunningForSelectedStation();
  if (!running) return 0;

  if (running.start_time) {
    const parsed = Date.parse(running.start_time);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
    }
  }

  return Math.max(0, Math.floor(Number(running.elapsed_seconds || 0)));
}

function renderRunElapsedNow() {
  document.getElementById("runElapsed").textContent = formatElapsed(getRunningElapsedSecondsNow());
}

function fmt(v, digits = 2) {
  return (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(digits) : "--";
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatKwh(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)} kWh` : "--";
}

function formatClientLabel(client) {
  if (!client) return "Sem cliente";
  const unit = [client.tower, client.apartment].filter(Boolean).join("/");
  return [client.name || "-", unit].filter(Boolean).join(" - ");
}

function formatTelemetryError(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  return text ? ` Detalhe: ${text}` : "";
}

function getCachedRunKwh(stationId) {
  return adminState.lastRunKwhByStation[String(stationId)];
}

function setCachedRunKwh(stationId, kwh) {
  if (!stationId) return;
  if (typeof kwh !== "number" || !Number.isFinite(kwh)) return;
  adminState.lastRunKwhByStation[String(stationId)] = kwh;
}

function clearCachedRunKwh(stationId) {
  if (!stationId) return;
  delete adminState.lastRunKwhByStation[String(stationId)];
}

function getSelectedUserId() {
  const n = Number(document.getElementById("userSelect").value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getSelectedAddressId() {
  const n = Number(document.getElementById("userAddressSelect").value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getSelectedStationId() {
  const n = Number(document.getElementById("controlStationSelect").value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getSelectedStation() {
  const stationId = getSelectedStationId();
  return adminState.stations.find((item) => item.id === stationId) || null;
}

function getRunningForSelectedStation() {
  const stationId = getSelectedStationId();
  if (!stationId) return null;
  return adminState.currentSessions.find((item) => item.station_id === stationId) || null;
}

function hasActiveSession() {
  return Boolean(getRunningForSelectedStation());
}

function updateControlStationLabel() {
  const station = getSelectedStation();
  const label = station ? `${station.name} (${station.location_label || "sem local"})` : "Nenhuma";
  document.getElementById("controlStationLabel").textContent = `Estacao selecionada: ${label}`;
}

function resetStationForm() {
  document.getElementById("stationId").value = "";
  document.getElementById("stationName").value = "";
  document.getElementById("stationLocation").value = "";
  document.getElementById("stationDevice").value = "";
  document.getElementById("stationCurrent").value = "32";
  document.getElementById("stationActive").checked = true;
}

function fillStationForm(station) {
  document.getElementById("stationId").value = String(station.id);
  document.getElementById("stationName").value = station.name || "";
  document.getElementById("stationLocation").value = station.location_label || "";
  document.getElementById("stationDevice").value = station.tuya_device_id || "";
  document.getElementById("stationCurrent").value = String(station.max_current_a || 32);
  document.getElementById("stationActive").checked = station.is_active === true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function fillControlStationSelect() {
  const select = document.getElementById("controlStationSelect");
  const savedId = Number(localStorage.getItem(STATION_STORAGE_KEY) || "0");
  const selectedValid = adminState.stations.some((item) => item.id === savedId);
  const fallback = adminState.stations.find((item) => item.is_active) || adminState.stations[0] || null;
  const selectedId = selectedValid ? savedId : (fallback ? fallback.id : null);

  select.innerHTML = "";
  if (adminState.stations.length === 0) {
    select.innerHTML = '<option value="">Nenhuma estacao</option>';
    localStorage.removeItem(STATION_STORAGE_KEY);
    updateControlStationLabel();
    renderActionButton();
    return;
  }

  for (const station of adminState.stations) {
    const option = document.createElement("option");
    option.value = String(station.id);
    option.textContent = `${station.name} (${station.location_label || "sem local"}) ${station.is_active ? "" : "[inativa]"}`.trim();
    select.appendChild(option);
  }

  if (selectedId) {
    select.value = String(selectedId);
    localStorage.setItem(STATION_STORAGE_KEY, String(selectedId));
  }

  updateControlStationLabel();
  renderActionButton();
}

function fillAddressSelect() {
  const select = document.getElementById("userAddressSelect");
  select.innerHTML = "";
  if (adminState.userAddresses.length === 0) {
    select.innerHTML = '<option value="">Sem endereco</option>';
    return;
  }

  for (const address of adminState.userAddresses) {
    const option = document.createElement("option");
    option.value = String(address.id);
    option.textContent = `${address.label}${address.is_default ? " [padrao]" : ""}`;
    select.appendChild(option);
  }
}

async function requireAdmin() {
  const res = await fetch("/auth/me");
  if (!res.ok) {
    window.location.href = "/login.html";
    return false;
  }
  const data = await res.json();
  if (data?.user?.is_admin !== true) {
    window.location.href = "/app.html";
    return false;
  }
  return true;
}
async function loadUsers() {
  const res = await fetch("/api/admin/users");
  const data = await res.json().catch(() => ({}));
  const select = document.getElementById("userSelect");
  select.innerHTML = "";

  if (!res.ok || !data.success || !Array.isArray(data.users)) {
    adminState.users = [];
    adminState.userAddresses = [];
    select.innerHTML = '<option value="">Erro ao carregar usuarios</option>';
    fillAddressSelect();
    renderActionButton();
    return;
  }

  adminState.users = data.users;
  select.innerHTML = '<option value="">Selecione um usuario...</option>';
  for (const user of adminState.users) {
    const option = document.createElement("option");
    option.value = String(user.id);
    option.textContent = `${user.name || "Sem nome"} (${user.email || "sem-email"})${user.is_admin ? " [admin]" : ""}`;
    select.appendChild(option);
  }
  renderActionButton();
}

async function loadAddressesForUser(userId) {
  if (!userId) {
    adminState.userAddresses = [];
    fillAddressSelect();
    return;
  }

  const res = await fetch(`/api/admin/users/${userId}/addresses`);
  const data = await res.json().catch(() => ({}));
  adminState.userAddresses = res.ok && data.success && Array.isArray(data.addresses) ? data.addresses : [];
  fillAddressSelect();
}

function renderStationsTable() {
  const tbody = document.getElementById("stationsTableBody");
  tbody.innerHTML = "";

  if (!Array.isArray(adminState.stations) || adminState.stations.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7">Nenhuma estacao cadastrada.</td></tr>';
    return;
  }

  for (const station of adminState.stations) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${station.id}</td>
      <td>${station.name || "-"}</td>
      <td>${station.location_label || "-"}</td>
      <td>${station.tuya_device_id || "-"}</td>
      <td>${station.max_current_a || "-"}</td>
      <td>${station.is_active ? "Ativa" : "Inativa"}</td>
      <td class="table-actions">
        <button class="btn btn-secondary btn-inline" data-action="edit" data-id="${station.id}">Editar</button>
        <button class="btn btn-secondary btn-inline" data-action="toggle" data-id="${station.id}">
          ${station.is_active ? "Desativar" : "Ativar"}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadStationsAdmin() {
  const res = await fetch("/api/admin/stations");
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.success || !Array.isArray(data.stations)) {
    adminState.stations = [];
    renderStationsTable();
    fillControlStationSelect();
    setStationMsg("Erro ao carregar estacoes.", "error");
    return;
  }

  adminState.stations = data.stations;
  renderStationsTable();
  fillControlStationSelect();
}

async function loadCurrentSessions() {
  const res = await fetch("/api/admin/current-sessions");
  const data = await res.json().catch(() => ({}));
  adminState.currentSessions = res.ok && data.success && Array.isArray(data.running) ? data.running : [];
}

function renderChargingSessionsTable() {
  const tbody = document.getElementById("chargingSessionsTableBody");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!Array.isArray(adminState.chargingSessions) || adminState.chargingSessions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6">Nenhum carregamento registrado.</td></tr>';
    return;
  }

  for (const session of adminState.chargingSessions) {
    const tr = document.createElement("tr");
    tr.dataset.sessionId = String(session.id);

    for (const text of [
      String(session.id ?? "--"),
      formatDateTime(session.start_time),
      session.end_time ? formatDateTime(session.end_time) : "Em andamento",
      formatKwh(session.energy_kwh),
      session.client_label || formatClientLabel(session.client),
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }

    const linkTd = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "table-actions";

    const select = document.createElement("select");
    select.className = "select table-select";
    select.dataset.sessionClientSelect = String(session.id);

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "Sem cliente";
    select.appendChild(emptyOption);

    for (const client of adminState.chargingClients) {
      const option = document.createElement("option");
      option.value = String(client.id);
      option.textContent = formatClientLabel(client);
      select.appendChild(option);
    }

    select.value = session.client_id ? String(session.client_id) : "";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-secondary btn-inline";
    button.dataset.action = "link-client";
    button.dataset.sessionId = String(session.id);
    button.textContent = "Salvar";

    wrap.appendChild(select);
    wrap.appendChild(button);
    linkTd.appendChild(wrap);
    tr.appendChild(linkTd);

    tbody.appendChild(tr);
  }
}

async function loadChargingClients() {
  const res = await fetch("/api/admin/charging-clients");
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.success || !Array.isArray(data.clients)) {
    adminState.chargingClients = [];
    renderChargingSessionsTable();
    setClientMsg(data.message || "Erro ao carregar clientes.", "error");
    return;
  }

  adminState.chargingClients = data.clients;
  renderChargingSessionsTable();
}

async function loadChargingSessions() {
  const res = await fetch("/api/admin/sessions?limit=100");
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.success || !Array.isArray(data.sessions)) {
    adminState.chargingSessions = [];
    renderChargingSessionsTable();
    setSessionsMsg(data.message || "Erro ao carregar carregamentos.", "error");
    return;
  }

  adminState.chargingSessions = data.sessions;
  renderChargingSessionsTable();
  setSessionsMsg("");
}

async function submitChargingClientForm(event) {
  event.preventDefault();

  const payload = {
    name: document.getElementById("clientName").value.trim(),
    tower: document.getElementById("clientTower").value.trim(),
    apartment: document.getElementById("clientApartment").value.trim(),
  };

  if (!payload.name) return setClientMsg("Informe o nome do cliente.", "error");

  const res = await fetch("/api/admin/charging-clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    return setClientMsg(data.message || `Falha ao cadastrar cliente (HTTP ${res.status})`, "error");
  }

  document.getElementById("chargingClientForm").reset();
  setClientMsg("Cliente cadastrado.", "ok");
  await loadChargingClients();
}

async function linkClientToSession(sessionId, clientId) {
  const res = await fetch(`/api/admin/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId || null }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.success) {
    return setSessionsMsg(data.message || `Falha ao vincular cliente (HTTP ${res.status})`, "error");
  }

  setSessionsMsg("Cliente vinculado ao carregamento.", "ok");
  await loadChargingSessions();
}

function renderActionMode() {
  const active = hasActiveSession();
  const userField = document.getElementById("startUserField");
  const addressField = document.getElementById("startAddressField");
  const runningSummary = document.getElementById("runningSummary");
  const running = getRunningForSelectedStation();

  userField.classList.toggle("hidden", active);
  addressField.classList.toggle("hidden", active);
  runningSummary.classList.toggle("hidden", !active);

  if (active && running) {
    const user = running.user;
    const who = user ? `${user.name || "-"} (${user.email || "sem-email"})` : `User ${running.user_id || "-"}`;
    document.getElementById("runningUserInline").textContent = who;
    document.getElementById("runningSessionInline").textContent = String(running.session_id || "--");
  } else {
    document.getElementById("runningUserInline").textContent = "--";
    document.getElementById("runningSessionInline").textContent = "--";
  }
}

function renderActionButton() {
  const btn = document.getElementById("adminActionBtn");
  if (!btn) return;

  if (adminState.actionBusy) {
    btn.disabled = true;
    btn.textContent = adminState.actionBusyLabel || "Processando...";
    return;
  }

  const stationId = getSelectedStationId();
  if (hasActiveSession()) {
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-secondary");
    btn.textContent = "Encerrar carregamento";
    btn.disabled = !stationId;
  } else {
    btn.classList.remove("btn-secondary");
    btn.classList.add("btn-primary");
    btn.textContent = "Iniciar carregamento";
    btn.disabled = !(stationId && getSelectedUserId() && getSelectedAddressId());
  }
}

async function refreshState() {
  if (adminState.refreshBusy) return;
  adminState.refreshBusy = true;

  try {
    const stationId = getSelectedStationId();
    if (!stationId) {
      adminState.live = null;
      document.getElementById("chargerState").textContent = "Status: selecione uma estacao";
      document.getElementById("powerKw").textContent = "--";
      document.getElementById("phasePowerKw").textContent = "--";
      document.getElementById("voltageV").textContent = "--";
      document.getElementById("currentA").textContent = "--";
      document.getElementById("phaseCount").textContent = "--";
      document.getElementById("deviceSessionEnergyLabel").textContent = "Energia da carga";
      document.getElementById("deviceSessionEnergyKwh").textContent = "--";
      document.getElementById("hasRunning").textContent = "Nao";
      document.getElementById("runUser").textContent = "--";
      document.getElementById("runStart").textContent = "--";
      document.getElementById("runElapsed").textContent = "00:00";
      document.getElementById("runKwh").textContent = "0.00";
      document.getElementById("runPrice").textContent = "--";
      document.getElementById("runId").textContent = "--";
      return;
    }

    const [liveRes] = await Promise.all([
      fetch(`/api/live?station_id=${stationId}`),
      loadCurrentSessions(),
    ]);

    const liveData = await liveRes.json().catch(() => ({}));
    if (!liveRes.ok || !liveData.success) {
      setMsg(liveData.message || "Falha ao atualizar live.", "error");
      return;
    }

    adminState.live = liveData;
    const running = getRunningForSelectedStation();

    document.getElementById("chargerState").textContent = `Status: ${liveData.stateLabel || "--"}`;
    document.getElementById("powerKw").textContent = fmt(liveData.powerKw);
    document.getElementById("phasePowerKw").textContent = fmt(liveData.phasePowerKw, 3);
    document.getElementById("voltageV").textContent = fmt(liveData.voltageV, 1);
    document.getElementById("currentA").textContent = fmt(liveData.currentA, 2);
    document.getElementById("phaseCount").textContent = String(liveData.phaseCount || "--");
    document.getElementById("deviceSessionEnergyLabel").textContent = liveData.deviceSessionEnergyLabel || "Energia da carga";
    document.getElementById("deviceSessionEnergyKwh").textContent = fmt(liveData.deviceSessionEnergyKwh);
    document.getElementById("hasRunning").textContent = running ? "Sim" : "Nao";

    if (liveData.telemetry_unavailable) {
      setMsg(
        `Telemetria Tuya indisponivel no momento. Exibindo apenas sessoes em andamento.${formatTelemetryError(liveData.telemetry_error)}`,
        "error"
      );
    }

    if (!running) {
      clearCachedRunKwh(stationId);
      document.getElementById("runUser").textContent = "--";
      document.getElementById("runStart").textContent = "--";
      document.getElementById("runElapsed").textContent = "00:00";
      document.getElementById("runKwh").textContent = "0.00";
      document.getElementById("runPrice").textContent = "--";
      document.getElementById("runId").textContent = "--";
    } else {
      const userLabel = running.user
        ? `${running.user.name || "-"} (${running.user.tower || "-"}/${running.user.apartment || "-"})`
        : `User ${running.user_id || "-"}`;

      document.getElementById("runUser").textContent = userLabel;
      document.getElementById("runStart").textContent = running.start_time || "--";
      renderRunElapsedNow();
      const incomingKwh = Number(liveData.kwhEstimated);
      const hasIncomingKwh = Number.isFinite(incomingKwh);
      const cachedKwh = getCachedRunKwh(stationId);
      const runKwh = hasIncomingKwh ? incomingKwh : (Number.isFinite(cachedKwh) ? cachedKwh : 0);
      if (hasIncomingKwh) setCachedRunKwh(stationId, incomingKwh);

      document.getElementById("runKwh").textContent = fmt(runKwh);
      document.getElementById("runPrice").textContent = typeof liveData.priceEstimated === "number"
        ? `R$ ${liveData.priceEstimated.toFixed(2)}`
        : "--";
      document.getElementById("runId").textContent = running.session_id || "--";
    }
  } catch (error) {
    setMsg("Erro ao atualizar estado: " + error.message, "error");
  } finally {
    adminState.refreshBusy = false;
    updateControlStationLabel();
    renderActionMode();
    renderActionButton();
  }
}
function setModalLoading(isLoading) {
  adminState.modalBusy = isLoading;
  const confirmBtn = document.getElementById("adminStopConfirm");
  const cancelBtn = document.getElementById("adminStopCancel");
  confirmBtn.disabled = isLoading;
  cancelBtn.disabled = isLoading;
  confirmBtn.textContent = isLoading ? "Encerrando..." : "Encerrar";
}

function closeStopModal(result) {
  if (adminState.modalBusy) return;
  const modal = document.getElementById("adminStopModal");
  modal.classList.add("hidden");
  const resolve = adminState.modalResolve;
  adminState.modalResolve = null;
  if (resolve) resolve(Boolean(result));
}

function openStopModal() {
  const modal = document.getElementById("adminStopModal");
  modal.classList.remove("hidden");
  setModalLoading(false);
  return new Promise((resolve) => { adminState.modalResolve = resolve; });
}

async function performStart() {
  const stationId = getSelectedStationId();
  const userId = getSelectedUserId();
  const addressId = getSelectedAddressId();

  if (!stationId) return setMsg("Selecione uma estacao.", "error");
  if (!userId) return setMsg("Selecione um usuario valido.", "error");
  if (!addressId) return setMsg("Selecione um endereco do usuario.", "error");

  adminState.actionBusy = true;
  adminState.actionBusyLabel = "Iniciando...";
  renderActionButton();
  setMsg("Iniciando carregamento...");

  try {
    const res = await fetch("/admin/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, address_id: addressId, station_id: stationId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg(data.message || `Falha ao iniciar (HTTP ${res.status})`, "error");
    setMsg(data.message || "Sessao iniciada.", "ok");
  } catch (error) {
    setMsg("Erro ao iniciar: " + error.message, "error");
  } finally {
    adminState.actionBusy = false;
    adminState.actionBusyLabel = "";
    await refreshState();
  }
}

async function performStop() {
  const stationId = getSelectedStationId();
  if (!stationId) return setMsg("Selecione uma estacao.", "error");

  adminState.actionBusy = true;
  adminState.actionBusyLabel = "Encerrando...";
  renderActionButton();
  setMsg("Encerrando carregamento...");
  setModalLoading(true);

  try {
    const res = await fetch("/admin/session/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ station_id: stationId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg(data.message || `Falha ao encerrar (HTTP ${res.status})`, "error");
    setMsg(data.message || "Sessao encerrada.", "ok");
  } catch (error) {
    setMsg("Erro ao encerrar: " + error.message, "error");
  } finally {
    setModalLoading(false);
    adminState.actionBusy = false;
    adminState.actionBusyLabel = "";
    await refreshState();
  }
}

async function handlePrimaryAction() {
  if (adminState.actionBusy) return;
  if (!hasActiveSession()) return performStart();
  const confirmed = await openStopModal();
  if (!confirmed) return;
  await performStop();
}

async function submitStationForm(event) {
  event.preventDefault();
  const stationId = Number(document.getElementById("stationId").value || "0");
  const payload = {
    name: document.getElementById("stationName").value.trim(),
    location_label: document.getElementById("stationLocation").value.trim(),
    tuya_device_id: document.getElementById("stationDevice").value.trim(),
    max_current_a: Number(document.getElementById("stationCurrent").value || "0"),
    is_active: document.getElementById("stationActive").checked,
  };

  if (!payload.name) return setStationMsg("Informe o nome da estacao.", "error");
  if (!payload.tuya_device_id) return setStationMsg("Informe o tuya_device_id.", "error");
  if (!Number.isInteger(payload.max_current_a) || payload.max_current_a <= 0) {
    return setStationMsg("Corrente maxima invalida.", "error");
  }

  const isEdit = Number.isInteger(stationId) && stationId > 0;
  const res = await fetch(isEdit ? `/api/admin/stations/${stationId}` : "/api/admin/stations", {
    method: isEdit ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return setStationMsg(data.message || `Falha ao salvar estacao (HTTP ${res.status})`, "error");

  setStationMsg(isEdit ? "Estacao atualizada." : "Estacao criada.", "ok");
  resetStationForm();
  await loadStationsAdmin();
  await refreshState();
}

async function toggleStationActive(station) {
  const res = await fetch(`/api/admin/stations/${station.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_active: !station.is_active }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return setStationMsg(data.message || `Falha ao alterar status (HTTP ${res.status})`, "error");
  setStationMsg("Status da estacao atualizado.", "ok");
  await loadStationsAdmin();
  await refreshState();
}

async function refreshAll() {
  await Promise.all([loadUsers(), loadStationsAdmin(), loadCurrentSessions(), loadChargingClients()]);
  await loadChargingSessions();
  await loadAddressesForUser(getSelectedUserId());
  await refreshState();
  setMsg("Dados atualizados.", "ok");
}

function startPolling() {
  if (adminState.pollTimer) clearInterval(adminState.pollTimer);
  adminState.pollTimer = setInterval(refreshState, POLL_MS);
}

function stopPolling() {
  if (!adminState.pollTimer) return;
  clearInterval(adminState.pollTimer);
  adminState.pollTimer = null;
}

function startElapsedTicker() {
  if (adminState.elapsedTimer) clearInterval(adminState.elapsedTimer);
  adminState.elapsedTimer = setInterval(renderRunElapsedNow, 1000);
}

function stopElapsedTicker() {
  if (!adminState.elapsedTimer) return;
  clearInterval(adminState.elapsedTimer);
  adminState.elapsedTimer = null;
}
async function loadSessions() {
  const res = await fetch("/sessions");
  const data = await res.json().catch(() => ({}));
  document.getElementById("out").textContent = JSON.stringify(data, null, 2);
}

async function loadTuya() {
  const stationId = getSelectedStationId();
  const suffix = stationId ? `?station_id=${stationId}` : "";
  const res = await fetch(`/tuya/status${suffix}`);
  const data = await res.json().catch(() => ({}));
  document.getElementById("out").textContent = JSON.stringify(data, null, 2);
}

function clearOutput() {
  document.getElementById("out").textContent = "(vazio)";
}

async function logout() {
  await fetch("/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
}

function setupEvents() {
  document.getElementById("adminActionBtn").addEventListener("click", handlePrimaryAction);
  document.getElementById("refreshBtn").addEventListener("click", refreshAll);
  document.getElementById("sessionsRefreshBtn").addEventListener("click", loadChargingSessions);
  document.getElementById("chargingClientForm").addEventListener("submit", submitChargingClientForm);

  document.getElementById("controlStationSelect").addEventListener("change", (event) => {
    const id = Number(event.target.value);
    if (Number.isInteger(id) && id > 0) localStorage.setItem(STATION_STORAGE_KEY, String(id));
    refreshState();
  });

  document.getElementById("userSelect").addEventListener("change", async () => {
    await loadAddressesForUser(getSelectedUserId());
    renderActionButton();
  });

  document.getElementById("userAddressSelect").addEventListener("change", renderActionButton);

  document.getElementById("stationForm").addEventListener("submit", submitStationForm);
  document.getElementById("stationResetBtn").addEventListener("click", () => {
    resetStationForm();
    setStationMsg("", "");
  });

  document.getElementById("stationsTableBody").addEventListener("click", async (event) => {
    const action = event.target?.dataset?.action;
    const id = Number(event.target?.dataset?.id || "0");
    if (!action || !Number.isInteger(id) || id <= 0) return;

    const station = adminState.stations.find((item) => item.id === id);
    if (!station) return;

    if (action === "edit") {
      fillStationForm(station);
      setStationMsg(`Editando estacao #${station.id}`, "");
      return;
    }

    if (action === "toggle") await toggleStationActive(station);
  });

  document.getElementById("chargingSessionsTableBody").addEventListener("click", async (event) => {
    const action = event.target?.dataset?.action;
    const sessionId = Number(event.target?.dataset?.sessionId || "0");
    if (action !== "link-client" || !Number.isInteger(sessionId) || sessionId <= 0) return;

    const select = document.querySelector(`[data-session-client-select="${sessionId}"]`);
    const clientId = select?.value ? Number(select.value) : null;
    if (clientId != null && (!Number.isInteger(clientId) || clientId <= 0)) {
      return setSessionsMsg("Cliente invalido.", "error");
    }

    await linkClientToSession(sessionId, clientId);
  });

  document.getElementById("adminStopCancel").addEventListener("click", () => closeStopModal(false));
  document.getElementById("adminStopConfirm").addEventListener("click", () => closeStopModal(true));
  document.querySelector("#adminStopModal .modal-backdrop").addEventListener("click", () => closeStopModal(false));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const modal = document.getElementById("adminStopModal");
      if (!modal.classList.contains("hidden")) closeStopModal(false);
    }
  });

  window.addEventListener("beforeunload", () => {
    stopPolling();
    stopElapsedTicker();
  });
}

(async () => {
  const ok = await requireAdmin();
  if (!ok) return;
  setupEvents();
  await refreshAll();
  startPolling();
  startElapsedTicker();
})();
