/**
 * Grounding: answer from the workspace notes, not from the model's memory.
 *
 * The first version of the agent sent the task straight to a 7b model with no context,
 * so it answered "when is the next stat holiday?" with a generic paragraph. This module
 * gives it the notes and — more importantly — tells it to refuse when the notes do not
 * contain the answer.
 *
 * Deliberately no embeddings and no dependencies: the corpus is a few hundred kilobytes of
 * markdown, so term scoring over ~1.4 KB chunks is instant and explainable. Every answer
 * cites the file and line range it came from.
 *
 * Scope: only curated workspace notes. No client folders, no legal case files, no
 * attachments — those are named in `EXCLUDED` and never read.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute } from 'node:path';

const STOP = new Set(
  ('a an the and or of to in for is are was were be been it this that with on at by from as if then than so ' +
    'do does did can could should would will you your we our i my me not no but what when where how why who which ' +
    'there their they them he she his her about into over under again more most some such only own same just').split(' '),
);

/** Read only what is safe and useful. Client data and legal work are excluded by construction. */
export const DEFAULT_KB = [
  'WORKING_KNOWLEDGE.md',
  'CURRENT_STATE.md',
  'MARK/Projects/Job_Search/BUILD_RERANK_2026-10-19.md',
  'MARK/Projects/Job_Search/JOB_REVIEW_2026-10-20.md',
  'MARK/Projects/Job_Search/DECISION_2026-10-19_scriptsavers_pharmacy.md',
  'MARK/Projects/Job_Search/HANDOFF_upwork_jobs.md',
  'MARK/Projects/Job_Search/applied_jobs.md',
  'MARK/Projects/Job_Search/seen_jobs.md',
  'MARK/Projects/Job_Search/rejected_jobs.md',
  'MARK/Projects/Job_Search/expert_networks_plan.md',
  'MARK/Projects/Job_Search/bridge/README.md',
  'MARK/Projects/Job_Search/Build_Ideas',
  'MARK/Projects/Build_Ideas',
  'MARK/Knowledge/STRATEGIES.md',
  'MARK/Knowledge/SKILLS.md',
  'MARK/Knowledge/WORKFLOWS.md',
  'MARK/Knowledge/ANTI_PATTERNS.md',
  'MARK/Knowledge/CORRECTIONS.md',
];

export const KB_CONFIG = new URL('./state/kb.json', import.meta.url);

/**
 * Which files and folders to index. Editable without touching code: put a JSON file at
 * bridge/state/kb.json with {"roots": ["WORKING_KNOWLEDGE.md", "/abs/path/to/dir", ...]}.
 * Relative paths resolve from ~/Workspace; absolute paths are allowed, so a folder outside
 * the workspace can be added deliberately. The EXCLUDED list still applies as a safety net.
 */
export function loadKbEntries({ configPath = KB_CONFIG } = {}) {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const roots = Array.isArray(raw?.roots)
      ? raw.roots.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
      : null;
    if (roots && roots.length) return roots;
  } catch {
    // no config, or unreadable: fall back to the built-in list
  }
  return DEFAULT_KB;
}

export const EXCLUDED = ['on-legal-research', 'oakville_case', 'devan_trial', 'Juliana_PDF_Extraction', 'attachments', 'node_modules', '.git'];

const CHUNK_TARGET = 1400;

function chunkText(text, source, updated = null) {
  const chunks = [];
  let buf = [];
  let start = 1;
  let size = 0;

  const flush = (end) => {
    if (buf.length) chunks.push({ source, start, end, updated, text: buf.join('\n').trim() });
    buf = [];
    size = 0;
    start = end + 1;
  };

  text.split('\n').forEach((line, i) => {
    // A single very long line (a markdown table row in the job logs) must not become one
    // giant chunk: that is what turned a 6 KB prompt into a 365 KB one and 150 s of latency.
    if (line.length > CHUNK_TARGET) {
      flush(i + 1);
      for (let p = 0; p < line.length; p += CHUNK_TARGET) {
        chunks.push({ source, start: i + 1, end: i + 1, updated, text: line.slice(p, p + CHUNK_TARGET) });
      }
      start = i + 2;
      return;
    }
    if (size + line.length + 1 > CHUNK_TARGET && buf.length) flush(i + 1);
    buf.push(line);
    size += line.length + 1;
  });
  flush(text.split('\n').length);

  return chunks.filter((c) => c.text.length > 40);
}

function norm(t) {
  return t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t;
}

function terms(query) {
  return [...new Set(
    String(query).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP.has(t))
      .map(norm),
  )];
}

async function expand(root, entry, out) {
  const full = isAbsolute(entry) ? entry : join(root, entry);
  let info = null;
  try {
    info = await stat(full);
  } catch {
    return; // missing entry: skip quietly, the index is best-effort
  }
  if (!info.isDirectory()) {
    // label stays exactly as configured (readable in a citation), path is what we read
    out.push({ label: entry, full });
    return;
  }
  const names = await readdir(full).catch(() => []);
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const child = join(full, name);
    if (EXCLUDED.some((x) => child.includes(x))) continue;
    out.push({ label: isAbsolute(entry) ? child : join(entry, name), full: child });
  }
}

/**
 * Build the index once at startup. `search` is synchronous afterwards, so a request
 * never pays for indexing.
 */
export async function buildKb({ root, files, configPath } = {}) {
  if (!root) throw new Error('buildKb requires a root');
  const entries = files ?? loadKbEntries({ configPath });
  const selected = [];
  for (const entry of entries) await expand(root, entry, selected);

  const chunks = [];
  for (const { label, full } of selected) {
    if (EXCLUDED.some((x) => full.includes(x))) continue;
    const text = await readFile(full, 'utf8').catch(() => null);
    if (!text) continue;
    // Recency matters: a stale note must lose to a fresh one, so the date travels with the citation.
    const updated = await stat(full).then((st) => st.mtime.toISOString().slice(0, 10)).catch(() => null);
    chunks.push(...chunkText(text, label, updated));
  }

  // Document frequency across chunks. A term that appears in a third of the corpus
  // ("job", "rate") carries almost no signal; a rare one ("aged", "i4b") carries most of it.
  const N = chunks.length;
  const df = new Map();
  for (const c of chunks) {
    const counts = new Map();
    for (const raw of c.text.toLowerCase().match(/[a-z0-9-]{3,}/g) ?? []) {
      if (STOP.has(raw)) continue;
      const t = norm(raw);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    c.counts = counts;
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const MAX_DF = Math.max(2, Math.floor(N * 0.25));
  const RARE_DF = Math.max(2, Math.floor(N * 0.1));

  function search(query, limit = 3) {
    const qs = terms(query);
    if (!qs.length) return [];
    const usable = qs.filter((t) => (df.get(t) ?? 0) > 0 && (df.get(t) ?? 0) <= MAX_DF);
    if (!usable.length) return [];
    // If every surviving term is common ("next", "job"), there is nothing to retrieve on:
    // better to return nothing and let the model say the notes do not cover it.
    if (!usable.some((t) => (df.get(t) ?? 0) <= RARE_DF)) return [];

    const pairs = [];
    for (let i = 0; i < usable.length - 1; i += 1) pairs.push(`${usable[i]} ${usable[i + 1]}`);

    const scored = [];
    for (const c of chunks) {
      const hay = c.text.toLowerCase();
      const name = c.source.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const t of usable) {
        // +0.5 rather than +1: with a one-chunk corpus df === N and a plain log() would be 0.
        const idf = Math.max(0.05, Math.log((N + 1) / ((df.get(t) ?? 0) + 0.5)));
        const n = Math.min(c.counts.get(t) ?? 0, 12); // exact token, never a substring
        if (n) { matched += 1; score += n * idf * (t.length >= 6 ? 1.5 : 1); }
        if (name.includes(t)) score += 3 * idf;
      }
      if (!score || matched === 0) continue;
      // One generic term ("next") is not evidence. Two terms, or one genuinely rare one.
      const rare = usable.some((t) => (c.counts.get(t) ?? 0) > 0 && (df.get(t) ?? 0) <= 5);
      if (matched < 2 && !rare) continue;
      for (const pair of pairs) if (hay.includes(pair)) score += 6;
      // Length normalisation: without it a 1.4 KB log line beats a precise sentence.
      score /= Math.sqrt(Math.max(1, c.text.length / 1000));
      scored.push({ ...c, score });
    }
    scored.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
    return scored.slice(0, limit);
  }

  return { chunks, files: selected.map((s) => s.label), search, root };
}

/** Turn retrieved chunks into the prompt. Caps the notes so a 7b model is not buried. */
export function buildPrompt(task, hits, { maxChars = 4500, facts = [], history = [], tools = [] } = {}) {
  let notes = '';
  let used = 0;
  hits.forEach((h, i) => {
    if (used >= maxChars) return;
    const body = h.text.length > 1500 ? `${h.text.slice(0, 1500)}…` : h.text;
    const block = `[${i + 1}] ${h.source} (lines ${h.start}-${h.end}${h.updated ? `, updated ${h.updated}` : ''})\n${body}`;
    notes += (notes ? '\n\n' : '') + block;
    used += block.length;
  });
  if (!notes) notes = '(no matching notes)';
  const factBlock = facts.length ? `FACTS ABOUT YOU AND NOW:\n${facts.map((f) => `- ${f}`).join('\n')}\n\n` : '';
  const histBlock = history.length
    ? `RECENT CONVERSATION (oldest first):\n${history.map((m) => `${m.role}: ${String(m.content).slice(0, 400)}`).join('\n')}\n\n`
    : '';
  // I4b: the model chooses tools now. It needs the list and the rule that a write waits.
  const toolBlock = tools.length
    ? `TOOLS (call one when the task needs data or a write; never invent a result):\n` +
      `${tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')}\n` +
      '- A write tool does not execute when you call it. It waits for the owner to approve, and you will be told the outcome. Never claim a write happened before approval.\n\n'
    : '';
  return (
    'You are a local assistant answering from the owner\'s workspace notes.\n' +
    'Rules:\n' +
    '- Answer from FACTS and NOTES below. If they do not contain the answer, say plainly that they do not cover it. Do not guess.\n' +
    '- Cite the note number you used, e.g. [2]. Facts need no citation.\n' +
    '- When two notes disagree, prefer the more recently updated one.\n' +
    '- Be short. No preamble.\n\n' +
    factBlock + histBlock + toolBlock +
    `NOTES:\n${notes}\n\nQUESTION: ${task}\n\nANSWER:`
  );
}

/** A handler for the bridge: retrieve, then answer. Same shape as createHandler. */
export function createGroundedHandler({ runner, kb, maxChunks = 3, facts = [] } = {}) {
  if (typeof runner !== 'function') throw new Error('createGroundedHandler requires a runner');
  if (!kb || typeof kb.search !== 'function') throw new Error('createGroundedHandler requires a kb');
  return async function handle(message) {
    const task = typeof message === 'string' ? message : message?.text;
    if (typeof task !== 'string' || !task.trim()) throw new Error('empty task: the message carries no text');
    const hits = kb.search(task.trim(), maxChunks);
    const history = Array.isArray(message?.history) ? message.history : [];
    return runner(buildPrompt(task.trim(), hits, { facts, history }));
  };
}

/** Workspace root, resolved from this file (…/Job_Search/bridge/context.js -> 4 levels up). */
export function workspaceRoot() {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

export { chunkText, terms };
