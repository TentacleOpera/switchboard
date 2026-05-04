---
description: Auto-export kanban state to JSON file on every change for fast agent reads
---

# Auto-Export Kanban State to File

## Goal
Eliminate on-demand script execution for kanban state queries by having the board continuously export its state to a JSON file that agents can read directly.

## Metadata
**Tags:** backend, database, performance, workflow
**Complexity:** 5
**Repo:** switchboard

## User Review Required
- [ ] Confirm file location: `.switchboard/kanban-state.json` vs alternatives
- [ ] Confirm refresh strategy: on every DB mutation vs debounced vs periodic

## Complexity Audit

### Routine
- **Add `exportStateToFile()` private method** in `src/services/KanbanDatabase.ts` (~L2555 area, near `_persistedUpdate`) — serializes all active plans per column via existing `getPlansByColumn()` to JSON and writes to `.switchboard/kanban-state.json`
- **Add `scheduleStateExport()` debounce wrapper** — 500ms `setTimeout` that coalesces rapid successive mutations into a single write
- **Add `_workspaceRoot` field** to `KanbanDatabase` constructor (currently at `src/services/KanbanDatabase.ts:287-369`) — needed to resolve the state file output path; pass from existing `forWorkspace()` factory
- **Add `dispose()` method** to clear pending debounce timer on extension deactivation
- **Update skill documentation** in `.agent/skills/kanban_operations/SKILL.md` — add "Fast Path" section for direct file reads
- **Update workflow** in `.agent/workflows/improve-plan.md` — replace `node .agent/skills/kanban_operations/get-state.js` with `read_file .switchboard/kanban-state.json`
- **Add unit tests** for `exportStateToFile()` output structure, debounce behavior, and graceful failure on write error

### Complex / Risky
- **Hook point selection:** `_persist()` (L2555) is the single chokepoint ALL mutations pass through (both `_persistedUpdate` and direct `_persist` calls like `upsertPlans`, `reviveDeletedPlans`, `registerImport`, `removeImport`, `healOrphanedEntries`, `batchUpdateMetadata`, `batchCompletePlans`, `setConfig`). Hooking `_persist()` ensures no mutation is missed. However, `_persist()` is called synchronously from some paths and asynchronously from others — the debounce must be scheduled regardless of caller async context.
- **Workspace root availability:** `KanbanDatabase` currently does NOT store its workspace root — it only knows `this._dbPath`. The `forWorkspace()` factory receives the root but doesn't persist it. Adding `_workspaceRoot` to the constructor is a design change that affects the `forWorkspace()` factory and all test instantiation paths.
- **State file completeness vs performance:** `getPlansByColumn()` only returns `status = 'active'` plans (L1429). Dependency checking via `getDependencyStatus()` can reference completed/archived plans. The export must decide: active-only (matches current `get-state.js` behavior) or include completed? **Clarification: Export active-only to match `get-state.js` current output; agents needing completed plan data should query the DB directly.**
- **Timer lifecycle on dispose:** If the extension deactivates while a debounced write is pending, the `setTimeout` callback fires after the DB is closed. Must flush synchronously in `dispose()` or cancel the timer.

## Edge-Case & Dependency Audit

- **Race Conditions**: Rapid successive column moves (drag-drop) trigger multiple `_persist()` calls. The 500ms debounce coalesces these into a single write. If the process crashes between the last mutation and the debounced write, the state file will be stale. Acceptable because the file is a performance cache, not a source of truth — agents fall back to `get-state.js` if needed.
- **Security**: State file contains plan topics, file paths, and workspace IDs. No credentials. File lives under `.switchboard/` which is already `.gitignore`d. No additional security measures needed.
- **Side Effects**: `_persist()` is called from ~20+ mutation sites. Adding `scheduleStateExport()` there affects all of them. The debounce timer must NOT block the `_persist()` return path — schedule it as a fire-and-forget side effect.
- **Disk I/O**: For a workspace with 100 active plans, the JSON output is ~50KB. Writing 50KB every 500ms during rapid operations is negligible. For 1000+ plan workspaces, consider compact JSON (no pretty-print) — but this is unlikely in practice.
- **Workspace scoping**: `KanbanDatabase` is instantiated per workspace root via `KanbanProvider._getKanbanDb()` (L1232-1241). Each instance writes to `<workspaceRoot>/.switchboard/kanban-state.json`. Multi-root workspaces get separate files automatically.
- **Git**: State file in `.switchboard/` is already `.gitignore`d. No change needed.
- **Backward compatibility**: Keep `get-state.js` skill working for external scripts / CLI usage. The state file is an optimization, not a replacement.
- **Dependencies & Conflicts**: Cross-plan conflict with `fix_kanbandatabase_directory_pollution_bug.md` — that plan adds validation to `forWorkspace()` which could reject invalid roots before `KanbanDatabase` is constructed. Since this plan adds `_workspaceRoot` to the constructor, both plans touch the same factory method. Coordinate: the pollution fix should run FIRST, then this plan adds the `_workspaceRoot` field to the validated constructor.

## Dependencies
- `fix_kanbandatabase_directory_pollution_bug` — Both plans modify `KanbanDatabase.forWorkspace()`. That plan should execute first to add root validation; this plan then adds `_workspaceRoot` field to the validated constructor.

## Adversarial Synthesis
Key risks: (1) Hooking the wrong mutation path — must hook `_persist()` not individual methods to avoid missed exports; (2) Timer leak on dispose — debounced write fires after DB closure; (3) Cross-plan conflict with directory pollution fix on `forWorkspace()` constructor. Mitigations: Hook `_persist()` as single chokepoint, add `dispose()` with synchronous flush, coordinate execution order with pollution fix first.

## Proposed Changes

### src/services/KanbanDatabase.ts
- **Context**: The `KanbanDatabase` class manages all kanban operations via SQLite. All mutations flow through `_persist()` (L2555-2563) either directly or via `_persistedUpdate()` (which calls `_persist()` internally). The class is instantiated per workspace root via `forWorkspace()` (L287-369).
- **Logic**: After every `_persist()` call (the single chokepoint), schedule a debounced state export to JSON.
- **Implementation**:
  1. **Add `_workspaceRoot` private field** — Store the workspace root passed to `forWorkspace()` so the export knows where to write. Modify constructor (around L287) to accept and store `workspaceRoot: string`.
  2. **Add `_stateFilePath` computed property** — `path.join(this._workspaceRoot, '.switchboard', 'kanban-state.json')`.
  3. **Add `_exportTimeout` private field** — `NodeJS.Timeout | undefined` for debounce timer.
  4. **Add `scheduleStateExport()` private method** — Clears any existing timeout, then sets a new 500ms timeout to call `exportStateToFile()`. Fire-and-forget: does not await the export.
  5. **Add `exportStateToFile()` private async method** — Queries all active plans grouped by column using `getPlansByColumn()`, builds the JSON structure (see below), writes atomically via temp file + rename.
  6. **Hook into `_persist()`** — At the end of `_persist()` (after the write succeeds, around L2563), call `this.scheduleStateExport()`. This ensures EVERY mutation triggers an export.
  7. **Add `dispose()` public method** — If `_exportTimeout` is set, clear it and synchronously call `exportStateToFile()` one final time before returning.
- **Edge Cases**:
  - Write failure: wrap `exportStateToFile()` in try/catch, log error via `console.error`, never throw — don't block operations
  - Missing workspace root: if `_workspaceRoot` is empty/undefined, skip export silently (edge case for test instances)
  - DB not ready: `exportStateToFile()` should call `ensureReady()` first and return early if false
  - Large workspaces: use compact JSON (`JSON.stringify(state)` without pretty-print) if plan count > 200

### .agent/skills/kanban_operations/SKILL.md
- **Context**: Skill documentation for kanban operations
- **Logic**: Update to reflect that agents can now read state file directly
- **Implementation**:
  - Add section: "## Read Kanban State (Fast Path)" instructing to read `.switchboard/kanban-state.json`
  - Keep existing script-based method as "## Fallback / External Usage"
  - Note: state file may be up to 500ms stale; for real-time accuracy use `get-state.js`

### .agent/workflows/improve-plan.md
- **Context**: Workflow that queries kanban state for dependency checking (L19-21)
- **Logic**: Replace script execution with direct file read
- **Implementation**:
  - Change step from `node .agent/skills/kanban_operations/get-state.js <workspace_id>` to `read_file <workspace_root>/.switchboard/kanban-state.json`
  - Add fallback note: if file doesn't exist, fall back to script execution

## Verification Plan

### Automated Tests
- Unit test: `exportStateToFile()` creates valid JSON with expected structure (columns array, workspaceId, timestamp)
- Unit test: Debouncing works — call `scheduleStateExport()` 5 times in 100ms, assert only 1 write occurs after 600ms
- Unit test: State file is readable and contains all expected columns for active plans
- Unit test: Write failure is caught and logged without throwing (mock `vscode.workspace.fs.writeFile` to throw)
- Unit test: `dispose()` flushes pending debounced write synchronously
- Unit test: Plans with `status = 'completed'` are NOT included in export (matches `get-state.js` behavior)
- Integration test: Multi-root workspace exports state to correct location per root

### Manual Verification
1. Move a plan between columns in kanban view
2. Verify `.switchboard/kanban-state.json` updates within 1 second
3. Run `improve-plan` workflow and confirm it reads state without script execution
4. Test rapid column moves (drag-drop multiple plans quickly) — verify no corruption
5. Deactivate extension while a plan move is in progress — verify no unhandled promise rejection

## Implementation Notes

**Debouncing strategy:**
```typescript
private _exportTimeout?: NodeJS.Timeout;

private scheduleStateExport(): void {
  if (this._exportTimeout) clearTimeout(this._exportTimeout);
  this._exportTimeout = setTimeout(() => this.exportStateToFile(), 500);
}
```

**Hook into `_persist()` (the single chokepoint):**
```typescript
// Inside _persist(), after successful write:
private async _persist(): Promise<boolean> {
  // ... existing write logic ...
  this.scheduleStateExport(); // <-- ADD THIS at the end
  return result;
}
```

**Dispose with synchronous flush:**
```typescript
public dispose(): void {
  if (this._exportTimeout) {
    clearTimeout(this._exportTimeout);
    this._exportTimeout = undefined;
    // Synchronous final flush — best effort
    void this.exportStateToFile();
  }
}
```

**File write safety:**
```typescript
private async exportStateToFile(): Promise<void> {
  if (!this._workspaceRoot) return; // Skip for test instances without root
  if (!(await this.ensureReady()) || !this._db) return;
  try {
    const state = await this._buildExportState();
    const tempPath = this._stateFilePath + '.tmp';
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(tempPath),
      Buffer.from(JSON.stringify(state)) // compact, no pretty-print
    );
    await vscode.workspace.fs.rename(
      vscode.Uri.file(tempPath),
      vscode.Uri.file(this._stateFilePath),
      { overwrite: true }
    );
  } catch (error) {
    console.error('[KanbanDatabase] Failed to export state to file:', error);
  }
}
```

**JSON structure (same as current get-state.js output):**
```json
{
  "workspaceId": "...",
  "timestamp": "2026-05-04T...",
  "columns": {
    "CREATED": [...],
    "BACKLOG": [...],
    "PLAN REVIEWED": [...],
    ...
  }
}
```

---

**Complexity**: 5
**Recommendation**: Send to Coder
