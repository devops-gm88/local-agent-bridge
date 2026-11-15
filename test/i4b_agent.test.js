/**
 * I4b — the model tool-call loop.
 *
 * The plan carried a risk note: "one successful tool call does not prove a chain." So the
 * central test here is a THREE-step chain where each model turn consumes the previous tool
 * result before deciding the next call. The write path is tested separately: it must stop at
 * pending_approval, write nothing, then execute exactly once on approval and never again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTools } from '../tools.js';
import { createApprovalQueue } from '../approvals.js';
import { createAgentHandler } from '../agent.js';

async function workspace(t) {
  const dir = join(tmpdir(), `agent-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    rowsPath: join(dir, 'rows.jsonl'),
    approvalsPath: join(dir, 'approvals.jsonl'),
  };
}

const toolCall = (name, args = {}, id = `call_${name}`) => ({ id, name, arguments: args });

/**
 * A scripted chat model: one canned assistant turn per call, recording the full conversation
 * each time. This is how a chain is proven without a live model — the assertions below check
 * that turn N really receives the tool results from turn N-1.
 */
function chatScript(turns, seen = []) {
  let i = 0;
  const chat = async ({ messages, tools }) => {
    seen.push({
      messages: messages.map((m) => ({ ...m })),
      tools: tools.map((t) => t.function.name),
    });
    const turn = turns[i];
    i += 1;
    if (!turn) throw new Error('chat script exhausted: the loop called the model more times than scripted');
    return {
      content: turn.content ?? '',
      tool_calls: turn.tool_calls ?? [],
      assistant: {
        role: 'assistant',
        content: turn.content ?? '',
        ...(turn.tool_calls?.length
          ? {
            tool_calls: turn.tool_calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.arguments },
            })),
          }
          : {}),
      },
    };
  };
  chat.seen = seen;
  return chat;
}

function setup(paths) {
  const tools = createTools({ rowsPath: paths.rowsPath });
  const approvals = createApprovalQueue({ logPath: paths.approvalsPath });
  return { tools, approvals };
}

test('the model chooses the tool: the call executes, its result is fed back, then the answer', async (t) => {
  const paths = await workspace(t);
  await writeFile(paths.rowsPath, '{"client":"a","amount":10}\n{"client":"b","amount":20}\n', 'utf8');
  const { tools, approvals } = setup(paths);
  const seen = [];
  const chat = chatScript([
    { tool_calls: [toolCall('read_rows')] },
    { content: 'There are 2 rows.' },
  ], seen);
  const handle = createAgentHandler({ chat, tools, approvals });

  const out = await handle({
    text: 'How many rows are in the sheet?',
    history: [{ role: 'user', content: 'prior turn' }],
  });

  assert.equal(out.status, 'ok');
  assert.equal(out.reply, 'There are 2 rows.');
  assert.deepEqual(out.steps, [{ tool: 'read_rows', status: 'ok', result: { rows: 2 } }]);

  assert.equal(seen.length, 2, 'two model turns: one to call, one to answer');
  assert.deepEqual(seen[0].tools, ['read_rows', 'sum_rows', 'append_row'], 'the model is handed the tool list');
  assert.match(seen[0].messages[0].content, /TOOLS/);
  assert.match(seen[0].messages[0].content, /prior turn/, 'history still reaches the prompt');
  const toolMessages = seen[1].messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 1);
  assert.deepEqual(JSON.parse(toolMessages[0].content), { rows: 2 }, 'the model sees the real tool result');
  assert.ok(seen[1].messages.some((m) => m.role === 'assistant' && m.tool_calls?.length === 1));
});

test('THREE-step chain: three model turns, each consuming the previous tool result, before answering', async (t) => {
  const paths = await workspace(t);
  await writeFile(paths.rowsPath, '{"client":"a","amount":125}\n{"client":"b","amount":75}\n', 'utf8');
  const { tools, approvals } = setup(paths);
  const seen = [];
  const chat = chatScript([
    { tool_calls: [toolCall('read_rows')] }, // step 1
    { tool_calls: [toolCall('sum_rows')] }, // step 2, after seeing the row count
    { tool_calls: [toolCall('read_rows')] }, // step 3, after seeing the total
    { content: 'Started with 2 rows; the amount total is 200; there are still 2 rows.' },
  ], seen);
  const handle = createAgentHandler({ chat, tools, approvals });

  const out = await handle({ text: 'Count the rows, total the amount, then confirm the count.' });

  assert.equal(out.status, 'ok');
  assert.match(out.reply, /2 rows/);
  assert.equal(out.steps.length, 3, 'three tool steps, not one');
  assert.deepEqual(out.steps.map((s) => s.tool), ['read_rows', 'sum_rows', 'read_rows']);
  assert.deepEqual(out.steps.map((s) => s.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(out.steps[1].result, { rows: 2, field: 'amount', counted: 2, total: 200 });
  assert.equal(seen.length, 4, 'model -> tool -> model -> tool -> model -> tool -> model');

  // The proof it is a chain: by turn 4 the model has all three observations in context.
  assert.equal(seen[3].messages.filter((m) => m.role === 'tool').length, 3);
  assert.equal(seen[1].messages.filter((m) => m.role === 'tool').length, 1);
  assert.equal(seen[2].messages.filter((m) => m.role === 'tool').length, 2);
});

test('a chain that ends in a write: two tools run, then the loop stops at pending_approval', async (t) => {
  const paths = await workspace(t);
  await writeFile(paths.rowsPath, '{"client":"a","amount":125}\n', 'utf8');
  const { tools, approvals } = setup(paths);
  const seen = [];
  const chat = chatScript([
    { tool_calls: [toolCall('read_rows')] },
    { tool_calls: [toolCall('sum_rows')] },
    { tool_calls: [toolCall('append_row', { row: { client: 'chain', amount: 200 } })] },
  ], seen);
  const handle = createAgentHandler({ chat, tools, approvals });

  const out = await handle({ text: 'Read the rows, total them, then append a summary row.' });

  assert.equal(out.status, 'pending_approval');
  assert.deepEqual(out.steps.map((s) => s.status), ['ok', 'ok', 'pending_approval']);
  assert.equal(out.approval.tool, 'append_row');
  assert.match(out.approval.id, /^[0-9a-f]{64}$/);
  const lines = (await readFile(paths.rowsPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1, 'nothing was written while the approval is pending');
  assert.equal(seen.length, 3, 'the loop stops at the gate rather than inventing an outcome');
});

test('the write exit test: pending -> approve executes once -> second approve is a no-op, both decisions logged', async (t) => {
  const paths = await workspace(t);
  const { tools, approvals } = setup(paths);
  const seen = [];
  const chat = chatScript([
    { tool_calls: [toolCall('append_row', { row: { client: 'agent', amount: 9 } })] },
  ], seen);
  const handle = createAgentHandler({ chat, tools, approvals });

  const out = await handle({ text: 'Append a row for the agent test.' });
  assert.equal(out.status, 'pending_approval');
  assert.equal(out.approval.class, 'write');
  await assert.rejects(() => readFile(paths.rowsPath, 'utf8'), /ENOENT/, 'nothing written before approval');

  const first = await approvals.decide({ id: out.approval.id, decision: 'approve', tools });
  assert.equal(first.status, 'executed');
  assert.equal((await readFile(paths.rowsPath, 'utf8')).trim().split('\n').length, 1);

  const second = await approvals.decide({ id: out.approval.id, decision: 'approve', tools });
  assert.equal(second.status, 'duplicate');
  assert.equal((await readFile(paths.rowsPath, 'utf8')).trim().split('\n').length, 1, 'a second approve writes nothing');

  const log = (await readFile(paths.approvalsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.filter((l) => l.type === 'pending').length, 1);
  assert.equal(log.filter((l) => l.type === 'decision').length, 1);
  assert.equal(log[0].payload_hash, log[1].payload_hash, 'the decision is bound to the exact payload');
  assert.equal(log[1].executed, true);
});

test('a model that keeps calling tools is stopped at maxSteps instead of looping forever', async (t) => {
  const paths = await workspace(t);
  const { tools, approvals } = setup(paths);
  const chat = chatScript([
    { tool_calls: [toolCall('read_rows')] },
    { tool_calls: [toolCall('read_rows')] },
    { content: 'never reached' },
  ]);
  const handle = createAgentHandler({ chat, tools, approvals, maxSteps: 2 });

  const out = await handle({ text: 'loop' });
  assert.equal(out.status, 'max_steps');
  assert.equal(out.steps.length, 2);
  assert.match(out.reply, /stopped after 2 tool steps/i);
});

test('an unknown tool call fails closed and the error is fed back, not executed', async (t) => {
  const paths = await workspace(t);
  const { tools, approvals } = setup(paths);
  const seen = [];
  const chat = chatScript([
    { tool_calls: [toolCall('drop_everything', { table: 'rows' })] },
    { content: 'I cannot do that.' },
  ], seen);
  const handle = createAgentHandler({ chat, tools, approvals });

  const out = await handle({ text: 'drop the table' });
  assert.equal(out.status, 'ok');
  assert.equal(out.steps[0].status, 'unknown_tool');
  assert.match(seen[1].messages.find((m) => m.role === 'tool').content, /unknown tool/);
});

test('the approval gate survives a restart: pending is reloaded and a decided id stays duplicate', async (t) => {
  const paths = await workspace(t);
  const tools = createTools({ rowsPath: paths.rowsPath });
  const first = createApprovalQueue({ logPath: paths.approvalsPath });
  const opened = await first.open({ runId: 'r-restart', tool: 'append_row', payload: { row: { n: 1 } } });

  // A new process (LaunchAgent restart) replays approvals.jsonl before serving anything.
  const second = createApprovalQueue({ logPath: paths.approvalsPath });
  assert.equal(second.list().length, 1, 'the pending approval is not lost on restart');
  assert.equal(second.list()[0].id, opened.id);

  assert.equal((await second.decide({ id: opened.id, decision: 'approve', tools })).status, 'executed');

  const third = createApprovalQueue({ logPath: paths.approvalsPath });
  assert.equal(third.list().length, 0);
  assert.equal((await third.decide({ id: opened.id, decision: 'approve', tools })).status, 'duplicate');
  assert.equal((await readFile(paths.rowsPath, 'utf8')).trim().split('\n').length, 1);
});

test('the agent handler refuses to construct without a chat seam, tools and a gate', () => {
  assert.throws(() => createAgentHandler({}), /requires a chat function/);
  assert.throws(() => createAgentHandler({ chat: async () => ({}) }), /requires tools/);
  assert.throws(
    () => createAgentHandler({ chat: async () => ({}), tools: { read_rows: {} } }),
    /requires an approval queue/,
  );
});
