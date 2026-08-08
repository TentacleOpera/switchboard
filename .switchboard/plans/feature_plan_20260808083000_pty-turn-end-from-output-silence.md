# Turn-End From PTY Output Silence: One Completion Signal That Works For Every Agent CLI

## Goal

Derive turn-end for a dispatched PTY seat from **output silence on the pty stream Switchboard already reads**, and use it to (a) clear the activity light on a real turn boundary rather than only on plan-file-watch latency or the blind 10-minute timer, and (b) drive the **blocked / waiting on you** card state that V59's `blocked_at` column exists for and currently has no writer.

The mechanism requires nothing from the agent: no hook registration, no config injection, no `--settings` rewrite, no HTTP callback, no token. It therefore behaves **identically for every CLI** — Claude Code, Codex, Gemini CLI, Aider, a wrapper script, a custom role.

### Problem

Three problems, one root.

**1. Completion is inferred from a side effect, and the inference is lossy.** The only completion signal is the plan file's mtime advancing (`PlanIngestionEngine.ts:931`), with a blind 10-minute timeout as backstop (`timeoutMs`, default 600000). An agent that finishes a turn without writing to the plan file produces no signal at all; the card stays lit until the timer expires. The predecessor mechanism — a `**Stage Complete: <COLUMN>**` marker the agent appended — was retired and is vestigial. Nothing replaced the agent's ability to signal that it was done.

**2. The board cannot represent "blocked", which is the state a fleet operator actually needs.** `working` is a single boolean derived from `dispatched_at` and its age (`isWorkingState`, `bootstrap.ts:167`, duplicated at `KanbanProvider.ts:163`). An agent grinding through a build and an agent that stopped 8 minutes ago to ask "Do you want me to proceed?" render identically. For an operator running many seats, "which seat is blocked on me" is the only question that determines what to do next. V59 added `blocked_at`, `setBlockedState` and the board's dashed-amber ring for exactly this — and **none of them have a writer.** The capability is scaffolded and inert.

**3. The previous attempt only worked for one CLI.** A sibling subtask (`feature_plan_20260807103100_agent-emitted-completion-via-cli-hooks.md`) built this capability on Claude Code lifecycle hooks. That implementation was **removed on 2026-08-08** because hooks are a Claude-Code-only mechanism: the board lit correctly for one CLI and silently fell back to the 10-minute timer for every other agent. See that file for the full record of what was built and removed. This plan replaces it with a mechanism that has no per-CLI dependency.

### Root cause

The fleet already receives every byte the agent prints — `PtyFleetService.create` subscribes `handle.onData(() => { handle.lastDataAt = Date.now(); })` (`ptyFleetService.ts:194`) on every terminal, unconditionally, before the startup command is even typed. The liveness subtask then bridges that into the sweep via `_terminalLivenessProvider` (`PlanIngestionEngine.ts:159`) and persists it as `last_liveness_at`.

That loop already classifies each dispatched terminal three ways, and **the third branch is empty**:

```
if (entry.status === 'exited')                        → force-clear      (implemented)
else if (nowMs - entry.lastDataAt < livenessWindowMs) → stamp heartbeat  (implemented)
// Active but silent longer than livenessWindowMs → no evidence;
// falls through to the blind timer (do nothing here).   ← THIS PLAN
```
— `PlanIngestionEngine.ts:291-305`

Sustained silence on a seat holding a live dispatched card is not "no evidence". It is the strongest CLI-agnostic evidence of a turn boundary available, and it is already computed and thrown away once per sweep tick. The root cause is that the classification stops one branch short.

### Second root cause (found in the 2026-08-08 improve pass) — the blocked state has a maximum lifespan of `timeoutMs`

Filling the empty branch is necessary but **not sufficient**, because the blocked state a writer would produce cannot survive long enough to be seen. The derive is:

```ts
const working = withinHardCap && (now - basis) < timeoutMs;
const blocked = working && !!blockedAt;
```
— `KanbanProvider.ts:180-183` (and the byte-identical copy at `bootstrap.ts:180-183`)

`basis` is `MAX(dispatched_at, last_liveness_at)`. A blocked seat is by definition producing no output, so it is never in `liveNames`, so `recordLiveness` never re-stamps it, so **its basis freezes at the last byte it emitted**. Timeline with the shipped defaults:

| t | event |
|---|---|
| t₀ | agent prints its question, goes quiet — `basis` freezes here |
| t₀ + 90s | silence branch fires, `blocked_at` stamped, dashed-amber ring appears |
| t₀ + 10min | `now - basis >= timeoutMs` ⇒ `working = false` ⇒ **`blocked = false`**; ring and badge vanish |
| t₀ + 10min | the same tick's `clearStaleWorkingState` nulls `dispatched_at` **and `blocked_at`** (`KanbanDatabase.ts:9852-9858`) |

Net: the "Waiting on you" badge is visible for **~8.5 minutes**, and then the card renders identically to a completed one. The scenario the capability exists for — operator away from the desk, comes back, asks "which seat needs me" — is precisely the scenario in which the answer has already been erased, and erased *into the wrong state*. A green "the badge appeared" test passes while the goal is unmet.

The same age gate is baked into the feature rollup's `anyBlocked` term (`KanbanDatabase.ts:6262-6265`), so a feature's blocked light dies on the same clock.

**Blocked is a wait on a human, and human latency is unbounded.** It cannot share a clock with "is the agent still working", which is a wait on a machine. This plan therefore gives blocked its own retention (see Proposed Change 3). Without that change the feature ships a badge that self-destructs, which is worse than no badge: it teaches the operator that the board forgets.

### Why silence rather than hooks or a screen emulator

- **Hooks** are deterministic and instant, but exist only on Claude Code. Building on them lights the board for one CLI and leaves every other agent on the timeout path — inconsistent behaviour depending on which agent was dispatched. Already tried and removed.
- **A headless VT emulator** (`feature_plan_20260807103200_pty-screen-state-idle-detection-headless-vt.md`) is the escalation for CLIs that repaint while idle, where raw silence carries no signal. That plan is **closed unbuilt**, and its own `## Recommendation` names this plan as the correct deliverable: *"a raw-byte silence timer over the `onData` handler subtask 1 already establishes: a few dozen lines, no new dependency, no masking profile, no version coupling."* This plan is that.
- **Raw byte silence** needs no per-CLI knowledge, so it cannot go stale against a third party's UI redesign — the failure mode that makes the emulator's masking rules a liability.

## Metadata

- **Complexity:** 6

> **Superseded:** **Complexity:** 5
> **Reason:** The improve pass found that the blocked state is unusable without a retention change spanning four additional sites (`isWorkingState` in two files, the feature-rollup SQL, and `clearStaleWorkingState`), plus a second setting. The change is still small per-site and reuses existing patterns, but it is no longer "one branch, one setting" — it is a cross-file derive change with a byte-compat obligation on ~4,000 shipped installs.
> **Replaced with:** **Complexity:** 6 (mixed — majority routine, with one moderate multi-file derive change).

- **Tags:** backend, database, reliability, feature

> **Superseded:** **Tags:** backend, terminals, kanban, database, reliability
> **Reason:** `terminals` and `kanban` are not in the allowed tag vocabulary; invented tags are dropped or mis-filed on import.
> **Replaced with:** **Tags:** backend, database, reliability, feature

## User Review Required

None.

## Complexity Audit

### Routine

- Filling in one existing `else` branch in a loop that already has the liveness array, the DB handle and the workspace id in scope.
- Two new `package.json` settings.
- Reusing `getActiveDispatchedByTerminal`, `setBlockedState`, `recordLiveness` and `clearWorkingState`, all of which already exist and are already reviewed.
- Threading one optional parameter through five `isWorkingState` call sites and four `getFeatureWorkingStates` call sites — mechanical, and default-valued so unconverted call sites stay correct.

### Complex / Risky

- **The mid-turn quiet stretch is the one real false-positive path, and it must be threshold-managed.** An agent waiting on a slow API call or a long compile can emit nothing for tens of seconds while genuinely working. A threshold under that produces false turn-ends on exactly the long turns the feature exists to serve. `livenessWindowMs` is already 90s by default, comfortably above the ~60s quiet stretch the emulator plan's Verification step 3 names as the hazard. The new threshold must therefore default to **90s with a floor of 30s** — a user must not be able to tune it into false-positive territory.
- **Do NOT reuse `livenessWindowMs` as the turn-end threshold.** It is tempting — the empty branch is literally keyed on it — but the two numbers answer different questions. `livenessWindowMs` is "how recently must we have heard from it to *spare* its card past the timeout" (min 10000 in `package.json:568`). Turn-end is "how long must it be silent before we declare the turn *over*". Wiring one number to both means a user lowering the spare-window to 10s silently arms a 10s false-completion trigger. One number carrying two decisions is precisely how a heuristic degrades invisibly.
- **The two thresholds are on one `if/else-if` chain, so the effective turn-end threshold is `max(livenessWindowMs, turnEndSilenceMs)`.** Because the silence case is the `else` of `nowMs - lastDataAt < livenessWindowMs`, a seat inside the liveness window can never reach it. With `livenessWindowMs = 600000` and `turnEndSilenceMs = 30000`, turn-end effectively fires at 600s, not 30s. This is the *safe* direction (conservative, never a false completion) and it also prevents the genuinely broken configuration where a seat is simultaneously heartbeat-stamped and declared finished on the same tick. Both setting descriptions must state the interaction, because a knob that silently does nothing is its own defect class.
- **Silence cannot distinguish "finished" from "asked a question" — both are silent.** This is the honest capability gap versus an emitted event. The discriminator here is plan-file evidence: silence **with** a plan-file mtime advance during the turn ⇒ completion; silence **without** one ⇒ ambiguous ⇒ blocked. That is conservative in the right direction (an unresolved seat surfaces as needing attention rather than being cleared), but it is a heuristic with a named failure: an agent that edits the plan file *and then* asks a clarifying question reads as completed. Accept and document; do not claim parity with an emitted event.
- **Use plan-file mtime, not `updated_at`.** `updated_at` only advances when the plan watcher re-ingests, which happens *after* this sweep observes silence — so keying on it can never detect a genuine completion. This exact defect was found and fixed during the hook implementation's review; carry the lesson forward. `fs.stat` on the plan file is a read-only syscall with no watcher race.
- **The mtime discriminator must resolve the WORKTREE copy for worktree dispatches.** `plans.plan_file` is stored workspace-relative, and `agentPromptBuilder.ts:72` re-resolves plan paths *inside* the worktree for worktree seats — so a worktree agent's completion write lands on a path the main-repo `stat` never sees. Statting `path.join(folder, plan_file)` for a worktree row reports a stale mtime and misclassifies **every worktree completion as blocked**. Resolve the worktree path from `worktrees.path` via the row's `worktree_id` and stat there.
- **`setBlockedState` must be idempotent per turn, not re-stamped per tick.** The silence branch re-fires every 10s tick for as long as the seat stays quiet. `setBlockedState` routes through `_persistedUpdate`, i.e. a full sql.js database persist — a write of the whole DB image per silent seat per tick. Beyond the cost, re-stamping `blocked_at = now` on every tick makes any retention measured from `blocked_at` never expire. Stamp only when the already-read record has `blockedAt == null`.
- **A false positive must be self-correcting, not sticky.** When bytes resume on a seat previously marked blocked-by-silence, `blocked_at` must be nulled on the same tick that stamps the heartbeat. Without this, one quiet stretch pins a card to "Waiting on you" for the rest of the turn and the operator learns to distrust the badge. This is what makes a threshold miss transient rather than wrong.
- **The blocked state needs its own clock, and that is a cross-file derive change on shipped code.** See "Second root cause" above. Four sites (`isWorkingState` ×2, `getFeatureWorkingStates` SQL, `clearStaleWorkingState`) plus their call sites. The byte-compat obligation is explicit: with `blocked_at` NULL — every pre-V59 row, every fleet-less host, every card that never blocked — the new terms must reduce to today's expressions exactly.
- **The double-broadcast gate is load-bearing and already built.** `clearWorkingState` returns TRUE only on a real non-NULL→NULL transition via `getRowsModified()` (`KanbanDatabase.ts:9700-9714`). This plan adds the second concurrent clearer that gate was built for. Fire the completion broadcast **only** on `transitioned === true`; the plan watcher's `setOnWorkingStateCleared` gates the same way.

## Edge-Case & Dependency Audit

### Race conditions

- **Sweep tick vs plan-file write.** An agent that writes the plan file and exits within one tick can be observed silent *before* the watcher ingests the write. mtime is read directly by `stat`, so the evidence is present even when the DB row is stale — this is the whole reason for choosing mtime over `updated_at`.
- **The watcher normally wins the completion race, and that is fine — but it means the silence branch's completion arm is a BACKSTOP, not the primary path.** When the agent writes the plan file, the change watcher clears `dispatched_at` within its debounce, long before `turnEndSilenceMs` elapses. `getActiveDispatchedByTerminal` requires `dispatched_at IS NOT NULL`, so by the time the silence branch looks, there is no live row and it correctly skips. The completion arm therefore only ever fires when the watcher *missed* the write — worktree copies outside a watched root, a disabled watcher, a debounce drop. This has a direct consequence for Verification (step 3 must isolate the branch, or it will be passed by the pre-existing mechanism and prove nothing).
- **Two clearers, one turn.** The plan watcher's mtime-driven clear and this silence-driven clear can land on the same turn. Both go through `clearWorkingState`; exactly one wins the UPDATE and only that caller broadcasts. Already enforced; do not add a parallel clear path.
- **Heartbeat pass precedes the silence pass within a tick, and the two sets are disjoint.** `recordLiveness` for `liveNames` runs before the sweep (`PlanIngestionEngine.ts:318-326`); `liveNames` and `silentTerminals` come from mutually exclusive branches of one `if/else-if`, so no seat is both stamped and turn-ended on the same tick.
- **Re-dispatch during a blocked state.** A re-dispatch calls `clearWorkingState`, which nulls `blocked_at` alongside `dispatched_at` (`KanbanDatabase.ts:9707-9711`), so a new turn never inherits the previous turn's blocked stamp.

### Security

- No new surface. No route, no token, no user input, no agent-writable file. This is a deliberate contrast with the removed hook design, which added an authenticated POST endpoint, an HMAC minter in the fleet, a per-terminal token in the pty environment, a secret in the ptyHost child's argv (readable via `ps`), and a generated settings file inside the user's workspace. None of that returns.

### Side effects

- **Cost is one `stat` per silent dispatched seat per tick** — not per output flush. The `onData` subscription is already assignment-only (`ptyFleetService.ts:194`) and unchanged by this plan. No parser, no accumulator, no new timer: the work rides the sweep interval that already runs.
- **DB writes stay bounded.** One `setBlockedState` persist per blocked *turn* (not per tick, per the idempotence gate above); the self-correction rides the `recordLiveness` UPDATE that already runs each tick. sql.js persists the whole image on every write, and heap exhaustion under write churn is a known failure mode in this codebase — the gating is not an optimisation, it is a constraint.
- **Native `vscode.Terminal` seats produce no PTY stream**, so they get no signal and degrade to the blind timeout — today's behaviour. Only fleet seats are in scope. State this at the setting.
- **A CLI that repaints while idle never goes silent**, so it never signals and degrades to the blind timeout. Safe, but per-CLI unknown and unmeasured. This is precisely the case the emulator plan exists for.
- **Longer-lived blocked cards change what the board shows at rest.** Once blocked carries its own retention, a card can stay lit for hours. That is the intent, but it changes the resting appearance of the board for existing users and must be bounded by an explicit setting rather than being unbounded.

### Dependencies & conflicts

- **Exited terminals are already handled and must not be double-handled.** `status === 'exited'` force-clears in the existing first branch. A dead terminal is maximally silent, so the new branch must be reached only for `status === 'active'` seats or every dead terminal produces a spurious blocked stamp on its way out. **Branch ordering is the entire veto** — see the Superseded callout in Proposed Change 1 for why no separate tombstone check is possible or needed.
- **Operator kill leaves no handle to read `status` from,** and the `recentlyClosed` tombstone (`ptyFleetService.ts:82`, recorded at `:114`) is what covers it — but it is already folded into `getLiveness()` as `status: 'exited'` (`ptyFleetService.ts:267-274`), so the engine consumes it through the existing first branch. Hard dependency on the tombstone existing; **not** a second condition to write.
- **Terminal rename.** `rename` rekeys the fleet map and updates `friendlyName`; attribution is by `dispatched_terminal`, so a seat renamed mid-turn stops resolving by name and its card waits for the blind timer. Acceptable; do not add a second attribution path for it.
- **Multi-root: the liveness snapshot is process-global, the DB lookup is per folder.** The sweep runs every silent terminal name against every watched folder's DB, so two workspaces that both dispatched to the same fleet seat (sequentially, the first not yet cleared) can both see a state change. `recordLiveness` already has this exact shape, so the aliasing is pre-existing rather than introduced — but for a clear/block decision the consequence is a wrong card rather than a spare heartbeat. Accept, and keep `ORDER BY dispatched_at DESC LIMIT 1` so at most the most-recent row per workspace is touched.
- **Blocking:** `feature_plan_20260807103000_pty-liveness-heartbeat-gates-activity-light-sweep.md` — owns the `onData` heartbeat, `_terminalLivenessProvider`, the `recentlyClosed` tombstone and the widened `MAX(dispatched_at, last_liveness_at)` derive. Landed and code-reviewed.
- **Consumes** V58 `last_liveness_at` and V59 `blocked_at`. **Adds no migration.**

## Dependencies

- **Blocking:** `pty-liveness-heartbeat-gates-activity-light-sweep` (landed).
- **Replaces:** `agent-emitted-completion-via-cli-hooks` (built, then removed as CLI-specific).
- **Related:** `pty-screen-state-idle-detection-headless-vt` — closed unbuilt; remains the escalation for CLIs measured to repaint at idle.
- Adds no migration. V59's `blocked_at` gains its first writer here.

## Resolved Assumptions

- **Whether bytes actually stop at an idle prompt. RESOLVED for Claude Code.** Idle re-rendering existed in mid-2025 builds and was removed in v2.1.170+ to cut idle CPU; bytes do stop at an idle prompt on current versions. Established by the Aug 2026 research pass recorded in the emulator plan's `## Resolved Assumptions` — **authoritative, do not re-research.** This is what makes a silence timer viable at all.
- **Raw-byte silence is unpredictable per CLI, not universally useless.** Also from that pass. Whether a given TUI repaints at idle is a per-CLI, per-version property the host cannot know in advance — an argument for a conservative threshold and graceful degradation, not for an emulator.
- **The seam exists and is empty.** Verified in code: `PlanIngestionEngine.ts:291-305` classifies exited / recently-active / silent and does nothing in the third case. `getActiveDispatchedByTerminal`, `setBlockedState` and the `clearWorkingState` transition boolean all exist and are reviewed.
- **The blocked UI exists and is wired to `card.blocked`.** Verified: dashed-amber `::after` overlay and the "Waiting on you" `.blocked-badge` at `src/webview/kanban.html:1043-1095`, applied at `:6879`. Only the writer and the retention are missing.
- **The liveness seam carries `{ friendlyName, lastDataAt, status }` and nothing else** (`ptyFleetService.ts:48-52`, `PlanIngestionEngine.ts:161`, `TaskViewerProvider.ts:627`). No `cwd`, no tombstone map. This is why the cwd fallback is dropped rather than wired — see Proposed Change 1.
- **Coding dispatches are contracted to write the plan file at completion** (`CODING_COMPLETION_REPORT_DIRECTIVE`, `agentPromptBuilder.ts:812`; reviewer equivalent at `:1332`). The mtime discriminator is therefore consistent with the prompt contract for every role, not only planners — it is not being asked to detect something agents were never told to do.

Residual and deliberately **not** a research question — it is a measurement, and it belongs in Verification step 2: **what is the longest genuine mid-turn silence across the CLIs actually in use?** The 90s default is inherited from a neighbouring knob, not measured. If any CLI routinely exceeds it, raise the default rather than accepting false completions.

## Adversarial Synthesis

Key risks: (1) **the blocked state's clock** — as shipped, `blocked` is gated on `working`, whose basis freezes when the seat goes quiet, so the badge lives ~8.5 minutes and then collapses into the *completed* rendering; the capability's headline value evaporates exactly when the operator is away, which is when it is needed; (2) the threshold is the rest of the design — too low and long turns false-complete, too high and the feature adds little over the blind timer, and the right value is a per-CLI empirical property nobody has measured; (3) silence genuinely cannot separate "done" from "waiting", so the blocked decision rests on plan-file evidence that a worktree dispatch would have made structurally invisible had the mtime path not been made worktree-aware.

Mitigations: a dedicated `blockedTimeoutMs` retention so blocked outlives the working window and is bounded by an explicit knob rather than a borrowed one; a separate turn-end knob with a 30s floor so the dangerous range is unreachable; worktree-aware mtime resolution so completions in worktrees are not systematically misread as blocked; an idempotence gate on the blocked stamp so a silent seat is one DB write per turn rather than one per tick; and `blocked_at` nulled the moment bytes resume, so a threshold miss is transient rather than sticky.

The honest case against this plan is that it is a heuristic replacing a deterministic signal that was already built and working for the most common CLI. That is true, and it is the accepted trade: a signal that behaves the same for every agent is worth more to a fleet operator than a better signal for one agent and nothing for the rest. Inconsistent state is harder to trust than uniformly approximate state.

The case for it is that it is small (one branch, two settings, one derive term, no dependency, no new surface), it cannot go stale against a third party's UI or hook contract, it keeps an authenticated endpoint and token-minting chain out of the attack surface, and it gives V59's scaffolded blocked state its first CLI-agnostic writer — and, with Proposed Change 3, its first *usable* lifetime.

## Proposed Changes

### 1. `src/services/PlanIngestionEngine.ts` — fill in the empty third branch

- Read `turnEndSilenceMs` and `blockedTimeoutMs` from the `activityLight` config alongside the existing `timeoutMs` and `livenessWindowMs` reads (`:259-267`).
- In the classification loop (`:291-305`), add the third case as the terminal `else`: `nowMs - entry.lastDataAt >= turnEndSilenceMs` → collect `entry.friendlyName` into `silentTerminals`.
- Keep the existing `exited` branch **first**. Ordering is the whole safety property:

  > **Superseded:** add the third case: `status === 'active'` **and** `nowMs - entry.lastDataAt >= turnEndSilenceMs` **and** not present in the `recentlyClosed` tombstone → collect into `silentTerminals`.
  > **Reason:** The engine cannot see `recentlyClosed` — it is private to `PtyFleetService` and the liveness seam carries only `{friendlyName, lastDataAt, status}` (`ptyFleetService.ts:48-52`). The check is also redundant: `getLiveness()` already emits every tombstone as `status: 'exited'` (`:267-274`), so the existing first branch consumes it. Writing the condition as specified would require widening the seam to publish a tombstone map, for no behavioural gain.
  > **Replaced with:** the silence case is the terminal `else` of the existing chain, so `status === 'exited'` (live handles *and* tombstones) is consumed by branch 1 and structurally cannot reach it. No explicit `status` test, no tombstone test. A reviewer must check *branch order*, not a condition list.

- In the existing per-folder loop, for each silent terminal: resolve the plan via `getActiveDispatchedByTerminal(wsId, name)`. No live dispatched row ⇒ skip (a manual chat in an undispatched seat must never clear an unrelated card).

  > **Superseded:** falling back to `getActiveDispatchedByCwd(wsId, cwd)` only when the name resolves nothing.
  > **Reason:** Two independent blockers. (a) The sweep has no `cwd` for a silent seat — `FleetLivenessEntry` does not carry one, so this would require widening `ptyFleetService.getLiveness()`, `FleetLivenessEntry`, the `_terminalLivenessProvider` type and the `TaskViewerProvider._ptyLiveness` map — directly contradicting this plan's own Change 4 ("no changes to `ptyFleetService.ts`"). (b) Even wired, it would match nothing: `getActiveDispatchedByCwd` is restricted to rows with an **empty** `dispatched_terminal` (`KanbanDatabase.ts:9801`), and a fleet dispatch always knows the seat name it is dispatching to, so those rows do not exist on this path.
  > **Replaced with:** name-only attribution via `getActiveDispatchedByTerminal`. A genuinely unattributed dispatch (empty `dispatched_terminal`) degrades to the blind timeout — the same posture the plan already takes for renamed seats and native terminals. `getActiveDispatchedByCwd` stays uncalled; do not delete it (it is the attribution seam for any future signal that identifies itself by directory).

- Decide with plan-file mtime, not `updated_at`. Resolve the path the agent actually wrote:

  > **Superseded:** `fs.stat(planFile).mtimeMs > Date.parse(dispatchedAt)`
  > **Reason:** Two defects. `plans.plan_file` is stored workspace-**relative** (`_ensureRelativePlanFile`), so a bare `stat` resolves against the process cwd and throws `ENOENT`. And for a worktree dispatch the agent writes the *worktree's* copy (`agentPromptBuilder.ts:72` re-resolves plan paths inside the worktree), so statting the main-repo path reports a stale mtime and misclassifies **every worktree completion as blocked** — silently converting the feature's happy path into its ambiguous path for the exact dispatch mode the fleet uses most.
  > **Replaced with:** resolve a root first — the row's worktree path when `worktreeId` is set (`SELECT path FROM worktrees WHERE id = ?`), else the watched `folder` — then `await fs.promises.stat(path.join(root, record.planFile))` and compare `mtimeMs > Date.parse(record.dispatchedAt)`. A `stat` rejection (missing file, permissions) is caught and treated as *no advance* ⇒ blocked, the conservative outcome.

  mtime advanced ⇒ completion → `clearWorkingState(planFile, wsId)`, and fire `_onWorkingStateCleared` **only** when it returns `true`. Otherwise ⇒ blocked.
- Stamp blocked idempotently:

  > **Superseded:** Otherwise ⇒ `setBlockedState(planFile, wsId, nowIso)`.
  > **Reason:** The silence branch re-fires every tick for as long as the seat stays quiet, and `setBlockedState` routes through `_persistedUpdate` — a full sql.js image write per silent seat per 10s tick, against a heap that is known to exhaust under write churn in this codebase. It also defeats Change 3: a `blocked_at` re-stamped every tick never ages out of any retention window measured from it.
  > **Replaced with:** `if (!record.blockedAt) { await db.setBlockedState(record.planFile, wsId, nowIso); }` — the record is already in hand from the attribution read, so the gate costs nothing and makes the write once-per-turn. Log the transition once, not per tick.

- Self-correct on resumed output:

  > **Superseded:** Extend the recently-active branch to null a stale blocked stamp: when a seat in `liveNames` has non-NULL `blocked_at`, clear it on the same tick.
  > **Reason:** Correct intent, but "when a seat in `liveNames` has non-NULL `blocked_at`" requires a per-live-seat DB read the sweep does not currently do, and a per-seat `setBlockedState(null)` persist on top of it — re-introducing exactly the per-tick write cost the gate above removes.
  > **Replaced with:** fold it into the `recordLiveness` UPDATE that already runs for `liveNames` each tick — `SET last_liveness_at = ?, blocked_at = NULL` (`KanbanDatabase.ts:9900-9903`). Same rows, same statement, same single persist, zero extra reads: bytes resumed ⇒ not blocked. Update that method's doc comment, which currently promises it owns only `last_liveness_at`.

- Wrap the whole addition in the same defensive posture the liveness read already uses (`:280-286`) — this runs inside an async interval callback, and an escaping rejection is fatal to the standalone process.

### 2. `package.json` — two settings

- `switchboard.activityLight.turnEndSilenceMs`, `"default": 90000`, `"minimum": 30000`, `"maximum": 600000`, `"scope": "resource"`, beside the existing two (`:557`, `:565`).
  Description must state: applies to PTY-fleet seats only (native `vscode.Terminal` seats degrade to the blind timeout); silence with a plan-file change reads as completion, silence without one reads as blocked; the 30s floor exists because lower values false-complete long turns waiting on slow tool calls; and **the effective threshold is `max(livenessWindowMs, turnEndSilenceMs)`**, because a seat inside the liveness window is spared before this test is reached.
- `switchboard.activityLight.blockedTimeoutMs`, `"default": 14400000` (4 hours), `"minimum": 600000` (10 min), `"maximum": 86400000` (24 h), `"scope": "resource"`.
  Description must state: how long a card stays visibly "Waiting on you" after the agent goes quiet without a plan-file change; deliberately much longer than `timeoutMs` because this is a wait on a **human**, not on a machine; the card clears earlier if output resumes, the terminal exits, or the card is re-dispatched.

### 3. Blocked gets its own clock — `KanbanProvider.ts`, `bootstrap.ts`, `KanbanDatabase.ts`

> **Superseded:** ### 3. No changes to `ptyFleetService.ts`, `LocalApiServer.ts` or the DB schema … This plan adds no route, no migration, no env var, no generated file, and does not modify the startup command.
> **Reason:** Still true for those three files, but incomplete as a change list: the plan as written produced a blocked badge with an ~8.5-minute lifespan that then collapsed into the *completed* rendering (see "Second root cause"). Shipping the writer without the retention satisfies every stated verification step while failing the stated goal (b). The retention lives in the derive and the sweep, so those files are in scope.
> **Replaced with:** this change (retention), plus Change 4 below, which keeps the original "what this plan does NOT touch" statement intact for the files it genuinely does not touch.

- **`src/services/KanbanProvider.ts:163` and `src/standalone/bootstrap.ts:167` — `isWorkingState`.** These are two byte-identical copies; **both must change together** or the extension board and the standalone board disagree. Add an optional 5th parameter `blockedTimeoutMs: number = 4 * 60 * 60 * 1000` and replace lines `180-183`:

  ```ts
  // Blocked is a wait on a HUMAN — it gets its own retention, measured from
  // blocked_at, not from the output-derived working basis (which freezes the
  // moment the agent goes quiet, i.e. exactly when blocked is stamped).
  const blockedTs = blockedAt ? Date.parse(blockedAt) : NaN;
  const blocked = Number.isFinite(blockedTs) && (now - (blockedTs as number)) < blockedTimeoutMs;
  const working = blocked || (withinHardCap && (now - basis) < timeoutMs);
  return { working, blocked };
  ```
  `working` must stay true while blocked, because the card has to render at all for the overlay to be visible — and because an unanswered question genuinely is an unfinished turn.
  **Byte-compat check (mandatory):** with `blockedAt` null/undefined — every pre-V59 row, every fleet-less host, every card that never blocked — `blockedTs` is `NaN`, `blocked` is `false`, and `working` reduces to `withinHardCap && (now - basis) < timeoutMs`, identical to today. The ~4,000 shipped installs see no change until a writer stamps `blocked_at`.
- **Call sites** — pass the configured value at `KanbanProvider.ts:1871`, `:3505`, `:3720`, `:7443` and `bootstrap.ts:214`. The default keeps any missed site correct rather than crashing, but a missed site renders a stale lifetime; enumerate with `grep -n "isWorkingState(" src/`.
- **`src/services/KanbanDatabase.ts:6262-6265` — `getFeatureWorkingStates`.** The `anyBlocked` term carries the same age gate, so a feature's blocked light dies on the old clock while its children stay lit — the exact parent/child disagreement the V58 comment at `:6252` was written to prevent. Add an optional `blockedTimeoutMs` parameter, compute a `blockedCutoff`, and make `anyBlocked` read `blocked_at IS NOT NULL AND dispatched_at IS NOT NULL AND blocked_at >= ?`, dropping the working-basis and hard-cap terms from that column only. `anyWorking` must also admit blocked rows, matching `isWorkingState`. Update the four call sites (`KanbanProvider.ts:1864`, `:3496`, `:3707`, `bootstrap.ts:207`); the optional parameter keeps the existing signature callable.
- **`src/services/KanbanDatabase.ts:9852-9858` — `clearStaleWorkingState`.** Today the age branch and the hard-cap branch both null `blocked_at`, so the sweep erases the state at `timeoutMs` regardless of what the derive says. Restrict both existing conditions to `blocked_at IS NULL`, and add a third condition that clears blocked rows on their own clock:

  ```
  WHERE workspace_id = ? AND dispatched_at IS NOT NULL AND (
        (blocked_at IS NULL AND (MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) < ?
                                 OR dispatched_at < ?))
     OR (blocked_at IS NOT NULL AND blocked_at < ?)
  )
  ```
  Leave the `forceTerminals` UPDATE **unconditional** — a dead seat clears a blocked card immediately, and that is the backstop that keeps a blocked light falsifiable. With `blocked_at` NULL everywhere the statement is semantically identical to today's, preserving the fleet-less compatibility contract stated in that method's doc comment.
- **Known residual, accept and log:** if the host restarts while a card is blocked, the fleet comes back with no matching seat, so neither the resumed-output clear nor the `forceTerminals` clear can fire. The card stays blocked until `blockedTimeoutMs` expires or the operator acts. Bounded and visible, which is the right failure direction; the alternative (reap blocked rows whose `dispatched_terminal` is absent from a non-empty liveness snapshot) needs a new per-tick query and cannot be distinguished from a fleet-less host, so it is deliberately out of scope.

### 4. No changes to `ptyFleetService.ts`, `LocalApiServer.ts`, `verbSchemas.ts` or the DB schema

Stated explicitly because the removed hook design touched all of them and a reader who remembers it will expect this plan to as well. The `onData` heartbeat, the `recentlyClosed` tombstone, `blocked_at`, `setBlockedState` and `getActiveDispatchedByTerminal` already exist. This plan adds **no route, no verb, no schema, no migration, no env var, no generated file**, and does not modify the startup command — so the return-in-body verb contract, the schema-validation contract and the return-contract ratchet are all untouched by it. The one seam-shaped temptation (publishing `cwd` on the liveness snapshot) was evaluated and rejected in Change 1.

## Verification Plan

Compilation and automated tests are out of scope for this session; the steps below are manual/observational.

1. **Parity for non-fleet seats.** Dispatch to a native `vscode.Terminal` seat. Behaviour is byte-identical to today (blind timeout only); no blocked stamp ever appears.
2. **Measure the real quiet-stretch ceiling — do this before trusting the default.** For each agent CLI actually in use, dispatch a turn with a long tool call (large build, slow network fetch) and log `nowMs - lastDataAt` each tick. Record the maximum genuine mid-turn silence per CLI. If any exceeds 90s, raise the default rather than accepting false completions.
3. **True completion — and prove it was THIS branch.** Dispatch a plan; let the agent finish and write the plan file.
   > **Superseded:** Card clears within one tick of `turnEndSilenceMs`, well before `timeoutMs`. Exactly **one** completion toast — confirm the `transitioned` gate by checking the log does not also report a watcher-driven broadcast for the same turn.
   > **Reason:** As written this step is passed by the **pre-existing** mechanism and proves nothing about the new code. The change watcher clears on the plan-file write within its debounce — seconds, not 90s — so `dispatched_at` is already NULL when the silence branch looks, `getActiveDispatchedByTerminal` returns null, and the branch correctly no-ops. A tester would observe a fast clear and one toast whether or not Change 1 was implemented at all. A green step that cannot fail is the "appears to achieve the goal" trap.
   > **Replaced with:** two observations. (a) **Ordering, as the expected outcome:** confirm the card clears on the *watcher's* debounce and the log attributes it to the plan-file-edit path, with **no** silence-branch line for that turn and exactly one completion broadcast — i.e. the new branch correctly stands down when the watcher wins. (b) **Isolate the backstop:** re-run with the plan file outside the watcher's reach (dispatch into a worktree whose plan copy is not under a watched root, or set `planWatcher.periodicScanEnabled: false` and suppress the change event). The card must now clear via the silence branch — a distinct log line, one toast — and the mtime must have been read from the **worktree** copy. This is the only configuration in which the completion arm is load-bearing, so it is the only one that verifies it.
4. **Blocked path (the new capability).** Dispatch a prompt that makes the agent stop and ask a clarifying question without touching the plan file. After `turnEndSilenceMs`, card shows the dashed-amber ring and "Waiting on you" — not cleared, not plain working.
5. **Blocked survives the working window — the step the original plan lacked.** From step 4, walk away for longer than `timeoutMs` (10 min default; temporarily lower `timeoutMs` to its 60s floor to make this fast). Confirm at **> `timeoutMs`** after the last byte: the ring and badge are **still** rendered, `blocked_at` is still non-NULL in `kanban.db`, and the parent feature card (if any) still shows blocked. Then confirm it does clear at `blockedTimeoutMs` (lower it to its 10-minute floor for the test). Without Change 3 this step fails at ~8.5 minutes with the card rendering as *completed* — run it against the unmodified derive first if you want to see the defect.
6. **Blocked stamp is written once per turn, not once per tick.** With a seat blocked for 5+ minutes, confirm the log records one blocked transition, not one per 10s tick, and that `blocked_at` does not advance between ticks. This is the sql.js write-churn guard.
7. **Self-correction.** From step 4, answer the question. On the next tick after bytes resume, `blocked_at` is nulled by the `recordLiveness` UPDATE and the card returns to plain working. Then induce a false positive deliberately (temporarily set `turnEndSilenceMs` to its 30s floor and run a >30s quiet tool call): confirm the card flips to blocked and then **back** to working when output resumes — the miss is transient.
8. **Named false-completion path, confirmed as a known limitation.** Have the agent edit the plan file and *then* ask a question. Confirm the card reads as completed. This is expected and documented; the test exists so the limitation is observed rather than discovered later.
9. **Both death paths.** (a) Agent exits on its own: card force-clears via the `exited` branch, no blocked stamp on the way out. (b) Close the terminal from the panel: card force-clears via the `recentlyClosed` tombstone (surfaced as `status: 'exited'`), no blocked stamp. (c) Kill the terminal while its card is **blocked**: the unconditional `forceTerminals` UPDATE clears it immediately rather than waiting out `blockedTimeoutMs`. Confirm no dead seat reaches the silence branch.
10. **Undispatched seat.** Hold a manual chat in a fleet seat with no dispatched card, then go quiet past the threshold. No card anywhere changes state.
11. **Long-turn gating.** Dispatch a turn that runs past `timeoutMs` while producing output throughout. The card stays lit (the widened basis) and the silence branch never fires. Proves the two mechanisms compose rather than fight.
12. **Threshold interaction.** Set `livenessWindowMs` to 300000 and `turnEndSilenceMs` to 30000. Confirm turn-end fires at ~300s, not 30s, and that no seat is heartbeat-stamped and turn-ended on the same tick. Documents the `max(...)` behaviour rather than leaving it as a surprise.
13. **Re-dispatch clears blocked.** Re-dispatch a card sitting in the blocked state; confirm `blocked_at` is NULL on the new turn.
14. **Byte-compat on a pre-blocked board.** With `blocked_at` NULL on every row (a fresh DB, or a fleet-less host), confirm card working-state rendering, the feature rollup and the timeout sweep are indistinguishable from the pre-change build. This is the ~4,000-install guard on the derive change.
15. **Standalone parity.** Repeat steps 4, 5 and 7 under `npx switchboard`. `bootstrap.ts` carries its own `isWorkingState` copy and its own `getFeatureWorkingStates` call — a fix applied to only one copy shows up here and nowhere else.
16. **Cost.** With 8 fleet terminals under heavy output, confirm no measurable interactive-latency change, that the added work is one `stat` per silent dispatched seat per tick (not per flush), and that DB persists per tick have not increased for live seats.

## Recommendation

**Send to Coder.** Build it. Complexity 6.

Ship Change 1 and Change 3 **together**. Change 1 alone produces a badge with an ~8.5-minute lifespan that then collapses into the *completed* rendering — a capability that is worse than absent, because it teaches the operator that the board forgets. Change 3 alone is inert (no writer). Neither half is independently shippable, which is why this stays one plan rather than two.

Run Verification step 2 (the quiet-stretch measurement) **before** shipping the `turnEndSilenceMs` default, and treat its output as the real value — 90s is inherited from a neighbouring knob, not measured.

Run Verification step 5 against the **unmodified** derive first. It fails there, and watching it fail is the cheapest way for the implementer to understand why Change 3 is not optional.

If the step-2 measurement shows the CLIs in use go reliably quiet, close `pty-screen-state-idle-detection-headless-vt` permanently rather than leaving it pending — that would be this line of work succeeding by making its most expensive option unnecessary.
