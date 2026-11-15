#!/usr/bin/env node
/**
 * Generate the invoice Code nodes in n8n_demo/workflow.json from bridge/engine.js.
 *
 * The problem this solves: an n8n Code node cannot import Shotty's modules, so "porting the
 * engine into the node logic" would normally mean a second copy that drifts. Instead the
 * portable region of engine.js is inlined into three Code nodes by this script, and the
 * n8n demo's own harness (`n8n_demo/tools/test_guard.js`) keeps executing the shipped text.
 *
 *   node scripts/build-n8n-code.js           # regenerate workflow.json
 *   node scripts/build-n8n-code.js --check   # exit 1 if the workflow is stale (used by tests)
 *
 * The generated wrappers only translate n8n's `$input` / `$json` / `$()` globals into the
 * engine's plain arguments. All decision logic lives in engine.js.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const BRIDGE = join(here, '..');
export const N8N_DIR = join(BRIDGE, 'n8n_demo');
export const ENGINE_PATH = join(BRIDGE, 'engine.js');
export const WORKFLOW_PATH = join(N8N_DIR, 'workflow.json');
export const DECISION_WORKFLOW_PATH = join(N8N_DIR, 'workflow_shotty_decision.json');
export const REPLY_WORKFLOW_PATH = join(N8N_DIR, 'workflow_reply.json');
export const RESEARCH_WORKFLOW_PATH = join(N8N_DIR, 'workflow_research.json');
export const RECONCILIATION_WORKFLOW_PATH = join(N8N_DIR, 'workflow_reconciliation.json');
export const RESEARCH_DECISION_PATH = join(N8N_DIR, 'workflow_shotty_research_decision.json');
export const RECONCILIATION_DECISION_PATH = join(N8N_DIR, 'workflow_shotty_reconciliation_decision.json');

const clone = (value) => JSON.parse(JSON.stringify(value));

function approvalHttpNode({ name, id, position, jsonBody }) {
  return {
    parameters: {
      method: 'POST',
      url: 'http://127.0.0.1:8787/api/approvals',
      authentication: 'none',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'x-bridge-token', value: 'REPLACE_WITH_BRIDGE_TOKEN' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody,
      options: { timeout: 15000 },
    },
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    onError: 'continueRegularOutput',
    retryOnFail: false,
  };
}

function upsert(nodes, template) {
  const existing = nodes.find((n) => n.name === template.name);
  const fresh = clone(template);
  if (existing) Object.assign(existing, fresh);
  else nodes.push(fresh);
  return nodes.find((n) => n.name === template.name);
}

const researchBody =
  "={{ JSON.stringify({ run_id: 'research:' + $json.id, execute: false, "
  + "title: 'Research row ' + $json.id + ' — ' + ($json.defects || 'exception'), "
  + "actions: [ { id: 'approve', label: 'Approve' }, { id: 'replace', label: 'Replace' }, { id: 'drop', label: 'Drop' } ], "
  + "fields: [ { label: 'Row', value: $json.id }, { label: 'Company', value: $json.company }, { label: 'Defects', value: $json.defects }, { label: 'Source', value: $json.source_url } ], "
  + "payload: { exception_id: $json.id, batch_id: $('Prepare Batch').first().json.batch_id }, "
  + "callback_url: 'http://127.0.0.1:5678/webhook/shotty-research-decision' }) }}";

const reconciliationBody =
  "={{ JSON.stringify({ run_id: 'recon:' + $json.run_id + ':' + $json.ref, execute: false, "
  + "title: 'Discrepancy ' + $json.ref + ' — ' + $json.type, "
  + "actions: [ { id: 'accept', label: 'Accept' }, { id: 'dispute', label: 'Dispute' } ], "
  + "fields: [ { label: 'Ref', value: $json.ref }, { label: 'Type', value: $json.type }, { label: 'Amount impact', value: $json.amount_impact }, { label: 'Run', value: $json.run_id } ], "
  + "payload: { run_id: $json.run_id, ref: $json.ref, type: $json.type, amount_impact: $json.amount_impact }, "
  + "callback_url: 'http://127.0.0.1:5678/webhook/shotty-reconciliation-decision' }) }}";

/** Research exceptions become phone decisions (APPROVE / REPLACE / DROP). */
export function buildResearchWorkflow(workflow) {
  const next = clone(workflow);
  next.id = 'LhneA6p51Vzr51dg'; // live workflow id, so an import updates instead of duplicating
  const nodes = next.nodes;
  const attach = {
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Keep the exception row and attach the Shotty approval id.
const rows = $('Append Exceptions').all();
const responses = $input.all();
return rows.map((row, i) => ({
  json: {
    ...row.json,
    shotty_approval_id: responses[i] && responses[i].json ? responses[i].json.id : null,
    shotty_status: responses[i] && responses[i].json ? responses[i].json.status : 'unknown',
  },
}));`,
    },
    id: 'a1b2c3d4-0000-4000-8000-000000000032',
    name: 'Attach Research Approval',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [520, 560],
  };

  upsert(nodes, approvalHttpNode({
    name: 'Ask Shotty (research)',
    id: 'a1b2c3d4-0000-4000-8000-000000000031',
    position: [300, 560],
    jsonBody: researchBody,
  }));
  upsert(nodes, attach);

  const pending = nodes.find((n) => n.name === 'Pending Decisions');
  if (!pending) throw new Error('research workflow is missing Pending Decisions');
  pending.parameters.jsCode = `// A pending decision row is still written for the audit trail; the phone approval id
// lets the decision webhook append the signed outcome against the same exception.
const batch = $('Prepare Batch').first().json.batch_id;
return $input.all().map((i) => ({
  json: {
    batch_id: batch,
    exception_id: i.json.id,
    decision: 'pending',
    reviewer: '',
    decided_at: '',
    note: 'awaiting reviewer',
    shotty_approval_id: i.json.shotty_approval_id || '',
  },
}));`;

  next.connections['Append Exceptions'] = { main: [[{ node: 'Ask Shotty (research)', type: 'main', index: 0 }]] };
  next.connections['Ask Shotty (research)'] = { main: [[{ node: 'Attach Research Approval', type: 'main', index: 0 }]] };
  next.connections['Attach Research Approval'] = { main: [[{ node: 'Pending Decisions', type: 'main', index: 0 }]] };
  return next;
}

/** Reconciliation discrepancies above materiality become phone decisions (ACCEPT / DISPUTE). */
export function buildReconciliationWorkflow(workflow) {
  const next = clone(workflow);
  next.id = 'uFUFNSljvxnQ1xXC';
  const nodes = next.nodes;

  const material = {
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Only discrepancies above materiality need a human sign-off; ask the phone for those.
const materiality = Number($('Match and Check').first().json.summary.materiality);
return $input.all().filter((i) => Number(i.json.amount_impact) >= materiality);`,
    },
    id: 'a1b2c3d4-0000-4000-8000-000000000034',
    name: 'Only Material',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [300, 760],
  };
  const attach = {
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Keep the discrepancy and attach the Shotty approval id.
const rows = $('Only Material').all();
const responses = $input.all();
return rows.map((row, i) => ({
  json: {
    ...row.json,
    shotty_approval_id: responses[i] && responses[i].json ? responses[i].json.id : null,
    shotty_status: responses[i] && responses[i].json ? responses[i].json.status : 'unknown',
  },
}));`,
    },
    id: 'a1b2c3d4-0000-4000-8000-000000000036',
    name: 'Attach Reconciliation Approval',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [740, 760],
  };

  upsert(nodes, material);
  upsert(nodes, approvalHttpNode({
    name: 'Ask Shotty (reconciliation)',
    id: 'a1b2c3d4-0000-4000-8000-000000000035',
    position: [520, 760],
    jsonBody: reconciliationBody,
  }));
  upsert(nodes, attach);

  const signoffs = nodes.find((n) => n.name === 'Pending Signoffs');
  if (!signoffs) throw new Error('reconciliation workflow is missing Pending Signoffs');
  signoffs.parameters.jsCode = `// Pending sign-off row per material discrepancy, carrying the phone approval id.
const run = $('Match and Check').first().json.summary;
return $input.all().filter((i) => i.json.amount_impact >= run.materiality).map((i) => ({
  json: {
    run_id: i.json.run_id,
    ref: i.json.ref,
    discrepancy: i.json.type,
    decision: 'pending',
    approver: '',
    decided_at: '',
    note: 'waiting for sign-off',
    shotty_approval_id: i.json.shotty_approval_id || '',
  },
}));`;

  next.connections['Append Discrepancies'] = { main: [[{ node: 'Only Material', type: 'main', index: 0 }]] };
  next.connections['Only Material'] = { main: [[{ node: 'Ask Shotty (reconciliation)', type: 'main', index: 0 }]] };
  next.connections['Ask Shotty (reconciliation)'] = { main: [[{ node: 'Attach Reconciliation Approval', type: 'main', index: 0 }]] };
  next.connections['Attach Reconciliation Approval'] = { main: [[{ node: 'Pending Signoffs', type: 'main', index: 0 }]] };
  return next;
}

function decisionWorkflow({ id, name, path, normaliseCode, sheetNode, sheetLabel }) {
  return {
    id,
    name,
    nodes: [
      {
        parameters: { httpMethod: 'POST', path, responseMode: 'onReceived', options: {} },
        id: `${id}-webhook`,
        name: 'Shotty decision',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [-220, 160],
        webhookId: path,
      },
      {
        parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: normaliseCode },
        id: `${id}-normalise`,
        name: 'Normalise Decision',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [-20, 160],
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: `${id}-if`, leftValue: '={{ $json.ok }}', rightValue: true, operator: { type: 'boolean', operation: 'equals' } }],
            combinator: 'and',
          },
          options: {},
        },
        id: `${id}-valid`,
        name: 'Valid decision?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2.2,
        position: [200, 160],
      },
      {
        parameters: {
          operation: 'append',
          documentId: clone(sheetNode.parameters.documentId),
          sheetName: clone(sheetNode.parameters.sheetName),
          dataMode: 'autoMapInputData',
          columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
          options: { handlingExtraData: 'ignoreIt' },
        },
        id: `${id}-sheet`,
        name: `Sheet: ${sheetLabel}`,
        type: sheetNode.type,
        typeVersion: sheetNode.typeVersion,
        position: [440, 160],
        credentials: clone(sheetNode.credentials),
      },
      {
        parameters: {},
        id: `${id}-noop`,
        name: 'Ignore invalid decision',
        type: 'n8n-nodes-base.noOp',
        typeVersion: 1,
        position: [440, 340],
      },
    ],
    connections: {
      'Shotty decision': { main: [[{ node: 'Normalise Decision', type: 'main', index: 0 }]] },
      'Normalise Decision': { main: [[{ node: 'Valid decision?', type: 'main', index: 0 }]] },
      'Valid decision?': {
        main: [
          [{ node: `Sheet: ${sheetLabel}`, type: 'main', index: 0 }],
          [{ node: 'Ignore invalid decision', type: 'main', index: 0 }],
        ],
      },
    },
    active: false,
    settings: { executionOrder: 'v1' },
    pinData: {},
    meta: {},
    tags: [],
  };
}

const researchNormalise = `// Shotty research callback. The payload carries the exception and batch ids.
const p = ($json && $json.body && typeof $json.body === 'object') ? $json.body : $json;
const payload = p.payload && typeof p.payload === 'object' ? p.payload : {};
const allowed = ['approve', 'replace', 'drop'];
const decision = String(p.decision ?? '').toLowerCase();
const problems = [];
if (!allowed.includes(decision)) problems.push('decision must be approve|replace|drop');
if (!payload.exception_id) problems.push('missing exception_id');
return [{
  json: {
    ok: problems.length === 0,
    batch_id: payload.batch_id ?? '',
    exception_id: payload.exception_id ?? '',
    decision,
    reviewer: 'phone',
    decided_at: p.decided_at ?? new Date().toISOString(),
    note: "decided on the owner's phone",
    shotty_approval_id: String(p.id ?? ''),
    problems,
  },
}];`;

const reconciliationNormalise = `// Shotty reconciliation callback. The payload carries the run and finding reference.
const p = ($json && $json.body && typeof $json.body === 'object') ? $json.body : $json;
const payload = p.payload && typeof p.payload === 'object' ? p.payload : {};
const allowed = ['accept', 'dispute'];
const decision = String(p.decision ?? '').toLowerCase();
const problems = [];
if (!allowed.includes(decision)) problems.push('decision must be accept|dispute');
if (!payload.ref) problems.push('missing ref');
return [{
  json: {
    ok: problems.length === 0,
    run_id: payload.run_id ?? '',
    ref: payload.ref ?? '',
    discrepancy: payload.type ?? '',
    decision,
    approver: 'phone',
    decided_at: p.decided_at ?? new Date().toISOString(),
    note: "decided on the owner's phone",
    shotty_approval_id: String(p.id ?? ''),
    problems,
  },
}];`;

export function buildResearchDecisionWorkflow(researchWorkflow) {
  const sheetNode = (researchWorkflow.nodes ?? []).find((n) => n.name === 'Append Decisions');
  if (!sheetNode) throw new Error('research workflow has no Append Decisions node');
  return decisionWorkflow({
    id: 'shotty-research-decision',
    name: 'Shotty research decision webhook',
    path: 'shotty-research-decision',
    normaliseCode: researchNormalise,
    sheetNode,
    sheetLabel: 'Decisions',
  });
}

export function buildReconciliationDecisionWorkflow(reconciliationWorkflow) {
  const sheetNode = (reconciliationWorkflow.nodes ?? []).find((n) => n.name === 'Append Signoffs');
  if (!sheetNode) throw new Error('reconciliation workflow has no Append Signoffs node');
  return decisionWorkflow({
    id: 'shotty-reconciliation-decision',
    name: 'Shotty reconciliation decision webhook',
    path: 'shotty-reconciliation-decision',
    normaliseCode: reconciliationNormalise,
    sheetNode,
    sheetLabel: 'Signoffs',
  });
}


const START = '// #region portable-invoice';
const END = '// #endregion portable-invoice';

/** Extract the dependency-free invoice functions. Throws if the region gains an import/IO. */
export function extractPortable(source = readFileSync(ENGINE_PATH, 'utf8')) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('engine.js is missing the portable-invoice markers');
  }
  const startOfBody = source.indexOf('\n', start) + 1;
  const body = source.slice(startOfBody, end).trim().replace(/^export /gm, '');
  if (/\bimport\s|\bcreateHash\b|\brequire\(|\bfetch\(|\bprocess\./.test(body)) {
    throw new Error('portable-invoice region must stay dependency-free (found import/createHash/fetch/process)');
  }
  return body;
}

const HEADER = '// GENERATED from bridge/engine.js — do not edit by hand. Regenerate: node scripts/build-n8n-code.js';

const WRAPPERS = {
  'Normalise Intake': (portable) => `${HEADER}
${portable}

// --- n8n wrapper: Normalise Intake ---
const input = $input.first().json;
const invoice = normaliseInvoice(input);
return [{
  json: {
    intake_id: 'INTAKE-' + Date.now().toString(36).toUpperCase(),
    source: String(input.source ?? 'form'),
    vendor: invoice.vendor,
    amount: invoice.amount,
    currency: invoice.currency,
    invoice_ref: invoice.invoice_ref,
    notes: invoice.notes,
    received_at: new Date().toISOString(),
    intake_problems: invoice.problems,
  },
}];`,

  'Lookup Vendor Policy': (portable) => `${HEADER}
${portable}

// --- n8n wrapper: Lookup Vendor Policy ---
const item = $json;
const config = item.config && typeof item.config === 'object' ? item.config : {};
const policy = matchVendorPolicy(item, config.vendors || []);
return [{ json: { ...item, policy } }];`,

  'Parse and Validate': (portable) => `${HEADER}
${portable}

// --- n8n wrapper: Parse and Validate ---
const raw = $input.first().json;
const upstream = $('Lookup Vendor Policy').first().json;
const cfg = ($('Attach Config').first().json || {}).config || {};
const result = adjudicateInvoice({
  output: raw.output,
  policy: upstream.policy,
  confidenceFloor: cfg.confidence_floor,
  intakeId: upstream.intake_id ?? '',
});
return [{ json: result }];`,
};

const SHOTTY_HTTP_NODE = 'Ask Shotty (phone approval)';
const SHOTTY_MERGE_NODE = 'Attach Approval ID';

const HTTP_NODE = {
  parameters: {
    method: 'POST',
    url: 'http://127.0.0.1:8787/api/approvals',
    authentication: 'none',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'x-bridge-token', value: 'REPLACE_WITH_BRIDGE_TOKEN' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      "={{ JSON.stringify({ run_id: $json.intake_id, tool: 'file_invoice_override', "
      + 'payload: { invoice: { vendor: $json.vendor, amount: $json.amount, currency: $json.currency, '
      + "invoice_ref: $json.invoice_ref }, reason: $json.reason }, "
      + "callback_url: 'http://127.0.0.1:5678/webhook/shotty-decision', "
      + "title: $json.vendor + ' — ' + $json.amount + ' ' + $json.currency, "
      + "fields: [ "
      + "{ label: 'Vendor', value: $json.vendor }, "
      + "{ label: 'Amount', value: $json.amount + ' ' + $json.currency }, "
      + "{ label: 'Approved limit', value: $json.approved_limit === null ? 'no approved-supplier record' : String($json.approved_limit) }, "
      + "{ label: 'Why held', value: $json.reason } ] }) }}",
    options: { timeout: 15000 },
  },
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  name: SHOTTY_HTTP_NODE,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [240, 620],
};

const MERGE_CODE = `// Keep the exception row and add the Shotty approval id, so the decision
// webhook can be tied back to the right row. This node exists because an
// HTTP Request node replaces its input with the response.
const rec = $('Exception Record').first().json;
const res = $input.first().json;
return [{ json: { ...rec, shotty_approval_id: res.id ?? null, shotty_status: res.status ?? 'unknown' } }];`;

const MERGE_NODE = {
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: MERGE_CODE },
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  name: SHOTTY_MERGE_NODE,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [460, 620],
};

/** Insert the two Shotty nodes and rewire the exception branch. Idempotent. */
function applyShottyWiring(workflow) {
  const nodes = workflow.nodes ?? [];
  // Upsert: an existing generated node must be refreshed when its template changes, not left
  // stale. This is what lets the invoice card gain readable fields on a rebuild.
  for (const template of [HTTP_NODE, MERGE_NODE]) {
    const existing = nodes.find((n) => n.name === template.name);
    const fresh = JSON.parse(JSON.stringify(template));
    if (existing) Object.assign(existing, fresh);
    else nodes.push(fresh);
  }

  const byName = new Map(nodes.map((n) => [n.name, n]));
  for (const name of ['Exception Record', 'Exception File', 'Sheet: Exceptions']) {
    if (!byName.has(name)) throw new Error(`workflow is missing node: ${name}`);
  }
  byName.get('Exception File').position = [680, 700];
  byName.get('Sheet: Exceptions').position = [680, 620];

  const conn = workflow.connections ?? (workflow.connections = {});
  conn['Exception Record'] = { main: [[{ node: SHOTTY_HTTP_NODE, type: 'main', index: 0 }]] };
  conn[SHOTTY_HTTP_NODE] = { main: [[{ node: SHOTTY_MERGE_NODE, type: 'main', index: 0 }]] };
  conn[SHOTTY_MERGE_NODE] = {
    main: [[
      { node: 'Exception File', type: 'main', index: 0 },
      { node: 'Sheet: Exceptions', type: 'main', index: 0 },
    ]],
  };
  return workflow;
}

/** Return a new workflow object with the Code nodes regenerated and Shotty wired in. */
export function buildWorkflow(workflow, engineSource = readFileSync(ENGINE_PATH, 'utf8')) {
  const portable = extractPortable(engineSource);
  const next = applyShottyWiring(JSON.parse(JSON.stringify(workflow)));
  const generated = new Set();
  for (const node of next.nodes ?? []) {
    const make = WRAPPERS[node.name];
    if (!make) continue;
    if (!node.parameters || typeof node.parameters !== 'object') node.parameters = {};
    node.parameters.jsCode = make(portable);
    generated.add(node.name);
  }
  const missing = Object.keys(WRAPPERS).filter((name) => !generated.has(name));
  if (missing.length) throw new Error(`workflow is missing Code nodes: ${missing.join(', ')}`);
  return next;
}

export function serialize(workflow) {
  return JSON.stringify(workflow, null, 2) + '\n';
}

/**
 * The decision webhook n8n receives from Shotty's `callback_url`. Kept as its own workflow so
 * the phone loop is not entangled with the Gmail reply loop. It records every decision and
 * appends the approved exception to the `Approved` tab, using the same spreadsheet and
 * credential as the main workflow.
 */
export function buildDecisionWorkflow(mainWorkflow) {
  const sheetsNode = (mainWorkflow.nodes ?? []).find((n) => n.name === 'Sheet: Approved');
  if (!sheetsNode) throw new Error('main workflow has no Sheet: Approved node to copy settings from');
  const documentId = sheetsNode.parameters.documentId;
  const credentials = sheetsNode.credentials;

  const NORMALISE = `// The webhook body is Shotty's callback payload (see bridge/approvals.js).
const p = ($json && $json.body && typeof $json.body === 'object') ? $json.body : $json;
const problems = [];
const id = String(p.id ?? '');
const decision = String(p.decision ?? '').toLowerCase();
if (!id) problems.push('missing approval id');
if (!['approve', 'reject'].includes(decision)) problems.push('decision must be approve|reject');
const filed = p.result && typeof p.result === 'object' && p.result.filed ? p.result.filed : null;
return [{
  json: {
    approval_id: id,
    run_id: p.run_id ?? '',
    tool: p.tool ?? '',
    decision,
    executed: p.executed === true,
    decided_at: p.decided_at ?? new Date().toISOString(),
    queue: decision === 'approve' ? 'approved_override' : 'rejected',
    intake_id: p.run_id ?? '',
    vendor: filed ? filed.vendor : '',
    amount: filed ? filed.amount : null,
    currency: filed ? filed.currency : '',
    category: filed ? filed.category : '',
    approved_limit: filed ? filed.approved_limit : null,
    policy_override: filed ? filed.policy_override === true : false,
    override_reason: filed ? filed.override_reason : '',
    reason: filed && Array.isArray(filed.policy_reasons) ? filed.policy_reasons.join('; ') : '',
    problems,
    ok: problems.length === 0,
  },
}];`;

  const sheet = (name, sheetName, position) => ({
    parameters: {
      operation: 'append',
      documentId,
      sheetName: { __rl: true, value: sheetName, mode: 'name' },
      dataMode: 'autoMapInputData',
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false },
      options: { handlingExtraData: 'ignoreIt' },
    },
    id: `a1b2c3d4-0000-4000-8000-0000000000${name === 'Approved' ? '11' : '12'}`,
    name: `Sheet: ${name}`,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position,
    credentials,
  });

  return {
    id: 'shotty-decision-webhook',
    name: 'Shotty decision webhook',
    nodes: [
      {
        parameters: { httpMethod: 'POST', path: 'shotty-decision', responseMode: 'onReceived', options: {} },
        id: 'a1b2c3d4-0000-4000-8000-000000000003',
        name: 'Shotty decision',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [-260, 160],
        webhookId: 'shotty-decision',
      },
      {
        parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: NORMALISE },
        id: 'a1b2c3d4-0000-4000-8000-000000000004',
        name: 'Normalise Decision',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [-40, 160],
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: 'a1b2c3d4-0000-4000-8000-000000000005', leftValue: '={{ $json.ok }}', rightValue: true, operator: { type: 'boolean', operation: 'equals' } }],
            combinator: 'and',
          },
          options: {},
        },
        id: 'a1b2c3d4-0000-4000-8000-000000000006',
        name: 'Valid decision?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2.2,
        position: [180, 160],
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: 'a1b2c3d4-0000-4000-8000-000000000007', leftValue: '={{ $json.decision }}', rightValue: 'approve', operator: { type: 'string', operation: 'equals' } }],
            combinator: 'and',
          },
          options: {},
        },
        id: 'a1b2c3d4-0000-4000-8000-000000000008',
        name: 'Approved?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2.2,
        position: [400, 160],
      },
      sheet('Approved', 'Approved', [640, 40]),
      sheet('Decision Log', 'Decisions', [640, 280]),
      {
        parameters: {},
        id: 'a1b2c3d4-0000-4000-8000-000000000009',
        name: 'Ignore invalid decision',
        type: 'n8n-nodes-base.noOp',
        typeVersion: 1,
        position: [400, 400],
      },
    ],
    connections: {
      'Shotty decision': { main: [[{ node: 'Normalise Decision', type: 'main', index: 0 }]] },
      'Normalise Decision': { main: [[{ node: 'Valid decision?', type: 'main', index: 0 }]] },
      'Valid decision?': {
        main: [
          [{ node: 'Approved?', type: 'main', index: 0 }],
          [{ node: 'Ignore invalid decision', type: 'main', index: 0 }],
        ],
      },
      'Approved?': {
        main: [
          [
            { node: 'Sheet: Approved', type: 'main', index: 0 },
            { node: 'Sheet: Decision Log', type: 'main', index: 0 },
          ],
          [{ node: 'Sheet: Decision Log', type: 'main', index: 0 }],
        ],
      },
    },
    active: false,
    settings: { executionOrder: 'v1' },
    pinData: {},
    meta: {},
    tags: [],
  };
}

/**
 * Reconcile the Gmail reply loop with Shotty.
 *
 * When a decision arrives by email, n8n owns the Sheet write. The reply workflow therefore
 * calls Shotty's `/approve` with `suppress_callback: true` so Shotty records the same decision
 * in its ledger and executes its side once, WITHOUT firing the phone webhook (which would
 * append the same invoice to the Sheet a second time).
 *
 * If Shotty answers `duplicate` on a first-decision route, the phone already decided: the
 * callback already wrote the Sheet, so this reply is logged as processed and no second write
 * happens. Conflict/agree routes keep their existing n8n behaviour.
 *
 * Idempotent: running the build twice changes nothing; `--check` fails if this file drifts.
 */
export function buildReplyWorkflow(workflow) {
  const next = JSON.parse(JSON.stringify(workflow));
  const parse = next.nodes.find((n) => n.name === 'Parse Decision');
  if (!parse) throw new Error('reply workflow is missing Parse Decision');

  // 1. Carry the Shotty approval id from the Exceptions row into the parse output.
  if (!parse.parameters.jsCode.includes('shottyApprovalId')) {
    const noticeAnchor = "  const noticeTo = unique([prior && prior.decided_by, responderKey, ADMIN]).join(', ');";
    if (!parse.parameters.jsCode.includes(noticeAnchor)) {
      throw new Error('Parse Decision changed: cannot find the shipping anchor for shotty_approval_id');
    }
    parse.parameters.jsCode = parse.parameters.jsCode.replace(
      noticeAnchor,
      `${noticeAnchor}\n  const shottyApprovalId = row ? String(row.shotty_approval_id || '') : '';`,
    );
    const outputAnchor = '      decided_at: now,';
    if (!parse.parameters.jsCode.includes(outputAnchor)) {
      throw new Error('Parse Decision changed: cannot find the decided_at anchor');
    }
    parse.parameters.jsCode = parse.parameters.jsCode.replace(
      outputAnchor,
      `${outputAnchor}\n      shotty_approval_id: shottyApprovalId,`,
    );
  }

  const nodes = next.nodes;
  const has = (name) => nodes.some((n) => n.name === name);
  const ifNode = (name, conditions, id, position) => ({
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions, combinator: 'and' },
      options: {},
    },
    id, name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position,
  });

  const hasShotty = ifNode('Has Shotty approval?', [
    { id: 'a1b2c3d4-0000-4000-8000-000000000021', leftValue: '={{ $json.shotty_approval_id }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
    { id: 'a1b2c3d4-0000-4000-8000-000000000022', leftValue: '={{ $json.decision }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
  ], 'a1b2c3d4-0000-4000-8000-000000000023', [420, 120]);

  const tellShotty = {
    parameters: {
      method: 'POST',
      url: 'http://127.0.0.1:8787/approve',
      authentication: 'none',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'x-bridge-token', value: 'REPLACE_WITH_BRIDGE_TOKEN' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ id: $json.shotty_approval_id, decision: String($json.decision).toLowerCase(), suppress_callback: true }) }}",
      options: { timeout: 10000 },
    },
    id: 'a1b2c3d4-0000-4000-8000-000000000024',
    name: 'Tell Shotty (reconcile)',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [640, 20],
    onError: 'continueRegularOutput',
    retryOnFail: false,
  };

  const mergeCode = `// Recover the parsed decision (the HTTP node replaces its input with the response) and
const parsed = $('Parse Decision').first().json;
const res = $input.first().json;
const unreachable = !res || (res.error && !res.status);
const status = unreachable ? 'unreachable' : String(res.status ?? 'unknown');
// Only a first-decision reply that hits an existing decision is a no-op. Conflict/agree
// routes must still run their own n8n handling.
const duplicate = status === 'duplicate' && parsed.route === 'decide';
return [{
  json: {
    ...parsed,
    shotty_status: status,
    shotty_duplicate: duplicate,
    shotty_previous: res.previous ?? null,
    shotty_error: unreachable ? (res.error ?? 'unreachable') : null,
  },
}];`;
  const merge = {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: mergeCode },
    id: 'a1b2c3d4-0000-4000-8000-000000000025',
    name: 'Shotty Answer',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [860, 20],
  };

  const already = ifNode('Already decided on phone?', [
    { id: 'a1b2c3d4-0000-4000-8000-000000000026', leftValue: '={{ $json.shotty_duplicate }}', rightValue: true, operator: { type: 'boolean', operation: 'equals' } },
  ], 'a1b2c3d4-0000-4000-8000-000000000027', [1080, 20]);

  const noop = {
    parameters: {},
    id: 'a1b2c3d4-0000-4000-8000-000000000028',
    name: 'No-op (already decided)',
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position: [1300, 120],
  };

  for (const node of [hasShotty, tellShotty, merge, already, noop]) {
    if (!has(node.name)) nodes.push(node);
  }

  // 2. Rewire Parse Decision into the reconciliation branch.
  const conn = next.connections ?? (next.connections = {});
  conn['Parse Decision'] = { main: [[{ node: 'Has Shotty approval?', type: 'main', index: 0 }]] };
  conn['Has Shotty approval?'] = {
    main: [
      [{ node: 'Tell Shotty (reconcile)', type: 'main', index: 0 }],
      [{ node: 'Conflict?', type: 'main', index: 0 }],
    ],
  };
  conn['Tell Shotty (reconcile)'] = { main: [[{ node: 'Shotty Answer', type: 'main', index: 0 }]] };
  conn['Shotty Answer'] = {
    main: [[{ node: 'Already decided on phone?', type: 'main', index: 0 }]],
  };
  conn['Already decided on phone?'] = {
    main: [
      [{ node: 'No-op (already decided)', type: 'main', index: 0 }],
      [{ node: 'Conflict?', type: 'main', index: 0 }],
    ],
  };
  conn['No-op (already decided)'] = { main: [[{ node: 'Gmail: Mark Processed', type: 'main', index: 0 }]] };
  return next;
}

function main() {
  const check = process.argv.includes('--check');
  const currentText = readFileSync(WORKFLOW_PATH, 'utf8');
  const nextWorkflow = buildWorkflow(JSON.parse(currentText));
  const nextText = serialize(nextWorkflow);
  const decisionText = serialize(buildDecisionWorkflow(nextWorkflow));
  const replyCurrent = (() => { try { return readFileSync(REPLY_WORKFLOW_PATH, 'utf8'); } catch { return null; } })();
  const replyText = serialize(buildReplyWorkflow(JSON.parse(replyCurrent ?? '{"nodes":[],"connections":{}}')));

  const researchCurrent = readFileSync(RESEARCH_WORKFLOW_PATH, 'utf8');
  const researchWorkflow = buildResearchWorkflow(JSON.parse(researchCurrent));
  const researchText = serialize(researchWorkflow);
  const researchDecisionText = serialize(buildResearchDecisionWorkflow(researchWorkflow));

  const reconciliationCurrent = readFileSync(RECONCILIATION_WORKFLOW_PATH, 'utf8');
  const reconciliationWorkflow = buildReconciliationWorkflow(JSON.parse(reconciliationCurrent));
  const reconciliationText = serialize(reconciliationWorkflow);
  const reconciliationDecisionText = serialize(buildReconciliationDecisionWorkflow(reconciliationWorkflow));

  const stale = [];
  if (nextText !== currentText) stale.push(WORKFLOW_PATH);
  if (replyText !== replyCurrent) stale.push(REPLY_WORKFLOW_PATH);
  if (researchText !== researchCurrent) stale.push(RESEARCH_WORKFLOW_PATH);
  if (reconciliationText !== reconciliationCurrent) stale.push(RECONCILIATION_WORKFLOW_PATH);
  for (const [path, text] of [
    [RESEARCH_DECISION_PATH, researchDecisionText],
    [RECONCILIATION_DECISION_PATH, reconciliationDecisionText],
  ]) {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { /* missing is stale */ }
    if (text !== current) stale.push(path);
  }
  let decisionCurrent = '';
  try {
    decisionCurrent = readFileSync(DECISION_WORKFLOW_PATH, 'utf8');
  } catch {
    // missing is stale
  }
  if (decisionText !== decisionCurrent) stale.push(DECISION_WORKFLOW_PATH);

  if (check) {
    if (stale.length) {
      console.error(`n8n workflow is stale: ${stale.map((f) => f.split('/').pop()).join(', ')}`);
      console.error('run `node scripts/build-n8n-code.js`');
      process.exit(1);
    }
    console.log('n8n workflows are up to date with engine.js');
    return;
  }

  for (const [path, text] of [
    [WORKFLOW_PATH, nextText],
    [DECISION_WORKFLOW_PATH, decisionText],
    [REPLY_WORKFLOW_PATH, replyText],
    [RESEARCH_WORKFLOW_PATH, researchText],
    [RESEARCH_DECISION_PATH, researchDecisionText],
    [RECONCILIATION_WORKFLOW_PATH, reconciliationText],
    [RECONCILIATION_DECISION_PATH, reconciliationDecisionText],
  ]) {
    const current = (() => { try { return readFileSync(path, 'utf8'); } catch { return null; } })();
    if (current === text) continue;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
    console.log(`wrote ${path}`);
  }
  console.log('n8n workflows up to date');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
