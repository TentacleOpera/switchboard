# Orchestrator Persona — One Tick, One Action, No Miscellaneous

## Goal

Rewrite `.agents/skills/switchboard-orchestrator/SKILL.md` for how agent-managed mode actually runs: Switchboard wakes the orchestrator on an interval, it assesses the board, it takes at most one action, and it stops. No kickoff ceremony, no forced grouping, no `Miscellaneous`.

### Why the current persona is wrong for this

**It is a batch manager, not a tick.** Its entry point is *"your first and only system-injected prompt"* (`SKILL.md:31`) — scan the board, group everything into features, sweep the leftovers into `Miscellaneous`, message every lead, then STOP. It ends with *"Do not restart or re-group."* (`:153`). On an interval, wake two has no defined behaviour: a naive implementation either re-runs the kickoff or does nothing forever.

**Its grouping step exists to satisfy a constraint that is being removed.** The `Miscellaneous` sweep is there because per-feature worktrees were forced on it, and a featureless plan had nowhere to be coded (see `worktree-strategy-is-the-users-choice.md`). With the default becoming one checkout, one team at a time, a standalone plan dispatches straight to a team and the sweep has no reason to exist.

**Nothing in it is idempotent or bounded.** It has no rule against acting twice on work already in flight, and no notion of a wake arriving while the previous pass is still running — a reentrancy the event-driven design never had.

### The sweep lives in a second file, and this plan removes it there too

Verification 5 below requires that **no `Miscellaneous` feature is ever created**. Deleting the sweep from the persona alone does not achieve that: the persona delegates grouping to `.agents/skills/group-into-features/SKILL.md`, whose `## Unattended mode` section (`:144-155`) mandates the sweep in writing — *"Every in-scope plan that ended up standalone … is assigned to a feature named `Miscellaneous`, so the batch has no ungrouped remainder"* — with `assign-to-feature.js` (`:150`) and `create-feature.js` (`:152`) invocations spelled out. That section is gated on `UNATTENDED=true`, which the orchestrator prompt injects (`TaskViewerProvider.ts:10372`) and will keep injecting. The tick stops asking for a sweep; the skill it calls performs one anyway.

**In scope for this plan:** delete the `Miscellaneous` sweep bullet and its two command examples from `## Unattended mode` in `.agents/skills/group-into-features/SKILL.md`, and regenerate the `.claude/skills/group-into-features/SKILL.md` mirror rather than hand-editing it (`.agents/` is authored; the `.claude/` tree is generated — `ClaudeCodeMirrorService.ts` `MIRROR_MANIFEST`).

*(Provenance: this scope was identified on 2026-08-17 during the grouping of this plan into the feature **The Orchestrator Runs as a Ticking Agent**, `91921c47-deec-45c5-87a3-3c1731322d6e`, and folded into the plan body on the following replan. Nothing else in the plan changed.)*

## The tick

The orchestrator's whole job is to keep two lanes fed. Each lane has a capacity guard and a dispatch action, and the lanes are **independent** — a busy coding team must never stop a plan reaching a free planner.

**Coding lane**

1. Coding team still working → **wait.**
2. Otherwise, a feature in PLAN REVIEWED → dispatch it to the coding team.

**Planning lane**

3. Planner not available → **wait.**
4. Otherwise, plans in CREATED → dispatch to the planning team or planner.

Assess both lanes on every wake. Waiting is the expected outcome most of the time, not a failure.

### How the guards are answered

Three signals, all of which the orchestrator can read or ask for directly:

1. **Completion reports in the plan files.** A dispatched agent appends a completion summary to its plan file when it finishes (`CODING_COMPLETION_REPORT_DIRECTIVE`, `agentPromptBuilder.ts:884`; plan files are write-once-at-the-end). The report's presence is the fact.
2. **The reports directory.** `.switchboard/orchestrator/reports/` holds `finished` / `blocked` / `question` / `status` files posted by leads, and `from: system` mirrors of `[switchboard:turn-end]` notices (see `agent-reports-go-to-a-file-inbox.md`). Drain it every wake; claim what you act on.
3. **Ask the lead.** Message it for a status update via `ptySendPrompt` when the files are ambiguous. The reply arrives as a report file when the lead is not talking to a pty.

**Two things that look like signals and are not:**

- **Column state.** Cards move on coding *start* — the move **is** the dispatch, and they never move on finish (`switchboard-contracts` #1). A card in a coding column means work began, not that it ended.
- **Terminal silence.** A lead is idle most of the time by design: it hands a subtask to a coder and waits. Silence is its normal working state, not a completion.

**What is deliberately not on this list:**

- **Grouping loose plans into features.** It is a judgement about what belongs together, not something a timer should do every ten minutes.
- **Advancing cards.** The coding team's head now owns the advance to CODE REVIEWED through board dispatch (see `coding-team-sends-the-feature-to-review-not-each-subtask.md`). The orchestrator must not also do it, or the two race on the same card.
- **Merge-back**, under the default `none` topology — there is nothing to merge back. It applies only when the user has chosen `per-feature`.

## Context is cleared every tick

Each wake clears the terminal and hands the agent a fresh prompt: the persona, plus `.switchboard/orchestrator/session.md` — the agreed goal and scope, and the log of what has happened. It re-reads the board and git from scratch and decides from that.

**Why cleared rather than continuous.** Every other rule here already says so. "Ground truth over self-report" and "re-derive every wake" are instructions to distrust memory — and a context that has been accumulating since 9pm is precisely a memory competing with the board. A long-lived context also grows without bound across an overnight run, and the compaction that eventually follows can silently drop the session goal, which is the one thing that must survive to 6am.

Clearing makes tick N and tick N+40 identical in construction. It also makes the session recoverable: kill the terminal, restart it, and nothing is lost, because everything that mattered was on disk. The mechanism already exists — `ptySendPrompt` takes `clearBeforePrompt` (`src/standalone/ptyPromptDelivery.ts:32`, `ptyHost.ts:248`).

**What this demands in exchange:** anything the next tick needs must be written to the session file when it happens. A dispatch that is not logged is a dispatch the next tick will make again. That is a real constraint, and it is the reason the log is append-only and written at the moment of action rather than at the end of a pass.

### The three things that must survive a cleared context

Clearing context turns every remembered fact into a bug. Name what has to be on disk, or the rules below describe behaviour the agent cannot perform:

1. **Dispatches.** Logged to `session.md` at the moment of action. Unlogged dispatch = repeated dispatch.
2. **Escalations.** Verification 7 requires an escalated item to stay escalated. With no memory, the only way the tick knows is the log — so an escalation entry names the planId or feature, and the tick treats a logged escalation as a hard skip for that item for the rest of the session.
3. **Stall counters.** The current persona tracks these in `.switchboard/orchestrator/progress.json` — `{ [planId]: { branch, lastSeenSha, stallCount } }` — and escalates at `stallCount >= 3` (`SKILL.md:100-105`). Stall detection is inherently cross-tick, so this file is not optional under a cleared context; it is the mechanism that makes it possible. **It carries over unchanged.** Read it every wake, write it whenever a branch tip is checked.

> **Superseded:** the rewrite's "Rules that carry over unchanged" list, which omitted stall detection and `progress.json` entirely.
> **Reason:** a wholesale persona rewrite that does not mention a shipped mechanism deletes it by silence. Stall detection is also the one existing rule that a cleared context makes *more* necessary, not less — a continuous context could have held the counter in memory; a tick cannot.
> **Replaced with:** `progress.json` is named explicitly above and retained in the carry-over list below.

## Rules the tick needs and the current persona lacks

- **One dispatch per lane per wake.** A wake may feed both lanes, never the same lane twice.
- **Silent when idle.** A no-op wake writes nothing to the session log. At a ten-minute interval, logging every wake makes the overnight record unreadable — which defeats the log's only purpose. Most wakes are no-ops.
- **A wake arriving mid-pass is dropped, not queued.** Never two passes at once.
- **Re-derive every wake.** Read the plan files and the board fresh; never trust what a previous wake believed. "Still working" is a fact about the world, not a remembered flag.
- **Obey the worktree setting; never write it.** Read it, follow it.

### Drop-not-queue is a host guarantee, not a persona rule

A skill document cannot decline a prompt it has already been handed. By the time the agent reads "drop this wake", the wake has been delivered and the previous pass's context has been cleared out from under it — which is worse than queueing.

**The wake deliverer owns this.** `automation-tab-three-exclusive-modes.md` supplies the interval; it must not deliver a wake while the previous prompt is still being worked, and must drop rather than queue the skipped one. The persona states the rule so an agent reading it understands the contract it is operating under, and adds nothing else — no lock file, no self-imposed mutex. If the deliverer does not enforce it, the persona cannot compensate, and that is the correct place for the requirement to live.

## Rules that carry over unchanged

- Ground truth over self-report — an agent saying "done" is a nudge to verify, never status of record.
- Verify via git: commits ahead of base, `git status --porcelain` for a dirty tree, tests where the plan specifies them.
- Stall detection via `.switchboard/orchestrator/progress.json`; escalate at `stallCount >= 3` and stop re-dispatching that subtask.
- Board ops through the API path only (`move-card.js` → `POST /kanban/move`), never sqlite writes.
- No confirmation gates; it runs unattended. Escalations go to the session log and it moves on.
- Worktree messaging is one line: "You're in a worktree at `<path>`, an isolated sibling checkout." No safety blocks, no corruption warnings.
- Merge-back one feature at a time, abort-eject-escalate on a conflict it cannot resolve coherently — reachable only under `per-feature`.

## Scope widens to planning

The current persona is coding and code review only: *"You never automate planning; planner-stage questions/warnings escalate to the human."* (`SKILL.md:4-5`). The planning lane above overturns that — dispatching a CREATED plan to a planner is now the orchestrator's job.

What still escalates is unchanged in kind: a **question** it cannot answer, a stalled agent, a conflict it cannot resolve. Feeding the planning lane is routine work; deciding a planner's open question is not.

## What this plan does not own

`orchestration-starts-as-a-conversation.md` writes `## Pre-flight` and `## Session File` into this same skill file and lands first. **This rewrite must leave those two sections intact** and rewrite everything else. Do not restate the pre-flight protocol here, and do not re-specify the session file's structure — reference them.

## Order — land this last

This is **4 of 4** in the orchestration set, and it is the one that consumes everything the other three build:

- `worktree-strategy-is-the-users-choice.md` (1 of 4) — the tick obeys the worktree setting and assumes `none` is the default. Without it, the setting is still being forced out from under the user and "obey it, never write it" describes nothing.
- `automation-tab-three-exclusive-modes.md` (2 of 4) — supplies the interval that produces the wake, and owns drop-not-queue. Without it there are no ticks to describe.
- `orchestration-starts-as-a-conversation.md` (3 of 4) — writes `session.md` at confirmation. This plan clears context every tick and hands the agent that file; land the persona first and each tick wakes with no goal, no scope and no log.

Landing it early is not merely premature — it replaces a persona that works today with one describing a world that does not exist yet, so orchestration is worse in the interval, not just unchanged.

## Metadata

**Complexity:** 4
**Tags:** docs, refactor, reliability

## User Review Required

None.

## Complexity Audit

### Routine

- Rewriting a 153-line skill document.
- Deleting three lines and two command examples from `group-into-features/SKILL.md`.
- Regenerating two `.claude/` mirrors.

### Complex / Risky

- **A persona is executable specification with no compiler.** Every rule that names a mechanism must name one that exists, or the tick silently does nothing. This is the failure class that made the current persona wrong for interval operation in the first place.
- **Rewriting a file another subtask is also writing.** Two of this file's sections belong to `orchestration-starts-as-a-conversation.md`. A wholesale rewrite that regenerates the file from scratch destroys them.
- **Deleting a documented behaviour from a shared skill.** `group-into-features` is invoked by paths other than the orchestrator; the sweep must be removed from `## Unattended mode` only, leaving the attended flow untouched.
- **Timing.** This is the plan whose early landing actively degrades a working system — the sequencing is a correctness constraint, not a preference.

## Edge-Case & Dependency Audit

### Race Conditions

- **Wake during a pass.** Owned by the deliverer (above). The persona must not attempt to detect it.
- **Tick vs. the coding head on the same card.** Both could advance to CODE REVIEWED. Resolved by ownership: the head owns the advance, the tick never performs it. This is a rule, not a lock, so a violation shows up as a double move — check for it in verification 6.
- **Tick vs. the run sheet.** Agent-managed and Scheduled are exclusive modes (`automation-tab-three-exclusive-modes.md`), so both dispatching the same board is prevented upstream by mode exclusivity plus the existing `isAutomationArmed` double-dispatch guard (`TaskViewerProvider.ts:1078`). The persona relies on that and adds no guard of its own.
- **Claim markers vs. staleness.** A report claimed more than `stalenessHours` ago (default 24) reads as unclaimed again. Harmless for an overnight session; worth knowing for one that runs longer.

### Security

- No new surface. The persona keeps the existing hard rule: board writes only through `move-card.js` / `POST /kanban/move`, read-only SQL for verification, never a sqlite write.
- The persona runs unattended with no confirmation gates — that is deliberate and matches the project rule against confirm dialogs.

### Side Effects

- Removing the `Miscellaneous` sweep leaves standalone plans ungrouped. That is the intent: under the `none` worktree default a standalone plan dispatches straight to a team. Existing `Miscellaneous` features already on a board are not touched by this plan and are not migrated — they are ordinary features the user can delete.
- Widening scope to planning means CREATED cards now move without a human, on boards where that previously never happened. It is gated by the session goal and scope agreed in the pre-flight.

### Dependencies & Conflicts

- **`.agents/skills/switchboard-orchestrator/SKILL.md`** — shared with `orchestration-starts-as-a-conversation.md`, which lands first and owns two sections. Hard ordering constraint.
- **`.agents/skills/group-into-features/SKILL.md`** — sole editor. No other subtask in this feature touches it.
- **`agent-reports-go-to-a-file-inbox.md`** — supplies signal 2. If it has not landed, the tick works with signals 1 and 3 only and a non-pty orchestrator's lane guards are weaker. Not a blocker; the persona should describe the reports directory regardless, since its absence degrades gracefully to an empty listing.
- **`coding-team-sends-the-feature-to-review-not-each-subtask.md`** — supplies the head that owns the CODE REVIEWED advance the persona hands off. If it has not landed, nothing performs that advance and features stall at coded. Land it before or alongside this plan.

## Dependencies

- `sess_worktree_strategy — worktree-strategy-is-the-users-choice.md` (1 of 4)
- `sess_automation_modes — automation-tab-three-exclusive-modes.md` (2 of 4) — the interval, and the drop-not-queue guarantee
- `sess_starts_as_conversation — orchestration-starts-as-a-conversation.md` (3 of 4) — `session.md`, and the two sections this rewrite must preserve
- `sess_file_inbox — agent-reports-go-to-a-file-inbox.md` — signal 2; degrades gracefully if absent
- `sess_coding_head_advance — coding-team-sends-the-feature-to-review-not-each-subtask.md` — the owner of the CODE REVIEWED advance

## Adversarial Synthesis

**Risk summary.** The dominant risk is a persona that describes machinery which does not exist: land it before the interval, the session file, or the coding head, and every tick wakes with no goal and hands off an advance nobody performs — orchestration gets worse rather than staying still. Mitigations are the hard ordering constraint (4 of 4, explicitly justified) and stating drop-not-queue as a requirement on the wake deliverer rather than a rule the document pretends to enforce. Secondary risks are the wholesale rewrite clobbering the two pre-flight sections another subtask owns (closed by the ownership split), and the `Miscellaneous` sweep surviving one call deeper in `group-into-features` (closed by editing that skill in the same change).

## Proposed Changes

### `.agents/skills/switchboard-orchestrator/SKILL.md`

- **Context.** 153 lines built around a single kickoff (`:31-48`), event-driven signal handling (`:71-92`), and a batch-completion terminator (`:150-153`). Referenced by absolute path from `TaskViewerProvider.ts:10361`, so the filename must not change.
- **Logic.** Replace the kickoff/batch frame with the tick frame, keeping every rule that is still true and the two sections owned by the pre-flight plan.
- **Implementation.**
  - **Delete:** `## Kickoff` (`:31-48`) in full, including the `Miscellaneous` sweep at `:37-38` and the forced grouping at `:34-36`. `## Batch Completion` (`:150-153`) in full. The "No timers, no polling, no self-scheduling" hard rule (`:10-14`) — it is now false. The planning-scope exclusion in `## Role & Scope` (`:4-5`).
  - **Add:** `## The Tick` (both lanes, capacity guards, one dispatch per lane per wake, assess both every wake). `## Signals` (the three above, and the two non-signals). `## Context Is Cleared Every Tick` (what must be on disk: dispatches, escalations, `progress.json`). `## What You Never Do` (advance to CODE REVIEWED, group loose plans, merge-back under `none`, write the worktree setting).
  - **Keep, edited:** `## Messaging Leads` (`:50-69`) unchanged except that a lead's reply may arrive as a report file. `## Verify via Git` (`:94-105`) unchanged, including `progress.json`. `## Escalation Boundary` (`:138-144`) with planner-stage *dispatch* moved to routine and planner-stage *questions* still escalating. `## Merge-Back` (`:116-136`) unchanged, scoped to `per-feature`. Hard rules 2-6 (`:15-29`) unchanged.
  - **Do not touch:** `## Pre-flight`, `## Session File`.
  - Retitle `## Session Log` to point at `session.md` and note the log half is append-only and silent on idle ticks — deferring the file's structure to `## Session File`.
- **Edge cases.** The `UNATTENDED=true` flag stays in the injected prompt; after this change its only remaining effect is gating `group-into-features`' confirm-skip. Say so, so a reader does not assume it still triggers a sweep.

### `.agents/skills/group-into-features/SKILL.md` (`## Unattended mode`, `:144-155`)

- **Context.** Gated on `UNATTENDED=true`. Bullet `:148` mandates the sweep; `:149-153` give the `assign-to-feature.js` / `create-feature.js` invocations and the zero-leftovers guard.
- **Logic.** Remove the sweep; leave the confirm-skip and the shell-safety and BACKLOG rules intact.
- **Implementation.** Delete the `:148` bullet and its three sub-bullets (`:149-153`). Keep `:147` (skip the CONFIRM gate), `:154` (shell-safety), `:155` (skip BACKLOG). Add one line stating that standalone plans are left standalone, and why — a plan with no feature dispatches directly under the `none` worktree default.
- **Edge cases.** The attended flow above `:144` must be byte-identical afterwards. Grep the tree for `Miscellaneous` when done: no remaining instruction should create one.

### `.claude/skills/switchboard-orchestrator/SKILL.md` and `.claude/skills/group-into-features/SKILL.md`

- **Implementation.** Regenerate from `.agents/` via the mirror service. Do not hand-edit. Note that `.claude/skills/switchboard-orchestrator/` does not currently exist — the orchestrator persona is read by absolute `.agents/` path (`TaskViewerProvider.ts:10361`) and is not in `MIRROR_MANIFEST`; do not add it to the manifest as part of this plan.

## Verification Plan

Run agent-managed mode on a real board and watch several wakes:

1. A wake with nothing to do writes nothing and dispatches nothing.
2. A feature in PLAN REVIEWED with a free coding team is dispatched; a wake while that team is still working dispatches nothing to it.
3. Plans in CREATED with a free planner are dispatched; a wake while the planner is busy dispatches nothing to it.
4. **The lanes are independent:** with the coding team busy and the planner free, a CREATED plan is still dispatched.
5. No `Miscellaneous` feature is ever created, and loose plans dispatch without being grouped first. Grep `.agents/` and `.claude/` afterwards — no instruction to create one remains in either tree.
6. The orchestrator never advances a card to CODE REVIEWED — that advance comes from the coding team's head.
7. An escalated item stays escalated — it is not retried on every wake, across a terminal restart as well as across wakes.
8. The worktree setting is identical before and after a full session.
9. Ten consecutive idle wakes produce a session log with no new entries.
10. `## Pre-flight` and `## Session File` are byte-identical before and after the rewrite.
11. A subtask whose branch tip does not move across three checks is escalated once and not re-dispatched — `progress.json` shows the counter and the escalation appears in the log exactly once.
12. A wake that fires while the previous pass is still running does not start a second pass — and the persona attempts no self-imposed lock.

### Automated Tests

Not run this session (SKIP TESTS directive), and largely not applicable — the deliverable is two markdown documents. The one mechanical check worth automating is a grep gate: no `Miscellaneous` sweep instruction in `.agents/` or `.claude/`, and `## Pre-flight` / `## Session File` still present in the persona.

---

**Recommendation:** Complexity 4 → **Send to Coder.**

## Completion report (2026-08-17, appended by lead-1)

Implemented in `f07a8038`. The persona was rewritten from a one-shot batch manager into a ticking agent: two independent lanes with capacity guards, one dispatch per lane per wake, context cleared every tick and rebuilt from `session.md`, silent on idle. `## Kickoff`, `## Batch Completion`, `## Handling What Comes Back`, `## Transitions You Own` and the false no-timers hard rule were deleted; `## The Tick`, `## Signals`, `## Context Is Cleared Every Tick` and `## What You Never Do` were added. The `Miscellaneous` sweep was also removed from `group-into-features`' `## Unattended mode` and its mirror regenerated. Verification 10 was checked independently: `## Pre-flight` (4675 bytes) and `## Session File` (786 bytes) are byte-identical across the rewrite.

Verified by lead-1 against the diff rather than the coder's account. Compilation and tests not run — SKIP COMPILATION / SKIP TESTS were in force for this run, so this plan's written Verification Plan remains unexecuted. Note: the coder reported completion to the lead over `ptySendPrompt` and was never instructed to append this report itself, so the board saw no completion signal for this card until now.

## Review Findings

Reviewed 2026-08-17 with tests run. **MAJOR:** the rewrite kept Hard Rule 2 verbatim — *"Scope boundary. Coding + code review only. Planner-stage items escalate."* — which contradicts `## Role & Scope`, the planning lane in `## The Tick`, and `## Escalation Boundary`; an unattended agent obeying Hard Rules over prose would never feed lane 2, silently killing half the feature. Rewritten to state that planner dispatch is routine and only planner-stage *questions* escalate. Also fixed: `## Escalation Boundary`'s vague "stage advancement" now excludes the CODE REVIEWED advance the coding head owns (the double-move race the plan calls out), the `UNATTENDED=true` edge-case note the plan required was added, and the `Signals` pointer now names the claim-marker path and defers the format to `switchboard-orchestration`. Verification 10 holds: `## Pre-flight` is byte-identical and `## Session File` differs only by one trailing blank line. Files changed: `.agents/skills/switchboard-orchestrator/SKILL.md`, plus the new gate `src/test/orchestrator-tick-and-reports-contract.test.js` wired as `test:contract:orchestrator-tick` in CI — the grep gate this plan named was never built, so persona coherence, the `Miscellaneous` sweep's absence from both trees and `progress.json`'s survival had no automated check at all. Remaining risk: none in this subtask; the persona still describes a wake interval the automation-modes feature must deliver.
