# Split a Board Selection of Features into Worktrees in One Action

## Goal

Select N features on the kanban board, press one button, and get N per-feature worktrees, each seated with a coder and a reviewer terminal — so setting up a parallel run over a backlog is one action instead of N repetitions of a per-feature action.

### Problem analysis

The operator workflow this serves: take six features off the backlog, give each an isolated tree with a coder and a reviewer, monitor them from the Terminals panel, then merge them back when reviewed. Today only the middle of that is supported, and the setup step is the friction that makes the whole topology unattractive to use.

Worktree creation is currently **one feature at a time, from the webview only**:

- `createWorktreeForFeature` lives inside a `case` in `src/services/KanbanProvider.ts:11339`. It resolves the default branch, calls `_createSafetyWorktree`, records the row via `db.addWorktree(branch, path, featureId, …)`, seats terminals, refreshes the board, and toasts.
- To set up six features you repeat the per-feature action six times, each with its own toast and board refresh.

And the terminals it seats are the wrong set for this workflow: line `:11339` passes `activeAgents` — *every* visible agent role — rather than the coder/reviewer pair the run actually needs. Six features would spawn six full agent sets instead of twelve terminals.

### Root cause

This is a wiring gap, not missing machinery. Every primitive already exists:

- **Selection is solved.** `src/webview/kanban.html:6419-6430` already derives `selectedFeatures` from `selectedCards` by filtering on `v.isFeature`, and `currentFeatureWorktrees[featurePlanId]` already maps a feature to its existing worktree. There is simply no worktree action bound to that selection.
- **Multi-select actions are an established pattern.** `moveSelected` (`KanbanProvider.ts:9351`) takes `{ workspaceRoot, sessionIds[] }` and fans out; `archiveSelected`, `completeSelected`, `promptSelected`, `codeMapSelected` follow the same shape. A bulk worktree verb is a new member of a family, not a new concept.
- **Terminal seating already accepts a role list.** `ensureWorktreeTerminals(worktreePath, roles: string[], reveal, isManual)` (`TaskViewerProvider.ts:10015`). Seating exactly `['coder','reviewer']` is an argument change.
- **The Terminals panel already groups by worktree.** `src/webview/terminals.js:2128-2151` builds live groups with `source: 'worktree'` keyed on each terminal's `worktreePath`, `:2208` resolves membership, and there is a `worktree:*` picker plus `toggleWorktreeAgentsOpenWithGrid`.

### Blocking prerequisite — terminals currently land on the wrong surface

**This plan cannot deliver its stated goal until `route-agent-terminals-to-the-active-surface.md` lands.** Confirmed by reproduction: creating a worktree from the board today produces a correct worktree row but no entry in the `terminals.html` sidebar, and **Open agent terminals** opens the terminals in VS Code. The cause is that `ensureWorktreeTerminals` → `_createAutobanTerminal` → `vscode.window.createTerminal` is hardcoded, while the cockpit's per-worktree groups are derived from PTY-fleet terminals carrying a `worktreePath`.

Built on today's behaviour, the button in this plan would create twelve VS Code terminals and leave the cockpit empty — the same failure six times over. Step 3 below therefore assumes surface-aware creation is already in place.

### Dependency

Step 1 below (extracting `createWorktreeForFeature` into a callable provider method) is **the same extraction** specified in `feature_plan_20260811143000_dispatch-analysis-worktree-recommendation.md` §1, which needs it for `POST /worktree/feature`. Whichever plan lands first performs the extraction; the second consumes the existing method and skips its own §1. Do not extract it twice.

## Implementation

### 1. Extract the single-feature creator, with roles as a parameter

Lift the body of `case 'createWorktreeForFeature'` (`KanbanProvider.ts:11339`) into a public provider method, leaving the message case as a thin caller that keeps its user-facing toasts. Add a `roles?: string[]` option that **defaults to today's `activeAgents` behaviour**, so the existing per-feature button's behaviour is byte-identical after the extraction.

Terminal seating must be best-effort inside the method: a headless host has no `_taskViewerProvider`, and a seating failure must never fail a creation that already produced a tree and a DB row.

### 2. New verb: `createWorktreesForSelectedFeatures`

Shaped after `moveSelected`: `{ workspaceRoot, featureIds: string[], roles?: string[] }`.

Loop **sequentially**, not concurrently — `git worktree add` against one repository is not safe to parallelise, and serial execution also keeps the progress reporting legible. A failure on one feature must never abort the loop; collect a per-feature outcome and continue.

Classify each outcome into three buckets, because they mean different things to the operator:

- **created** — new tree and row.
- **skipped** — the feature already has an `active` worktree. The existing guard returns `Feature already has worktree: <branch>`; that is a no-op, not an error, and must not be reported as a failure.
- **failed** — `_createSafetyWorktree` threw (detached HEAD, missing default branch, branch name already taken, disk). Carry the message.

### 3. Seat a coder and a reviewer per tree

Pass `['coder','reviewer']` from the bulk path. Two details that matter at six trees but not at one:

- **`reveal: false`.** The single-feature path passes `reveal = true`; twelve terminals each demanding focus makes the panel unusable. Reveal nothing on the bulk path and let the operator navigate.
- **Terminal identity must carry `worktreePath`**, since that is the key `terminals.js:2131` groups on. If bulk-seated terminals do not carry it, they land ungrouped and the monitoring story collapses. Verify rather than assume.

### 4. Board affordance

Add the action to the existing multi-select action bar, enabled when at least one selected card has `isFeature`. Non-feature cards in the selection are ignored and named in the result — silently dropping them would read as the button half-working.

No confirmation dialog, per project rules. The button acts immediately.

### 5. Progress reporting

Six `git worktree add` operations take long enough that a silent button reads as broken. Post each per-feature outcome as it lands rather than one summary at the end, and finish with a summary line naming created / skipped / failed counts.

### 6. Never write `feature_worktree_mode`

Creating worktrees must not touch that config key. Orchestration stashes a prior under `orchestration_prior_feature_worktree_mode` and restores it later; a stray write from this path clobbers that dance. Mode changes stay the user's, via `setFeatureWorktreeMode`.

## Verification Plan

1. **Unit — fan-out.** Three feature ids, one of which already has an active worktree. Assert two created, one skipped-not-failed, and that the loop visited all three.
2. **Unit — failure isolation.** Stub `_createSafetyWorktree` to throw for the second of three. Assert the first and third are created and the second is reported failed with its message.
3. **Unit — roles.** Assert the bulk path calls `ensureWorktreeTerminals` with exactly `['coder','reviewer']` and `reveal: false`, and that the single-feature path still passes `activeAgents` with `reveal: true` (the extraction must not change existing behaviour).
4. **Unit — seating is best-effort.** With no `_taskViewerProvider`, assert creation still succeeds and returns branch and path.
5. **Unit — non-feature cards.** A selection mixing features and plain plans. Assert only features are attempted and the plain plans are named in the result.
6. **Manual — the actual workflow.** Select six features, press the button. Confirm six trees appear in `git worktree list`, six `active` rows in the Worktrees tab, and twelve terminals in the Terminals panel.
7. **Manual — monitoring.** In `terminals.html`, confirm the twelve terminals group under six `source: 'worktree'` groups, that the `worktree:*` picker jumps between them, and that the grid view shows them. This requires the surface-routing prerequisite to have landed; if terminals appear in VS Code instead, that prerequisite has regressed rather than this plan having failed. Capture precisely what is missing before commissioning any terminals-panel work — there is uncommitted in-flight work on terminal groups, grids, peek and bulk creation, so run this against that work rather than against `main`.
8. **Manual — single-feature parity.** Create one worktree via the existing per-feature button. Confirm it still seats the full agent set, reveals, toasts, and records its row — proving the extraction preserved the UI path.

## Metadata

**Complexity:** 5
**Tags:** backend, ui, feature, devops
**Project:** Browser Switchboard
