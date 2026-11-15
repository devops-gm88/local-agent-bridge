/**
 * MCP tool wiring — I4b (1 of 5).
 *
 * The tools in `tools.js` are already the agent's capability surface. This module exposes
 * that same surface over the Model Context Protocol, and converts it to the `tools` array
 * the local Ollama model accepts. One definition, two consumers:
 *
 *   MCP client (e.g. an MCP-capable host)  --stdio JSON-RPC-->  tools/list, tools/call
 *   the local model                        --tools array-->     native tool_calls
 *
 * A `write` tool never executes over MCP either: it goes through the same approval queue and
 * returns `pending_approval` with the approval id. The approval gate is not bypassable just
 * because the caller is an MCP client.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, which is what MCP's stdio
 * transport is. `mcp_server.js` is the runnable server; this module is the testable core.
 *
 * Deliberately dependency-free: the protocol surface the agent needs (initialize,
 * tools/list, tools/call, ping) is small, and a 400-line SDK for it would be the only
 * network-installed dependency in a zero-install product.
 */
import { createInterface } from 'node:readline';
import { makeRunId } from './log.js';
import { requiresApproval } from './guard.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'shotty';

/** MCP wire form: `{name, description, inputSchema}`. */
export function toMcpTools(tools) {
  if (!tools || typeof tools !== 'object') throw new Error('toMcpTools requires a tools object');
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
}

/** Ollama / OpenAI-compatible form: `{type:'function', function:{name,description,parameters}}`. */
export function toModelTools(tools) {
  return toMcpTools(tools).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

const textContent = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * The JSON-RPC core. `handleMessage` takes one parsed MCP message and returns the response
 * object, or `null` for a notification (MCP notifications get no reply).
 */
export function createMcpServer({ tools, approvals = null, clock = () => Date.now() } = {}) {
  if (!tools || typeof tools !== 'object') throw new Error('createMcpServer requires a tools object');
  const toolList = toMcpTools(tools);

  async function callTool(params) {
    const name = typeof params?.name === 'string' ? params.name : '';
    const tool = tools[name];
    if (!tool) {
      return { content: textContent({ error: `unknown tool: ${name || '(none)'}` }), isError: true };
    }
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};

    if (requiresApproval(tool.class)) {
      if (!approvals) {
        // Fails closed: a write with nowhere to record the decision is refused, not run.
        return { content: textContent({ error: 'this server has no approval queue; write refused' }), isError: true };
      }
      const rec = await approvals.open({ runId: makeRunId(clock()), tool: name, payload: args });
      const pending = {
        status: 'pending_approval',
        id: rec.id,
        tool: name,
        class: tool.class,
        duplicate: Boolean(rec.duplicate),
        note: 'The owner must approve this on the phone. Nothing has been written.',
        approve_with: 'POST /approve {id, decision:"approve"|"reject"}',
      };
      return { content: textContent(pending), structuredContent: pending, isError: false };
    }

    try {
      const result = await tool.run(args);
      return { content: textContent(result), structuredContent: result, isError: false };
    } catch (err) {
      return { content: textContent({ error: err instanceof Error ? err.message : String(err) }), isError: true };
    }
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return rpcError(null, -32600, 'invalid request: expected a JSON-RPC object');
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    let result;
    try {
      if (method === 'initialize') {
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: '0.4.0' },
        };
      } else if (method === 'notifications/initialized' || method === 'initialized') {
        return null; // notification: no response
      } else if (method === 'ping') {
        result = {};
      } else if (method === 'tools/list') {
        result = { tools: toolList };
      } else if (method === 'tools/call') {
        result = await callTool(params);
      } else {
        return isNotification ? null : rpcError(id, -32601, `method not found: ${method ?? '(none)'}`);
      }
    } catch (err) {
      return isNotification ? null : rpcError(id, -32603, err instanceof Error ? err.message : String(err));
    }
    return isNotification ? null : rpcResult(id, result);
  }

  return { handleMessage, tools: toolList, serverInfo: { name: SERVER_NAME, version: '0.4.0' } };
}

/**
 * Newline-delimited JSON-RPC on a duplex stream pair — MCP's stdio transport.
 * Returns a handle so a test (or a supervisor) can close the reader.
 */
export function serveMcpStdio({ input = process.stdin, output = process.stdout, ...options } = {}) {
  const server = createMcpServer(options);
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify(rpcError(null, -32700, 'parse error: invalid JSON')) + '\n');
      return;
    }
    const response = await server.handleMessage(msg);
    if (response) output.write(JSON.stringify(response) + '\n');
  });
  return { server, close: () => rl.close() };
}
