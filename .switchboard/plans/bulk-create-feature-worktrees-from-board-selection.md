# Split a Board Selection of Features into Worktrees in One Action

## Goal

Select N features on the kanban board, press one button, and get N per-feature worktrees, each seated with a coder and a reviewer terminal — so setting up a parallel run over a backlog is one action instead of N repetitions of a per-feature action.

### Problem analysis

The operator workflow this serves: take six features off the backlog, give each an isolated tree with a coder and a reviewer, monitor them from the Terminals panel, then merge them back when reviewed. Today only the middle of that is supported, and the setup step is the friction that makes the whole topology unattractive to use.

Worktree creation is currently **one feature at a time, from the webview only**:

- `createWorktreeForFeature` lives inside a `case` in `src/services/KanbanProvider.ts:11677`. It resolves the default branch, calls `_createSafetyWorktree`, records the row via `db.addWorktree(branch, path, featureId, …)`, seats terminals, refreshes the board, sends worktree config, and toasts.
- To set up six features you repeat the per-feature action six times, each with its own toast and board refresh.

And the terminals it seats are the wrong set for this workflow: line `:11702` passes `activeAgents` — *every* visible agent role — rather than the coder/reviewer pair the run actually needs. Six features would spawn six full agent sets instead of twelve terminals.

### Root cause

This is a wiring gap, not missing machinery. Every primitive already exists:

- **Selection is solved.** `src/webview/kanban.html:6941-6943` already derives `selectedFeatures` from `selectedCards` by filtering on `v.isFeature`, and `currentFeatureWorktrees[featurePlanId]` (declared `:4879`) already maps a feature to its existing worktree — `:12999` already uses it to exclude features that have one. There is simply no worktree action bound to that selection.
- **Multi-select actions are an established pattern.** `moveSelected` (`KanbanProvider.ts:9550`) takes `{ workspaceRoot, sessionIds[] }` and fans out; `archiveSelected` (`:9156`), `promptSelected` (`:9869`), `completeSelected` (`:10232`), `codeMapSelected` (`:10846`) follow the same shape. A bulk worktree verb is a new member of a family, not a new concept.
- **Terminal seating already accepts a role list.** `ensureWorktreeTerminals(worktreePath, roles: string[], reveal, isManual)` (`TaskViewerProvider.ts:10343`). Seating exactly `['coder','reviewer']` is an argument change.
- **The Terminals panel already groups by worktree.** `src/webview/terminals.js:2489-2500` builds live groups with `source: 'worktree'` keyed on each terminal's `worktreePath`, `:2546` resolves membership, and there is a `worktree:*` picker plus `toggleWorktreeAgentsOpenWithGrid`.

### Blocking prerequisite — terminals currently land on the wrong surface

**This plan cannot deliver its stated goal until `route-agent-terminals-to-the-active-surface.md` lands.** Confirmed by reproduction: creating a worktree from the board today produces a correct worktree row but no entry in the `terminals.html` sidebar, and **Open agent terminals** opens the terminals in VS Code. The cause is that `ensureWorktreeTerminals` → `_createAutobanTerminal` → `vscode.window.createTerminal` (`TaskViewerProvider.ts:9534`) is hardcoded, while the cockpit's per-worktree groups are derived from PTY-fleet terminals carrying a `worktreePath`.

Built on today's behaviour, the button in this plan would create twelve VS Code terminals and leave the cockpit empty — the same failure six times over. Step 3 below therefore assumes surface-aware creation is already in place.

### Second blocking prerequisite — the per-role terminal cap makes six features impossible

*(Not present in the previous revision of this plan; found by reading `_createAutobanTerminal` at HEAD.)*

`_createAutobanTerminal` refuses creation when the role's pool is full (`TaskViewerProvider.ts:9517-9521`), and that pool is **workspace-global**: `_getConfiguredAutobanPool(role)` reads `this._autobanState.terminalPools[role]`, which has no worktree dimension, against `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5` (`src/services/autobanState.ts:16`). `ensureWorktreeTerminals` then appends every terminal it creates back into that same pool (`:10406-10420`).

So the plan's own headline scenario is unreachable at HEAD: the sixth feature's `coder` is refused with a warning toast and `_createAutobanTerminal` returns `undefined`. Six features yield ten terminals, not twelve — and worse, the ten that *were* created have displaced the operator's main-tree terminals from the autoban rotation pool, because `_limitAutobanPool` truncates to five.

**The fix belongs in the prerequisite plan, not here.** `route-agent-terminals-to-the-active-surface.md` §4a scopes the cap by worktree path + backend and stops worktree-seated terminals from joining the rotation pool. This plan must not implement a local workaround — a second cap-scoping implementation inside the bulk path is exactly the duplication this feature is trying to avoid.

### Dependency

Step 1 below is **the same extraction** specified in `feature_plan_20260811143000_dispatch-analysis-worktree-recommendation.md` §1, which needs it for `POST /worktree/feature`. That route does not exist yet — `LocalApiServer.ts` currently exposes only `/worktree/cleanup` (`:3977`) and `/worktree/list` (`:4013`) — so the extraction is genuinely unclaimed. Whichever plan lands first performs it; the second consumes the existing method and skips its own §1. Do not extract it twice.

## Metadata

**Complexity:** 5
**Tags:** backend, ui, feature, devops
**Project:** Browser Switchboard

## User Review Required

None. The open choices are settled here: roles are `['coder','reviewer']`, the loop is sequential, `reveal: false`, non-feature cards are ignored-and-named, and the shared creation path is `_ensureFeatureIntegrationWorktree` widened rather than a fresh extraction.

## Complexity Audit

### Routine

- A new multi-select verb shaped after four existing siblings.
- A new button in the existing multi-select action bar, gated on `v.isFeature`.
- Per-item progress messages over the existing push transport.

### Complex / Risky

- The extraction must leave the existing single-feature UI path byte-identical (toasts, reveal, full agent set, board refresh, worktree config push) on ~4,000 shipped installs.
- There are already **three** feature-worktree creation paths in `KanbanProvider.ts`; a naive extraction makes it four. Consolidating them instead is the higher-value but higher-risk move.
- `git worktree add` against one repository is not concurrency-safe; the fan-out must be serial and must not abort on one failure.

## Implementation

### 1. Consolidate onto the creator that already exists

> **Superseded:** "Lift the body of `case 'createWorktreeForFeature'` (`KanbanProvider.ts:11339`) into a public provider method, leaving the message case as a thin caller."
> **Reason:** the extraction target already exists and the previous revision did not know about it. `_ensureFeatureIntegrationWorktree(workspaceRoot, db, featurePlanId, featureTopic)` (`KanbanProvider.ts:12458`) is already a callable, idempotent, per-feature worktree creator: it runs the same "feature already has an active worktree" guard against `getWorktrees()`, resolves the default branch, calls `_createSafetyWorktree`, records the row via `db.addWorktree`, seats terminals via `ensureWorktreeTerminals(wtPath, activeAgents, false, true)`, carries a race fallback for two near-simultaneous calls, and returns the `WorktreeRow`. Its only caller today is `:13383`. Lifting the `case` body into a *new* method would make this the **fourth** implementation of feature-worktree creation in one file (the `case` at `:11677`, `createWorktreeForProject` at `:11729`, `_ensureFeatureIntegrationWorktree` at `:12458`, and the new one) — the precise outcome the dispatch-analysis plan warns against.
> **Replaced with:** widen `_ensureFeatureIntegrationWorktree` into the single public creator and repoint every caller at it.

The unified signature:

```ts
public async ensureFeatureWorktree(
    workspaceRoot: string,
    db: KanbanDatabase,
    featurePlanId: string,
    featureTopic: string,
    opts?: { roles?: string[]; reveal?: boolean; repoName?: string }
): Promise<{ outcome: 'created' | 'skipped' | 'failed'; row?: WorktreeRow; error?: string }>
```

Four things it must preserve or change deliberately:

- **`roles` defaults to today's `activeAgents` resolution** (`_getVisibleAgents` → enabled roles), so the existing per-feature button's behaviour is byte-identical after the change.
- **`reveal` defaults to `true`** for the `case` caller and `false` for the two programmatic callers, matching what each does today. `_ensureFeatureIntegrationWorktree` currently hardcodes `false`; the `case` hardcodes `true`.
- **`repoName`** is threaded through to `_createSafetyWorktree` — the `case` passes `msg.repoName` (`:11652`), `_ensureFeatureIntegrationWorktree` passes `undefined`.
- **Outcome replaces the swallow.** `_ensureFeatureIntegrationWorktree` currently catches, logs, and returns `undefined` or a race-fallback row (`:12484-12489`) — a shape that cannot distinguish "already existed" from "creation threw". The bulk path needs all three, so the method returns them and the race fallback maps to `skipped`.

Toasts, `_refreshBoard` and `_sendWorktreeConfig` stay in the callers, not in the method — the bulk path must not fire six toasts and six refreshes.

Terminal seating stays best-effort inside the method: a headless host has no `_taskViewerProvider`, and a seating failure must never fail a creation that already produced a tree and a DB row. This is already how both existing callers behave.

### 2. New verb: `createWorktreesForSelectedFeatures`

Shaped after `moveSelected` (`:9550`): `{ workspaceRoot, featureIds: string[], roles?: string[] }`.

Loop **sequentially**, not concurrently — `git worktree add` against one repository is not safe to parallelise, and serial execution also keeps the progress reporting legible. A failure on one feature must never abort the loop; collect a per-feature outcome and continue.

The three outcome buckets come straight back from step 1's return, because they mean different things to the operator:

- **created** — new tree and row.
- **skipped** — the feature already has an `active` worktree. The existing guard returns `Feature already has worktree: <branch>`; that is a no-op, not an error, and must not be reported as a failure.
- **failed** — `_createSafetyWorktree` threw (detached HEAD, missing default branch, branch name already taken, disk). Carry the message.

**Register the verb properly — the previous revision omitted both steps.** `src/generated/verbAllowlist.ts` is generated: add the verb and run `npm run catalog:check` (`package.json:887`) so `KANBAN_VERBS` and the protocol catalog stay in sync, or `npm run parity:check` fails in CI. Add a matching entry to `verbSchemas.ts` beside `createWorktreeForFeature` (`:475`) — PRD contract #5 requires per-verb boundary validation, and the schema must be permissive and field-accurate: `featureIds` required, `roles` and `workspaceRoot` optional. Return the per-feature outcome array in the HTTP body per PRD contract #4; a bare `{success:true}` is a contract violation for a verb whose whole value is its per-item result.

### 3. Seat a coder and a reviewer per tree

Pass `['coder','reviewer']` from the bulk path. Three details that matter at six trees but not at one:

- **`reveal: false`.** The single-feature path passes `reveal = true`; twelve terminals each demanding focus makes the panel unusable. Reveal nothing on the bulk path and let the operator navigate.
- **Terminal identity must carry `worktreePath`**, since that is the key `terminals.js:2476` groups on. If bulk-seated terminals do not carry it, they land ungrouped and the monitoring story collapses. Verify rather than assume. Note also that a derived worktree group only materialises once that path's live terminal count reaches the sidebar group `threshold` — seating both roles is what makes the group appear.
- **On the fleet surface, seat both roles in one call.** The pty host already exposes `ptyCreateBatch` (`src/standalone/ptyHost.ts:114` → `ptyFleetService.createBatch`, `src/standalone/ptyFleetService.ts:530`), which takes `allocation: [{role, count}]` plus one shared `cwd`/`worktreePath`, caps at `MAX_BATCH = 32`, and returns `created` / `failed` / `estimatedDurationMs`. That is exactly one worktree's role set. Prefer it over two sequential `ptyCreateTerminal` calls, and feed its `estimatedDurationMs` into the progress reporting in step 5 rather than inventing a pacing estimate. This is a routing detail inside the prerequisite plan's fleet branch — this plan consumes it, it does not implement it.

### 4. Board affordance

Add the action to the existing multi-select action bar in `src/webview/kanban.html` (the bar driven by `selectedCards`, `:5068`/`:5124`), enabled when at least one selected card has `isFeature` — the same predicate already used at `:6941-6943`. Non-feature cards in the selection are ignored and named in the result — silently dropping them would read as the button half-working.

No confirmation dialog, per project rules. The button acts immediately.

### 5. Progress reporting

Six `git worktree add` operations take long enough that a silent button reads as broken. Post each per-feature outcome as it lands rather than one summary at the end, and finish with a summary line naming created / skipped / failed counts. Route the push through the broadcast transport, not a raw `panel.webview.postMessage` — `scripts/check-push-routing.js` holds `KanbanProvider.ts` at a baseline of **1** raw send and will fail the build on a second.

### 6. Never write `feature_worktree_mode`

Creating worktrees must not touch that config key. Orchestration stashes a prior under `orchestration_prior_feature_worktree_mode` (`KanbanProvider.ts:2244-2253`, `:8363-8376`) and restores it later; a stray write from this path clobbers that dance. Mode changes stay the user's, via `setFeatureWorktreeMode`.

## Edge-Case & Dependency Audit

**Race conditions.** The consolidated method keeps `_ensureFeatureIntegrationWorktree`'s check-then-create guard and its race fallback, so a bulk run overlapping a per-feature click converges on one row rather than two. Sequential iteration means the bulk path never races itself. The `getWorktrees()` snapshot is re-read per feature, not hoisted, or a tree created earlier in the same batch is invisible to the guard later in it.

**Security.** No new network surface beyond the verb; the schema is the boundary check. Feature ids are used as DB lookups and as branch-name input to `_createSafetyWorktree` — that path already sanitises topics for the existing button and must not be bypassed.

**Side effects.** One board refresh and one worktree-config push at the end of the batch, not per feature. Six trees is real disk. Nothing writes `feature_worktree_mode`.

**Dependencies & conflicts.**
- Blocked on `route-agent-terminals-to-the-active-surface.md` for both the surface routing and the per-role cap scoping.
- **Contends with `bulk-merge-back-reviewed-feature-worktrees.md` on three files**: `src/services/KanbanProvider.ts` (both add a verb case), `src/services/verbSchemas.ts` (both append), and `src/generated/verbAllowlist.ts` (both regenerate a single generated line). Per the project PRD's "one agent stream per provider file", these two must serialise, not run in parallel. Both also add a control to the same multi-select action bar in `kanban.html`.
- Shares the `createWorktreeForFeature` extraction with `feature_plan_20260811143000_dispatch-analysis-worktree-recommendation.md` §1 — first to land performs it.

## Dependencies

- `route-agent-terminals-to-the-active-surface.md` — surface-aware terminal creation and worktree-scoped per-role cap. Hard blocker.
- `feature_plan_20260811143000_dispatch-analysis-worktree-recommendation.md` — shares the single-feature creator consolidation; either order, never both.

## Adversarial Synthesis

**Risk summary.** The headline risk is silent under-delivery: at HEAD the button would produce ten terminals instead of twelve and evict the operator's autoban pool, and every existing gate would stay green because nothing asserts the count. Mitigations: hard-block on the prerequisite plan's cap scoping, assert the per-worktree seating count in a test rather than trusting the manual pass, and consolidate onto `_ensureFeatureIntegrationWorktree` instead of adding a fourth creation path. Secondary risk: the extraction silently changes the shipped single-feature button (reveal, role set, toasts, repoName) — pinned by a parity test that exercises the existing path unchanged.

## Proposed Changes

### `src/services/KanbanProvider.ts`

- **Context.** Holds `case 'createWorktreeForFeature'` (`:11677`), `createWorktreeForProject` (`:11729`), `_ensureFeatureIntegrationWorktree` (`:12458`), `_resolveDefaultBranch` (`:12430`), `_createSafetyWorktree`, and the multi-select verb family (`:9156`, `:9550`, `:9869`, `:10232`, `:10846`).
- **Logic.** Widen `_ensureFeatureIntegrationWorktree` into a public `ensureFeatureWorktree` returning a typed outcome; repoint the `case` and the `:13383` caller at it; add `case 'createWorktreesForSelectedFeatures'` that loops it sequentially.
- **Implementation.** Add `opts.roles`/`reveal`/`repoName`; replace the `undefined`-returning catch with `{outcome:'failed', error}`; map the race fallback to `skipped`; keep toasts/refresh/config-push in callers.
- **Edge cases.** No `_taskViewerProvider` → creation still succeeds, seating skipped. Re-read `getWorktrees()` per iteration.

### `src/services/verbSchemas.ts`

- **Context.** `createWorktreeForFeature` schema at `:475`.
- **Logic.** Add `createWorktreesForSelectedFeatures`.
- **Implementation.** `featureIds: { type: 'array', required: true }`, `roles: { type: 'array' }`, `workspaceRoot: { type: 'string' }`.
- **Edge cases.** Permissive per PRD contract #5 — reject nothing the webview legitimately sends.

### `src/generated/verbAllowlist.ts`

- **Context.** Generated; `KANBAN_VERBS` is a single line.
- **Logic.** Regenerate.
- **Implementation.** `npm run catalog:check`.
- **Edge cases.** Merge-conflicts with any sibling plan adding a verb — serialise.

### `src/webview/kanban.html`

- **Context.** Multi-select bar around `:5068`-`:5162`; feature predicate at `:6941`.
- **Logic.** New bulk-worktree action, enabled when the selection contains ≥1 feature.
- **Implementation.** Post the new verb with the feature ids; render per-item progress and the final summary.
- **Edge cases.** Mixed selection → features attempted, plain plans named in the result. No confirm gate.

## Verification Plan

### Automated Tests

1. **Unit — fan-out.** Three feature ids, one of which already has an active worktree. Assert two created, one skipped-not-failed, and that the loop visited all three.
2. **Unit — failure isolation.** Stub `_createSafetyWorktree` to throw for the second of three. Assert the first and third are created and the second is reported failed with its message.
3. **Unit — roles and reveal.** Assert the bulk path calls seating with exactly `['coder','reviewer']` and `reveal: false`, and that the single-feature `case` still resolves `activeAgents` with `reveal: true` and forwards `repoName` (the consolidation must not change existing behaviour).
4. **Unit — seating is best-effort.** With no `_taskViewerProvider`, assert creation still succeeds and returns branch and path.
5. **Unit — non-feature cards.** A selection mixing features and plain plans. Assert only features are attempted and the plain plans are named in the result.
6. **Unit — seating count at scale.** Six feature ids. Assert twelve seating requests are issued and none is refused — the regression test for the per-role cap prerequisite. This test must fail if that prerequisite regresses.
7. **Unit — third caller unchanged.** Assert the `:13383` per-feature-mode caller still gets `reveal: false` and the full agent set after the consolidation.
8. **Contract — verb registration.** `npm run catalog:check` and `npm run parity:check` pass with the new verb; `npm run push-routing:check` still reports `KanbanProvider.ts` at its baseline.

### Manual

9. **The actual workflow.** Select six features, press the button. Confirm six trees in `git worktree list`, six `active` rows in the Worktrees tab, and twelve terminals in the Terminals panel.
10. **Monitoring.** In `terminals.html`, confirm the twelve terminals group under six `source: 'worktree'` groups, that the `worktree:*` picker jumps between them, and that the grid view shows them. This requires the surface-routing prerequisite to have landed; if terminals appear in VS Code instead, that prerequisite has regressed rather than this plan having failed.
11. **Autoban pool untouched.** Before and after the batch, confirm the operator's main-tree autoban pools for `coder` and `reviewer` are unchanged — no worktree terminal has entered the rotation pool.
12. **Single-feature parity.** Create one worktree via the existing per-feature button. Confirm it still seats the full agent set, reveals, toasts, and records its row — proving the consolidation preserved the UI path.

> **Superseded:** "Capture precisely what is missing before commissioning any terminals-panel work — there is uncommitted in-flight work on terminal groups, grids, peek and bulk creation, so run this against that work rather than against `main`."
> **Reason:** stale. `git status --porcelain -- src/` is clean at HEAD; that terminal-groups/grid/peek work landed in commit `1bd39f4a` ("terminals fleet, tickets subtasks, standalone pty, delegate contract"). There is no uncommitted tree to run against.
> **Replaced with:** run the manual passes against `main` at HEAD.

---

**Recommendation: Send to Coder** (complexity 5).
