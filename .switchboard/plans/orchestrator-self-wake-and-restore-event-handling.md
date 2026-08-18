# Orchestrator Self-Wake and Restore Event-Driven Completion Handling

## Goal

The orchestrator agent (`.agents/skills/switchboard-orchestrator/SKILL.md`) is broken in five ways that make it unable to orchestrate anything. This plan rewrites the skill to fix all five by: (1) giving the agent a self-wake mechanism it runs itself, (2) restoring the completion-handling and card-advancement sections the Aug 17 rewrite deleted, (3) enforcing lead-only dispatch, (4) fixing terminal detection with a health check, and (5) enforcing the concise pre-flight output format.

## Problem Analysis & Root Causes

### Background

The orchestrator skill was rewritten on Aug 17 (`f07a8038`, "orchestrator-persona-becomes-a-tick"). The rewrite replaced the original event-driven model with a tick-based model. The original model worked: the agent dispatched to leads, then responded to completion reports and `[switchboard:turn-end]` notices. The rewrite deleted the completion-handling sections, the card-advancement sections, and the "Handling What Comes Back" section, and replaced them with a tick loop that describes behavior the engine doesn't provide.

### The five problems

1. **No self-wake mechanism.** The rewrite describes a tick loop ("each wake clears the terminal") but never tells the agent HOW to wake itself. The original said "no timers, no polling, no self-scheduling" — which forbade the one thing the agent needs. Neither version provides a background script or instructions for the agent to self-schedule using its native capabilities. The orchestrator is meant to run in non-CLI terminals that can't be reached by `ptySendPrompt` or extension-injected turn-end notices, so the wake MUST be agent-side: a background script the agent runs in its own terminal, or the agent's native scheduling capability.

   **Verification (code-traced):** `orchestrationConfig.intervalMinutes` exists in `autobanState.ts:58` (default 10) and is persisted in `AutobanConfigState.orchestrationConfig`, but NO timer in `TaskViewerProvider.ts`, `bootstrap.ts`, or `ptyFleetService.ts` reads it to send periodic wake prompts. The comment at `TaskViewerProvider.ts:10579` says "the orchestrator wake interval is installed separately" but the installation code does not exist. The `agentPromptBuilder.ts:982` comment confirms `ptySendPrompt` "cannot reach the orchestrator" in some runtimes. The wake mechanism is genuinely missing — problem confirmed.

2. **Completion handling deleted.** The rewrite removed "Handling What Comes Back" (how to process completion reports and turn-end notices) and "Transitions You Own" (advancing cards to CODE REVIEWED, dispatching review). Even if the agent wakes, it doesn't know what to do when work finishes — the card just sits in a coding column forever.

   > **Superseded:** "Completion handling deleted. The rewrite removed 'Handling What Comes Back' (how to process completion reports and turn-end notices)."
   > **Reason:** The rewrite DID delete the "Handling What Comes Back" section, but it was REPLACED by the "Signals" section (current skill lines 309–335), which covers: (1) completion reports in plan files (`CODING_COMPLETION_REPORT_DIRECTIVE`), (2) the reports directory (`.switchboard/orchestrator/reports/` with `finished`/`blocked`/`question`/`status` files and claim markers), and (3) asking the lead via `ptySendPrompt`. The claim "deleted entirely" is inaccurate — the content was restructured, not removed.
   > **Replaced with:** The genuine gap is narrower than "completion handling deleted." What Signals LACKS that the original had: (a) the "act" instructions — the original said "read the board, verify via git, and act: advance verified-complete subtasks, dispatch review, run merge-back, or escalate." Signals tells the orchestrator WHAT to read but not WHAT TO DO with completions it detects. (b) The turn-end notice processing detail — the original distinguished `finished` (plan file mtime advanced → verify and act) from `blocked` (seat is blocked → check terminal, answer or escalate, re-dispatch if crashed). Signals mentions `from: system` mirrors of turn-end notices but gives no processing instructions for the finished/blocked distinction. The fix is to ADD the act instructions and turn-end detail to the existing Signals section, not to restore a duplicate "Handling What Comes Back" section.

3. **Dispatches to individual coders instead of the lead.** The transcript shows the orchestrator dispatching to `Coding-coder-1` directly. The skill says "message the team leads" but the orchestrator uses `POST /kanban/dispatch` (routes to a specific terminal) instead of `POST /kanban/queue/next` (hands the card to the lead, lead delegates). The orchestrator is bypassing the lead entirely.

   **Verification (code-traced):** `POST /kanban/dispatch` exists (`LocalApiServer.ts:4396`) and routes to a specific terminal. `POST /kanban/queue/next` exists (`LocalApiServer.ts:4400`) and hands the next staged card to the lead. The current skill's "Messaging Leads" section (lines 382–404) says to message leads via `ptySendPrompt` and the "The handoff sequence" uses `POST /kanban/queue/next`, but "The Tick" section (lines 256–276) just says "dispatch it to the coding team" without specifying the mechanism — leaving `POST /kanban/dispatch` as an apparent option. Problem confirmed.

4. **Terminal detection fails on stale port files.** The orchestrator reads `.switchboard/api-server-port.txt` which goes stale after an extension restart. The `/switchboard` launcher has a health check (`GET /health`); the orchestrator skill does not. It trusts the port file, hits a dead port, and concludes no terminals exist.

   **Verification (code-traced):** `GET /health` exists (`LocalApiServer.ts:4358`) and returns registered terminals, workspace roots, and liveness. The launcher (`switchboard.md` step 1) reads the port file, calls `GET /health`, and treats only a 200 as "a board is running." The orchestrator skill's bash snippets (lines 70, 197, 386) read the port file directly with no health check. Problem confirmed.

5. **Pre-flight produces massive diagnostic dumps.** The skill says "lead with the two counts, then one line per card, nothing else" but the orchestrator narrates every check, producing walls of text. The six checks are useful; the narration is not.

   > **Superseded:** "The skill says 'lead with the two counts, then one line per card, nothing else' but the orchestrator narrates every check."
   > **Reason:** The current skill (lines 137–140) ALREADY contains the concise output contract: "A passing check produces no output. If all checks pass, the pre-flight report is simply `Pre-flight clear.`" This was added after the Aug 17 rewrite (the rewrite's version said only "Report what you find in plain terms; do not fix it"). The contract exists; the problem is enforcement clarity, not absence.
   > **Replaced with:** Strengthen the existing contract with an explicit "Pre-flight output contract" callout that restates the rule more forcefully and adds the negative examples (no diagnostic narration, no terminal listings, no port-probing output, no "here's what I found" preamble). This is a reinforcement, not a new addition.

### What was lost in the rewrite (git-traced)

Comparing `6a4df070` (Aug 16, original) → `f07a8038` (Aug 17, rewrite):

| Section in original | Status in rewrite | Impact |
|---|---|---|
| Hard Rule #1: "No timers, no polling" | Replaced with tick loop description | Agent has no self-wake instructions |
| "Handling What Comes Back" (completion reports, turn-end notices) | **Deleted, replaced by "Signals"** — covers what to read, lacks what to do | Agent can detect completions but lacks act instructions |
| "Transitions You Own" (advance to CODE REVIEWED, dispatch review) | **Deleted, replaced by "What You Never Do"** — which FORBIDS the CODE REVIEWED advance | Cards never advance through review (see Step 3 contradiction) |
| "Kickoff" (group into features, message leads, stop) | Replaced with handoff sequence | Lead doesn't know to self-pace |
| "Batch Completion" (final summary) | **Deleted entirely** | No session end state |

## Metadata

**Complexity:** 6
**Tags:** refactor, feature, backend, cli
**Project:** Browser Switchboard

## User Review Required

This plan proposes reverting a deliberate design decision from the Aug 17 rewrite: the "What You Never Do" section explicitly forbids the orchestrator from advancing cards to CODE REVIEWED (the coding team's head owns that transition). Step 3 below proposes to restore the orchestrator's ownership of that transition. This is a design reversal, not a bug fix — the user must confirm which model is correct before implementation.

Additionally, Step 7 proposes removing the handoff model as the default. The handoff model has a working queue-watch nudge mechanism (`armQueueWatch` + sweep in `PlanIngestionEngine.ts`) that dispatches the next card to the lead when it goes idle. The plan's claim that "the lead is never told to self-pace" is inaccurate — the queue watch handles it. The user must confirm whether the self-wake model should replace handoff as the default, or whether both should coexist.

## Complexity Audit

### Routine
- Adding a health check to the orchestrator skill's bash snippets (mirrors the launcher's existing pattern)
- Adding an explicit lead-only dispatch rule to Hard Rules
- Restoring the "Batch Completion" section (pure documentation, no code change)
- Strengthening the pre-flight output contract (reinforcement of existing text)
- Adding the self-wake background script snippet (a 3-line shell loop)

### Complex / Risky
- **Resolving the CODE REVIEWED ownership contradiction.** The rewrite deliberately moved the CODE REVIEWED transition to the coding team's head ("What You Never Do" line 444). Restoring it to the orchestrator creates a race condition on the same card — the exact failure the rewrite was designed to prevent. The plan must either argue for reverting (with reasoning) or drop the CODE REVIEWED transition from the restoration.
- **Designing the self-wake mechanism correctly.** The wake interval comes from `orchestrationConfig.intervalMinutes` (default 10), which is stored in `autoban.state` — the agent must read this value to know its interval. The mechanism must work in non-CLI terminals where `ptySendPrompt` cannot reach the orchestrator.
- **Augmenting Signals without duplicating it.** The "act" instructions (advance/review/merge/escalate) must be added to the existing Signals section, not restored as a separate "Handling What Comes Back" section that would duplicate the detection instructions.
- **Deciding handoff-vs-self-wake as default.** The handoff model has a working queue-watch backstop. Making self-wake the default is a design preference that changes the orchestrator's lifecycle, not a fix for a broken mechanism.

## Edge-Case & Dependency Audit

### Race Conditions
- **CODE REVIEWED advance race:** If the orchestrator AND the coding team's head both advance the same card to CODE REVIEWED, the two race on the same card. The rewrite's "What You Never Do" section exists to prevent this. Any restoration of the CODE REVIEWED transition MUST resolve who owns it — both cannot.
- **Self-wake + extension wake:** If a future extension update adds a wake timer using `orchestrationConfig.intervalMinutes`, and the agent also self-wakes on the same interval, the "wake arriving mid-pass is dropped" rule (lines 289–296) handles it — but only if the deliverer enforces it. The plan states the wake is agent-side only, which avoids this race for now.

### Security
- No security implications — this is a skill documentation change, not a code change. The self-wake background script runs `sleep` and `echo` only.

### Side Effects
- Changing the orchestrator's default lifecycle from handoff to self-wake changes when the orchestrator terminal exits. Under handoff, the orchestrator exits after dispatching the first card. Under self-wake, it stays alive for the session duration. This affects terminal management and resource usage.

### Dependencies & Conflicts
- `autobanState.ts` — `OrchestrationConfig.intervalMinutes` (line 58): the self-wake interval source. Already exists, no code change needed.
- `LocalApiServer.ts` — `GET /health` (line 4358): the health check endpoint. Already exists.
- `LocalApiServer.ts` — `POST /kanban/queue/next` (line 4400): lead dispatch. Already exists.
- `LocalApiServer.ts` — `POST /kanban/dispatch` (line 4396): the endpoint to forbid for orchestrator use. Already exists.
- `PlanIngestionEngine.ts` — `armQueueWatch` (line 255): the queue-watch nudge mechanism that makes the handoff model work. Already exists.
- `agentPromptBuilder.ts:982` — confirms `ptySendPrompt` cannot always reach the orchestrator, validating the agent-side wake requirement.

## Dependencies

No session-level dependencies. This plan modifies a single skill file (`.agents/skills/switchboard-orchestrator/SKILL.md`) and depends only on existing API endpoints and state structures that are already implemented and shipped.

## Adversarial Synthesis

Key risks: (1) the CODE REVIEWED transition restoration directly contradicts a deliberate race-prevention design decision — both the orchestrator and the coding team's head cannot own the same transition without racing; (2) the plan's claim that completion handling was "deleted entirely" is factually wrong — Signals replaced it, and a naive restoration would duplicate the detection instructions; (3) the handoff model is not broken — the queue-watch nudge mechanism dispatches subsequent cards to the lead automatically, so replacing handoff with self-wake as the default is a design preference, not a fix. Mitigations: augment Signals with act instructions rather than restoring a duplicate section; resolve the CODE REVIEWED ownership before implementation (user decision required); present self-wake as an alternative to handoff, not a replacement for a broken mechanism.

## Proposed Changes

### `.agents/skills/switchboard-orchestrator/SKILL.md`

**Context:** The orchestrator skill is the sole file modified. All 10 steps below are edits to this single file. No source code (`src/`) changes are needed — all API endpoints, state structures, and mechanisms already exist.

#### Step 1 — Add the self-wake mechanism

Replace the "Context Is Cleared Every Tick" and "The Tick" sections' framing with a new "## Self-Wake" section that gives the agent two mechanisms:

**A. Background script (default).** Provide a shell script the agent runs in a background terminal:

```bash
# Run this in a background terminal to wake yourself every N minutes.
# Replace 600 with your desired interval in seconds.
while true; do sleep 600; echo "WAKE $(date -u +%FT%TZ)"; done
```

The agent monitors that terminal's output. When it sees `WAKE`, it re-reads the board and acts. The interval comes from `orchestrationConfig.intervalMinutes` in the autoban state (default 10 minutes = 600 seconds). The agent reads this from `.switchboard/autoban.state` or the `GET /health` / autoban state API.

**B. Native scheduling (alternative).** Tell the agent: "If your runtime supports background execution or scheduling (e.g. Devin's background shells, Claude Code's background commands), use it to run the same sleep-and-signal loop. The mechanism is yours; the behavior is the same: wake every N minutes, re-read the board, act on what you find."

**Key constraints to state in the skill:**
- The orchestrator terminal stays alive for the duration of the session. It does not exit after dispatch.
- On each wake, re-derive everything from the board and git (same as the current "Re-derive every wake" rule — keep that rule).
- A no-op wake (nothing to dispatch, nothing to advance) writes nothing to the session log. Keep the "Silent when idle" rule.
- One dispatch per lane per wake. Keep that rule.
- The wake is agent-side, NOT extension-delivered. The extension does not send wake prompts. The agent's own background process is the sole wake mechanism.

**Implementation:** Insert a new "## Self-Wake" section between "Pre-flight" (after the confirm flow) and "The Tick". Rewrite "The Tick" to reference the self-wake mechanism as the source of wakes. Keep "Context Is Cleared Every Tick" but reframe it: the clearing is done by the self-wake mechanism's prompt delivery, not by an extension-delivered tick. The `ptySendPrompt` `clearBeforePrompt` reference (lines 355–356) stays — it documents the mechanism the agent uses to clear its own context on each wake.

**Edge cases:**
- The agent's runtime may not support background terminals. The native scheduling alternative covers this.
- The interval may be changed mid-session. The agent re-reads `orchestrationConfig.intervalMinutes` on each wake and adjusts if needed (restart the background loop with the new interval).
- The background terminal may die. The agent should check on each wake that its background loop is still running, and restart it if not.

#### Step 2 — Augment "Signals" with act instructions (NOT restore "Handling What Comes Back")

> **Superseded:** "Restore 'Handling What Comes Back'. Restore the section from the Aug 16 version."
> **Reason:** The current skill already has a "Signals" section (lines 309–335) that covers the detection side: completion reports in plan files, the reports directory, and asking the lead. Restoring a separate "Handling What Comes Back" section would duplicate the detection instructions and create two sources of truth for the same information.
> **Replaced with:** Augment the existing "Signals" section with the ACT instructions that are genuinely missing. After the "Two things that look like signals and are not" block, add:

```markdown
### What to do when a signal arrives

When a completion report or report file tells you a subtask is done:

1. **Verify via git** (see Verify via Git). The report is a nudge, not status of record.
2. **Act based on what you find:**
   - **Coding complete and verified** → the coding team's head advances the card to CODE REVIEWED (see "What You Never Do" — you do NOT own this transition). You dispatch review by messaging the lead to review it, or by dispatching a reviewer.
   - **Blocked with a question** → answer it if you know the answer; escalate to the human via the session log if you don't.
   - **Crashed or out of context** → re-dispatch the work to the same lead.
   - **Feature fully coded** → run merge-back (per-feature worktree mode only; see Merge-Back).
   - **Escalation needed** → write it to the session log and continue with other work.

### Turn-end notice processing

When a `from: system` mirror of a `[switchboard:turn-end]` notice appears in the reports directory:

- **`finished`** (plan file mtime advanced) → verify via git, then act per the instructions above.
- **`blocked`** (seat went quiet without a completion report) → check the terminal. If it is asking a question, answer it or escalate. If it crashed or ran out of context, re-dispatch the work to the same lead.

A turn-end notice is a nudge to read the board — not a command. The board and git are still the status of record.
```

This preserves the existing Signals detection instructions and adds the missing act/processing layer.

#### Step 3 — Resolve the CODE REVIEWED transition contradiction

> **Superseded:** "Restore 'Transitions You Own'. CODE REVIEWED: when a subtask's coding is verified complete, move it to CODE REVIEWED and message the lead to review it."
> **Reason:** The Aug 17 rewrite deliberately moved the CODE REVIEWED transition to the coding team's head. The current skill's "What You Never Do" section (line 444) explicitly states: "Advance a card to CODE REVIEWED. The coding team's head owns that advance through board dispatch. If you also do it, the two race on the same card." Restoring the orchestrator's ownership of this transition recreates the exact race condition the rewrite was designed to prevent. This is a design reversal, not a bug fix.
> **Replaced with:** Two options, requiring user decision (see User Review Required):

**Option A (keep the rewrite's design — recommended):** The orchestrator does NOT advance to CODE REVIEWED. The coding team's head owns that transition. The orchestrator's role is to DETECT completion (via Signals) and DISPATCH review (message the lead to review, or dispatch a reviewer). Add a "Transitions You Own" section that lists only the transitions the orchestrator actually owns under the current design:

```markdown
## Transitions You Own

- **PLAN REVIEWED → CODER CODED / LEAD CODED / INTERN CODED**: message the lead, the lead's team does the coding. The card moves on dispatch (the move IS the dispatch).
- **CREATED → PLAN REVIEWED**: dispatch CREATED plans to the planning team or planner. This is routine, not an escalation.
- **Dispatching review**: when a subtask's coding is verified complete, message the lead to review it (or dispatch a reviewer). You do NOT advance the card to CODE REVIEWED yourself — the coding team's head owns that advance (see What You Never Do).
- Writing user decisions into the plan file when a question is resolved.
- Handling research gaps by dispatching a research agent.
```

**Option B (revert to the original design — user must confirm):** The orchestrator owns the CODE REVIEWED transition. This requires deleting the "Advance a card to CODE REVIEWED" entry from "What You Never Do" and restoring the original transition. This recreates the race condition risk and must only be chosen if the coding team's head is confirmed to NOT also advance to CODE REVIEWED.

**Proceeding assumption:** Option A (keep the rewrite's design) unless the user chooses Option B.

#### Step 4 — Enforce lead-only dispatch

Add an explicit rule in Hard Rules (after existing Hard Rule 5):

```markdown
6. **Dispatch to the lead, never to individual coders.** You message the team lead. The lead delegates to its own coders. You never call `POST /kanban/dispatch` to route work to a specific coder terminal. The only dispatch verbs you use are:
   - `POST /kanban/queue/next` with `{ from: "<lead terminal name>" }` — hands the next staged card to the lead.
   - `POST /terminals/verb/ptySendPrompt` to the lead's `friendlyName` — messages the lead directly.
   If no lead terminal exists for a feature, record it in the session log and continue with the features that do have one.
```

**Implementation:** Add as Hard Rule 6 in the "Hard Rules" section (after the current rule 5 about worktree messaging). Update "The Tick" section to reference `POST /kanban/queue/next` as the dispatch mechanism for the coding lane, not the ambiguous "dispatch it to the coding team."

#### Step 5 — Fix terminal detection with a health check

Add a "## Port Discovery" section (or fold into Pre-flight) that mirrors the `/switchboard` launcher's health check:

```bash
PORT_FILE="$ROOT/.switchboard/api-server-port.txt"
if [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE")
  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" 2>/dev/null)
else
  HEALTH="000"
fi
if [ "$HEALTH" != "200" ]; then
  echo "Board is not responding on port $PORT. The port file may be stale."
  echo "If the extension restarted, the port may have changed. Check the extension output or .switchboard/api-server-port.txt."
fi
```

State the rule: "A port file is not liveness. Read the port, call `GET /health`, and treat only a 200 as 'a board is running'. A stale port file pointing at a dead port means the board is down, not that no terminals exist."

**Implementation:** Replace all bare `PORT=$(cat .switchboard/api-server-port.txt)` snippets in the skill (lines 70, 197, 386) with the health-checked version, or add a "Port Discovery" section at the top that defines a `resolve_base` shell function and reference it in all subsequent snippets.

#### Step 6 — Strengthen the pre-flight output contract

The current skill (lines 137–140) already has: "A passing check produces no output. If all checks pass, the pre-flight report is simply `Pre-flight clear.`" Strengthen this with an explicit callout at the top of the "The six checks" subsection:

```markdown
> **Pre-flight output contract.** A passing check produces no output. Only failing checks are reported, one line each. The report ends with the ready-card summary in the format below. No diagnostic narration, no terminal listings, no port-probing output, no "here's what I found" preamble. If all checks pass, the report is simply `Pre-flight clear.` followed by the ready-card summary.
```

Keep the ready-card format from the current skill (two counts, one line per card, `+N more` for >25).

**Implementation:** This is a reinforcement of existing text, not a new addition. Add the callout blockquote before the numbered checks list.

#### Step 7 — Present self-wake as alternative to handoff, not replacement for a broken mechanism

> **Superseded:** "Remove the handoff model as the default. The handoff sequence exits the orchestrator and expects the lead to self-pace via POST /kanban/queue/next — but the lead is never told to do this."
> **Reason:** The handoff model is not broken. The queue-watch nudge mechanism (`armQueueWatch` in `PlanIngestionEngine.ts:255` + the sweep) dispatches the next card to the lead automatically when the lead goes idle and cards remain in the DISPATCH queue. The lead does not need to call `POST /kanban/queue/next` itself — the queue watch does it. The claim "the lead is never told to self-pace" is inaccurate.
> **Replaced with:** Present self-wake as an ALTERNATIVE to handoff, not a replacement for a broken mechanism. Modify the "Handoff, or arm?" section to present three options:

```markdown
## Handoff, arm, or self-wake?

Three session models:

- **Handoff (default for one team):** One coding team working through a queue of plans. You scope the work, launch the team, stage the queue, dispatch the first card, report the handoff, and exit. The queue-watch nudge mechanism (`armQueueWatch`) dispatches subsequent cards to the lead automatically when it goes idle — the lead does not self-pace, the queue watch does it for them.
- **Arm (multi-team exception):** Multiple teams across worktrees or separate repos requiring persistent coordination. State the reason, confirm to arm, and the extension's armed state keeps the session alive.
- **Self-wake (agent-managed persistence):** The orchestrator stays alive and self-wakes on a timer (see Self-Wake). Use when you want the orchestrator to actively monitor completions, dispatch review, and run merge-back rather than relying on the queue watch alone. This is the model that restores the completion-handling and transition-ownership behavior the original orchestrator had.
```

The handoff sequence (`POST /orchestration/handoff`) remains available and is still the default for single-team sessions. Self-wake is the explicit choice for sessions where the orchestrator needs to actively manage the pipeline.

#### Step 8 — Restore "Batch Completion"

Restore the section from the Aug 16 version, adapted for the self-wake model:

```markdown
## Batch Completion

When every feature is merged or escalated: write a final session-log summary (merged features, escalations outstanding). Stop the self-wake background script. The session is complete.
```

**Implementation:** Add after the "Merge-Back" section. This is the one section that was genuinely deleted and not replaced.

#### Step 9 — Keep the pre-flight interview

Keep the pre-flight interview (6 checks, propose goal, wait for confirmation) from the rewrite. It has value as an attended phase before going unattended. The confirm → arm flow (`POST /orchestration/confirm`) stays as-is in the code. No changes needed — this step is a confirmation that the pre-flight interview should be preserved.

#### Step 10 — Keep the planning lane

Keep the planning lane from the rewrite. The orchestrator dispatches both coding and planning work. CREATED plans go to the planning team/planner; PLAN REVIEWED features go to the coding team lead. No changes needed — this step is a confirmation that the planning lane should be preserved.

## Verification Plan

### Automated Tests

No automated tests are applicable — this plan modifies a skill documentation file (`.agents/skills/switchboard-orchestrator/SKILL.md`), not source code. The verification is manual and behavioral.

### Manual Verification

1. **Self-wake test:** Start the orchestrator, confirm the session, verify the agent starts a background sleep loop in a separate terminal. After the interval elapses, verify the agent wakes and re-reads the board.

2. **Completion handling test:** Dispatch a feature to a lead. When the lead completes a subtask (completion report in plan file), verify the orchestrator detects it on the next wake, verifies via git, and acts (dispatches review to the lead). Under Option A, verify the orchestrator does NOT advance the card to CODE REVIEWED itself — the coding team's head does.

3. **Lead-only dispatch test:** Verify the orchestrator sends work to the lead terminal only, never to `Coding-coder-1` or `Coding-coder-2` directly. Check the session log for the dispatch target.

4. **Terminal detection test:** Restart the VS Code extension (port changes). Verify the orchestrator's health check detects the new port rather than reporting no terminals.

5. **Pre-flight output test:** Start the orchestrator fresh. Verify the pre-flight report is the concise format (two counts + card list) with no diagnostic narration.

6. **Handoff still available test:** Verify the handoff sequence (`POST /orchestration/handoff`) still works as an explicit option. Verify the queue-watch nudge mechanism dispatches subsequent cards to the lead after handoff.

7. **Batch completion test:** When all features are merged or escalated, verify the orchestrator writes a final session-log summary and stops the self-wake background script.

## Outstanding Questions

- **[user]** Should the orchestrator own the CODE REVIEWED transition (Option B, reverting the Aug 17 design), or should the coding team's head keep owning it (Option A, keeping the current design)? — proceeding on the assumption that Option A (keep the current design) is correct, since the rewrite's race-prevention rationale is sound and the orchestrator can dispatch review without owning the column advance.
- **[user]** Should self-wake replace handoff as the default session model, or should handoff remain the default with self-wake as an explicit alternative? — proceeding on the assumption that handoff remains the default for single-team sessions (it has a working queue-watch backstop) and self-wake is the explicit choice for sessions needing active completion management.
