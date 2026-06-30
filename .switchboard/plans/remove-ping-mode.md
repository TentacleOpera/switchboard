# Remove Ping Mode (Constant / Manual Radio)

## Goal

Delete the `pingMode: 'constant' | 'manual'` concept entirely. The remote poll loop runs when the toolbar toggle is on and stops when it's off — that's the only meaningful behaviour. Constant mode auto-starts on VS Code load, but VS Code is always an attended environment, so this is just manual mode where the user forgot to press a button while burning API calls indefinitely. The radio adds UI noise with no real decision to make.

### Core problem

The ping mode radio was designed for a "phone at lunch" scenario where constant mode would keep the loop running unattended. But the extension only runs inside VS Code — there is no unattended context. Every user who picks constant mode is paying for continuous polling even when they have nothing open to remote-control. Manual mode is always correct; constant mode is always wrong.

### What changes

- `pingMode` is removed from `RemoteConfig`, `DEFAULT_REMOTE_CONFIG`, `getConfig()`, `setConfig()`, and `start()` in `RemoteControlService.ts`.
- `restoreFromConfig()` becomes a no-op (it only existed to auto-start constant mode on extension load).
- The reconciling poll on `start()` (`_poll()` before the loop begins) is kept unconditionally — it was previously gated to manual mode only, but it is correct behaviour regardless: if silent sync is off, the board may have drifted while pinging was off, so reconcile first.
- The ping mode radio (`<div>` with `name="remote-ping-mode"` radios) is removed from `kanban.html`.
- `remoteCollectConfig()` and `renderRemoteConfig()` drop the `pingMode` field.

### Migration

Existing users who saved `pingMode: 'constant'` in their DB will have that field ignored on next read — `getConfig()` simply won't parse or return it. No migration script needed: the field becomes inert junk in the stored JSON and the rest of the contract (`boards`, `silentSync`, `pingFrequencySeconds`, `provider`) is unaffected. On first save from the UI the field disappears from the stored blob.

Plan 3/3 of the Remote Sync Refactor explicitly preserves `pingMode` in its migration contract. That line should be dropped — plan 3/3's migration must NOT write `pingMode` into the new unified contract.

## Complexity

2 — mechanical deletion across two files, no logic change beyond removing the constant auto-start.

## Metadata

- **Tags:** [frontend, backend, refactor, simplify]
- **Repo:** switchboard

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

**`DEFAULT_REMOTE_CONFIG` (`:47–53`)** — remove `pingMode: 'manual'`.

**`getConfig()` (`:92–109`)** — remove `pingMode: parsed.pingMode === 'constant' ? 'constant' : 'manual'` from the returned object.

**`setConfig()` (`:111–129`)** — remove `pingMode` from `normalized`; replace the `if/else if` block with a single unconditional restart if active:
```ts
await db.setConfig(REMOTE_CONFIG_KEY, JSON.stringify(normalized));
if (this._active) {
    this._scheduleTimer(normalized.pingFrequencySeconds);
}
```

**`start()` (`:151–164`)** — remove the `if (config.pingMode === 'manual' && !config.silentSync)` guard; always run the reconciling poll when silent sync is off:
```ts
public async start(): Promise<void> {
    const config = await this.getConfig();
    if (config.boards.length === 0) {
        this._log('No boards selected — not starting.');
        return;
    }
    if (!config.silentSync) {
        this._log('Silent sync off — running a reconciling poll before starting loop.');
        await this._poll();
    }
    this._active = true;
    this._scheduleTimer(config.pingFrequencySeconds);
    this._log(`Started (provider=${config.provider}, every ${config.pingFrequencySeconds}s, ${config.boards.length} board(s)).`);
}
```

**`restoreFromConfig()` (`:183–188`)** — delete the method body (or remove the method entirely if no callers need it beyond the constant auto-start):
```ts
public async restoreFromConfig(): Promise<void> {
    // No-op: ping starts only when the user activates the toolbar toggle.
}
```

### `src/webview/kanban.html`

**Ping mode radio group (`:2602–2613`)** — delete the entire `<div>` block:
```html
<!-- Ping mode: radio group -->
<div style="margin-bottom:10px;">
    <span ...>Ping mode</span>
    <label class="remote-radio-row">
        <input type="radio" name="remote-ping-mode" value="manual" checked>
        ...
    </label>
    <label class="remote-radio-row">
        <input type="radio" name="remote-ping-mode" value="constant">
        ...
    </label>
</div>
```

**`renderRemoteConfig()` (`:6988–6990`)** — remove the two lines that read `config.pingMode` and set the radio.

**`remoteCollectConfig()` (`:7001`, `:7007`)** — remove the `modeEl` variable and the `pingMode` key from the returned object.

## Verification

1. Open the Remote tab — confirm the radio group is gone.
2. Configure boards, turn the toolbar toggle on — confirm the poll starts (check the log or observe state mirroring firing).
3. Turn the toggle off — confirm the poll stops.
4. Turn the toggle on with silent sync OFF — confirm a reconciling poll fires immediately before the loop begins.
5. Restart VS Code with boards configured — confirm the loop does NOT auto-start (toolbar toggle remains inactive).
6. Save remote config — confirm no `pingMode` field in the stored JSON (query the DB: `sqlite3 .switchboard/kanban.db "SELECT value FROM config WHERE key='remote.config'"`).
