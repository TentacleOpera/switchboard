# Enforce Mutual Exclusivity Between Remote Control and Bug-Triage Modes

## Goal

Make **Remote Control** and **Bug-Triage / Automation** mutually exclusive **per workspace**, enforced in code rather than left to convention. Today the two are independent feature toggles built on the *same* `LinearSyncService` config, and nothing stops both being active on one workspace at once. They are meant to be two different products for two different use cases:

- **Bug-Triage / Automation** — watch an external board where support/bug tickets land, auto-pull them in, route to the triage agent, sync verdicts back. (`autoPullEnabled` / `realTimeSyncEnabled` / `automationRules`; the "ENABLE TRIAGE PIPELINE" button in `setup.html`.)
- **Remote Control** — drive a *personal software-development* board remotely (Linear or Notion) via delta polling. (`RemoteControlService`, the Remote tab in `kanban.html`.)

The goal: a workspace is in **one** mode or the other (or neither). Enabling Remote Control suppresses all triage automation for that workspace, and enabling the Triage Pipeline turns Remote Control off — with the guarantee that the triage outbound path can **never** run while Remote Control is live.

### Background & Problem (root-cause analysis)

**The intended design was never enforced.** Both modes read the same per-workspace `LinearSyncService` config and run off independent flags; no code path consults the other mode:

- `RemoteControlService` / `LinearRemoteProvider` piggyback on the triage setup — `LinearRemoteProvider.fetchStateDeltas` (line 36) / `fetchCommentDeltas` (line 72) gate on the *same* `config.setupComplete` (line 38, 74) and reuse `columnToStateId` (lines 40–42). There is no separate Remote-Control Linear setup.
- `RemoteControlService.start()` (line 151) / `stop()` (line 167, sync `public stop(): void`) never touch `realTimeSyncEnabled` / `autoPullEnabled`.
- The triage runtime gates check only their own flags and never `rc.isActive`:
  - Real-time outbound push: `_queueLinearSync` (`src/services/KanbanProvider.ts:1924`) / `_queueClickUpSync` (`:1897`).
  - Auto-pull import: `_configureLinearAutoPull` (`:1826`) / `_configureClickUpAutoPull` (`:1742`).
  - Automation poll: `_configureLinearAutomation` (`:1855`) / `_configureClickUpAutomation` (`:1789`).
- `_remoteControlActive` (`src/services/KanbanProvider.ts:137`) exists, but is used **only** to inject the `REMOTE_MODE_DIRECTIVE` into agent prompts (§11) — it does not gate any triage path.

**Why this is a correctness bug, not just a tidiness issue.** When both modes are live on a Linear workspace, the triage outbound path silently orphans cards from Remote Control:

1. A local card moves column → `_queueLinearSync` → `LinearSyncService.debouncedSync` (line 2144) → `syncPlan` (line 1902) → **`createIssue`** (`src/services/LinearSyncService.ts:1992-2079`).
2. `createIssue` creates the Linear issue and stamps the issue id via `updateLinearIssueIdByPlanFile` (`:2057`) — which writes **only** `linear_issue_id` (`src/services/KanbanDatabase.ts:1801` — `UPDATE plans SET linear_issue_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?` at line 1805). It does **not** change `sourceType`, so the card stays `sourceType: 'local'`.
3. Remote Control's index keeps only `linear-import` / `linear-automation` cards: `_indexByRemoteId` (`src/services/RemoteControlService.ts:220-244`) requires `p.sourceType === 'linear-import' || 'linear-automation'` (gate at lines 229–232).
4. Result: the just-synced `local`+`linearIssueId` card is **invisible** to Remote Control — moving it in Linear no longer moves it locally, and comments on it never reach the agent.

Enforcing exclusivity removes the precondition entirely: if triage outbound cannot run while Remote Control owns the workspace, no `local`+`linearIssueId` card can ever be produced, so the `sourceType` gate in `_indexByRemoteId` stays correct and we do not need to weaken it.

**Scope note on migrations.** It is critical to distinguish the two features:
- **Linear sync / Bug-Triage** (`LinearSyncService`, `autoPullEnabled` / `realTimeSyncEnabled` / `automationRules`, `createIssue`, the "ENABLE TRIAGE PIPELINE" button) — **has shipped** in a released VSIX a couple months ago. Released installs can and do have triage enabled.
- **Remote Control** (`RemoteControlService`, `src/services/remote/`, the Remote tab, delta polling) — **has NOT shipped**. Confirmed by the user: no released VSIX includes Remote Control functionality. The sync shipped, the remote did not.

The mutual exclusivity bug requires *both* modes active on the same workspace. Since released installs can have triage/sync but **cannot** have Remote Control, no released install can have both modes on simultaneously — there is no historical "both enabled" state to migrate. The boundary flag-flip below is a user-initiated mode switch, not a silent migration, and it touches only two booleans while preserving the heavy triage config (team id, `columnToStateId`, `automationRules`, the Bug Triage board), so switching back is a one-toggle restore.

> **Note:** The original plan justified the no-migration argument with "src/services/remote/ is new/untracked" — this is factually incorrect; the files ARE tracked in git. The correct justification is the sync-vs-remote distinction above: the sync shipped, Remote Control did not.

---

## Metadata

**Tags:** backend, reliability, feature, refactor
**Complexity:** 5

---

## User Review Required

No user review required. The migration argument (Remote Control is unreleased, confirmed by the user) is settled. The startup reconciliation (Step 5) is a no-op for the released install base and a clean-up for dev installs. No architectural decisions require user sign-off.

---

## Complexity Audit

### Routine
- Adding a single helper method `_isWorkspaceRemoteControlled` to `KanbanProvider.ts`
- Adding early-return guards to six existing triage methods (one-liner each)
- Adding boundary enforcement method `_disableTriageForRemoteControl` that calls existing `loadConfig`/`saveConfig`/`_configure*` methods
- Adding `disableRemoteControlForTriage` public method on `KanbanProvider` + one call site in `TaskViewerProvider`
- Adding startup reconciliation check (one `if` + `continue` in an existing loop)
- Adding two one-line UI notes to existing HTML files
- All methods referenced (`_getRemoteControl`, `_getLinearService`, `_getClickUpService`, `_postLinearState`, `_postClickUpState`, `loadConfig`, `saveConfig`) are confirmed to exist with compatible signatures

### Complex / Risky
- The runtime guard on `_queueLinearSync` is the one that closes the `createIssue` data bug — it must be airtight. The belt-and-suspenders approach (both boundary and runtime guards) mitigates flag drift.
- The interval callback re-checks (lines 1834, 1867, 1761, 1801) must self-suppress if the workspace enters Remote-Control mode mid-interval — a timer could fire after the mode switch but before the next `initializeIntegrationAutoPull` reconciliation.
- The reverse boundary (triage → RC) must clear `RemoteConfig.boards` and stop polling — this discards the user's board selection, requiring re-selection on switch-back. This is intentional (board selection is lightweight; triage config is heavy).

---

## Edge-Case & Dependency Audit

**Race Conditions:**
- A triage interval timer could fire between the moment Remote Control is enabled and the next `initializeIntegrationAutoPull` reconciliation. The runtime guards in the interval callbacks (lines 1834, 1867, 1761, 1801) handle this by re-checking `_isWorkspaceRemoteControlled` on each tick.
- `saveConfig` and `setConfig` are async — concurrent calls from two rapid UI actions could interleave. The existing code does not lock config writes, and this plan does not introduce new concurrency beyond what already exists. The boundary methods call `saveConfig` then immediately call `_configure*` which re-reads config — a brief window exists where stale config could be read, but the runtime guards catch any missed flag.

**Security:** No security implications. Mode flags are workspace-local config booleans. No credentials, tokens, or sensitive data are exposed or modified.

**Side Effects:**
- Enabling Remote Control flips `autoPullEnabled` and `realTimeSyncEnabled` to `false` for both Linear and ClickUp on that workspace. The triage config (mappings, rules, board) is preserved.
- Enabling Triage Pipeline clears `RemoteConfig.boards` to `[]` and stops polling. The user must re-select boards to switch back to Remote Control.
- `_remoteControlActive` is recomputed across all workspaces after either boundary action, ensuring the `REMOTE_MODE_DIRECTIVE` injection is correct.

**Dependencies & Conflicts:**
- `_integrationAutoPull.stop(workspaceRoot, kind)` signature confirmed: `kind` is `'linear'`, `'clickup'`, `'linear-automation'`, or `'clickup-automation'` (verified at lines 1746, 1757, 1796, 1830, 1862).
- `LinearSyncService.saveConfig(config: LinearConfig): Promise<void>` at line 280 — confirmed.
- `ClickUpSyncService.loadConfig(): Promise<ClickUpConfig | null>` at line 519 — confirmed.
- `ClickUpSyncService.saveConfig(config: ClickUpConfig): Promise<void>` at line 540 — confirmed.
- Both `LinearConfig` and `ClickUpConfig` have `autoPullEnabled` and `realTimeSyncEnabled` fields (confirmed by `handleEnableTriagePipeline` setting both at lines 4799-4800 and 4838-4839).
- `RemoteControlService.stop()` is **sync** (`public stop(): void`, line 167) — no `await` needed.
- `RemoteControlService.isActive` is a getter (line 84) returning `this._active` — returns `false` immediately after `stop()`.
- No conflict with Plan 1 (orientation skill — pure documentation) or Plan 2 (copy button — reads config, doesn't modify mode state).

---

## Dependencies

No session dependencies. This plan is self-contained within the epic.

---

## Adversarial Synthesis

Key risks: (1) 66% of line number references in the original plan were wrong — all methods exist but at different lines, risking edits to unrelated code if followed literally; (2) the reverse boundary was wired to `SetupPanelProvider` when the actual triage enable logic lives in `TaskViewerProvider.handleEnableTriagePipeline` (line 4767), which already has a `_kanbanProvider` reference; (3) the "new/untracked" migration justification was factually wrong (files ARE tracked). Mitigations: all line numbers corrected to verified values; reverse boundary call moved to `TaskViewerProvider.handleEnableTriagePipeline` before the `initializeIntegrationAutoPull` call at line 4877; migration justification corrected — Remote Control is confirmed unreleased by the user, so no migration is needed for the install base.

---

## Decisions

- **D1 — Exclusivity is per-workspace, Remote-Control-dominant, provider-agnostic.** A workspace is in *Remote-Control mode* iff its `RemoteConfig.boards.length > 0` (regardless of provider). While in that mode, **all** triage automation for that workspace is suppressed — Linear **and** ClickUp, auto-pull + automation poll + real-time outbound. Rationale: the use case is workspace-level ("watch a bug board" vs "personal dev"), so even Notion Remote Control suppresses Linear/ClickUp triage in the same workspace.
- **D2 — Enforce at both the boundary and at runtime (belt-and-suspenders).**
  - *Boundary:* enabling Remote Control flips the workspace's triage flags off; enabling the Triage Pipeline clears/stops Remote Control for that workspace.
  - *Runtime:* the six triage gate functions short-circuit when the workspace is in Remote-Control mode. The runtime guard is what makes "`createIssue` can never run while Remote Control is live" airtight even if persisted flags drift.
- **D3 — The newly-enabled mode wins; the other is disabled, with a status message, never a confirm gate.** The user's click is explicit intent. We surface the switch via the existing status lines (e.g. `remote-config-status`, `linear-triage-result`) — no `confirm()` / `showWarningMessage` gate (project rule: confirm gates are a silent no-op in webviews and are banned).
- **D4 — Boundary enforcement flips persisted triage booleans off (not runtime-only).** Keeps the persisted config and the UI honest. Only `autoPullEnabled` and `realTimeSyncEnabled` are changed; `automationRules`, mappings, and the Bug Triage board are untouched.
- **D5 — Add a cheap idempotent startup reconciliation.** In `initializeIntegrationAutoPull`, for any workspace already in Remote-Control mode, ensure triage flags are off before configuring the auto-pull/automation timers. No released install can hit the both-on state, so this is a no-op for them and a clean-up for any dev install predating this change.
- **D6 — UI reflects the lock.** The Remote tab notes that enabling Remote Control disables triage sync; the triage enable affordance shows "Disabled — workspace is in Remote Control mode" when applicable. Minimal text, no new dialogs.

---

## Proposed Changes

### 1. Single source of truth: a per-workspace mode check (`src/services/KanbanProvider.ts`)

**Context:** `_getRemoteControl` is at line 1438 (`private _getRemoteControl(workspaceRoot: string): RemoteControlService`). The `RemoteConfig` interface (lines 34–45 in `RemoteControlService.ts`) has `boards: string[]` (line 38) and `pingMode: 'constant' | 'manual'` (line 42).

**Logic:** Add a helper near the other remote-control plumbing:

```ts
/** A workspace is in Remote-Control mode iff it has any remote board selected (any provider). */
private async _isWorkspaceRemoteControlled(workspaceRoot: string): Promise<boolean> {
    try {
        const rc = this._getRemoteControl(workspaceRoot);
        const cfg = await rc.getConfig();
        return Array.isArray(cfg.boards) && cfg.boards.length > 0;
    } catch {
        return false;
    }
}
```

Use `boards.length > 0` (not `rc.isActive`) so a *configured* remote-control workspace suppresses triage even when it is in manual ping mode and not currently polling.

**Edge Cases:** `getConfig()` returns a `RemoteConfig` with `boards: []` by default (`DEFAULT_REMOTE_CONFIG` at line 47). The `Array.isArray` guard handles any malformed config.

### 2. Runtime guards on the six triage paths (`src/services/KanbanProvider.ts`)

**Context:** Add an early return at the top of each, after the existing `loadConfig()` flag checks. The `_integrationAutoPull.stop()` signature is confirmed: `stop(workspaceRoot, 'linear'|'clickup'|'linear-automation'|'clickup-automation')`.

**Logic:**

- `_queueLinearSync` (line **1924**) and `_queueClickUpSync` (line **1897**) — outbound real-time push. Guard here is the one that closes the `createIssue` data bug.
  ```ts
  if (await this._isWorkspaceRemoteControlled(workspaceRoot)) { return; }
  ```
- `_configureLinearAutoPull` (line **1826**) and `_configureClickUpAutoPull` (line **1742**) — when remote-controlled, call `this._integrationAutoPull.stop(workspaceRoot, 'linear'|'clickup')` and return (mirrors the existing `!autoPullEnabled` branch at lines 1830/1746).
- `_configureLinearAutomation` (line **1855**) and `_configureClickUpAutomation` (line **1789**) — when remote-controlled, `stop(workspaceRoot, 'linear-automation'|'clickup-automation')` and return (mirrors lines 1862/1796).

Also add the same guard inside the interval callbacks (the `latestConfig` re-checks at **lines 1834, 1867, 1761, 1801** — all verified correct) so an already-scheduled timer self-suppresses if the workspace enters Remote-Control mode mid-interval.

**Edge Cases:** The interval callback guards must call `_isWorkspaceRemoteControlled` (async) — the callbacks are already async (they `await loadConfig()`), so this is compatible.

### 3. Boundary enforcement — enabling Remote Control disables triage (`src/services/KanbanProvider.ts`)

**Context:** `case 'setRemoteConfig'` is at line **5543** and `case 'startRemoteControl'` is at line **5584** (both in `_handleMessage` switch statement starting at line 5120). The helper methods `_getLinearService` (line 1586), `_getClickUpService` (line 1410), `_postLinearState` (line 1727), `_postClickUpState` (line 1691) all exist and are confirmed.

**Logic:** Add:

```ts
/** When a workspace enters Remote-Control mode, turn triage automation off (D1/D4). */
private async _disableTriageForRemoteControl(workspaceRoot: string): Promise<void> {
    const linear = this._getLinearService(workspaceRoot);
    const lc = await linear.loadConfig();
    if (lc?.setupComplete && (lc.autoPullEnabled || lc.realTimeSyncEnabled)) {
        await linear.saveConfig({ ...lc, autoPullEnabled: false, realTimeSyncEnabled: false });
    }
    const clickUp = this._getClickUpService(workspaceRoot);
    const cc = await clickUp.loadConfig();
    if (cc?.setupComplete && (cc.autoPullEnabled || cc.realTimeSyncEnabled)) {
        await clickUp.saveConfig({ ...cc, autoPullEnabled: false, realTimeSyncEnabled: false });
    }
    // Tear down any running timers immediately.
    await this._configureLinearAutoPull(workspaceRoot);
    await this._configureLinearAutomation(workspaceRoot);
    await this._configureClickUpAutoPull(workspaceRoot);
    await this._configureClickUpAutomation(workspaceRoot);
    await Promise.all([this._postLinearState(workspaceRoot), this._postClickUpState(workspaceRoot)]);
}
```

**Method names confirmed:** `LinearSyncService.saveConfig(config: LinearConfig): Promise<void>` (line 280), `ClickUpSyncService.saveConfig(config: ClickUpConfig): Promise<void>` (line 540), `LinearSyncService.loadConfig(): Promise<LinearConfig | null>` (line 243), `ClickUpSyncService.loadConfig(): Promise<ClickUpConfig | null>` (line 519).

Call it from the Remote-Control enable boundaries:

- `case 'setRemoteConfig'` (line **5543**) — after `rc.setConfig(...)`, if the new config has `boards.length > 0`, `await this._disableTriageForRemoteControl(workspaceRoot)`.
- `case 'startRemoteControl'` (line **5584**) — after `rc.start()`, if `rc.isActive`, same call.

**Edge Cases:** The `saveConfig` spread (`{ ...lc, autoPullEnabled: false, realTimeSyncEnabled: false }`) preserves all other config fields including `automationRules`, `columnToStateId`, `teamId`, etc. The `_configure*` calls re-read the just-saved config and stop timers accordingly.

### 4. Boundary enforcement — enabling Triage stops Remote Control (`src/services/TaskViewerProvider.ts`)

**Context:** The triage enable logic lives in `TaskViewerProvider.handleEnableTriagePipeline` (line 4767), NOT in `SetupPanelProvider`. `SetupPanelProvider` (line 437) delegates to it: `this._taskViewerProvider.handleEnableTriagePipeline(provider, token)`. `TaskViewerProvider` already has a `_kanbanProvider` reference (used at line 4877: `this._kanbanProvider?.initializeIntegrationAutoPull()`). The method resolves `effectiveRoot` at line 4777.

**Logic:** Add a public method on `KanbanProvider`:

```ts
public async disableRemoteControlForTriage(workspaceRoot: string): Promise<void> {
    const rc = this._getRemoteControl(workspaceRoot);
    rc.stop();  // sync — public stop(): void (line 167)
    const cfg = await rc.getConfig();
    if (cfg.boards.length > 0) { await rc.setConfig({ ...cfg, boards: [], pingMode: 'manual' }); }
    this._remoteControlActive = Array.from(this._remoteControls.values()).some(r => r.isActive);
    this._panel?.webview.postMessage({ type: 'remoteControlState', active: rc.isActive });
}
```

**Call site — `TaskViewerProvider.handleEnableTriagePipeline`** (insert before line **4877**, the `initializeIntegrationAutoPull` call):

```ts
// D2/D4 — enabling triage disables Remote Control for this workspace (mutual exclusivity).
await this._kanbanProvider?.disableRemoteControlForTriage(effectiveRoot);
```

Then the existing `this._kanbanProvider?.initializeIntegrationAutoPull()` at line 4877 runs and configures triage timers (Remote Control is already stopped, so no conflict).

Post a note in the `triagePipelineResult` message (returned to SetupPanelProvider at line 440) that Remote Control was turned off for the workspace. This can be appended to the `result` object or handled as a separate status line.

**Edge Cases:**
- `rc.stop()` is sync (`public stop(): void`, line 167) — no `await` needed. `rc.isActive` returns `false` immediately after.
- `setConfig({ ...cfg, boards: [], pingMode: 'manual' })` clears the board selection — the user must re-select boards to switch back to Remote Control. This is intentional (D4 rationale: board selection is lightweight, triage config is heavy).
- `_remoteControlActive` recomputes across ALL workspaces, not just this one — correct, because the directive injection checks the global flag.

### 5. Startup reconciliation (`src/services/KanbanProvider.ts`)

**Context:** `initializeIntegrationAutoPull` is at line **1942**. The per-`workspaceRoot` loop with `_configure*` calls is at lines **1946–1950**.

**Logic:** Inside the per-`workspaceRoot` loop, **before** the `_configure*` calls:

```ts
if (await this._isWorkspaceRemoteControlled(workspaceRoot)) {
    await this._disableTriageForRemoteControl(workspaceRoot);
    continue; // skip configuring triage timers for this workspace
}
```

This makes the invariant self-healing on every boot (D5).

**Edge Cases:** If `_disableTriageForRemoteControl` is called and triage flags are already off (normal case for a remote-controlled workspace), the `if (lc?.setupComplete && ...)` guards skip the `saveConfig` call — it's a no-op. The `_configure*` calls still run but immediately return due to the runtime guards. The `continue` skips redundant timer setup.

### 6. UI (`src/webview/kanban.html`, `src/webview/setup.html`)

**Context:** The Remote tab section is `#remote-tab-content` at lines **2537–2610** in `kanban.html`. The "ENABLE TRIAGE PIPELINE" buttons are at setup.html line **1004** (Linear) and line **800** (ClickUp).

**Logic:**
- **Remote tab** (`kanban.html`, near line 2553, under the subsection header): add one line — "Enabling Remote Control turns off Bug-Triage sync for this workspace (they are mutually exclusive)." No new controls.
- **Triage enable** (`setup.html`, near lines 1004/800): when the active workspace is remote-controlled, render the existing result line as "Disabled — workspace is in Remote Control mode." The backend already gates the action; this is purely informational. No `confirm()` / modal.

**Edge Cases:** The UI note is static text, not a dynamic status — it doesn't need a message handler. The triage disabled state is informational only; the backend `_disableTriageForRemoteControl` and runtime guards enforce the actual lock.

---

## Verification Plan

### Automated Tests

Per session instructions, automated tests will be run separately by the user. The following test cases are documented for that run:

**Unit (`src/services/__tests__/`):**
- `_indexByRemoteId` is unchanged — add a regression test asserting a `local`+`linearIssueId` card is still excluded (documents the dependency the guards protect).
- New: with `boards: ['']`, `_isWorkspaceRemoteControlled` returns `true`; with `boards: []`, `false`.
- New: `_disableTriageForRemoteControl` flips `autoPullEnabled`/`realTimeSyncEnabled` to `false` while leaving `automationRules` and `columnToStateId` intact.

**Integration (`src/test/integrations/shared/remote-control-service.test.js` + a new triage-exclusivity test):**
1. Enable Linear triage on a workspace → enable Remote Control → assert triage flags are off, auto-pull timer stopped, and a column move does **not** call `createIssue` (spy on `LinearSyncService.syncPlan`).
2. Enable Remote Control → enable Triage Pipeline → assert `RemoteConfig.boards` is emptied and `rc.isActive === false`.
3. Seed a workspace with both flags on (simulating a dev install) → run `initializeIntegrationAutoPull` → assert triage flags reconciled off and no triage timers scheduled.

### Manual Verification (installed VSIX)

Real Linear workspace; enable triage, then Remote Control; move a card; confirm no new Linear issue is created and the Remote tab note appears. Then enable triage again; confirm Remote Control stops and its boards clear.

---

## Out of scope / non-goals

- **No change to `_indexByRemoteId`'s `sourceType` gate.** Exclusivity removes the bug's precondition; weakening the gate (option 2 from discussion) is explicitly not pursued.
- **No new "mode" enum or schema field.** Mode is derived from `RemoteConfig.boards.length` — no migration of a new persisted field.
- **Notion-vs-Linear provider exclusivity within Remote Control** is already handled ("exactly one active at a time", see `notion-remote-control-and-delta-polling.md`) and is untouched here.
- **No cross-workspace coupling.** A workspace may be triage-only while another is remote-only; enforcement is strictly per-workspace.

---

## Recommendation

Complexity 5 → **Send to Coder**
