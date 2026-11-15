/**
 * The approval queue — I4's core, now also the external approval API for n8n.
 *
 * A write does not execute when it is requested. It is opened as a pending approval with a
 * stable id; the owner approves or rejects; the decision and its outcome are appended to
 * approvals.jsonl. A second decision on the same id is a duplicate, never a second write.
 *
 * I4b upgrade: `callback_url` closes the loop for an external orchestrator (n8n). After the
 * decision is durably logged, a JSON POST tells the caller what happened. A failed callback
 * never un-does or re-runs the decision; it is recorded as a `callback` line.
 *
 * Fails closed: an unknown tool, a bad decision, or an execution error leaves the action
 * unexecuted and recorded as such.
 */
import { readFileSync } from 'node:fs';
import { appendRun } from './log.js';
import { approvalKey, payloadHash, requiresApproval } from './guard.js';

/**
 * Rebuild the in-memory state from the append-only log. A LaunchAgent restart must not lose
 * a pending approval (it would become an unknown id) and must not forget that an id was
 * already decided (that is what makes a second Approve a duplicate across restarts).
 */
function replay(logPath) {
  const pending = new Map();
  const decided = new Set();
  const decisions = new Map();
  if (!logPath) return { pending, decided, decisions };
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return { pending, decided, decisions };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn last line must not take the whole gate down
    }
    if (!rec || typeof rec.id !== 'string') continue;
    if (rec.type === 'pending') {
      pending.set(rec.id, { ...rec, status: 'pending' });
    } else if (rec.type === 'decision') {
      decided.add(rec.id);
      decisions.set(rec.id, rec);
      pending.delete(rec.id);
    }
  }
  return { pending, decided, decisions };
}

export const DEFAULT_ACTIONS = Object.freeze([
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
]);

const ACTION_ID = /^[a-z0-9_-]{1,32}$/;

/**
 * Decision-only approvals (research: APPROVE/REPLACE/DROP, reconciliation: ACCEPT/DISPUTE)
 * need an explicit action set. Tool-backed approvals keep the default Approve/Reject pair.
 */
export function cleanActions(actions) {
  const list = Array.isArray(actions) && actions.length ? actions : DEFAULT_ACTIONS;
  if (list.length > 4) throw new Error('at most 4 actions are allowed');
  const seen = new Set();
  return list.map((action) => {
    const id = typeof action === 'string' ? action : action?.id;
    const label = typeof action === 'string'
      ? `${action.charAt(0).toUpperCase()}${action.slice(1)}`
      : action?.label;
    if (!ACTION_ID.test(String(id ?? ''))) throw new Error(`invalid action id: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate action id: ${id}`);
    seen.add(id);
    return { id, label: String(label ?? id).slice(0, 40) };
  });
}

/** Human-readable phone card fields: [{label, value}], not raw JSON. */
export function cleanFields(fields) {
  if (fields === null || fields === undefined) return null;
  if (!Array.isArray(fields)) throw new Error('fields must be an array');
  if (fields.length > 12) throw new Error('at most 12 fields are allowed');
  return fields.map((field) => {
    const label = String(field?.label ?? '').trim();
    if (!label) throw new Error('each field needs a label');
    const value = field?.value;
    return {
      label: label.slice(0, 60),
      value: (value === null || value === undefined ? '' : String(value)).slice(0, 400),
    };
  });
}

const validCallbackUrl = (value) => {
  if (value === null || value === undefined) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('callback_url must be an http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('callback_url must be an http(s) URL');
  }
  return url.toString();
};

export function createApprovalQueue({
  logPath = null,
  clock = () => Date.now(),
  callbackToken = null,
  callbackTimeoutMs = 3000,
  fetchImpl = fetch,
} = {}) {
  const replayed = replay(logPath);
  const pending = replayed.pending;
  const decided = replayed.decided;
  const decisions = replayed.decisions;
  const entries = [];

  async function record(line) {
    entries.push(line);
    if (logPath) await appendRun(logPath, line);
    return line;
  }

  /** Tell the external caller what the owner decided. Never changes the decision. */
  async function fireCallback(rec, entry) {
    if (!rec.callback_url) return null;
    const payload = {
      id: rec.id,
      run_id: rec.run_id,
      tool: rec.tool,
      payload_hash: rec.payload_hash,
      execute: rec.execute !== false,
      decision: entry.decision,
      action: entry.decision,
      executed: entry.executed,
      title: rec.title ?? null,
      fields: rec.fields ?? null,
      payload: rec.payload ?? null,
      result: entry.result,
      error: entry.error,
      decided_at: entry.decided_at,
    };
    let outcome;
    try {
      const res = await fetchImpl(rec.callback_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(callbackToken ? { 'x-bridge-token': callbackToken } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(callbackTimeoutMs),
      });
      outcome = { ok: res.ok, status: res.status };
    } catch (err) {
      outcome = {
        ok: false,
        error: err?.name === 'TimeoutError' ? `timeout after ${callbackTimeoutMs} ms` : (err?.message || String(err)),
      };
    }
    await record({ type: 'callback', id: rec.id, tool: rec.tool, ...outcome });
    return outcome;
  }

  return {
    /**
     * Open a request. Returns the record, or a duplicate marker for a repeated request.
     * `execute:false` records a decision only; n8n executes the consequence.
     */
    async open({
      runId,
      tool = null,
      payload = {},
      callback_url = null,
      title = null,
      execute = true,
      actions = null,
      fields = null,
    }) {
      const isExecute = execute !== false;
      if (isExecute && !tool) throw new Error('an executing approval requires a tool');
      const actionSet = cleanActions(actions);
      const fieldSet = cleanFields(fields);
      const id = approvalKey(runId, payload);
      if (pending.has(id)) return { ...pending.get(id), duplicate: true };
      if (decided.has(id)) return { id, status: 'already_decided', duplicate: true };

      const rec = {
        id,
        run_id: runId,
        tool: tool ?? null,
        payload_hash: payloadHash(payload),
        payload,
        execute: isExecute,
        actions: actionSet,
        ...(fieldSet ? { fields: fieldSet } : {}),
        callback_url: validCallbackUrl(callback_url),
        ...(title ? { title: String(title) } : {}),
        status: 'pending',
        created_at: new Date(clock()).toISOString(),
      };
      pending.set(id, rec);
      await record({ type: 'pending', ...rec });
      return rec;
    },

    list() {
      return [...pending.values()];
    },

    get(id) {
      return pending.get(id) ?? null;
    },

    /** Current state of one approval: pending, executed, rejected, failed — or null. */
    status(id) {
      const rec = pending.get(id);
      if (rec) {
        return {
          id,
          status: 'pending',
          run_id: rec.run_id,
          tool: rec.tool,
          payload: rec.payload,
          payload_hash: rec.payload_hash,
          execute: rec.execute !== false,
          actions: rec.actions ?? DEFAULT_ACTIONS,
          fields: rec.fields ?? null,
          title: rec.title ?? null,
          created_at: rec.created_at,
          callback_url: rec.callback_url ?? null,
        };
      }
      const d = decisions.get(id);
      if (!d) return null;
      const executed = d.execute !== false;
      return {
        // `decided` is the terminal state for a decision-only approval; the action id is the
        // decision itself (e.g. replace/drop/accept/dispute).
        status: d.error ? 'failed' : !executed ? 'decided' : d.decision === 'approve' ? (d.executed ? 'executed' : 'failed') : 'rejected',
        id,
        run_id: d.run_id,
        tool: d.tool,
        payload_hash: d.payload_hash,
        execute: executed,
        decision: d.decision,
        executed: d.executed,
        result: d.result,
        error: d.error,
        decided_at: d.decided_at,
      };
    },

    /**
     * Approve or reject. Executes at most once per id.
     *
     * `suppressCallback` exists for the Gmail reply loop: n8n already owns the Sheet write for
     * an email decision, so it reconciles Shotty's ledger without firing the phone webhook and
     * causing a second Sheet append. The decision is still recorded here exactly once.
     */
    async decide({ id, decision, tools, suppressCallback = false }) {
      const rec = pending.get(id);
      if (!rec) {
        if (decided.has(id)) {
          const prior = decisions.get(id);
          return {
            status: 'duplicate',
            id,
            previous: prior
              ? { decision: prior.decision, executed: prior.executed, decided_at: prior.decided_at }
              : null,
          };
        }
        const err = new Error('unknown approval id');
        err.code = 'ENOAPPROVAL';
        throw err;
      }

      const execute = rec.execute !== false;
      const allowed = execute ? ['approve', 'reject'] : (rec.actions ?? DEFAULT_ACTIONS).map((a) => a.id);
      if (!allowed.includes(decision)) {
        throw new Error(`decision must be one of: ${allowed.join(', ')}`);
      }

      // Validate before consuming the request, so a bad tool cannot silently eat it.
      const tool = execute && decision === 'approve' ? tools?.[rec.tool] : null;
      if (execute && decision === 'approve' && !tool) {
        throw new Error(`unknown tool: ${rec.tool}`);
      }

      pending.delete(id);
      decided.add(id);

      let result = null;
      let error = null;
      if (execute && decision === 'approve') {
        try {
          result = await tool.run(rec.payload);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }

      const entry = {
        type: 'decision',
        id,
        run_id: rec.run_id,
        tool: rec.tool,
        payload_hash: rec.payload_hash,
        decision,
        execute,
        decided_at: new Date(clock()).toISOString(),
        executed: execute && decision === 'approve' && !error,
        result,
        error,
      };
      decisions.set(id, entry);
      await record(entry);
      const callback = suppressCallback ? null : await fireCallback(rec, entry);

      return {
        status: error ? 'failed' : !execute ? 'decided' : decision === 'approve' ? 'executed' : 'rejected',
        id,
        decision,
        execute,
        result,
        error,
        callback,
      };
    },

    /** Everything logged, in order. Used by the tests and by the audit view. */
    entries() {
      return [...entries];
    },
  };
}

export { requiresApproval };
