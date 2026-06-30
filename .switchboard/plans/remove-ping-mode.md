# Remove Ping Mode (Constant / Manual Radio)

## Goal

Delete the `pingMode: 'constant' | 'manual'` concept entirely. The remote poll loop runs when the toolbar toggle is on and stops when it's off — that's the only meaningful behaviour. Constant mode auto-starts on VS Code load, but VS Code is always an attended environment, so this is just manual mode where the user forgot to press a button while burning API calls indefinitely. The radio adds UI noise with no real decision to make.

### Core problem

The ping mode radio was designed for a "phone at lunch" scenario where constant mode would keep the loop running unattended. But the extension only runs inside VS Code — there is no unattended context. Every user who picks constant mode is paying for continuous polling even when they have nothing open to remote-control. Manual mode is always correct; constant mode is always wrong.

### Root-cause analysis

`pingMode` threads through four surfaces: the `RemoteConfig` interface, the persisted DB blob (`remote.config`), the webview radio, and the `restoreFromConfig()` auto-start path. The constant branch is the ONLY consumer of `restoreFromConfig()` — once it's gone, that method and its sole caller (the `webviewReady` handler in `KanbanProvider.ts`) become dead code. The manual branch's only behavioural quirk — the reconciling poll gated on `pingMode === 'manual' && !silentSync` — is correct behaviour for ANY start with silent sync off, so the guard collapses to `!config.silentSync` and the poll runs unconditionally. No logic is lost; only a redundant decision axis is removed.

### What changes

- `pingMode` is removed from `RemoteConfig`, `DEFAULT_REMOTE_CONFIG`, `getConfig()`, `setConfig()`, and `start()` in `RemoteControlService.ts`.
- `restoreFromConfig()` is deleted entirely, along with its sole caller block in `KanbanProvider.ts` (the `webviewReady` "§10 Constant-mode auto-starts on load" block). `_remoteControlActive` defaults to `false` on load, which is correct — the toolbar toggle is the only start trigger.
- The reconciling poll on `start()` (`_poll()` before the loop begins) is kept unconditionally — it was previously gated to manual mode only, but it is correct behaviour regardless: if silent sync is off, the board may have drifted while pinging was off, so reconcile first.
- The ping mode radio (`<div>` with `name="remote-ping-mode"` radios) is removed from `kanban.html`.
- `remoteCollectConfig()` and `renderRemoteConfig()` drop the `pingMode` field.

### Migration

Existing users who saved `pingMode: 'constant'` in their DB will have that field ignored on next read — `getConfig()` simply won't parse or return it. No migration script needed: the field becomes inert junk in the stored JSON and the rest of the contract (`boards`, `silentSync`, `pingFrequencySeconds`, `provider`) is unaffected. On first save from the UI the field disappears from the stored blob. This is a valid soft migration per the project's "preserve unknown/legacy keys" rule — the stored blob is not rewritten or truncated on read, the legacy key simply stops being round-tripped.

Plan 3/3 of the Remote Sync Refactor explicitly preserves `pingMode` in its migration contract (6 references: lines 13, 88, 90, 137, 145, 152). That contract must be updated to drop `pingMode` — plan 3/3's migration must NOT write `pingMode` into the new unified contract. Plan 3/3 is unreleased dev work (part of the remote-sync-refactor epic, not yet coded), so this is a clean documentation edit, not a shipped-state migration.

## Metadata

- **Tags:** [frontend, backend, refactor, ui]
- **Complexity:** 3

## User Review Required

Yes — confirm the product decision that constant/auto-start polling has no legitimate use case in an attended VS Code environment. This plan narrows shipped product behaviour (removes a user-facing config axis). If any user relies on constant mode to keep a board mirrored while they step away but leave VS Code open, that workflow is removed. The plan author judges this an anti-pattern (unbounded API burn with no attended action), but the call is yours.

## Complexity Audit

### Routine
- Delete `pingMode` field from `RemoteConfig` interface, `DEFAULT_REMOTE_CONFIG`, `getConfig()` return object, `setConfig()` normalized object — mechanical edits in one file.
- Delete the ping mode radio `<div>` from `kanban.html` markup.
- Delete the two `pingMode` lines in `renderRemoteConfig()` and the `modeEl`/`pingMode` lines in `remoteCollectConfig()` — mechanical JS edits.
- Collapse the `start()` guard from `config.pingMode === 'manual' && !config.silentSync` to `!config.silentSync` — one-line condition simplification.
- Drop `mode=${config.pingMode}` from the `start()` log line.

### Complex / Risky
- Deleting `restoreFromConfig()` requires also removing its caller block in `KanbanProvider.ts:5152-5164` (the `webviewReady` "§10 Constant-mode auto-starts" block). The plan originally listed only two files; this is a third. Removing the method without removing the caller would break compilation. Leaving the caller with a no-op method leaves dead code + a misleading comment. Cleanest: remove both.
- Coordinating with Plan 3/3 (Remote Sync Refactor) — its migration contract still references `pingMode` in 6 places and must be updated, or a future implementer will re-introduce the field.

## Edge-Case & Dependency Audit

**Race Conditions**
- None introduced. The `start()` reconciling poll runs before `_active = true` and before `_scheduleTimer`, identical ordering to today's manual path. The `_polling` re-entrancy guard already serialises overlapping cycles.
- `setConfig()` reschedule: original code called `await this.start()` for constant mode (which itself schedules a timer). New code calls `_scheduleTimer` directly when `_active`. No double-schedule risk — `_scheduleTimer` clears any existing timer first.

**Security**
- None. Removing a config field does not change auth, token handling, or provider request shape.

**Side Effects**
- Stored `remote.config` blobs in the field retain a stale `pingMode` key until next UI save. Inert — `getConfig()` stops reading it. No blob rewrite on read.
- Users currently running constant mode will, after this change + reload, find their poll loop OFF on next VS Code launch (toolbar toggle inactive). This is the intended behaviour change but is user-visible. Flagged in User Review Required.
- `_remoteControlActive` initialisation: with the `webviewReady` caller block removed, `_remoteControlActive` stays `false` until the user hits the toolbar toggle. The 11 other assignment sites (toggle on/off handlers) are unaffected.

**Dependencies & Conflicts**
- Plan 3/3 (`remote-sync-refactor-3-config-consolidation-and-remote-tab-ux.md`) — documentation dependency. Its migration contract must drop `pingMode` before or alongside implementation, or the field gets re-introduced into the unified contract.
- No dependency on Plan 1/3 or 2/3 (provider capabilities, Notion push pipeline) — those don't touch `pingMode`.

## Dependencies

- `.switchboard/plans/remote-sync-refactor-3-config-consolidation-and-remote-tab-ux.md` — drop `pingMode` from the unified config contract (lines 13, 88, 90, 137, 145, 152). Unreleased dev work; clean break.

## Adversarial Synthesis

Key risks: (1) the plan originally missed the `restoreFromConfig()` caller in `KanbanProvider.ts`, which would break compilation if the method were deleted without removing the caller — now addressed by deleting both; (2) Plan 3/3's migration contract still encodes `pingMode` in 6 places and will re-introduce the field if not updated; (3) constant-mode users lose auto-start on reload — intended, but user-visible. Mitigations: three-file deletion coordinated in one change; Plan 3/3 doc edit listed as an explicit dependency; product-scope narrowing surfaced in User Review Required.

## Proposed Changes

### `src/services/RemoteControlService.ts`

**`RemoteConfig` interface (`:34–45`)** — remove `pingMode`:
```ts
export interface RemoteConfig {
    provider: RemoteProviderKind;
    boards: string[];
    silentSync: boolean;
    pingFrequencySeconds: number;
}
```
Also remove the `/** Constant = always pinging; Manual = only while the toolbar toggle is on. */` JSDoc line (`:41`).

**`DEFAULT_REMOTE_CONFIG` (`:47–53`)** — remove `pingMode: 'manual'`:
```ts
export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
    provider: 'linear',
    boards: [],
    silentSync: false,
    pingFrequencySeconds: 60
};
```

**`getConfig()` (`:92–109`)** — remove `pingMode: parsed.pingMode === 'constant' ? 'constant' : 'manual'` from the returned object (`:103`).

**`setConfig()` (`:111–129`)** — remove `pingMode` from `normalized` (`:118`); replace the `if/else if` block (`:122–128`) with a single unconditional reschedule if active:
```ts
await db.setConfig(REMOTE_CONFIG_KEY, JSON.stringify(normalized));
if (this._active) {
    this._scheduleTimer(normalized.pingFrequencySeconds);
}
```
Also remove the `// Constant mode keeps the ping loop running whenever configured.` comment (`:122`).

**`start()` (`:151–164`)** — remove the `if (config.pingMode === 'manual' && !config.silentSync)` guard; always run the reconciling poll when silent sync is off; drop `mode=...` from the log:
```ts
public async start(): Promise<void> {
    const config = await this.getConfig();
    if (config.boards.length === 0) {
        this._log('No boards selected — not starting.');
        return;
    }
    if (!config.silentSync) {
        this._log('Silent sync off — running a reconciling poll before starting loop.');
        await this._poll(); // one-time reconcile before the loop
    }
    this._active = true;
    this._scheduleTimer(config.pingFrequencySeconds);
    this._log(`Started (provider=${config.provider}, every ${config.pingFrequencySeconds}s, ${config.boards.length} board(s)).`);
}
```
Also update the method JSDoc (`:150`) — drop "In Manual mode with silentSync off, run a reconciling sync first." → "If silentSync is off, run a reconciling sync first."

**`restoreFromConfig()` (`:182–188`)** — delete the method entirely (and its JSDoc `:182`). Its sole caller is removed in `KanbanProvider.ts` below.

### `src/services/KanbanProvider.ts`

**`webviewReady` handler — constant-mode auto-start block (`:5152–5164`)** — delete the entire block:
```ts
// §10 — Constant-mode remote control auto-starts on load.
{
    const rcRoot = this._resolveWorkspaceRoot(undefined);
    if (rcRoot) {
        try {
            const rc = this._getRemoteControl(rcRoot);
            await rc.restoreFromConfig();
            this._remoteControlActive = rc.isActive;
        } catch (e) {
            this._outputChannel?.appendLine(`[RemoteControl] restore failed: ${e}`);
        }
    }
}
```
With `restoreFromConfig()` gone, this block is dead. `_remoteControlActive` keeps its `false` default (`:145`); the toolbar toggle is the only start trigger. The 11 other `_remoteControlActive` assignment sites (toggle handlers at `:5572`, `:5614`, `:5617`, `:5620`, `:5631`, `:5634`, `:5637`) are unchanged.

### `src/webview/kanban.html`

**Ping mode radio group (`:2647–2658`)** — delete the entire `<div>` block:
```html
<!-- Ping mode: radio group -->
<div style="margin-bottom:10px;">
    <span style="display:block; margin-bottom:4px; font-size:11px; color:var(--text-secondary);">Ping mode</span>
    <label class="remote-radio-row">
        <input type="radio" name="remote-ping-mode" value="manual" checked>
        <span>Manual — ping only while the toolbar toggle is on</span>
    </label>
    <label class="remote-radio-row">
        <input type="radio" name="remote-ping-mode" value="constant">
        <span>Constant — always pinging when configured</span>
    </label>
</div>
```

**`renderRemoteConfig()` (`:7052–7054`)** — remove the three lines that read `config.pingMode` and set the radio:
```js
const mode = config.pingMode === 'constant' ? 'constant' : 'manual';
const radio = document.querySelector(`input[name="remote-ping-mode"][value="${mode}"]`);
if (radio) radio.checked = true;
```

**`remoteCollectConfig()` (`:7065`, `:7071`)** — remove the `modeEl` variable (`:7065`) and the `pingMode` key from the returned object (`:7071`):
```js
function remoteCollectConfig() {
    const boards = Array.from(
        document.querySelectorAll('#remote-boards-list input[data-role="remote-board"]:checked')
    ).map(cb => cb.value);   // keeps '' — do NOT filter by truthiness
    const providerEl = document.getElementById('remote-provider');
    return {
        provider: providerEl && providerEl.value === 'notion' ? 'notion' : 'linear',
        boards,
        silentSync: document.getElementById('remote-silent-sync')?.checked === true,
        pingFrequencySeconds: Math.min(120, Math.max(30,
            parseInt(document.getElementById('remote-ping-frequency')?.value, 10) || 60)),
    };
}
```

### `.switchboard/plans/remote-sync-refactor-3-config-consolidation-and-remote-tab-ux.md`

**Migration contract (`:13`, `:88`, `:90`, `:137`, `:145`, `:152`)** — drop `pingMode` from the unified config shape and the default contract. The new shape becomes `{ provider, boards, silentSync, pingFrequencySeconds, mode, push, comments }` (no `pingMode`). The default contract (`:152`) becomes `{ provider: 'linear', boards: [], silentSync: false, pingFrequencySeconds: 60, mode: 'ingest', push: false, comments: true }`. The old-config read at `:137`/`:145` keeps `provider`, `boards`, `silentSync`, `pingFrequencySeconds` only.

## Verification Plan

### Automated Tests
Skipped per session directive — the user runs the test suite separately.

### Manual Verification
1. Open the Remote tab — confirm the radio group is gone.
2. Configure boards, turn the toolbar toggle on — confirm the poll starts (check the log or observe state mirroring firing).
3. Turn the toggle off — confirm the poll stops.
4. Turn the toggle on with silent sync OFF — confirm a reconciling poll fires immediately before the loop begins.
5. Restart VS Code with boards configured — confirm the loop does NOT auto-start (toolbar toggle remains inactive; `_remoteControlActive` stays `false`).
6. Save remote config — confirm no `pingMode` field in the stored JSON (query the DB: `sqlite3 .switchboard/kanban.db "SELECT value FROM config WHERE key='remote.config'"`).
7. Pre-existing blob with `pingMode: 'constant'` — reload, confirm `getConfig()` returns a valid `RemoteConfig` (no throw, no `pingMode` key) and the loop does NOT auto-start.
8. Toggle on, change ping frequency in the Remote tab, save — confirm the running timer reschedules to the new cadence without a double-timer.

## Recommendation

Complexity 3 → **Send to Coder**. Mechanical deletion across three files plus one plan-doc edit; the only non-trivial coordination is the `restoreFromConfig()` caller removal in `KanbanProvider.ts` and the Plan 3/3 contract update.

## Review Findings

Core implementation across `RemoteControlService.ts`, `KanbanProvider.ts`, and `kanban.html` is correct and complete — `pingMode` removed from interface/default/getConfig/setConfig/start, `restoreFromConfig()` and its `webviewReady` caller block deleted, radio group HTML removed, JS functions cleaned, reconciling-poll guard collapsed to `!config.silentSync`. Review caught four stale-reference gaps: (1) Plan 3/3 contract still listed `pingMode` at lines 88/90 — fixed; (2) `docs/switchboard_user_manual.md:1525` and `docs/remote_sync_architecture_refactor_analysis.md:48,120` still documented `pingMode` — fixed; (3) test fixture `remote-control-service.test.js:40` had stale `pingMode: 'manual'` in `BASE_CONFIG` — fixed; (4) orphaned `.remote-radio-row` CSS in `kanban.html:769-780` — removed. No code logic regressions; `setConfig()` reschedule and `_scheduleTimer` clear-first ordering verified safe. Remaining risk: historical plan documents in `.switchboard/plans/` still mention `pingMode` (archived artifacts, out of scope).
