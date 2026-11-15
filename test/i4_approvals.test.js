/**
 * I4 — the approval gate. The exit test from the plan:
 * a write stops for approval, Approve executes exactly once, a second Approve does not
 * duplicate, and both decisions are in approvals.jsonl.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../server.js';
import { createTools } from '../tools.js';
import { createApprovalQueue } from '../approvals.js';
import { CLASSES, requiresApproval, payloadHash, approvalKey } from '../guard.js';

const TOKEN = 'test-token-1234';

async function workspace(t) {
  const dir = join(tmpdir(), `i4-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await rm(dir, { recursive: true, force: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    rowsPath: join(dir, 'rows.jsonl'),
    approvalsPath: join(dir, 'approvals.jsonl'),
  };
}

async function boot(t, paths) {
  const app = createApp({
    handler: async ({ text }) => `echo: ${text}`,
    token: TOKEN,
    rowsPath: paths.rowsPath,
    approvalsPath: paths.approvalsPath,
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => app.close());
  return `http://127.0.0.1:${app.address().port}`;
}

const call = (base, path, body, token = TOKEN) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': token },
    body: JSON.stringify(body),
  });

const get = (base, path, token = TOKEN) =>
  fetch(base + path, { headers: { 'x-bridge-token': token } });

// ---------------------------------------------------------------- the rule

test('write and external-send require approval; read and compute do not', () => {
  assert.equal(requiresApproval(CLASSES.WRITE), true);
  assert.equal(requiresApproval(CLASSES.EXTERNAL), true);
  assert.equal(requiresApproval(CLASSES.READ), false);
  assert.equal(requiresApproval(CLASSES.COMPUTE), false);
  assert.equal(requiresApproval('something-else'), false, 'unknown classes fail open only for reads');
});

test('the payload hash is stable across key order and the key binds the run id', () => {
  const a = payloadHash({ b: 2, a: 1 });
  const b = payloadHash({ a: 1, b: 2 });
  assert.equal(a, b);
  assert.notEqual(approvalKey('run-1', { a: 1 }), approvalKey('run-2', { a: 1 }));
  assert.notEqual(approvalKey('run-1', { a: 1 }), approvalKey('run-1', { a: 2 }));
});

// ---------------------------------------------------------------- the queue

test('a write is not executed when it is opened — it waits', async (t) => {
  const paths = await workspace(t);
  const tools = createTools({ rowsPath: paths.rowsPath });
  const queue = createApprovalQueue({ logPath: paths.approvalsPath });

  const rec = await queue.open({ runId: 'r1', tool: 'append_row', payload: { row: { n: 1 } } });
  assert.equal(rec.status, 'pending');
  assert.equal(queue.list().length, 1);

  const { rows } = await tools.read_rows.run();
  assert.equal(rows, 0, 'nothing was written while pending');
});

test('approve executes exactly once; a second approve is a duplicate and writes nothing', async (t) => {
  const paths = await workspace(t);
  const tools = createTools({ rowsPath: paths.rowsPath });
  const queue = createApprovalQueue({ logPath: paths.approvalsPath });

  const { id } = await queue.open({ runId: 'r1', tool: 'append_row', payload: { row: { n: 1 } } });

  const first = await queue.decide({ id, decision: 'approve', tools });
  assert.equal(first.status, 'executed');
  assert.equal((await tools.read_rows.run()).rows, 1);

  const second = await queue.decide({ id, decision: 'approve', tools });
  assert.equal(second.status, 'duplicate');
  assert.equal((await tools.read_rows.run()).rows, 1, 'no second row');
});

test('reject does not execute, and is recorded as decided', async (t) => {
  const paths = await workspace(t);
  const tools = createTools({ rowsPath: paths.rowsPath });
  const queue = createApprovalQueue({ logPath: paths.approvalsPath });

  const { id } = await queue.open({ runId: 'r1', tool: 'append_row', payload: { row: { n: 2 } } });
  const out = await queue.decide({ id, decision: 'reject', tools });
  assert.equal(out.status, 'rejected');
  assert.equal((await tools.read_rows.run()).rows, 0);
  assert.equal((await queue.decide({ id, decision: 'reject', tools })).status, 'duplicate');
});

test('an unknown approval id fails closed and is not silently accepted', async () => {
  const queue = createApprovalQueue();
  await assert.rejects(() => queue.decide({ id: 'nope', decision: 'approve', tools: {} }), /unknown approval id/);
});

test('both decisions are appended to approvals.jsonl with the audit fields', async (t) => {
  const paths = await workspace(t);
  const tools = createTools({ rowsPath: paths.rowsPath });
  const queue = createApprovalQueue({ logPath: paths.approvalsPath });

  const a = await queue.open({ runId: 'r1', tool: 'append_row', payload: { row: { n: 3 } } });
  await queue.decide({ id: a.id, decision: 'approve', tools });
  const b = await queue.open({ runId: 'r2', tool: 'append_row', payload: { row: { n: 4 } } });
  await queue.decide({ id: b.id, decision: 'reject', tools });

  const lines = (await readFile(paths.approvalsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const decisions = lines.filter((l) => l.type === 'decision');
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].decision, 'approve');
  assert.equal(decisions[0].executed, true);
  assert.equal(decisions[1].decision, 'reject');
  assert.equal(decisions[1].executed, false);
  for (const d of decisions) {
    assert.match(d.payload_hash, /^[0-9a-f]{64}$/);
    assert.ok(d.decided_at);
    assert.equal(d.tool, 'append_row');
  }
});

// ---------------------------------------------------------------- over HTTP

test('a read tool executes immediately; a write tool returns 202 pending', async (t) => {
  const paths = await workspace(t);
  const base = await boot(t, paths);

  const read = await call(base, '/tool', { tool: 'read_rows', payload: {} });
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).result, { rows: 0 });

  const write = await call(base, '/tool', { tool: 'append_row', payload: { row: { n: 5 } } });
  assert.equal(write.status, 202);
  const body = await write.json();
  assert.equal(body.status, 'pending_approval');
  assert.match(body.id, /^[0-9a-f]{64}$/);
});

test('the HTTP exit test: pending -> approve -> one row -> second approve is a duplicate', async (t) => {
  const paths = await workspace(t);
  const base = await boot(t, paths);

  const opened = await (await call(base, '/tool', { tool: 'append_row', payload: { row: { n: 6 } } })).json();

  const pending = await (await get(base, '/approvals')).json();
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0].id, opened.id);

  const ok = await call(base, '/approve', { id: opened.id, decision: 'approve' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, 'executed');

  const rows = (await readFile(paths.rowsPath, 'utf8')).trim().split('\n');
  assert.equal(rows.length, 1);

  const again = await call(base, '/approve', { id: opened.id, decision: 'approve' });
  assert.equal((await again.json()).status, 'duplicate');
  assert.equal((await readFile(paths.rowsPath, 'utf8')).trim().split('\n').length, 1);

  const empty = await (await get(base, '/approvals')).json();
  assert.equal(empty.pending.length, 0);
});

test('reject over HTTP writes nothing, and an unknown id is a 404', async (t) => {
  const paths = await workspace(t);
  const base = await boot(t, paths);

  const opened = await (await call(base, '/tool', { tool: 'append_row', payload: { row: { n: 7 } } })).json();
  const rejected = await call(base, '/approve', { id: opened.id, decision: 'reject' });
  assert.equal((await rejected.json()).status, 'rejected');
  await assert.rejects(() => readFile(paths.rowsPath, 'utf8'), /ENOENT/);

  const missing = await call(base, '/approve', { id: 'deadbeef', decision: 'approve' });
  assert.equal(missing.status, 404);

  // An invalid decision word must fail on a pending approval, not on an already-decided id
  // (which is a duplicate by design).
  const fresh = await (await call(base, '/tool', { tool: 'append_row', payload: { row: { n: 8 } } })).json();
  const bad = await call(base, '/approve', { id: fresh.id, decision: 'maybe' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /decision must be one of/);
});

test('the approval endpoints are behind the same token', async (t) => {
  const paths = await workspace(t);
  const base = await boot(t, paths);
  assert.equal((await get(base, '/approvals', 'wrong-token')).status, 401);
  assert.equal((await call(base, '/tool', {}, 'wrong-token')).status, 401);
});
