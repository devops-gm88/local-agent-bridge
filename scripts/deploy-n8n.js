#!/usr/bin/env node
/**
 * Deploy the three workflows to an n8n instance — safely and reproducibly.
 *
 * The repo files carry install-time placeholders on purpose (the bridge token must never be
 * committed). This script makes a throwaway copy with the real values, imports it, and
 * activates only the decision webhook. The main invoice workflow and the Gmail reply handler
 * stay inactive: they are triggered by a form and by Gmail, and should not start polling
 * because a deploy script ran.
 *
 *   node scripts/deploy-n8n.js --user-folder ~/.n8n --token "$BRIDGE_TOKEN" --apply
 *   node scripts/deploy-n8n.js --user-folder /tmp/n8n-test --n8n-url http://127.0.0.1:5680 \
 *        --shotty-url http://127.0.0.1:8788 --token test-token --apply
 *
 * Default is a dry run: it prints exactly what would be imported and with which values.
 *
 * AN IMPORTANT LIMIT: importing does not register a webhook in an already-running n8n. The
 * decision workflow only starts receiving callbacks after n8n restarts (or the workflow is
 * re-activated from the UI). The script says so at the end instead of pretending otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const BRIDGE = join(here, '..');
export const N8N_DIR = join(BRIDGE, 'n8n_demo');

const WORKFLOWS = [
  { name: 'main invoice workflow', file: join(N8N_DIR, 'workflow.json'), activate: false },
  { name: 'Gmail reply handler', file: join(N8N_DIR, 'workflow_reply.json'), activate: false },
  { name: 'Shotty invoice decision webhook', file: join(N8N_DIR, 'workflow_shotty_decision.json'), activate: true },
  { name: 'Verified research pipeline', file: join(N8N_DIR, 'workflow_research.json'), activate: false },
  { name: 'Shotty research decision webhook', file: join(N8N_DIR, 'workflow_shotty_research_decision.json'), activate: true },
  { name: 'Reconciliation close audit', file: join(N8N_DIR, 'workflow_reconciliation.json'), activate: false },
  { name: 'Shotty reconciliation decision webhook', file: join(N8N_DIR, 'workflow_shotty_reconciliation_decision.json'), activate: true },
];

const TOKEN_PLACEHOLDER = 'REPLACE_WITH_BRIDGE_TOKEN';
const SHOTTY_PLACEHOLDER = 'http://127.0.0.1:8787';
const N8N_PLACEHOLDER = 'http://127.0.0.1:5678';

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'apply' || key === 'help') {
      args[key] = true;
    } else {
      args[key] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

/** Find the n8n CLI without assuming it is on PATH (npx runs it from a cache dir). */
export function findN8nBin(env = process.env) {
  if (env.N8N_BIN) return env.N8N_BIN;
  const roots = [
    env.N8N_NPX_ROOT,
    env.npm_config_cache ? join(env.npm_config_cache, '_npx') : null,
    join(env.HOME ?? '', 'Library', 'Caches', 'npm-n8n', '_npx'),
    join('/tmp', 'npmcache', '_npx'),
    join(env.HOME ?? '', '.npm', '_npx'),
  ].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, 'node_modules', 'n8n', 'bin', 'n8n');
      if (existsSync(candidate)) return candidate;
    }
  }
  // Last resort: an `n8n` on PATH.
  for (const dir of String(env.PATH ?? '').split(':')) {
    const candidate = join(dir, 'n8n');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Which workflows were active before a deploy? `n8n import` can deactivate them. */
export function readActiveWorkflowIds(userFolder, { execFile = execFileSync } = {}) {
  if (!userFolder) return [];
  const dbPath = join(userFolder, '.n8n', 'database.sqlite');
  if (!existsSync(dbPath)) return [];
  try {
    const out = execFile('sqlite3', ['-readonly', dbPath, 'select id from workflow_entity where active=1;'], { encoding: 'utf8' });
    return String(out).split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return []; // sqlite3 missing or DB locked: preserve nothing rather than fail the deploy
  }
}

/** Only restore workflows that were active before AND are among the imported ones. */
export function publishesToRestore({ previouslyActive = [], importedIds = [], alreadyActivated = [] } = {}) {
  return previouslyActive.filter((id) => importedIds.includes(id) && !alreadyActivated.includes(id));
}

export function validateToken(token) {
  if (typeof token !== 'string' || token.length < 8) {
    throw new Error('a bridge token of at least 8 characters is required (--token or BRIDGE_TOKEN)');
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new Error('the bridge token contains characters that cannot be safely inlined into the workflow JSON');
  }
  return token;
}

/**
 * Build the deploy plan: replaced values, temp files, and the exact CLI invocations.
 * Pure enough to test — no process is started here.
 */
export function buildPlan({
  token,
  shottyUrl = 'http://127.0.0.1:8787',
  n8nUrl = 'http://127.0.0.1:5678',
  outDir = mkdtempSync(join(tmpdir(), 'shotty-n8n-')),
} = {}) {
  validateToken(token);
  for (const [label, url] of [['shottyUrl', shottyUrl], ['n8nUrl', n8nUrl]]) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${label} is not a URL: ${url}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must be http(s)`);
  }

  const files = WORKFLOWS.map((workflow) => {
    const raw = readFileSync(workflow.file, 'utf8')
      .replaceAll(TOKEN_PLACEHOLDER, token)
      .replaceAll(SHOTTY_PLACEHOLDER, shottyUrl)
      .replaceAll(N8N_PLACEHOLDER, n8nUrl);
    const json = JSON.parse(raw);
    if (workflow.activate) json.active = true;
    const outPath = join(outDir, workflow.file.split('/').pop());
    return { ...workflow, json, outPath, text: JSON.stringify(json, null, 2) + '\n' };
  });

  return {
    outDir,
    files,
    // `import:workflow --activeState=fromJson` only works in queue/multi-main mode, so
    // activation is a separate publish step that works in a regular single-process instance.
    commands: files.map((file) => ({
      file: file.outPath,
      args: ['import:workflow', `--input=${file.outPath}`],
    })),
    activations: files
      .filter((file) => file.activate)
      .map((file) => ({ id: file.json.id, args: ['publish:workflow', `--id=${file.json.id}`] })),
  };
}

function run(n8nBin, args, env) {
  execFileSync(n8nBin, args, { env, stdio: 'inherit' });
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node scripts/deploy-n8n.js --user-folder <dir> --token <bridge token> [--apply]');
    console.log('       [--shotty-url http://127.0.0.1:8787] [--n8n-url http://127.0.0.1:5678] [--n8n-bin <path>]');
    return;
  }

  const userFolder = args['user-folder'] ?? env.N8N_USER_FOLDER;
  const token = args.token ?? env.BRIDGE_TOKEN;
  const shottyUrl = args['shotty-url'] ?? env.SHOTTY_URL ?? 'http://127.0.0.1:8787';
  const n8nUrl = args['n8n-url'] ?? env.N8N_URL ?? 'http://127.0.0.1:5678';
  const n8nBin = args['n8n-bin'] ?? findN8nBin(env);
  const plan = buildPlan({ token, shottyUrl, n8nUrl });

  console.log(`n8n CLI      : ${n8nBin ?? '(not found — set N8N_BIN)'}`);
  console.log(`user folder  : ${userFolder ?? '(not set — set N8N_USER_FOLDER or --user-folder)'}`);
  console.log(`shotty       : ${shottyUrl}`);
  console.log(`callback base: ${n8nUrl}/webhook/shotty-decision`);
  for (const file of plan.files) {
    console.log(`  ${file.activate ? 'ACTIVATE' : 'import  '}  ${file.name}  (${JSON.parse(file.text).nodes.length} nodes)`);
  }
  console.log(`staged in    : ${plan.outDir}`);

  if (!args.apply) {
    console.log('\nDry run. Re-run with --apply to import.');
    return plan;
  }
  if (!n8nBin) throw new Error('n8n CLI not found; pass --n8n-bin or set N8N_BIN');
  if (!userFolder) throw new Error('user folder is required with --apply (--user-folder or N8N_USER_FOLDER)');

  for (const file of plan.files) writeFileSync(file.outPath, file.text, 'utf8');
  // MUST be read before importing: n8n deactivates imported workflows, so a read after the
  // import sees them already off and restores nothing.
  const importedIds = plan.files.map((file) => file.json.id);
  const previouslyActive = args['no-preserve-active'] ? [] : readActiveWorkflowIds(userFolder);
  const n8nEnv = {
    ...env,
    N8N_USER_FOLDER: userFolder,
    // Do not collide with a running instance's task broker.
    N8N_RUNNERS_BROKER_PORT: env.N8N_RUNNERS_BROKER_PORT ?? '5691',
  };
  for (const command of plan.commands) {
    console.log(`\n$ n8n ${command.args.join(' ')}`);
    run(n8nBin, command.args, n8nEnv);
  }
  for (const activation of plan.activations) {
    console.log(`\n$ n8n ${activation.args.join(' ')}`);
    run(n8nBin, activation.args, n8nEnv);
  }

  // Importing with the default activeState turns previously active workflows off. Restore the
  // ones we imported that were active BEFORE this deploy, so upgrading does not silently kill
  // the live demos.
  const restore = publishesToRestore({
    previouslyActive,
    importedIds,
    alreadyActivated: plan.activations.map((a) => a.id),
  });
  for (const id of restore) {
    const publishArgs = ['publish:workflow', `--id=${id}`];
    console.log(`\n$ n8n ${publishArgs.join(' ')}   # restore previous active state`);
    run(n8nBin, publishArgs, n8nEnv);
  }
  if (restore.length) console.log(`Restored ${restore.length} previously active workflow(s).`);

  console.log('\nImported. Two manual steps remain:');
  console.log('  1. Restart n8n (or re-activate "Shotty decision webhook" in the UI) so the webhook registers.');
  console.log('  2. Add a "shotty_approval_id" column to the Exceptions tab (and optionally');
  console.log('     "shotty_approval_id" to the research Decisions and reconciliation Signoffs tabs).');
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`deploy failed: ${err.message}`);
    process.exit(1);
  }
}
