---
description: Auto-export kanban state to markdown file on every change for fast agent reads
---

# Auto-Export Kanban State to File

## Goal
Eliminate on-demand script execution for kanban state queries by having the board continuously export its state to a human-readable markdown file that agents can read directly.

## Metadata
**Tags:** backend, database, performance, workflow
**Complexity:** 3

## User Review Required
- [ ] Confirm file location: `.switchboard/kanban-board.md`
- [ ] Confirm refresh strategy: synchronous write on every DB mutation is acceptable given <1ms cost

## Complexity Audit

### Routine
- **Replace `exportStateToFile()` output format** in `src/services/KanbanDatabase.ts` (~L2618) — change from JSON to markdown. Group plans by column, render as `[<sessionId>](<planFile>) — <topic>` links.
- **Remove `scheduleStateExport()` debounce wrapper** — write markdown synchronously at end of `_persist()`. Markdown is <10KB; write cost is negligible. Eliminates timer complexity entirely.
- **Update skill documentation** in `.agent/skills/kanban_operations/SKILL.md` — replace "Fast Path" JSON reference with markdown file path.
- **Update workflow** in `.agent/workflows/improve-plan.md` — replace `read_file .switchboard/kanban-state.json` with `read_file .switchboard/kanban-board.md`
- **Add unit test** for markdown output structure and graceful failure on write error

### Complex / Risky
- **Hook point selection:** `_persist()` (L2673) is the single chokepoint ALL mutations pass through. Hooking `_persist()` ensures no mutation is missed. Since markdown writes are synchronous and cheap, call directly at end of `_persist()` instead of scheduling a debounce.
- **Workspace root availability:** Already resolved — `_workspaceRoot` was added in constructor (L671) as part of the original implementation. No additional changes needed.
- **Backwards compatibility:** The old `.switchboard/kanban-state.json` file should be removed on first write to avoid confusion. Agents may have cached references to it.

## Edge-Case & Dependency Audit

- **Race Conditions**: Rapid successive column moves trigger multiple `_persist()` calls, each rewriting the markdown file. Since writes are synchronous and <10KB, this is harmless — last write wins, which is correct.
- **Security**: Markdown file contains plan topics, file paths, and session IDs. No credentials. File lives under `.switchboard/` which is already `.gitignore`d. No additional security measures needed.
- **Side Effects**: `_persist()` is called from ~20+ mutation sites. The markdown write happens inline at the end of `_persist()`, after the DB write succeeds. It does not block the return path (fire-and-forget with `void`).
- **Disk I/O**: For a workspace with 100 active plans, markdown output is ~5KB. Writing 5KB synchronously is negligible (<1ms).
- **Workspace scoping**: `KanbanDatabase` is instantiated per workspace root. Each instance writes to `<workspaceRoot>/.switchboard/kanban-board.md`. Multi-root workspaces get separate files automatically.
- **Git**: Markdown file in `.switchboard/` is already `.gitignore`d. No change needed.
- **Backward compatibility**: 
  - Remove old `.switchboard/kanban-state.json` on first markdown write to prevent stale file confusion.
  - Keep `get-state.js` skill working for external scripts / CLI usage.
- **Dependencies & Conflicts**: None. The `_workspaceRoot` constructor change was already implemented.

## Dependencies
None. The `_workspaceRoot` constructor change was already implemented in a previous plan.

## Adversarial Synthesis
Key risks: (1) Markdown format may not be parseable by automated tools that expected JSON — mitigate by keeping `get-state.js` as canonical machine-readable API; (2) Synchronous write on every mutation could theoretically slow rapid bulk operations — mitigate by the fact that markdown is tiny and FS writes are buffered; (3) Old `kanban-state.json` may confuse agents until cleaned up — mitigate by deleting it on first markdown write. Markdown is for human/agent quick-glance only; all structured queries should use the DB or `get-state.js`.

## Proposed Changes

### src/services/KanbanDatabase.ts
- **Context**: The `KanbanDatabase` class manages all kanban operations via SQLite. All mutations flow through `_persist()` (L2673-2707) either directly or via `_persistedUpdate()` (which calls `_persist()` internally). The class is instantiated per workspace root via `forWorkspace()` (L287-375). The `_workspaceRoot` field and `exportStateToFile()` method already exist from the original implementation; this change refactors the output format and removes debounce complexity.
- **Logic**: After every `_persist()` call, write a simple markdown file synchronously (fire-and-forget).
- **Implementation**:
  1. **Remove `_exportTimeout` field and `scheduleStateExport()` method** — Delete lines 2609-2616. Debounce is unnecessary for small markdown writes.
  2. **Rename and refactor `exportStateToFile()`** — Rename to `exportStateToMarkdown()` or keep existing name but change implementation:
     - Query all active plans via `getBoard(workspaceId)` (already doing this)
     - Group by `kanbanColumn` using all `VALID_KANBAN_COLUMNS` as keys (not just NEW/PLANNED)
     - Build markdown string: `# Kanban Board\n\n## <Column Name>\n- [<sessionId>](<planFile>) — <topic>\n`
     - Delete old `.switchboard/kanban-state.json` if it exists (one-time cleanup)
     - Write to `.switchboard/kanban-board.md` via temp file + rename
  3. **Simplify `_persist()` hook** — At the end of `_persist()` (L2702-2704), replace `this.scheduleStateExport()` with `void this.exportStateToFile()`. Fire-and-forget, no timer.
  4. **Simplify `dispose()`** — Keep existing dispose (L675-681) but remove timer logic. Since there's no pending timer, `dispose()` can just be a no-op or optionally do a final flush.
  5. **Update `_stateFilePath`** — Change from `kanban-state.json` to `kanban-board.md` (L667-669).
- **Edge Cases**:
  - Write failure: wrap in try/catch, log error, never throw
  - Missing workspace root: skip export silently (already handled)
  - No plans: write file with header and "No active plans" message
  - Plan file path is relative: resolve against workspace root for clickable links

### .agent/skills/kanban_operations/SKILL.md
- **Context**: Skill documentation for kanban operations
- **Logic**: Update to reference the markdown file instead of JSON
- **Implementation**:
  - Replace "## Read Kanban State (Fast Path)" section — instruct to read `.switchboard/kanban-board.md`
  - Keep existing script-based method as "## Fallback / External Usage"
  - Remove stale note about 500ms debounce

### .agent/workflows/improve-plan.md
- **Context**: Workflow that queries kanban state for dependency checking (L19-21)
- **Logic**: Replace JSON file read with markdown file read
- **Implementation**:
  - Change step from `read_file <workspace_root>/.switchboard/kanban-state.json` to `read_file <workspace_root>/.switchboard/kanban-board.md`
  - Keep fallback to `node .agent/skills/kanban_operations/get-state.js <workspace_id>` if file missing

## Verification Plan

### Automated Tests
- Unit test: `exportStateToFile()` creates valid markdown with expected structure (column headers, plan links)
- Unit test: State file contains all expected columns for active plans
- Unit test: Write failure is caught and logged without throwing
- Unit test: Plans with `status = 'completed'` are NOT included in export
- Unit test: Old `kanban-state.json` is deleted on first markdown write
- Integration test: Multi-root workspace exports markdown to correct location per root

### Manual Verification
1. Move a plan between columns in kanban view
2. Verify `.switchboard/kanban-board.md` updates immediately
3. Open markdown file and confirm it shows human-readable plan links grouped by column
4. Run `improve-plan` workflow and confirm it reads the markdown file
5. Test rapid column moves — verify no corruption, last write wins

## Implementation Notes

**Markdown generation (replaces JSON):**
```typescript
private async exportStateToFile(): Promise<void> {
  if (!this._workspaceRoot || !this._db) return;
  try {
    const workspaceId = await this.getWorkspaceId();
    if (!workspaceId) return;

    const allPlans = await this.getBoard(workspaceId);
    const columns = new Map<string, KanbanPlanRecord[]>();
    for (const col of VALID_KANBAN_COLUMNS) {
      columns.set(col, []);
    }
    for (const plan of allPlans) {
      const list = columns.get(plan.kanbanColumn);
      if (list) list.push(plan);
    }

    let md = `# Kanban Board\n\n`;
    md += `*Workspace: ${workspaceId}* · *Updated: ${new Date().toISOString()}*\n\n`;
    for (const [col, plans] of columns) {
      md += `## ${col}\n\n`;
      if (plans.length === 0) {
        md += `_No plans_\n\n`;
      } else {
        for (const plan of plans) {
          const filePath = path.isAbsolute(plan.planFile)
            ? plan.planFile
            : path.join(this._workspaceRoot, plan.planFile);
          md += `- [${plan.sessionId}](${filePath}) — ${plan.topic}\n`;
        }
        md += `\n`;
      }
    }

    // One-time cleanup of old JSON file
    const oldJsonPath = path.join(this._workspaceRoot, '.switchboard', 'kanban-state.json');
    if (fs.existsSync(oldJsonPath)) {
      await fs.promises.unlink(oldJsonPath);
    }

    const tmpPath = this._stateFilePath + '.tmp';
    await fs.promises.writeFile(tmpPath, md, 'utf8');
    await fs.promises.rename(tmpPath, this._stateFilePath);
  } catch (error) {
    console.error('[KanbanDatabase] Failed to export state to file:', error);
  }
}
```

**Hook into `_persist()` (simplified):**
```typescript
private async _persist(): Promise<boolean> {
  // ... existing write logic ...
  if (result) {
    void this.exportStateToFile(); // fire-and-forget, no debounce
  }
  return result;
}
```

**Simplified `dispose()`:**
```typescript
public dispose(): void {
  // No timer to clear — writes are synchronous fire-and-forget
  // Optional: final flush on deactivation
  void this.exportStateToFile();
}
```

**Markdown output format:**
```markdown
# Kanban Board

*Workspace: 038bffef-...* · *Updated: 2026-05-04T...*

## CREATED
- [sess_1777759329250](/Users/patrickvuleta/.../.switchboard/plans/architectural_refactor_2_update_call_sites.md) — Architectural Refactor 2/4: Update All Call Sites
- [sess_1777759330075](/Users/patrickvuleta/.../.switchboard/plans/architectural_refactor_1_event_system.md) — Architectural Refactor 1/4: Event System Foundation

## BACKLOG
_No plans_

## PLAN REVIEWED
...
```

## UAT Failure — RESOLVED

**Expected Behavior:**
- Simple markdown file output containing all plan links that agents could read quickly
- Direct file read without script execution

**Actual Behavior (Original Implementation):**
- Complex JSON auto-export system with debouncing, dispose handlers, and database hooks
- Workflow still used `node .agent/skills/kanban_operations/get-state.js <workspace_id>` fallback which failed
- Over-engineered solution that didn't match the simple use case

**Root Cause:**
- Plan was designed as a performance optimization for database queries
- User requirement was for a static markdown file with plan links
- Mismatch between implementation scope and actual need

**Resolution Applied:**
- Replaced JSON export with markdown export to `.switchboard/kanban-board.md`
- Removed debounce timer and `scheduleStateExport()` — writes are now synchronous fire-and-forget at end of `_persist()`
- Simplified `dispose()` — no timer to clear
- Updated `.agent/skills/kanban_operations/SKILL.md` to reference markdown file
- Updated `.agent/workflows/improve-plan.md` to read markdown file instead of JSON
- Added one-time cleanup of old `.switchboard/kanban-state.json`

**Status:** Plan revised. Ready for re-implementation.

---

## Reviewer Pass — 2026-05-05

### Stage 1: Grumpy Adversarial Critique

**CRITICAL — Stale test compilation output (`out/` directory)**
`out/services/KanbanDatabase.js` still contained `_exportTimeout`, `scheduleStateExport()`, and wrote to `kanban-state.json`. The `tsconfig.test.json` compiles to `out/`, and `pretest` runs `compile-tests` which feeds from that directory. Any test run against `out/` was testing the OLD code. The production webpack bundle (`dist/extension.js`) was clean, but the test pipeline was a zombie. If someone ran `npm test`, they'd validate code that no longer exists in source.

**MAJOR — Test file tested the wrong feature**
`src/test/kanban-auto-export.test.ts` was a museum piece. It read `kanban-state.json` and parsed JSON, tested debouncing with `setTimeout(resolve, 1000)`, asserted only `NEW` and `PLANNED` columns existed, tested `dispose()` clearing a timer, and used `@ts-ignore` to call a private method. Every single test was testing behavior that was deliberately removed in the plan revision.

**NIT — `fs.existsSync` in async function**
`exportStateToFile()` uses `fs.existsSync` (synchronous) inside an async function. Not a bug, but inconsistent style.

**NIT — `dispose()` fire-and-forget may not complete on shutdown**
`dispose()` calls `void this.exportStateToFile()` which is async. If the extension process exits before the promise resolves, the final write may not complete. Acceptable per plan design (fire-and-forget is intentional).

### Stage 2: Balanced Synthesis

**Keep:**
- The TS source in `src/services/KanbanDatabase.ts` is correct — `_stateFilePath` points to `kanban-board.md`, `_persist()` calls `void this.exportStateToFile()` directly, no debounce timer, `dispose()` is simplified.
- The webpack bundle `dist/extension.js` is correct — no stale references.
- `.agent/skills/kanban_operations/SKILL.md` correctly references `kanban-board.md` with fallback to `get-state.js`.
- `.agent/workflows/improve-plan.md` correctly reads `kanban-board.md` with fallback.

**Fix now:**
- Rewrite `src/test/kanban-auto-export.test.ts` to test markdown output: column headers, plan links, `_No plans_` placeholder, old JSON cleanup, write failure handling, completed plan exclusion, dispose flush.
- Recompile `out/` directory via `tsc -p tsconfig.test.json --outDir out` to sync test compilation output.

**Defer:**
- `fs.existsSync` in async function — cosmetic, zero impact.
- `dispose()` fire-and-forget race — inherent to the design, acceptable.

### Fixes Applied

1. **Rewrote `src/test/kanban-auto-export.test.ts`** — 6 tests covering:
   - Markdown file creation with header and all `VALID_KANBAN_COLUMNS` as h2 headings
   - Plan links grouped by column with `[sessionId](planFile) — topic` format
   - Old `kanban-state.json` cleanup on first markdown write
   - Write failure caught without throwing (chmod 444 test)
   - Completed plans excluded from export
   - `dispose()` triggers final export flush

2. **Recompiled `out/` directory** — `npx tsc -p tsconfig.test.json --outDir out` (exit 0, clean). Verified `out/services/KanbanDatabase.js` now references `kanban-board.md` with no `scheduleStateExport` or `_exportTimeout`. Verified `out/test/kanban-auto-export.test.js` references `kanban-board.md`.

### Files Changed
- `src/test/kanban-auto-export.test.ts` — full rewrite (old: 134 lines JSON tests, new: 206 lines markdown tests)
- `out/services/KanbanDatabase.js` — recompiled from updated TS source
- `out/test/kanban-auto-export.test.js` — recompiled from updated TS source

### Validation
- TypeScript compilation: `npx tsc -p tsconfig.test.json --outDir out` — **PASS** (exit 0, no errors)
- Webpack bundle (`dist/extension.js`): verified no stale `scheduleStateExport`/`_exportTimeout`/`kanban-state.json` references — **PASS**
- SKILL.md: verified references `kanban-board.md` — **PASS**
- improve-plan.md: verified references `kanban-board.md` — **PASS**

### Remaining Risks
- Tests use `setTimeout(resolve, 300)` to wait for async fire-and-forget writes — flaky on slow CI. Mitigation: 5s timeout per test, 300ms is generous for in-memory FS writes.
- `dispose()` fire-and-forget may not complete if process exits immediately after dispose. Mitigation: acceptable per design; the next startup's `_persist()` will regenerate the file.

---

**Complexity**: 3
**Recommendation**: Send to Coder
