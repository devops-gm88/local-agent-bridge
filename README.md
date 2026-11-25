# Shotty — a local agent the owner controls from their phone (I1–I6 + I4b)


A local agent on the owner's Mac, driven from their phone, where a write cannot execute without an approval.

[![CI](https://github.com/devops-gm88/local-agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/devops-gm88/local-agent-bridge/actions/workflows/ci.yml) **134 tests: 133 pass, 0 fail, 1 skipped** in CI run [43725253764](https://github.com/devops-gm88/local-agent-bridge/actions/runs/43725253764) - measured: the approval gate refuses every write that does not carry the owner's decision

```bash
npm test
```

**What this proves:** a local model can drive real tools, a write cannot execute without the
owner's approval from their phone, and every step is in an append-only log — on a machine that
costs nothing per token.

An agent that runs on the owner's own Mac at zero marginal cost. No cloud, no account, no
recurring fee.

The product is not a chatbot. It is **"a capability the buyer keeps running after the consultant
leaves"** — a done-for-you install plus a retainer, and proof-of-capability for proposals. It is
not a new catalogue listing.

**134 tests: 133 pass, 0 fail, 1 skipped** (`npm test`, 2026-11-15). The suite is hermetic — fake
`fetch`/`exec`, real HTTP server on port 0, no model and no network. The one skipped test indexes
the owner's own notes, so it skips on a clean clone instead of failing on a fixture it does not have.

---

## What exists now

### I1 — the loop (2026-10-17, 6 tests)
```
transport.js   MockTelegram (fixtures) | HttpTelegram (optional adapter) | createTransport()
bridge.js      runBridge(): poll -> handler -> reply -> log
log.js         appendRun() JSONL writer, makeRunId()
fixtures/      captured Telegram update JSON
```

### I2 — the model seam (2026-10-20)
```
runner.js      createOllamaRunner()       POST /api/chat to the local daemon   <- default, text
               createOllamaChatRunner()   same daemon, native `tools` + tool_calls <- I4b
               createDshRunner()          dsh headless "<task>"               <- cloud route
               createHandler()            message -> task adapter
demo_live.js   replays a captured update through the real loop, writes runs.jsonl
```

### I3 — the phone channel: local PWA (2026-10-20)
```
server.js      HTTP: phone page, POST /task, GET /health, token auth, runs.jsonl
```

### I4a — the approval gate (2026-10-20)
```
guard.js       tool classes + the rule: write / external-send require approval
tools.js       read_rows (read) · sum_rows (compute) · append_row (gated write)
approvals.js   pending queue, idempotent decide, approvals.jsonl
```
A write does not execute when requested. It opens a **pending approval** with a stable id
(`sha256(run_id + payload_hash)`); the owner approves or rejects; the decision and its outcome are
appended to `approvals.jsonl`. **A second Approve on the same id is a duplicate, never a second
write.** The queue now also **replays `approvals.jsonl` at startup**, so a LaunchAgent restart
neither loses a pending approval nor forgets that an id was already decided.

### I5 — grounding: answers come from the notes (2026-10-20)
```
context.js     curated index of the workspace notes, IDF retrieval, refusal rule, citations
```
The first version sent the question straight to a 7b model, so "when is the next stat holiday?"
came back as a generic paragraph about holidays. It now retrieves from the notes first and is told
to refuse when they do not contain the answer.

**What is indexed:** 39 files, ~900 chunks — `WORKING_KNOWLEDGE.md`, `CURRENT_STATE.md`, the build
and job logs, `MARK/Knowledge/*`, the bridge README. Client folders, legal case files and
attachments are **excluded by name** and never read.

**How retrieval works:** rare terms weigh more than common ones (IDF), chunks are length-normalised,
a query must match at least two terms or one genuinely rare one, and each citation carries the file,
line range and last-modified date so a stale note loses to a fresh one. No embeddings, no
dependencies, no network.

**Measured, 2026-10-20 (`qwen2.5:7b`):**

| Question | Answer |
|---|---|
| "Did we apply to the aged care job, and at what rate?" | *"Yes, $70/hr, 1.75× the client's $40/hr average [1]"* — 10.8 s |
| "When is the next stat holiday?" | *"The notes do not cover the next stat holiday."* — 5.6 s |
| "What is the next action for the local agent?" | names **I4b** — 6.0 s |

**Honest limits:** a 7b model is the weak link. Single-hop lookups are good; multi-hop questions
("why did we skip X and what did that save us") are unreliable. The fix is a bigger model or
better multi-hop retrieval — not a bigger prompt.

### Runtime state (not in the repository)

`state/` is created on first run: the token, the append-only `runs.jsonl` / `approvals.jsonl`
logs, the conversation tail, the sheet rows and the note-index config. `state.example/` shows the
shape; `cp -r state.example state` gives a clone an empty one. It is git-ignored because it holds
the token and the owner's rows.

### I6 — a name, an identity and memory (2026-10-20)
```
state/name         what it is called (default: Agent)
state/session.jsonl  the last turns of the conversation, reloaded on restart
state/token        the persistent token, so the Home Screen link survives restarts
```
The prompt now carries **facts about itself** — name, model, today's date, what it can do — plus
the **last six turns** of conversation. There is also a `GET /healthz` identity check: name,
model, notes count and uptime.

Renaming: `echo Shotty > state/name` then restart (or `./install-service.sh` again). `AGENT_NAME`
in the environment overrides the file.

---

## I4b — the model drives the tools (2026-10-20)

`n8n_demo/` in this repository carries the generated workflows and their own guard harness,
so the n8n port is verifiable here rather than in a separate folder.

The plan's risk note was: *one successful tool call does not prove a chain.* The implementation and
the exit tests are shaped around that. `npm test` includes a **three-step chain** where each model
turn consumes the previous tool result, and the chain was also run against the real model.

### 1. MCP tool wiring — the model (or any MCP client) chooses the tool
```
mcp.js         JSON-RPC 2.0 core: initialize, tools/list, tools/call, ping
               toMcpTools()   MCP wire form    toModelTools()  Ollama `tools` form
mcp_server.js  runnable stdio MCP server: node mcp_server.js
```
There is **one tool definition** (`tools.js`): name, description, JSON-Schema input. It is handed to
the local model as its native `tools` array and served over MCP. No second copy can drift.

```
read_rows   read      Count the rows in the owner's rows sheet.
sum_rows    compute   Sum a numeric field (default "amount"); returns count and total.
append_row  write     Append one row object — always waits for the owner's approval.
```

The MCP server speaks the real protocol over newline-delimited JSON-RPC on stdio. Verified live:

```
$ printf '...initialize...\n...tools/list...\n...tools/call sum_rows...\n' | node mcp_server.js
initialize: {'name': 'shotty', 'version': '0.4.0'} {'tools': {'listChanged': False}}
tools/list: ['read_rows', 'sum_rows', 'append_row']
tools/call sum_rows: {"rows":2,"field":"amount","counted":2,"total":446}
```

A write over MCP is **not** executed: it returns `pending_approval` with the approval id. The gate
cannot be bypassed by calling it from an MCP client instead of the phone.

Mount it in an MCP client:
```json
{ "command": "node",
  "args": ["/path/to/local-agent-bridge/mcp_server.js"] }
```

### 2. The model tool-call loop — `agent.js`
```
owner message
  -> retrieve notes, build prompt, hand the model the tool list
  -> model returns tool_calls
  -> read/compute tools execute; result returned as a `tool` message
  -> model sees the result and may call another tool ... (MAX_TOOL_STEPS, default 6)
  -> model returns text = the reply
write tool -> opens an approval, loop stops at pending_approval, nothing is written
```
`POST /task` now uses this handler. `/tool` still exists for direct callers and is still gated.

**Exit test — hermetic, part of `npm test`:** a scripted model calls `read_rows`, then `sum_rows`,
then `read_rows`, then answers. The test asserts three executed steps, four model turns, and that
each turn's context contains every previous tool result (`test/i4b_agent.test.js`).

**Same chain, measured live** against `qwen2.5:7b` through `POST /task` (2026-10-20, port 8788):

| | |
|---|---|
| Steps | `read_rows` → `sum_rows` → `read_rows` |
| Duration | **18,166 ms** |
| Reply | *"There are 2 rows in the sheet. The total of the "amount" field across these rows is 446."* |
| Steps array | `[{rows:2}, {rows:2, total:446}, {rows:2}]` |

**Honest limit found live:** on one attempt the 7b model answered in prose instead of calling
`append_row` (status `ok`, zero steps). Tool selection is a model behaviour, not a code guarantee.
An explicit *"call the append_row tool … do not reply in text"* made it call correctly. The loop
records `steps`, so a miss is visible in `runs.jsonl` instead of being mistaken for success.

### 3. Approve / Reject buttons on the phone page
```
page.js        the page + its inline script, split out of server.js so it can be tested
```
- The page loads `GET /approvals` on open, so an approval created before a reload is still actionable.
- Each pending approval renders as a card with the tool name, the exact payload and **Approve /
  Reject** buttons that call `POST /approve`.
- A write returned by `POST /task` renders its approval card immediately.
- The result is reported honestly: *"Approved — executed exactly once."*, *"Rejected — nothing was
  executed."*, *"Already decided — nothing ran again."*

The page's **real inline JavaScript is executed in `node:vm` against a DOM stub** in the test suite —
both buttons are clicked, the request body is checked, and the result text is asserted. A page that
merely contains the word "Approve" would not pass.

### 4. Scheduled end-of-day summary
```
summary.js     summarize() deterministic from runs.jsonl + approvals.jsonl
               createSummaryScheduler() once per local day, catch-up on start
state/summaries.jsonl
GET /summary
```
No cron and no cloud scheduler: the long-running process ticks once a minute. At or after
`EOD_SUMMARY_HOUR` (default 18) it writes **one** summary for the local day; the summaries file is
its own "already ran today" marker, so a restart does not duplicate it. It catches up immediately on
start, so a Mac asleep at 18:00 still reports when it wakes.

The summary is deterministic — counts and outcomes read from the same logs the rest of the product
audits — not another generation that can be wrong. The phone page shows the latest one on load.

Live example (`EOD_SUMMARY_HOUR=0` forced, state from this session):
```
Shotty — end of day 2026-10-20
Tasks today: 27 (ok 25, errors 0, waiting for approval 2)
Average reply: 22393 ms
Approvals: 0 pending · 2 approved (2 executed) · 1 rejected
Latest:
· Call the append_row tool right now with arguments {"row":{"client":"re… → pending_approval
· Append a row for client reject-me with amount 1. Use append_row. → ok
· Step 1: use read_rows to count the rows in the sheet. Step 2: then use … → ok
```

### 5. The stale-origin failure message, fixed
Before: opening an old IP/home-screen link showed only `Request failed: Load failed`.
Now:
- The page probes `GET /healthz` on load. If it cannot reach the server it shows a banner:
  *"Cannot reach Shotty at http://&lt;old-ip&gt;. That address is probably stale — the Wi-Fi or
  tailnet address changed since this page was added to the Home Screen. Use the tailnet address
  instead: **http://&lt;tailnet-ip&gt;:8787/** — then Add to Home Screen again."*
- Every failed task shows the same guidance **and** keeps the original browser error
  (`Request failed: Load failed`) for diagnosis.
- The tailnet address is `TAILNET_URL` (default empty), set explicitly by
  `install-service.sh` from `tailscale ip -4`. Nothing is hard-coded at runtime except that default.
- `./phone.sh` also prints the tailnet link when Tailscale is up.

### 6. `/healthz`
```json
{ "ok": true, "name": "Shotty", "model": "qwen2.5:7b", "notes": 39,
  "uptime_s": 6, "started_at": "2026-10-20T20:13:22.113Z" }
```
Behind the same token as every other endpoint. `/health` is kept unchanged for older callers.


---

## I4b upgrade — the invoice job, and the external approval API (2026-10-23)

The first real job ported from `n8n_demo/workflow.json` into Shotty's tool loop, plus the API
that lets n8n use Shotty as its human-approval surface.

### The engine is a faithful port, not a reimplementation
```
engine.js        pure, no I/O: normalise intake · match vendor policy · parse model output · adjudicate
```
It ports the three n8n Code nodes that make the invoice demo safe (`Normalise Intake`,
`Lookup Vendor Policy`, `Parse and Validate`). The **eight guard cases from
`n8n_demo/tools/test_guard.js` are re-run against it** in `test/i4b_invoice.test.js` — same
expectations, including unknown vendor, over-limit, inactive account, confidence floor, fenced
JSON and prose output.

One hardening over the original: a missing `approved_limit` used to compare false against `NaN`
and read as "no limit". It now fails closed with `approved limit is missing or not a number`.

### The invoice tools
```
invoice_tools.js   check_invoice (read) · file_invoice (gated write) · read_invoices (read)
state/vendors.json approved-supplier table seed (Northline, Kestrel, Meridian, Summit)
state/invoices.jsonl  the filed ledger (JSONL stand-in for the client's sheet)
```
`file_invoice` runs the deterministic policy check **twice**: `precheck()` before an approval is
opened, so the owner is never asked to approve something the policy already rejects; and again in
`run()`, so a replayed queue or direct caller cannot bypass it. The tool refuses with
`rejected_by_policy` and no approval exists.

### The external approval API
```
POST /api/approvals      {run_id, tool, payload, callback_url?, title?} -> 202 {id, status}
GET  /api/approvals/:id  -> pending | executed | rejected | failed
POST /approve            the phone decision (existing endpoint)
```
`callback_url` is POSTed the decision after it is durably logged, with the bridge token in
`x-bridge-token`. A failed callback never un-does the decision — it is recorded as a `callback`
line in `approvals.jsonl`. A duplicate approval fires no second callback.

### Verified live, 2026-10-23 (port 8788, real Ollama `qwen2.5:7b`)

| Step | Result |
|---|---|
| `POST /task` "check then file Northline $1,840" | model called `check_invoice` → `file_invoice`; **`pending_approval` in 29,173 ms** |
| `POST /api/approvals` (n8n-style, with callback) | `202`, id `0ccf1f64…`, status `pending` |
| `POST /approve` approve | `executed`; one line in `state/invoices.jsonl`; callback **HTTP 200** received with `decision: approve`, `executed: true` |
| `POST /approve` again | `duplicate`; **no second callback**; ledger still one line |
| over-limit invoice (Northline $4,200) | **`422 rejected_by_policy`** — no approval opened, owner never asked |
| `approvals.jsonl` | `pending`, `decision`, and one `callback {ok:true,status:200}` line |

**Honest limit observed live:** asked to file an invoice where currency and reference were not in
the request, the 7b model filled them in (`USD`, `INV-12345`). The deterministic fields it was
given (vendor, amount) were correct, and the guard still governs eligibility — but do not leave
free-text fields blank in a real intake; populate them from the invoice document.

### 3. Both decision channels, one ledger (2026-10-23, slice 3)
The Gmail reply loop and the phone buttons used to be independent decision surfaces. Now the reply
path reconciles through Shotty before it writes anything:

```
Parse Decision -> Has Shotty approval?  (id present in the Exceptions row)
   yes -> Tell Shotty (POST /approve, suppress_callback:true) -> Shotty Answer
            -> Already decided on phone?
                 yes (duplicate on a first decision) -> No-op -> Gmail: Mark Processed
                 no                                  -> Conflict? -> existing n8n path
   no  -> Conflict?  (unchanged pre-Shotty behaviour)
```

- `suppress_callback:true` is the key: n8n owns the Sheet write for an email decision, so Shotty
  records and executes its side **without** firing the phone webhook (which would append the same
  invoice to the Sheet twice).
- If the phone already decided, `/approve` returns `duplicate` plus `previous {decision, executed,
  decided_at}`; the reply is marked processed and **nothing is written twice**.
- A conflict/agree route still runs its existing n8n handling, and if Shotty is unreachable the HTTP
  node continues (`onError: continueRegularOutput`) so email handling degrades, not breaks.
- Generated into `n8n_demo/workflow_reply.json` by the same build script; `--check` covers it.

**Verified live 2026-10-23** (port 8788 + a callback receiver): email-style
`{decision:'approve', suppress_callback:true}` → `executed`, **0 callbacks**, one ledger line;
a second email decision → `duplicate` with `previous.decision='approve'`; a phone-style decision on
another approval still fired **one** callback (HTTP 200).
**Not verified:** a full Gmail round trip, because the reply workflow's Google credentials are
install-time values. The decision logic and routing are executed in the test suite.


### Decision approvals — the research and reconciliation pipelines (2026-10-24, slice 5)
The invoice job executes in Shotty; the research and reconciliation demos execute in n8n. Both now
use the same phone approval surface through a **decision-only** approval:

```json
POST /api/approvals
{
  "run_id": "research-batch-B01-row-12",
  "execute": false,
  "title": "Row 12 — missing source",
  "actions": [
    { "id": "approve", "label": "Approve" },
    { "id": "replace", "label": "Replace" },
    { "id": "drop",    "label": "Drop" }
  ],
  "fields": [
    { "label": "Row", "value": "12" },
    { "label": "Defect", "value": "missing source URL" }
  ],
  "payload": { "row_id": 12 },
  "callback_url": "http://127.0.0.1:5678/webhook/..."
}
```

- `execute:false` means Shotty records the human decision and calls back; it runs no tool. n8n
  executes the consequence (`REPLACE`/`DROP`/`ACCEPT`...). `execute` defaults to `true`, so every
  existing invoice approval is unchanged.
- `actions` is the workflow's vocabulary (max 4, ids `[a-z0-9_-]{1,32}`); a decision outside the
  set is a **400**. `fields` becomes a readable card (label/value rows) instead of raw JSON.
- Terminal status is `decided`, and the callback carries `decision`, `action`, `executed:false`,
  `execute:false`, `fields`. A repeated decision is a `duplicate` with `previous`.
- The page renders the action set as buttons, and **polls `/approvals` every 10s**, showing the
  pending count in the title — a decision raised by any of the three pipelines reaches the phone
  without a reload.

**Verified live 2026-10-24** (port 8788 + callback receiver, then the installed tailnet service):
research approval with `Approve/Replace/Drop` → `replace` → `decided`, callback
`{decision:"replace", action:"replace", executed:false, execute:false, fields:[...]}`;
duplicate `approve` → `duplicate` + `previous.replace`; `accept/dispute` approval rejected
`approve` with **400 `decision must be one of: accept, dispute`**; zero pending afterwards. Page
and poll logic execute in the UI tests.

**Not yet wired:** each new pipeline still needs its own n8n decision webhook (the generated
`workflow_shotty_decision.json` validates invoice vocabulary `approve|reject`). The Shotty side is
ready; the research/reconciliation webhook normalisers are the next slice.


### One approval surface for all three pipelines (2026-10-26, slice 6)
Both demo pipelines are now wired to the same phone approval API.

**Invoice card polish:** the invoice HTTP node now sends `fields` (Vendor / Amount / Approved
limit / Why held) and the hold `reason` in the payload, so the phone card is readable and
`file_invoice_override` records `override_reason` instead of an empty string.

**Research — APPROVE / REPLACE / DROP** (`workflow_research.json`):
```
Append Exceptions -> Ask Shotty (research) -> Attach Research Approval -> Pending Decisions
```
Each exception opens a decision-only approval with `fields` (Row / Company / Defects / Source) and
`payload {exception_id, batch_id}`. `Pending Decisions` now carries `shotty_approval_id` into the
row it writes for the audit.

**Reconciliation — ACCEPT / DISPUTE** (`workflow_reconciliation.json`):
```
Append Discrepancies -> Only Material -> Ask Shotty (reconciliation)
  -> Attach Reconciliation Approval -> Pending Signoffs
```
Only discrepancies at or above materiality are sent to the phone.

**Two new decision webhooks** (generated, published by the deploy):
- `workflow_shotty_research_decision.json` — `shotty-research-decision` → validates
  approve/replace/drop → appends the signed row to the `Decisions` tab.
- `workflow_shotty_reconciliation_decision.json` — `shotty-reconciliation-decision` → validates
  accept/dispute → appends to the `Signoffs` tab.

Both carry `shotty_approval_id`, `reviewer/approver: phone`, and the decided-at time; invalid
callbacks go to a no-op, so a malformed payload cannot write a row.

`scripts/deploy-n8n.js` now imports **7 workflows**, publishes the **3 decision webhooks**, and
restores any workflow that was active before the import (so research/reconciliation keep running).

**Honest limits:** the phone decision appends the outcome row but does not update the original
Exceptions/Discrepancies row (the invoice Gmail path is still the only one that updates its
exception row). The generated flows are covered by build and node-code tests; they need a live
deploy + one form run per demo to be counted as demonstrated.

### What this changes about the product
n8n keeps intake, Sheets/Gmail and the audit trail; Shotty provides the local model, the
deterministic guard and the phone approval surface. The port is: `workflow.json` gains an HTTP
Request node to `POST /api/approvals` and a decision webhook, while `engine.js` is generated into
the n8n Code nodes by `scripts/build-n8n-code.js` (next slice). Until that generation exists, do
not claim the two copies are identical in the workflow JSON.


### The n8n port: generated, wired, executed (2026-10-23, slice 2)

An n8n Code node cannot import `engine.js`, so the port is **generated**, not copy-pasted:

```
bridge/scripts/build-n8n-code.js
  portable region of engine.js  ->  jsCode of Normalise Intake · Lookup Vendor Policy · Parse and Validate
  plus the Shotty wiring: Ask Shotty (HTTP Request) · Attach Approval ID
  plus workflow_shotty_decision.json (the callback webhook)
```
`node scripts/build-n8n-code.js --check` fails if the workflow on disk is stale. The bridge test
suite runs that check, then **executes the shipped node text** and deep-compares it with
`engine.js`, then runs the n8n demo's own `tools/test_guard.js` → **8/8**.

**Wired into `n8n_demo/workflow.json` (exception branch):**
```
Exception Record -> Ask Shotty (POST /api/approvals) -> Attach Approval ID -> Exception File + Sheet: Exceptions -> Email
```
The HTTP node sends `tool: file_invoice_override`, the exception invoice, a `callback_url` and a
title. The token is the install-time placeholder `REPLACE_WITH_BRIDGE_TOKEN` (same pattern as the
spreadsheet id). On the exception path the human decision **is** the override, so
`file_invoice_override` records `policy_override: true` and the failed reasons in the ledger.

**`n8n_demo/workflow_shotty_decision.json`** is the webhook n8n receives: `shotty-decision` →
validate → on approve append to `Approved`, always append to `Decisions`. It copies the
spreadsheet id and credential id from the main workflow so import is one step.

**Verified in real n8n 2.43.7 (CLI execution, 2026-10-23):**

| Step | Result |
|---|---|
| import the generated workflow into an n8n instance and execute it | `status: success` |
| the HTTP Request node hit Shotty | pending approval created: `file_invoice_override`, Northline **4,200 CAD**, title "Northline Electrical Supply — 4200 CAD" |
| Shotty's callback to `…/webhook/shotty-decision` | reached n8n (404 in that test instance because the decision webhook was not activated there) |
| decision webhook logic | executed in tests: approve → `approved_override` row; reject → `rejected`; invalid → ignored |

**Honest limits for this slice:**
- The decision webhook has not been executed end-to-end inside a listening n8n, because the local
  instance is authenticated and its credentials are live. Its Code node is tested; its Sheet nodes
  need the real spreadsheet.
- Add a `shotty_approval_id` column to the `Exceptions` tab to persist the id; autoMap ignores it
  until the column exists.
- The two decision channels are now reconciled (below), but the reconciliation relies on the
  `Exceptions` tab having a `shotty_approval_id` column. Without it the reply path skips Shotty and
  behaves exactly as before.
- If a phone approval executed but its webhook callback failed, a later email reply sees a
  `duplicate` and deliberately does not re-file; recover from `approvals.jsonl`, do not re-send.
- The only thing this proves about the invoice job is the logic and the wiring — the Sheet/Gmail
  connector in n8n is the existing one, and Shotty's own ledger is still JSONL.


### Deploying the workflows to n8n (2026-10-23, slice 4)
The repo files deliberately carry install-time placeholders (the bridge token must never be
committed). `scripts/deploy-n8n.js` makes a throwaway copy with real values, imports all seven
workflow files (invoice, reply handler, research, reconciliation and three decision webhooks),
publishes the webhooks, and restores the active state of the pipelines it imported:

```
node scripts/deploy-n8n.js --user-folder ~/.n8n --token "$BRIDGE_TOKEN"           # dry run
node scripts/deploy-n8n.js --user-folder ~/.n8n --token "$BRIDGE_TOKEN" --apply
  # optional: --shotty-url http://127.0.0.1:8787 --n8n-url http://127.0.0.1:5678
  #           --n8n-bin /path/to/n8n
```

It refuses a missing/unsafe token, prints the exact substitution (`shottyUrl`, `n8nUrl`,
callback base), imports the main workflow and reply handler **inactive** (a deploy must not make
Gmail start polling), publishes `Shotty decision webhook`, and prints the two remaining manual
steps: **restart n8n** (a running instance does not register a new webhook) and **add the
`shotty_approval_id` column** to the Exceptions tab. The workspace copy of `workflow*.json` is
never modified.

**Verified 2026-10-23 against a real, listening n8n 2.43.7** (`N8N_USER_FOLDER=/tmp/shotty-deploy`,
port 5680): deploy imported 3 workflows and published the webhook; `POST
/webhook/shotty-decision` returned 200 and the execution ran
`Shotty decision → Normalise Decision → Valid decision? → Approved?` with
`Normalise Decision` output `{ok:true, queue:approved_override, policy_override:true}`. It then
failed at `Sheet: Approved` with a Google OAuth error — expected, because that throwaway instance
has no credentials. A real Shotty approval with `callback_url` set to that webhook returned
**HTTP 200**, and n8n recorded a second execution.

**Still not verified:** the Sheet append with real credentials and one real Gmail APPROVE round
trip — both need the live instance and its Google account.

---

## Endpoints

| Endpoint | Does |
|---|---|
| `GET /` | the phone page (login form without a token) |
| `GET /healthz` | name, model, notes count, uptime, started_at |
| `GET /health` | older health shape: model + uptime |
| `POST /task` `{text}` | the model tool-call loop. `ok`/`pending_approval`/`max_steps` → 200; error → 502 |
| `GET /approvals` | the pending queue |
| `POST /approve` `{id, decision, suppress_callback?}` | executing approvals: `approve` runs once, `reject` records · decision-only approvals: any configured action → `decided` · repeat = `duplicate` + `previous` · `suppress_callback:true` for the email path · unknown id = 404 |
| `POST /tool` `{tool, payload}` | direct tool call: read → runs now · write → **202 `pending_approval`** |
| `GET /summary` | the latest end-of-day summary, or `null` |
| `GET /help` | the cheat sheet |
| `POST /api/approvals` `{run_id, tool?, payload, callback_url?, title?, execute?, actions?, fields?}` | external (n8n) opens an approval; executing tools are prechecked → 422 `rejected_by_policy`; `execute:false` + `actions` is a decision-only approval |
| `GET /api/approvals/:id` | one approval's state: `pending` / `executed` / `rejected` / `failed` |

## Exit test — live on 2026-10-20 (port 8788, real Ollama `qwen2.5:7b`)

| Step | Result |
|---|---|
| `POST /task` "append a row for client live-proof, amount 321" | model chose `append_row`; **`pending_approval` in 15,208 ms** |
| rows file while pending | **1 line — nothing written** |
| `GET /approvals` | one pending, id `8b32bfc9…` |
| `POST /approve approve` | `executed`, rows file 2 lines |
| `POST /approve approve` again | **`duplicate`** — rows still 2 lines |
| `approvals.jsonl` | `pending` + `decision` lines with the same `payload_hash` (`938d69c9…`) |
| second write → `POST /approve reject` | `rejected`, rows unchanged, `executed:false` in the log |
| three-step chain task | `read_rows` → `sum_rows` → `read_rows`, 3 steps, correct answer (2 rows / 446) |
| `GET /healthz` over the tailnet | `200`, name Shotty, 39 notes, uptime |
| `npm test` | **133 passing, 0 failing, 1 skipped** (2026-11-15) |

## Security notes

- Binds `127.0.0.1` by default. The tailnet IP is the only thing that should ever be set.
- Token in the env, never committed. Rotate with `openssl rand -hex 16`.
- The page embeds the token because it is a single-user page behind the tailnet; do not put this
  server on a public interface without a real login in front of it.
- Request bodies are capped at 16 KB; anything larger is rejected.
- `runs.jsonl` and `approvals.jsonl` are append-only and record every tool step, every approval and
  every decision — auditable with `tail`.
- A write has no path around the gate: `/tool`, the model loop and the MCP server all open an
  approval instead of executing.

## Run it

**One command for the phone: `npm run phone`.** It stops any old server on port 8787, mints a
fresh token (that is the rotation), binds to the Wi-Fi address, opens the Mac browser and prints the
URL to type on the phone. Re-running it is always safe.

**The commands have to run from this folder.** `npm run serve` fails with *"Missing script: serve"*
if you are anywhere else, which is what it says, not what it means. There is nothing to install: the
bridge has no npm dependencies.

```
git clone https://github.com/devops-gm88/local-agent-bridge && cd local-agent-bridge
cp -r state.example state     # empty logs, a name and a KB config; the token is minted on first run
npm test                      # 134 tests: 133 pass, 1 skips off the owner's machine
export BRIDGE_TOKEN=$(npm run --silent token)
npm run serve
```

Then open **`http://127.0.0.1:8787`** in a browser on the Mac and paste the token when asked.

### Phone

**Same Wi-Fi:** `npm run serve:lan` prints `http://<lan-ip>:8787/?t=<token>`. Share → **Add to
Home Screen**.

**Tailnet (works anywhere):**
```
brew install --cask tailscale     # sign in, same account on the Mac and the phone
./install-service.sh              # binds 0.0.0.0 and prints the tailnet URL
```
Open `http://<tailnet-ip>:8787/?t=<token>` on the phone → **Add to Home Screen**. If the tailnet
address ever changes, the page itself tells you to use the current one (see I4b §5).

The Mac must stay awake: `caffeinate -dims npm run serve`.

## Run it as a service — survives closing the terminal

```
./install-service.sh      # starts at login, restarts if it dies
./uninstall-service.sh    # stops it and removes the plist
```

It installs a macOS LaunchAgent (`ca.localagent.bridge`) with `RunAtLoad` and `KeepAlive`, a
**stable token** from `state/token`, the tailnet URL and `EOD_SUMMARY_HOUR`, and logs to
`/tmp/local-agent.log`. The phone URL does not change between reboots unless you rotate with
`./phone.sh --rotate`.

It binds `0.0.0.0` so a DHCP change does not break it. The token is the only protection — if that
is not enough for a network you join in public, set `HOST` to the LAN address in the plist instead.

| Env | Default | Meaning |
|---|---|---|
| `BRIDGE_TOKEN` | — | **required**, ≥8 chars; the only secret — env only, never in the repo |
| `HOST` | `127.0.0.1` | LAN IP or Tailscale IP for the phone. Empty falls back to `127.0.0.1` |
| `PORT` | `8787` | |
| `MODEL` | `qwen2.5:7b` | the 14b did not answer inside 180 s cold |
| `RUNNER` | `ollama` | `dsh` switches to the cloud route (text-only, no tool loop) |
| `TAILNET_URL` | empty | the address the stale-origin message tells you to use |
| `EOD_SUMMARY_HOUR` | `18` | local hour of the end-of-day summary |
| `EOD_SUMMARY` | `on` | `off` disables the scheduler |
| `MAX_TOOL_STEPS` | `6` | tool-call loop cap; stops instead of looping |
| `GROUNDED` | `on` | `off` runs the bare model with no note index |
| `BRIDGE_ROWS` / `BRIDGE_APPROVALS` | `state/…` | `mcp_server.js` paths only |

n8n install-time values (not day-to-day): `REPLACE_WITH_BRIDGE_TOKEN` and the Shotty URL in
`n8n_demo/workflow.json`; the spreadsheet id and credential ids already there; the
`callback_url` host/port in the same node. Regenerate the nodes with `node scripts/build-n8n-code.js`.

## Channel decision — 2026-10-20

| Channel | Verdict | Why |
|---|---|---|
| **Local PWA over the tailnet** | **CHOSEN** | No third party in the path, no bot token, no account. Approval buttons are buttons. Works on any phone, and it ships to any client |
| Telegram | kept as an **optional adapter** | Free token, 2 minutes, works today — but a third party, and often blocked on corporate networks, so it is a liability as a *product* channel |
| **iMessage** | **rejected, verified** | No Apple bot API. `~/Library/Messages/chat.db` returns **`Operation not permitted`** without a manual Full Disk Access grant (tested on this machine 2026-10-20). The bot would message as the owner, with no separate identity. And it needs a Mac awake 24/7 — so it cannot ship to a Windows client |

## ⚠️ Finding that corrects the architecture note

`local_agent_mvp.md` previously said I2 was *"`dsh headless` against the local Ollama model"*.
It is not: `dsh headless` routes to `deepseek-official` (cloud) and exits `MISSING_CREDENTIAL`
without `DEEPSEEK_API_KEY`. The local path is Ollama directly, which is the default here.

## Not built yet

- **A full Gmail round-trip test and the Sheet write with real credentials** — the routing and
  the webhook are tested; the live Google side is install-time. Send one real APPROVE and confirm
  the `Approved` tab before quoting it.
- **MCP resources / prompts / sampling** — only the tools capability is implemented, which is all
  this product needs.
- **A real client-system connector** — `append_row` and `file_invoice` still write local JSONL
  stand-ins. Swapping in Sheets/GHL is one `run()` body; the gate does not change. Until then, do
  not claim a Sheets integration in a proposal.
- **JSON-Schema validation of tool arguments** — arguments are validated by each tool's `run()`,
  not by a schema validator. Enough for three tools; not enough for a plugin marketplace.
- **Windows 11** — everything verified here is macOS. Do not quote a Windows install until tested.
- **A physical-phone tap test** — the page's JavaScript is executed in a DOM stub in the test suite
  and the page was served live, but a human thumb on glass has not been recorded.
- A real `HttpTelegram` implementation, only if the Telegram adapter is ever wanted.