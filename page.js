/**
 * The phone page itself — split out of server.js in I4b so the UI can be served, escaped
 * and tested without booting the HTTP layer.
 *
 * I4b (3 of 5): pending approvals render as cards with real Approve / Reject buttons that
 * call `POST /approve`. The page loads the queue on open, so an approval created before a
 * reload is still actionable.
 *
 * I4b (5 of 5): a stale origin (Wi-Fi or tailnet IP changed) used to surface as
 * "Request failed: Load failed". The page now pings /healthz on load, shows a banner when it
 * cannot reach the agent, and every failure message names the current tailnet address to use
 * instead. The address is configurable (TAILNET_URL) — nothing is hard-coded at runtime.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** JSON that is safe to inline inside a `<script>` element. */
function jsString(value) {
  return JSON.stringify(String(value ?? '')).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

// Set TAILNET_URL (or pass the install script one) to the phone-reachable address.
// Empty by default: a clone has no tailnet, and the stale-origin banner drops the hint.
export const DEFAULT_TAILNET_URL = '';

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#12100e;color:#e8e4df;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  padding:16px 16px calc(16px + env(safe-area-inset-bottom));max-width:720px;margin:0 auto}
h1{font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:#a09890;font-weight:600;margin:4px 0 14px}
textarea{width:100%;min-height:96px;background:#1c1917;color:#e8e4df;border:1px solid #2e2a27;border-radius:10px;
  padding:12px;font:inherit;resize:vertical}
button{width:100%;margin-top:10px;padding:14px;border:0;border-radius:10px;background:#c9a961;color:#12100e;
  font:inherit;font-weight:700;letter-spacing:.02em}
button:disabled{opacity:.5}
.card{margin-top:14px;background:#1c1917;border:1px solid #2e2a27;border-radius:10px;padding:12px;white-space:pre-wrap}
.card.approval{border-color:#c9a961;white-space:normal}
.card.approval.done{border-color:#3f6b4a}
.card.summary{border-color:#3a4c63}
.approval-title{font-weight:700;font-size:14px;letter-spacing:.02em}
.row{display:flex;gap:8px}
.row button{flex:1;width:auto;margin-top:10px;padding:12px}
.row button.secondary{background:#2e2a27;color:#e8e4df;border:1px solid #4a433d}
.meta{color:#a09890;font-size:12.5px;margin-top:6px;letter-spacing:.02em}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.field{display:flex;justify-content:space-between;gap:10px;margin-top:6px;font-size:13.5px}
.field .k{color:#a09890}
.field .v{text-align:right;word-break:break-word}
.err{border-color:#b5564a}
.banner{margin-top:10px;background:#2a1714;border:1px solid #b5564a;border-radius:10px;padding:12px;color:#e8b4ad;
  font-size:14px;white-space:normal}
.header{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.header a{color:#a09890;font-size:13px;text-decoration:none;border:1px solid #2e2a27;border-radius:6px;padding:4px 9px}
`;

const SCRIPT = (token, tailnet, name) => `
const TOKEN = ${jsString(token)};
const TAILNET = ${jsString(tailnet)};
const OUT = document.getElementById('out');
const APPROVALS = document.getElementById('approvals');
const BANNER = document.getElementById('banner');
const PAGE_TITLE = ${jsString(name)};
const SEEN = new Set();

function card(text, meta, isErr, parent){
  const d = document.createElement('div');
  d.className = 'card' + (isErr ? ' err' : '');
  d.textContent = text;
  if (meta){ const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; d.appendChild(m); }
  (parent || OUT).prepend(d);
  return d;
}

function showBanner(text){
  BANNER.hidden = false;
  BANNER.textContent = text;
}

function staleOriginMessage(){
  const base = 'Cannot reach Shotty at ' + location.origin + '. That address is probably stale — the '
    + 'Wi-Fi or tailnet address changed since this page was added to the Home Screen.';
  if (!TAILNET) return base + ' Reload from the address the server printed, then Add to Home Screen again.';
  return base + ' Use the tailnet address instead: ' + TAILNET + '/ — then Add to Home Screen again.';
}

function approvalCard(a){
  if (!a || !a.id || SEEN.has(a.id)) return;
  SEEN.add(a.id);
  const box = document.createElement('div');
  box.className = 'card approval';
  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = 'Approval needed · ' + (a.title || a.tool || 'decision');
  box.appendChild(title);

  if (Array.isArray(a.fields) && a.fields.length) {
    a.fields.forEach(function(f){
      const line = document.createElement('div');
      line.className = 'field';
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = f.label;
      const val = document.createElement('span');
      val.className = 'v';
      val.textContent = f.value;
      line.appendChild(key);
      line.appendChild(val);
      box.appendChild(line);
    });
  } else {
    const payload = document.createElement('div');
    payload.className = 'meta mono';
    payload.textContent = JSON.stringify(a.payload || {});
    box.appendChild(payload);
  }

  const actions = (Array.isArray(a.actions) && a.actions.length)
    ? a.actions
    : [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }];
  const row = document.createElement('div');
  row.className = 'row';
  const buttons = [];
  actions.forEach(function(action){
    const b = document.createElement('button');
    b.textContent = action.label || action.id;
    if (action.id !== 'approve') b.className = 'secondary';
    b.addEventListener('click', function(){ decide(action.id); });
    row.appendChild(b);
    buttons.push(b);
  });
  box.appendChild(row);
  const status = document.createElement('div');
  status.className = 'meta';
  box.appendChild(status);
  APPROVALS.prepend(box);

  function decide(decision){
    buttons.forEach(function(b){ b.disabled = true; });
    status.textContent = 'sending…';
    fetch('/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
      body: JSON.stringify({ id: a.id, decision: decision })
    }).then(function(r){
      return r.json().then(function(d){ return { http: r.status, data: d }; });
    }).then(function(res){
      const d = res.data || {};
      if (d.status === 'executed'){ status.textContent = 'Approved — executed exactly once.'; box.className = 'card approval done'; }
      else if (d.status === 'decided'){
        const chosen = actions.filter(function(action){ return action.id === d.decision; })[0];
        status.textContent = (chosen ? chosen.label : d.decision) + ' — recorded and sent to the workflow.';
        box.className = 'card approval done';
      }
      else if (d.status === 'rejected'){ status.textContent = 'Rejected — nothing was executed.'; box.className = 'card approval done'; }
      else if (d.status === 'duplicate'){ status.textContent = 'Already decided — nothing ran again.'; box.className = 'card approval done'; }
      else { status.textContent = 'Could not decide: ' + (d.error || ('HTTP ' + res.http)); }
    }).catch(function(){
      status.textContent = staleOriginMessage();
    });
  }

}

function updateTitle(count){
  document.title = count > 0 ? '(' + count + ') ' + PAGE_TITLE : PAGE_TITLE;
}

function loadApprovals(){
  fetch('/approvals', { headers: { 'x-bridge-token': TOKEN } })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d || !Array.isArray(d.pending)) return;
      d.pending.forEach(approvalCard);
      updateTitle(d.pending.length);
    })
    .catch(function(){ /* the health check owns the banner */ });
}

function loadSummary(){
  fetch('/summary', { headers: { 'x-bridge-token': TOKEN } })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d || !d.latest || !d.latest.text) return;
      const box = card(d.latest.text, 'end-of-day summary · ' + (d.latest.date || ''), false);
      box.className = 'card summary';
    })
    .catch(function(){});
}

function health(){
  fetch('/healthz', { headers: { 'x-bridge-token': TOKEN } })
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(d){ if (d && d.ok) BANNER.hidden = true; })
    .catch(function(){ showBanner(staleOriginMessage()); });
}

async function send(){
  const box = document.getElementById('t');
  const go = document.getElementById('go');
  const text = box.value.trim();
  if (!text) return;
  go.disabled = true;
  const pending = card('working…', null, false);
  try {
    const r = await fetch('/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
      body: JSON.stringify({ text: text })
    });
    const data = await r.json();
    pending.remove();
    card(data.reply || '(no reply)', (data.status || '') + ' · ' + (data.duration_ms || 0) + ' ms', !data.ok);
    if (data.approval) approvalCard(data.approval);
    if (data.ok) box.value = '';
  } catch (e) {
    pending.remove();
    card(staleOriginMessage(), 'Request failed: ' + (e && e.message ? e.message : String(e)), true);
  } finally {
    go.disabled = false;
  }
}

document.getElementById('go').addEventListener('click', send);
document.getElementById('t').addEventListener('keydown', function(e){
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
});
health();
loadApprovals();
loadSummary();
// Poll so a decision raised by any workflow (invoice, research, reconciliation) reaches the
// phone without a reload. SEEN keeps the cards from duplicating.
if (typeof setInterval === 'function') setInterval(loadApprovals, 10000);
`;

export function renderPage({ token, name = 'Agent', model = 'qwen2.5:7b', notes = 0, tailnet = DEFAULT_TAILNET_URL } = {}) {
  if (typeof token !== 'string' || !token) throw new Error('renderPage requires a token');
  const safeName = escapeHtml(name);
  const safeModel = escapeHtml(model);
  const notesLine = notes
    ? `${Number(notes)} notes indexed · answers cite them`
    : 'grounding off · bare model';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#12100e">
<title>${safeName}</title>
<style>${STYLE}</style></head>
<body>
<div class="header">
  <h1 style="margin-bottom:14px">${safeName} · ${safeModel}</h1>
  <a href="/help?t=${encodeURIComponent(token)}">help</a>
</div>
<div class="meta" id="notes">${notesLine}</div>
<div class="banner" id="banner" hidden></div>
<textarea id="t" placeholder="Ask it something…" autocapitalize="sentences"></textarea>
<button id="go">Send</button>
<div id="approvals"></div>
<div id="out"></div>
<script>${SCRIPT(token, tailnet, name)}</script>
</body></html>`;
}

const LOGIN_STYLE = `
:root{color-scheme:dark}
body{margin:0;background:#12100e;color:#e8e4df;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  padding:48px 20px;max-width:520px;margin:0 auto}
h1{font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:#a09890;font-weight:600;margin:0 0 18px}
p{color:#a09890;font-size:14px;margin:0 0 18px}
input{width:100%;background:#1c1917;color:#e8e4df;border:1px solid #2e2a27;border-radius:10px;
  padding:14px;font:16px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
button{width:100%;margin-top:12px;padding:14px;border:0;border-radius:10px;background:#c9a961;color:#12100e;
  font:inherit;font-weight:700}
.err{color:#b5564a;margin-top:12px;font-size:14px;min-height:20px}
`;

const LOGIN_SCRIPT = `
document.getElementById('go').onclick = function(){
  const v = document.getElementById('t').value.trim();
  if (!v) { document.getElementById('e').textContent = 'The token is empty.'; return; }
  location.replace('/?t=' + encodeURIComponent(v));
};
document.getElementById('t').addEventListener('keydown', function(e){
  if (e.key === 'Enter') document.getElementById('go').click();
});
`;

export function renderLogin() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#12100e">
<title>agent · unlock</title>
<style>${LOGIN_STYLE}</style></head>
<body>
<h1>local agent</h1>
<p>Paste the token printed in the terminal where the server is running.</p>
<input id="t" placeholder="token" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus>
<button id="go">Unlock</button>
<div class="err" id="e"></div>
<script>${LOGIN_SCRIPT}</script>
</body></html>`;
}
