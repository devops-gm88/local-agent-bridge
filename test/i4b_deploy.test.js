/**
 * The deploy path: install-time values are substituted into a throwaway copy, never committed,
 * and only the decision webhook is activated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan, parseArgs, validateToken, findN8nBin, publishesToRestore, readActiveWorkflowIds } from '../scripts/deploy-n8n.js';

test('buildPlan substitutes the token and URLs and activates only the decision webhook', () => {
  const plan = buildPlan({
    token: 'deadbeefdeadbeef',
    shottyUrl: 'http://127.0.0.1:8788',
    n8nUrl: 'http://127.0.0.1:5680',
  });
  assert.equal(plan.files.length, 7);
  const byName = Object.fromEntries(plan.files.map((f) => [f.name, f]));

  const mainText = byName['main invoice workflow'].text;
  assert.doesNotMatch(mainText, /REPLACE_WITH_BRIDGE_TOKEN/);
  assert.match(mainText, /deadbeefdeadbeef/);
  assert.match(mainText, /http:\/\/127\.0\.0\.1:8788\/api\/approvals/);
  assert.match(mainText, /http:\/\/127\.0\.0\.1:5680\/webhook\/shotty-decision/);
  assert.equal(byName['main invoice workflow'].activate, false);

  const replyText = byName['Gmail reply handler'].text;
  assert.match(replyText, /deadbeefdeadbeef/);
  assert.match(replyText, /http:\/\/127\.0\.0\.1:8788\/approve/);
  assert.equal(byName['Gmail reply handler'].activate, false);

  const decision = byName['Shotty invoice decision webhook'];
  assert.equal(decision.json.active, true, 'the webhook must be active to receive callbacks');
  assert.equal(plan.commands.length, 7);
  assert.deepEqual(plan.activations.map((a) => a.id), [
    'shotty-decision-webhook', 'shotty-research-decision', 'shotty-reconciliation-decision',
  ]);
  assert.deepEqual(plan.activations[0].args, ['publish:workflow', '--id=shotty-decision-webhook']);

  for (const name of ['Verified research pipeline', 'Reconciliation close audit']) {
    assert.match(byName[name].text, /deadbeefdeadbeef/, `${name} token substituted`);
    assert.match(byName[name].text, /127\.0\.0\.1:8788\/api\/approvals/, `${name} points at Shotty`);
    assert.equal(byName[name].activate, false);
  }
  assert.equal(byName['Shotty research decision webhook'].json.active, true);
  assert.equal(byName['Shotty reconciliation decision webhook'].json.active, true);
});

test('a missing or unsafe token is refused before anything is imported', () => {
  assert.throws(() => buildPlan({ token: '' }), /at least 8 characters/);
  assert.throws(() => buildPlan({ token: 'short' }), /at least 8 characters/);
  assert.throws(() => buildPlan({ token: 'bad"token' }), /cannot be safely inlined/);
  assert.throws(() => validateToken(undefined), /required/);
});

test('a non-http URL is refused', () => {
  assert.throws(() => buildPlan({ token: 'deadbeefdeadbeef', shottyUrl: 'not-a-url' }), /not a URL/);
  assert.throws(() => buildPlan({ token: 'deadbeefdeadbeef', n8nUrl: 'file:///tmp/x' }), /must be http/);
});

test('a deploy restores imported workflows that were active before it ran', () => {
  assert.deepEqual(
    publishesToRestore({
      previouslyActive: ['vendor-invoice-approval-gate', 'invoice-approval-reply-handler', 'some-unrelated'],
      importedIds: ['vendor-invoice-approval-gate', 'invoice-approval-reply-handler', 'shotty-decision-webhook'],
      alreadyActivated: ['shotty-decision-webhook'],
    }),
    ['vendor-invoice-approval-gate', 'invoice-approval-reply-handler'],
  );
  assert.deepEqual(publishesToRestore({}), []);
  assert.deepEqual(readActiveWorkflowIds('/tmp/definitely-not-an-n8n-folder'), []);
});

test('argument parsing and CLI discovery are explicit', () => {
  assert.deepEqual(parseArgs(['--user-folder', '/tmp/x', '--apply']), { 'user-folder': '/tmp/x', apply: true });
  assert.equal(findN8nBin({ N8N_BIN: '/custom/n8n' }), '/custom/n8n');
});
