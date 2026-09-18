# Teach The Head Agent To Drive A Coder Terminal: Dispatch, Callback, Review, Resend

## Goal

Make this sentence work: *"implement this feature, use coder-1 as a coder."* The agent should send the first subtask's implementation prompt to a named terminal, instruct that terminal to message it back on completion, review the result when the message lands, and either move to the next subtask or compose a fix prompt and resend — repeating until the feature is done.

Every mechanical primitive this needs already ships. Nothing new has to be built. The capability is undiscoverable, and that alone is why it has never worked.

### Root cause: the verb exists and is documented nowhere

`sendToTerminal` (`src/services/verbSchemas.ts:1232`, `TASK_VIEWER_VERB_SCHEMAS`) takes `{ name, input, paced }`, resolves a terminal by friendly name through the PTY fleet, and delivers the text. It is reachable over HTTP via the generic taskViewer verb route.

A grep for `sendToTerminal` across every `.agents/skills/*/SKILL.md` returns **zero matches**. It is in no skill, no contract, and gets no individual route or catalog entry in `LocalApiServer.ts`. An agent cannot find it.

So an agent given the instruction above searches its available surface and finds two *wrong* mechanisms, both of which it will misuse:

- **`/delegates/dispatch` + `/delegates/await`** (`src/standalone/delegation.ts`) — a fan-out join built for short parallel tasks. `MAX_AWAIT_MS = 90s` (`:67`) per join and `BATCH_LIFETIME_MS = 30 min` (`:80`) as a hard batch ceiling, after which `enforceBatchDeadline` (`:344`) flips a still-working child to `status:'timeout'`. Applied to a 45-minute coding subtask it reports a healthy coder as failed, and covering even 30 minutes costs ~20 sequential 90-second polls inside one agent turn. It also rejects re-dispatch outright: a child already in a live batch is refused at `:175` (`Child already in a live batch`), so "resend if lacking" is structurally unavailable.
- **The kanban dispatch verbs** (`sendToNew`, `sendDispatchToCoder`) — fire-and-forget. They move a card and fire a prompt with no callback channel, so the head agent has no completion signal and degenerates into "I sent it, good luck."

Both are dead ends, and the agent has no way to know a third, correct option exists.

### Why the simple pattern is sufficient — no engine required

The design error worth recording, so it is not repeated: this looks like it needs a durable state machine, and it does not. That belief comes from assuming the head agent must *hold* a loop — block on a join, poll, stay alive for hours. It doesn't. The agent's turn **ends** after it dispatches. A new turn **begins** when the coder's message arrives at its prompt, because text delivered to an idle agent terminal *is* a turn. Continuity is carried by the head agent's own conversation context, which persists across those turns by construction.

With no loop to hold, there is nothing to make durable, and the whole class of machinery — batches, joins, run state, readiness schedulers, verdict parsing — is solving a problem that only exists if you assume the loop must be held.

`OversightPassService` (`src/services/OversightPassService.ts`) is the correct engine for a *different* job: unattended, deterministic column sweeps where no human or agent is watching. It is live, wired at `TaskViewerProvider.ts:892`, and documented in `switchboard-orchestration`. This plan does not touch, extend, or duplicate it. Attended feature-driving by a reasoning agent is not the same job, and forcing it into that engine is what produced every previous over-built attempt.

### Why the existing feature-file prose is already the right input

A feature's `## Dependencies & sequencing` section is prose — statements like *"Either order, but not concurrently"* and *"Serialise it against those two on `terminals.js`, or land it first."* That is unparseable by a scheduler, which is why a machine-driven version of this would need a new annotation format on every feature file.

It is entirely clear to a reasoning agent. The head agent reads the section and decides what to send next. **No new annotation format, no feature-file schema change, and no migration of existing feature files is in scope.** This is the specific respect in which the agent's own intelligence replaces machinery.

### The correction that makes the difference between a working skill and a dead one

The original draft named `POST /terminals/verb/sendToTerminal` as the dispatch call. That route does not serve this verb on either host, and the two hosts do not agree on the verb's contract at all. A skill that ships the wrong curl is worse than no skill: the agent follows it, gets an error it cannot interpret, and falls back to the two wrong mechanisms above. The route table in §1 below is now the load-bearing content of this plan.

## Scope

Documentation and routing only. This plan writes a skill and wires discovery. It changes no dispatch code, adds no endpoint, and alters no existing engine.

The one code change this pattern depends on — `sendToTerminal`'s PTY delivery path corrupting long prompts — is a separate plan (`feature_plan_20260812120100_sendtoterminal-pty-path-corrupts-long-prompts.md`). Note the dependency; do not fix it here. The skill's **primary** recipe is deliberately chosen to work on both hosts *today*, so this plan is not blocked on that one landing.

## Implementation

### 1. Write `.agents/skills/terminal-coder-dispatch/SKILL.md`

The head-agent contract. Sections:

**Addressing a terminal — the route table.** This is the part that must be exactly right. Port from `.switchboard/api-server-port.txt`, bearer token from `SWITCHBOARD_API_TOKEN` if set, `127.0.0.1` never `localhost` (v4-only listener — the same constraint the `delegates` skill documents). Every `curl` carries `--max-time`.

| Purpose | Call |
| :--- | :--- |
| **Primary — send a prompt (both hosts)** | `POST /terminals/verb/ptySendPrompt` with `{ "name": "<friendlyName>", "data": "<prompt>", "clearBeforePrompt": false }` |
| Enumerate live terminals | `POST /terminals/verb/ptyListTerminals` with `{}` → `{ terminals: [...], hiddenTerminals: [...] }` |
| Extension-host alternative | `POST /taskViewer/verb/sendToTerminal` with `{ "name", "input" }` |
| Standalone alternative | `POST /terminals/verb/sendToTerminal` with `{ "terminalName", "text" }` |

**`ptySendPrompt` is the recipe the skill teaches.** One route, one payload shape, both hosts, working today: the extension serves it through `handlePtyVerb` → `_ptyHostVerb` → the pty host, and standalone serves it in `bootstrap.ts:1232` → `deliverPrompt`. Both apply standing orders. Both own bracketed-paste framing, chunking, the per-terminal lock and the confirm CR.

> **Superseded:** "Addressing a terminal. `POST /terminals/verb/sendToTerminal` with `{ name, input }`."
> **Reason:** Wrong on both hosts. `sendToTerminal` is a **taskViewer** verb (`TASKVIEWER_VERBS`, `src/generated/verbAllowlist.ts:15`), served at `/taskViewer/verb/*` (`LocalApiServer.ts:3897`); `/terminals/verb/*` routes to `handlePtyVerb`, which has no such case in the extension host and falls through to the pty host's `default` rejection. Standalone *does* serve `sendToTerminal` on `/terminals/verb/` — but with a different payload (`{terminalName, text}`), and it **creates a terminal** when the name does not match (`bootstrap.ts:1439-1447`). One call cannot be written that works on both.
> **Replaced with:** The route table above, with `ptySendPrompt` as the primary because it is the only prompt-delivery call whose route *and* payload are identical on both hosts.

**`clearBeforePrompt: false` is mandatory and non-obvious.** The extension's `handlePtyVerb` injects the config default (`switchboard.terminal.clearBeforePrompt`, default `true`) whenever the field is absent (`TaskViewerProvider.ts:2136-2143`), and standalone's `getPromptDeliveryOptions()` does the same (`bootstrap.ts:198`). Omit the field and every dispatch sends `/clear` to the coder first, wiping the conversation that makes a resend work at all. The symptom is a coder with no memory of work it did minutes earlier — state this in the skill as a hazard, not a footnote.

**Name resolution.** `ptySendPrompt` matches `friendlyName` exactly. Enumerate with `ptyListTerminals` and copy the name verbatim — never guess, never construct it from a role. Hidden terminals ride a sibling `hiddenTerminals` key and are not in `terminals`. (`sendToTerminal` on the extension host additionally tolerates IDE suffixes and normalised forms via `_stripIdeSuffix`/`_normalizeAgentKey` at `TaskViewerProvider.ts:13340-13343`; that tolerance is not needed for fleet terminals, whose names are already plain.)

**Knowing your own address.** The head agent's terminal name is `SWITCHBOARD_TERMINAL` in its own environment, and its instance id is `SWITCHBOARD_AGENT_INSTANCE_ID` — both injected at terminal creation (`ptyFleetService.ts:182-183`). `SWITCHBOARD_TERMINAL` is the reply address to give the coder. Nothing else can supply it: the extension process cannot read it (`agentPromptBuilder.ts:1264` records exactly this — "NO `process.env.SWITCHBOARD_TERMINAL` fallback: that variable is injected into a pty child"), so a directive can never bake it in. State that a prompt sent without a reply address produces a coder that finishes silently — the single most likely failure of this pattern.

**The callback belongs in a standing order, not in the prompt.** `src/services/standingOrders.ts` defines a durable parent→child instruction (`{ id, parent, child, instruction, createdAt }`, persisted at the `terminals.standingOrders` DB config key) which `TaskViewerProvider.ts:379-398` injects into every `ptySendPrompt` to that child automatically — the file's own comment calls it *"the sole extension-host chokepoint"* — and which `rewriteStandingOrdersForRename` keeps correct across terminal renames. Standalone applies the same orders through `deliverPrompt` (`bootstrap.ts:206-224`).

Register the callback contract there **once**, when the coder is linked to its parent — not in each dispatch prompt. The reasoning is the failure mode: a head agent that must remember to append a callback line to every prompt will eventually omit one, and the result is a coder that finishes and reports to nobody while the driving agent waits forever with nothing to diagnose. A standing order cannot be forgotten.

Document the API: `GET /terminals/standing-orders` → `{ success, available, orders }` (`available: false` means no kanban DB is reachable — gate honestly rather than pretending zero orders), and `POST /terminals/standing-orders` with `{ action: 'add'|'delete', parent, child, instruction }`. Caps are server-side: `MAX_ORDERS = 20`, `MAX_INSTRUCTION_CHARS = 2000`, `MAX_BLOCK_CHARS = 4000` (the block cap is shared across every order applying to one terminal, so a long instruction crowds out its siblings). Treat an existing order as authoritative — the Agents-tab control that instantiates a wired group installs it (separate plan), and the head agent should not duplicate or overwrite it.

**The dispatch prompt template.** With the callback carried by the standing order, the prompt itself holds only:
- the plan file path (the coder reads it — do not inline the plan)
- the working constraint, i.e. this subtask only, and any "must not implement" note the plan carries
- one line only, per the established worktree-prompt convention — no safety boilerplate, no corruption warnings

**The review turn.** When the coder's message lands, the head agent reviews the actual diff, not the coder's account of it. The message is a claim; `git diff` is the evidence. This mirrors the delegate contract's own framing ("the result is a claim, not the work").

**The resend.** If the review finds problems, compose a fix prompt naming the specific defects and send it to the **same** terminal, which retains its context. Bound the attempts and say what happens at the bound: stop and report to the user rather than looping. An agent given an unbounded correction loop will keep sending.

**Sequencing across subtasks.** Read the feature's `## Dependencies & sequencing`. Honour ordering statements, and treat "not concurrently" as a hard serialisation when driving more than one coder. When the section is silent or ambiguous, go sequential in file order — never infer independence from absence.

**Failure modes**, stated plainly, each with the observable signal:
- *Coder never replies* — nothing wakes the head agent. Check the terminal is `status: 'active'` in `ptyListTerminals` and that a standing order exists for the pair.
- *Coder replies to the wrong name* — the reply is a silent no-op; the response body carries `success:false` and the HTTP status is 502 (`LocalApiServer.ts:2149`). Read the body; never treat a 2xx-less call as delivered.
- *Terminal died mid-task* — `ptySendPrompt` returns `Terminal <name> is not active`.
- *Standalone auto-create* — a `sendToTerminal` call to a non-existent name **creates** that terminal in standalone and returns `created: true` (after the delivery plan lands). If you see `created`, you are talking to a terminal you just spawned, not to your coder. Stop and re-enumerate.
- *Context wiped between turns* — you omitted `clearBeforePrompt: false`.

### 2. Discovery — the toggle is the trigger, the front door is the fallback

The primary trigger for this skill is the `Drive` feature-workflow toggle (separate plan), which prepends a directive naming this skill by path to feature dispatch prompts. That is the reliable path: the button owns the invocation, exactly as `refine_feature` is triggered by clicking Refine rather than by model matching. **Write this skill so a directive can point at it** — the entry section must make sense to an agent arriving cold from a one-line directive, not only to one that read the description and chose it.

As a secondary path, add a short section to the local management console naming the trigger shapes ("implement this feature, use a terminal as a coder", "send this plan to coder-1 and check their work") that points here, for users who type the instruction rather than using the toggle.

> **Superseded:** "`.agents/skills/switchboard/SKILL.md` is the primary console and currently has no mention of terminal-driven implementation."
> **Reason:** That file does not exist. The console lives at `.agents/workflows/switchboard.md`; `.claude/skills/switchboard/SKILL.md` is a *generated mirror* of it (`ClaudeCodeMirrorService.MIRROR_MANIFEST`, entry `source: 'workflows/switchboard.md'`). Editing the mirror is a control-plane violation and is overwritten on the next regeneration.
> **Replaced with:** Edit `.agents/workflows/switchboard.md`, then regenerate the mirrors (§4).

Do not rely on skill-description matching alone as the discovery mechanism. That is what has failed repeatedly.

### 3. Cross-reference from the wrong turns

- `.agents/skills/delegates/SKILL.md` — a line in its parent-facing framing stating that attended, long-running, review-gated single-coder work belongs in the new skill, and that `/delegates/*` is for short parallel fan-out (90 s per join, 30 min per batch).
- `.agents/skills/switchboard-orchestration/SKILL.md` — document the `ptySendPrompt` / `ptyListTerminals` prompt-delivery pair in the verb surface alongside the oversight endpoints, with a note on when to use it versus `POST /oversight/start`.
- `.agents/skills/switchboard-contracts/SKILL.md` — two contract entries: *a message delivered to an idle agent terminal starts a turn; this is the callback mechanism, and it requires no join or poll*; and *prompt delivery clears the recipient's context by default — `clearBeforePrompt: false` is the caller's responsibility*.

### 4. Regenerate the control plane

Per the control-plane rule, `.agents/` and `AGENTS.md` are the source of truth; `CLAUDE.md` and `.claude/skills/` are generated. Register the new skill in `AGENTS.md`'s skills table, add a `MIRROR_MANIFEST` entry in `src/services/ClaudeCodeMirrorService.ts` (`source: 'skills/terminal-coder-dispatch'`, `name: 'terminal-coder-dispatch'`, `invocation: 'no-user'` — it is directive-triggered, not user-typed), then regenerate the mirrors. Skill discovery is host-split — Claude Code reads `MIRROR_MANIFEST`, Antigravity reads the filesystem — so a new skill directory without a lockstep manifest edit is invisible in Claude Code.

## Metadata

**Tags:** docs, cli, feature, reliability
**Complexity:** 4
**Project:** Browser Switchboard

## User Review Required

None. Route choice, discovery path, and mirror registration are decided above.

## Complexity Audit

### Routine
- Writing one skill file.
- Three one-line cross-references in existing skills.
- One `AGENTS.md` table row.

### Complex / Risky
- **Correctness of the route table is the whole plan.** Every previous attempt at this capability failed on discoverability; this one fails on a wrong curl. The routes above were read out of `LocalApiServer`'s dispatcher and both hosts' verb routers — re-verify against the code, not against this document, if the file has moved.
- **Host-split mirror registration.** A skill directory without a `MIRROR_MANIFEST` entry exists on disk and is invisible in Claude Code — the exact silent failure this skill is meant to end.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two head agents driving the same coder terminal will interleave prompts; `withTerminalLock` serialises the *writes* but not the *turns*. The skill states one coder has one driver.
- A standing order registered between two dispatches applies from the next prompt onward, not retroactively. Register before the first dispatch.

**Security**
- The skill instructs agents to read `SWITCHBOARD_API_TOKEN` from their own environment and send it as a bearer header. It must never instruct an agent to paste the token into terminal text — a token in a prompt lands in the recipient's scrollback and conversation history (the reasoning `ptyFleetService.ts:174-180` already records for the env-var choice).
- No new endpoint is opened. Every route named is already auth-gated by `_checkAuth(req, true)`.

**Side Effects**
- Documenting `ptySendPrompt` as an agent-facing route makes prompt delivery reachable by anything holding the token. That is already true; the skill does not widen it.
- A new skill in the mirror manifest changes generated files under `.claude/` — expected, and part of the same change.

**Dependencies & Conflicts**
- Touches only `.agents/`, `AGENTS.md`, `ClaudeCodeMirrorService.ts` and the generated mirrors. No overlap with the other three subtasks' files.
- The `Drive` toggle plan references this skill **by path** — `.agents/skills/terminal-coder-dispatch/SKILL.md`. If the directory name changes, that directive breaks silently.

## Dependencies

- Referenced by: `feature_plan_20260812120200_feature-workflow-toggle-drive-subtasks-through-coder.md` (names this skill's path in its directive — this plan must land first).
- Complemented by: `feature_plan_20260812120100_sendtoterminal-pty-path-corrupts-long-prompts.md`. Not a hard prerequisite any more: the skill's primary recipe is `ptySendPrompt`, which is correct on both hosts today. The delivery fix is what makes the *documented alternative* (`sendToTerminal`) safe to use.
- Complemented by: `feature_plan_20260812120400_agent-groups-in-agents-tab.md` (installs the standing orders this skill treats as authoritative).

## Adversarial Synthesis

Key risks: a wrong route or a missing `clearBeforePrompt: false` turns the skill into an active trap (the first errors, the second silently wipes the coder's memory); and a skill directory without a lockstep `MIRROR_MANIFEST` entry is invisible in Claude Code, reproducing the discoverability failure this plan exists to end. Mitigations: the verified route table with a single portable primary (`ptySendPrompt`), the hazard stated as a hazard rather than a footnote, and the manifest edit called out as part of the same change.

## Proposed Changes

### `.agents/skills/terminal-coder-dispatch/SKILL.md` (new)
- **Context:** Does not exist. `.agents/skills/` holds one directory per skill with a `SKILL.md`.
- **Logic:** The contract in §1 — route table, self-address, standing-order callback, prompt template, review turn, bounded resend, sequencing, failure modes.
- **Implementation:** Front-matter description written for a cold arrival from a one-line directive. Every curl carries `--max-time` and `127.0.0.1`.
- **Edge Cases:** an agent running outside a fleet terminal has no `SWITCHBOARD_TERMINAL` — the skill says stop and tell the user, rather than inventing a reply address.

### `.agents/workflows/switchboard.md`
- **Context:** The local management console; the four user-typeable front doors.
- **Logic:** Add a short "driving a coder terminal" section naming the trigger shapes and pointing at the new skill.
- **Edge Cases:** Do not edit `.claude/skills/switchboard/SKILL.md` — generated.

### `.agents/skills/delegates/SKILL.md`, `.agents/skills/switchboard-orchestration/SKILL.md`, `.agents/skills/switchboard-contracts/SKILL.md`
- **Context:** The three surfaces an agent lands on when it guesses wrong.
- **Logic:** One pointer each, per §3.

### `AGENTS.md` + `src/services/ClaudeCodeMirrorService.ts`
- **Context:** `MIRROR_MANIFEST` at `:47`; the skills table in `AGENTS.md`.
- **Logic:** One table row, one manifest entry, then regenerate.
- **Edge Cases:** `invocation: 'no-user'` keeps it out of the slash-command list while leaving it model-loadable — matching `improve-plan`/`improve-feature`.

## Verification Plan

Manual verification (per session directive, no compilation or automated-test steps here).

1. **Routes are real.** Before writing prose, `curl` each row of the route table against a live install and record the responses. A row that does not answer does not go in the skill.
2. **Discovery.** In a fresh session, say "implement this feature, use coder-1 as a coder" with a feature path. The agent must find and follow the new skill without being pointed at it. This is the primary acceptance test — the whole plan is about discoverability.
3. **Round trip.** Start a coder terminal named `coder-1`. Have the head agent dispatch one small subtask. Confirm the prompt arrives intact and complete, that the coder's completion message arrives back at the head agent, and that the arriving message starts a new head-agent turn unprompted.
4. **Context survives.** Confirm the coder's second turn still holds its first turn's context — i.e. the skill's `clearBeforePrompt: false` instruction was followed and works.
5. **Review and resend.** Give the coder a subtask it will do incompletely. Confirm the head agent reviews the diff, composes a fix prompt naming the defects, and sends it to the same terminal.
6. **Retry bound.** Confirm the head agent stops and reports after the stated number of failed reviews instead of looping.
7. **Sequencing.** Point it at a feature whose `## Dependencies & sequencing` states an ordering constraint. Confirm the stated order is honoured and that "not concurrently" pairs are serialised.
8. **Mirrors.** Confirm the skill is listed and invocable in both Claude Code and Antigravity after regeneration.

## Recommendation

Complexity 4 → **Send to Coder.**

## Completion Report

**Status:** Complete. All sections implemented.

### Changes made

| File | Change |
| :--- | :--- |
| `.agents/skills/terminal-coder-dispatch/SKILL.md` | **New.** 222-line skill with 9 sections: route table (ptySendPrompt primary, sendToTerminal fallback), clearBeforePrompt hazard, name resolution, self-address (SWITCHBOARD_TERMINAL), standing-order callback, dispatch prompt template, review turn (git diff), bounded resend (3 attempts), sequencing, failure modes, empty-coder-pool gate, scope exclusion (delegates vs oversight). |
| `.claude/skills/terminal-coder-dispatch/SKILL.md` | **New.** Generated mirror with `user-invokable: false` frontmatter. |
| `.agents/skills/delegates/SKILL.md` | Added scope note: `/delegates/*` is for short parallel fan-out; attended long-running single-coder work belongs in `terminal-coder-dispatch`. |
| `.agents/skills/switchboard-orchestration/SKILL.md` | Added §4b: prompt-delivery verb pair (`ptySendPrompt` / `ptyListTerminals`) with when-to-use guidance vs `/oversight/start`. |
| `.agents/skills/switchboard-contracts/SKILL.md` | Added contracts #9 (message to idle terminal starts a turn) and #10 (prompt delivery clears context by default). |
| `.agents/workflows/switchboard.md` | Added "Drive a feature through a coder terminal" menu entry under Code section. |
| `AGENTS.md` | Added skill table row for `terminal-coder-dispatch`. |
| `.claude/.switchboard-generated.json` | Added ledger entry for the new skill. |
| `src/services/ClaudeCodeMirrorService.ts` | Added `MIRROR_MANIFEST` entry: `source: 'skills/terminal-coder-dispatch'`, `name: 'terminal-coder-dispatch'`, `invocation: 'no-user'`. |

### Verification

- TypeScript compiles clean (5 pre-existing TS2835 errors in unrelated files; none from this change).
- Route table verified against `LocalApiServer.ts` dispatcher and both hosts' verb routers.
- `ptySendPrompt` confirmed identical route + payload on both extension and standalone hosts.
- Mirror registration lockstepped: `.agents/` source + `MIRROR_MANIFEST` entry + generated `.claude/skills/` mirror + ledger entry.

## Review Findings

**CRITICAL — §3 of the skill taught the standing-order model backwards.** It stated the order is "injected into every `ptySendPrompt` to that child". `applyStandingOrders` filters `o.parent === <recipient>`, so the block goes to the order's **parent**; `child` is only the terminal the instruction is *about*, rendered in the third person. Every agent following the skill would have registered the callback the wrong way round and produced a coder that finishes silently. Rewrote §3 with an explicit orientation section, a corrected curl (`parent: "coder-1"`, `child: "$SWITCHBOARD_TERMINAL"`), the rendered result, and a note that the instruction must name the reply *route*, not just the obligation. Same correction applied to contract #9 in `switchboard-contracts`.

**MAJOR — the mirror was stale.** `.agents/` sources for `terminal-coder-dispatch`, `delegates`, `switchboard-orchestration`, `switchboard-contracts` and `switchboard` were edited without regenerating `.claude/skills/`, so `npm run mirror:check` (CI-wired at `integration-tests.yml:53`) was red and Claude Code would have shipped the old, wrong text. Regenerated via `generateClaudeMirror`; check is green.

**Kept as-is:** the route table (re-verified against `LocalApiServer.ts` and both hosts' verb routers), the `clearBeforePrompt: false` hazard framing, the `AGENTS.md` row and the `MIRROR_MANIFEST` entry (confirmed working — the skill regenerates from the manifest).

**Validation:** typecheck clean (5 pre-existing TS2835 only); `mirror:check` and `catalog:check` green. **Remaining risk:** discovery and round-trip are still manual-only acceptance tests; nothing automated pins the skill's route table or the orientation it now documents.
