/**
 * Decision-only approvals: the research (APPROVE/REPLACE/DROP) and reconciliation action sets.
 * Shotty records the human decision and calls back; n8n executes the consequence. Nothing in
 * these tests executes a Shotty tool.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../server.js';
import { createApprovalQueue, cleanActions, cleanFields, DEFAULT_ACTIONS } from '../approvals.js';
import { createTools } from '../tools.js';

const TOKEN = 'test-token-1234';

async function workspace(t) {
  const dir = join(tmpdir(), `decision-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    rowsPath: join(dir, 'rows.jsonl'),
    approvalsPath: join(dir, 'approvals.jsonl'),
    invoicesPath: join(dir, 'invoices.jsonl'),
    vendorsPath: join(dir, 'vendors.json'),
  };
}

async function receiver(t) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/hook`, seen };
}

async function boot(t, paths) {
  const app = createApp({
    handler: async ({ text }) => `echo: ${text}`,
    token: TOKEN,
    rowsPath: paths.rowsPath,
    approvalsPath: paths.approvalsPath,
    callbackToken: TOKEN,
    callbackTimeoutMs: 500,
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => app.close());
  return `http://127.0.0.1:${app.address().port}`;
}

const call = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
  body: JSON.stringify(body),
});
const get = (base, path) => fetch(base + path, { headers: { 'x-bridge-token': TOKEN } });

const RESEARCH_ACTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'replace', label: 'Replace' },
  { id: 'drop', label: 'Drop' },
];
const RESEARCH_FIELDS = [
  { label: 'Row', value: '12' },
  { label: 'Defect', value: 'missing source URL' },
];

test('a research decision is recorded and sent to the workflow without executing a tool', async (t) => {
  const paths = await workspace(t);
  const hook = await receiver(t);
  const base = await boot(t, paths);

  const opened = await call(base, '/api/approvals', {
    run_id: 'research-row-12',
    execute: false,
    title: 'Row 12 — missing source',
    actions: RESEARCH_ACTIONS,
    fields: RESEARCH_FIELDS,
    payload: { row_id: 12, batch: 'B-01' },
    callback_url: hook.url,
  });
  assert.equal(opened.status, 202);
  const pending = await opened.json();
  assert.equal(pending.status, 'pending_approval');
  assert.equal(pending.execute, false);
  assert.equal(pending.class, 'decision');
  assert.deepEqual(pending.actions.map((a) => a.label), ['Approve', 'Replace', 'Drop']);

  const status = await (await get(base, `/api/approvals/${pending.id}`)).json();
  assert.equal(status.status, 'pending');
  assert.equal(status.execute, false);
  assert.deepEqual(status.fields, RESEARCH_FIELDS);
  assert.deepEqual(status.actions, RESEARCH_ACTIONS);

  const decided = await (await call(base, '/approve', { id: pending.id, decision: 'replace' })).json();
  assert.equal(decided.status, 'decided');
  assert.equal(decided.decision, 'replace');
  assert.equal(decided.execute, false);
  assert.equal(decided.callback.ok, true);

  assert.equal(hook.seen.length, 1);
  assert.equal(hook.seen[0].decision, 'replace');
  assert.equal(hook.seen[0].action, 'replace');
  assert.equal(hook.seen[0].executed, false);
  assert.equal(hook.seen[0].execute, false);
  assert.deepEqual(hook.seen[0].fields, RESEARCH_FIELDS);
  assert.deepEqual(hook.seen[0].payload, { row_id: 12, batch: 'B-01' }, 'the workflow can route on ids');

  const after = await (await get(base, `/api/approvals/${pending.id}`)).json();
  assert.equal(after.status, 'decided');
  assert.equal(after.decision, 'replace');

  const again = await (await call(base, '/approve', { id: pending.id, decision: 'approve' })).json();
  assert.equal(again.status, 'duplicate');
  assert.equal(again.previous.decision, 'replace');
  assert.equal(hook.seen.length, 1, 'a duplicate decision fires no second callback');
});

test('validation: action sets, fields and decisions all fail closed', async (t) => {
  const paths = await workspace(t);
  const base = await boot(t, paths);

  const noTool = await call(base, '/api/approvals', { run_id: 'x', payload: {} });
  assert.equal(noTool.status, 400, 'an executing approval still requires a tool');

  const tooMany = await call(base, '/api/approvals', {
    run_id: 'x2', execute: false,
    actions: ['a', 'b', 'c', 'd', 'e'],
  });
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /at most 4 actions/);

  const duplicate = await call(base, '/api/approvals', {
    run_id: 'x3', execute: false,
    actions: [{ id: 'approve' }, { id: 'approve', label: 'Again' }],
  });
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).error, /duplicate action id/);

  const badFields = await call(base, '/api/approvals', {
    run_id: 'x4', execute: false, actions: ['approve'], fields: 'nope',
  });
  assert.equal(badFields.status, 400);

  const opened = await (await call(base, '/api/approvals', {
    run_id: 'x5', execute: false, actions: ['approve', 'replace'], payload: { row: 1 },
  })).json();
  const wrong = await call(base, '/approve', { id: opened.id, decision: 'drop' });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /decision must be one of/);
});

test('tool-backed approvals keep the Approve/Reject decision contract', async (t) => {
  const paths = await workspace(t);
  const tools = createTools({ rowsPath: paths.rowsPath });
  const queue = createApprovalQueue({ logPath: paths.approvalsPath });
  const opened = await queue.open({ runId: 'r-tool', tool: 'append_row', payload: { row: { n: 1 } } });
  assert.equal(opened.execute, true);
  assert.deepEqual(opened.actions, DEFAULT_ACTIONS);

  await assert.rejects(
    () => queue.decide({ id: opened.id, decision: 'replace', tools }),
    /decision must be one of: approve, reject/,
  );
  assert.equal((await queue.decide({ id: opened.id, decision: 'approve', tools })).status, 'executed');
});

test('a decision approval survives a restart with its actions and fields intact', async (t) => {
  const paths = await workspace(t);
  const first = createApprovalQueue({ logPath: paths.approvalsPath });
  const opened = await first.open({
    runId: 'r-restart-decision',
    execute: false,
    actions: RESEARCH_ACTIONS,
    fields: RESEARCH_FIELDS,
    payload: { row: 2 },
  });

  const second = createApprovalQueue({ logPath: paths.approvalsPath });
  const pending = second.list()[0];
  assert.equal(pending.id, opened.id);
  assert.deepEqual(pending.actions, RESEARCH_ACTIONS);
  assert.deepEqual(pending.fields, RESEARCH_FIELDS);
  assert.equal(pending.execute, false);

  const outcome = await second.decide({ id: opened.id, decision: 'drop', tools: {} });
  assert.equal(outcome.status, 'decided');

  const third = createApprovalQueue({ logPath: paths.approvalsPath });
  assert.equal((await third.decide({ id: opened.id, decision: 'approve', tools: {} })).status, 'duplicate');
  const log = (await readFile(paths.approvalsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.find((l) => l.type === 'decision').decision, 'drop');
});

test('action and field normalisation is strict but sensible', () => {
  assert.deepEqual(cleanActions(['approve', 'drop']).map((a) => a.id), ['approve', 'drop']);
  assert.equal(cleanActions(['approve', 'drop'])[1].label, 'Drop');
  assert.deepEqual(cleanActions(null), DEFAULT_ACTIONS);
  assert.equal(cleanActions([{ id: 'accept', label: 'Accept into ledger' }])[0].label, 'Accept into ledger');
  assert.equal(cleanFields(null), null);
  assert.deepEqual(cleanFields([{ label: 'Amount', value: 4200 }]), [{ label: 'Amount', value: '4200' }]);
  assert.throws(() => cleanActions([{ id: 'Bad Id' }]), /invalid action id/);
  assert.throws(() => cleanFields([{ value: 'no label' }]), /needs a label/);
});
