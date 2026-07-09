# Remove the "Multiple cards changed by a file sync. Backup snapshot created." toast

## Goal

During normal use, a VS Code information toast pops up constantly:

> Multiple cards (5) changed by a file sync. Backup snapshot created.

It fires any time five or more plan/feature `.md` files change within a two-second window — which happens routinely during ordinary multi-card operations (grouping, batch moves, imports, orchestration sweeps). The toast tells the user nothing they can act on: a backup snapshot being written is a silent safety mechanism, not something that needs a modal interruption every few actions. It is pure noise and the user wants it gone.

The fix: stop showing the toast. Keep the backup itself and the diagnostic log line — only the user-facing notification is removed.

### Problem analysis & root cause

`GlobalPlanWatcherService._registerEventForBulkCheck` batches recent file-change events and, when five or more land inside two seconds, writes a defensive DB backup snapshot and then announces it:

```ts
// src/services/GlobalPlanWatcherService.ts:596-615
private _registerEventForBulkCheck(fsPath: string, workspaceRoot: string): void {
    const now = Date.now();
    this._recentEvents.push({ fsPath, ts: now });
    this._recentEvents = this._recentEvents.filter(e => now - e.ts <= 2000);
    if (this._recentEvents.length >= 5) {
        const count = this._recentEvents.length;
        this._recentEvents = []; // reset
        void (async () => {
            try {
                const db = KanbanDatabase.forWorkspace(workspaceRoot);
                await db.ensureReady();
                await db.writeDbBackup('bulk-change');
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] bulk change (${count}); snapshot written`);
                vscode.window.showInformationMessage(`Multiple cards (${count}) changed by a file sync. Backup snapshot created.`);  // <-- the noise
            } catch (e) {
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Failed to write bulk-change backup: ${e}`);
            }
        })();
    }
}
```

**Root cause:** an internal safety event (writing a backup snapshot) was wired to a `showInformationMessage`. The threshold (≥5 events / 2s) is trivially crossed by legitimate bulk operations, so the "notification" fires on routine activity rather than signalling anything the user needs to know. The backup write and the output-channel log are the parts worth keeping; the toast is not.

This is the only call site — `grep` for the message string returns a single hit at `src/services/GlobalPlanWatcherService.ts:609`.

## Metadata

- **Tags:** notifications, ux, plan-watcher, noise-reduction
- **Complexity:** 1/10
- **Files touched:** `src/services/GlobalPlanWatcherService.ts`

## Complexity Audit

**Routine.** Delete a single `vscode.window.showInformationMessage(...)` statement. No control-flow change, no data change, no migration, no protocol change. The surrounding backup logic and error handling are untouched.

## Edge-Case & Dependency Audit

- **Backup still written.** `db.writeDbBackup('bulk-change')` stays — the actual safety behavior is preserved. Only the announcement is removed.
- **Diagnostics preserved.** The `_outputChannel.appendLine('[GlobalPlanWatcher] bulk change (${count}); snapshot written')` line stays, so the event is still traceable in the output channel if the user ever needs to confirm a snapshot ran. Removing the toast does not blind anyone.
- **Single call site.** The message string appears nowhere else (`grep` confirms one hit). No shared helper or other toast is affected.
- **No test asserts on the toast.** This is a fire-and-forget notification; no code branches on its result (`showInformationMessage`'s promise is not awaited). Removing it cannot change any behavior downstream.
- **No settings/telemetry dependency.** The message is a hardcoded literal, not gated by a setting; removing it needs no config or migration.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts` — delete the toast

Remove line 609 (the `showInformationMessage` call) inside `_registerEventForBulkCheck`. The `try` block becomes:

```ts
try {
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    await db.ensureReady();
    await db.writeDbBackup('bulk-change');
    this._outputChannel?.appendLine(`[GlobalPlanWatcher] bulk change (${count}); snapshot written`);
} catch (e) {
    this._outputChannel?.appendLine(`[GlobalPlanWatcher] Failed to write bulk-change backup: ${e}`);
}
```

No other change. `count` is still used by the surviving log line, so it stays declared.

## Verification Plan

1. Rebuild/reinstall the VSIX.
2. Trigger a bulk file change: on the Kanban board, group 5+ plans into a feature, or run any operation that rewrites five or more `.md` files within ~2 seconds.
   - **Expect:** **no** "Multiple cards changed by a file sync" toast appears.
3. Open the extension's output channel (GlobalPlanWatcher) and confirm the `bulk change (N); snapshot written` line is still logged.
4. Confirm a backup snapshot file was still produced (the `writeDbBackup('bulk-change')` output), verifying the safety mechanism is intact and only the notification was removed.
