/**
 * Grounding tests. A small temp corpus for the logic, plus one smoke test against the
 * real workspace so a renamed file or a broken path is caught here and not in a demo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildKb, buildPrompt, createGroundedHandler, workspaceRoot, DEFAULT_KB, EXCLUDED,
} from '../context.js';

async function corpus(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'kb-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  return root;
}

test('search finds the note that contains the term, and ranks it first', async (t) => {
  const root = await corpus(t, {
    'expert_networks.md': '# Expert networks\n\nPhase 0 has not started since 16 September. The channel bypasses Upwork JSS entirely.',
    'fleet.md': '# Fleet\n\nPre-hire versus post-hire comparison engine for trailers and equipment.',
  });
  const kb = await buildKb({ root, files: ['expert_networks.md', 'fleet.md'] });
  assert.equal(kb.chunks.length, 2);

  const hits = kb.search('expert networks phase 0');
  assert.ok(hits.length >= 1);
  assert.match(hits[0].source, /expert_networks\.md/);
  assert.match(hits[0].text, /Phase 0/);
});

test('a query made only of stopwords returns nothing', async (t) => {
  const root = await corpus(t, { 'a.md': '# A\n\nThe quick brown fox.' });
  const kb = await buildKb({ root, files: ['a.md'] });
  assert.deepEqual(kb.search('what is the of and'), []);
});

test('the prompt carries the notes, the question, the refusal rule and the citation ask', async (t) => {
  const root = await corpus(t, {
    'notes.md': '# Notes\n\nThe next increment is I4b, the model tool-call loop.',
  });
  const kb = await buildKb({ root, files: ['notes.md'] });
  const hits = kb.search('next increment');
  const prompt = buildPrompt('what is the next increment?', hits);

  assert.match(prompt, /Answer from FACTS and NOTES/);
  assert.match(prompt, /say plainly that they do not cover it/);
  assert.match(prompt, /\[1\] notes\.md \(lines \d+-\d+, updated \d{4}-\d{2}-\d{2}\)/);
  assert.match(prompt, /QUESTION: what is the next increment\?/);
});

test('no hits still produces a prompt that tells the model to refuse', async () => {
  const prompt = buildPrompt('when is the next stat holiday?', []);
  assert.match(prompt, /\(no matching notes\)/);
  assert.match(prompt, /Do not guess/);
});

test('the grounded handler retrieves, then calls the runner with the built prompt', async (t) => {
  const root = await corpus(t, {
    'kb.md': '# Knowledge\n\nConnects balance is 62 after the aged-care proposal was submitted.',
  });
  const kb = await buildKb({ root, files: ['kb.md'] });
  const seen = [];
  const handle = createGroundedHandler({
    kb,
    runner: async (prompt) => { seen.push(prompt); return 'The balance is 62 [1].'; },
  });

  const reply = await handle({ text: 'what is the connects balance?' });
  assert.equal(reply, 'The balance is 62 [1].');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Connects balance is 62/);
});

test('a directory entry pulls in .md files only, and excluded paths are skipped', async (t) => {
  const root = await corpus(t, {
    'ideas/one.md': '# One\n\napproval gate',
    'ideas/two.txt': 'approval gate in a txt file',
    'on-legal-research/secret.md': '# Legal\n\napproval gate PHIPA',
  });
  const kb = await buildKb({ root, files: ['ideas', 'on-legal-research/secret.md'] });

  const sources = kb.files.join(' ');
  assert.match(sources, /ideas[/\\]one\.md/);
  assert.doesNotMatch(sources, /two\.txt/);
  assert.doesNotMatch(kb.chunks.map((c) => c.source).join(' '), /on-legal-research/);
  assert.ok(EXCLUDED.includes('on-legal-research'));
});

test('the real workspace index builds and answers a known question', async (t) => {
  // This smoke test indexes the owner's notes, which a clone of this repository
  // does not have. It runs where the workspace exists and is skipped elsewhere, so
  // a clean clone stays green without pretending the index was checked.
  const root = workspaceRoot();
  if (!existsSync(join(root, 'WORKING_KNOWLEDGE.md'))) {
    t.skip('no workspace notes at ' + root + ' (clean clone)');
    return;
  }
  const kb = await buildKb({ root });
  assert.ok(kb.chunks.length > 50, `expected a real index, got ${kb.chunks.length} chunks`);
  assert.ok(kb.files.length >= 5);

  const hits = kb.search('expert networks phase 0 not started');
  assert.ok(hits.length > 0, 'should retrieve the expert-networks material');
  const sources = hits.map((h) => h.source).join(' ');
  assert.match(sources, /expert_networks_plan|WORKING_KNOWLEDGE|CURRENT_STATE/);
});

test('the default file list is curated — no client or legal folders', () => {
  for (const entry of DEFAULT_KB) {
    for (const bad of EXCLUDED) assert.ok(!entry.includes(bad), `${entry} must not include ${bad}`);
  }
});

test('the prompt carries runtime facts and recent conversation', () => {
  const prompt = buildPrompt('q', [], {
    facts: ['Your name is Scout.', 'You are running the model qwen2.5:7b.'],
    history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }],
  });
  assert.match(prompt, /FACTS ABOUT YOU AND NOW/);
  assert.match(prompt, /Your name is Scout/);
  assert.match(prompt, /RECENT CONVERSATION/);
  assert.match(prompt, /user: earlier question/);
  assert.match(prompt, /assistant: earlier answer/);
});

test('the grounded handler passes message.history into the prompt', async (t) => {
  const root = await corpus(t, { 'n.md': '# N\n\nThe approving rule lives in guard.js.' });
  const kb = await buildKb({ root, files: ['n.md'] });
  const prompts = [];
  const handle = createGroundedHandler({
    kb,
    facts: ['You are Scout.'],
    runner: async (p) => { prompts.push(p); return 'ok'; },
  });
  await handle({ text: 'what does the approving rule do?', history: [{ role: 'user', content: 'prior turn' }] });
  assert.match(prompts[0], /You are Scout\./);
  assert.match(prompts[0], /prior turn/);
});

test('the indexed roots come from a config file when one is given', async (t) => {
  const root = await corpus(t, { 'a.md': '# A\n\nalpha content here', 'b.md': '# B\n\nbeta content here' });
  const cfg = join(root, 'kb.json');
  await writeFile(cfg, JSON.stringify({ roots: ['a.md'] }), 'utf8');

  const kb = await buildKb({ root, configPath: cfg });
  assert.equal(kb.files.length, 1);
  assert.match(kb.files[0], /a\.md$/);
});

test('an absolute path outside the workspace can be added deliberately', async (t) => {
  const root = await corpus(t, {});
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'ext.md'), '# Ext\n\ngamma content lives here and is long enough to keep as a chunk.', 'utf8');

  const cfg = join(root, 'kb.json');
  await writeFile(cfg, JSON.stringify({ roots: [join(outside, 'ext.md')] }), 'utf8');

  const kb = await buildKb({ root, configPath: cfg });
  assert.equal(kb.files.length, 1);
  assert.ok(kb.files[0].startsWith(outside), 'the absolute path is used as given');
  assert.match(kb.search('gamma content')[0].text, /gamma/);
});
