---
name: terminal-coder-dispatch
description: "Drive a feature's subtasks through a coder terminal — dispatch, callback, review, resend. The attended long-running single-coder pattern."
user-invokable: false
---

# Skill: Terminal Coder Dispatch

You are a **head agent** driving a feature's subtasks through one or more **coder terminals**.
Your turn ends after you dispatch a subtask. A new turn begins when the coder's completion
message arrives at your prompt — text delivered to an idle agent terminal *is* a turn.
Continuity is carried by your own conversation context, which persists across those turns
by construction. There is no loop to hold, no join to poll, no batch to manage.

> **You arrived here from a one-line directive** (e.g. the `Drive` feature-workflow toggle
> prepended "read and follow `.agents/skills/terminal-coder-dispatch/SKILL.md`"). This skill
> is the complete contract. Read it once, then drive.

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
| Enumerate live terminals | `POST /terminals/verb/ptyListTerminals` with `{}` → `{ terminals: [...], hiddenTerminals: [...] }` |
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

The extension's `handlePtyVerb` injects the config default
(`switchboard.terminal.clearBeforePrompt`, default `true`) whenever the field is absent, and
standalone's `getPromptDeliveryOptions()` does the same. **Omit the field and every dispatch
sends `/clear` to the coder first**, wiping the conversation that makes a resend work at all.
The symptom is a coder with no memory of work it did minutes earlier. Pass it explicitly on
every send:

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
than pretending zero orders. Caps are server-side: `MAX_ORDERS = 20`,
`MAX_INSTRUCTION_CHARS = 2000`, `MAX_BLOCK_CHARS = 4000` (the block cap is shared across every
order applying to one terminal, so a long instruction crowds out its siblings).

**Treat an existing order as authoritative.** The Agents-tab group control that instantiates a
wired team installs the callback order at creation time. Do not duplicate or overwrite it —
check with GET first.

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
said not to touch was touched.

---

## 6. The resend

If the review finds problems, compose a fix prompt naming the **specific defects** and send it
to the **same** terminal, which retains its context (`clearBeforePrompt: false` preserved it).

Bound the attempts: after **3 failed reviews**, stop and report to the user rather than
looping. An agent given an unbounded correction loop will keep sending. State what failed on
each attempt in your report.

---

## 7. Sequencing across subtasks

Read the feature's `## Dependencies & sequencing` section. Honour ordering statements, and
treat "not concurrently" as a hard serialisation when driving more than one coder. When the
section is silent or ambiguous, go **sequential in file order** — never infer independence
from absence.

---

## 8. Failure modes

Each with the observable signal and the fix:

- **Coder never replies** — nothing wakes you. Check the terminal is `status: 'active'` in
  `ptyListTerminals` and that a standing order exists for the pair (`GET /terminals/standing-orders`).
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

---

## 9. Empty coder pool

Before dispatching, enumerate the live coder pool with `ptyListTerminals` and filter for
`role: 'coder'` (or the role your directive names). If the pool is empty or too small for the
feature, **stop and tell the user** to create terminals — naming the Agents-tab **Agent Groups**
control (which instantiates a wired team in one action) and the `+` button in the column
header (the single-terminal path). Do not attempt to create terminals yourself; creation is
not on the documented verb rail for agents, and each terminal is a running agent CLI.

---

## When this skill does NOT apply

- **Short parallel fan-out** (90 s per join, 30 min per batch) → use `/delegates/dispatch` +
  `/delegates/await` (see the `delegates` skill). That is a different job.
- **Unattended, deterministic column sweeps** with no agent watching → use
  `POST /oversight/start` (see the `switchboard-orchestration` skill). This skill is attended
  driving by a reasoning agent, not unattended automation.
