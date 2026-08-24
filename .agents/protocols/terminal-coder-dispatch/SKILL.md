# Skill: Terminal Coder Dispatch

You are a **head agent** driving a feature's subtasks through one or more **coder terminals**.
Your turn ends after you dispatch a subtask. A new turn begins when the coder's completion
message arrives at your prompt — text delivered to an idle agent terminal *is* a turn.
Continuity is carried by your own conversation context, which persists across those turns
by construction. There is no loop to hold, no join to poll, no batch to manage.

> **You arrived here from a one-line directive** (e.g. the `Drive` feature-workflow toggle
> prepended "read and follow `.agents/protocols/terminal-coder-dispatch/SKILL.md`"). This skill
> is the complete contract. Read it once, then drive.

---

## 0. Quick Start

1. Read your dispatch prompt — it contains your team roster, plan IDs, and the feature file path.
2. Read the feature file for subtask sequencing.
3. Dispatch the first subtask: POST /terminals/verb/ptySendPrompt with dispatch field.
4. On callback: review git diff, not the coder's self-report.
5. Resend fixes to the same terminal, or escalate after two failures.
6. Clear a terminal only when at rest (completion + next work elsewhere).
7. A feature watch is armed automatically by the system for drive-mode dispatches — no action needed.

Everything else in this skill is reference for edge cases. Consult §1–§10 when you hit them.

---

## 0.1. Do NOT

- Do NOT query kanban.db directly with sqlite3. Use the API endpoints (GET /kanban/plans, GET /kanban/plan). The plan IDs are in your dispatch prompt.
- Do NOT grep the codebase to verify work before dispatching. The kanban column is the system's record — a different evidentiary class than a coder's self-report. Verification happens on callback (§5), not before dispatch.
- Do NOT re-register standing orders. They were installed at team creation. Check with GET /terminals/standing-orders only if you suspect a problem.
- Do NOT enumerate terminals more than once per startup. The roster is in your dispatch prompt.

---

## 1. Addressing a terminal — the route table

The API port is in `.switchboard/api-server-port.txt` (relative to the workspace root, which
is your CWD). The bearer token, if set, is in your environment as `SWITCHBOARD_API_TOKEN`.
Every `curl` below carries `--max-time` and uses `127.0.0.1` (never `localhost` — the listener
is v4-only and `localhost` can resolve to `::1`, bypassing it).

```bash
PORT=$(cat .switchboard/api-server-port.txt)
BASE="http://127.0.0.1:$PORT"
AUTH=""; [ -n "$SWITCHBOARD_API_TOKEN" ] && AUTH="-H \"Authorization: Bearer $SWITCHBOARD_API_TOKEN\""
```

| Purpose | Call |
| :--- | :--- |
| **Primary — send a prompt (both hosts)** | `POST /terminals/verb/ptySendPrompt` with `{ "name": "<friendlyName>", "data": "<prompt>", "clearBeforePrompt": false }` |
| **Dispatch a subtask (both hosts)** | the same call plus `"dispatch": { "planFile"\|"planId", "role" }` — registers the dispatch and attaches the protocol directives in one call (§3.5) |
| Enumerate live terminals | `POST /terminals/verb/ptyListTerminals` with `{}` → `{ terminals: [...], hiddenTerminals: [...] }` |
| Rest a terminal — reset its context | `POST /terminals/verb/ptyClearTerminal` with `{ "name": "<friendlyName>" }` |
| Extension-host alternative | `POST /taskViewer/verb/sendToTerminal` with `{ "name", "input" }` |
| Standalone alternative | `POST /terminals/verb/sendToTerminal` with `{ "terminalName", "text" }` |

**`ptySendPrompt` is the recipe this skill teaches.** One route, one payload shape, both
hosts, working today: the extension serves it through `handlePtyVerb` → `_ptyHostVerb` → the
pty host, and standalone serves it in `bootstrap.ts` → `deliverPrompt`. Both apply standing
orders. Both own bracketed-paste framing, chunking, the per-terminal lock and the confirm CR.

> **Do not use `sendToTerminal` as your primary dispatch route.** It is a *taskViewer* verb
> served at `/taskViewer/verb/*` on the extension host and at `/terminals/verb/*` on
> standalone — with a **different payload** on each (`{name, input}` vs `{terminalName, text}`).
> One call cannot be written that works on both hosts. Use `ptySendPrompt`, which is identical
> on both. The `sendToTerminal` rows above are fallbacks for a host that does not serve
> `ptySendPrompt` — pick the row that matches the host you are on.

### `clearBeforePrompt: false` is mandatory and non-obvious

Both hosts currently treat an **absent** `clearBeforePrompt` as `false` — the extension injects
the config default only when a caller passes `clearBeforePromptFromConfig: true`
(`TaskViewerProvider.ts`), and standalone does the same (`bootstrap.ts`). Do not rely on that.
The meaning of an omitted field has already moved once, and if it moves back, every dispatch
you send wipes the coder's conversation and the symptom is a coder with no memory of work it
did minutes earlier. Pass it explicitly on every send:

```bash
curl -s -X POST "$BASE/terminals/verb/ptySendPrompt" $AUTH \
  -H "Content-Type: application/json" \
  --max-time 30 \
  -d '{"name":"coder-1","data":"<your prompt>","clearBeforePrompt":false}'
```

### Name resolution

`ptySendPrompt` matches `friendlyName` exactly. Enumerate with `ptyListTerminals` and copy the
name verbatim — never guess, never construct it from a role. Hidden terminals ride a sibling
`hiddenTerminals` key and are not in `terminals`.

```bash
curl -s -X POST "$BASE/terminals/verb/ptyListTerminals" $AUTH \
  -H "Content-Type: application/json" --max-time 10 -d '{}'
```

---

## 2. Knowing your own address

Your terminal name is `SWITCHBOARD_TERMINAL` in your own environment, and your instance id is
`SWITCHBOARD_AGENT_INSTANCE_ID` — both injected at terminal creation. `SWITCHBOARD_TERMINAL`
is the reply address you give the coder. Nothing else can supply it: the extension process
cannot read it (it is injected into a pty child, not the host), so a directive can never bake
it in.

```bash
echo "My terminal name: $SWITCHBOARD_TERMINAL"
```

**A prompt sent without a reply address produces a coder that finishes silently** — the single
most likely failure of this pattern. Always tell the coder where to report.

---

## 3. The callback belongs in a standing order, not in the prompt

A standing order (`src/services/standingOrders.ts`) is a durable instruction persisted at the
`terminals.standingOrders` DB config key and appended automatically to every `ptySendPrompt`
delivered to the terminal it belongs to. Register the callback contract **once**, when the
coder is linked to you — not in each dispatch prompt. A head agent that must remember to append
a callback line to every prompt will eventually omit one, and the result is a coder that
finishes and reports to nobody while the driving agent waits forever with nothing to diagnose.
A standing order cannot be forgotten.

### Get the orientation right — this is the one thing that silently breaks

The two fields are **not** "head" and "worker". They are:

- **`parent`** — the terminal that **receives** the block. `applyStandingOrders` selects with
  `o.parent === <recipient>`.
- **`child`** — the terminal the instruction is **about**. It is rendered in the third person:
  `- Regarding terminal "<child>": <instruction>`.

So to make **your coder report to you**, the order is `parent: "coder-1"` (the coder receives
it) and `child: "<your terminal name>"` (it is about you). Registering it the other way round
installs a block that gets delivered to *you*, about a coder that is never told anything — and
the coder finishes silently. Write the instruction so it reads correctly after the
`Regarding terminal "<child>":` prefix.

**API:**

```bash
# List standing orders
curl -s "$BASE/terminals/standing-orders" $AUTH --max-time 10

# Add a callback order: the CODER receives it, and it is about YOU.
curl -s -X POST "$BASE/terminals/standing-orders" $AUTH \
  -H "Content-Type: application/json" --max-time 10 \
  -d '{"action":"add","parent":"coder-1","child":"'"$SWITCHBOARD_TERMINAL"'","instruction":"it is your head agent. When you finish a task, send it a message naming what you changed and what to review. Do not wait to be asked."}'
```

Delivered to `coder-1`, that renders as:
`- Regarding terminal "<your terminal name>": it is your head agent. When you finish a task, send it a message…`

**Say how, not just what.** "Send it a message" is not a route. The coder is an agent in a
fleet terminal holding the same port file and token you do, so spell the call out in the
instruction — otherwise it may finish, intend to report, and have no idea how:

> `…send it a message via POST /terminals/verb/ptySendPrompt with {"name":"<that terminal>","data":"<your report>","clearBeforePrompt":false} against the port in .switchboard/api-server-port.txt.`

`available: false` in the GET response means no kanban DB is reachable — gate honestly rather
than pretending zero orders. There are no server-side caps and no truncation: a duplicate
order is not dropped, it is rendered a second time in the standing-orders block of every
prompt that terminal receives from then on.

**Treat an existing order as authoritative.** The Agents-tab group control that instantiates a
wired team installs the callback order at creation time. Do not duplicate or overwrite it —
check with GET first.

---

## 3.4. Seat safeguards ride the delivery layer — do not hand-copy them

A seat safeguard (subagent policy, git policy, skip-compilation, skip-tests, caveman output,
suppress-walkthrough, accurate-coding) is a property of the **seat**, not of the dispatch. The
delivery layer (`_ptyHostVerb` on the extension, `deliverPrompt` on standalone) appends the
configured seat directive block to every `ptySendPrompt` the seat receives — from the board,
from a lead, from a peer — using the same verbatim constants the board path composes. You do
not hand-copy these directives into your prompt body, and you do not paraphrase them. A
hand-typed sentence of prose enters the same evidential pool as the plan file and can lose an
argument to it; a composed directive block carries provenance and structural separation, and
is the same artefact the seat already obeys on the board path. If you need a safeguard applied,
configure it on the seat (Prompts tab → role addons) — do not write it into the prompt.

---

## 3.5. Register the dispatch before you send — the backstop the standing order is not

A standing order is a contract the coder must choose to honour. On 2026-08-16 a coder with a
correctly-oriented standing order finished its subtask and **sent nothing back**; the head sat
idle for eleven minutes and would have sat idle indefinitely. The floor under this pattern is
not the standing order — it is a dispatch **record** the plan-ingestion sweep reads, and a
turn-end notifier that fires when the coder's plan file advances. `ptySendPrompt` writes no
record, so the sweep never saw the dispatch and the notifier never fired.

### Do it in one call — `dispatch`

`ptySendPrompt` takes an optional `dispatch` field: `{ "dispatch": { "planId"?, "planFile"?,
"role"? } }`. When you pass it, the host registers the dispatch **itself, before delivering**,
and attaches the protocol directives the board attaches — the plan-file completion report and
Mission Control reports directive. This is the route to use, on both hosts:

```bash
curl -s -X POST "$BASE/terminals/verb/ptySendPrompt" $AUTH \
  -H "Content-Type: application/json" --max-time 30 \
  -d '{"name":"coder-1","data":"<your prompt>","clearBeforePrompt":false,
       "dispatch":{"planFile":".switchboard/plans/<plan-file>","role":"coder"}}'
# → { "success": true, "attributed": 1, "skipped": 0,
#     "directivesAttached": ["COMPLETION REPORT", "MISSION CONTROL REPORT"] }
```

Why it matters, beyond saving a call:

- **`directivesAttached` is the receipt.** Omit `dispatch` and it comes back `[]`: your coder
  was told nothing about writing a completion report, so it will finish correctly and the
  board will read it as still in flight. An empty array on a real dispatch is a defect in your
  call, not a cosmetic difference.
- **Ordering is taken out of your hands.** The host attributes before it delivers, so the
  `dispatched_at` / plan-file-mtime compare below cannot be inverted by a fast coder.
- **It fails closed.** Nothing resolved (`attributed: 0`) → `success: false` and **no prompt is
  delivered**. Fix the plan reference and re-send; there is no half-dispatched state to unwind.
- **Shape is validated.** A non-string `planId` / `planFile` / `role`, or a `role` that is not a
  known seat role, is rejected with `success: false` rather than silently coerced.

Send `dispatch` **only on a dispatch** — never on a message, and never on a coder's report back
to you. The protocol directives tell their recipient to write a completion report into a plan
file; on a report message that would make *you* advance a plan file's mtime and fire a false
`completed`.

### Fallback: the two-call form

A caller that cannot set `dispatch` (an older host, or a paste/drop path) must still register
the dispatch with the shipped `attributePastedPrompt` verb **before** it calls
`ptySendPrompt`. Registration stamps `dispatched_terminal` / `dispatched_at` on the plan row —
the exact columns the sweep's `getActiveDispatchedByTerminal` query reads. With the record in
place, the sweep's `blocked` outcome (silence past `turnEndSilenceMs`, ~90 s) and the
file-edit `completed` outcome (the coder writes its completion report) both fire a
`[switchboard:turn-end]` notice to your prompt. The notice *is* the new turn.

**Register BEFORE you send, not after.** `dispatched_at` is stamped at registration time and the
completion test is `plan-file mtime > dispatchedAt`. Registering after the coder already wrote
inverts the compare and the completion is invisible — you then get a late `blocked` instead.
One call, in this order:

```bash
# 1. Register — stamps the dispatch record the backstop reads.
curl -s -X POST "$BASE/kanban/verb/attributePastedPrompt" $AUTH \
  -H "Content-Type: application/json" --max-time 10 \
  -d '{"terminalName":"coder-1","role":"coder","planFiles":[".switchboard/plans/<plan-file>"],"workspaceRoot":"'"$PWD"'"}'
# → { "success": true, "attributed": 1, "skipped": 0 }

# 2. Dispatch — only AFTER the registration succeeded.
curl -s -X POST "$BASE/terminals/verb/ptySendPrompt" $AUTH \
  -H "Content-Type: application/json" --max-time 30 \
  -d '{"name":"coder-1","data":"<your prompt>","clearBeforePrompt":false}'
```

`planFiles` is the workspace-relative plan path (the same path you put in the dispatch prompt).
If you know the `planId`, pass `planIds: ["<id>"]` instead — it resolves without the plan-file
fallback. `workspaceRoot` is your CWD.

### Check the body — `attributed: 0` is a failed registration

The verb returns `{ success, attributed, skipped }` in the body. `success: true` with
`attributed: 0` means nothing was stamped — the plan did not resolve, the DB was not ready, or
the workspace root did not match. **A zero is a failed registration, not a success.** You are
not covered: no record, no backstop, the 2026-08-16 failure. Re-resolve the plan (check the
path, check `workspaceRoot`) and re-register until `attributed: 1`.

### One outstanding plan per terminal

`getActiveDispatchedByTerminal` is `ORDER BY dispatched_at DESC LIMIT 1`. A second registration
against a terminal already holding an unresolved plan **hides the first from the backstop** —
the sweep only ever reads the newest row. Drive **one subtask at a time per coder terminal**;
use a second coder terminal for concurrency. This matches the one-subtask-per-terminal pattern
this skill teaches, and the verb does not reject a second attribution (it is shared with the
board's paste/drop path, which must stay permissive on ~4 000 installs).

### What the wake looks like

A `[switchboard:turn-end]` message arriving at your prompt *is* the new turn — text delivered
to an idle agent terminal is a turn, same as a coder's report. Two outcomes:

- **`completed`** —
  ```
  [switchboard:turn-end] Seat '<coder>' finished its turn on '<plan file>' — "<topic>" (column <col>, feature <feat>, worked <dur>).
  Verify the diff (git diff) before you trust the report, then advance the card or register the next subtask (attributePastedPrompt) and dispatch it.
  ```
  The notice carries the card's inline state and the review instruction directly.
- **`blocked`** — `Seat '<coder>' has gone quiet on '<plan file>' without writing a completion
  report — it may be waiting on input.` **`blocked` means "go look", not "this subtask is
  dead".** A `blocked` notice is not terminal: the coder can write its report afterward and a
  `completed` notice for the same seat follows. Do not abandon a subtask on a `blocked`; read
  the terminal and decide.

### Arming the feature-level nudge (optional, for the whole feature)

For **drive-mode dispatches**, the feature watch is armed automatically by the system —
you do not need to call `watchFeature` yourself. The manual arming path below remains for
non-drive or external-headed teams only.

The per-dispatch backstop covers each dispatch you register. It does NOT cover the window where
**no** dispatch is outstanding — you dropped the thread, your turn ended without you sending the
next subtask, or a registration failed. For that, arm a feature watch on yourself:

```bash
# Arm — the sweep nudges you when the feature has un-accepted subtasks, no dispatch is
# outstanding, and you have gone idle past turnEndSilenceMs.
curl -s -X POST "$BASE/kanban/verb/watchFeature" $AUTH \
  -H "Content-Type: application/json" --max-time 10 \
  -d '{"featureId":"<feature planId>","headTerminal":"'"$SWITCHBOARD_TERMINAL"'","workspaceRoot":"'"$PWD"'"}'
# Optional stopColumns: columns you treat as accepted beyond COMPLETED.
#   ,"stopColumns":["CODE REVIEWED"]

# Cancel when you are done (the sweep also auto-drops the watch when the feature is
# done or your terminal exits).
curl -s -X POST "$BASE/kanban/verb/unwatchFeature" $AUTH \
  -H "Content-Type: application/json" --max-time 10 \
  -d '{"featureId":"<feature planId>","workspaceRoot":"'"$PWD"'"}'
```

The nudge carries **evidence, not a poke**: the remaining subtasks, their seats, and how long
each has been silent. It fires at most once per `turnEndSilenceMs` window per watch, and it
gates on your own silence — it will not interrupt you mid-turn. Arm it once when you start
driving a feature; it cancels itself when every subtask is accepted or your terminal exits.

---

## 4. The dispatch prompt template

With the callback carried by the standing order, the prompt itself holds only:

- the **plan file path** (the coder reads it — do not inline the plan)
- the **working constraint** — this subtask only, and any "must not implement" note the plan carries
- **one line only**, per the established worktree-prompt convention — no safety boilerplate, no
  corruption warnings

Example:

```
Implement the plan at .switchboard/plans/feature_plan_20260812120100_sendtoterminal-pty-path-corrupts-long-prompts.md. This subtask only. Do not touch the other three subtasks in the feature.
```

---

## 5. The review turn

When the coder's message lands, review the **actual diff**, not the coder's account of it. The
message is a claim; `git diff` is the evidence. This mirrors the delegate contract's own
framing — "the result is a claim, not the work".

```bash
git diff                # unstaged changes
git diff --cached       # staged changes
git log --oneline -5    # recent commits, if the coder committed
```

Check the diff against the plan's acceptance criteria and the project's standing engineering
contracts (PRD). Verify the files the plan said to change were changed, and nothing the plan
said not to touch was touched. Where the plan names a mechanism, verify the seat used **that**
mechanism. "The function exists and has other call sites" is not conformance — check what it
reads from and whether the plan named it. An existing function can be reading a store that was
deprecated months earlier, and nothing in a diff shows that.

---

## 5.5. The head drives, it does not design — authority, findings, mechanism, and git verbs

The head's job is driving and conformance review. It does not invent architecture, does not add scope,
and does not redesign in flight. When live reasoning conflicts with written instructions, resolve by
the strict **authority order**:
1. **The user** — the user's explicit words and directives always come first.
2. **Project contracts** — `CLAUDE.md`, standing engineering rules, and the team commit contract.
3. **The plan file** — last in authority, because it is agent-authored, but strictly binding on implementation details until amended.

Your own live reasoning is not on this ladder. A head that treats its own live thoughts as top of the
stack produces unreviewed drift that bypasses every gate. Four mandatory rules govern prompt contents:

1. **Every finding cites a plan clause.** Quote the section or line the diff violates. A defect you
cannot cite is not a finding: it is recorded as a question report (`.switchboard/mission-control/reports/`), never dispatched to a seat as work.
*(See Appendix: 2026-08-16 resolver accepted on existence, not plan-named source)*

2. **Name the defect, never the mechanism.** A dispatch or fix prompt states what is wrong and which
plan clause it breaks. It does not name the function, file, key, or design the seat should use.
**The one exception:** where the plan itself names a mechanism, quote the plan verbatim — the plan's own
words are more specific than the head's paraphrase and carry provenance the head's do not. Do not invent,
paraphrase, or substitute an unstated mechanism.
*(See Appendix: 2026-08-16 head invented design over plan-specified path)*

3. **Never issue a git verb to a team seat.** No `commit`, `push`, `branch`, `merge`, no exceptions.
A team commits **once**, as its head, and the reviewer reviews that commit. Coders in a team never commit.
Plan prose that uses "commit" as sequencing — "as subtask 4's first commit" — is ordering language and must
be translated before entering a prompt: "do this first, as a separate step, before any deletion."
*(See Appendix: 2026-08-16 "first commit" prose swept seven subtasks into one unscoped commit)*

4. **Plan files are immutable to the head.** The plan is the source of truth. The head reads
it, dispatches based on it, and reviews against it. The head never rewrites, edits, or
restructures plan content. The only write to a plan file is the completion-report append by
a dispatched coder — never a rewrite of the plan's content sections by the head.

---

## 5.6. Driving unattended — default actions, recorded questions, and the irreversible-block bound

A head agent pacing a queue with nobody at the machine must never convert uncertainty into a stop.
The core asymmetry of unattended driving: **asking costs the whole night; acting wrongly on a reversible thing costs one card.**
Git history, plan files and board columns are recoverable; elapsed time is not.

**Which mode you are in.** You are attended only while a human is demonstrably reading — the user
has written to you in this session and is still there. A head started by an automation (the
Mission Control, an autoban wake, a `POST /kanban/queue/next` hand-off), or one whose last human
message is many turns behind, is unattended, and this section governs. **When you cannot tell, you
are unattended** — assuming attended wrongly costs the whole night, while assuming unattended
wrongly costs one recorded question that a human reads anyway. Without this rule the mode has no
entry condition and every head defaults to attended, which is the stall this section exists to remove.

Every decision the role faces maps to a stated default action:

| Decision | Unattended default |
| :--- | :--- |
| Which seat takes the next item | Decide. Idle seat over busy seat, per §7/§8. Never ask. |
| Order of remaining work | Decide from the feature's sequencing section; silent or ambiguous → file order. |
| A defect with no citable plan clause | Record a `question` report, take the most conservative action the plan already sanctions, continue. |
| A seat fails the same subtask twice | Escalate per §6. Ladder exhausted → record `blocked`, leave the card, **move to the next queue item**. |
| The team's work is complete | Commit as head. Working tree carrying foreign changes → commit an explicit file list and record what was excluded and why. |
| A card looks superseded or redundant | Record it once as a `question`. Never delete. Never restate. |
| A seat has reported and its next work is a different surface | Clear it, **in the same turn as the review**, before dispatching anything else. Not a later step, not a tidy-up. |
| Keeping a seat's context across subtasks | Allowed only when the next subtask edits code that seat just wrote, stated in the dispatch, and **re-decided at every hand-off** — a once-justified exception does not carry forward. |
| Any decision not listed above | Record a `question` report, take the most conservative action the plan already sanctions, continue. This is the fallback that makes the table complete — an unlisted decision class must never revert to asking, which is the bug this plan exists to fix. |
| Anything irreversible | **Block.** Destructive git (reset, checkout `<path>`, restore, clean, stash drop, force push), pushing, deleting user data or board cards. Record and stop on these only. This overrides the catch-all row — an irreversible action has no sanctioned default. |

Rules bounding unattended execution:

- **A default is never an invention.** The action taken must be one the plan already sanctions. "Decide" resolves ambiguity about *which* sanctioned action; it never authorises a new one.
- **Recording is not asking.** A `question` report (`.switchboard/mission-control/reports/`) is an artefact a human reads on their own schedule. Writing one must never end the head's turn — the head records and then continues in the same turn.
- **Recording does not end your turn.** The attended turn model says your turn ends after you dispatch a subtask. Unattended, recording a question and proceeding to the next queue item is a single turn — the head does not end its turn when it records, it takes the next queue item in the same turn.
- **The head commits as the team's head, not via a seat.** §5.5 rule 3 prohibits issuing git verbs to team seats; the head's own commit is not a verb to a seat. Unattended, the head commits the team's work itself (per the "team's work is complete" row above).

---

## 6. The resend & escalation ladder

If the review finds problems on the **first** attempt, compose a fix prompt naming the **specific defects**
and send it to the **same** terminal, which retains its context (`clearBeforePrompt: false` preserved it).

If a seat fails review on the same subtask **twice**, do **not** send that subtask to it a third time.
Escalate one rung along the ladder:

`intern → coder → lead`

Carry the specific defects from **both** attempts into the dispatch prompt so the stronger seat does
not have to re-derive them. In your status report, state which seat you moved the subtask to and why.

The ladder terminates:
- Attended: If a seat that fails twice is already at `lead` tier, or your team has no seat above it, do **not**
  dispatch again and do not take the subtask yourself. Stop, report to the user with the findings from
  every attempt, and leave the card where it is.
- Unattended: Exhausting the ladder retires **that card**, not the session — record `blocked` with the findings
  from every attempt, leave the card, and proceed to the next queue item. A card that cannot be finished must not hold the cards behind it.
- Escalation retires the **pairing, not the seat** — an escalated-off seat still receives other subtasks.
- When you escalate off a seat, that seat is now at rest for this subtask: apply §7 (`ptyClearTerminal`)
  to it before assigning it different work.

---

## 7. Resting a terminal — clear it when you put it down

A coder reports completion. You review the diff, and the next subtask goes to a *different*
terminal. That first terminal is now **at rest** — clear it immediately:

```bash
curl -s -X POST "$BASE/terminals/verb/ptyClearTerminal" $AUTH \
  -H "Content-Type: application/json" --max-time 10 \
  -d '{"name":"coder-1"}'
```

Both hosts serve this verb with the same `{ name }` payload — the extension through
`handlePtyVerb` → the pty host, standalone in `bootstrap.ts`. It takes the same per-terminal
send lock as `ptySendPrompt`, so a clear issued right after dispatching to another terminal
cannot splice into an in-flight paste.

**Why this step is mandatory for correctness.** Because you pass `clearBeforePrompt: false` on every
send, your coders are never cleared by the dispatch path — a coder that took subtask 1, then subtask 4,
then a fix resend, carries all of it into subtask 7. Clearing at rest is what resets that context. Leaving
stale context in an active coder is a correctness bug, not an efficiency trade-off: accumulating multiple
subtasks and conflicting instructions in a single context degrades reasoning and induces hallucinated
conflicts. The alternative — letting the next prompt carry the clear — pays for `/clear` and its settle window
*inside* the dispatch and destroys the conversation a resend depends on. The mandatory
`clearBeforePrompt: false` rule above is unchanged: a resend to a terminal you did **not** rest still needs
its context.

Rules governing resting and prompt injection:

- **Never message a seat that has not reported.** A seat you dispatched and have not heard from is
  mid-turn; a message delivered to it injects into a running turn. The engine gates itself on exactly
  this (`_runFeatureNudgeSweep` will not nudge a head inside `turnEndSilenceMs`); the head must gate
  itself the same way. A `blocked` notice is silence, not a report, and does not make a send legal.
- **Correcting an instruction already delivered is a clear plus one authoritative dispatch** — never a
  second message layered on the first. Contradictory instructions in one context are worse than either
  alone, and the seat cannot tell which one wins. The clear waits for that seat's report: a delivered
  instruction cannot be recalled mid-turn, and the two rules either side of this one — never message a
  seat that has not reported, only clear a terminal genuinely at rest — both still hold. Correcting is
  what you do when the seat comes back; it is not an exception that lets you reach into a running turn.
- **Clear at rest, always.** When a seat's completion has arrived and its next work is a different surface,
  `ptyClearTerminal` before dispatching. Keeping context is a deliberate exception, taken only when the next
  subtask edits the same code the seat just wrote, and stated in the dispatch when taken.
- **Prefer an idle seat over a second item.** Before giving a seat its next item, check whether another
  seat is idle. §8's sequencing still governs order; this governs placement.

Three original rules, all load-bearing:

- **Never clear yourself.** Your driving context is your own conversation across turns —
  there is no loop holding it and nothing to recover it from. `SWITCHBOARD_TERMINAL` is your
  own name; never pass it to this verb. For the same reason, never call
  `ptyClearAllTerminals`: it clears every active terminal, you included.
- **Only clear a terminal that is genuinely at rest.** The verb writes `/clear` to the pty
  unconditionally — there is no busy check. A terminal is at rest when its completion message
  has reached you *and* you have decided its next work goes elsewhere. Clearing a coder that
  is still working destroys the work in flight. "At rest" is **not** "a terminal I am not
  currently prompting" — a coder you dispatched and have not heard from is working, not
  resting. In particular, a `blocked` turn-end notice is *silence*, not completion: it means
  the coder has not reported for ~90 s, which is the one moment it is most likely to be
  mid-task. Never rest a terminal on a `blocked` notice; only a `completed` notice or an
  explicit completion message from the coder itself satisfies the precondition.
- **Standing orders survive a clear.** The callback contract lives at the
  `terminals.standingOrders` DB key and is re-appended to every `ptySendPrompt`. A cleared
  coder still reports to you on its next task — do not re-register the order, and treat any
  existing order as authoritative (check with `GET /terminals/standing-orders` first).

---

## 8. Sequencing across subtasks

Read the feature's `## Dependencies & sequencing` section. Honour ordering statements, and
treat "not concurrently" as a hard serialisation when driving more than one coder. When the
section is silent or ambiguous, go **sequential in file order** — never infer independence
from absence.

---

## 9. Failure modes

Each with the observable signal and the fix:

- **Coder never replies** — nothing wakes you. The standing order is the fast path, not the
  floor: a coder can ignore it (it did, on 2026-08-16). The floor is the dispatch record. Check
  you registered the dispatch with `attributePastedPrompt` **before** `ptySendPrompt` and that
  the body returned `attributed: 1` (a zero is a failed registration — no record, no backstop).
  Then check the terminal is `status: 'active'` in `ptyListTerminals` and that a standing order
  exists for the pair (`GET /terminals/standing-orders`). With the record in place, a silent
  coder produces a `blocked` turn-end notice at ~90 s and a coder that writes its report
  produces a `completed` notice — either wakes you. For the no-dispatch-outstanding window, arm
  a feature watch (`watchFeature`) so the sweep nudges you when you stall.
- **Coder replies to the wrong name** — the reply is a silent no-op; the response body carries
  `success:false` and the HTTP status is 502. Read the body; never treat a non-2xx call as
  delivered.
- **Terminal died mid-task** — `ptySendPrompt` returns `Terminal <name> is not active`.
- **Standalone auto-create** — a `sendToTerminal` call to a non-existent name **creates** that
  terminal in standalone and returns `created: true`. If you see `created`, you are talking to
  a terminal you just spawned, not to your coder. Stop and re-enumerate.
- **Context wiped between turns** — you omitted `clearBeforePrompt: false`. The coder has no
  memory of its earlier work.
- **No `SWITCHBOARD_TERMINAL` in your environment** — you are running outside a fleet terminal.
  Stop and tell the user; do not invent a reply address.
- **`ptyClearTerminal` answered `success: true` and nothing was cleared** — the verb returns
  `success: true` when the name resolves but the terminal is not `active`; it writes nothing,
  because a dead pty has no context to reset. Only an unknown name returns
  `{"success": false, "error": "No such terminal: <name>"}`. Treat `success: true` as "the
  name resolved", not as "the terminal is alive" — `ptyListTerminals` is the liveness check.

---

## 10. Knowing your roster & tier resolution

Before dispatching, enumerate the live terminal pool with `ptyListTerminals`.
**Filter to your team's seats only** — a terminal is on your team when its
`parentInstanceId` matches your own `SWITCHBOARD_AGENT_INSTANCE_ID`
(injected into your environment at terminal creation). A terminal with no
`parentInstanceId` (null/undefined) is a standalone seat — not on your team,
never dispatch to it, never send it instructions. Role alone is not a
membership test: two standalone coders and your team's coder all report
`role: "coder"`, but only the one whose `parentInstanceId` matches yours is
yours to drive.

```bash
# Enumerate, then filter to your team
curl -s -X POST "$BASE/terminals/verb/ptyListTerminals" $AUTH \
  -H "Content-Type: application/json" --max-time 10 -d '{}' | \
  jq --arg myId "$SWITCHBOARD_AGENT_INSTANCE_ID" \
     '.terminals | map(select(.status == "active" and .parentInstanceId == $myId))'
```

**Shared members** (e.g. a shared reviewer) are spawned unparented and will
not match the `parentInstanceId` filter. This is correct for the Coding team:
the lead never dispatches subtasks to the reviewer directly. If your team
uses shared coders, identify them by the team-group membership in the
terminals config instead.

### Trust the roster — do not second-guess `recommendedRole`

Each subtask's plan record carries a `recommendedRole` field (`lead` | `coder`
| `intern`) — the seat the board would route it to. Use it. Do not invent your
own complexity tiers or compare scores against a self-derived notion of what
is "intern-tier" work. The operator seated the intern because they want it
used; a subtask with `recommendedRole: "intern"` goes to the intern, full stop.
If the recommended role is absent, treat it as `coder`. Do not re-derive it by
reading the plan file's `Recommendation:` line — nothing in the system parses
that line, and a remapped board would make it wrong.

### If the required seat is missing or too small

If the required pool or seat is missing or too small for the feature, **stop
and tell the user** to create terminals — naming the Agents-tab **Agent Groups**
control (which instantiates a wired team in one action) and the `+` button in
the column header (the single-terminal path). Do not attempt to create
terminals yourself; creation is not on the documented verb rail for agents, and
each terminal is a running agent CLI.

### When escalating and the rung above is absent

When escalating and the rung immediately above the failed seat is absent on
your team (e.g. no coder exists between intern and lead), dispatch to the
highest available rung above it and state the skipped rung in the dispatch
prompt. Never fall back downward to the same tier or a lower tier.

### Verify before you undo

Before sending any terminal a revert, cleanup, or stand-down instruction,
verify the state you are undoing actually exists. A stand-down message sent
to a clean terminal sends it hunting for damage that was never there — worse
than the original error. One call:

```bash
git diff          # unstaged changes
git diff --cached # staged changes
git status --porcelain  # any modifications at all
git log --oneline -5    # recent commits
```

If all four are empty (or show nothing relevant), the terminal is clean — say
nothing to it. If there are changes, name the specific files and commits in
your instruction. Never send a terminal to revert files you have not confirmed
are modified.

---

## When this skill does NOT apply

- **Short parallel fan-out** (90 s per join, 30 min per batch) → use `/delegates/dispatch` +
  `/delegates/await` (see the `delegates` skill). That is a different job.
- **Unattended, deterministic column sweeps** with no agent watching → read
  `.agents/protocols/switchboard-mission-control-http/SKILL.md`. This skill is driving by a reasoning agent — attended, or
  unattended under §5.6 — not a deterministic sweep.

---

## Appendix: War Stories

These are illustrative anecdotes from observed failure sessions, not operational rules.
They are collected here so the operational sections (§1–§10) stay focused on what you must
do now, not on what went wrong once. Each entry is back-referenced from its original section.

### 2026-08-16: Resolver accepted on existence, not plan-named source

A head reviewed a resolver by confirming the function existed ("matches four existing
call sites"), rather than checking whether it was the one the plan named. It accepted a dead store and
propagated that wrong choice into review comments for two subsequent subtasks, turning one local error
into a three-subtask defect.

*Back-reference: §5.5 rule 1 — "Every finding cites a plan clause."*

### 2026-08-16: Head invented design over plan-specified path

On discovering a resolver read a dead store, the head designed a replacement over a
different source, dispatched it, contradicted that instruction in a follow-up, and then sent a third version.
Three of four messages were the head's invented design, while the plan had specified the correct path all along.

*Back-reference: §5.5 rule 2 — "Name the defect, never the mechanism."*

### 2026-08-16: "First commit" prose swept seven subtasks into one unscoped commit

Plan sequencing prose ("as subtask 4's first commit") was copied verbatim into a dispatch
prompt as "YOUR FIRST COMMIT". The seat committed immediately, sweeping seven subtasks plus unrelated files
into an unscoped commit on `main` where project git policy strictly forbids unwinding it.

*Back-reference: §5.5 rule 3 — "Never issue a git verb to a team seat."*
