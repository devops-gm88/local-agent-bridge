/**
 * Invoice decision engine — pure functions, no I/O, no imports.
 *
 * This is a faithful port of the three n8n Code nodes that make the invoice demo safe:
 *   Normalise Intake  ·  Lookup Vendor Policy  ·  Parse and Validate
 * (`~/Workspace/MARK/Projects/Job_Search/n8n_demo/workflow.json`)
 *
 * Why a separate file: an n8n Code node cannot `require` Shotty's modules, so the same
 * source is used two ways —
 *   Shotty   imports it directly (tools, precheck, tests);
 *   n8n     gets the invoice functions inlined into the node's `jsCode` by
 *           `scripts/build-n8n-code.js` (the hash helpers are Node-only and are not emitted).
 * One engine, two hosts, and the n8n test harness can keep running the shipped node text.
 *
 * The safety property is unchanged: the model may say "approved", but it cannot make an
 * approval stick when the policy record disagrees.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- hashing (was guard.js)

/** Deterministic JSON so a payload hash is stable regardless of key order. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function payloadHash(payload) {
  return sha256Hex(stableStringify(payload ?? {}));
}

/** Idempotency key: run_id + hash of the exact tool-call payload. */
export function approvalKey(runId, payload) {
  return sha256Hex(`${runId}:${payloadHash(payload)}`);
}

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

// #region portable-invoice (inlined into n8n Code nodes; keep this region dependency-free)

// ---------------------------------------------------------------- normalise intake

const pick = (input, keys) => {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') return input[key];
  }
  return undefined;
};

/** Port of the `Normalise Intake` node. Returns the normalised invoice and what was missing. */
export function normaliseInvoice(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const inner = source.invoice && typeof source.invoice === 'object' ? { ...source.invoice, ...source } : source;

  const vendor = String(pick(inner, ['vendor', 'Vendor', 'supplier']) ?? '').trim();
  const amountRaw = String(pick(inner, ['amount', 'Amount', 'total']) ?? '').replace(/[^0-9.\-]/g, '');
  const amount = amountRaw === '' ? NaN : Number(amountRaw);
  const currency = String(pick(inner, ['currency', 'Currency']) ?? 'CAD').toUpperCase();
  const invoiceRef = String(pick(inner, ['invoice_ref', 'Invoice Reference', 'reference']) ?? '').trim();
  const notes = String(pick(inner, ['notes', 'Notes', 'description']) ?? '').trim();

  const problems = [];
  if (!vendor) problems.push('vendor missing');
  if (!Number.isFinite(amount) || amount <= 0) problems.push('amount missing or not a number');

  return {
    vendor,
    amount: Number.isFinite(amount) ? amount : 0,
    currency,
    invoice_ref: invoiceRef,
    notes,
    problems,
  };
}

// ---------------------------------------------------------------- vendor policy

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['supply', 'supplies', 'supplier', 'company', 'ltd', 'inc', 'the', 'and', 'industrial']);
const words = (s) => norm(s).split(' ').filter((w) => w.length > 3 && !STOP.has(w));

/** Map a Vendors sheet row to the policy shape, tolerating the shipped column names. */
export function normalisePolicyRow(row = {}) {
  return {
    vendor: row.vendor ?? row.Vendor ?? '',
    category: row.category ?? row.Category ?? 'uncategorised',
    approved_limit: Number(row.approved_limit ?? row['Approved Limit'] ?? row.limit),
    active: row.account_active ?? row['Account Active'] ?? row.active,
  };
}

/** Port of the `Lookup Vendor Policy` node: loose matching, never a hardcoded supplier. */
export function matchVendorPolicy(invoice, policies = []) {
  const rows = (policies || []).map(normalisePolicyRow);
  const askedNorm = norm(invoice?.vendor);
  const hit = askedNorm
    ? rows.find((p) => {
      const pn = norm(p.vendor);
      if (!pn) return false;
      if (askedNorm.includes(pn) || pn.includes(askedNorm)) return true;
      const pw = words(p.vendor);
      return pw.length > 0 && pw.every((w) => askedNorm.includes(w));
    })
    : undefined;

  return hit
    ? {
      policy_found: true,
      matched_vendor: hit.vendor,
      category: hit.category,
      approved_limit: hit.approved_limit,
      account_active: hit.active === true || hit.active === 'TRUE' || hit.active === 1,
    }
    : {
      policy_found: false,
      matched_vendor: null,
      category: 'unmatched',
      approved_limit: null,
      account_active: false,
    };
}

// ---------------------------------------------------------------- model output contract

/** Port of the parse attempts in `Parse and Validate`. Returns {parsed, problems}. */
export function parseModelJson(text) {
  const problems = [];
  let parsed = null;
  const attempts = [String(text ?? '').trim()];
  const fenced = String(text ?? '').replace(/```json/gi, '```').split('```').filter((s) => s.includes('{'));
  attempts.push(...fenced.map((s) => s.trim()));
  const braces = String(text ?? '').match(/\{[\s\S]*\}/);
  if (braces) attempts.push(braces[0]);

  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const candidate = JSON.parse(attempt);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate;
        break;
      }
    } catch {
      // try the next candidate, exactly as the n8n node does
    }
  }
  if (!parsed) problems.push('agent returned no parseable JSON object');
  return { parsed, problems, raw: String(text ?? '') };
}

/**
 * Port of the `Parse and Validate` node. `output` is the model's raw text. Any disagreement
 * between the model's "approved" and the deterministic policy record downgrades the result.
 */
export function adjudicateInvoice({ output, policy, confidenceFloor = 0.6, intakeId = '' } = {}) {
  const floor = Number.isFinite(Number(confidenceFloor)) && Number(confidenceFloor) > 0
    ? Number(confidenceFloor)
    : 0.6;
  const { parsed, problems, raw } = parseModelJson(typeof output === 'string' ? output : JSON.stringify(output ?? {}));

  const vendor = String(parsed?.vendor ?? '').trim();
  const amount = Number(parsed?.amount);
  const decision = String(parsed?.decision ?? '').toLowerCase();
  const confidence = Number(parsed?.confidence ?? 0);

  if (parsed) {
    if (!vendor) problems.push('vendor missing from agent output');
    if (!Number.isFinite(amount) || amount <= 0) problems.push('amount missing or invalid from agent output');
    if (!['approved', 'needs_review'].includes(decision)) problems.push('decision is not approved|needs_review');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) problems.push('confidence outside 0-1');
  }

  if (decision === 'approved') {
    if (!policy?.policy_found) problems.push('approval rejected: vendor is not on the approved-supplier table');
    if (policy?.policy_found && !policy.account_active) problems.push('approval rejected: supplier account is inactive');
    if (policy?.policy_found && Number.isFinite(amount) && amount > policy.approved_limit) {
      problems.push(`approval rejected: ${amount} exceeds the approved limit of ${policy.approved_limit}`);
    }
    if (!Number.isFinite(confidence) || confidence < floor) {
      problems.push(`approval below the ${floor} confidence floor`);
    }
  }

  const finalDecision = decision === 'approved' && problems.length === 0 ? 'approved' : 'needs_review';
  return {
    route: finalDecision === 'approved' ? 'auto_approve' : 'needs_review',
    intake_id: intakeId,
    vendor: vendor || 'unknown',
    amount: Number.isFinite(amount) ? amount : 0,
    currency: String(parsed?.currency ?? 'CAD').toUpperCase(),
    category: String(parsed?.category ?? policy?.category ?? 'uncategorised'),
    decision: finalDecision,
    model_decision: ['approved', 'needs_review'].includes(decision) ? decision : 'invalid',
    reason: String(parsed?.reason ?? '').trim()
      || (problems.join('; ') || (finalDecision === 'approved'
        ? `within the approved limit of ${policy?.approved_limit}`
        : 'no reason given')),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    policy_found: Boolean(policy?.policy_found),
    approved_limit: policy?.approved_limit ?? null,
    validation_problems: problems,
    agent_raw: raw.slice(0, 1500),
  };
}

/**
 * The deterministic check the tools and the approval gate run BEFORE a human is asked.
 * A model cannot even open an approval for an invoice the policy rejects.
 */
export function inspectInvoice({ invoice, policies = [], confidenceFloor = 0.6 } = {}) {
  const normalised = normaliseInvoice(invoice);
  const policy = matchVendorPolicy(normalised, policies);
  const reasons = [...normalised.problems];

  if (!policy.policy_found) reasons.push('vendor is not on the approved-supplier table');
  else {
    if (!policy.account_active) reasons.push('supplier account is inactive');
    if (!Number.isFinite(policy.approved_limit)) {
      // Fail closed: a missing limit used to compare false against NaN and read as "no limit".
      reasons.push('approved limit is missing or not a number');
    } else if (Number.isFinite(normalised.amount) && normalised.amount > policy.approved_limit) {
      reasons.push(`${normalised.amount} exceeds the approved limit of ${policy.approved_limit}`);
    }
  }
  const eligible = reasons.length === 0;
  return {
    invoice: normalised,
    policy,
    eligible,
    recommendation: eligible ? 'auto_approve' : 'needs_review',
    reasons,
    confidence_floor: Number(confidenceFloor),
  };
}

// #endregion portable-invoice
