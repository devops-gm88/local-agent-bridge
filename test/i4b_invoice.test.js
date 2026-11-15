/**
 * Invoice slice — I4b upgrade.
 *
 * The first half proves the n8n Code-node logic was ported faithfully: the same eight cases
 * that `n8n_demo/tools/test_guard.js` runs are run here against engine.js.
 *
 * The second half proves the external approval API: n8n can open an approval, the phone
 * decides, the callback closes the loop, the decision executes once, and an invoice the
 * policy rejects never reaches a human at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normaliseInvoice, normalisePolicyRow, matchVendorPolicy, parseModelJson,
  adjudicateInvoice, inspectInvoice, approvalKey, payloadHash,
} from '../engine.js';
import { createTools } from '../tools.js';
import { createInvoiceTools } from '../invoice_tools.js';
import { createApprovalQueue } from '../approvals.js';
import { createAgentHandler } from '../agent.js';
import { requiresApproval } from '../guard.js';
import { createApp } from '../server.js';

const TOKEN = 'test-token-1234';

const POLICY_OK = {
  policy_found: true, matched_vendor: 'Northline Electrical Supply', category: 'electrical supplies',
  approved_limit: 2500, account_active: true,
};
const POLICY_UNKNOWN = { policy_found: false, matched_vendor: null, category: 'unmatched', approved_limit: null, account_active: false };
const POLICY_INACTIVE = { ...POLICY_OK, account_active: false };

const approve = (amount, extra = {}) => ({
  vendor: 'Northline Electrical Supply',
  amount,
  currency: 'CAD',
  category: 'electrical supplies',
  decision: 'approved',
  reason: 'looks fine',
  confidence: 0.95,
  ...extra,
});
const runGuard = (output, policy) => adjudicateInvoice({
  output: typeof output === 'string' ? output : JSON.stringify(output),
  policy,
  confidenceFloor: 0.6,
});

// ---------------------------------------------------------------- the port

test('ported n8n guard: model approves a valid invoice -> auto_approve', () => {
  const out = runGuard(approve(1840), POLICY_OK);
  assert.equal(out.route, 'auto_approve');
  assert.equal(out.decision, 'approved');
});

test('ported n8n guard: unknown vendor is downgraded to needs_review', () => {
  const out = runGuard(approve(500), POLICY_UNKNOWN);
  assert.equal(out.route, 'needs_review');
  assert.equal(out.model_decision, 'approved');
  assert.ok(out.validation_problems.some((p) => p.includes('not on the approved-supplier table')));
});

test('ported n8n guard: over-limit approval is downgraded', () => {
  const out = runGuard(approve(4200), POLICY_OK);
  assert.equal(out.route, 'needs_review');
  assert.ok(out.validation_problems.some((p) => p.includes('exceeds the approved limit')));
});

test('ported n8n guard: inactive supplier is downgraded', () => {
  const out = runGuard(approve(200), POLICY_INACTIVE);
  assert.equal(out.route, 'needs_review');
  assert.ok(out.validation_problems.some((p) => p.includes('account is inactive')));
});

test('ported n8n guard: below the confidence floor is downgraded', () => {
  const out = runGuard(approve(100, { confidence: 0.2 }), POLICY_OK);
  assert.equal(out.route, 'needs_review');
  assert.ok(out.validation_problems.some((p) => p.includes('confidence floor')));
});

test('ported n8n guard: model wraps JSON in markdown -> still parsed', () => {
  const out = runGuard('```json\n' + JSON.stringify({ ...approve(100), decision: 'needs_review', reason: 'over policy' }) + '\n```', POLICY_OK);
  assert.equal(out.model_decision, 'needs_review');
  assert.equal(out.vendor, 'Northline Electrical Supply');
});

test('ported n8n guard: prose instead of JSON -> needs_review, no crash', () => {
  const out = runGuard('I think this is fine, approve it.', POLICY_OK);
  assert.equal(out.route, 'needs_review');
  assert.ok(out.validation_problems.some((p) => p.includes('no parseable JSON')));
});

test('ported n8n guard: approved invoice with an empty reason gets a written reason', () => {
  const out = runGuard(approve(100, { reason: '' }), POLICY_OK);
  assert.equal(out.route, 'auto_approve');
  assert.ok(out.reason.length > 0);
});

test('intake normalises messy amounts and records what was missing', () => {
  const ok = normaliseInvoice({ vendor: 'Northline', amount: '$1,840.50', currency: 'cad' });
  assert.equal(ok.amount, 1840.5);
  assert.equal(ok.currency, 'CAD');
  assert.deepEqual(ok.problems, []);

  const bad = normaliseInvoice({});
  assert.match(bad.problems.join(' '), /vendor missing/);
  assert.match(bad.problems.join(' '), /amount missing/);
  const nested = normaliseInvoice({ invoice: { vendor: 'Kestrel', amount: 780 } });
  assert.equal(nested.vendor, 'Kestrel');
  assert.equal(nested.amount, 780);
});

test('vendor matching tolerates partial names and sheet-style policy rows', () => {
  const policies = [
    { vendor: 'Northline Electrical Supply', category: 'electrical supplies', approved_limit: 2500, account_active: true },
    { vendor: 'Meridian Tool Rental', category: 'equipment rental', approved_limit: 1200, account_active: 'FALSE' },
  ];
  assert.equal(matchVendorPolicy({ vendor: 'Northline' }, policies).policy_found, true);
  assert.equal(matchVendorPolicy({ vendor: 'ACME Widgets' }, policies).policy_found, false);
  assert.equal(normalisePolicyRow({ vendor: 'X', approved_limit: '900', account_active: 'TRUE' }).active, 'TRUE');
});

test('inspectInvoice fails closed on missing limits and gives a fileable answer otherwise', () => {
  const vendors = [{ vendor: 'Northline Electrical Supply', category: 'electrical supplies', approved_limit: 2500, account_active: true }];
  const ok = inspectInvoice({ invoice: { vendor: 'Northline Electrical Supply', amount: 1840 }, policies: vendors });
  assert.equal(ok.eligible, true);
  assert.equal(ok.recommendation, 'auto_approve');

  const over = inspectInvoice({ invoice: { vendor: 'Northline Electrical Supply', amount: 4200 }, policies: vendors });
  assert.equal(over.eligible, false);
  assert.ok(over.reasons.some((r) => r.includes('exceeds the approved limit')));

  const noLimit = inspectInvoice({
    invoice: { vendor: 'Northline Electrical Supply', amount: 10 },
    policies: [{ vendor: 'Northline Electrical Supply', approved_limit: null, account_active: true }],
  });
  assert.equal(noLimit.eligible, false);
  assert.ok(noLimit.reasons.some((r) => r.includes('approved limit is missing')));
});

test('the approval key stays deterministic and key-order independent', () => {
  assert.equal(approvalKey('run-1', { a: 1, b: 2 }), approvalKey('run-1', { b: 2, a: 1 }));
  assert.notEqual(approvalKey('run-1', { a: 1 }), approvalKey('run-2', { a: 1 }));
  assert.match(payloadHash({ a: 1 }), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- invoice tools

async function workspace(t) {
  const dir = join(tmpdir(), `invoice-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = {
    dir,
    rowsPath: join(dir, 'rows.jsonl'),
    invoicesPath: join(dir, 'invoices.jsonl'),
    vendorsPath: join(dir, 'vendors.json'),
    approvalsPath: join(dir, 'approvals.jsonl'),
  };
  await writeFile(paths.vendorsPath, JSON.stringify({
    vendors: [
      { vendor: 'Northline Electrical Supply', category: 'electrical supplies', approved_limit: 2500, account_active: true },
      { vendor: 'Kestrel Industrial Fasteners', category: 'fasteners', approved_limit: 900, account_active: true },
    ],
  }), 'utf8');
  return paths;
}

test('check_invoice reads the policy; file_invoice is a gated write that refuses bad invoices', async (t) => {
  const paths = await workspace(t);
  const invoiceTools = createInvoiceTools(paths);

  assert.equal(requiresApproval(invoiceTools.file_invoice.class), true);
  assert.equal(requiresApproval(invoiceTools.check_invoice.class), false);

  const check = await invoiceTools.check_invoice.run({ invoice: { vendor: 'Northline Electrical Supply', amount: 1840 } });
  assert.equal(check.eligible, true);
  assert.equal(check.policy.approved_limit, 2500);

  await assert.rejects(
    () => invoiceTools.file_invoice.precheck({ invoice: { vendor: 'Acme Widgets', amount: 500 } }),
    /not on the approved-supplier table/,
  );
  await assert.rejects(
    () => invoiceTools.file_invoice.run({ invoice: { vendor: 'Northline Electrical Supply', amount: 4200 } }),
    /exceeds the approved limit/,
  );

  const filed = await invoiceTools.file_invoice.run({ invoice: { vendor: 'Northline Electrical Supply', amount: 1840 } });
  assert.equal(filed.filed.vendor, 'Northline Electrical Supply');
  assert.equal((await invoiceTools.read_invoices.run()).filed, 1);
});

test('file_invoice_override allows a human-approved policy override, and records why', async (t) => {
  const paths = await workspace(t);
  const tools = createInvoiceTools(paths);

  assert.equal(requiresApproval(tools.file_invoice_override.class), true);
  assert.equal(tools.file_invoice_override.precheck({ invoice: { vendor: 'Northline Electrical Supply', amount: 4200 } }) instanceof Promise, true);
  await tools.file_invoice_override.precheck({ invoice: { vendor: 'Northline Electrical Supply', amount: 4200 } }); // policy failure allowed
  await assert.rejects(() => tools.file_invoice_override.precheck({ invoice: {} }), /not fileable/);

  const out = await tools.file_invoice_override.run({
    invoice: { vendor: 'Northline Electrical Supply', amount: 4200, currency: 'CAD' },
    reason: 'PO confirmed by the owner',
  });
  assert.equal(out.policy_override, true);
  const line = JSON.parse((await readFile(paths.invoicesPath, 'utf8')).trim());
  assert.equal(line.decision, 'filed_override');
  assert.equal(line.policy_override, true);
  assert.equal(line.override_reason, 'PO confirmed by the owner');
  assert.ok(line.policy_reasons.some((r) => /exceeds the approved limit/.test(r)));
});

// ---------------------------------------------------------------- external approval API

async function callbackReceiver(t) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/n8n-hook`, seen };
}

async function boot(t, paths, extra = {}) {
  const tools = {
    ...createTools({ rowsPath: paths.rowsPath }),
    ...createInvoiceTools(paths),
  };
  const app = createApp({
    handler: async ({ text }) => `echo: ${text}`,
    token: TOKEN,
    rowsPath: paths.rowsPath,
    approvalsPath: paths.approvalsPath,
    tools,
    callbackToken: TOKEN,
    callbackTimeoutMs: 500,
    ...extra,
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => app.close());
  return { base: `http://127.0.0.1:${app.address().port}`, tools };
}

const call = (base, path, body, token = TOKEN) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bridge-token': token },
  body: JSON.stringify(body),
});
const get = (base, path, token = TOKEN) => fetch(base + path, { headers: { 'x-bridge-token': token } });

test('the n8n loop: open approval -> pending -> approve once -> callback once -> status executed', async (t) => {
  const paths = await workspace(t);
  const receiver = await callbackReceiver(t);
  const { base } = await boot(t, paths);

  const opened = await call(base, '/api/approvals', {
    run_id: 'invoice-1',
    tool: 'file_invoice',
    payload: { invoice: { vendor: 'Northline Electrical Supply', amount: 1840, invoice_ref: 'NL-1042' } },
    callback_url: receiver.url,
    title: 'Northline NL-1042',
  });
  assert.equal(opened.status, 202);
  const pending = await opened.json();
  assert.equal(pending.status, 'pending_approval');
  assert.match(pending.id, /^[0-9a-f]{64}$/);
  await assert.rejects(() => readFile(paths.invoicesPath, 'utf8'), /ENOENT/, 'nothing filed before approval');

  const status = await (await get(base, `/api/approvals/${pending.id}`)).json();
  assert.equal(status.status, 'pending');
  assert.equal(status.tool, 'file_invoice');

  const approved = await (await call(base, '/approve', { id: pending.id, decision: 'approve' })).json();
  assert.equal(approved.status, 'executed');
  assert.equal(approved.callback.ok, true);
  assert.equal((await readFile(paths.invoicesPath, 'utf8')).trim().split('\n').length, 1);

  assert.equal(receiver.seen.length, 1);
  assert.equal(receiver.seen[0].headers['x-bridge-token'], TOKEN);
  assert.equal(receiver.seen[0].body.decision, 'approve');
  assert.equal(receiver.seen[0].body.executed, true);
  assert.equal(receiver.seen[0].body.id, pending.id);

  const after = await (await get(base, `/api/approvals/${pending.id}`)).json();
  assert.equal(after.status, 'executed');

  const again = await (await call(base, '/approve', { id: pending.id, decision: 'approve' })).json();
  assert.equal(again.status, 'duplicate');
  assert.equal(receiver.seen.length, 1, 'a duplicate approval fires no second callback');
  assert.equal((await readFile(paths.invoicesPath, 'utf8')).trim().split('\n').length, 1);
});

test('an email-driven decision suppresses the phone callback, and duplicate reports the prior decision', async (t) => {
  const paths = await workspace(t);
  const receiver = await callbackReceiver(t);
  const { base } = await boot(t, paths);

  const opened = await (await call(base, '/api/approvals', {
    run_id: 'invoice-email-1',
    tool: 'file_invoice_override',
    payload: { invoice: { vendor: 'Northline Electrical Supply', amount: 4200 }, reason: 'email decision' },
    callback_url: receiver.url,
  })).json();

  // The reply workflow calls /approve with suppress_callback: n8n owns the Sheet write for an
  // email decision, so firing the phone webhook would append the same invoice twice.
  const first = await (await call(base, '/approve', { id: opened.id, decision: 'approve', suppress_callback: true })).json();
  assert.equal(first.status, 'executed');
  assert.equal(first.callback, null);
  assert.equal(receiver.seen.length, 0, 'no phone webhook for an email decision');
  assert.equal((await readFile(paths.invoicesPath, 'utf8')).trim().split('\n').length, 1);

  const second = await (await call(base, '/approve', { id: opened.id, decision: 'approve', suppress_callback: true })).json();
  assert.equal(second.status, 'duplicate');
  assert.equal(second.previous.decision, 'approve');
  assert.equal(second.previous.executed, true);
  assert.equal(receiver.seen.length, 0);
  assert.equal((await readFile(paths.invoicesPath, 'utf8')).trim().split('\n').length, 1);
});

test('a rejected invoice is not filed, and the callback records the rejection', async (t) => {
  const paths = await workspace(t);
  const receiver = await callbackReceiver(t);
  const { base } = await boot(t, paths);

  const opened = await (await call(base, '/api/approvals', {
    run_id: 'invoice-2',
    tool: 'file_invoice',
    payload: { invoice: { vendor: 'Kestrel Industrial Fasteners', amount: 780 } },
    callback_url: receiver.url,
  })).json();

  const rejected = await (await call(base, '/approve', { id: opened.id, decision: 'reject' })).json();
  assert.equal(rejected.status, 'rejected');
  await assert.rejects(() => readFile(paths.invoicesPath, 'utf8'), /ENOENT/);
  assert.equal(receiver.seen[0].body.decision, 'reject');
  assert.equal(receiver.seen[0].body.executed, false);
  assert.equal((await (await get(base, `/api/approvals/${opened.id}`)).json()).status, 'rejected');
});

test('an invoice the policy rejects never opens an approval at all', async (t) => {
  const paths = await workspace(t);
  const { base } = await boot(t, paths);

  const over = await call(base, '/api/approvals', {
    run_id: 'invoice-3',
    tool: 'file_invoice',
    payload: { invoice: { vendor: 'Northline Electrical Supply', amount: 4200 } },
  });
  assert.equal(over.status, 422);
  const body = await over.json();
  assert.equal(body.status, 'rejected_by_policy');
  assert.match(body.error, /exceeds the approved limit/);

  const unknown = await call(base, '/api/approvals', { tool: 'drop_everything', payload: {} });
  assert.equal(unknown.status, 400);

  const pendingNow = await (await get(base, '/approvals')).json();
  assert.equal(pendingNow.pending.length, 0, 'no human is asked about a policy-failed invoice');

  // n8n's exception path uses the explicit override tool: the human decision IS the override,
  // so this invoice can be opened for approval and is recorded as an override when executed.
  const override = await call(base, '/api/approvals', {
    run_id: 'invoice-3-override',
    tool: 'file_invoice_override',
    payload: { invoice: { vendor: 'Northline Electrical Supply', amount: 4200 }, reason: 'owner confirmed PO' },
  });
  assert.equal(override.status, 202);
  const opened = await override.json();
  assert.equal(opened.tool, 'file_invoice_override');
  const executed = await (await call(base, '/approve', { id: opened.id, decision: 'approve' })).json();
  assert.equal(executed.status, 'executed');
  assert.equal(executed.result.filed.policy_override, true);
  assert.equal((await readFile(paths.invoicesPath, 'utf8')).trim().split('\n').length, 1);
});

test('a failed callback never un-does the decision; it is logged as a callback line', async (t) => {
  const paths = await workspace(t);
  const { base } = await boot(t, paths);

  const opened = await (await call(base, '/api/approvals', {
    run_id: 'invoice-4',
    tool: 'file_invoice',
    payload: { invoice: { vendor: 'Kestrel Industrial Fasteners', amount: 100 } },
    callback_url: 'http://127.0.0.1:1/n8n-hook', // nothing listens here
  })).json();

  const approved = await (await call(base, '/approve', { id: opened.id, decision: 'approve' })).json();
  assert.equal(approved.status, 'executed');
  assert.equal(approved.callback.ok, false);
  assert.equal((await readFile(paths.invoicesPath, 'utf8')).trim().split('\n').length, 1);

  const log = (await readFile(paths.approvalsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const callbackLine = log.find((l) => l.type === 'callback');
  assert.ok(callbackLine, 'the failed callback is in the audit log');
  assert.equal(callbackLine.ok, false);
  assert.equal(log.filter((l) => l.type === 'decision').length, 1);
});

test('the agent precheck blocks a policy-failed file_invoice before an approval is opened', async (t) => {
  const paths = await workspace(t);
  const tools = { ...createTools({ rowsPath: paths.rowsPath }), ...createInvoiceTools(paths) };
  const approvals = createApprovalQueue({ logPath: paths.approvalsPath });
  const turns = [
    { tool_calls: [{ id: 'c1', name: 'file_invoice', arguments: { invoice: { vendor: 'Northline Electrical Supply', amount: 4200 } } }] },
    { content: 'That invoice is over the approved limit, so I did not file it.' },
  ];
  let i = 0;
  const chat = async () => {
    const turn = turns[i++];
    return { content: turn.content ?? '', tool_calls: turn.tool_calls ?? [], assistant: { role: 'assistant', content: turn.content ?? '' } };
  };
  const handle = createAgentHandler({ chat, tools, approvals });
  const out = await handle({ text: 'file the Northline invoice for 4200' });

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.steps, [{
    tool: 'file_invoice',
    status: 'policy_rejected',
    error: 'invoice is not eligible to file: 4200 exceeds the approved limit of 2500',
  }]);
  assert.equal(approvals.list().length, 0, 'the owner was not asked');
  await assert.rejects(() => readFile(paths.invoicesPath, 'utf8'), /ENOENT/);
});

// ---------------------------------------------------------------- parse helper

test('parseModelJson accepts bare, fenced and embedded JSON and rejects prose', () => {
  assert.equal(parseModelJson('{"a":1}').parsed.a, 1);
  assert.equal(parseModelJson('```json\n{"a":2}\n```').parsed.a, 2);
  assert.equal(parseModelJson('prefix {"a":3} suffix').parsed.a, 3);
  assert.match(parseModelJson('no json here').problems.join(' '), /no parseable JSON/);
  assert.equal(parseModelJson('{"a":1}').parsed !== null, true);
});
