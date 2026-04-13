# Fix Custom Lane Import/Reset Round-Tripping

## Goal
Preserve configured custom Kanban lane IDs in the plan-file `## Switchboard State` footer so `switchboard.resetKanbanDb` can rebuild the database into the same custom lane instead of silently falling back to `CREATED`. Keep the existing markdown footer format, duplicate-state protections, and current write paths intact while extending import-time validation to workspace-defined lanes.

## Metadata
**Tags:** backend, bugfix
**Complexity:** 6

## User Review Required
> [!NOTE]
> - **Clarification:** the verified reset path is `src/extension.ts:1140-1164` → `importPlanFiles()` in `src/services/PlanFileImporter.ts`; the draft's `ArchiveManager.ts` and `PlanPersistenceService.ts` do not exist in this repo.
> - **Clarification:** the repo already persists state in a markdown footer via `applyKanbanStateToPlanContent()` / `writePlanStateToFile()` (`src/services/planStateUtils.ts:167-229`), including `**Last Updated:**` and `**Format Version:**`. Do not replace that with YAML front matter; extend validation around the existing footer shape.
> - **Clarification:** `TaskViewerProvider._updateKanbanColumnForSession()` and `KanbanProvider._schedulePlanStateWrite()` already pass the resolved column ID directly into `writePlanStateToFile()` (`src/services/TaskViewerProvider.ts:1092-1113`, `src/services/KanbanProvider.ts:37-58`). The missing durability is import-time parsing/validation plus regression coverage that locks the current write behavior.
> - **Clarification:** current `.switchboard/state.json` in this repo has `customAgents: []` and no `customKanbanColumns`, so automated coverage must build a synthetic workspace state file with a user-defined lane rather than depending on live repo state.
> - **Clarification:** round-tripping only applies when the referenced custom lane still exists in `.switchboard/state.json`. Auto-creating missing lanes from a footer string would be a net-new product behavior and is out of scope for this bugfix.

## Complexity Audit
### Routine
- Parameterize `inspectKanbanState()` / `extractKanbanState()` so import-time callers can validate a footer against workspace-specific lane IDs instead of the current hard-coded built-in list.
- Load custom lane definitions once from `.switchboard/state.json` in `PlanFileImporter.ts` using the already-shipped `parseCustomKanbanColumns()`, `parseCustomAgents()`, and `buildKanbanColumns()` helpers from `src/services/agentConfig.ts`.
- Add an end-to-end regression that writes a custom lane footer, resets/reimports through `importPlanFiles()`, and asserts the same `custom_column_*` ID survives.
- Lock the already-correct write paths in `TaskViewerProvider.ts` and `KanbanProvider.ts` via source assertions so future refactors do not re-alias custom lane IDs back to built-in columns.

### Complex / Risky
- `src/services/planStateUtils.ts` is already shared with the duplicate-state fix. Extending validation must not regress the current top-level-section scan, preserved-draft safety, or footer rewrite behavior.
- If import-time validation becomes “accept any string”, malformed footer values will masquerade as real lanes and create ghost states that are not present in `.switchboard/state.json`.
- `buildKanbanColumns()` does not emit `BACKLOG` or the legacy `CODED` alias, so the importer's allowed-column set must merge current built-in compatibility values with configured custom lanes rather than blindly trusting one helper.
- The live repo state currently contains no custom lanes, so a lazy regression can pass without actually covering the failure scenario. The test must synthesize both `state.json` and plan-file content.

## Edge-Case & Dependency Audit
- **Race Conditions:** `KanbanProvider.ts` debounces `_schedulePlanStateWrite()` and `TaskViewerProvider.ts` writes the footer after `db.updateColumn()`. `switchboard.resetKanbanDb` can therefore read a plan file while footers are actively changing. The importer should load the allowed lane set once per `importPlanFiles()` call and keep the top-level footer scan deterministic so partial edits still fall back predictably to `CREATED` / `active`.
- **Security:** Keep the existing workspace-root safety in `writePlanStateToFile()` untouched. Import should only accept lane IDs present in the built-in compatibility set or the sanitized `buildKanbanColumns(...)` result from `.switchboard/state.json`; it must not invent new columns or trust arbitrary footer strings.
- **Side Effects:** Preserve the existing `## Switchboard State` footer shape, `**Last Updated:**` / `**Format Version:**` fields, legacy `CODED` compatibility, and the preserved-draft protections already enforced by `planStateUtils.ts`. ClickUp/Linear-generated plans that only use built-in columns must continue importing exactly as they do now.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` shows no active **New** work. Active **Planned** work is this plan, `Fix Duplicate Switchboard State Parsing Bug`, `Extend Event Monitoring and Ticket Write-Back to Linear`, and `Remove ClickUp Automation Technical Debt`. The direct dependency/conflict is `Fix Duplicate Switchboard State Parsing Bug`: it already targets the same `src/services/planStateUtils.ts` / `src/services/PlanFileImporter.ts` parser surface, so this plan must build on that top-level-section scan rather than reintroducing first-match regex logic. `Remove ClickUp Automation Technical Debt` is a real merge hotspot because it also edits `src/services/PlanFileImporter.ts`, but it is not a blocker if the import-loop changes are merged carefully. There is no verified dependency on `Extend Event Monitoring and Ticket Write-Back to Linear` if this fix stays out of `LinearSyncService.ts` / automation wiring. A `.switchboard/plans` scan also confirms `add_kanban_column_management.md` explicitly deferred “cross-reset/import round-tripping for non-built-in lane IDs” and `fix_plan_appearing_in_multiple_columns_bug.md` focuses on duplicate local rows in `TaskViewerProvider.ts` / `KanbanDatabase.ts`, so the former is historical follow-up context and the latter is not a direct dependency.

## Adversarial Synthesis
### Grumpy Critique
The original draft was trying to solve a Markdown-footer bug by hallucinating a brand-new storage format and two services that do not even exist. Spectacular. This repo does not use YAML front matter for Kanban state; it uses a `## Switchboard State` footer written by `writePlanStateToFile()`, and that writer already accepts whatever column ID the board hands it. The real failure is embarrassingly specific: import-time validation still thinks only the old built-in columns exist, so a perfectly real `custom_column_*` footer is treated like a typo and dumped back into `CREATED`.

And no, the answer is not “just accept any string” or “recreate the missing lane from the footer.” That is how you turn one round-trip bug into a durable configuration-corruption machine. Custom lanes live in `.switchboard/state.json`, not in a magic markdown séance. If the importer does not validate against the configured board model, it will either reject legitimate custom lanes or bless garbage lanes. Pick your poison.

### Balanced Response
The corrected plan keeps the existing footer format and narrows the fix to the actual broken contract: `PlanFileImporter.ts` must validate footer column IDs against the workspace's configured Kanban lanes, not just a hard-coded built-in set. `planStateUtils.ts` stays responsible for finding the authoritative top-level footer; `PlanFileImporter.ts` becomes responsible for supplying the right allowed columns for this workspace.

The plan also avoids unnecessary production churn on the write side. The current writers in `TaskViewerProvider.ts` and `KanbanProvider.ts` already pass raw column IDs into `writePlanStateToFile()`, so the implementation only needs regression coverage to keep that true. The new test then exercises the full round trip: configured custom lane survives reset/import, unknown lane still falls back safely, and the parser does not regress into “accept any footer string” behavior.

## Agent Recommendation

Send to Coder

## Execution Summary

**Status:** Completed
**Executed:** April 13, 2026

### Files Changed
- **src/services/planStateUtils.ts**
  - Added `KanbanStateInspectionOptions` interface with optional `validColumns` parameter
  - Added `lastSeenColumn` field to `KanbanStateInspection` interface for better error reporting
  - Split `parseStateSectionBody` into `extractStateSectionFields` (field extraction) and `parseStateSectionBody` (validation with column set)
  - Added `resolveValidColumns` helper to merge default built-in columns with custom columns
  - Updated `inspectKanbanState` and `extractKanbanState` to accept optional `KanbanStateInspectionOptions`
  - Changed `SwitchboardStateSection` interface to use `fields` instead of `parsedState` for separation of concerns

- **src/services/PlanFileImporter.ts**
  - Added imports for `buildKanbanColumns`, `parseCustomAgents`, `parseCustomKanbanColumns` from agentConfig
  - Removed unused `extractKanbanState` import
  - Added call to `readImportableKanbanColumns` to load workspace-specific lane definitions
  - Updated `inspectKanbanState` call to pass `validColumns` parameter
  - Improved warning message to include the specific column ID that failed validation
  - Added `readImportableKanbanColumns` helper function that:
    - Reads `.switchboard/state.json` to get custom lane configurations
    - Parses custom agents and custom kanban columns using existing helpers
    - Builds the full column set using `buildKanbanColumns`
    - Adds legacy compatibility columns (`BACKLOG`, `CODED`)
    - Returns a Set of valid column IDs for validation

- **src/test/custom-lane-roundtrip-regression.test.js** (NEW)
  - Created comprehensive regression test that:
    - Asserts TaskViewerProvider and KanbanProvider pass raw column IDs to footer writer
    - Creates synthetic workspace with custom lane in state.json
    - Tests configured custom lane round-tripping through import/reset
    - Tests unknown custom lane falls back to CREATED
    - Validates the full write → import → database flow

### Validation Results
All verification tests passed:
- ✅ `npm run compile` - Webpack build successful
- ✅ `npm run compile-tests` - TypeScript compilation successful
- ✅ `node src/test/duplicate-switchboard-state-regression.test.js` - Passed (confirms no regression to duplicate-state fix)
- ✅ `node src/test/custom-lane-roundtrip-regression.test.js` - Passed (new test validates custom lane round-tripping)
- ✅ `node src/test/kanban-custom-column-dispatch-regression.test.js` - Passed (confirms no regression to existing custom column dispatch)

### Implementation Notes
- The implementation preserves the existing markdown footer format exactly as specified
- No changes were made to the write paths (TaskViewerProvider.ts, KanbanProvider.ts) as they already pass raw column IDs correctly
- The fix is narrowly scoped to import-time validation in PlanFileImporter.ts
- Legacy column IDs (`BACKLOG`, `CODED`) are explicitly added for backward compatibility
- The solution validates against the configured workspace state, not arbitrary strings, preventing configuration corruption
- The test uses synthetic workspace state to ensure coverage regardless of the live repo's configuration

### Remaining Risks
None identified. The implementation follows the plan exactly, all tests pass, and the changes are minimal and focused on the specific bug without affecting other functionality.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Keep the state format as the existing markdown footer. The implementation should extend workspace-aware validation around `inspectKanbanState()` / `importPlanFiles()`, then add regression coverage that proves the current write paths already emit the exact custom lane ID.

### High Complexity

#### 1. Make footer parsing workspace-aware without changing the footer format
##### [MODIFY] `src/services/planStateUtils.ts`
- **Context:** This file already owns the authoritative `## Switchboard State` scan and the footer rewrite helper. The duplicate-state fix has moved it away from naive first-match regexes, but its validation still hard-codes built-in columns only. That is why `custom_column_*` and `custom_agent_*` footers can be written yet still fail import.
- **Logic:**
  1. Keep `collectTopLevelSwitchboardStateSections()` and `stripTrailingSwitchboardStateSections()` responsible only for finding/removing live footer blocks; do not entangle them with workspace config.
  2. Add an exported `KanbanStateInspectionOptions` type with an optional `validColumns` iterable.
  3. Split “extract raw footer fields” from “validate footer fields” so callers can pass a workspace-aware allow-list while the scanner itself remains deterministic.
  4. Preserve the default behavior for existing callers: if no `validColumns` are supplied, built-in compatibility values remain valid, so the duplicate-state regression keeps its current semantics.
  5. Surface the last seen raw footer column for importer warnings, but keep `applyKanbanStateToPlanContent()` unchanged so save-time format stays the same.
- **Implementation:**

```diff
--- a/src/services/planStateUtils.ts
+++ b/src/services/planStateUtils.ts
@@
 export interface KanbanStateInspection {
     state: KanbanStateFields | null;
     topLevelSectionCount: number;
+    lastSeenColumn: string | null;
 }
 
+export interface KanbanStateInspectionOptions {
+    validColumns?: Iterable<string>;
+}
+
 interface SwitchboardStateSection {
     start: number;
     end: number;
     body: string;
-    parsedState: KanbanStateFields | null;
+    fields: {
+        kanbanColumn: string | null;
+        status: string | null;
+    };
 }
 
-const VALID_COLUMNS = new Set([
+const DEFAULT_VALID_COLUMNS = new Set([
     'CREATED', 'BACKLOG', 'PLANNED', 'TEAM LEAD CODED', 'INTERN CODED', 'CODER CODED',
     'LEAD CODED', 'CODE REVIEWED', 'ACCEPTANCE TESTED', 'CODED', 'PLAN REVIEWED', 'COMPLETED'
 ]);
@@
-function parseStateSectionBody(sectionBody: string): KanbanStateFields | null {
+function extractStateSectionFields(sectionBody: string): { kanbanColumn: string | null; status: string | null } {
     const columnMatch = sectionBody.match(/\*\*Kanban Column:\*\*\s*(.+)/);
     const statusMatch = sectionBody.match(/\*\*Status:\*\*\s*(.+)/);
 
-    const kanbanColumn = columnMatch?.[1]?.trim();
-    const status = statusMatch?.[1]?.trim();
+    return {
+        kanbanColumn: columnMatch?.[1]?.trim() || null,
+        status: statusMatch?.[1]?.trim() || null
+    };
+}
 
-    if (!kanbanColumn || !VALID_COLUMNS.has(kanbanColumn)) {
-        return null;
+function resolveValidColumns(options?: KanbanStateInspectionOptions): Set<string> {
+    const resolved = new Set(DEFAULT_VALID_COLUMNS);
+    if (!options?.validColumns) {
+        return resolved;
     }
+    for (const value of options.validColumns) {
+        const normalized = String(value || '').trim();
+        if (normalized) {
+            resolved.add(normalized);
+        }
+    }
+    return resolved;
+}
 
+function parseStateSectionBody(
+    sectionBody: string,
+    validColumns: Set<string>
+): KanbanStateFields | null {
+    const { kanbanColumn, status } = extractStateSectionFields(sectionBody);
+    if (!kanbanColumn || !validColumns.has(kanbanColumn)) {
+        return null;
+    }
     return {
         kanbanColumn,
         status: status === 'completed' ? 'completed' : 'active'
@@
         sections.push({
             start,
             end,
             body,
-            parsedState: parseStateSectionBody(body)
+            fields: extractStateSectionFields(body)
         });
     }
@@
-export function inspectKanbanState(content: string): KanbanStateInspection {
+export function inspectKanbanState(
+    content: string,
+    options?: KanbanStateInspectionOptions
+): KanbanStateInspection {
     const sections = collectTopLevelSwitchboardStateSections(content);
+    const validColumns = resolveValidColumns(options);
     for (let i = sections.length - 1; i >= 0; i--) {
-        if (sections[i].parsedState) {
+        const parsedState = parseStateSectionBody(sections[i].body, validColumns);
+        if (parsedState) {
             return {
-                state: sections[i].parsedState,
-                topLevelSectionCount: sections.length
+                state: parsedState,
+                topLevelSectionCount: sections.length,
+                lastSeenColumn: sections[i].fields.kanbanColumn
             };
         }
     }
 
     return {
         state: null,
-        topLevelSectionCount: sections.length
+        topLevelSectionCount: sections.length,
+        lastSeenColumn: sections.length > 0 ? sections[sections.length - 1].fields.kanbanColumn : null
     };
 }
 
-export function extractKanbanState(content: string): KanbanStateFields | null {
-    return inspectKanbanState(content).state;
+export function extractKanbanState(
+    content: string,
+    options?: KanbanStateInspectionOptions
+): KanbanStateFields | null {
+    return inspectKanbanState(content, options).state;
 }
```

- **Edge Cases Handled:** This keeps the duplicate-state scan deterministic, preserves fenced-code / preserved-draft safety, and avoids a format migration. Unknown footer values still stay invalid by default unless the caller explicitly expands the allowed lane set.

#### 2. Validate imported footer columns against `.switchboard/state.json` instead of the built-in-only list
##### [MODIFY] `src/services/PlanFileImporter.ts`
- **Context:** `switchboard.resetKanbanDb` calls `importPlanFiles()` after deleting the local DB. This file is therefore the recovery path that decides whether a written footer survives reset. It already imports `inspectKanbanState(content)` for built-in lanes; it now needs to supply the workspace's configured custom lane IDs before iterating plan files.
- **Logic:**
  1. Read `.switchboard/state.json` once near the top of `importPlanFiles()`.
  2. Use existing helpers from `src/services/agentConfig.ts` — `parseCustomAgents()`, `parseCustomKanbanColumns()`, and `buildKanbanColumns()` — to build the authoritative lane ID set for this workspace.
  3. Add legacy compatibility values that are intentionally not emitted by `buildKanbanColumns()` (`BACKLOG`, `CODED`) so older plan files still recover correctly.
  4. Pass that set into `inspectKanbanState(content, { validColumns })`.
  5. If a footer exists but its lane is not importable in this workspace, warn and fall back to `CREATED` / `active` rather than inventing a new lane definition on the fly.
- **Implementation:**

```diff
--- a/src/services/PlanFileImporter.ts
+++ b/src/services/PlanFileImporter.ts
@@
 import * as fs from 'fs';
 import * as crypto from 'crypto';
 import * as path from 'path';
+import { buildKanbanColumns, parseCustomAgents, parseCustomKanbanColumns } from './agentConfig';
 import { KanbanDatabase, KanbanPlanRecord, KanbanPlanStatus } from './KanbanDatabase';
-import { extractKanbanState, inspectKanbanState } from './planStateUtils';
+import { inspectKanbanState } from './planStateUtils';
@@
 export async function importPlanFiles(workspaceRoot: string): Promise<number> {
     const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
     if (!fs.existsSync(plansDir)) {
         return 0;
     }
@@
     const db = KanbanDatabase.forWorkspace(workspaceRoot);
     const ready = await db.ensureReady();
     if (!ready) {
         return 0;
     }
+
+    const validKanbanColumns = await readImportableKanbanColumns(workspaceRoot);
@@
-        const embeddedStateInspection = inspectKanbanState(content);
+        const embeddedStateInspection = inspectKanbanState(content, { validColumns: validKanbanColumns });
         const embeddedState = embeddedStateInspection.state;
         if (embeddedStateInspection.topLevelSectionCount > 1) {
             console.warn(
                 `[PlanFileImporter] Detected ${embeddedStateInspection.topLevelSectionCount} top-level Switchboard State sections in ${planFileNormalized}; using the last valid section.`
             );
         } else if (!embeddedState && embeddedStateInspection.topLevelSectionCount > 0) {
             console.warn(
-                `[PlanFileImporter] Found top-level Switchboard State section(s) in ${planFileNormalized} but none were valid; defaulting to CREATED/active.`
+                `[PlanFileImporter] Found top-level Switchboard State section(s) in ${planFileNormalized} but '${embeddedStateInspection.lastSeenColumn || 'unknown'}' is not importable in this workspace; defaulting to CREATED/active.`
             );
         }
@@
 }
+
+async function readImportableKanbanColumns(workspaceRoot: string): Promise<Set<string>> {
+    const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
+    let customAgents: unknown[] = [];
+    let customKanbanColumns: unknown[] = [];
+
+    try {
+        if (fs.existsSync(statePath)) {
+            const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
+            customAgents = Array.isArray(state.customAgents) ? state.customAgents : [];
+            customKanbanColumns = Array.isArray(state.customKanbanColumns) ? state.customKanbanColumns : [];
+        }
+    } catch (error) {
+        console.warn('[PlanFileImporter] Failed to read custom kanban column config from state.json:', error);
+    }
+
+    const validColumns = new Set(
+        buildKanbanColumns(
+            parseCustomAgents(customAgents),
+            parseCustomKanbanColumns(customKanbanColumns)
+        ).map((column) => column.id)
+    );
+
+    validColumns.add('BACKLOG');
+    validColumns.add('CODED');
+
+    return validColumns;
+}
```

- **Edge Cases Handled:** Import stays strict enough to reject stale or deleted custom lanes, but it stops rejecting legitimate `custom_column_*` / `custom_agent_*` IDs that are still configured in `state.json`. Reading the config once avoids per-file inconsistency if the user edits setup during a reset/import.

### Low Complexity

#### 3. Add a real round-trip regression that proves both the write side and the reset/import side preserve custom lane IDs
##### [CREATE] `src/test/custom-lane-roundtrip-regression.test.js`
- **Context:** Existing regressions already prove duplicate top-level `## Switchboard State` handling and source-level custom-column dispatch persistence, but there is no end-to-end test that a written custom lane footer survives a DB rebuild from plan files.
- **Logic:**
  1. Read `src/services/TaskViewerProvider.ts` and `src/services/KanbanProvider.ts` as source text and assert they still call `writePlanStateToFile()` with the resolved column ID rather than remapping to a built-in lane label.
  2. Create a synthetic workspace with `.switchboard/state.json` containing one `customKanbanColumns` entry so the test does not depend on the repo's live state.
  3. Create one plan file, use `writePlanStateToFile()` to persist `custom_column_docs_ready`, and confirm the footer contains the exact ID.
  4. Create a second plan file whose footer references an unknown custom column to prove importer validation is not “accept any string.”
  5. Run `importPlanFiles(workspaceRoot)` and assert the configured custom lane round-trips while the missing lane safely falls back to `CREATED`.
- **Implementation:**

```diff
*** Add File: src/test/custom-lane-roundtrip-regression.test.js
+'use strict';
+
+const assert = require('assert');
+const fs = require('fs');
+const os = require('os');
+const path = require('path');
+
+const {
+    applyKanbanStateToPlanContent,
+    writePlanStateToFile
+} = require(path.join(process.cwd(), 'out', 'services', 'planStateUtils.js'));
+const { importPlanFiles } = require(path.join(process.cwd(), 'out', 'services', 'PlanFileImporter.js'));
+const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
+
+const taskViewerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
+const kanbanProviderSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
+
+function buildPlanContent(title, sessionId) {
+    return [
+        `# ${title}`,
+        '',
+        '## Goal',
+        'Verify custom lane round-tripping through plan-file-only import/reset recovery.',
+        '',
+        `**Plan ID:** ${sessionId}`,
+        `**Session ID:** ${sessionId}`,
+        ''
+    ].join('\n');
+}
+
+async function run() {
+    assert.match(
+        taskViewerSource,
+        /writePlanStateToFile\([\s\S]*column,\s*column === 'COMPLETED' \? 'completed' : 'active'[\s\S]*\);/s,
+        'Expected TaskViewerProvider to persist the exact resolved column id to the plan footer.'
+    );
+    assert.match(
+        kanbanProviderSource,
+        /_schedulePlanStateWrite\([\s\S]*normalizedColumn,\s*normalizedColumn === 'COMPLETED' \? 'completed' : 'active'[\s\S]*\);/s,
+        'Expected KanbanProvider to persist normalized board column ids without snapping custom lanes back to a built-in alias.'
+    );
+
+    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-custom-lane-'));
+    try {
+        const switchboardDir = path.join(workspaceRoot, '.switchboard');
+        const plansDir = path.join(switchboardDir, 'plans');
+        await fs.promises.mkdir(plansDir, { recursive: true });
+        await fs.promises.writeFile(
+            path.join(switchboardDir, 'state.json'),
+            JSON.stringify({
+                customAgents: [],
+                customKanbanColumns: [
+                    {
+                        id: 'custom_column_docs_ready',
+                        label: 'Docs Ready',
+                        role: 'coder',
+                        triggerPrompt: 'Polish the docs handoff.',
+                        order: 250,
+                        dragDropMode: 'cli'
+                    }
+                ]
+            }, null, 2),
+            'utf8'
+        );
+
+        const configuredPlanPath = path.join(plansDir, 'custom-lane-roundtrip.md');
+        await fs.promises.writeFile(
+            configuredPlanPath,
+            buildPlanContent('Custom Lane Roundtrip Fixture', 'custom-lane-roundtrip'),
+            'utf8'
+        );
+        await writePlanStateToFile(configuredPlanPath, workspaceRoot, 'custom_column_docs_ready', 'active');
+
+        const configuredContent = await fs.promises.readFile(configuredPlanPath, 'utf8');
+        assert.ok(
+            configuredContent.includes('**Kanban Column:** custom_column_docs_ready'),
+            'Expected footer writer to persist the exact custom column id.'
+        );
+
+        const missingPlanPath = path.join(plansDir, 'missing-custom-lane.md');
+        await fs.promises.writeFile(
+            missingPlanPath,
+            applyKanbanStateToPlanContent(
+                buildPlanContent('Missing Custom Lane Fixture', 'missing-custom-lane'),
+                {
+                    kanbanColumn: 'custom_column_deleted_lane',
+                    status: 'active',
+                    lastUpdated: '2026-01-01T00:00:00.000Z',
+                    formatVersion: 1
+                }
+            ),
+            'utf8'
+        );
+
+        const imported = await importPlanFiles(workspaceRoot);
+        assert.strictEqual(imported, 2, 'Expected importPlanFiles to ingest both custom-lane fixtures.');
+
+        const db = KanbanDatabase.forWorkspace(workspaceRoot);
+        const ready = await db.ensureReady();
+        assert.strictEqual(ready, true, 'Expected KanbanDatabase to initialize for custom-lane regression coverage.');
+
+        const configuredPlan = await db.getPlanBySessionId('custom-lane-roundtrip');
+        assert.ok(configuredPlan, 'Expected configured custom-lane fixture to be imported.');
+        assert.strictEqual(
+            configuredPlan?.kanbanColumn,
+            'custom_column_docs_ready',
+            'Expected configured custom column ids to survive reset/import round-tripping.'
+        );
+
+        const missingPlan = await db.getPlanBySessionId('missing-custom-lane');
+        assert.ok(missingPlan, 'Expected missing-lane fixture to be imported.');
+        assert.strictEqual(
+            missingPlan?.kanbanColumn,
+            'CREATED',
+            'Expected unknown custom column ids not present in state.json to fall back to CREATED.'
+        );
+    } finally {
+        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
+        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
+    }
+
+    console.log('custom lane roundtrip regression test passed');
+}
+
+run().catch((error) => {
+    console.error('custom lane roundtrip regression test failed:', error);
+    process.exit(1);
+});
```

- **Edge Cases Handled:** The regression proves the real bug and its safety boundary at the same time: configured custom lanes round-trip, missing lanes do not get silently re-created, and the already-correct footer writers stay locked to raw column IDs.

## Verification Plan
### Automated Tests
- `npm run compile`
- `node src/test/duplicate-switchboard-state-regression.test.js`
- `node src/test/custom-lane-roundtrip-regression.test.js`
- `node src/test/kanban-custom-column-dispatch-regression.test.js`

### Manual Verification Steps
- In the setup panel, add a user-defined custom Kanban column so `.switchboard/state.json` contains a `customKanbanColumns` entry.
- Move any local plan into that custom lane and confirm the plan file footer ends with `**Kanban Column:** custom_column_<...>` rather than a built-in alias.
- Run `Switchboard: Reset Kanban Database`.
- Confirm the card reappears in the same custom lane after the board rebuild.
- Remove the custom lane from setup, reset the DB again, and confirm the importer warns and falls back to `CREATED` instead of silently inventing a ghost lane.

## Preserved Original Draft (Verbatim)
````markdown
# Fix Custom Lane Import/Reset Round-Tripping

## Problem

Custom kanban lane IDs survive in the DB but are lost during import/reset operations that rebuild state from plan files. The plan-file footer only persists built-in Switchboard State values (e.g., `CODED`, `REVIEWED`), not user-authored custom lane IDs.

## Impact

- Custom lanes appear to work until a DB reset/import occurs
- Plans silently revert to built-in states or get stuck in unmapped columns
- Breaks the invariant that plan files are the source of truth for recovery

## Root Cause

The plan-state footer parser and importer only recognize the canonical lane set. Custom lane IDs are treated as opaque strings in the DB but never serialized to the plan file, so they have no recovery path.

## Fix

### 1. Extend Plan State Schema

Update the footer format to support arbitrary lane IDs:

```yaml
---
state: custom-lane-id-here
---
```

Keep backward compatibility: built-in states still use short names, custom lanes use full IDs.

### 2. Update Importer Path

In `planStateUtils.ts` and `ArchiveManager.ts`:
- Parse custom lane IDs from footer state field
- Validate against `setup.kanban.columns` schema on import
- Map to internal column IDs (create if missing, warn if conflicting)

### 3. Update Exporter Path

Ensure `savePlan()` and `updatePlanState()` persist the actual column ID, not just the canonical state alias.

### 4. Regression Test

Add `custom-lane-roundtrip-regression.test.js`:
1. Create plan with custom lane assignment
2. Export to plan file
3. Reset DB / re-import
4. Assert plan lands in correct custom column

## Files to Touch

- `src/services/planStateUtils.ts` - parser, validator, writer
- `src/services/ArchiveManager.ts` - import path
- `src/services/PlanPersistenceService.ts` - export path
- `src/services/KanbanProvider.ts` - column validation helper
- `src/test/custom-lane-roundtrip-regression.test.js` - new test

## Deferred Dependencies

None. This fix is self-contained within the plan-state/import model.

## Validation

- `npm run compile`
- `node src/test/custom-lane-roundtrip-regression.test.js`
- Manual: create custom lane → move plan → reset DB → verify plan position
````

## Direct Reviewer Pass (2026-04-13, In-Place Review)

### Stage 1 - Grumpy Principal Engineer
- [NIT] The fix does the real job, but the regression only proves a custom **user** lane. The importer now builds its valid-column set from both custom user lanes and custom agent lanes, so we are still trusting shared plumbing rather than pinning the agent-backed variant with its own fixture.
- [NIT] The implementation is correct and the original draft was wrong. This repo does not need a magical new footer format; it needs the existing `writePlanStateToFile()` path plus workspace-aware import validation. The code got that right, even if the earlier draft did not.

### Stage 2 - Balanced Synthesis
- **Keep:** `PlanFileImporter.ts` now validates persisted footer column IDs against the workspace's configured Kanban surface instead of a stale built-in-only allowlist, and the writers still preserve the raw column ID on disk.
- **Fix now:** None. I did not find a material correctness defect in the implemented custom-lane import/reset path.
- **Defer:** Add one direct regression for a custom agent-backed lane so both branches of the importable-column builder are covered explicitly.

### Fixed Items
- None in reviewer pass.

### Files Changed
- No additional reviewer-pass code changes were required.
- Reviewed implementation remains centered on:
  - `src/services/planStateUtils.ts`
  - `src/services/PlanFileImporter.ts`
  - `src/test/custom-lane-roundtrip-regression.test.js`

### Validation Results
- `npm run compile` - **PASSED**
- `npm run compile-tests` - **PASSED**
- `node src/test/duplicate-switchboard-state-regression.test.js` - **PASSED**
- `node src/test/custom-lane-roundtrip-regression.test.js` - **PASSED**
- `node src/test/kanban-custom-column-dispatch-regression.test.js` - **PASSED**

### Remaining Risks
- Custom agent-backed lanes are still validated indirectly through shared importable-column plumbing rather than a dedicated end-to-end fixture.
