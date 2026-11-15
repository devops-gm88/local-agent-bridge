/**
 * I4b — the scheduled end-of-day summary. Deterministic, built from the audit logs, and
 * once per local day: a restart after the hour must not produce a second summary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summarize, buildSummary, createSummaryScheduler, localDate, readJsonl } from '../summary.js';

const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

async function workspace(t) {
  const dir = join(tmpdir(), `summary-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    runsPath: join(dir, 'runs.jsonl'),
    approvalsPath: join(dir, 'approvals.jsonl'),
    summariesPath: join(dir, 'summaries.jsonl'),
  };
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('the summary reports today\'s tasks and approval outcomes, and ignores other days', () => {
  const runs = [
    { started_at: new Date(at(20, 9)).toISOString(), status: 'ok', duration_ms: 1000, task: 'first' },
    { started_at: new Date(at(20, 12)).toISOString(), status: 'error', duration_ms: 3000, task: 'second' },
    { started_at: new Date(at(20, 13)).toISOString(), status: 'pending_approval', duration_ms: 2000, task: 'write' },
    { started_at: new Date(at(20, 15)).toISOString(), status: 'ok', duration_ms: 4000, task: 'fourth' },
    { started_at: new Date(at(19, 23)).toISOString(), status: 'ok', duration_ms: 9999, task: 'yesterday' },
  ];
  const approvals = [
    { type: 'pending', id: 'a', tool: 'append_row' },
    { type: 'pending', id: 'b', tool: 'append_row' },
    { type: 'decision', id: 'b', decision: 'approve', executed: true },
    { type: 'pending', id: 'c', tool: 'append_row' },
    { type: 'decision', id: 'c', decision: 'reject', executed: false },
  ];

  const out = summarize({ runs, approvals, now: at(20, 20) });
  assert.equal(out.date, '2026-10-20');
  assert.equal(out.runs, 4, 'only today counts');
  assert.deepEqual(out.tasks, { ok: 2, error: 1, pending_approval: 1, other: 0 });
  assert.equal(out.avg_ms, 2500);
  assert.deepEqual(out.approvals, { pending: 1, approved: 1, executed: 1, rejected: 1 });
  assert.match(out.text, /end of day 2026-10-20/);
  assert.match(out.text, /Tasks today: 4 \(ok 2, errors 1, waiting for approval 1\)/);
  assert.match(out.text, /Average reply: 2500 ms/);
  assert.match(out.text, /1 pending · 1 approved \(1 executed\) · 1 rejected/);
  assert.doesNotMatch(out.text, /yesterday/, 'other days are not in the summary');
  assert.doesNotMatch(out.text, /first/, 'only the last three tasks are listed');
});

test('buildSummary reads the real JSONL logs and tolerates missing ones', async (t) => {
  const paths = await workspace(t);
  await writeFile(paths.runsPath, jsonl([
    { started_at: new Date(at(20, 10)).toISOString(), status: 'ok', duration_ms: 500, task: 'from file' },
  ]), 'utf8');

  const built = await buildSummary({ runsPath: paths.runsPath, approvalsPath: paths.approvalsPath, now: at(20, 18, 5) });
  assert.equal(built.runs, 1);
  assert.equal(built.avg_ms, 500);

  const empty = await buildSummary({ runsPath: join(paths.dir, 'missing.jsonl'), approvalsPath: join(paths.dir, 'nope.jsonl'), now: at(20, 18) });
  assert.equal(empty.runs, 0);
  assert.equal(empty.avg_ms, 0);
  assert.match(empty.text, /no measured tasks/);
});

test('the scheduler waits for the hour, writes once per day, and survives a restart without duplicating', async (t) => {
  const paths = await workspace(t);
  await writeFile(paths.runsPath, jsonl([
    { started_at: new Date(at(20, 10)).toISOString(), status: 'ok', duration_ms: 800, task: 'scheduled' },
  ]), 'utf8');

  const scheduler = createSummaryScheduler({ ...paths, atHour: 18, now: () => at(20, 17) });
  assert.equal(await scheduler.tick(at(20, 17)), null, 'not before the hour');
  await assert.rejects(() => readFile(paths.summariesPath, 'utf8'), /ENOENT/);

  const first = await scheduler.tick(at(20, 18, 1));
  assert.ok(first);
  assert.equal(first.date, '2026-10-20');
  assert.equal(first.type, 'summary');
  assert.match(first.created_at, /Z$/);
  const lines = (await readFile(paths.summariesPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);

  assert.equal(await scheduler.tick(at(20, 19, 30)), null, 'already ran today');

  // A restart after the hour: loadLatest() marks today done, so no second summary.
  const restarted = createSummaryScheduler({ ...paths, atHour: 18, now: () => at(20, 19, 45) });
  const latest = await restarted.loadLatest();
  assert.equal(latest.date, '2026-10-20');
  assert.equal(await restarted.tick(at(20, 19, 45)), null, 'restart must not duplicate the summary');

  const nextDay = await restarted.tick(at(21, 18, 2));
  assert.equal(nextDay.date, '2026-10-21');
  const after = (await readFile(paths.summariesPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(after.length, 2, 'a new day gets a new summary');

  scheduler.stop();
  restarted.stop();
});

test('start() catches up immediately after the hour instead of waiting for the first interval', async (t) => {
  const paths = await workspace(t);
  await writeFile(paths.runsPath, jsonl([
    { started_at: new Date(at(20, 10)).toISOString(), status: 'ok', duration_ms: 100, task: 'catch up' },
  ]), 'utf8');
  const scheduler = createSummaryScheduler({ ...paths, atHour: 18, now: () => at(20, 20) });
  t.after(() => scheduler.stop());
  scheduler.start();
  await new Promise((r) => setTimeout(r, 20));
  const lines = (await readFile(paths.summariesPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1, 'the missed summary was written on start');
  assert.equal(lines[0].date, '2026-10-20');
});

test('the scheduler rejects a bad hour instead of silently never running', () => {
  assert.throws(() => createSummaryScheduler({ atHour: 24 }), /atHour must be an integer/);
  assert.throws(() => createSummaryScheduler({ atHour: 'noon' }), /atHour must be an integer/);
});

test('localDate and readJsonl are the small helpers the summary depends on', async (t) => {
  assert.equal(localDate(at(20, 0)), '2026-10-20');
  const paths = await workspace(t);
  await writeFile(paths.summariesPath, '{"a":1}\nnot json\n{"b":2}\n', 'utf8');
  assert.deepEqual(await readJsonl(paths.summariesPath), [{ a: 1 }, { b: 2 }]);
});
