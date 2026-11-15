/**
 * The n8n port, verified rather than asserted.
 *
 * An n8n Code node cannot import engine.js, so `scripts/build-n8n-code.js` inlines the
 * portable region into the three invoice nodes. These tests check that:
 *   1. the workflow on disk is up to date with engine.js (--check),
 *   2. the SHIPPED node text executes and returns exactly what engine.js returns,
 *   3. the demo's own harness (`n8n_demo/tools/test_guard.js`) still passes 8/8,
 *   4. the HTTP Request node and the decision webhook are wired.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  buildWorkflow, buildDecisionWorkflow, extractPortable, serialize,
  WORKFLOW_PATH, DECISION_WORKFLOW_PATH, N8N_DIR,
  RESEARCH_WORKFLOW_PATH, RECONCILIATION_WORKFLOW_PATH,
  RESEARCH_DECISION_PATH, RECONCILIATION_DECISION_PATH,
} from '../scripts/build-n8n-code.js';
import { normaliseInvoice, matchVendorPolicy, adjudicateInvoice } from '../engine.js';

const BRIDGE = fileURLToPath(new URL('..', import.meta.url));
const readWorkflow = () => JSON.parse(readFileSync(WORKFLOW_PATH, 'utf8'));
const getNode = (workflow, name) => {
  const node = workflow.nodes.find((n) => n.name === name);
  assert.ok(node, `workflow is missing node: ${name}`);
  return node;
};
const compile = (code, names) => new Function(...names, 'code', code);

const POLICY_OK = {
  policy_found: true, matched_vendor: 'Northline Electrical Supply', category: 'electrical supplies',
  approved_limit: 2500, account_active: true,
};
const POLICY_UNKNOWN = { policy_found: false, matched_vendor: null, category: 'unmatched', approved_limit: null, account_active: false };

// ---------------------------------------------------------------- generated code

test('the committed workflow is up to date with engine.js (--check)', () => {
  const res = spawnSync(process.execPath, [join(BRIDGE, 'scripts/build-n8n-code.js'), '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /up to date/);
});

test('the n8n demo\'s own guard harness still passes 8/8 against the generated node text', () => {
  const res = spawnSync(process.execPath, [join(N8N_DIR, 'tools/test_guard.js')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /8\/8 passed/);
});

test('generated Code nodes are plain, dependency-free JavaScript', () => {
  const workflow = readWorkflow();
  for (const name of ['Normalise Intake', 'Lookup Vendor Policy', 'Parse and Validate']) {
    const code = getNode(workflow, name).parameters.jsCode;
    assert.match(code, /GENERATED from bridge\/engine\.js/);
    assert.doesNotMatch(code, /^\s*import\s/m, `${name} must not import`);
    assert.doesNotMatch(code, /^\s*export\s/m, `${name} must not export`);
    assert.match(code, /function normaliseInvoice/);
  }
});

test('the portable region is guarded: missing markers or Node-only code is rejected', () => {
  assert.throws(() => extractPortable('const x = 1;'), /missing the portable-invoice markers/);
  assert.throws(
    () => extractPortable('// #region portable-invoice\nimport { createHash } from "node:crypto";\n// #endregion portable-invoice'),
    /must stay dependency-free/,
  );
});

test('kept idempotent: rebuilding an already-generated workflow changes nothing', () => {
  const once = buildWorkflow(readWorkflow());
  const twice = buildWorkflow(JSON.parse(serialize(once)));
  assert.equal(serialize(twice), serialize(once));
});

// ---------------------------------------------------------------- parity with engine.js

test('Normalise Intake node returns the same intake contract as engine.normaliseInvoice', () => {
  const workflow = readWorkflow();
  const run = compile(getNode(workflow, 'Normalise Intake').parameters.jsCode, ['$input', '$']);
  const out = run({ first: () => ({ json: { vendor: 'Northline Electrical Supply', amount: '$1,840.50', currency: 'cad' } }) }, () => null)[0].json;
  const expected = normaliseInvoice({ vendor: 'Northline Electrical Supply', amount: '$1,840.50', currency: 'cad' });

  assert.equal(out.vendor, expected.vendor);
  assert.equal(out.amount, expected.amount);
  assert.equal(out.currency, expected.currency);
  assert.deepEqual(out.intake_problems, expected.problems);
  assert.match(out.intake_id, /^INTAKE-/);
});

test('Lookup Vendor Policy node matches the engine policy exactly', () => {
  const workflow = readWorkflow();
  const run = compile(getNode(workflow, 'Lookup Vendor Policy').parameters.jsCode, ['$json', '$input', '$']);
  const vendors = [{ vendor: 'Northline Electrical Supply', category: 'electrical supplies', approved_limit: 2500, account_active: true }];
  const item = { vendor: 'Northline', config: { vendors } };
  const out = run(item, () => null, () => null)[0].json;
  assert.deepEqual(out.policy, matchVendorPolicy(item, vendors));
  assert.equal(out.vendor, 'Northline');
});

test('Parse and Validate node returns exactly the engine adjudication for every guard case', () => {
  const workflow = readWorkflow();
  const run = compile(getNode(workflow, 'Parse and Validate').parameters.jsCode, ['$input', '$']);
  const cases = [
    [JSON.stringify({ vendor: 'Northline Electrical Supply', amount: 1840, currency: 'CAD', decision: 'approved', reason: 'ok', confidence: 0.95 }), POLICY_OK],
    [JSON.stringify({ vendor: 'Northline Electrical Supply', amount: 4200, currency: 'CAD', decision: 'approved', reason: 'ok', confidence: 0.95 }), POLICY_OK],
    [JSON.stringify({ vendor: 'Northline Electrical Supply', amount: 500, currency: 'CAD', decision: 'approved', reason: 'ok', confidence: 0.95 }), POLICY_UNKNOWN],
    ['I think this is fine, approve it.', POLICY_OK],
  ];
  for (const [output, policy] of cases) {
    const out = run({ first: () => ({ json: { output } }) }, () => ({ first: () => ({ json: { policy } }) }))[0].json;
    const expected = adjudicateInvoice({ output, policy, confidenceFloor: 0.6, intakeId: '' });
    assert.deepEqual(out, expected);
  }
});

// ---------------------------------------------------------------- wiring

test('the exception branch calls Shotty before the Sheet and email', () => {
  const workflow = readWorkflow();
  const http = getNode(workflow, 'Ask Shotty (phone approval)');
  assert.equal(http.type, 'n8n-nodes-base.httpRequest');
  assert.equal(http.parameters.method, 'POST');
  assert.match(http.parameters.url, /\/api\/approvals$/);
  assert.equal(http.parameters.headerParameters.parameters[0].name, 'x-bridge-token');
  assert.equal(http.parameters.headerParameters.parameters[0].value, 'REPLACE_WITH_BRIDGE_TOKEN');
  assert.match(http.parameters.jsonBody, /file_invoice_override/);
  assert.match(http.parameters.jsonBody, /shotty-decision/);
  assert.match(http.parameters.jsonBody, /callback_url/);
  assert.match(http.parameters.jsonBody, /Why held/, 'the phone card is readable');
  assert.match(http.parameters.jsonBody, /reason: \$json\.reason/, 'the hold reason reaches the ledger');

  assert.deepEqual(workflow.connections['Exception Record'].main[0].map((c) => c.node), ['Ask Shotty (phone approval)']);
  assert.deepEqual(workflow.connections['Ask Shotty (phone approval)'].main[0].map((c) => c.node), ['Attach Approval ID']);
  assert.deepEqual(
    workflow.connections['Attach Approval ID'].main[0].map((c) => c.node),
    ['Exception File', 'Sheet: Exceptions'],
  );
  assert.deepEqual(workflow.connections['Sheet: Exceptions'].main[0].map((c) => c.node), ['Email: Approval Request']);
});

test('Attach Approval ID keeps the exception row and adds the approval id', () => {
  const workflow = readWorkflow();
  const code = getNode(workflow, 'Attach Approval ID').parameters.jsCode;
  const run = compile(code, ['$input', '$']);
  const out = run(
    { first: () => ({ json: { id: 'abc123', status: 'pending_approval' } }) },
    (name) => ({ first: () => ({ json: { intake_id: 'INTAKE-1', vendor: 'Northline', amount: 4200 } }) }),
  )[0].json;
  assert.equal(out.intake_id, 'INTAKE-1');
  assert.equal(out.vendor, 'Northline');
  assert.equal(out.shotty_approval_id, 'abc123');
  assert.equal(out.shotty_status, 'pending_approval');
});

// ---------------------------------------------------------------- decision webhook

test('the decision webhook workflow is generated with the real spreadsheet settings', () => {
  const main = readWorkflow();
  const decision = JSON.parse(readFileSync(DECISION_WORKFLOW_PATH, 'utf8'));
  const webhook = getNode(decision, 'Shotty decision');
  assert.equal(webhook.parameters.httpMethod, 'POST');
  assert.equal(webhook.parameters.path, 'shotty-decision');

  const approvedSheet = getNode(main, 'Sheet: Approved').parameters.documentId;
  assert.deepEqual(getNode(decision, 'Sheet: Approved').parameters.documentId, approvedSheet);
  assert.ok(getNode(decision, 'Sheet: Approved').credentials, 'credentials copied for import');

  assert.deepEqual(decision.connections['Shotty decision'].main[0].map((c) => c.node), ['Normalise Decision']);
  assert.deepEqual(decision.connections['Valid decision?'].main[0].map((c) => c.node), ['Approved?']);

  const approved = decision.connections['Approved?'].main;
  assert.deepEqual(approved[0].map((c) => c.node), ['Sheet: Approved', 'Sheet: Decision Log']);
  assert.deepEqual(approved[1].map((c) => c.node), ['Sheet: Decision Log']);
});

test('Normalise Decision turns Shotty callbacks into sheet rows and rejects garbage', () => {
  const decision = JSON.parse(readFileSync(DECISION_WORKFLOW_PATH, 'utf8'));
  const code = getNode(decision, 'Normalise Decision').parameters.jsCode;
  const run = compile(code, ['$json', '$input', '$']);

  const approve = run({
    body: {
      id: 'a'.repeat(64), run_id: 'INTAKE-1', tool: 'file_invoice_override', decision: 'approve', executed: true,
      decided_at: '2026-10-23T12:00:00.000Z',
      result: { filed: { vendor: 'Northline', amount: 4200, currency: 'CAD', category: 'electrical supplies', approved_limit: 2500, policy_override: true, override_reason: 'PO confirmed by owner', policy_reasons: ['4200 exceeds the approved limit of 2500'] } },
    },
  }, () => null, () => null)[0].json;
  assert.equal(approve.ok, true);
  assert.equal(approve.decision, 'approve');
  assert.equal(approve.queue, 'approved_override');
  assert.equal(approve.vendor, 'Northline');
  assert.equal(approve.policy_override, true);
  assert.equal(approve.override_reason, 'PO confirmed by owner');
  assert.match(approve.reason, /exceeds the approved limit/);

  const reject = run({ body: { id: 'x', decision: 'reject', executed: false } }, () => null, () => null)[0].json;
  assert.equal(reject.ok, true);
  assert.equal(reject.queue, 'rejected');

  const invalid = run({ body: { decision: 'maybe' } }, () => null, () => null)[0].json;
  assert.equal(invalid.ok, false);
  assert.equal(invalid.problems.length, 2);
});

// ---------------------------------------------------------------- reply reconciliation

test('the reply workflow reconciles with Shotty and suppresses its own callback', () => {
  const reply = JSON.parse(readFileSync(join(N8N_DIR, 'workflow_reply.json'), 'utf8'));
  const parse = getNode(reply, 'Parse Decision');
  assert.match(parse.parameters.jsCode, /shotty_approval_id: shottyApprovalId/);
  assert.match(parse.parameters.jsCode, /row\.shotty_approval_id/);

  const http = getNode(reply, 'Tell Shotty (reconcile)');
  assert.equal(http.type, 'n8n-nodes-base.httpRequest');
  assert.equal(http.parameters.method, 'POST');
  assert.match(http.parameters.url, /\/approve$/);
  assert.match(http.parameters.jsonBody, /suppress_callback: true/);
  assert.equal(http.parameters.headerParameters.parameters[0].value, 'REPLACE_WITH_BRIDGE_TOKEN');
  assert.equal(http.onError, 'continueRegularOutput', 'a Shotty outage must not block email handling');

  assert.deepEqual(reply.connections['Parse Decision'].main[0].map((c) => c.node), ['Has Shotty approval?']);
  assert.deepEqual(reply.connections['Has Shotty approval?'].main[0].map((c) => c.node), ['Tell Shotty (reconcile)']);
  assert.deepEqual(reply.connections['Has Shotty approval?'].main[1].map((c) => c.node), ['Conflict?']);
  assert.deepEqual(reply.connections['Already decided on phone?'].main[0].map((c) => c.node), ['No-op (already decided)']);
  assert.deepEqual(reply.connections['Already decided on phone?'].main[1].map((c) => c.node), ['Conflict?']);
  assert.deepEqual(reply.connections['No-op (already decided)'].main[0].map((c) => c.node), ['Gmail: Mark Processed']);
});

test('Parse Decision now carries shotty_approval_id and still decides the route', () => {
  const reply = JSON.parse(readFileSync(join(N8N_DIR, 'workflow_reply.json'), 'utf8'));
  const code = getNode(reply, 'Parse Decision').parameters.jsCode;
  const run = compile(code, ['$input', '$']);
  const row = { intake_id: 'INTAKE-1', shotty_approval_id: 'a'.repeat(64), vendor: 'Northline', amount: 4200 };
  const message = {
    id: 'msg-1',
    subject: 'Re: Approval needed: Northline - 4200 CAD (INTAKE-1)',
    text: 'APPROVE\n\n-- SIS',
    from: { value: [{ address: 'approver@example.com' }] },
    headers: {},
  };
  const out = run(
    { all: () => [{ json: row }] },
    (name) => ({ all: () => (name === 'Get Full Message' ? [{ json: message }] : []) }),
  );
  assert.equal(out[0].json.route, 'decide');
  assert.equal(out[0].json.decision, 'APPROVE');
  assert.equal(out[0].json.shotty_approval_id, row.shotty_approval_id);
});

test('Shotty Answer only no-ops a first decision that is already decided, never a conflict', () => {
  const reply = JSON.parse(readFileSync(join(N8N_DIR, 'workflow_reply.json'), 'utf8'));
  const code = getNode(reply, 'Shotty Answer').parameters.jsCode;
  const run = (parsed, res) => compile(code, ['$input', '$'])(
    { first: () => ({ json: res }) },
    () => ({ first: () => ({ json: parsed }) }),
  )[0].json;

  const dup = run({ route: 'decide', decision: 'APPROVE' }, { status: 'duplicate', previous: { decision: 'reject' } });
  assert.equal(dup.shotty_status, 'duplicate');
  assert.equal(dup.shotty_duplicate, true);
  assert.deepEqual(dup.shotty_previous, { decision: 'reject' });

  const conflict = run({ route: 'conflict', decision: 'REJECT' }, { status: 'duplicate' });
  assert.equal(conflict.shotty_duplicate, false, 'conflict routes keep their own n8n handling');

  const ok = run({ route: 'decide', decision: 'APPROVE' }, { status: 'executed', ok: true });
  assert.equal(ok.shotty_duplicate, false);

  const down = run({ route: 'decide', decision: 'APPROVE' }, { error: 'connect ECONNREFUSED' });
  assert.equal(down.shotty_status, 'unreachable');
  assert.equal(down.shotty_duplicate, false, 'a Shotty outage falls back to the email path');
});

// ---------------------------------------------------------------- research + reconciliation

test('research exceptions become phone approvals with APPROVE / REPLACE / DROP', () => {
  const workflow = JSON.parse(readFileSync(RESEARCH_WORKFLOW_PATH, 'utf8'));
  assert.equal(workflow.id, 'LhneA6p51Vzr51dg', 'import must update the live workflow, not duplicate it');

  const http = getNode(workflow, 'Ask Shotty (research)');
  assert.equal(http.parameters.url, 'http://127.0.0.1:8787/api/approvals');
  assert.equal(http.parameters.headerParameters.parameters[0].value, 'REPLACE_WITH_BRIDGE_TOKEN');
  assert.match(http.parameters.jsonBody, /execute: false/);
  assert.match(http.parameters.jsonBody, /id: 'replace'/);
  assert.match(http.parameters.jsonBody, /id: 'drop'/);
  assert.match(http.parameters.jsonBody, /shotty-research-decision/);
  assert.match(http.parameters.jsonBody, /exception_id/);

  assert.deepEqual(workflow.connections['Append Exceptions'].main[0].map((c) => c.node), ['Ask Shotty (research)']);
  assert.deepEqual(workflow.connections['Ask Shotty (research)'].main[0].map((c) => c.node), ['Attach Research Approval']);
  assert.deepEqual(workflow.connections['Attach Research Approval'].main[0].map((c) => c.node), ['Pending Decisions']);
  assert.match(getNode(workflow, 'Pending Decisions').parameters.jsCode, /shotty_approval_id/);

  const attach = compile(getNode(workflow, 'Attach Research Approval').parameters.jsCode, ['$input', '$']);
  const out = attach(
    { all: () => [{ json: { id: 'abc', status: 'pending_approval' } }] },
    (name) => ({ all: () => (name === 'Append Exceptions' ? [{ json: { id: 'R-1', company: 'Acme', defects: 'dead_source' } }] : []) }),
  )[0].json;
  assert.equal(out.id, 'R-1');
  assert.equal(out.shotty_approval_id, 'abc');
});

test('reconciliation discrepancies above materiality become ACCEPT / DISPUTE approvals', () => {
  const workflow = JSON.parse(readFileSync(RECONCILIATION_WORKFLOW_PATH, 'utf8'));
  assert.equal(workflow.id, 'uFUFNSljvxnQ1xXC');

  const http = getNode(workflow, 'Ask Shotty (reconciliation)');
  assert.match(http.parameters.jsonBody, /execute: false/);
  assert.match(http.parameters.jsonBody, /id: 'accept'/);
  assert.match(http.parameters.jsonBody, /id: 'dispute'/);
  assert.match(http.parameters.jsonBody, /shotty-reconciliation-decision/);

  assert.deepEqual(workflow.connections['Append Discrepancies'].main[0].map((c) => c.node), ['Only Material']);
  assert.deepEqual(workflow.connections['Only Material'].main[0].map((c) => c.node), ['Ask Shotty (reconciliation)']);
  assert.deepEqual(workflow.connections['Attach Reconciliation Approval'].main[0].map((c) => c.node), ['Pending Signoffs']);
  assert.match(getNode(workflow, 'Pending Signoffs').parameters.jsCode, /shotty_approval_id/);

  const filter = compile(getNode(workflow, 'Only Material').parameters.jsCode, ['$input', '$']);
  const kept = filter(
    { all: () => [{ json: { amount_impact: 1200 } }, { json: { amount_impact: 50 } }] },
    () => ({ first: () => ({ json: { summary: { materiality: 500 } } }) }),
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].json.amount_impact, 1200);
});

test('the research decision webhook turns a phone choice into a Decisions row', () => {
  const workflow = JSON.parse(readFileSync(RESEARCH_DECISION_PATH, 'utf8'));
  assert.equal(getNode(workflow, 'Shotty decision').parameters.path, 'shotty-research-decision');
  assert.equal(getNode(workflow, 'Sheet: Decisions').parameters.sheetName.value, 'Decisions');

  const run = (body) => compile(getNode(workflow, 'Normalise Decision').parameters.jsCode, ['$json', '$input', '$'])({ body }, () => null, () => null)[0].json;

  const replaced = run({
    id: 'a'.repeat(64), decision: 'replace', decided_at: '2026-10-26T13:00:00.000Z',
    payload: { exception_id: 'R-7', batch_id: 'RB-123', type: 'research' },
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.decision, 'replace');
  assert.equal(replaced.exception_id, 'R-7');
  assert.equal(replaced.batch_id, 'RB-123');
  assert.equal(replaced.reviewer, 'phone');
  assert.equal(replaced.shotty_approval_id, 'a'.repeat(64));

  const invalid = run({ id: 'x', decision: 'bogus', payload: {} });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.problems.some((p) => /exception_id/.test(p)));
  assert.ok(invalid.problems.some((p) => /approve\|replace\|drop/.test(p)));
});

test('the reconciliation decision webhook turns ACCEPT / DISPUTE into a Signoffs row', () => {
  const workflow = JSON.parse(readFileSync(RECONCILIATION_DECISION_PATH, 'utf8'));
  assert.equal(getNode(workflow, 'Shotty decision').parameters.path, 'shotty-reconciliation-decision');
  assert.equal(getNode(workflow, 'Sheet: Signoffs').parameters.sheetName.value, 'Signoffs');

  const run = (body) => compile(getNode(workflow, 'Normalise Decision').parameters.jsCode, ['$json', '$input', '$'])({ body }, () => null, () => null)[0].json;
  const accepted = run({
    id: 'b'.repeat(64), decision: 'accept',
    payload: { run_id: 'REC-1', ref: 'INV-42', type: 'amount_mismatch' },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.decision, 'accept');
  assert.equal(accepted.ref, 'INV-42');
  assert.equal(accepted.discrepancy, 'amount_mismatch');
  assert.equal(accepted.approver, 'phone');

  const invalid = run({ decision: 'approve', payload: { ref: 'INV-42' } });
  assert.equal(invalid.ok, false);
});

test('buildDecisionWorkflow is deterministic', () => {
  const built = buildDecisionWorkflow(readWorkflow());
  assert.equal(serialize(built), serialize(buildDecisionWorkflow(buildWorkflow(readWorkflow()))));
});
