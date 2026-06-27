# Enforce Mutual Exclusivity Between Remote Control and Bug-Triage Modes

## Goal

Make **Remote Control** and **Bug-Triage / Automation** mutually exclusive **per workspace**, enforced in code rather than left to convention. Today the two are independent feature toggles built on the *same* `LinearSyncService` config, and nothing stops both being active on one workspace at once. They are meant to be two different products for two different use cases:

- **Bug-Triage / Automation** — watch an external board where support/bug tickets land, auto-pull them in, route to the triage agent, sync verdicts back. (`autoPullEnabled` / `realTimeSyncEnabled` / `automationRules`; the "ENABLE TRIAGE PIPELINE" button in `setup.html`.)
- **Remote Control** — drive a *personal software-development* board remotely (Linear or Notion) via delta polling. (`RemoteControlService`, the Remote tab in `kanban.html`.)

The goal: a workspace is in **one** mode or the other (or neither). Enabling Remote Control suppresses all triage automation for that workspace, and enabling the Triage Pipeline turns Remote Control off — with the guarantee that the triage outbound path can **never** run while Remote Control is live.

### Background & Problem (root-cause analysis)

**The intended design was never enforced.** Both modes read the same per-workspace `LinearSyncService` config and run off independent flags; no code path consults the other mode:

- `RemoteControlService` / `LinearRemoteProvider` piggyback on the triage setup — `LinearRemoteProvider.fetchStateDeltas/fetchCommentDeltas` gate on the *same* `config.setupComplete` and reuse `columnToStateId` (`src/services/remote/LinearRemoteProvider.ts:28-33, 65-66`). There is no separate Remote-Control Linear setup.
- `RemoteControlService.start()/stop()` (`src/services/RemoteControlService.ts:150-171`) never touch `realTimeSyncEnabled` / `autoPullEnabled`.
- The triage runtime gates check only their own flags and never `rc.isActive`:
  - Real-time outbound push: `_queueLinearSync` / `_queueClickUpSync` (`src/services/KanbanProvider.ts:1917-1933`, `:1890-1915`).
  - Auto-pull import: `_configureLinearAutoPull` / `_configureClickUpAutoPull` (`:1819-1846`, `:1735-1780`).
  - Automation poll: `_configureLinearAutomation` / `_configureClickUpAutomation` (`:1848-1883`, `:1782-1817`).
- `_remoteControlActive` (`src/services/KanbanProvider.ts:137`) exists, but is used **only** to inject the `REMOTE_MODE_DIRECTIVE` into agent prompts (§11) — it does not gate any triage path.

**Why this is a correctness bug, not just a tidiness issue.** When both modes are live on a Linear workspace, the triage outbound path silently orphans cards from Remote Control:

1. A local card moves column → `_queueLinearSync` → `LinearSyncService.debouncedSync` → `syncPlan` → **`createIssue`** (`src/services/LinearSyncService.ts:1992-2076`).
2. `createIssue` creates the Linear issue and stamps the issue id via `updateLinearIssueIdByPlanFile` (`:2057`) — which writes **only** `linear_issue_id` (`src/services/KanbanDatabase.ts:1799` — `UPDATE plans SET linear_issue_id = ...`). It does **not** change `sourceType`, so the card stays `sourceType: 'local'`.
3. Remote Control's index keeps only `linear-import` / `linear-automation` cards: `_indexByRemoteId` (`src/services/RemoteControlService.ts:229-232`) requires `p.sourceType === 'linear-import' || 'linear-automation'`.
4. Result: the just-synced `local`+`linearIssueId` card is **invisible** to Remote Control — moving it in Linear no longer moves it locally, and comments on it never reach the agent.

Enforcing exclusivity removes the precondition entirely: if triage outbound cannot run while Remote Control owns the workspace, no `local`+`linearIssueId` card can ever be produced, so the `sourceType` gate in `_indexByRemoteId` stays correct and we do not need to weaken it.

**Scope note on migrations.** Remote Control is **unreleased dev work** (`src/services/remote/` is new/untracked; the `notion-remote-control-*` plans are in progress). Bug-Triage (`autoPullEnabled` / `realTimeSyncEnabled` / `automationRules`) **has shipped**. Therefore no released install can currently have *both* modes on — there is no historical "both enabled" state to migrate. The boundary flag-flip below is a user-initiated mode switch, not a silent migration, and it touches only two booleans while preserving the heavy triage config (team id, `columnToStateId`, `automationRules`, the Bug Triage board), so switching back is a one-toggle restore.

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

## Implementation

### 1. Single source of truth: a per-workspace mode check (`src/services/KanbanProvider.ts`)

Add a small helper near the other remote-control plumbing (`_getRemoteControl` is at `:1438`):

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

### 2. Runtime guards on the six triage paths (`src/services/KanbanProvider.ts`)

Add an early return at the top of each, after the existing `loadConfig()` flag checks:

- `_queueLinearSync` (`:1917`) and `_queueClickUpSync` (`:1890`) — outbound real-time push. Guard here is the one that closes the `createIssue` data bug.
- `_configureLinearAutoPull` (`:1819`) and `_configureClickUpAutoPull` (`:1735`) — when remote-controlled, call `this._integrationAutoPull.stop(workspaceRoot, 'linear'|'clickup')` and return (mirrors the existing `!autoPullEnabled` branch).
- `_configureLinearAutomation` (`:1848`) and `_configureClickUpAutomation` (`:1782`) — when remote-controlled, `stop(workspaceRoot, 'linear-automation'|'clickup-automation')` and return.

Example for `_queueLinearSync`:

```ts
if (await this._isWorkspaceRemoteControlled(workspaceRoot)) { return; }
```

Also add the same guard inside the interval callbacks (the `latestConfig` re-checks at `:1834`, `:1867`, `:1761`, `:1801`) so an already-scheduled timer self-suppresses if the workspace enters Remote-Control mode mid-interval.

### 3. Boundary enforcement — enabling Remote Control disables triage (`src/services/KanbanProvider.ts`)

Add:

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

(Confirm the exact `saveConfig`/persist method names on `LinearSyncService` / `ClickUpSyncService` during implementation; reuse whatever the triage UI already calls.)

Call it from the Remote-Control enable boundaries:

- `case 'setRemoteConfig'` (`:5430`) — after `rc.setConfig(...)`, if the new config has `boards.length > 0`, `await this._disableTriageForRemoteControl(workspaceRoot)`.
- `case 'startRemoteControl'` (`:5471`) — after `rc.start()`, if `rc.isActive`, same call.

### 4. Boundary enforcement — enabling Triage stops Remote Control (`src/services/SetupPanelProvider.ts`)

In `case 'enableTriagePipeline'` (`:435`), before/after enabling the pipeline, clear Remote Control for that workspace so the reverse switch is symmetric. Because `SetupPanelProvider` does not own the `_remoteControls` map, route this through `KanbanProvider` (the owner). Add a public method on `KanbanProvider`:

```ts
public async disableRemoteControlForTriage(workspaceRoot: string): Promise<void> {
    const rc = this._getRemoteControl(workspaceRoot);
    rc.stop();
    const cfg = await rc.getConfig();
    if (cfg.boards.length > 0) { await rc.setConfig({ ...cfg, boards: [], pingMode: 'manual' }); }
    this._remoteControlActive = Array.from(this._remoteControls.values()).some(r => r.isActive);
    this._panel?.webview.postMessage({ type: 'remoteControlState', active: rc.isActive });
}
```

Wire `SetupPanelProvider` to invoke it (constructor dependency or an existing event bridge — match how SetupPanelProvider already reaches KanbanProvider). Then post `triagePipelineResult` with a note that Remote Control was turned off for the workspace.

### 5. Startup reconciliation (`src/services/KanbanProvider.ts`)

In `initializeIntegrationAutoPull` (`:1935`), inside the per-`workspaceRoot` loop and **before** the `_configure*` calls at `:1940-1943`:

```ts
if (await this._isWorkspaceRemoteControlled(workspaceRoot)) {
    await this._disableTriageForRemoteControl(workspaceRoot);
    continue; // skip configuring triage timers for this workspace
}
```

This makes the invariant self-healing on every boot (D5).

### 6. UI (`src/webview/kanban.html`, `src/webview/setup.html`)

- **Remote tab** (`kanban.html`, the §10 config block near `:2545`): add one line under the subsection header — "Enabling Remote Control turns off Bug-Triage sync for this workspace (they are mutually exclusive)." No new controls.
- **Triage enable** (`setup.html`, the Linear/ClickUp "ENABLE TRIAGE PIPELINE" blocks near `:1004` / `:800`): when the active workspace is remote-controlled, render the existing result line as "Disabled — workspace is in Remote Control mode." The backend already gates the action; this is purely informational. No `confirm()` / modal.

---

## Testing

- **Unit (`src/services/__tests__/`):**
  - `_indexByRemoteId` is unchanged — add a regression test asserting a `local`+`linearIssueId` card is still excluded (documents the dependency the guards protect).
  - New: with `boards: ['']`, `_isWorkspaceRemoteControlled` returns `true`; with `boards: []`, `false`.
  - New: `_disableTriageForRemoteControl` flips `autoPullEnabled`/`realTimeSyncEnabled` to `false` while leaving `automationRules` and `columnToStateId` intact.
- **Integration (`src/test/integrations/shared/remote-control-service.test.js` + a new triage-exclusivity test):**
  1. Enable Linear triage on a workspace → enable Remote Control → assert triage flags are off, auto-pull timer stopped, and a column move does **not** call `createIssue` (spy on `LinearSyncService.syncPlan`).
  2. Enable Remote Control → enable Triage Pipeline → assert `RemoteConfig.boards` is emptied and `rc.isActive === false`.
  3. Seed a workspace with both flags on (simulating a dev install) → run `initializeIntegrationAutoPull` → assert triage flags reconciled off and no triage timers scheduled.
- **Manual (installed VSIX):** real Linear workspace; enable triage, then Remote Control; move a card; confirm no new Linear issue is created and the Remote tab note appears. Then enable triage again; confirm Remote Control stops and its boards clear.

---

## Out of scope / non-goals

- **No change to `_indexByRemoteId`'s `sourceType` gate.** Exclusivity removes the bug's precondition; weakening the gate (option 2 from discussion) is explicitly not pursued.
- **No new "mode" enum or schema field.** Mode is derived from `RemoteConfig.boards.length` — no migration of a new persisted field.
- **Notion-vs-Linear provider exclusivity within Remote Control** is already handled ("exactly one active at a time", see `notion-remote-control-and-delta-polling.md`) and is untouched here.
- **No cross-workspace coupling.** A workspace may be triage-only while another is remote-only; enforcement is strictly per-workspace.

**Complexity: 5/10** — well-localized (two services + two webview notes + tests), no architectural change, the only subtlety is enforcing at both boundary and runtime and getting the per-workspace check right.
