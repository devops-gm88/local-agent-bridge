/**
 * I4b — MCP tool wiring. The tools are exposed over MCP JSON-RPC, and a write goes through
 * the SAME approval gate over MCP: it returns pending_approval and never executes itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { createTools } from '../tools.js';
import { createApprovalQueue } from '../approvals.js';
import { createMcpServer, serveMcpStdio, toMcpTools, toModelTools, PROTOCOL_VERSION } from '../mcp.js';

async function workspace(t) {
  const dir = join(tmpdir(), `mcp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await rm(dir, { recursive: true, force: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, rowsPath: join(dir, 'rows.jsonl'), approvalsPath: join(dir, 'approvals.jsonl') };
}

function setup(paths) {
  const tools = createTools({ rowsPath: paths.rowsPath });
  const approvals = createApprovalQueue({ logPath: paths.approvalsPath });
  const server = createMcpServer({ tools, approvals });
  return { tools, approvals, server };
}

const textOf = (res) => JSON.parse(res.result.content[0].text);

test('the MCP tool list is generated from the same definition the model sees', async () => {
  const dir = join(tmpdir(), `mcp-shape-${process.pid}`);
  const tools = createTools({ rowsPath: join(dir, 'rows.jsonl') });

  const mcp = toMcpTools(tools);
  assert.deepEqual(mcp.map((t) => t.name), ['read_rows', 'sum_rows', 'append_row']);
  for (const tool of mcp) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`);
  }
  assert.deepEqual(mcp.find((t) => t.name === 'append_row').inputSchema.required, ['row']);

  const model = toModelTools(tools);
  assert.equal(model[0].type, 'function');
  assert.equal(model[0].function.name, 'read_rows');
  assert.deepEqual(model[0].function.parameters, mcp[0].inputSchema, 'one schema, two consumers');
});

test('MCP initialize handshake answers with tools capability, and notifications are silent', async (t) => {
  const paths = await workspace(t);
  const { server } = setup(paths);

  const res = await server.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
  });
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.ok(res.result.capabilities.tools);
  assert.equal(res.result.serverInfo.name, 'shotty');

  const notification = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification, null, 'a notification gets no response');
});

test('tools/list returns the callable surface', async (t) => {
  const paths = await workspace(t);
  const { server } = setup(paths);
  const res = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(res.result.tools.map((t) => t.name), ['read_rows', 'sum_rows', 'append_row']);
});

test('tools/call executes a read immediately', async (t) => {
  const paths = await workspace(t);
  const { server } = setup(paths);

  const res = await server.handleMessage({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_rows', arguments: {} },
  });
  assert.equal(res.result.isError, false);
  assert.deepEqual(textOf(res), { rows: 0 });
});

test('tools/call on a write stops at pending_approval, writes nothing, and the gate executes it once', async (t) => {
  const paths = await workspace(t);
  const { tools, approvals, server } = setup(paths);

  const res = await server.handleMessage({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'append_row', arguments: { row: { client: 'mcp', amount: 5 } } },
  });
  const pending = textOf(res);
  assert.equal(pending.status, 'pending_approval');
  assert.match(pending.id, /^[0-9a-f]{64}$/);
  assert.equal(pending.tool, 'append_row');

  await assert.rejects(() => readFile(paths.rowsPath, 'utf8'), /ENOENT/, 'the MCP write must not run itself');

  const first = await approvals.decide({ id: pending.id, decision: 'approve', tools });
  assert.equal(first.status, 'executed');
  assert.equal((await readFile(paths.rowsPath, 'utf8')).trim().split('\n').length, 1);

  const second = await approvals.decide({ id: pending.id, decision: 'approve', tools });
  assert.equal(second.status, 'duplicate');
  assert.equal((await readFile(paths.rowsPath, 'utf8')).trim().split('\n').length, 1);
});

test('unknown tools and unknown methods fail closed', async (t) => {
  const paths = await workspace(t);
  const { server } = setup(paths);

  const unknownTool = await server.handleMessage({
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'drop_everything', arguments: {} },
  });
  assert.equal(unknownTool.result.isError, true);
  assert.match(textOf(unknownTool).error, /unknown tool/);

  const unknownMethod = await server.handleMessage({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(unknownMethod.error.code, -32601);

  const invalid = await server.handleMessage('not an object');
  assert.equal(invalid.error.code, -32600);

  const noQueue = createMcpServer({ tools: createTools({ rowsPath: paths.rowsPath }) });
  const refused = await noQueue.handleMessage({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'append_row', arguments: { row: { n: 1 } } },
  });
  assert.equal(refused.result.isError, true, 'a write with no approval queue is refused, not executed');
  await assert.rejects(() => readFile(paths.rowsPath, 'utf8'), /ENOENT/);
});

test('the stdio transport answers newline-delimited JSON-RPC (what an MCP client speaks)', async (t) => {
  const paths = await workspace(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const { close } = serveMcpStdio({ input, output, tools: createTools({ rowsPath: paths.rowsPath }), approvals: createApprovalQueue({ logPath: paths.approvalsPath }) });
  t.after(() => close());

  const next = () => new Promise((resolve) => output.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim()))));

  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  const init = await next();
  assert.equal(init.result.protocolVersion, PROTOCOL_VERSION);

  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sum_rows', arguments: {} } }) + '\n');
  const sum = await next();
  assert.deepEqual(JSON.parse(sum.result.content[0].text), { rows: 0, field: 'amount', counted: 0, total: 0 });

  input.write('{not json\n');
  const parseError = await next();
  assert.equal(parseError.error.code, -32700);
});
