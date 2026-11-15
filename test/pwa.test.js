/**
 * PWA adapter tests — hermetic. A fake handler, a real HTTP server on port 0, no model call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../server.js';

const TOKEN = 'test-token-1234';

async function boot(t, { handler = async ({ text }) => `echo: ${text}`, logPath = null } = {}) {
  const app = createApp({ handler, token: TOKEN, logPath, model: 'qwen2.5:7b' });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => app.close());
  return `http://127.0.0.1:${app.address().port}`;
}

const post = (base, path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('without a token the page asks for one, and every API call is refused', async (t) => {
  const base = await boot(t);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200, 'a login form, not a bare 401');
  assert.match(await page.text(), /Paste the token/);

  const api = await fetch(base + '/health');
  assert.equal(api.status, 401);
  assert.equal((await api.json()).ok, false);
});

test('the phone page is served with a token and names the model', async (t) => {
  const base = await boot(t);
  const res = await fetch(base + '/?t=' + TOKEN);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Agent · qwen2\.5:7b/);
  assert.match(html, /qwen2\.5:7b/);
  assert.match(html, /id="t"/, 'has the task box');
});

test('a task returns the model reply and the measured duration', async (t) => {
  const base = await boot(t);
  const res = await post(base, '/task', { text: 'status?' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.reply, 'echo: status?');
  assert.equal(body.status, 'ok');
  assert.equal(body.chat, 'pwa');
  assert.ok(typeof body.duration_ms === 'number');
  assert.match(body.run_id, /^[a-z0-9]+-[a-z0-9]{6}$/);
});

test('a task is appended to runs.jsonl in the same shape as the chat transports', async (t) => {
  const dir = join(tmpdir(), `pwa-test-${process.pid}`);
  const logPath = join(dir, 'runs.jsonl');
  await rm(dir, { recursive: true, force: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const base = await boot(t, { logPath });
  await post(base, '/task', { text: 'log me' });

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.chat, 'pwa');
  assert.equal(rec.task, 'log me');
  assert.equal(rec.reply, 'echo: log me');
  assert.equal(rec.status, 'ok');
});

test('a bad token cannot submit a task', async (t) => {
  const base = await boot(t);
  const res = await post(base, '/task', { text: 'nope' }, { 'x-bridge-token': 'wrong' });
  assert.equal(res.status, 401);
});

test('invalid JSON and empty text are rejected with 400', async (t) => {
  const base = await boot(t);
  assert.equal((await post(base, '/task', '{not json')).status, 400);
  assert.equal((await post(base, '/task', { text: '   ' })).status, 400);
});

test('a failing handler is logged as an error, not swallowed', async (t) => {
  const base = await boot(t, {
    handler: async () => { throw new Error('model unavailable'); },
  });
  const res = await post(base, '/task', { text: 'do it' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 'error');
  assert.equal(body.error, 'model unavailable');
  assert.equal(body.reply, 'Error: model unavailable');
});

test('health reports ok, and unknown routes 404', async (t) => {
  const base = await boot(t);
  const health = await fetch(base + '/health', { headers: { 'x-bridge-token': TOKEN } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const missing = await fetch(base + '/nope', { headers: { 'x-bridge-token': TOKEN } });
  assert.equal(missing.status, 404);
});

test('createApp refuses to start without a usable token', () => {
  assert.throws(() => createApp({ handler: async () => 'x' }), /requires a token/);
  assert.throws(() => createApp({ handler: async () => 'x', token: 'short' }), /at least 8 characters/);
  assert.throws(() => createApp({ token: TOKEN }), /requires a handler/);
});

test('conversation memory: the second request carries the first turn', async (t) => {
  const dir = join(tmpdir(), `mem-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  await rm(dir, { recursive: true, force: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const seen = [];
  const app = createApp({
    handler: async (m) => { seen.push(m); return `answer ${seen.length}`; },
    token: TOKEN,
    name: 'Scout',
    historyPath: join(dir, 'session.jsonl'),
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;

  await post(base, '/task', { text: 'first question' });
  await post(base, '/task', { text: 'second question' });

  assert.equal(seen[0].history.length, 0);
  assert.equal(seen[1].history.length, 2);
  assert.equal(seen[1].history[0].content, 'first question');
  assert.equal(seen[1].history[1].role, 'assistant');
});
