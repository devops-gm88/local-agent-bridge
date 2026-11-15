/**
 * The tools the agent may call. Deliberately tiny: two reads/computes, one write.
 *
 * Each tool carries a name, a one-line description and a JSON-Schema input. That single
 * definition is used twice: it is passed to the local model as a native `tools` array
 * (so the MODEL picks the tool), and it is served over MCP (`mcp.js`) so any MCP client
 * sees the same surface. There is no second copy to drift.
 *
 * The write is a stand-in for "append a row to a client sheet". Swapping it for a real
 * Sheets/GHL call is a single `run()` body — the guard and the approval gate do not change.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CLASSES } from './guard.js';

async function readRows(rowsPath) {
  const text = await readFile(rowsPath, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function createTools({ rowsPath }) {
  if (!rowsPath) throw new Error('createTools requires rowsPath');

  return {
    read_rows: {
      class: CLASSES.READ,
      description: 'Count the rows currently in the owner\'s rows sheet. Use when asked how many rows exist.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        try {
          const text = await readFile(rowsPath, 'utf8');
          return { rows: text.trim() ? text.trim().split('\n').length : 0 };
        } catch (err) {
          if (err.code === 'ENOENT') return { rows: 0 };
          throw err;
        }
      },
    },

    sum_rows: {
      class: CLASSES.COMPUTE,
      description: 'Read every row and sum one numeric field (default "amount"). Returns the row count and the total. Use when asked for a total.',
      inputSchema: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'the numeric field to sum; defaults to "amount"' },
        },
        additionalProperties: false,
      },
      async run({ field = 'amount' } = {}) {
        const rows = await readRows(rowsPath);
        let total = 0;
        let counted = 0;
        for (const row of rows) {
          const n = Number(row?.[field]);
          if (Number.isFinite(n)) {
            total += n;
            counted += 1;
          }
        }
        return { rows: rows.length, field, counted, total };
      },
    },

    append_row: {
      class: CLASSES.WRITE,
      description: 'Append one key/value row object to the owner\'s rows sheet. This is a write and always waits for the owner\'s approval.',
      inputSchema: {
        type: 'object',
        properties: {
          row: { type: 'object', description: 'the row to append, e.g. {"client":"Acme","amount":125}' },
        },
        required: ['row'],
        additionalProperties: false,
      },
      async run({ row } = {}) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new Error('append_row needs a `row` object');
        }
        await mkdir(dirname(rowsPath), { recursive: true });
        const record = { ...row, appended_at: new Date().toISOString() };
        await appendFile(rowsPath, JSON.stringify(record) + '\n', 'utf8');
        return { appended: record };
      },
    },
  };
}
