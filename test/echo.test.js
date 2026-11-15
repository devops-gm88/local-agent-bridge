import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { MockTelegram, createTransport } from '../transport.js';
import { runBridge } from '../bridge.js';
import { appendRun, makeRunId } from '../log.js';

const FIXTURES = new URL('../fixtures/update_message.json', import.meta.url);

test('a captured Telegram update produces the expected reply', async () => {
  const fixtures = JSON.parse(await readFile(FIXTURES, 'utf8'));
  const transport = new MockTelegram(fixtures);
  const runs = await runBridge({
    transport,
    handler: async (m) => `echo: ${m.text}`,
  });

  assert.equal(transport.sent.length, 2, 'one reply per inbound message');
  assert.equal(transport.sent[0].chatId, '820144');
  assert.equal(transport.sent[0].text, 'echo: hello agent');
  assert.equal(transport.sent[1].text, 'echo: status?');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, 'ok');
  assert.match(runs[0].run_id, /^[a-z0-9]+-[a-z0-9]{6}$/);
});

test('the inbox drains, so a second poll sends nothing new', async () => {
  const fixtures = JSON.parse(await readFile(FIXTURES, 'utf8'));
  const transport = new MockTelegram(fixtures);
  await runBridge({ transport, handler: async (m) => m.text });
  await runBridge({ transport, handler: async (m) => m.text });
  assert.equal(transport.sent.length, 2, 'no duplicate replies after re-poll');
});

test('a throwing handler replies with an error and logs status=error', async () => {
  const transport = new MockTelegram([{
    update_id: 1,
    message: { chat: { id: 7 }, text: 'boom' },
  }]);
  const runs = await runBridge({
    transport,
    handler: async () => { throw new Error('model unavailable'); },
  });
  assert.equal(runs[0].status, 'error');
  assert.equal(runs[0].error, 'model unavailable');
  assert.equal(transport.sent[0].text, 'Error: model unavailable');
});

test('runs are appended to JSONL, one valid record per line', async () => {
  const dir = join(tmpdir(), `bridge-test-${process.pid}`);
  const path = join(dir, 'runs.jsonl');
  await rm(dir, { recursive: true, force: true });

  const transport = createTransport({
    kind: 'mock',
    fixtures: [{ update_id: 9, message: { chat: { id: 5 }, text: 'log me' } }],
  });
  await runBridge({ transport, handler: async (m) => `ok: ${m.text}`, logPath: path });

  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.chat, '5');
  assert.equal(rec.task, 'log me');
  assert.equal(rec.status, 'ok');
  assert.ok(typeof rec.duration_ms === 'number');
  await rm(dir, { recursive: true, force: true });
});

test('an unknown transport kind is rejected rather than silently mocked', () => {
  assert.throws(() => createTransport({ kind: 'carrier-pigeon' }), /unknown transport kind/);
});

test('makeRunId is unique across rapid calls', () => {
  const ids = new Set(Array.from({ length: 200 }, () => makeRunId(1760700000000)));
  assert.equal(ids.size, 200);
});
