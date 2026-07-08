# Manual Worktree Provisioning + terminal.show() Focus-Stealing Fix

**Plan ID:** 4748075c-b9af-4217-aa7a-faeb39c42c04

## Metadata

**Complexity:** 5
**Tags:** ui, ux, refactor, reliability
**Project:** (unassigned)

## Goal

Stop `terminal.show()` from stealing focus when worktrees are auto-provisioned, and make worktree provisioning an explicit user action (a "CREATE WORKTREE" board button) rather than a side effect of feature creation — while keeping orchestrator-driven auto-provisioning intact.

### Problem

When a user creates multiple features (e.g. via `group-into-features` or `create-feature`), the system automatically provisions a git worktree per feature and opens a full set of agent terminals in each worktree. Each terminal calls `terminal.show()`, stealing focus. The result is disconcerting: several worktrees appear at once, the terminal panel fills with terminals the user didn't ask for, and focus jumps repeatedly. The user may not want to start work on the features immediately.

### Background

Auto-provisioning is controlled by `feature_worktree_mode` in the kanban DB. Two values exist: `'none'` (manual) and `'per-feature'` (auto-create one shared worktree per feature at creation time). The mode is set either manually via a radio in the Worktrees tab, or automatically when the user selects orchestration automation mode (`setAutomationMode` handler saves the prior value, sets `per-feature`, and restores on switch-away).

When `per-feature` mode is active, `_ensureFeatureIntegrationWorktree` fires at feature-creation time (`KanbanProvider.ts` line ~10668). It creates the git worktree, then calls `ensureWorktreeTerminals`, which calls `_createAutobanTerminal` for each active agent role. Each `_createAutobanTerminal` calls `terminal.show()` unconditionally (line ~7286), which focuses/reveals the terminal in the panel.

### Root Cause

Two separate issues combine:

1. **Auto-provisioning fires for manual users** — the `per-feature` radio is user-accessible in the Worktrees tab, so a user can accidentally enable auto-provisioning. Even without touching the radio, the mode persists in the DB, so a prior orchestration session that didn't clean up could leave it on.

2. **`terminal.show()` is unconditional on the worktree autoban terminal path** — every worktree autoban terminal creation path (manual, auto, batch) calls `.show()` at `TaskViewerProvider.ts:7286`, which steals focus. Even a single manual worktree creation opens N terminals and focuses each one in sequence. *(Clarification: this plan scopes the fix to the autoban worktree terminal creation path only. Other `terminal.show()` call sites in `TaskViewerProvider.ts` — manual single-terminal creation, dispatch reveals, etc. — are intentionally out of scope; their focus behavior is intended.)*

## User Review Required

Yes — before implementation, confirm:
- The "CREATE WORKTREE" board button placement (after "SUGGEST FEATURES" in `kanban-sub-bar`) and its selection-aware behavior matrix are the desired UX.
- Removing the "Auto Mode" radio entirely (vs. hiding it) is acceptable — `feature_worktree_mode` becomes orchestrator-only and is no longer user-toggleable from the UI.
- The startup stale-mode reconciliation (crash-during-orchestration recovery) is wanted as part of this change.

## Complexity Audit

### Routine
- Adding a `reveal: boolean` flag (5th parameter) to `_createAutobanTerminal` and threading it through `ensureWorktreeTerminals` — a one-line gate on `terminal.show()`.
- Passing `reveal: false` from the auto-provision caller and `reveal: true` from the four manual/explicit callers — argument additions at known call sites.
- Removing the "Auto Mode" radio block from `kanban.html` — DOM-element deletion in the Worktrees-tab render path.
- Adding a static "CREATE WORKTREE" `<button>` to the `kanban-sub-bar` toolbar — mirrors existing `strip-btn` buttons.
- Reusing the existing `createWorktree` / `createWorktreeForFeature` / `createWorktreeForProject` message handlers — no new backend messages.
- Startup stale-mode reconciliation — a config read + conditional reset on activation.

### Complex / Risky
- Board-button state management: enable/disable + tooltip must track selection state (`selectedCards` size, `isFeature`, existing-worktree check via `currentFeatureWorktrees`), be initialized on board render (not only on selection change), and stay decoupled from `recomputeWorktreeIndicator` via a dedicated `updateCreateWorktreeButton()`.
- Board-button message construction: must source `featureTopic` from `currentCards[pid].topic` (not present in `selectedCards` values) and use the `selectedCards` *key* as `featureId` for feature cards (the value's `featureId` field is for subtask cards, empty for feature cards).
- Crash-recovery hole opened by removing the radio: a crash mid-orchestration leaves `feature_worktree_mode = 'per-feature'` with no UI to see or reset it — requires a startup reconciliation guard.

## Edge-Case & Dependency Audit

### Race Conditions
- **Duplicate worktree creation** — the backend's existing guard (`KanbanProvider.ts:9143-9149`) blocks duplicate feature worktrees with an info message, so a stale board-button state (worktree created via the Worktrees tab before the board refreshes) results in a no-op click, not a duplicate. `_ensureFeatureIntegrationWorktree` (9812-9843) has its own check-then-create guard with a race fallback that re-reads `getWorktrees()` on failure.
- **Mode toggle mid-creation** — `feature_worktree_mode` is snapshotted once at feature-creation time (`featureWorktreeModeSnapshot`, KanbanProvider.ts:10666), so a toggle mid-creation cannot split a feature between two provisioning behaviors. Unchanged by this plan.

### Security
- No new attack surface. Worktree paths are resolved via `path.resolve`; branch/topic names flow through the existing `_createSafetyWorktree` sanitization. No user-supplied input is newly trusted.

### Side Effects
- **Removed radio removes observability** — `feature_worktree_mode` is no longer visible/toggleable in the UI. The startup reconciliation (see Proposed Changes §5) is the compensating control; without it, a stale `per-feature` mode is invisible and silently auto-provisions.
- **`reveal: false` terminals still appear in the terminal list** — they are created and running, just not focused/revealed. The user can open them from the terminal dropdown. This is the desired orchestration behavior; the existing `openWorktreeTerminals` handler (reveal via `revealWorktreeTerminal`) remains the explicit-reveal path.

### Dependencies & Conflicts
- **`setAutomationMode` save/restore contract** (KanbanProvider.ts:6722-6756) — depends on `orchestration_prior_feature_worktree_mode` config key being saved on switch-to-orchestration and consumed on switch-away. The startup reconciliation reuses this same key. No new keys.
- **`setFeatureWorktreeMode` handler** (KanbanProvider.ts:9238) — becomes dead code once the radio is removed (the radio's `change` listener was its only sender). Recommendation: keep the handler (harmless if unused); the orchestrator sets the config directly via `db.setConfig`, not via this handler. Removing it is optional cleanup, out of scope for this plan.
- **Board globals** — the board button depends on `selectedCards` (Map, kanban.html:4033), `currentFeatureWorktrees` (Object, :3968), `selectedWorktreeRepo` (string, :6492), `activeProjectFilter` (:4024), `currentCards` (board data, set in `renderBoard` :5522), and `currentWorkspaceRoot`. All exist and are refreshed on board updates.

## Dependencies

- None. This plan is self-contained; no other plan or session must complete first.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the board button cannot construct a valid `createWorktreeForFeature` message without sourcing `featureTopic` from `currentCards` and using the selectedCards *key* as `featureId`; (2) removing the "Auto Mode" radio deletes the only UI visibility into `per-feature` mode, so a crash mid-orchestration leaves silent, invisible auto-provisioning with no reset path; (3) the removal list omits the `autoModeHeader` div, leaving a dangling heading. Mitigations: mirror the Worktrees-tab payload (kanban.html:10508-10516) for message fields; add a startup reconciliation that consumes a stale `orchestration_prior_feature_worktree_mode` on activation; remove the entire Auto Mode block (header + desc + group + options).

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `reveal` flag on the worktree autoban terminal path

**Context:** `_createAutobanTerminal` (line 7243) creates an autoban pool terminal in the panel and unconditionally calls `terminal.show()` at line 7286, stealing focus. `ensureWorktreeTerminals` (line 8077) maps over roles and calls `_createAutobanTerminal(role, agentName, resolvedPath, true)` at lines 8132-8135 (the `true` is the 4th param `skipStatePoolUpdate`).

**Logic:**
- `_createAutobanTerminal` — add a **5th** parameter `reveal: boolean = true` (after the existing 4th `skipStatePoolUpdate: boolean = false`). Signature becomes:
  `private async _createAutobanTerminal(role: string, requestedName?: string, cwd?: string, skipStatePoolUpdate: boolean = false, reveal: boolean = true): Promise<...>`
- Gate the show: change `terminal.show();` (line 7286) to `if (reveal) terminal.show();`. The terminal is still created and started by `vscode.window.createTerminal` (line 7280); it appears in the terminal list regardless — `show()` only reveals/focuses the panel.
- `ensureWorktreeTerminals` (line 8077) — add a 3rd parameter `reveal: boolean = true`. Pass it through in the `Promise.all` map (lines 8132-8135):
  `this._createAutobanTerminal(role, agentName, resolvedPath, true, reveal)`

**Implementation:**
1. Edit `_createAutobanTerminal` signature (line 7243) — append `, reveal: boolean = true`.
2. Edit line 7286 — wrap `terminal.show();` in `if (reveal) { ... }`.
3. Edit `ensureWorktreeTerminals` signature (line 8077) — append `, reveal: boolean = true`.
4. Edit the map call (line 8134) — append `, reveal` after `true`.

**Edge Cases:** When `reveal` is false the terminal still registers in `_registeredTerminals`, still resolves its PID in the background (lines 7290-7302), and still counts toward `MAX_AUTOBAN_TERMINALS_PER_ROLE`. No behavior change except panel focus. The existing `openWorktreeTerminals` handler remains the explicit-reveal path (calls `revealWorktreeTerminal`).

### `src/services/KanbanProvider.ts` — caller reveal flags + startup stale-mode reconciliation

**Context:** Five callers invoke `ensureWorktreeTerminals`. One is auto-provisioning (should pass `reveal: false`); four are manual/explicit (should pass `reveal: true`). Separately, `setAutomationMode` (6722-6756) saves/restores `feature_worktree_mode` but only restores on a *clean* switch-away — a crash mid-orchestration leaves the mode stuck at `per-feature` with no UI reset (the radio is being removed).

**Logic — caller reveal flags:**

| Caller | File / line | Reveal | Reason |
|---|---|---|---|
| `_ensureFeatureIntegrationWorktree` | KanbanProvider.ts:9835 | `false` | Auto-provisioned by orchestrator |
| `createWorktree` handler | KanbanProvider.ts:9125 | `true` | Manual creation |
| `createWorktreeForFeature` handler | KanbanProvider.ts:9162 | `true` | Manual creation (incl. new board button) |
| `createWorktreeForProject` handler | KanbanProvider.ts:9198 | `true` | Manual creation |
| `openWorktreeTerminals` handler | KanbanProvider.ts:9277 | `true` | Explicit "open terminals" action |

Implementation: append `, false` to the call at line 9835; append `, true` (or rely on the default) to the calls at 9125, 9162, 9198, 9277. (The default is `true`, so the manual callers can omit the arg — but passing it explicitly documents intent.)

**Logic — startup stale-mode reconciliation (Clarification — crash-during-orchestration recovery):**

Add a reconciliation that runs once on extension activation / board init (alongside the existing config reads). Pseudocode:
```
const PRIOR_KEY = 'orchestration_prior_feature_worktree_mode';
const mode = await db.getConfig('feature_worktree_mode') || 'none';
const savedPrior = await db.getConfig(PRIOR_KEY);
if (mode === 'per-feature' && savedPrior) {
    // Orchestration saved a prior but never consumed it (crash / unclean exit).
    const validModes = ['none', 'per-feature'];
    await db.setConfig('feature_worktree_mode', validModes.includes(savedPrior) ? savedPrior : 'none');
    await db.setConfig(PRIOR_KEY, '');   // consume the stale prior
}
```
This reuses the exact same key + valid-modes list as `setAutomationMode` (6746-6748). It is idempotent and only fires when a prior was saved but not consumed — normal orchestration (clean switch-away) already clears the prior, so the guard is a no-op in the happy path.

**Edge Cases:** The reconciliation must not fire while an orchestration session is *actively* running (a live orchestrator legitimately holds `per-feature` with an unconsumed prior). Guard: skip the reset if an active orchestrator session is detected (check the existing orchestration-session state before resetting). If no live-session signal is available, the safe default is to still reset — a live orchestrator re-asserts `per-feature` on its next wake via `setAutomationMode`, so a transient reset is self-healing.

### `src/webview/kanban.html` — remove the Auto Mode radio block (entire section)

**Context:** The Worktrees-tab render path builds an "Auto Mode" section in the FEATURES panel. It consists of FOUR elements appended to `featuresSection`: `autoModeHeader` (lines 10415-10417), `featuresDesc` (10419-10422), `autoModeGroup` (10424-10426, populated by the `AUTO_MODE_OPTIONS.forEach` at 10433-10465), and the final `featuresSection.appendChild(autoModeGroup)` at 10466.

**Logic:** Remove the **entire** block — lines 10415 through 10466 — i.e. `autoModeHeader` + `featuresDesc` + `autoModeGroup` + `AUTO_MODE_OPTIONS`. *(Clarification: the original plan listed only `featuresDesc`, `autoModeGroup`, and `AUTO_MODE_OPTIONS`, omitting `autoModeHeader` — which would leave a dangling bold "Auto Mode" heading. Remove all four.)* The `featureWorktreeMode` config value still exists in the DB and is still read by the backend (`featureWorktreeModeSnapshot` at KanbanProvider.ts:10666); it is just no longer user-toggleable from the UI.

**Edge Cases:** The `setFeatureWorktreeMode` message handler (KanbanProvider.ts:9238) becomes unreachable from the UI (its only sender was the radio's `change` listener at kanban.html:10443-10450). Keep the handler — harmless if unused; the orchestrator sets the config directly via `db.setConfig`. Removing it is optional cleanup, out of scope.

### `src/webview/kanban.html` — add "CREATE WORKTREE" button to the board toolbar

**Context:** The `kanban-sub-bar` toolbar (line 2642) holds board-level actions. "SUGGEST FEATURES" is at line 2654. The board tracks selection in `selectedCards` (Map, :4033) whose values are `{ workspaceRoot, project, isFeature, featureId }` and whose *keys* are planIds. Board card data lives in `currentCards` (set in `renderBoard`, :5522), where feature cards expose `.planId`, `.topic`, and `.isFeature`. The existing Worktrees-tab "Create Feature Worktree" button (10508-10516) shows the exact payload shape for `createWorktreeForFeature`.

**Logic — static button (placement after "SUGGEST FEATURES", line 2654):**
```html
<button class="strip-btn" id="btn-create-worktree" data-tooltip="Create a worktree for the selected feature, or for the active project / workspace">CREATE WORKTREE</button>
```

**Selection-aware behavior:**

| Selection state | Button behavior | Message sent |
|---|---|---|
| 0 cards selected | Enabled. Creates project worktree (or unbound if no project active). | `createWorktreeForProject` (if `activeProjectFilter` set and not `__unassigned__`) or `createWorktree` (unbound) |
| 1 feature card selected | Enabled. Creates feature worktree linked to that feature. | `createWorktreeForFeature` |
| 1 non-feature card selected | Disabled. Tooltip: "Only feature cards can have worktrees" | — |
| 2+ cards selected | Disabled. Tooltip: "Select a single feature to create its worktree" | — |
| 1 feature card that already has a worktree | Disabled. Tooltip: "Feature already has a worktree" | — |

**Implementation details (Clarification — message field sourcing):**
- The handler reads `selectedCards`, `activeProjectFilter`, `currentFeatureWorktrees`, `selectedWorktreeRepo`, AND **`currentCards`** (for `.topic`) and **`currentWorkspaceRoot`** (for every message's `workspaceRoot` field). The original plan omitted the last two.
- **Feature case:** use the `selectedCards` *key* (the planId) as `featureId` — NOT `value.featureId` (that field is populated for *subtask* cards and is empty for a feature card itself). Look up the card in `currentCards` by that planId to get `.topic` as `featureTopic`. Mirror the Worktrees-tab payload (kanban.html:10508-10516):
  ```js
  postKanbanMessage({
      type: 'createWorktreeForFeature',
      featureId: pid,                       // the selectedCards KEY
      featureTopic: feature.topic,          // from currentCards.find(c => (c.planId||c.sessionId) === pid)
      workspaceRoot: currentWorkspaceRoot,
      repoName: selectedWorktreeRepo || undefined
  });
  ```
- **Project case (0 cards, active project):** `createWorktreeForProject` needs `project`, `repoName`, `workspaceRoot` (KanbanProvider.ts:9173-9198 uses `msg.project` as both the branch topic and the project link). Send `project: activeProjectFilter`.
- **Unbound case (0 cards, no project):** `createWorktree` needs `featureTopic`, `repoName`, `workspaceRoot` (KanbanProvider.ts:9104-9135). Send a default `featureTopic` (e.g. `'worktree'` or a timestamp-derived name) — match whatever the existing Worktrees-tab unbound button uses.
- **Button state — dedicated function, initialized on render (Clarification):** Add a dedicated `updateCreateWorktreeButton()` rather than bolting logic onto `recomputeWorktreeIndicator()` (which is a worktree-indicator function, not a toolbar-button function). Call `updateCreateWorktreeButton()` from the same selection-change sites that call `recomputeWorktreeIndicator()` (kanban.html:5240, 5671, 6156, 6610, 6655, 6752, 7385) AND **on board render** (`renderBoard`, ~5519) so the initial 0-card state (enabled) is correct at first paint — not only after the first selection change.
- Add a 5-second disable-after-click guard (matching the existing manual buttons' pattern at 10518).

**Edge Cases:**
- **Stale `currentFeatureWorktrees`** — the "already has a worktree" check reads `currentFeatureWorktrees` (refreshed on board updates). If a worktree is created via the Worktrees tab between board refreshes, the board button may show enabled for a feature that already has one. The backend's duplicate guard (KanbanProvider.ts:9143-9149) blocks the duplicate with an info message — worst case is a no-op click, not a duplicate.
- **`selectedWorktreeRepo` unset** — defaults to `''` (kanban.html:6492) if the user never opened the Worktrees tab; the backend falls back to the workspace's default repo. Acceptable — the Worktrees tab remains the detailed multi-repo path.

### Orchestration auto-provisioning stays as-is

The `setAutomationMode` handler (KanbanProvider.ts:6722-6756) already sets `feature_worktree_mode = 'per-feature'` when orchestration is selected and restores the prior value on switch-away. This continues to work — the only change is that the user can no longer manually toggle the mode via the removed radio. The orchestrator sets it directly via `db.setConfig`.

The feature-creation auto-provision at KanbanProvider.ts:10666-10668 also stays — it only fires when `featureWorktreeModeSnapshot === 'per-feature'`, which now only happens under orchestration (or a stale crash state, which the new startup reconciliation clears).

## Out of Scope

- Worktree cleanup / merge-back UX (existing "copy merge prompt" button in Worktrees tab remains unchanged)
- Column-move-triggered provisioning (option (b) from discussion — rejected due to custom-column and move-failure concerns)
- Per-plan worktree linkage (only feature cards are eligible, per decision)
- Multi-feature worktree creation (button disabled for 2+ feature selection)
- Focus-stealing on non-worktree `terminal.show()` call sites (manual single-terminal creation, dispatch reveals — intended behavior, out of scope)
- Removal of the now-dead `setFeatureWorktreeMode` handler (optional cleanup, deferred)

## Implementation Order

1. **Fix `terminal.show()`** (TaskViewerProvider.ts: `reveal` 5th param + gate; KanbanProvider.ts: caller flag updates) — isolated, testable.
2. **Startup stale-mode reconciliation** (KanbanProvider.ts: activation/board-init guard) — closes the crash-recovery hole before the radio is removed.
3. **Remove "Auto Mode" radio block** (kanban.html:10415-10466 — all four elements) — do this AFTER step 2 so the visibility removal doesn't precede its compensating control.
4. **Add "Create Worktree" button** to board toolbar (kanban.html — button + `updateCreateWorktreeButton()` + message construction + state init on render).
5. (Optional) One-time migration to reset stale `per-feature` mode — **omitted** (the startup reconciliation in step 2 supersedes it; it runs every activation and self-heals).

## Verification Plan

### Automated Tests
*Automated tests skipped per session directive. Verification is manual.*

### Manual Verification
- **Auto-provisioning under orchestration:** Select orchestration mode → create a feature → worktree is created, terminals are created but NOT focused (no panel reveal, no focus jump). Switch away from orchestration → mode restores to `none`.
- **Manual provisioning via board button:** Select a feature card → "CREATE WORKTREE" is enabled → click → worktree created with the feature's topic as branch name, terminals created AND focused. Select a non-feature card → button disabled ("Only feature cards can have worktrees"). Select 2+ cards → button disabled ("Select a single feature..."). Select a feature with existing worktree → button disabled ("Feature already has a worktree"). Select nothing (project active) → button creates project worktree. Select nothing (no project) → button creates unbound worktree.
- **Button initial state:** Open the board fresh (no selection) → "CREATE WORKTREE" is enabled at first paint (not stuck disabled until a selection change).
- **Manual provisioning via Worktrees tab:** Existing buttons still work as before; the "Auto Mode" section is gone, no dangling "Auto Mode" heading remains.
- **Crash-recovery (stale mode):** Simulate a crash-during-orchestration: set `feature_worktree_mode='per-feature'` and `orchestration_prior_feature_worktree_mode='none'` directly in the DB, then reload the window. On activation, the reconciliation resets `feature_worktree_mode` to `none` and clears the prior. Creating a feature afterward does NOT auto-provision.
- **No stale auto-mode:** After switching away from orchestration (clean), creating a feature does NOT auto-provision a worktree.

---

**Recommendation:** Complexity 5 (Mixed) → **Send to Coder.**
