/**
 * I2 exit tests: the runner seam.
 *
 * Everything here is hermetic — a fake fetch and a fake exec, no model, no
 * network, no token. The live proof against the real Ollama daemon is
 * `npm run demo`, which writes runs.jsonl with measured latency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOllamaRunner, createDshRunner, createRunner, createHandler } from '../runner.js';
import { MockTelegram } from '../transport.js';
import { runBridge } from '../bridge.js';

const FIXTURES = new URL('../fixtures/update_message.json', import.meta.url);

function fakeFetch(reply, { status = 200, captured = [] } = {}) {
  return async (url, init) => {
    captured.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ message: { content: reply } }),
      text: async () => 'upstream detail',
    };
  };
}

test('the ollama runner calls /api/chat with the local model, no stream', async () => {
  const captured = [];
  const run = createOllamaRunner({ fetchImpl: fakeFetch('I2 OK', { captured }) });
  const answer = await run('Reply with exactly: I2 OK');

  assert.equal(answer, 'I2 OK');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'http://localhost:11434/api/chat');
  assert.equal(captured[0].body.model, 'qwen2.5:7b');
  assert.equal(captured[0].body.stream, false);
  assert.equal(captured[0].body.messages[0].content, 'Reply with exactly: I2 OK');
  assert.equal(captured[0].init.method, 'POST');
});

test('the ollama runner surfaces a non-200 instead of returning a blank answer', async () => {
  const run = createOllamaRunner({ fetchImpl: fakeFetch('', { status: 500 }) });
  await assert.rejects(() => run('boom'), /ollama 500: upstream detail/);
});

test('the ollama runner refuses an empty message', async () => {
  const run = createOllamaRunner({ fetchImpl: fakeFetch('   ') });
  await assert.rejects(() => run('anything'), /empty message/);
});

test('the dsh runner passes the task as a single argv entry', async () => {
  const calls = [];
  const execImpl = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { stdout: 'answer from dsh\n' };
  };
  const run = createDshRunner({ execImpl });
  const answer = await run('summarise the handoff');

  assert.equal(answer, 'answer from dsh');
  assert.equal(calls[0].bin, 'dsh');
  assert.deepEqual(calls[0].args, ['headless', 'summarise the handoff']);
});

test('the dsh runner turns a failed exec into a readable error', async () => {
  const execImpl = async () => {
    const err = new Error('Command failed');
    err.stderr = 'dsh: MISSING_CREDENTIAL: llm-deepseek';
    throw err;
  };
  const run = createDshRunner({ execImpl });
  await assert.rejects(() => run('anything'), /MISSING_CREDENTIAL/);
});

test('an empty task is rejected before any model call', async () => {
  let called = false;
  const run = createOllamaRunner({ fetchImpl: async () => { called = true; } });
  await assert.rejects(() => run('   '), /empty task/);
  assert.equal(called, false, 'no request was made');
});

test('createRunner defaults to the local model and rejects unknown kinds', () => {
  assert.equal(typeof createRunner(), 'function');
  assert.throws(() => createRunner({ kind: 'gpt-5-from-a-hat' }), /unknown runner kind/);
});

test('I2: a captured Telegram update is answered by the model and logged with latency', async () => {
  const fixtures = JSON.parse(await readFile(FIXTURES, 'utf8'));
  const transport = new MockTelegram(fixtures);
  const dir = join(tmpdir(), `bridge-i2-${process.pid}`);
  const logPath = join(dir, 'runs.jsonl');
  await rm(dir, { recursive: true, force: true });

  const runs = await runBridge({
    transport,
    handler: createHandler({ runner: createOllamaRunner({ fetchImpl: fakeFetch('the model answer') }) }),
    logPath,
  });

  assert.equal(runs.length, 2);
  assert.equal(transport.sent[0].text, 'the model answer');
  assert.equal(runs[0].status, 'ok');
  assert.ok(typeof runs[0].duration_ms === 'number');
  assert.equal(runs[0].task, 'hello agent');

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2, 'one JSONL record per message');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.reply, 'the model answer');
  assert.equal(rec.status, 'ok');
  await rm(dir, { recursive: true, force: true });
});

test('I2: a model failure is logged as status=error, not swallowed', async () => {
  const transport = new MockTelegram([{
    update_id: 1,
    message: { chat: { id: 7 }, text: 'do it' },
  }]);
  const runs = await runBridge({
    transport,
    handler: createHandler({ runner: createOllamaRunner({ fetchImpl: fakeFetch('', { status: 503 }) }) }),
  });
  assert.equal(runs[0].status, 'error');
  assert.match(runs[0].error, /ollama 503/);
  assert.match(transport.sent[0].text, /^Error: ollama 503/);
});

test('the handler translates a message into the task text exactly once', async () => {
  const seen = [];
  const runner = async (task) => { seen.push(task); return 'ok'; };
  const handle = createHandler({ runner });
  const reply = await handle({ text: '  check the sheet  ', chatId: '1' });
  assert.equal(reply, 'ok');
  assert.deepEqual(seen, ['check the sheet'], 'trimmed, and the message object is not passed through');
});

test('a message with no text is refused before the model is called', async () => {
  let called = false;
  const handle = createHandler({ runner: async () => { called = true; return 'x'; } });
  await assert.rejects(() => handle({ photo: 'x' }), /no text/);
  assert.equal(called, false);
});

test('createHandler rejects a missing runner at construction, not at call time', () => {
  assert.throws(() => createHandler({}), /requires a runner function/);
});
