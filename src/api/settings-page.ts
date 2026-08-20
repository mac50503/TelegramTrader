export const SETTINGS_PAGE_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TelegramTrader — Configuración</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  .field { margin: 0.6rem 0; display: flex; flex-direction: column; gap: 0.2rem; }
  .field label { font-size: 0.85rem; font-weight: 600; }
  .field .hint { font-size: 0.75rem; color: #666; }
  .field input[type=text], .field input[type=password], .field input[type=number], .field select {
    padding: 0.4rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem;
  }
  .checkbox-row { display: flex; align-items: center; gap: 0.5rem; flex-direction: row; }
  .chat-list { display: flex; flex-direction: column; gap: 0.3rem; max-height: 220px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; padding: 0.5rem; }
  .chat-list label { font-weight: normal; font-size: 0.85rem; display: flex; gap: 0.5rem; align-items: center; }
  button { padding: 0.5rem 1rem; border-radius: 4px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 0.9rem; }
  button.secondary { background: #fff; color: #1a1a1a; }
  #login, #app { display: none; }
  #status { margin-top: 1rem; padding: 0.6rem; border-radius: 4px; font-size: 0.85rem; display: none; }
  #status.ok { background: #e6f4ea; color: #1e7a34; display: block; }
  #status.err { background: #fce8e6; color: #a50e0e; display: block; }
  .reveal { font-size: 0.75rem; cursor: pointer; text-decoration: underline; background: none; border: none; color: #444; padding: 0; width: fit-content; }
  .actions { margin-top: 1.5rem; display: flex; gap: 0.6rem; }
</style>
</head>
<body>
<h1>TelegramTrader — Configuración</h1>
<p>Esta página lee y escribe directamente el archivo <code>.env</code> del servidor. Al guardar, el servidor se reinicia solo si lo estás corriendo con <code>npm run dev</code>.</p>

<div id="login">
  <div class="field">
    <label for="apiKey">API Key</label>
    <input type="password" id="apiKey" placeholder="La misma que usa el EA (X-API-Key)">
  </div>
  <button id="loginBtn">Entrar</button>
</div>

<div id="app">
  <form id="settingsForm"></form>
  <div class="actions">
    <button id="saveBtn" type="button">Guardar cambios</button>
    <button id="logoutBtn" type="button" class="secondary">Cambiar API key</button>
  </div>
</div>

<div id="status"></div>

<script>
const SECTIONS = [
  { title: "Aplicación", fields: [
    { key: "NODE_ENV", type: "select", options: ["development", "test", "production"] },
    { key: "LOG_LEVEL", type: "select", options: ["fatal", "error", "warn", "info", "debug", "trace", "silent"] }
  ]},
  { title: "Telegram", fields: [
    { key: "TELEGRAM_ENABLED", type: "bool" },
    { key: "TELEGRAM_API_ID", type: "text", hint: "De https://my.telegram.org/apps" },
    { key: "TELEGRAM_API_HASH", type: "secret" },
    { key: "TELEGRAM_SESSION_PATH", type: "text" },
    { key: "TELEGRAM_ALLOWED_CHATS", type: "chats" }
  ]},
  { title: "Agente de IA", fields: [
    { key: "AI_AGENT_ENABLED", type: "bool" },
    { key: "AI_AGENT_COMMAND", type: "text", hint: "Vacío = auto-detectar entre AI_PROVIDERS" },
    { key: "AI_PREFILTER_ENABLED", type: "bool", hint: "Filtro determinístico antes de llamar al CLI" },
    { key: "AI_PROVIDERS", type: "text", hint: "Orden de prioridad, separado por comas" },
    { key: "AI_MIN_CONFIDENCE", type: "number", step: "0.01" },
    { key: "AI_AGENT_TIMEOUT_MS", type: "number" },
    { key: "AI_CLAUDE_MODEL", type: "text" },
    { key: "AI_CODEX_MODEL", type: "text" },
    { key: "AI_CODEX_SANDBOX", type: "select", options: ["read-only", "workspace-write", "danger-full-access"] },
    { key: "AI_KIRO_MODEL", type: "text" },
    { key: "AI_KIRO_TIMEOUT_MS", type: "number" },
    { key: "AI_KIRO_TRUST_ALL_TOOLS", type: "bool", hint: "Riesgo: le da acceso total a kiro-cli. Déjalo apagado salvo que sepas lo que haces." }
  ]},
  { title: "Riesgo", fields: [
    { key: "DEFAULT_FIXED_LOT", type: "number", step: "0.01" },
    { key: "DEFAULT_RISK_PERCENT", type: "number", step: "0.1" },
    { key: "MAX_LOT", type: "number", step: "0.01" },
    { key: "MAX_RISK_PERCENT", type: "number", step: "0.1" },
    { key: "MAX_DAILY_TRADES", type: "number" },
    { key: "MAX_DAILY_LOSS", type: "number" },
    { key: "MAX_SIMULTANEOUS_TRADES", type: "number" },
    { key: "SIGNAL_TTL_SECONDS", type: "number" },
    { key: "DUPLICATE_WINDOW_SECONDS", type: "number" }
  ]},
  { title: "API REST", fields: [
    { key: "API_HOST", type: "text" },
    { key: "API_PORT", type: "number" },
    { key: "API_KEY", type: "secret" },
    { key: "API_RATE_LIMIT_MAX", type: "number" },
    { key: "API_RATE_LIMIT_WINDOW_MS", type: "number" }
  ]},
  { title: "Trading", fields: [
    { key: "TRADING_MODE", type: "select", options: ["SIMULATION", "LIVE"], hint: "LIVE requiere también LIVE_TRADING_CONFIRM" },
    { key: "LIVE_TRADING_CONFIRM", type: "text", hint: "Debe ser exactamente I_UNDERSTAND_LIVE_TRADING para activar LIVE" },
    { key: "MT5_ALLOWED_ACCOUNT_IDS", type: "text" },
    { key: "MT5_CONTEXT_MAX_AGE_SECONDS", type: "number" }
  ]}
];

let apiKey = sessionStorage.getItem("tt-api-key") || "";
let initialValues = {};
let selectedChats = new Set();

function api(path, options = {}) {
  return fetch(path, { ...options, headers: { ...(options.headers || {}), "X-API-Key": apiKey } });
}

function showStatus(message, ok) {
  const el = document.getElementById("status");
  el.textContent = message;
  el.className = ok ? "ok" : "err";
}

function fieldHtml(field, value) {
  const id = "f_" + field.key;
  if (field.type === "bool") {
    const checked = value === "true" ? "checked" : "";
    return \`<div class="field"><div class="checkbox-row"><input type="checkbox" id="\${id}" \${checked}><label for="\${id}">\${field.key}</label></div>\${field.hint ? \`<span class="hint">\${field.hint}</span>\` : ""}</div>\`;
  }
  if (field.type === "select") {
    const opts = field.options.map((o) => \`<option value="\${o}" \${o === value ? "selected" : ""}>\${o}</option>\`).join("");
    return \`<div class="field"><label for="\${id}">\${field.key}</label><select id="\${id}">\${opts}</select>\${field.hint ? \`<span class="hint">\${field.hint}</span>\` : ""}</div>\`;
  }
  if (field.type === "secret") {
    return \`<div class="field"><label for="\${id}">\${field.key}</label><input type="password" id="\${id}" value="\${value ?? ""}"><button type="button" class="reveal" onclick="const i=document.getElementById('\${id}'); i.type = i.type==='password'?'text':'password';">mostrar/ocultar</button></div>\`;
  }
  if (field.type === "chats") {
    return \`<div class="field"><label>\${field.key}</label><div class="hint">Chats/canales permitidos. Requiere Telegram conectado para ver la lista.</div><div class="chat-list" id="\${id}">Cargando...</div>
      <div class="checkbox-row"><input type="text" id="\${id}_manual" placeholder="Agregar chatId manualmente"><button type="button" class="secondary" onclick="addManualChat('\${field.key}')">Agregar</button></div></div>\`;
  }
  const numAttrs = field.type === "number" ? \` type="number" step="\${field.step || "1"}"\` : ' type="text"';
  return \`<div class="field"><label for="\${id}">\${field.key}</label><input\${numAttrs} id="\${id}" value="\${value ?? ""}">\${field.hint ? \`<span class="hint">\${field.hint}</span>\` : ""}</div>\`;
}

function addManualChat(key) {
  const input = document.getElementById("f_" + key + "_manual");
  const id = input.value.trim();
  if (!id) return;
  selectedChats.add(id);
  input.value = "";
  renderChatList(key);
}

function renderChatList(key, chats) {
  const container = document.getElementById("f_" + key);
  if (chats) container.dataset.loaded = JSON.stringify(chats);
  const loaded = chats || JSON.parse(container.dataset.loaded || "[]");
  const known = new Set(loaded.map((c) => c.chatId));
  const extra = [...selectedChats].filter((id) => !known.has(id));
  const rows = loaded.map((c) => \`<label><input type="checkbox" data-chat-id="\${c.chatId}" onchange="toggleChat('\${key}','\${c.chatId}',this.checked)" \${selectedChats.has(c.chatId) ? "checked" : ""}> \${c.name} (\${c.chatId})</label>\`);
  const extraRows = extra.map((id) => \`<label><input type="checkbox" data-chat-id="\${id}" checked onchange="toggleChat('\${key}','\${id}',this.checked)"> \${id} (agregado a mano)</label>\`);
  container.innerHTML = rows.concat(extraRows).join("") || "<span class='hint'>Sin chats disponibles. Activa Telegram y reinicia.</span>";
}

function toggleChat(key, chatId, checked) {
  if (checked) selectedChats.add(chatId); else selectedChats.delete(chatId);
  renderChatList(key);
}

async function loadSettings() {
  const res = await api("/api/settings");
  if (!res.ok) { showStatus("API key inválida o error del servidor.", false); return false; }
  initialValues = await res.json();
  const form = document.getElementById("settingsForm");
  form.innerHTML = SECTIONS.map((section) => \`<h2>\${section.title}</h2>\` + section.fields.map((f) => fieldHtml(f, initialValues[f.key])).join("")).join("");
  selectedChats = new Set((initialValues.TELEGRAM_ALLOWED_CHATS || "").split(",").map((s) => s.trim()).filter(Boolean));

  const chatsRes = await api("/api/settings/telegram-chats");
  const chatsData = chatsRes.ok ? await chatsRes.json() : { connected: false, chats: [] };
  renderChatList("TELEGRAM_ALLOWED_CHATS", chatsData.chats || []);
  return true;
}

function collectChanges() {
  const changes = {};
  for (const section of SECTIONS) {
    for (const field of section.fields) {
      if (field.type === "chats") {
        const value = [...selectedChats].join(",");
        if (value !== (initialValues[field.key] || "")) changes[field.key] = value;
        continue;
      }
      const el = document.getElementById("f_" + field.key);
      const value = field.type === "bool" ? String(el.checked) : el.value;
      if (value !== (initialValues[field.key] ?? (field.type === "bool" ? "false" : ""))) changes[field.key] = value;
    }
  }
  return changes;
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) return;
  const ok = await loadSettings();
  if (ok) {
    sessionStorage.setItem("tt-api-key", apiKey);
    document.getElementById("login").style.display = "none";
    document.getElementById("app").style.display = "block";
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  sessionStorage.removeItem("tt-api-key");
  apiKey = "";
  document.getElementById("app").style.display = "none";
  document.getElementById("login").style.display = "block";
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const changes = collectChanges();
  if (Object.keys(changes).length === 0) { showStatus("No hay cambios que guardar.", true); return; }
  const res = await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    showStatus("Guardado. Si el servidor corre con npm run dev, se va a reiniciar solo en unos segundos.", true);
    initialValues = { ...initialValues, ...changes };
  } else {
    showStatus("Error al guardar: " + (body.error?.message || res.status), false);
  }
});

(async () => {
  if (apiKey) {
    const ok = await loadSettings();
    if (ok) { document.getElementById("app").style.display = "block"; return; }
  }
  document.getElementById("login").style.display = "block";
})();
</script>
</body>
</html>`;
