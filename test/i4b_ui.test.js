/**
 * I4b — the phone page: /healthz, /summary, and the approval buttons.
 *
 * The last tests execute the page's REAL inline script inside node:vm against a tiny DOM
 * stub. That is deliberate: a page that contains the word "Approve" is not the same thing as
 * a button that calls POST /approve, and the stale-origin bug was a JavaScript failure mode.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import vm from 'node:vm';

import { createApp } from '../server.js';
import { DEFAULT_TAILNET_URL } from '../page.js';

const TOKEN = 'test-token-1234';

async function boot(t, options = {}) {
  const app = createApp({ handler: async ({ text }) => `echo: ${text}`, token: TOKEN, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => app.close());
  return { base: `http://127.0.0.1:${app.address().port}`, app };
}

const get = (base, path, token = TOKEN) => fetch(base + path, { headers: { 'x-bridge-token': token } });

// ---------------------------------------------------------------- endpoints

test('/healthz reports name, model, notes count and uptime', async (t) => {
  let now = 1_700_000_000_000;
  const { base } = await boot(t, { name: 'Shotty', model: 'qwen2.5:7b', notes: 39, clock: () => now });
  now += 5_000;

  const res = await get(base, '/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, 'Shotty');
  assert.equal(body.model, 'qwen2.5:7b');
  assert.equal(body.notes, 39);
  assert.equal(body.uptime_s, 5);
  assert.match(body.started_at, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal((await fetch(base + '/healthz')).status, 401, '/healthz is behind the token too');
});

test('/summary serves the latest end-of-day summary, or null before the first one', async (t) => {
  const none = await boot(t);
  assert.equal((await (await get(none.base, '/summary')).json()).latest, null);

  const provider = async () => ({ date: '2026-10-20', text: 'Shotty — end of day 2026-10-20\nTasks today: 0' });
  const withSummary = await boot(t, { summaryProvider: provider });
  const body = await (await get(withSummary.base, '/summary')).json();
  assert.equal(body.ok, true);
  assert.equal(body.latest.date, '2026-10-20');
  assert.match(body.latest.text, /end of day/);
});

test('the page markup carries the approval buttons, the health probe and the tailnet fallback', async (t) => {
  const { base } = await boot(t, { name: 'Shotty', model: 'qwen2.5:7b', notes: 39 });
  const res = await fetch(base + '/?t=' + TOKEN);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /Shotty · qwen2\.5:7b/);
  assert.match(html, /39 notes indexed/);
  assert.match(html, /id="approvals"/);
  assert.match(html, /id="banner"/);
  assert.match(html, /'Approve'/, 'an Approve button is wired');
  assert.match(html, /'Reject'/, 'a Reject button is wired');
  assert.match(html, /'\/approvals'/, 'the page loads the pending queue on open');
  assert.match(html, /'\/approve'/, 'the buttons call the decision endpoint');
  assert.match(html, /'\/healthz'/, 'the page probes reachability');
  assert.match(html, /probably stale/, 'the failure message explains the stale origin');
  assert.match(html, new RegExp(DEFAULT_TAILNET_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'it names the tailnet address');

  const custom = await boot(t, { tailnetUrl: 'http://100.64.0.1:9999' });
  assert.match(await (await fetch(custom.base + '/?t=' + TOKEN)).text(), /100\.64\.0\.1:9999/);
});

// ---------------------------------------------------------------- page script in a VM

class El {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.className = '';
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.handlers = {};
    this.style = {};
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  prepend(child) {
    child.parent = this;
    this.children.unshift(child);
    return child;
  }

  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  addEventListener(type, fn) {
    (this.handlers[type] ??= []).push(fn);
  }

  click() {
    for (const fn of this.handlers.click ?? []) fn({});
  }

  set onclick(fn) {
    this.addEventListener('click', fn);
  }
}

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.children) findAll(child, predicate, out);
  return out;
}

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({
      path,
      headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : null,
    });
    const route = routes[path];
    if (!route) throw new TypeError('Load failed'); // the browser's stale-origin failure
    // Hand the route the same shape the server sees: a parsed JSON body.
    const parsed = { ...options, body: options.body ? JSON.parse(options.body) : null };
    const value = typeof route === 'function' ? await route(parsed, calls) : route;
    if (value instanceof Error) throw value;
    return { ok: true, status: 200, json: async () => value };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function runPage(html, routes, origin = 'http://127.0.0.1:8787') {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const map = {};
  for (const id of ['t', 'go', 'out', 'approvals', 'banner', 'notes']) map[id] = new El();
  const sandbox = {
    document: {
      title: '',
      getElementById: (id) => map[id] ?? null,
      createElement: (tag) => new El(tag),
    },
    fetch: fakeFetch(routes),
    location: { origin },
    setInterval: (fn) => { sandbox.poll = fn; return 0; },
  };
  vm.runInNewContext(script, sandbox);
  return {
    map,
    fetch: sandbox.fetch,
    sandbox,
    flush: () => new Promise((r) => setTimeout(r, 25)),
  };
}

const pageHtml = async (base) => (await fetch(base + '/?t=' + TOKEN)).text();

test('a pending approval renders Approve/Reject buttons; Approve calls /approve and reports executed once', async (t) => {
  const { base } = await boot(t);
  const html = await pageHtml(base);
  const routes = {
    '/healthz': { ok: true },
    '/summary': { latest: null },
    '/approvals': {
      ok: true,
      pending: [{ id: 'abc123', tool: 'append_row', payload: { row: { client: 'vm', amount: 7 } } }],
    },
    '/approve': (options) => ({ ok: true, status: options.body?.decision === 'approve' ? 'executed' : 'rejected' }),
  };
  const page = runPage(html, routes);
  await page.flush();

  assert.equal(page.map.approvals.children.length, 1, 'the pending approval became a card');
  const buttons = findAll(page.map.approvals, (n) => n.tagName === 'button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Approve', 'Reject']);

  buttons[0].click();
  await page.flush();

  const call = page.fetch.calls.find((c) => c.path === '/approve');
  assert.ok(call, 'the button called POST /approve');
  assert.deepEqual(call.body, { id: 'abc123', decision: 'approve' });
  assert.equal(call.headers['x-bridge-token'], TOKEN);
  assert.match(page.map.approvals.textContent, /Approved — executed exactly once/);
});

test('the Reject button records a rejection and does not claim execution', async (t) => {
  const { base } = await boot(t);
  const page = runPage(await pageHtml(base), {
    '/healthz': { ok: true },
    '/summary': { latest: null },
    '/approvals': { ok: true, pending: [{ id: 'def456', tool: 'append_row', payload: { row: { n: 1 } } }] },
    '/approve': (options) => ({ ok: true, status: options.body?.decision === 'reject' ? 'rejected' : 'executed' }),
  });
  await page.flush();

  const buttons = findAll(page.map.approvals, (n) => n.tagName === 'button');
  buttons[1].click();
  await page.flush();

  const call = page.fetch.calls.find((c) => c.path === '/approve');
  assert.deepEqual(call.body, { id: 'def456', decision: 'reject' });
  assert.match(page.map.approvals.textContent, /Rejected — nothing was executed/);
});

test('a stale origin shows a banner naming the tailnet address instead of a bare failure', async (t) => {
  const tailnet = 'http://100.64.0.1:8787';
  const { base } = await boot(t, { tailnetUrl: tailnet });
  const page = runPage(await pageHtml(base), {
    '/healthz': () => { throw new TypeError('Load failed'); },
    '/summary': { latest: null },
    '/approvals': { ok: true, pending: [] },
  });
  await page.flush();

  assert.equal(page.map.banner.hidden, false, 'the banner is shown');
  assert.match(page.map.banner.textContent, /Cannot reach Shotty at http:\/\/127\.0\.0\.1:8787/);
  assert.match(page.map.banner.textContent, /use the tailnet address/i);
  assert.ok(page.map.banner.textContent.includes(tailnet), 'the banner names the configured address');
});

test('a task that cannot reach the server explains the stale origin, including "Load failed"', async (t) => {
  const { base } = await boot(t);
  const page = runPage(await pageHtml(base), {
    '/healthz': { ok: true },
    '/summary': { latest: null },
    '/approvals': { ok: true, pending: [] },
    '/task': () => { throw new TypeError('Load failed'); },
  });
  await page.flush();

  page.map.t.value = 'write a row';
  page.map.go.click();
  await page.flush();

  const text = page.map.out.textContent;
  assert.match(text, /Probably stale|probably stale/);
  assert.match(text, /Request failed: Load failed/, 'the original browser error is still shown for diagnosis');
  assert.match(text, new RegExp(DEFAULT_TAILNET_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(page.map.go.disabled, false, 'the send button is usable again');
});

test('a pending write returned by /task renders its approval card immediately', async (t) => {
  const { base } = await boot(t);
  const page = runPage(await pageHtml(base), {
    '/healthz': { ok: true },
    '/summary': { latest: null },
    '/approvals': { ok: true, pending: [] },
    '/task': {
      ok: true,
      status: 'pending_approval',
      reply: 'I need your approval to run append_row.',
      duration_ms: 12,
      approval: { id: 'live789', tool: 'append_row', payload: { row: { client: 'live' } } },
    },
  });
  await page.flush();

  page.map.t.value = 'append a row';
  page.map.go.click();
  await page.flush();

  const buttons = findAll(page.map.approvals, (n) => n.tagName === 'button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Approve', 'Reject']);
  assert.match(page.map.approvals.textContent, /append_row/);
});

test('a decision-only approval renders its fields and custom actions; Replace is recorded', async (t) => {
  const { base } = await boot(t);
  const page = runPage(await pageHtml(base), {
    '/healthz': { ok: true },
    '/summary': { latest: null },
    '/approvals': {
      ok: true,
      pending: [{
        id: 'row-12', tool: null, execute: false, title: 'Row 12 — missing source',
        actions: [{ id: 'approve', label: 'Approve' }, { id: 'replace', label: 'Replace' }, { id: 'drop', label: 'Drop' }],
        fields: [{ label: 'Row', value: '12' }, { label: 'Defect', value: 'missing source URL' }],
        payload: { row_id: 12 },
      }],
    },
    '/approve': (options) => ({ ok: true, status: 'decided', decision: options.body?.decision, execute: false }),
  });
  await page.flush();

  const text = page.map.approvals.textContent;
  assert.match(text, /Row 12 — missing source/);
  assert.match(text, /missing source URL/);
  const buttons = findAll(page.map.approvals, (n) => n.tagName === 'button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Approve', 'Replace', 'Drop']);

  buttons[1].click();
  await page.flush();
  const call = page.fetch.calls.find((c) => c.path === '/approve');
  assert.deepEqual(call.body, { id: 'row-12', decision: 'replace' });
  assert.match(page.map.approvals.textContent, /Replace — recorded and sent to the workflow/);
});

test('the pending count is shown in the title and the queue is polled', async (t) => {
  const { base } = await boot(t);
  let pending = [
    { id: 'p1', tool: 'append_row', payload: {} },
    { id: 'p2', tool: 'file_invoice', payload: {} },
  ];
  const page = runPage(await pageHtml(base), {
    '/healthz': { ok: true },
    '/summary': { latest: null },
    '/approvals': () => ({ ok: true, pending }),
    '/approve': { ok: true, status: 'executed' },
  });
  await page.flush();
  assert.equal(page.sandbox.document.title, '(2) Agent');

  pending = [];
  assert.equal(typeof page.sandbox.poll, 'function', 'the page registered a poll');
  page.sandbox.poll();
  await page.flush();
  assert.equal(page.sandbox.document.title, 'Agent');
  assert.equal(page.map.approvals.children.length, 2, 'SEEN prevents duplicate cards on poll');
});

test('the latest end-of-day summary renders on the page when one exists', async (t) => {
  const { base } = await boot(t);
  const page = runPage(await pageHtml(base), {
    '/healthz': { ok: true },
    '/approvals': { ok: true, pending: [] },
    '/summary': { latest: { date: '2026-10-20', text: 'Shotty — end of day 2026-10-20\nTasks today: 3' } },
  });
  await page.flush();
  assert.match(page.map.out.textContent, /end of day 2026-10-20/);
});
