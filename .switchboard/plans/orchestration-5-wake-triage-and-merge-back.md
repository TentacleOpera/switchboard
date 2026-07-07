# Orchestration Wake + Triage Loop with Feature-by-Feature Merge-Back

## Goal

Close the loop: on each preconfigured interval, the *system* wakes the orchestrator; it drains the request inbox, verifies real progress against git and board state, writes a triage summary to the session log, and acts — advancing stages, dispatching research, escalating planner-stage or unresolvable items to the human, and merging completed features back (feature by feature, resolving conflicts). The batch ends when every feature is merged or escalated.

### Problem / background / root cause

Kickoff (subtask 4) leaves the fleet running and the orchestrator asleep. Something has to reconvene it, and the decision is explicit: **the system wakes it, not itself.** The autoban engine already ticks on `intervalMinutes` with `lastTickAt` tracking — the state types live in `src/services/autobanState.ts` (`lastTickAt?: Record<string, number>` at `:71`, interval clamping at `:43`), while the timers themselves live in `src/services/TaskViewerProvider.ts` (`_autobanTimers`/`_autobanLastTickAt`/`_autobanTickQueue` fields at `:341-346`, engine at `_startAutobanEngine` `:8741`, serialized tick at `_enqueueAutobanTick` `:8726`, per-column dispatch at `_autobanTickColumn` `:8836`) — which is exactly the heartbeat needed. In Orchestration mode the tick, instead of doing per-column dispatch, re-invokes the orchestrator with a "check status" wake. On wake the orchestrator must judge progress from **ground truth** (git branch ahead of base, commits, tests, card column, and the `plan_events` audit table) because an agent reporting "done" is unreliable; the inbox (subtask 3) carries the questions it must triage; and merge-back is the terminal action that retires each feature.

Two hard host constraints shape the engine side of this plan: the extension host's API server and terminal registry are in-memory singletons that a hot loop of identical work can starve, so the wake tick must be **cheap** (one `fs.stat` + one terminal injection, no DB reads, no git calls) and **single-flighted**; and worktree records are DB-backed with **no reconciliation**, so merge-back cleanup must flow through the recorded worktree rows and the explicit cleanup path — never raw `git worktree remove` and never branch-name guessing (the extension auto-creates branches and other actors create branches too).

## Metadata
**Tags:** backend, feature, reliability
**Complexity:** 7
**Project:** Switchboard

## User Review Required

None. All judgment calls are decided in this plan: wakes count against the global session cap; a wake that arrives while the previous is still running is skipped, with a force-wake escape after 3 consecutive skips; the orchestrator aborts (`git merge --abort`) an unresolvable conflict to leave the checkout clean before escalating (unattended context — no user is present to take over mid-conflict, and a conflict-marked integration checkout would poison sibling merges); the empty-column auto-stop is bypassed in orchestration mode (completion = all features merged/escalated, not empty source columns).

## Complexity Audit

### Routine
- The orchestration branch in `_startAutobanEngine` is one new `if` block that reuses the existing timer map, tick queue, `lastTickAt`, pause bookkeeping, and stop helpers — same skeleton as the per-column path.
- The wake prompt injection reuses `_dispatchExecuteMessage` (`TaskViewerProvider.ts:16425`) verbatim — an existing, validated path to a named terminal (exemplar usage: `dispatchToCoderTerminal` `:7887`).
- The single-flight guard mirrors two proven in-repo patterns: `RemoteControlService._polling` (`:117`, skip at `:292`, reset in `finally` at `:338`) and `PipelineOrchestrator._isAdvancing` (`:53`, `:181-182`, `finally` at `:235`).
- Session-cap and stop-with-message handling copy the existing tick's shape (`_autobanTickColumn` cap check at `:8840-8843`, `_stopAutobanWithMessage` `:6976`, `_stopAutobanForExhaustion` `:6993`).
- Marker-file conventions (`last-wake-complete`, `batch-complete`, `progress.json`) are plain file writes in the `.switchboard/orchestrator/` directory subtask 3 creates.

### Complex / Risky
- **Single-flight across an async agent, not an async function.** The injection returns in milliseconds but the orchestrator's *work* takes minutes. In-memory guards alone cannot know when the previous wake finished; completion must be observed via the `last-wake-complete` marker the persona touches as its final act. Getting the skip/force-wake state machine wrong either stacks wakes (prompt spam into a working agent) or deadlocks the loop behind a dead terminal.
- **Pause/reset plumbing reads per-column `rules`.** `setAutobanPausedFromKanban` computes `pausedRemainingMs` from `this._autobanState.rules[column]` (`TaskViewerProvider.ts:7832-7834`) and the unpause loop drops keys whose rule is missing/disabled (`:7855`); `resetAutobanTimersFromKanban` iterates `rules` (`:7804`). The orchestration timer key has no rule, so each of these three sites needs an explicit branch or the pause math silently breaks (1-minute fallback) or the timer is dropped on unpause.
- **Auto-stop semantics invert.** The engine's existing "stop when source columns are empty" sweep (`:8777-8784` → `_stopAutobanIfNoValidTicketsRemain` `:7096`) is *wrong* in orchestration mode — mid-batch, source columns are legitimately empty while work is in flight. It must be bypassed, and replaced by the batch-complete marker check (mirroring `PipelineOrchestrator`'s auto-stop-when-nothing-pending at `:205-212`).
- **Merge-back reuses the shipped merge-prompt/cleanup path.** The `worktree_cleanup` skill (`.agents/skills/worktree_cleanup.md`), `POST /worktree/cleanup` route (`LocalApiServer.ts:1397`), and public `KanbanProvider.cleanupWorktree` (`:9969`) are now in code. The kind-aware merge-target resolution the orchestrator mirrors lives in the `copyWorktreeMergePrompt` handler (`KanbanProvider.ts:9221`) — it resolves subtask → integration → main from DB worktree rows and emits the agent-run merge steps. The orchestrator either reuses that handler's resolution logic or follows its pattern directly; it does not call non-existent merge functions. Sequencing note under Dependencies.
- **Cross-subtask contract surface.** The wake-complete/batch-complete/progress.json markers and the wake prompt are a protocol split across this plan (engine side) and subtask 2 (persona side). Drift between the two halves fails silently (engine forever "skipping" or never terminating).

## Edge-Case & Dependency Audit

**Race Conditions**
- **Overlapping wakes.** Single-flight guard; a wake that arrives while the previous is still working is skipped (re-fires next tick). Enforced two ways: the tick body runs on the serialized `_autobanTickQueue` (`TaskViewerProvider.ts:8726-8738`), and injection is gated on the `last-wake-complete` marker being newer than the last injection timestamp. Force-wake escape after 3 consecutive skips so a crashed orchestrator can't wedge the loop.
- **Wake vs. mode change / stop.** The tick body re-checks `enabled`, `paused`, and `automationMode === 'orchestration'` at the top (the queue may run a tick enqueued just before the user switched modes; `_stopAutobanEngine` at `:8791` resets `_autobanTickQueue` to `Promise.resolve()` at `:8815`, but an in-flight tick can still be executing).
- **Orchestrator board moves vs. user drags.** The orchestrator moves cards only via `POST /kanban/move` (`LocalApiServer.ts:1344`, handler `:322-361`) → the `moveCard` callback (`TaskViewerProvider.ts:1032-1056`) → `KanbanProvider.moveCardToColumn` — the same backend path a human's move takes, inheriting the feature→subtask cascade, tracker sync fan-out, and board refresh. The webview's centralized optimistic-move guard (`moveCardsOptimistically`, `kanban.html:4502`; render gate on `optimisticMoveUntil` at `:6537`) only defers renders during a user-initiated drag, so API-driven moves land as ordinary refreshes and never fight the drag state. Hard rule: never write columns via direct SQL.
- **Interrupted drain/merge.** A wake killed mid-drain must be safe to re-run: inbox processing is idempotent (move-to-`processed/` per item, per subtask 3), and merge state is re-derived from git each wake — a half-merged integration checkout is detected via `git -C <path> status`/`MERGE_HEAD` and either completed or aborted+escalated before anything else touches that feature.

**Security**
- The wake path writes only to a registered terminal via `_dispatchExecuteMessage`, which validates the agent name before using it as a path segment (`TaskViewerProvider.ts:16432-16436`). No new API surface is added by the engine. `/kanban/move` inherits the existing localhost boundary and `_checkAuth` gate (`LocalApiServer.ts:323`). The orchestrator persona runs with the same permissions as any dispatched agent; merge-back grants it nothing new — it executes git in checkouts it already owns.
- `progress.json` / markers are plain files under `.switchboard/orchestrator/` — no secrets; do not put tracker tokens or API details in them.

**Side Effects**
- Wakes increment `sessionSendCount` (persisted via `_persistAutobanState`, `TaskViewerProvider.ts:6584-6596`) — the global session cap (`_getAutobanRemainingSessionCapacity` `:6866`) becomes a hard runaway-cost stop for orchestration too, mirroring `:8840-8843`.
- Merge-back mutates main: the integration branch lands on the default branch unattended. That is the feature's settled design ("Merge-back is in scope, feature by feature"), and every landed commit is reviewable in git history plus narrated in the session log.
- Cleanup flips worktree rows to `merged` and removes directories via the recorded-row path (`_removeWorktreeRow` `KanbanProvider.ts:9907-9925` semantics: DB row is marked even if the filesystem removal fails, followed by `git worktree prune` `:9928`). Because there is no reconciliation, skipping this path would leave phantom "active" rows forever.
- The engine broadcast (`_getAutobanBroadcastState` `:7389-7394`) automatically carries the orchestration `lastTickAt` entry to the AUTOMATION tab (subtask 1's status line renders countdown from it) — no extra webview messaging is added here.

**Dependencies & Conflicts**
- **Blocked by subtask 1** (mode foundation): `'orchestration'` in the `automationMode` union (`autobanState.ts:76`) + whitelist (`:275`), `OrchestrationConfig { enabled, intervalMinutes }`, the mode-change whitelist in `setAutomationModeFromKanban` (`TaskViewerProvider.ts:7473`), and the `startOrchestrator` terminal-launch hook this plan reuses for wake-delivery recovery.
- **Blocked by subtask 3** (inbox + session log): `.switchboard/orchestrator/inbox/` (+`processed/`) and `session-log.md`. This plan adds three sibling conventions in the same directory (`last-wake-complete`, `batch-complete`, `progress.json`).
- **Blocked by subtask 4** (kickoff): the merge topology (per-feature integration + subtask worktrees, terminals, dispatched coders) must exist before there is anything to triage or merge.
- **Subtask 2 (persona)** encodes the behaviour this engine invokes; the marker/prompt contract defined here must be mirrored verbatim in `.agents/workflows/orchestrator.md`.
- **Merge-prompt/cleanup path (shipped):** the `worktree_cleanup` skill (`.agents/skills/worktree_cleanup.md`), `POST /worktree/cleanup` (`LocalApiServer.ts:1397`), and `KanbanProvider.cleanupWorktree` (`:9969`) are landed. The kind-aware merge-target resolution the orchestrator follows is in the `copyWorktreeMergePrompt` handler (`KanbanProvider.ts:9221`). No pre-land required.
- **Conflict surface with other git actors:** the extension auto-commits and creates worktree branches, and non-Switchboard actors create branches (e.g. `epic/` branches). Merge-back therefore operates **only** on branches recorded in the `worktrees` table (`KanbanDatabase.ts:175-186`, `WorktreeRow` `:21-33`, `getWorktrees()` `:2891` — active rows only), keyed by `feature_id`/`subtask_plan_id`/`tier`, never by branch-name pattern matching.

## Dependencies

None by `sess_` ID (sibling session IDs are not pinned at authoring time). Ordering, by plan file:
- `orchestration-1-automation-mode-foundation.md` — **blocks** (mode enum, `OrchestrationConfig`, start hook).
- `orchestration-3-agent-request-channel-and-session-log.md` — **blocks** (inbox + session log this loop drains and writes).
- `orchestration-4-kickoff-group-and-fan-out.md` — **blocks** (worktree/terminal topology the merge-back retires).
- `orchestration-2-persona-workflow.md` — co-requisite contract: the persona document encodes the wake/triage/merge behaviour; the marker protocol below must appear in it.

## Adversarial Synthesis

The two ways this loop dies are wake-protocol drift and merge-back running on guesses: if the engine's marker contract and the persona's behaviour disagree, the loop either spams a working agent or silently never wakes/never terminates; and any merge path not driven by DB-recorded worktree rows will eventually merge a stranger's branch or orphan un-reconciled rows. Mitigations: the marker contract is specified once here and copied verbatim into the persona; every git target comes from `getWorktrees()` rows with kind logic mirroring the shipped `mergeWorktree` branching; cleanup goes exclusively through the explicit cleanup path; and the tick body is one `fs.stat` plus one terminal injection so the fragile extension host never sees a hot loop.

## Proposed Changes

### 1. `src/services/autobanState.ts` — shared constants for the wake contract

**Context.** State types and normalizers only — the timers live in TaskViewerProvider. Subtask 1 adds `OrchestrationConfig { enabled: boolean; intervalMinutes: number }` (clamped 1–60 like `normalizeSingleColumnConfig` at `:43`) and `orchestrationConfig?` on `AutobanConfigState`.

**Logic.** This plan adds the cross-file constants so engine, persona docs, and UI agree on names:

```ts
export const ORCHESTRATION_TICK_KEY = '__ORCHESTRATION__';       // key into _autobanTimers/_autobanLastTickAt/pausedRemainingMs
export const ORCHESTRATOR_TERMINAL_NAME = 'Orchestrator';        // terminal launched by startOrchestrator (subtask 1) and woken here
export const ORCHESTRATION_MAX_SKIPPED_WAKES = 3;                // force-wake escape threshold
export const ORCHESTRATION_MAX_FAILED_WAKES = 3;                 // delivery failures before engine stops
```

**Implementation.** Plain exported consts near `AUTOBAN_SHARED_REVIEWER_COLUMNS` (`:11`). `ORCHESTRATION_TICK_KEY` is deliberately not a real column name so it can never collide with `rules` entries (normalization at `:205-227` merges arbitrary rule keys; the dunder name keeps it out of that namespace by construction — the engine never writes it into `rules`).

**Edge cases.** `buildAutobanBroadcastState` (`:282-290`) copies whatever is in the `lastTickAt` map entries — the `__ORCHESTRATION__` key rides along to the webview; subtask 1's panel reads it for the countdown. Older webviews ignore unknown keys.

### 2. `src/services/TaskViewerProvider.ts` — the wake hook (autoban tick, orchestration mode)

Preserved intent from the original plan: *in the autoban tick path, when `automationMode === 'orchestration'`, replace per-column dispatch with an orchestrator **wake**: send the orchestrator terminal a "wake: check status" prompt. Reuse the existing `intervalMinutes` + `lastTickAt` machinery and the single-flight guard so overlapping wakes don't stack (mirror the `_polling` guard pattern used by `RemoteControlService._poll`). Respect pause/stop: pausing the automation pauses wakes; stopping ends the loop.*

**Context.** `_startAutobanEngine` (`:8741`) builds per-column `setInterval` timers into `_autobanTimers` (`:341`), each tick enqueued on the serialized `_autobanTickQueue` (`:346`, `_enqueueAutobanTick` `:8726-8738` which stamps `_autobanLastTickAt` in `finally` `:8734`). Single-column mode already demonstrates a mode filter inside the loop (`:8747-8749`). The engine also arms an `onColumnChanged` watch subscription (`:8768`) and a 60s empty-column sweep (`:8777-8784`). The prompt-injection path to a named terminal already exists: `_dispatchExecuteMessage(workspaceRoot, targetAgent, payload, metadata)` (`:16425-16451`) → `_attemptDirectTerminalPush` (`:16497`), returning `false` (with a warning toast at `:16449`) when the terminal isn't running.

**Logic — new fields** (near `:341-346`):

```ts
private _orchestrationWakeSentAt = 0;      // epoch ms of last successfully injected wake
private _orchestrationSkippedWakes = 0;    // consecutive ticks skipped awaiting last-wake-complete
private _orchestrationFailedWakes = 0;     // consecutive delivery failures
```

**Logic — engine branch** (top of `_startAutobanEngine`, immediately after the `_stopAutobanEngine()` call at `:8742`):

```ts
if (this._autobanState.automationMode === 'orchestration') {
    const cfg = this._autobanState.orchestrationConfig;                 // subtask 1
    const intervalMs = Math.max(1, cfg?.intervalMinutes ?? 10) * 60_000;
    this._autobanLastTickAt.set(ORCHESTRATION_TICK_KEY, Date.now());
    this._autobanTimers.set(ORCHESTRATION_TICK_KEY, setInterval(
        () => this._enqueueOrchestrationWake(), intervalMs));
    // Deliberately: NO immediate first wake (kickoff just dispatched the fleet — the
    // first check-in fires after one full interval), NO onColumnChanged watch, and
    // NO empty-column sweep (completion is the batch-complete marker, not empty columns).
    this._postAutobanState();
    return;
}
```

**Logic — `_enqueueOrchestrationWake()`** (sibling of `_enqueueAutobanTick` `:8726`): chains `_orchestrationWakeTick()` onto `_autobanTickQueue`, catches/logs, stamps `_autobanLastTickAt.set(ORCHESTRATION_TICK_KEY, Date.now())` and `_postAutobanState()` in `finally` — identical shape to `:8727-8737`.

**Logic — `_orchestrationWakeTick()`** (the cheap tick body; sibling of `_autobanTickColumn` `:8836`):

1. **Re-check guards** (the queue may run a stale enqueue): `enabled`, `!paused`, `automationMode === 'orchestration'`, resolvable `workspaceRoot` — return otherwise.
2. **Termination check.** If `<root>/.switchboard/orchestrator/batch-complete` exists: rename it to `batch-complete.<ISO>.done` (so the next run starts clean), then `await this._stopAutobanWithMessage('Orchestration complete: all features merged or escalated. See .switchboard/orchestrator/session-log.md.', 'info')` (`:6976`) and return. This mirrors `PipelineOrchestrator`'s auto-stop-when-nothing-pending (`PipelineOrchestrator.ts:205-212`) with file-based ground truth instead of run-sheet state.
3. **Single-flight on the agent's work.** If `_orchestrationWakeSentAt > 0`, `fs.stat` `<root>/.switchboard/orchestrator/last-wake-complete`; if the file is missing or `mtimeMs < _orchestrationWakeSentAt`, the previous wake has not reported completion → `_orchestrationSkippedWakes++`; if `< ORCHESTRATION_MAX_SKIPPED_WAKES`, log and return (the wake re-fires next tick). At the threshold, fall through and prepend `Previous wake did not report completion — recover: check for an interrupted triage or merge before proceeding.` to the prompt, then reset the skip counter. This is the `RemoteControlService._polling` skip pattern (`:117`/`:292`/`:338`) extended across agent work via the marker file, plus an escape so a crashed orchestrator can't wedge the loop.
4. **Session cap.** `if (this._getAutobanRemainingSessionCapacity() <= 0)` → `_stopAutobanForExhaustion(...)` and return — mirrors `:8840-8843`. Wakes count: on successful injection, increment `sessionSendCount` and `await this._persistAutobanState()`.
5. **Inject the wake.** One line, no board state embedded (the orchestrator re-hydrates from ground truth itself; keeping the tick free of DB/git work is the anti-starvation requirement):

```
Orchestrator wake <ISO timestamp>: check status. Follow the wake/triage protocol in .agents/workflows/orchestrator.md.
```

   `const ok = await this._dispatchExecuteMessage(workspaceRoot, ORCHESTRATOR_TERMINAL_NAME, prompt, { orchestrationWake: true });`
6. **Outcome bookkeeping.** `ok` → set `_orchestrationWakeSentAt = Date.now()`, zero both failure counters. `!ok` → `_orchestrationFailedWakes++`; attempt one relaunch via subtask 1's `startOrchestrator` launch hook (so the next tick's wake finds a live terminal); at `ORCHESTRATION_MAX_FAILED_WAKES`, `_stopAutobanWithMessage('Orchestration stopped: orchestrator terminal unreachable after 3 wake attempts.')` — a total-failure state, which per project convention does merit a message.

**Logic — pause/stop/reset plumbing** (three existing sites that assume per-column rules):

- `setAutobanPausedFromKanban` (`:7826`): when computing `pausedRemainingMs` (`:7830-7837`), for `column === ORCHESTRATION_TICK_KEY` take the interval from `orchestrationConfig.intervalMinutes` instead of `rules[column]` (`:7832-7834`). In the unpause loop (`:7848-7866`), the `!rule?.enabled → continue` at `:7855` and the single-column filter at `:7850-7853` must both let the orchestration key through; resume it with the same `setTimeout → setInterval` pattern (`:7858-7865`) targeting `_enqueueOrchestrationWake`.
- `resetAutobanTimersFromKanban` (`:7788`): the rules loop at `:7804-7820` never sees the orchestration key; add a mode branch that clears/restarts the single orchestration timer and enqueues an immediate wake (the button's documented purpose).
- `_stopAutobanEngine` (`:8791`): after the existing clears (`:8811-8815`), zero `_orchestrationWakeSentAt` / `_orchestrationSkippedWakes` / `_orchestrationFailedWakes`. The generic `_autobanTimers` clear at `:8792-8795` already kills the orchestration interval because it lives in the same map.
- `_stopAutobanIfNoValidTicketsRemain` (`:7096`): add an early `if (this._autobanState.automationMode === 'orchestration') { return false; }` — in this mode empty source columns are the *normal* mid-batch state, and although the orchestration engine branch arms neither the sweep nor the watch, other public entry points still call this helper.
- `_tryRestoreAutoban` (`:7439-7448`) needs no change: it re-runs `_startAutobanEngine`, which now branches on the persisted mode; `autoban.state` round-trips via `workspaceState` (`:6595`) provided subtask 1's normalizer preserves `orchestrationConfig`.

**Edge cases.** Interval change while running: subtask 1's config panel funnels through the existing update→restart path (`setAutobanEnabledFromKanban` `:7462-7465` restarts the engine when enabled), which rebuilds the orchestration timer with the new interval. Terminal renamed/closed by the user mid-run: delivery failure path (step 6) relaunches, then stops after 3. Workspace with no `.switchboard/orchestrator/` yet (kickoff crashed early): `fs.stat` failure counts as "marker missing" — first wake still fires because `_orchestrationWakeSentAt === 0` skips the gate.

### 3. Contract with the orchestrator persona and `.switchboard/orchestrator/` (files owned by subtasks 2 & 3 — listed here as the protocol this engine requires, not as file edits in this plan)

Preserved intent from the original plan (triage): *Drain inbox (`.switchboard/orchestrator/inbox/`): for each request, decide an action by type — answer/act on a coder/reviewer question, dispatch a **research agent** for a well-formed research request, or **escalate** planner-stage questions and anything ambiguous/unresolvable to the human. Verify progress from git/board, not self-report: a subtask counts as coded only when its worktree branch is ahead of base with committed work (and tests where applicable); reviewed only when the review stage genuinely passed. Advance cards via `/kanban/move` accordingly. Session log: append a dated summary each wake — read, verified, advanced/dispatched/merged, escalated. Move processed inbox items to `processed/`.*

The persona (`.agents/workflows/orchestrator.md`, subtask 2) must encode, verbatim in contract terms:

- **Wake bracketing.** First act of every wake: append a `## Wake <ISO>` header to `session-log.md`. Last act: append the summary line **and touch `.switchboard/orchestrator/last-wake-complete`**. The engine's single-flight gate reads only that marker's mtime.
- **Ground-truth verification signals**, in precedence order:
  1. *Git:* for each in-flight subtask worktree row, `git -C <wt.path> rev-list --count <base_branch>..<branch>` (ahead-of-base with committed work) — `base_branch` comes from the row (`KanbanDatabase.ts:31`), never from guessing.
  2. *Board:* card column via the read-only kanban query path (`get-state.js` in `.agents/skills/kanban_operations/`, or the `query_switchboard_kanban` skill). Column vocabulary is `CREATED | PLAN REVIEWED | LEAD CODED | CODER CODED | INTERN CODED | CODE REVIEWED | CODED` (`src/services/kanbanColumnDerivation.ts:3`).
  3. *Audit trail:* the `plan_events` table (`KanbanDatabase.ts:222-235`, written via `appendPlanEventByPlanId` `:6791`) answers "who moved this card and when" — the designated first stop for unexpected-transition triage.
  Agent self-report is never a signal of record.
- **Stall counter storage.** `.switchboard/orchestrator/progress.json`, single-writer (the orchestrator only — the extension never reads or writes it, so the "config lives in the DB" rule is not in play; this is agent-domain working state): `{ [planId]: { branch, lastSeenSha, stallCount } }`. Each wake: if a subtask's branch tip SHA is unchanged since the last wake and its card hasn't advanced, `stallCount++`; new commits or a column advance reset it to 0. At `stallCount >= 3`, escalate in the session log and stop re-dispatching that subtask. (Preserved edge case: *no git progress across a configurable number of wakes → escalate rather than spin forever* — the count is 3, adjustable later in `progress.json` semantics without engine changes.)
- **Card advancement** exclusively via `POST /kanban/move` (`move-card.js` → `LocalApiServer.ts:1344` → `moveCard` callback `TaskViewerProvider.ts:1032-1056`). Never direct SQL, never a bare column write.
- **Research dispatch:** for a well-formed research request the orchestrator runs the research itself in its own terminal session (spawning its own subagent), records the outcome file path in the session log, and answers the requesting agent by writing a reply file next to the processed request.
- **Planner escalation is a hard boundary** — planner-stage questions are never auto-answered (preserved verbatim).
- **Termination:** when every feature is merged or escalated, write the final session-log summary and create `.switchboard/orchestrator/batch-complete`. The engine (not the agent) stops the loop on the next tick — the orchestrator never touches automation state.

### 4. Merge-back (feature by feature) — persona-driven, DB-recorded topology only

Preserved intent from the original plan: *when all of a feature's subtasks are code-reviewed, the orchestrator performs the **agent-driven merge** following the `merge-prompt` pattern: subtask branches → the feature integration branch → main, **resolving conflicts as it goes** (never a bare `git merge` that dead-ends). Do one feature at a time to keep the conflict surface contained. On success, request worktree cleanup via the `worktree_cleanup` skill / `/worktree/cleanup`. On a conflict the agent cannot resolve, leave the worktree intact and **escalate** to the human via the session log.*

Concretized against the shipped kind-aware topology (the `copyWorktreeMergePrompt` handler at `KanbanProvider.ts:9221` resolves exactly this target graph from DB rows; the orchestrator reuses its resolution logic or follows its pattern):

- **Readiness:** a feature is mergeable when *all* its subtask cards sit in `CODE REVIEWED` (cross-checked against git ahead-of-base). Preserved edge case: *don't merge a feature until all its subtasks are reviewed; a half-done feature stays in progress.*
- **Topology from DB rows only.** `getWorktrees()` (`KanbanDatabase.ts:2891` — active rows only) keyed by the feature: subtask rows are `subtask_plan_id && feature_id` (`KanbanProvider.ts:9243`), tier rows are `tier && feature_id` (same branch, `:9243`), and the integration row is `feature_id` with neither, having children (`:9255-9260`). The `copyWorktreeMergePrompt` handler resolves these same rows at `:9244` (integration lookup) and `:9257` (children check). Branches not recorded in these rows are **out of bounds** — the extension and other actors create branches this loop must never touch.
- **Order and commands:** one feature at a time. Each subtask/tier branch merges *in the integration checkout*: `git -C <integrationWt.path> merge <subtaskWt.branch>` (the target the `copyWorktreeMergePrompt` handler computes at `:9246-9247`); then the integration branch merges *in the main checkout*: `git -C <workspaceRoot> merge <integrationWt.branch>` (the handler's integration-→-main path, `:9255-9260`). Always explicit `git -C <path>` — never CWD-relative prose. Default-branch fallback for legacy rows without `base_branch`: the handler's `wtRow.base_branch || await this._resolveDefaultBranch(...)` at `:9235` (`_resolveDefaultBranch` at `:9724`).
- **Conflicts:** resolve in-checkout, commit the merge, continue. If genuinely unresolvable, `git -C <path> merge --abort` to restore a clean checkout, leave all of the feature's worktrees intact, and escalate via the session log (decided above — the interactive merge-prompt's "don't abort" guidance is for attended runs; unattended, a conflict-marked checkout poisons the rest of the batch).
- **Cleanup:** after the feature lands on main, invoke the `worktree_cleanup` skill (`.agents/skills/worktree_cleanup.md`) → `POST /worktree/cleanup` (`LocalApiServer.ts:1397`) → `KanbanProvider.cleanupWorktree` (`:9969`) → `_cleanupWorktree` (`:9984`, kind-aware) → `_removeWorktreeRow` (`:9923`) + `_pruneWorktrees` (`:9944`); for a whole feature, `_cleanupFeatureWorktrees` (`:9960`) iterates the feature's rows and ends in a prune. Never raw `git worktree remove` — worktree rows have no reconciliation and would show "active" forever.

### 5. Termination (engine + persona halves together)

Preserved from the original plan: *when every feature is merged or escalated, the batch is done: write a final session-log summary and stop (or idle) the orchestration loop, mirroring how `PipelineOrchestrator` auto-stops when nothing is pending.* Implemented as: persona writes `batch-complete` (§3); engine detects it at the top of the next tick and stops with an info message (§2 step 2), archiving the marker so a subsequent Start begins clean.

## Verification Plan

### Manual / Behavioral

*(Preserved test intents from the original plan are folded in below.)*

1. **Wake cadence + single-flight.** Orchestration mode, 1-minute interval, a registered terminal named `Orchestrator`. Observe exactly one wake prompt per interval. Without touching `last-wake-complete`, the next tick logs a skip and injects nothing; after touching the marker, the following tick injects. *(Original: overlapping wakes are single-flighted.)*
2. **Force-wake escape.** Leave the marker stale for 3 consecutive ticks → the 4th injects with the "previous wake did not report completion" preamble and resets the counter.
3. **Termination.** Create `.switchboard/orchestrator/batch-complete` → next tick stops the engine with the info message, marker archived with a timestamp suffix. *(Original: loop terminates and reports when all features are merged/escalated.)*
4. **Pause/stop semantics.** Pause mid-countdown → no wakes; unpause → countdown resumes from remaining time (verify the AUTOMATION tab countdown from the broadcast `__ORCHESTRATION__` lastTickAt entry). Stop → timers cleared, counters zeroed. Reset-timers button → immediate wake + fresh interval.
5. **Dead terminal.** Close the Orchestrator terminal → each tick shows the delivery warning and attempts relaunch; after 3 consecutive failures the engine stops with the unreachable message.
6. **Session cap.** Set `globalSessionCap` low (e.g. 3) → engine stops for exhaustion after that many wakes.
7. **Triage rehearsal (agent level).** Seed inbox files of each type (question / warning / research / planner-stage), wake the orchestrator manually: each request is routed correctly (act / research / escalate), items land in `processed/`, the session-log entry lists read/verified/advanced/dispatched/escalated. *(Original: inbox drain routes each request type correctly and marks items processed.)*
8. **Progress verification.** One worktree with committed work ahead of base, one without: only the former's card advances via `/kanban/move`; the latter's `stallCount` increments in `progress.json`, and after 3 stalled wakes it is escalated, not re-dispatched. *(Original: simulated wake with git progress advances the right cards; without progress, nothing advances and a stall eventually escalates.)*
9. **Merge-back.** Two-subtask feature, both in `CODE REVIEWED`, one subtask branch deliberately conflicting with the other: orchestrator merges subtask → integration (resolving the conflict, committing), then integration → main, then requests cleanup — worktree rows flip to `merged`, directories removed, prune run. Unresolvable-conflict variant: merge aborted, checkout clean, worktrees intact, escalation in the session log. *(Original: a clean feature merges subtask → integration → main and triggers cleanup; an unresolvable conflict escalates and leaves the worktree.)*
10. **Reload resilience.** Reload the window mid-run → `_tryRestoreAutoban` re-arms the orchestration timer from persisted state.
11. **Host health.** With a short interval running for ~30 minutes, confirm via dev tools that ticks are one stat + one injection — no refresh storms, no starvation of the API server or terminal registry.

### Automated Tests
*(Deferred per session directive — not run during this review; listed for the implementer.)*

- Engine branch: orchestration mode arms exactly one timer under `ORCHESTRATION_TICK_KEY`, arms no watch subscription and no sweep; `_stopAutobanIfNoValidTicketsRemain` returns `false` in orchestration mode.
- Tick body state machine: skip/force-wake/failed-wake counters across marker-present, marker-stale, marker-missing, and delivery-failure permutations; batch-complete stops and archives.
- Pause math: `pausedRemainingMs` for the orchestration key derives from `orchestrationConfig.intervalMinutes`; unpause resumes the orchestration timer.
- Persistence: `autoban.state` round-trips mode + config (in concert with subtask 1's normalizer tests).

## Out of scope

- The Notion command channel (directive in / status out) — deferred per the feature doc. Wake is driven by the autoban interval, reported via the session log.
- The inbox/session-log mechanics themselves (subtask 3), the persona's full text (subtask 2), grouping/fan-out (subtask 4), and the mode/config/UI foundation (subtask 1).
- Automating the planner stage; any new scheduler.

## Research Findings Applied (2026-07-07)

External-mechanism research (git/VS Code/APFS/merge-automation, run per the review's advisory) came back; these findings are now binding on the implementation:

- **Terminal survival across window reload — resolved (was Uncertain Assumption 3).** Extension-created process terminals survive a reload only under `terminal.integrated.enablePersistentSessions`, and VS Code's pty service SIGHUP-kills background terminals ~60s after a reload with no user interaction. Conclusion: the orchestrator terminal must be treated as **lossable at any reload**, and §2 step 6's relaunch-on-delivery-failure path is *required* behavior, not a fallback nicety. Do not attempt to make the terminal reload-proof.
- **Delivery to a busy CLI agent just buffers — not a hazard.** Text delivered while the CLI agent is mid-task lands in the CLI's own input buffer and is handled as the next message after the current turn; it does not interrupt or corrupt the running task (user-verified against the actual CLIs). The marker-gated single-flight in §2 step 3 is therefore an **efficiency mechanism, not a safety one**: it exists to avoid queueing redundant "check status" wakes, each of which would burn a full orchestrator turn re-triaging stale state. The research's raw-`sendText` multiline/truncation hazard also does not apply: the extension never delivers prompts via raw `sendText` — the dispatch path this plan reuses (`_attemptDirectTerminalPush`) delivers via `sendRobustText` (`terminalUtils.ts:118`; clipboard-paste for payloads >100 chars, chunked send with CLI newline-flattening as fallback, settle + Enter). The wake prompt goes through the same existing path — do not invent a new delivery mechanism or add prompt-format constraints.
- **mtime gating on APFS.** APFS stores nanosecond timestamps but Node's `fs.utimes`/`touch` paths truncate to ms — irrelevant at a minutes-scale wake cadence, but for robustness the persona should also **write an ISO timestamp as the marker file's content**; the engine may fall back to content comparison if mtime ever looks suspect.
- **Abort-eject-escalate is the industry standard.** GitHub merge queues, Renovate, Bors-NG, and Gerrit all abort on unresolvable conflicts rather than leaving a conflicted checkout. This plan's decided policy (unattended merges run `git merge --abort` on unresolvable conflicts, then escalate — never leave `MERGE_HEAD`/conflict markers in the shared integration checkout) is confirmed as the correct divergence from the attended merge-prompt guidance.

## Uncertain Assumptions

*(The user was advised to run research/verification on these before implementation. Original item 3 — terminal delivery after window reload — was resolved by that research; see Research Findings Applied above.)*

1. **Cleanup path landing order.** `POST /worktree/cleanup`, public `KanbanProvider.cleanupWorktree`, and the `worktree_cleanup` skill exist only as the (reviewed, un-implemented) `merge-prompt-button-agent-driven-worktree-merge.md` plan — verified absent from `LocalApiServer.ts` and `.agents/skills/` today, with the mechanical merge still shipped at `KanbanProvider.ts:9265`. This plan assumes they land first; if not, its implementer must carry that subset.
2. **Final `OrchestrationConfig` shape.** Subtask 1 is in flight; `{ enabled, intervalMinutes }` and the `startOrchestrator` launch hook are assumed per its plan. Field renames there ripple into §2's config reads and the pause-math branch.
3. **Kickoff arms the engine.** Assumed: subtask 4's Start flow leaves `enabled: true` in orchestration mode so `_startAutobanEngine`'s new branch arms the wake timer at kickoff end; if kickoff instead defers arming, this plan's engine branch is where it must be triggered from.

---

**Recommendation:** Complexity 7 → **Send to Lead Coder.** The engine diff is contained, but the single-flight-across-agent-work state machine, the inverted auto-stop semantics, the three rules-assuming plumbing sites, and the cross-subtask marker contract all fail silently if fumbled — this needs a coder who reads the existing engine before touching it.

**Stage Complete:** PLAN REVIEWED

## Review Findings

Reviewed against commit `fcd9846`. Files changed by this review: `src/services/TaskViewerProvider.ts` (`_enqueueOrchestrationWake`, `_startAutobanEngine`, `startOrchestratorFromKanban`, `_stopAutobanEngine`, new `_orchestrationWakeSentAt` field). **CRITICAL (fixed):** the wake tick ignored `_dispatchExecuteMessage`'s boolean return — it returns `false` (does not throw) on a dead terminal, so the failure/relaunch/stop path was dead code and a lost terminal left the loop silently "waking" forever with the UI showing running; now the return is captured and the failure counter/auto-stop fire correctly. **MAJOR (fixed):** the single-flight gate compared the marker's mtime to `interval*0.9`, which wrongly skips a healthy wake whenever the orchestrator's work exceeds ~10% of the interval (halving effective cadence) — replaced with the plan's `_orchestrationWakeSentAt` reference (skip only while the last-sent wake is uncompleted) plus a force-wake escape at the skip threshold instead of stopping the engine. **MAJOR (fixed):** `_startAutobanEngine` fired an immediate wake, landing a Wake-Protocol prompt on top of the just-injected kickoff prompt (plan says no immediate wake) — removed, with a `lastTickAt` baseline seeded for the countdown. **MAJOR (fixed):** a completed batch's `batch-complete` marker persisted and would stop every future batch on its first wake — now archived on detection and cleared at kickoff. Validation: static/caller-trace only (compile+tests skipped). Remaining risks (deferred, MINOR): no automatic terminal relaunch on delivery failure (wiring `startOrchestrator` as relaunch would re-run kickoff; the engine instead stops cleanly after 3 failures with a message), and the pause/reset plumbing for the `__ORCHESTRATION__` timer key is absent — acceptable because the pause/reset toolbar buttons are hidden in orchestration mode, so those paths are UI-unreachable.

**Second pass (2026-07-08, commit `ed01f0b`):** Re-verified all engine-side fixes from the first pass are intact. `_enqueueOrchestrationWake` (`:9139`) correctly captures `_dispatchExecuteMessage`'s return, uses `_orchestrationWakeSentAt` for single-flight (not mtime-vs-interval), force-wakes after `ORCHESTRATION_MAX_SKIPPED_WAKES`, and stops with a warning message after `ORCHESTRATION_MAX_FAILED_WAKES`. `_startAutobanEngine` (`:9248`) does NOT fire an immediate wake — seeds `lastTickAt` only. `startOrchestratorFromKanban` (`:7722`) clears stale `batch-complete`/`last-wake-complete` markers. `_stopAutobanEngine` (`:9335`) zeroes `_orchestrationWakeSentAt`. The pause/reset plumbing gap (`setAutobanPausedFromKanban` `:8217`, `resetAutobanTimersFromKanban` `:8179`) remains — confirmed UI-unreachable (toolbar button hidden at `kanban.html:5425`). No code changes needed in this subtask. Validation: static caller/consumer trace only (compile+tests skipped per directive).
