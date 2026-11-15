/**
 * Transport: local PWA over the tailnet. Replaces the Telegram adapter as the default.
 *
 * Why this and not iMessage: Apple has no bot API, `~/Library/Messages/chat.db` is blocked by
 * TCC without a manual Full Disk Access grant (verified 2026-10-20 — `Operation not permitted`),
 * a bot would message as the owner rather than as itself, and it needs a Mac awake 24/7 — which
 * makes it impossible to ship to a Windows client. A web page has none of those properties.
 *
 * Why this and not Telegram: no third party in the path, no token, no account, and approval
 * buttons are buttons instead of a chat keyboard. Telegram stays as an optional adapter.
 *
 * Auth: a shared token (BRIDGE_TOKEN), sent as `x-bridge-token` or `?t=` on the page URL. The
 * server binds 127.0.0.1 by default; set HOST to the Tailscale IP to reach it from the phone.
 *
 * I4b: `POST /task` now runs the model tool-call loop (agent.js) — the model chooses a tool.
 * A write stops at `pending_approval` and returns the approval id; the page turns that into
 * Approve / Reject buttons. `GET /healthz` is the phone page's reachability probe, and
 * `GET /summary` serves the scheduled end-of-day summary.
 */
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createRunner, createHandler, createOllamaChatRunner } from './runner.js';
import { appendRun, makeRunId } from './log.js';
import { createTools } from './tools.js';
import { createInvoiceTools } from './invoice_tools.js';
import { createApprovalQueue } from './approvals.js';
import { requiresApproval } from './guard.js';
import { buildKb, createGroundedHandler, workspaceRoot } from './context.js';
import { createAgentHandler } from './agent.js';
import { createSummaryScheduler } from './summary.js';
import { renderPage, renderLogin, DEFAULT_TAILNET_URL } from './page.js';

const MAX_BODY = 16 * 1024;

export function createApp({
  handler,
  token,
  logPath = null,
  rowsPath = null,
  approvalsPath = null,
  model = 'qwen2.5:7b',
  clock = () => Date.now(),
  tools = null,
  approvals = null,
  name = 'Agent',
  historyPath = null,
  notes = 0,
  tailnetUrl = DEFAULT_TAILNET_URL,
  summaryProvider = null,
  callbackToken = null,
  callbackTimeoutMs = 3000,
} = {}) {
  if (typeof handler !== 'function') throw new Error('createApp requires a handler');
  if (typeof token !== 'string' || token.length < 8) {
    throw new Error('createApp requires a token of at least 8 characters');
  }
  const startedAt = clock();
  const toolSet = tools ?? createTools({
    rowsPath: rowsPath ?? new URL('./state/rows.jsonl', import.meta.url).pathname,
  });
  const history = (() => {
    if (!historyPath) return [];
    try {
      return readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).slice(-6).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  })();
  const queue = approvals ?? createApprovalQueue({
    logPath: approvalsPath ?? new URL('./state/approvals.jsonl', import.meta.url).pathname,
    clock,
    callbackToken,
    callbackTimeoutMs,
  });

  const authorized = (req, url) => {
    const header = req.headers['x-bridge-token'];
    return header === token || url.searchParams.get('t') === token;
  };

  const json = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (!authorized(req, url)) {
      // The page gets a login form instead of a bare 401: typing a 64-character token into
      // a phone URL bar is the failure mode this removes. The API still refuses.
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(renderLogin());
      }
      return json(res, 401, { ok: false, error: 'missing or bad token' });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const body = renderPage({ token, name, model, notes, tailnet: tailnetUrl });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      return res.end(body);
    }

    if (req.method === 'GET' && url.pathname === '/help') {
      try {
        const sheet = readFileSync(fileURLToPath(new URL('./CHEATSHEET.html', import.meta.url)), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(sheet);
      } catch {
        return json(res, 404, { ok: false, error: 'cheat sheet missing' });
      }
    }

    // I4b: the phone page's reachability probe. A stale origin shows a banner with the
    // tailnet address instead of "Request failed: Load failed".
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, {
        ok: true,
        name,
        model,
        notes,
        uptime_s: Math.round((clock() - startedAt) / 1000),
        started_at: new Date(startedAt).toISOString(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        model,
        uptime_s: Math.round((clock() - startedAt) / 1000),
      });
    }

    // I4b: the scheduled end-of-day summary. Deterministic, built from the JSONL logs.
    if (req.method === 'GET' && url.pathname === '/summary') {
      let latest = null;
      if (summaryProvider) {
        try {
          latest = await summaryProvider();
        } catch {
          latest = null;
        }
      }
      return json(res, 200, { ok: true, latest });
    }

    if (req.method === 'POST' && url.pathname === '/task') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        const msg = err.message === 'body too large' ? 'body too large' : 'invalid JSON';
        return json(res, 400, { ok: false, error: msg });
      }
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text) return json(res, 400, { ok: false, error: 'text is required' });

      const started = clock();
      const runId = makeRunId(started);
      let status = 'ok';
      let reply;
      let error = null;
      let approval = null;
      let steps = [];
      try {
        // A plain handler returns a string (I1–I6). The agent handler returns an object with
        // the tool steps and, for a write, the pending approval. Both go through here.
        const outcome = await handler({ text, chatId: 'pwa', history: history.slice(-6), runId });
        if (typeof outcome === 'string') {
          reply = outcome;
        } else if (outcome && typeof outcome === 'object') {
          reply = String(outcome.reply ?? '');
          status = outcome.status ?? 'ok';
          approval = outcome.approval ?? null;
          steps = Array.isArray(outcome.steps) ? outcome.steps : [];
        } else {
          reply = '';
        }
      } catch (err) {
        status = 'error';
        error = err instanceof Error ? err.message : String(err);
        reply = `Error: ${error}`;
      }
      const record = {
        run_id: runId,
        chat: 'pwa',
        task: text,
        status,
        error,
        started_at: new Date(started).toISOString(),
        duration_ms: clock() - started,
        reply,
        steps,
      };
      if (approval) record.approval = approval;
      if (logPath) await appendRun(logPath, record);
      const turns = [{ role: 'user', content: text }, { role: 'assistant', content: reply }];
      history.push(...turns);
      if (historyPath) {
        for (const turn of turns) await appendRun(historyPath, turn);
      }
      return json(res, status === 'error' ? 502 : 200, { ok: status !== 'error', ...record });
    }

    // I4b upgrade: an external orchestrator (n8n) can open an approval and poll its state.
    // The phone is the decision surface; the callback closes the loop back to n8n.
    if (req.method === 'POST' && url.pathname === '/api/approvals') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message === 'body too large' ? 'body too large' : 'invalid JSON' });
      }
      // execute:false is a decision-only approval (research/reconciliation): n8n executes the
      // consequence, Shotty records the human decision and calls back.
      const execute = body.execute !== false;
      const toolName = typeof body.tool === 'string' ? body.tool : '';
      const tool = toolName ? toolSet[toolName] : null;
      if (execute && !tool) return json(res, 400, { ok: false, error: `unknown tool: ${toolName || '(none)'}` });
      const args = body.payload && typeof body.payload === 'object' ? body.payload : {};
      if (execute && typeof tool.precheck === 'function') {
        try {
          await tool.precheck(args);
        } catch (err) {
          return json(res, 422, {
            ok: false, status: 'rejected_by_policy', tool: toolName, error: err.message,
            details: err.details ?? null,
          });
        }
      }
      try {
        const rec = await queue.open({
          runId: typeof body.run_id === 'string' && body.run_id ? body.run_id : makeRunId(clock()),
          tool: execute ? toolName : null,
          payload: args,
          callback_url: body.callback_url ?? null,
          title: body.title ?? null,
          execute,
          actions: body.actions ?? null,
          fields: body.fields ?? null,
        });
        const alreadyDecided = rec.status === 'already_decided';
        return json(res, 202, {
          ok: true,
          status: alreadyDecided ? 'already_decided' : 'pending_approval',
          id: rec.id,
          tool: rec.tool,
          class: execute ? tool.class : 'decision',
          execute,
          actions: rec.actions,
          fields: rec.fields ?? null,
          duplicate: Boolean(rec.duplicate),
          callback_url: rec.callback_url ?? null,
        });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/approvals/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/approvals/'.length));
      const state = queue.status(id);
      if (!state) return json(res, 404, { ok: false, error: 'unknown approval id' });
      return json(res, 200, { ok: true, ...state });
    }

    if (req.method === 'GET' && url.pathname === '/approvals') {
      return json(res, 200, {
        ok: true,
        pending: queue.list().map(({ id, run_id, tool, payload, title, execute, actions, fields, created_at }) => ({
          id, run_id, tool, payload, title: title ?? null,
          execute: execute !== false, actions, fields: fields ?? null, created_at,
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/tool') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message === 'body too large' ? 'body too large' : 'invalid JSON' });
      }
      const toolName = typeof body.tool === 'string' ? body.tool : '';
      const tool = toolSet[toolName];
      if (!tool) return json(res, 400, { ok: false, error: `unknown tool: ${toolName || '(none)'}` });
      const args = body.payload && typeof body.payload === 'object' ? body.payload : {};
      if (requiresApproval(tool.class)) {
        if (typeof tool.precheck === 'function') {
          try {
            await tool.precheck(args);
          } catch (err) {
            return json(res, 422, {
              ok: false, status: 'rejected_by_policy', tool: toolName, error: err.message,
              details: err.details ?? null,
            });
          }
        }
        const rec = await queue.open({ runId: makeRunId(clock()), tool: toolName, payload: args });
        return json(res, 202, { ok: true, status: 'pending_approval', id: rec.id, tool: toolName, class: tool.class });
      }
      try {
        const result = await tool.run(args);
        return json(res, 200, { ok: true, status: 'ok', tool: toolName, class: tool.class, result });
      } catch (err) {
        return json(res, 502, { ok: false, status: 'error', tool: toolName, error: err.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/approve') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'invalid JSON' });
      }
      try {
        const out = await queue.decide({
          id: typeof body.id === 'string' ? body.id : '',
          decision: body.decision,
          tools: toolSet,
          suppressCallback: body.suppress_callback === true,
        });
        return json(res, out.status === 'failed' ? 502 : 200, { ok: out.status !== 'failed', ...out });
      } catch (err) {
        if (err.code === 'ENOAPPROVAL') return json(res, 404, { ok: false, error: 'unknown approval id' });
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    return json(res, 404, { ok: false, error: 'not found' });
  });
}

async function main() {
  const { env } = process;
  const token = env.BRIDGE_TOKEN;
  const port = Number(env.PORT ?? 8787);
  // An empty HOST (e.g. `HOST=$(tailscale ip -4)` when tailscale is not installed or not
  // running) must fall back to loopback. Never to every interface.
  const host = (env.HOST ?? '').trim() || '127.0.0.1';
  const model = env.MODEL ?? 'qwen2.5:7b';
  if (!token) {
    console.error('BRIDGE_TOKEN is required. Generate one:  openssl rand -hex 16');
    process.exit(1);
  }
  const name = env.AGENT_NAME
    || (() => { try { return readFileSync(new URL('./state/name', import.meta.url), 'utf8').trim(); } catch { return ''; } })()
    || 'Agent';
  const facts = [
    `Your name is ${name}; the owner calls you that.`,
    `You run locally on this Mac using the Ollama model ${model}. No cloud and no third-party API.`,
    `Today is ${new Date().toLocaleDateString('en-CA')}.`,
    'You answer from the owner\'s workspace notes and may call tools: read_rows, sum_rows, check_invoice and read_invoices run immediately; append_row and file_invoice are writes and wait for the owner to approve them.',
  ];

  const rowsPath = new URL('./state/rows.jsonl', import.meta.url).pathname;
  const invoicesPath = new URL('./state/invoices.jsonl', import.meta.url).pathname;
  const vendorsPath = new URL('./state/vendors.json', import.meta.url).pathname;
  const logPath = new URL('./state/runs.jsonl', import.meta.url).pathname;
  const approvalsPath = new URL('./state/approvals.jsonl', import.meta.url).pathname;
  const summariesPath = new URL('./state/summaries.jsonl', import.meta.url).pathname;

  const runnerKind = env.RUNNER ?? 'ollama';
  let handler;
  let tools = null;
  let approvals = null;
  let notes = 0;

  let knowledge = null;
  if ((env.GROUNDED ?? 'on').toLowerCase() !== 'off') {
    try {
      knowledge = await buildKb({ root: workspaceRoot() });
      notes = knowledge.files.length;
    } catch (err) {
      console.error(`grounding off — index failed: ${err.message}`);
    }
  }

  if (runnerKind === 'ollama') {
    // I4b: the real path. Tools are wired to the model and to the owner's approval gate.
    // The invoice tools are the first real job: deterministic policy check, gated filing.
    tools = {
      ...createTools({ rowsPath }),
      ...createInvoiceTools({ invoicesPath, vendorsPath }),
    };
    approvals = createApprovalQueue({ logPath: approvalsPath, callbackToken: token });
    const chat = createOllamaChatRunner({ model });
    handler = createAgentHandler({
      chat,
      tools,
      approvals,
      kb: knowledge,
      facts,
      maxSteps: Number(env.MAX_TOOL_STEPS ?? 6),
    });
  } else {
    // The cloud `dsh` route has no tool loop; it stays a plain text runner by design.
    const runner = createRunner({ kind: runnerKind, model });
    handler = knowledge
      ? createGroundedHandler({ runner, kb: knowledge, facts })
      : createHandler({ runner });
  }

  const scheduler = createSummaryScheduler({
    runsPath: logPath,
    approvalsPath,
    summariesPath,
    atHour: Number(env.EOD_SUMMARY_HOUR ?? 18),
    enabled: (env.EOD_SUMMARY ?? 'on').toLowerCase() !== 'off',
  });
  await scheduler.loadLatest();
  scheduler.start();

  // The page advertises the address that actually works off-LAN. Default is the current
  // tailnet address; TAILNET_URL overrides it if the tailnet changes.
  const tailnetUrl = (env.TAILNET_URL ?? DEFAULT_TAILNET_URL).trim() || DEFAULT_TAILNET_URL;

  const server = createApp({
    handler,
    name,
    historyPath: new URL('./state/session.jsonl', import.meta.url).pathname,
    token,
    logPath,
    rowsPath,
    approvalsPath,
    tools,
    approvals,
    notes,
    tailnetUrl,
    summaryProvider: async () => scheduler.latest(),
    model,
  });
  server.on('close', () => scheduler.stop());
  server.on('error', (err) => {
    if (err.code === 'EADDRNOTAVAIL') {
      console.error(`Cannot bind ${host}. Check HOST. This machine's LAN address is usually:`);
      console.error('  ipconfig getifaddr en0');
      process.exit(1);
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Set PORT to something else.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, host, () => {
    const scope = host === '127.0.0.1' ? 'this Mac only' : 'reachable from your network';
    console.log(`${name} ready — ${scope}`);
    console.log(`  open:  http://${host}:${port}/?t=<your BRIDGE_TOKEN>`);
    console.log(`  tailnet: ${tailnetUrl}`);
    console.log(`  model: ${model} · logs: state/runs.jsonl`);
    console.log(notes ? `  notes: ${notes} files indexed (answers cite them)` : '  notes: grounding OFF (bare model)');
    console.log(`  tools: ${tools ? Object.keys(tools).join(', ') : 'none (text-only runner)'}`);
    console.log(`  summary: end of day at ${env.EOD_SUMMARY_HOUR ?? 18}:00 local → state/summaries.jsonl`);
    if (host === '127.0.0.1') console.log('  phone: HOST=$(ipconfig getifaddr en0) npm run serve  (same Wi-Fi)');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
