/**
 * The model seam. Increment I2.
 *
 * I1 left `handler` as a plain function so the loop could be tested with no
 * model, no token and no network. This file supplies the real handler.
 *
 * Two runners, same signature — `async (task) => string`:
 *
 *   ollama  POST /api/chat to the local Ollama daemon. No credential, no
 *           network egress, no recurring fee. This is the default, and it is
 *           the one that matches the product: "a capability the buyer keeps
 *           running after the consultant leaves".
 *   dsh     `dsh headless "<task>"`. Kept because it is the documented seam in
 *           `local_agent_mvp.md`, but note the finding below.
 *
 * FINDING (2026-10-19): `dsh headless` does NOT run the local model. Its default
 * provider route is `deepseek-official` (cloud) and it fails with
 * MISSING_CREDENTIAL without DEEPSEEK_API_KEY. So the spec's claim that I2 is
 * "dsh headless against the local Ollama model" does not hold as written. The
 * local-model path is Ollama directly, which is what this file defaults to.
 * `dsh` remains available for the cloud-model case.
 *
 * Both runners are injectable (`fetchImpl`, `execImpl`) so tests never touch a
 * network, a model or a token.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Local model runner. Default backend. */
export function createOllamaRunner({
  model = 'qwen2.5:7b',
  baseUrl = 'http://localhost:11434',
  timeoutMs = 180_000,
  fetchImpl = fetch,
} = {}) {
  return async function run(task) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('empty task');
    const res = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0 },
        messages: [{ role: 'user', content: task }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = typeof res.text === 'function' ? await res.text() : '';
      throw new Error(`ollama ${res.status}: ${String(detail).slice(0, 400)}`);
    }
    const data = await res.json();
    const content = data?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('ollama returned an empty message');
    }
    return content.trim();
  };
}

/** DSH runner. Cloud provider route; requires DEEPSEEK_API_KEY in its env. */
export function createDshRunner({
  bin = 'dsh',
  timeoutMs = 180_000,
  execImpl = execFileAsync,
} = {}) {
  return async function run(task) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('empty task');
    try {
      const { stdout } = await execImpl(bin, ['headless', task], {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      const out = String(stdout ?? '').trim();
      if (!out) throw new Error('dsh headless returned no output');
      return out;
    } catch (err) {
      const stderr = String(err?.stderr ?? '').trim();
      const detail = stderr || err?.message || String(err);
      throw new Error(`dsh headless failed: ${detail.slice(0, 400)}`);
    }
  };
}

/**
 * The chat-capable local runner — I4b. Same local daemon, but the model is given the tool
 * list and may answer with `tool_calls` instead of text. This is the seam that lets the
 * MODEL choose a tool; `/tool` is no longer something a human has to call by hand.
 *
 * Returns the raw assistant message as well as the normalised calls, so the tool-call loop
 * can push exactly what the model produced back into the conversation.
 */
export function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((call, i) => {
    const fn = call?.function ?? call ?? {};
    let args = fn.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return {
      id: call?.id ?? `call_${i + 1}`,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    };
  });
}

export function createOllamaChatRunner({
  model = 'qwen2.5:7b',
  baseUrl = 'http://localhost:11434',
  timeoutMs = 180_000,
  fetchImpl = fetch,
} = {}) {
  return async function chat({ messages, tools = [] } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('chat requires a non-empty messages array');
    }
    const body = { model, stream: false, options: { temperature: 0 }, messages };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    const res = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = typeof res.text === 'function' ? await res.text() : '';
      throw new Error(`ollama ${res.status}: ${String(detail).slice(0, 400)}`);
    }
    const data = await res.json();
    const message = data?.message ?? {};
    const toolCalls = normalizeToolCalls(message.tool_calls);
    return {
      content: typeof message.content === 'string' ? message.content : '',
      tool_calls: toolCalls,
      // What the model actually returned, replayed into the next turn unchanged.
      assistant: {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : '',
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      },
    };
  };
}

/** Pick a runner from config. Local model is the default on purpose. */
export function createRunner({ kind = 'ollama', ...opts } = {}) {
  if (kind === 'ollama') return createOllamaRunner(opts);
  if (kind === 'dsh') return createDshRunner(opts);
  throw new Error(`unknown runner kind: ${kind}`);
}

/**
 * Adapter: the bridge hands the handler a *message*; a runner takes a *task*.
 * Keeping that translation explicit here is what lets both be tested alone —
 * and it is the bug this increment nearly shipped: passing the message object
 * straight into the runner made every task look empty.
 */
export function createHandler({ runner } = {}) {
  if (typeof runner !== 'function') throw new Error('createHandler requires a runner function');
  return async function handle(message) {
    const task = typeof message === 'string' ? message : message?.text;
    if (typeof task !== 'string' || !task.trim()) {
      throw new Error('empty task: the message carries no text');
    }
    return runner(task.trim());
  };
}
