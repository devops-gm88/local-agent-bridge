#!/usr/bin/env node
/**
 * Runnable MCP server for Shotty's tools — `node mcp_server.js` over stdio.
 *
 * Point any MCP-capable client at it:
 *
 *   { "command": "node",
 *     "args": ["/path/to/local-agent-bridge/mcp_server.js"] }
 *
 * The tool list is the same one the local model gets (tools.js). A write tool goes to the
 * approval queue and returns pending_approval; it is never executed here. stdio is the
 * protocol, so diagnostics go to stderr only.
 */
import { pathToFileURL } from 'node:url';
import { createTools } from './tools.js';
import { createApprovalQueue } from './approvals.js';
import { serveMcpStdio } from './mcp.js';

export function main({ env = process.env } = {}) {
  const rowsPath = env.BRIDGE_ROWS ?? new URL('./state/rows.jsonl', import.meta.url).pathname;
  const approvalsPath = env.BRIDGE_APPROVALS ?? new URL('./state/approvals.jsonl', import.meta.url).pathname;
  const tools = createTools({ rowsPath });
  const approvals = createApprovalQueue({ logPath: approvalsPath });
  process.stderr.write(`shotty mcp: ${Object.keys(tools).join(', ')} · approvals -> ${approvalsPath}\n`);
  return serveMcpStdio({ tools, approvals });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
