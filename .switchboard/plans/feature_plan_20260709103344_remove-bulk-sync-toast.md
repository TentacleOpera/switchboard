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

This is the only call site — `grep` for the message string returns a single hit at `src/services/GlobalPlanWatcherService.ts:609`. It is also the only `showInformationMessage` call in the whole file (confirmed), so there is no adjacent notification to disturb.

## Metadata

- **Tags:** ux, bugfix
- **Complexity:** 1/10
- **Files touched:** `src/services/GlobalPlanWatcherService.ts`

> **Superseded:** **Tags:** notifications, ux, plan-watcher, noise-reduction
> **Reason:** `improve-plan` restricts tags to a fixed allowed list. `notifications`, `plan-watcher`, and `noise-reduction` are not on it; the importer would drop them. Only `ux` was valid.
> **Replaced with:** `ux, bugfix` — both from the allowed list; removing a spurious toast is a UX bugfix.

## User Review Required

- **None.** This is a scoped, mechanical removal of a single fire-and-forget notification. The behavior it guards (backup write + log line) is explicitly retained, so there is no product-level decision for the user to make.

## Complexity Audit

### Routine
- Delete one `vscode.window.showInformationMessage(...)` statement (line 609).
- No control-flow change, no data change, no migration, no protocol change.
- The surrounding backup logic, the `count` variable, and the `try/catch` error handling are untouched.
- Reuses no new pattern; it only removes code.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None introduced. The removed line is the last statement in the `try` block and its result is never observed (`showInformationMessage` is not awaited). Deleting it cannot reorder or gate anything. The async IIFE, event buffer reset (`this._recentEvents = []`), and 2s window are unchanged.
- **Security:** None. The toast leaks no sensitive data and gates no permission; removing it has no security dimension.
- **Side Effects:**
  - **Backup still written.** `db.writeDbBackup('bulk-change')` stays — the actual safety behavior is preserved. Only the announcement is removed.
  - **Diagnostics preserved.** The `_outputChannel.appendLine('[GlobalPlanWatcher] bulk change (${count}); snapshot written')` line stays, so the event is still traceable in the output channel if the user ever needs to confirm a snapshot ran. Removing the toast does not blind anyone.
- **Dependencies & Conflicts:**
  - **Single call site.** The message string appears nowhere else (`grep` confirms one hit). No shared helper or other toast is affected.
  - **No test asserts on the toast.** Confirmed: no `*.test.ts` references the message string, `bulk-change`, or `_registerEventForBulkCheck`. No code branches on the notification's result, so removal cannot change any downstream behavior.
  - **No settings/telemetry dependency.** The message is a hardcoded literal, not gated by a setting; removing it needs no config or migration.
  - **`count` still consumed.** After removal, `count` is still read by the surviving log line (608), so its declaration must stay. No unused-variable fallout.

## Dependencies

- None. This plan does not depend on any other session's work and nothing depends on it.

## Adversarial Synthesis

**Risk Summary:** Deleting one fire-and-forget `showInformationMessage` (line 609) carries essentially zero behavioral risk — its return value is never observed, no test asserts on it, and the safety backup + diagnostic log both survive. The only realistic failure mode is a coder over-editing (removing the `count` variable, the log line, or the backup call) or reintroducing a "quieter" replacement notification, which would defeat the purpose. Mitigation: delete exactly the one line and verify the log line still emits `count`.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts` — delete the toast

- **Context:** Inside `_registerEventForBulkCheck` (line 596), the async IIFE that writes the bulk-change backup snapshot. Line 609 announces the snapshot via `vscode.window.showInformationMessage`.
- **Logic:** Remove only line 609. Leave the `try`/`catch`, the `writeDbBackup('bulk-change')` call, the `_outputChannel.appendLine(...)` log, the `count` declaration (line 601), and the event-buffer reset exactly as they are.
- **Implementation:** After the edit, the `try` block reads:

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

- **Edge Cases:** Do NOT replace the toast with a status-bar message, a "quieter" notification, or a setting-gated variant — the requirement is silence, and the output-channel log already provides traceability. Do NOT touch `count`, the log line, or the backup call.

## Verification Plan

### Automated Tests
- None. This is a fire-and-forget UI notification with no behavioral surface: its promise is not awaited and no code branches on it. No existing test references it (confirmed via `grep`), and none is warranted for a pure line-removal. (Per session directive, no automated tests or compile step are run as part of this verification.)

### Manual verification (UAT, in an installed build)
1. Trigger a bulk file change: on the Kanban board, group 5+ plans into a feature, or run any operation that rewrites five or more `.md` files within ~2 seconds.
   - **Expect:** **no** "Multiple cards changed by a file sync" toast appears.
2. Open the extension's output channel (GlobalPlanWatcher) and confirm the `bulk change (N); snapshot written` line is still logged.
3. Confirm a backup snapshot file was still produced (the `writeDbBackup('bulk-change')` output), verifying the safety mechanism is intact and only the notification was removed.

---

**Recommendation: Send to Intern.** (Complexity 1/10 — a single-line deletion with the surrounding logic explicitly preserved.)

## Completion Summary

Removed the single `vscode.window.showInformationMessage(...)` call from `src/services/GlobalPlanWatcherService.ts` inside `_registerEventForBulkCheck` (formerly line 609). The bulk-change backup logic (`db.writeDbBackup('bulk-change')`) and the output-channel log line (`[GlobalPlanWatcher] bulk change (${count}); snapshot written`) remain intact. The message string no longer appears in the source, and the file still compiles syntactically; no other files were modified. Per the session directive, no compilation or automated test run was executed.
