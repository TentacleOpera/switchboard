# Atomic State Persistence for Switchboard Configuration

## Goal
Ensure that writes to `.switchboard/state.json` are atomic, preventing file truncation and data loss when the IDE crashes or is forcefully closed during a write operation.

### Problem Analysis & Root Cause
On startup, Switchboard loads terminal configurations, active environments, recent project boards, and custom agent configurations from `.switchboard/state.json`. When the IDE is suddenly closed or crashes during a write to this file, the file can be truncated to 0 bytes. This causes Switchboard to lose all state on the next startup, leading to duplicate terminals being spawned, loss of recently accessed lists/projects, and deletion of custom roles or startup commands.

In [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts), state updates are saved using standard, non-atomic file writes (`fs.promises.writeFile(statePath, newContent)`). If the Node process terminates while writing, the file descriptor is closed mid-operation, leaving a truncated or corrupted file on disk.

Fortunately, [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts) already implements an atomic write helper `_writeFileAtomic` (line 16847):
```typescript
private async _writeFileAtomic(targetPath: string, content: string): Promise<void> {
    const directory = path.dirname(targetPath);
    const tempPath = path.join(directory, `${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rename(tempPath, targetPath);
}
```
However, the state saving code does not utilize it. This plan replaces the direct `fs.promises.writeFile` calls with calls to `this._writeFileAtomic`.

## Metadata
**Tags:** bugfix, backend, reliability
**Complexity:** 2

## User Review Required

> [!NOTE]
> This change is minor and has very low risk of side effects. The atomic write helper has already been implemented and used successfully elsewhere in the codebase.

## Open Questions

None. The issue and solution are clear-cut.

## Complexity Audit

### Routine
- Replacing `fs.promises.writeFile(statePath, ...)` with `this._writeFileAtomic(statePath, ...)` at two call sites
- Both call sites already use `'utf8'` encoding, matching the `_writeFileAtomic` internal implementation

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: `_persistLastAccessed` (line 5127) reads and writes state.json directly, bypassing the `updateState` queue. This creates a potential race with `_processUpdateQueue` (line 1599) if both fire concurrently. However, this is a pre-existing issue unrelated to the atomic write change — the atomic write actually reduces the window for corruption compared to the current non-atomic writes.
- **Security**: No security implications — same data, same file path, same permissions.
- **Side Effects**: If the process crashes between the temp-file write and the rename step in `_writeFileAtomic`, a `.tmp-{pid}-{timestamp}` orphan file will remain in `.switchboard/`. This is a minor disk leak but not a data loss issue (the original file remains intact). This is a pre-existing characteristic of `_writeFileAtomic` already used elsewhere in the codebase.
- **Dependencies & Conflicts**: The `selfStateWriteUntil` guard (line 1598) is set before the write call. With atomic writes, if the process crashes after the guard is set but before the rename completes, the guard timestamp is already recorded but the file hasn't changed. This is strictly safer than the current behavior where a crash mid-write truncates the file.

## Dependencies

None.

## Adversarial Synthesis
Key risks: orphan temp files on crash (pre-existing, acceptable); concurrent writes from `_persistLastAccessed` bypassing the update queue (pre-existing, out of scope). Mitigations: atomic writes reduce the corruption window; the existing `_writeFileAtomic` helper is already battle-tested in other call sites.

## Proposed Changes

### Switchboard Core Extension Services

---

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

- Update state update queue writer in `_processUpdateQueue` (line 1599) to call `this._writeFileAtomic(statePath, newContent)` instead of `fs.promises.writeFile(statePath, newContent)`.
- Update last accessed status writer in `_persistLastAccessed` (line 5127) to call `this._writeFileAtomic(statePath, JSON.stringify(state, null, 2))` instead of `fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')`.

## Verification Plan

### Automated Tests
- No specific automated tests for this change. Run existing test suite if available.

### Manual Verification
1. Open the Switchboard extension sidebar.
2. Trigger an environment update (e.g., select or deselect list/project or register a terminal role).
3. Verify that the `.switchboard/state.json` file is correctly written and updated without errors.
4. Verify that the extension loads correctly on startup and correctly reads the state.
5. (Crash test) Force-kill the VS Code process during a state update, then reopen — verify `state.json` is not truncated.

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Details |
|---|---------|----------|---------|
| 1 | `_processUpdateQueue` uses `_writeFileAtomic` | — | Verified at line 1599. Correct replacement. |
| 2 | `_persistLastAccessed` uses `_writeFileAtomic` | — | Verified at line 5127. Correct replacement; encoding `'utf8'` preserved inside `_writeFileAtomic`. |
| 3 | `_writeFileAtomic` lacks temp-file cleanup on rename failure | NIT | Pre-existing issue in the helper method (lines 16845-16850). If `rename` throws, orphan temp file remains. Out of scope for this plan. |
| 4 | Race condition between `_persistLastAccessed` and update queue | — | Pre-existing, acknowledged. Atomic writes reduce corruption window. |
| 5 | `fs.writeFileSync` at line 1577 not converted to atomic | NIT | Initialization path creates `state.json` from scratch. Sync write is low-risk for truncation. Out of scope — plan targeted async `writeFile` call sites only. |

### Stage 2: Balanced Synthesis

- **Keep**: Both `_writeFileAtomic` replacements are correct and complete.
- **Fix Now**: Nothing needed.
- **Defer**: (1) Add try/catch cleanup to `_writeFileAtomic` for orphan temp files on rename failure (NIT, pre-existing). (2) Consider converting `fs.writeFileSync` init path to atomic write for consistency (NIT, low risk).

### Code Fixes Applied

None — implementation verified correct with no CRITICAL or MAJOR findings.

### Verification Results

- **`_processUpdateQueue` (line 1599)**: Uses `this._writeFileAtomic(statePath, newContent)` ✓
- **`_persistLastAccessed` (line 5127)**: Uses `this._writeFileAtomic(statePath, JSON.stringify(state, null, 2))` ✓
- **`_writeFileAtomic` method (line 16845)**: Unchanged, temp-file + rename pattern ✓
- **No remaining `fs.promises.writeFile(statePath, ...)` calls**: Confirmed ✓
- **Compilation**: Skipped per review instructions
- **Tests**: Skipped per review instructions

### Remaining Risks

- `_writeFileAtomic` orphan temp files on rename failure (pre-existing, NIT)
- `fs.writeFileSync` init path not atomic (low risk, NIT)
- Concurrent writes from `_persistLastAccessed` bypassing update queue (pre-existing race, reduced by atomic writes)

## Recommendation
**Send to Intern** — Complexity 2, two-line substitution using an existing helper method.
