#!/usr/bin/env node
/**
 * Test the deterministic guard in the "Parse and Validate" Code node.
 *
 * The guard is the safety property of the whole workflow: the model may say
 * "approved", but it cannot make an approval stick when the policy record
 * disagrees. That is worth an executable test rather than a claim.
 *
 * The node's JavaScript is extracted from workflow.json, so the test runs the
 * exact code that ships. `$input` and `$()` are stubbed to mimic n8n.
 *
 *   node tools/test_guard.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflow.json'), 'utf8'));
const node = wf.nodes.find((n) => n.name === 'Parse and Validate');
const code = node.parameters.jsCode;

// The node body has a top-level `return`, so it is compiled as a function with
// n8n's globals as parameters.
const compiled = new Function('$input', '$', 'code', code);

function runRaw(text, policy) {
  const items = compiled(
    { first: () => ({ json: { output: text } }) },
    () => ({ first: () => ({ json: { policy } }) }),
  );
  return items[0].json;
}

function run(agentOutput, policy) {
  return runRaw(JSON.stringify(agentOutput), policy);
}

const POLICY_OK = {
  policy_found: true,
  matched_vendor: 'Northline Electrical Supply',
  category: 'electrical supplies',
  approved_limit: 2500,
  account_active: true,
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
  policy_found: true,
  ...extra,
});

const cases = [
  {
    name: 'model approves a valid invoice -> auto_approve',
    out: run(approve(1840), POLICY_OK),
    expect: (r) => r.route === 'auto_approve' && r.decision === 'approved',
  },
  {
    name: 'model approves an unknown vendor -> downgraded to needs_review',
    out: run(approve(500), POLICY_UNKNOWN),
    expect: (r) =>
      r.route === 'needs_review' &&
      r.model_decision === 'approved' &&
      r.validation_problems.some((p) => p.includes('not on the approved-supplier table')),
  },
  {
    name: 'model approves above the limit -> downgraded',
    out: run(approve(4200), POLICY_OK),
    expect: (r) =>
      r.route === 'needs_review' && r.validation_problems.some((p) => p.includes('exceeds the approved limit')),
  },
  {
    name: 'model approves an inactive supplier -> downgraded',
    out: run(approve(200), POLICY_INACTIVE),
    expect: (r) =>
      r.route === 'needs_review' && r.validation_problems.some((p) => p.includes('account is inactive')),
  },
  {
    name: 'model approves below the confidence floor -> downgraded',
    out: run(approve(100, { confidence: 0.2 }), POLICY_OK),
    expect: (r) => r.route === 'needs_review' && r.validation_problems.some((p) => p.includes('confidence floor')),
  },
  {
    name: 'model wraps JSON in markdown -> still parsed',
    out: runRaw(
      '```json\n' + JSON.stringify({ ...approve(100), decision: 'needs_review', reason: 'over policy' }) + '\n```',
      POLICY_OK,
    ),
    expect: (r) => r.model_decision === 'needs_review' && r.vendor === 'Northline Electrical Supply',
  },
  {
    name: 'model returns prose -> needs_review, no crash',
    out: run('I think this is fine, approve it.', POLICY_OK),
    expect: (r) =>
      r.route === 'needs_review' && r.validation_problems.some((p) => p.includes('no parseable JSON')),
  },
  {
    name: 'approved invoice with an empty reason gets a written reason',
    out: run(approve(100, { reason: '' }), POLICY_OK),
    expect: (r) => r.route === 'auto_approve' && r.reason.length > 0,
  },
];

let failed = 0;
for (const c of cases) {
  let ok = false;
  let err = '';
  try {
    ok = c.expect(c.out);
  } catch (e) {
    err = e.message;
  }
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${err ? ' — ' + err : ''}`);
  if (!ok) console.log('      got:', JSON.stringify(c.out).slice(0, 300));
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
