/**
 * The scheduled end-of-day summary — I4b (4 of 5).
 *
 * No cron, no cloud scheduler: the process the LaunchAgent keeps alive ticks once a minute
 * and, at or after the configured hour, writes one summary for the local day. It is
 * idempotent — the summaries file doubles as the "already ran today" marker, so a restart
 * after the hour does not produce a second summary, and a Mac asleep at the hour catches up
 * on the first tick after it wakes.
 *
 * The summary is deterministic, read from the same JSONL logs the rest of the product audits
 * (`runs.jsonl`, `approvals.jsonl`). No model call: an end-of-day report should be a fact
 * about what happened, not another generation that can be wrong.
 */
import { readFile } from 'node:fs/promises';
import { appendRun } from './log.js';

/** Local calendar date `YYYY-MM-DD` — the same form `toLocaleDateString('en-CA')` gives. */
export function localDate(ms) {
  return new Date(ms).toLocaleDateString('en-CA');
}

export async function readJsonl(path) {
  if (!path) return [];
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn line (process killed mid-append) must not break the summary.
    }
  }
  return out;
}

/** Pure: turn the rows of the two logs into the summary record and its phone text. */
export function summarize({ runs = [], approvals = [], now = Date.now() } = {}) {
  const date = localDate(now);
  const today = runs.filter((r) => r.started_at && localDate(new Date(r.started_at).getTime()) === date);
  const tasks = { ok: 0, error: 0, pending_approval: 0, other: 0 };
  let totalMs = 0;
  let measured = 0;
  for (const r of today) {
    if (r.status === 'ok') tasks.ok += 1;
    else if (r.status === 'error') tasks.error += 1;
    else if (r.status === 'pending_approval') tasks.pending_approval += 1;
    else tasks.other += 1;
    if (typeof r.duration_ms === 'number' && r.duration_ms >= 0) {
      totalMs += r.duration_ms;
      measured += 1;
    }
  }

  const pendingById = new Map();
  const decided = [];
  for (const rec of approvals) {
    if (rec.type === 'pending' && rec.id) pendingById.set(rec.id, rec);
    else if (rec.type === 'decision' && rec.id) {
      decided.push(rec);
      pendingById.delete(rec.id);
    }
  }
  const approvalsStats = {
    pending: pendingById.size,
    approved: decided.filter((d) => d.decision === 'approve').length,
    executed: decided.filter((d) => d.executed).length,
    rejected: decided.filter((d) => d.decision === 'reject').length,
  };

  const avgMs = measured ? Math.round(totalMs / measured) : 0;
  const lines = [
    `Shotty — end of day ${date}`,
    `Tasks today: ${today.length} (ok ${tasks.ok}, errors ${tasks.error}, waiting for approval ${tasks.pending_approval})`,
    `Average reply: ${avgMs} ms${measured ? '' : ' (no measured tasks)'}`,
    `Approvals: ${approvalsStats.pending} pending · ${approvalsStats.approved} approved (${approvalsStats.executed} executed) · ${approvalsStats.rejected} rejected`,
  ];
  const recent = today
    .slice(-3)
    .reverse()
    .map((r) => `· ${String(r.task ?? '').slice(0, 70)} → ${r.status ?? 'unknown'}`);
  if (recent.length) lines.push('Latest:', ...recent);

  return {
    date,
    tasks,
    runs: today.length,
    avg_ms: avgMs,
    approvals: approvalsStats,
    text: lines.join('\n'),
  };
}

/** Read the logs and build the summary for the local day containing `now`. */
export async function buildSummary({ runsPath, approvalsPath, now = Date.now() } = {}) {
  const [runs, approvals] = await Promise.all([readJsonl(runsPath), readJsonl(approvalsPath)]);
  return summarize({ runs, approvals, now });
}

/**
 * Once-a-day scheduler. `tick()` is public so a test controls time without waiting an hour;
 * `start()` is the production path (one unref'd interval, so it never holds a test open).
 */
export function createSummaryScheduler({
  runsPath,
  approvalsPath,
  summariesPath,
  atHour = 18,
  now = () => Date.now(),
  enabled = true,
  intervalMs = 60_000,
  build = buildSummary,
} = {}) {
  const hour = Number(atHour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`atHour must be an integer 0-23, got ${atHour}`);
  }
  let latest = null;
  let timer = null;
  let inFlight = false;

  async function tick(atMs = now()) {
    if (!enabled) return null;
    if (new Date(atMs).getHours() < hour) return null;
    const date = localDate(atMs);
    if (latest && latest.date === date) return null; // already ran today
    if (inFlight) return null;
    inFlight = true;
    try {
      const record = await build({ runsPath, approvalsPath, now: atMs });
      const line = { type: 'summary', created_at: new Date(atMs).toISOString(), ...record };
      if (summariesPath) await appendRun(summariesPath, line);
      latest = line;
      return line;
    } finally {
      inFlight = false;
    }
  }

  async function loadLatest() {
    const lines = await readJsonl(summariesPath);
    latest = lines.length ? lines.at(-1) : null;
    return latest;
  }

  function start() {
    if (timer || !enabled) return;
    // Catch up immediately: a restart after the hour (or a Mac waking late) should not wait
    // for the first interval to write the day's summary.
    tick().catch(() => {});
    timer = setInterval(() => {
      tick().catch(() => {}); // a failed summary must never crash the agent
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, loadLatest, latest: () => latest, atHour: hour };
}
