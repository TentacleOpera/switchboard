# Fix: GlobalPlanWatcher Startup Scan Skipped When Periodic Scan Disabled

## Problem

`GlobalPlanWatcherService._startPeriodicScan()` returns early when `switchboard.planWatcher.periodicScanEnabled` is `false`, before any scan runs. This means:

1. The `_scanSeenPaths` cache is never seeded.
2. Plans that existed on disk **before the extension session started** are never imported into the DB.
3. Users who set Scan Speed to "Off" in the Plan Scanner setup tab to reduce background CPU cost silently lose all pre-startup plan ingestion — not just the repeating scan.

The user's mental model ("Off = no repeating scan") is correct. The implementation was wrong.

## Root Cause

`initialize()` calls `_startPeriodicScan()` which, when disabled, does nothing at all:

```ts
// GlobalPlanWatcherService.ts
if (!enabled) {
    this._outputChannel?.appendLine('[GlobalPlanWatcher] Periodic scan disabled');
    return;  // ← exits before any scan ever runs
}
this._scanInterval = setInterval(async () => { ... }, this._scanIntervalMs);
```

The first interval tick (when `_scanSeenPaths` is empty) is what normally seeds the cache and imports pre-startup files. With `periodicScanEnabled: false`, that tick never fires.

## Fix

### `src/services/GlobalPlanWatcherService.ts`

Add `_runStartupScan()` method and call it unconditionally from `initialize()`, after `_startPeriodicScan()`.

**New method** (insert before `_startPeriodicScan`):

```ts
private _runStartupScan(): void {
    void (async () => {
        if (this._scanInProgress) { return; }
        this._scanInProgress = true;
        try {
            const folders = await this._getAllMappedFolders();
            for (const folder of folders) {
                await this._scanForNewFiles(folder);
            }
            this._outputChannel?.appendLine('[GlobalPlanWatcher] Startup scan complete');
        } finally {
            this._scanInProgress = false;
        }
    })();
}
```

**Updated `initialize()`**:

```ts
public async initialize(): Promise<void> {
    this._outputChannel?.appendLine('[GlobalPlanWatcher] Initializing...');
    await this._refreshWatchers();
    this._startPeriodicScan();
    // Always run one startup scan regardless of periodicScanEnabled — this seeds the
    // seen-paths cache and imports files that were created before this session started.
    // periodicScanEnabled only controls whether the scan *repeats*; the initial pass
    // must always happen so pre-startup files are not silently dropped.
    this._runStartupScan();
    ...
}
```

`_startPeriodicScan` is unchanged. When `periodicScanEnabled` is true, the interval still ticks as before — but on first tick `_scanSeenPaths` is already populated by the startup scan, so only genuinely new files are processed (no regression, slight improvement).

### `src/webview/setup.html`

Update the Plan Scanner tab description (line ~947) to make the distinction explicit:

**Before:**
> File watchers pick up new plans instantly. The Scan Speed below controls how often Switchboard re-scans as a fallback for missed events — both external IDE folders (Antigravity / Cursor / Claude Code / Windsurf-Devin) and the internal `.switchboard/plans` directory. Runs in the background even when this panel is minimised, unfocused, or closed.

**After:**
> File watchers pick up new plans instantly. Switchboard also scans once at startup to import any plans created while the extension was not running — this startup scan always happens. The Scan Speed below controls how often that scan *repeats* as a fallback for missed events — both external IDE folders (Antigravity / Cursor / Claude Code / Windsurf-Devin) and the internal `.switchboard/plans` directory. Set to **Off** to disable the recurring scan while keeping the startup pass.

## Metadata

- **Tags:** bug, reliability
- **Complexity:** 2

## User Review Required

None.

## Behaviour After Fix

| Scenario | Before fix | After fix |
|---|---|---|
| Periodic scan enabled (default) | Startup scan runs at first interval tick (~10s after init) | Startup scan runs immediately at init; interval ticks find only files newer than that |
| Periodic scan disabled ("Off") | No scan ever runs; pre-startup files silently lost | Startup scan runs once at init; no repeating scan |
| `triggerScan` (manual button) | Unaffected — always re-scans all files | Unaffected |

## Files Changed

- `src/services/GlobalPlanWatcherService.ts` — add `_runStartupScan()`, call from `initialize()`
- `src/webview/setup.html` — clarify Plan Scanner tab description

## Verification

1. Set `switchboard.planWatcher.periodicScanEnabled: false` in settings.
2. Drop a `.md` plan file into `.switchboard/plans/` while the extension is not running (or reload the window with a pre-existing untracked plan).
3. Reload the window / restart the extension.
4. Confirm the plan appears on the kanban board within a few seconds (startup scan picked it up).
5. Confirm no repeating "Periodic scan" log lines appear in the Switchboard output channel.
6. With periodic scan enabled, confirm the output channel shows "Startup scan complete" immediately, then subsequent interval ticks log "0 new paths" (steady state).
