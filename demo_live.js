/**
 * I2 live proof. Runs the real bridge against the real local model and writes
 * runs.jsonl with measured latency. No token, no network egress, no cloud.
 *
 *   npm run demo                 # fixture task, default model
 *   npm run demo -- "your task"  # your own task
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockTelegram } from './transport.js';
import { runBridge } from './bridge.js';
import { createRunner, createHandler } from './runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const task = process.argv.slice(2).join(' ').trim() || 'Reply with exactly: I2 OK';
const logPath = join(here, 'state', 'runs.jsonl');

// A captured Telegram update, replayed so the loop is exercised end to end.
const fixtures = JSON.parse(await readFile(join(here, 'fixtures', 'update_message.json'), 'utf8'));
const inbound = [{ ...fixtures[0], message: { ...fixtures[0].message, text: task } }];

const transport = new MockTelegram(inbound);
const handler = createHandler({ runner: createRunner({ kind: process.env.RUNNER ?? 'ollama' }) });

const started = Date.now();
const runs = await runBridge({ transport, handler, logPath });
const wall = Date.now() - started;

const run = runs[0];
console.log(`task      : ${run.task}`);
console.log(`status    : ${run.status}`);
console.log(`reply     : ${run.reply}`);
console.log(`model time: ${run.duration_ms} ms`);
console.log(`wall time : ${wall} ms`);
console.log(`log       : ${logPath}`);
console.log('last line :', (await readFile(logPath, 'utf8')).trim().split('\n').at(-1));

if (run.status !== 'ok' || !run.reply.trim()) {
  console.error('I2 EXIT TEST FAILED: no model answer');
  process.exit(1);
}
