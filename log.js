/**
 * Append-only JSONL run log. One line per task, no database.
 * Auditable with `tail` and greppable, which is what a one-machine install needs.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function makeRunId(now = Date.now()) {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function appendRun(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
  return record;
}
