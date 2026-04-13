# Fix Duplicate Switchboard State Parsing Bug

## Goal
Fix plan ingestion so files with multiple literal `## Switchboard State` headings resolve to the correct authoritative Kanban state instead of letting the first regex match win. Preserve historical/preserved draft content while making both ingestion and save-time state rewriting deterministic.

## Metadata
**Tags:** backend, bugfix
**Complexity:** 6

## User Review Required
> [!NOTE]
> - This is a parser/write-path bugfix, not a product behavior change. The intended behavior after the fix is: the **last valid top-level** `## Switchboard State` section wins, while files with no valid top-level state section still default to `CREATED` / `active`.
> - **Clarification:** the verified fix surface is `src/services/planStateUtils.ts` plus ingestion coverage in `src/services/PlanFileImporter.ts`. `src/services/KanbanProvider.ts::_schedulePlanStateWrite()` and `src/services/TaskViewerProvider.ts::_updateKanbanColumnForSession()` already funnel writes through `writePlanStateToFile()`, so this bug does **not** need per-caller save-path edits. Current code search still does **not** justify changing `KanbanDatabase.ts` or any `_isLikelyPlanFile()` heuristic for this parser bug.
> - **Clarification:** duplicate literal headings inside preserved original drafts and fenced code blocks are part of the real problem. The parser must ignore fenced examples, and the writer must stop deleting everything from the first `## Switchboard State` match to EOF.
> - **Clarification:** the repo already contains multi-state plan files such as `.switchboard/plans/remove_clickup_automation_debt.md` and `.switchboard/plans/flexible_clickup_column_mapping.md`, so verification should include real-world preserved-draft shapes, not only a synthetic two-section markdown file.

## Complexity Audit
### Routine
- Extend `src/test/duplicate-switchboard-state-regression.test.js` coverage for duplicate top-level state sections, fenced preserved-draft state examples, and malformed trailing state sections.
- Keep the existing fallback semantics in `PlanFileImporter.ts`: when no valid top-level state section exists, imported plans still default to `CREATED` / `active`.
- Add a narrow ingestion warning in `PlanFileImporter.ts` when top-level duplicate or malformed state sections are detected, so fallback behavior stops being silent during investigation.

### Complex / Risky
- `src/services/planStateUtils.ts::extractKanbanState()` currently uses a single first-match regex, so it will happily read the wrong state block when earlier stale sections exist.
- `src/services/planStateUtils.ts::applyKanbanStateToPlanContent()` currently removes `/\n?## Switchboard State[\s\S]*$/`, which means a preserved original draft or fenced code sample containing that heading can cause save-time truncation from the first match to EOF.
- The fix must distinguish **authoritative top-level state sections** from historical examples inside fenced code blocks without introducing a parser that accidentally ignores the real footer or rewrites unrelated content.

## Edge-Case & Dependency Audit
- **Race Conditions:** `KanbanProvider.ts` debounces `writePlanStateToFile()` calls, and `PlanFileImporter.ts` may read files while users are editing them. The parser logic must therefore be deterministic on partial/ambiguous content: scan all top-level state sections, prefer the last valid one, and preserve the existing `CREATED` / `active` fallback when no valid section survives.
- **Security:** Keep all path-safety and workspace-root validation inside `writePlanStateToFile()` unchanged. This bugfix should not widen file-write scope or relax path checks.
- **Side Effects:** The write helper must preserve trailing plan content, preserved original drafts, and fenced code examples. The implementation should normalize only the live footer section(s); it must not erase historical examples embedded earlier in the file just because they contain the same heading text.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` succeeded. Active **New** plans: none. Active **Planned** items relevant to this fix are:
  - `Fix Custom Lane Import/Reset Round-Tripping` is the only real semantic dependency/conflict. That plan also wants to change `src/services/planStateUtils.ts` plus import/reset behavior so plan files can round-trip arbitrary custom lane IDs. This duplicate-state fix must stay scoped to deterministic duplicate-section parsing/writing with the current canonical-column validation, then that follow-on plan can extend the same helpers without reintroducing first-match parsing.
  - `Remove ClickUp Automation Technical Debt` is only a merge hotspot in `src/services/PlanFileImporter.ts`; it removes unrelated imported metadata (`Pipeline ID`, `Internal Plan`) but does not require different `## Switchboard State` semantics.
  - `Extend Event Monitoring and Ticket Write-Back to Linear` targets `KanbanDatabase.ts`, integration services, and Linear automation wiring. It does not overlap with `src/services/planStateUtils.ts` or footer parsing.
  - `.switchboard/plans/remove_clickup_automation_debt.md` and `.switchboard/plans/flexible_clickup_column_mapping.md` both already contain duplicate top-level `## Switchboard State` headings, so they are verified compatibility fixtures for manual regression review rather than hypothetical examples.
  - `switchboard-get_kanban_state` also shows this topic in **Lead Coder** (`sess_1776029097776`) while the plan file being edited is the **Planned** card (`sess_1776029097785`). Per the planning rule, Lead Coder is not part of the active dependency set, but reviewers should still key off the exact file path or session ID so the two tracks are not conflated.

## Adversarial Synthesis
### Grumpy Critique
This plan finally stopped waving at the wrong organs, but it still needed someone to say the quiet part loudly: the concurrency note was stale, the conflict scan was stale, and the caller surface was underspecified. `writePlanStateToFile()` is reached from both `src/services/KanbanProvider.ts` and `src/services/TaskViewerProvider.ts`; if the plan does not name that explicitly, somebody will “simplify” the wrong caller and call it architecture.

And do not pretend the active custom-lane plan is background scenery. `fix_custom_lane_import_roundtrip.md` wants to cut into the same `planStateUtils.ts` / import-reset seam. If this plan silently expands into arbitrary custom lane IDs now, that is scope creep in a fake moustache. If it ignores that overlap entirely, that is merge-conflict roulette. The job here is deterministic duplicate-section repair with current canonical validation — not a stealth footer-format redesign.

### Balanced Response
The revised plan now names the verified caller surface and the only real active semantic overlap. All plan-state writes still funnel through `writePlanStateToFile()` even though `KanbanProvider.ts` and `TaskViewerProvider.ts` trigger it, so the implementation can stay centered on `src/services/planStateUtils.ts` plus the importer/test harness instead of scattering parser logic across callers.

It also separates true dependencies from mere merge hotspots: `fix_custom_lane_import_roundtrip.md` is the follow-on schema/format change that must build on this deterministic parser/writer behavior, `remove_clickup_automation_debt.md` only overlaps in `PlanFileImporter.ts`, and `extend_automation_to_linear.md` is unrelated. That keeps scope tight: fix duplicate top-level parsing and footer rewriting, preserve current canonical-column validation, and verify against the real multi-state plan files already in the repo.

## Agent Recommendation

Send to Coder

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Do not spread this across unrelated services. The implementation should stay centered on `src/services/planStateUtils.ts`, with only the minimal importer/test changes needed to prove the parser and writer now behave correctly.

### Clarification - verified caller surface and fixture files
- `src/services/PlanFileImporter.ts` is the only verified ingestion path that converts markdown plan files into persisted board rows; its `inspectKanbanState()` result feeds the existing `CREATED` / `active` fallback.
- `src/services/KanbanProvider.ts::_schedulePlanStateWrite()` and `src/services/TaskViewerProvider.ts::_updateKanbanColumnForSession()` both already call `writePlanStateToFile()`, which is why save-path changes stay isolated to `src/services/planStateUtils.ts`.
- `src/services/ClickUpSyncService.ts` still emits the live footer in the current bold-markdown format (`## Switchboard State` plus `**Kanban Column:**` / `**Status:**`), so this plan must preserve that on-disk shape.
- `.switchboard/plans/remove_clickup_automation_debt.md` and `.switchboard/plans/flexible_clickup_column_mapping.md` are real repo fixtures with duplicate top-level state headings; use them as compatibility references during review instead of treating preserved-draft duplicates as a synthetic edge case.

### High Complexity

#### 1. Replace first-match regex parsing and EOF truncation with top-level section scanning
##### [MODIFY] `src/services/planStateUtils.ts`
- **Context:** This file owns both `extractKanbanState()` and `applyKanbanStateToPlanContent()`. Current code uses `content.match(/## Switchboard State.../)` for parsing and `content.replace(/\n?## Switchboard State[\s\S]*$/, '')` for writing, which is exactly why stale earlier sections win and why preserved original drafts can be truncated on save.
- **Logic:**
  1. Add a small internal scanner that walks the markdown line-by-line, tracks fenced code blocks, and records only **top-level** `## Switchboard State` sections that are outside fences.
  2. Parse every discovered section body and keep the **last valid** one as the authoritative state. This intentionally fixes both “first stale section wins” and “later malformed section should not erase an earlier valid one.”
  3. Add an exported inspection result so callers can tell whether they saw 0, 1, or multiple top-level state sections without reimplementing the scan logic.
  4. Replace the existing write helper’s `replace(...EOF)` logic with a function that removes only the trailing live state footer section(s), preserving earlier historical examples and any non-state content that follows older embedded headings.
  5. Preserve the original file’s line-ending style so the helper does not generate noisy CRLF/LF churn.
- **Implementation:**

```diff
--- a/src/services/planStateUtils.ts
+++ b/src/services/planStateUtils.ts
@@
 export interface KanbanStateFields {
     kanbanColumn: string;
     status: string;
 }
 
+export interface KanbanStateInspection {
+    state: KanbanStateFields | null;
+    topLevelSectionCount: number;
+}
+
+interface SwitchboardStateSection {
+    start: number;
+    end: number;
+    body: string;
+    parsedState: KanbanStateFields | null;
+}
+
 const VALID_COLUMNS = new Set([
     'CREATED', 'BACKLOG', 'PLANNED', 'TEAM LEAD CODED', 'INTERN CODED', 'CODER CODED',
     'LEAD CODED', 'CODE REVIEWED', 'ACCEPTANCE TESTED', 'CODED', 'PLAN REVIEWED', 'COMPLETED'
 ]);
+
+const FENCE_TOGGLE_RE = /^(```|~~~)/;
+const TOP_LEVEL_HEADING_RE = /^(##\s+|#\s+)/;
+const SWITCHBOARD_STATE_HEADING_RE = /^## Switchboard State\s*$/;
+
+function normalizeLineEndings(content: string): string {
+    return content.replace(/\r\n/g, '\n');
+}
+
+function restoreLineEndings(content: string, lineEnding: string): string {
+    return lineEnding === '\n' ? content : content.replace(/\n/g, lineEnding);
+}
+
+function parseStateSectionBody(sectionBody: string): KanbanStateFields | null {
+    const columnMatch = sectionBody.match(/\*\*Kanban Column:\*\*\s*(.+)/);
+    const statusMatch = sectionBody.match(/\*\*Status:\*\*\s*(.+)/);
+
+    const kanbanColumn = columnMatch?.[1]?.trim();
+    const status = statusMatch?.[1]?.trim();
+
+    if (!kanbanColumn || !VALID_COLUMNS.has(kanbanColumn)) {
+        return null;
+    }
+
+    return {
+        kanbanColumn,
+        status: status === 'completed' ? 'completed' : 'active'
+    };
+}
+
+function collectTopLevelSwitchboardStateSections(content: string): SwitchboardStateSection[] {
+    const normalized = normalizeLineEndings(content);
+    const lines = normalized.split('\n');
+    const lineStarts: number[] = [];
+    let offset = 0;
+
+    for (const line of lines) {
+        lineStarts.push(offset);
+        offset += line.length + 1;
+    }
+
+    const sections: SwitchboardStateSection[] = [];
+    let inFence = false;
+
+    for (let i = 0; i < lines.length; i++) {
+        const line = lines[i];
+        const trimmed = line.trim();
+
+        if (FENCE_TOGGLE_RE.test(trimmed)) {
+            inFence = !inFence;
+            continue;
+        }
+
+        if (inFence || !SWITCHBOARD_STATE_HEADING_RE.test(line)) {
+            continue;
+        }
+
+        let endLine = lines.length;
+        let sectionInFence = false;
+        for (let j = i + 1; j < lines.length; j++) {
+            const candidate = lines[j];
+            const candidateTrimmed = candidate.trim();
+
+            if (FENCE_TOGGLE_RE.test(candidateTrimmed)) {
+                sectionInFence = !sectionInFence;
+                continue;
+            }
+
+            if (!sectionInFence && TOP_LEVEL_HEADING_RE.test(candidate)) {
+                endLine = j;
+                break;
+            }
+        }
+
+        const start = lineStarts[i];
+        const end = endLine < lineStarts.length ? lineStarts[endLine] : normalized.length;
+        const bodyStart = Math.min(normalized.length, start + line.length + 1);
+        const body = normalized.slice(bodyStart, end);
+
+        sections.push({
+            start,
+            end,
+            body,
+            parsedState: parseStateSectionBody(body)
+        });
+    }
+
+    return sections;
+}
+
+function stripTrailingSwitchboardStateSections(content: string): string {
+    const normalized = normalizeLineEndings(content);
+    const sections = collectTopLevelSwitchboardStateSections(normalized);
+    if (sections.length === 0) {
+        return normalized.trimEnd();
+    }
+
+    let removalStart = -1;
+    let cursor = normalized.length;
+    for (let i = sections.length - 1; i >= 0; i--) {
+        const suffix = normalized.slice(sections[i].end, cursor);
+        if (suffix.trim().length > 0) {
+            break;
+        }
+        removalStart = sections[i].start;
+        cursor = sections[i].start;
+    }
+
+    if (removalStart !== -1) {
+        return normalized.slice(0, removalStart).trimEnd();
+    }
+
+    const last = sections[sections.length - 1];
+    return (normalized.slice(0, last.start) + normalized.slice(last.end)).trimEnd();
+}
 
 /**
  * Parses the `## Switchboard State` section from plan file content.
  * Returns null if the section is absent or cannot be parsed.
  */
-export function extractKanbanState(content: string): KanbanStateFields | null {
-    const sectionMatch = content.match(
-        /## Switchboard State\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/
-    );
-    if (!sectionMatch) {
-        return null;
-    }
-    const section = sectionMatch[1];
-
-    const columnMatch = section.match(/\*\*Kanban Column:\*\*\s*(.+)/);
-    const statusMatch = section.match(/\*\*Status:\*\*\s*(.+)/);
-
-    const kanbanColumn = columnMatch?.[1]?.trim();
-    const status = statusMatch?.[1]?.trim();
-
-    if (!kanbanColumn || !VALID_COLUMNS.has(kanbanColumn)) {
-        return null;
-    }
-
-    return {
-        kanbanColumn,
-        status: status === 'completed' ? 'completed' : 'active'
-    };
+export function inspectKanbanState(content: string): KanbanStateInspection {
+    const sections = collectTopLevelSwitchboardStateSections(content);
+    for (let i = sections.length - 1; i >= 0; i--) {
+        if (sections[i].parsedState) {
+            return {
+                state: sections[i].parsedState,
+                topLevelSectionCount: sections.length
+            };
+        }
+    }
+
+    return {
+        state: null,
+        topLevelSectionCount: sections.length
+    };
+}
+
+export function extractKanbanState(content: string): KanbanStateFields | null {
+    return inspectKanbanState(content).state;
 }
@@
 export function applyKanbanStateToPlanContent(
     content: string,
     state: KanbanStateFields & { lastUpdated: string; formatVersion: number }
 ): string {
-    const withoutState = content.replace(/\n?## Switchboard State[\s\S]*$/, '');
+    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
+    const withoutState = stripTrailingSwitchboardStateSections(content);
 
     const stateSection = [
         '## Switchboard State',
         `**Kanban Column:** ${state.kanbanColumn}`,
         `**Status:** ${state.status}`,
         `**Last Updated:** ${state.lastUpdated}`,
         `**Format Version:** ${state.formatVersion}`
     ].join('\n');
 
-    return withoutState.trimEnd() + '\n\n' + stateSection + '\n';
+    const rebuilt = withoutState.length > 0
+        ? withoutState + '\n\n' + stateSection + '\n'
+        : stateSection + '\n';
+    return restoreLineEndings(rebuilt, lineEnding);
 }
```
- **Edge Cases Handled:** This scanner ignores fenced preserved-draft examples, prefers the last valid top-level state when duplicates exist, keeps the zero-valid-state fallback path intact, and stops save-time truncation of everything after the first heading match.

### Low Complexity

#### 2. Surface ambiguous or malformed state fallback during import instead of staying silent
##### [MODIFY] `src/services/PlanFileImporter.ts`
- **Context:** The importer already owns the fallback from embedded state to `CREATED` / `active`. It is the right place to emit a narrow warning when duplicate or malformed top-level state sections are encountered during ingestion.
- **Logic:**
  1. Import the new inspection helper from `planStateUtils.ts`.
  2. Use the inspected state result for the actual column/status decision.
  3. Warn when more than one top-level section exists, or when top-level sections exist but none are valid. Keep the fallback behavior unchanged.
  4. Do **not** change `KanbanDatabase.ts`, `TaskViewerProvider.ts`, or `_isLikelyPlanFile()` here; they are not the parser.
- **Implementation:**

```diff
--- a/src/services/PlanFileImporter.ts
+++ b/src/services/PlanFileImporter.ts
@@
-import { extractKanbanState } from './planStateUtils';
+import { extractKanbanState, inspectKanbanState } from './planStateUtils';
@@
-        const embeddedState = extractKanbanState(content);
-        const kanbanColumn = embeddedState?.kanbanColumn ?? 'CREATED';
-        const status: KanbanPlanStatus = (embeddedState?.status === 'completed' ? 'completed' : 'active');
+        const embeddedStateInspection = inspectKanbanState(content);
+        const embeddedState = embeddedStateInspection.state;
+        if (embeddedStateInspection.topLevelSectionCount > 1) {
+            console.warn(
+                `[PlanFileImporter] Detected ${embeddedStateInspection.topLevelSectionCount} top-level Switchboard State sections in ${planFileNormalized}; using the last valid section.`
+            );
+        } else if (!embeddedState && embeddedStateInspection.topLevelSectionCount > 0) {
+            console.warn(
+                `[PlanFileImporter] Found top-level Switchboard State section(s) in ${planFileNormalized} but none were valid; defaulting to CREATED/active.`
+            );
+        }
+
+        const kanbanColumn = embeddedState?.kanbanColumn ?? 'CREATED';
+        const status: KanbanPlanStatus = embeddedState?.status === 'completed' ? 'completed' : 'active';
 ```
- **Edge Cases Handled:** Import remains backward compatible for legacy plans with no state section, while malformed or duplicated top-level state blocks stop looking like a mysterious silent default.

#### 3. Add end-to-end regression coverage for duplicate, malformed, and preserved-draft state shapes
##### [MODIFY] `src/test/duplicate-switchboard-state-regression.test.js`
- **Context:** The repo already contains `src/test/duplicate-switchboard-state-regression.test.js`, and it is the right single harness for this bug because it loads compiled modules from `out/` while covering both direct parsing and `importPlanFiles()` ingestion. Keep extending this file instead of creating a second overlapping duplicate-state regression.
- **Logic:**
  1. Keep importing `inspectKanbanState`, `extractKanbanState`, and `applyKanbanStateToPlanContent` from `out/services/planStateUtils.js`.
  2. Keep importer integration by loading `importPlanFiles` and `KanbanDatabase` from the compiled `out/services` tree.
  3. Verify that two real top-level state sections resolve to the last valid section.
  4. Verify that a malformed trailing section falls back to the last earlier valid section instead of nulling the parse.
  5. Verify that a fenced preserved-draft example containing `## Switchboard State` does **not** count as a live top-level section and survives `applyKanbanStateToPlanContent()`.
  6. Verify actual importer integration by importing a temp plan file with duplicate top-level state sections and asserting the DB row lands in the last valid column.
  7. Retain the source assertion proving the old `replace(/\n?## Switchboard State[\s\S]*$/, '')` truncation pattern is gone.
- **Implementation:**

```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    inspectKanbanState,
    extractKanbanState,
    applyKanbanStateToPlanContent
} = require(path.join(process.cwd(), 'out', 'services', 'planStateUtils.js'));
const { importPlanFiles } = require(path.join(process.cwd(), 'out', 'services', 'PlanFileImporter.js'));
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

async function run() {
    const duplicateTopLevelContent = [
        '# Duplicate Top-Level State Fixture',
        '',
        '## Goal',
        'Ensure duplicate top-level state sections resolve correctly.',
        '',
        '**Plan ID:** duplicate-state-top-level',
        '**Session ID:** duplicate-state-top-level',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** BACKLOG',
        '**Status:** active',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** PLAN REVIEWED',
        '**Status:** active',
        ''
    ].join('\n');

    const malformedTailContent = [
        '# Malformed Trailing State Fixture',
        '',
        '## Goal',
        'Ensure malformed trailing state does not erase an earlier valid state.',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** BACKLOG',
        '**Status:** active',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** NOT_A_REAL_COLUMN',
        '**Status:** active',
        ''
    ].join('\n');

    const preservedDraftContent = [
        '# Preserved Draft Fixture',
        '',
        '## Goal',
        'Ensure preserved draft content survives state rewrites.',
        '',
        '## Preserved Original Draft',
        '```markdown',
        '## Switchboard State',
        '',
        '**Kanban Column:** BACKLOG',
        '**Status:** active',
        '```',
        '',
        '## Notes',
        'This content must survive state rewrites.',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** CREATED',
        '**Status:** active',
        ''
    ].join('\n');

    const duplicateInspection = inspectKanbanState(duplicateTopLevelContent);
    assert.strictEqual(
        duplicateInspection.topLevelSectionCount,
        2,
        'Expected both real top-level Switchboard State sections to be counted.'
    );
    assert.strictEqual(
        duplicateInspection.state?.kanbanColumn,
        'PLAN REVIEWED',
        'Expected the last valid top-level Switchboard State section to win.'
    );
    assert.strictEqual(
        duplicateInspection.state?.status,
        'active',
        'Expected duplicate top-level state parsing to preserve active status.'
    );

    const malformedTrailingState = extractKanbanState(malformedTailContent);
    assert.strictEqual(
        malformedTrailingState?.kanbanColumn,
        'BACKLOG',
        'Expected parser to fall back to the last earlier valid top-level state when the trailing section is malformed.'
    );

    const preservedInspection = inspectKanbanState(preservedDraftContent);
    assert.strictEqual(
        preservedInspection.topLevelSectionCount,
        1,
        'Expected fenced preserved-draft state examples not to count as live top-level state sections.'
    );
    const rewrittenPreservedDraft = applyKanbanStateToPlanContent(preservedDraftContent, {
        kanbanColumn: 'PLAN REVIEWED',
        status: 'active',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        formatVersion: 1
    });
    assert.ok(
        rewrittenPreservedDraft.includes('```markdown\n## Switchboard State\n\n**Kanban Column:** BACKLOG\n**Status:** active\n```'),
        'Expected preserved original draft state examples inside fenced code to remain intact after rewriting the live footer.'
    );
    assert.ok(
        rewrittenPreservedDraft.trimEnd().endsWith([
            '## Switchboard State',
            '**Kanban Column:** PLAN REVIEWED',
            '**Status:** active',
            '**Last Updated:** 2026-01-01T00:00:00.000Z',
            '**Format Version:** 1'
        ].join('\n')),
        'Expected rewritten content to end with exactly one authoritative live Switchboard State footer.'
    );

    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-duplicate-state-'));
    try {
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        await fs.promises.mkdir(plansDir, { recursive: true });
        await fs.promises.writeFile(
            path.join(plansDir, 'duplicate-top-level.md'),
            duplicateTopLevelContent,
            'utf8'
        );

        const imported = await importPlanFiles(workspaceRoot);
        assert.strictEqual(imported, 1, 'Expected importPlanFiles to ingest the duplicate-state fixture.');

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'Expected KanbanDatabase to initialize for duplicate-state regression test.');

        const importedPlan = await db.getPlanBySessionId('duplicate-state-top-level');
        assert.ok(importedPlan, 'Expected imported duplicate-state fixture to be persisted.');
        assert.strictEqual(
            importedPlan?.kanbanColumn,
            'PLAN REVIEWED',
            'Expected importer to persist the column from the last valid top-level Switchboard State section.'
        );
        assert.strictEqual(
            importedPlan?.status,
            'active',
            'Expected importer to preserve active status from the last valid top-level Switchboard State section.'
        );
    } finally {
        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }

    const stateUtilsSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'planStateUtils.ts'),
        'utf8'
    );
    assert.doesNotMatch(
        stateUtilsSource,
        /content\.replace\(\/\\n\?## Switchboard State\[\\s\\S\]\*\$\/, ''\)/,
        'Expected applyKanbanStateToPlanContent() to stop stripping from the first Switchboard State match to EOF.'
    );

    console.log('duplicate switchboard state regression test passed');
}

run().catch((error) => {
    console.error('duplicate switchboard state regression test failed:', error);
    process.exit(1);
});
```
- **Edge Cases Handled:** This test guards both synthetic duplicates and the real preserved-draft shape already present in the repo, so future parser rewrites cannot quietly reintroduce first-match parsing or content-truncating footer replacement.

## Verification Plan
### Automated Tests
- `npm run compile`
- `npm run compile-tests`
- `node src/test/duplicate-switchboard-state-regression.test.js`
- **Clarification:** `npm run lint` currently fails at repo baseline because ESLint 9 cannot find an `eslint.config.*` file. Do not treat that existing repo issue as a regression from this fix.

### Manual Verification Steps
1. Create a scratch plan in `.switchboard/plans/` with two top-level `## Switchboard State` sections: an earlier `BACKLOG` section and a later `PLAN REVIEWED` section.
2. Refresh or re-import plans and verify the card lands in `PLAN REVIEWED`, not `BACKLOG`.
3. Create a second scratch plan whose preserved original draft contains a fenced markdown example with `## Switchboard State`, plus one live footer at the end.
4. Move that card to a different column in Kanban so `writePlanStateToFile()` runs.
5. Re-open the file and verify the preserved fenced draft still exists verbatim, the live footer was updated at the end, and no unrelated content after the preserved draft was removed.
6. Create a third scratch plan with an earlier valid state section and a malformed trailing state section; verify ingestion still uses the earlier valid state instead of defaulting to `CREATED` or hiding the card.

## Preserved Original Draft (Verbatim)
```markdown
# Fix Duplicate Switchboard State Parsing Bug

## Goal

Fix the Kanban plan ingestion bug where files containing duplicate `## Switchboard State` sections either fail to appear on the board entirely or get assigned to the wrong column. The parser currently exhibits undefined behavior when multiple state blocks exist.

## Problem Description

When a plan file contains more than one `## Switchboard State` section (common when users append a new state block without deleting the old one), the Kanban ingestion system:
1. May parse the first (stale) section and place the plan in the wrong column
2. May fail to parse entirely and silently skip the file
3. Leaves the file on disk but "invisible" to the board until manually fixed

This creates the illusion that plans "disappear" after editing, when in fact the tracker is making incorrect placement decisions based on ambiguous metadata.

## Metadata
**Tags:** backend, kanban, bugfix
**Complexity:** 4

## Root Cause

The `PlanFileImporter` and/or `KanbanDatabase` ingestion path extracts the `## Switchboard State` section via regex or line scanning without:
- Validating that exactly one state section exists
- Determining which section is "authoritative" (last vs first)
- Surfacing a parse error when duplicates are detected

The current behavior appears to read the **first** state block encountered, meaning appended updates (which logically should override) are ignored.

## Proposed Changes

### 1. Harden State Section Extraction with Duplicate Detection
#### [MODIFY] `src/services/PlanFileImporter.ts`
- **Context:** The `extractEmbeddedMetadata` utility and/or the dedicated Switchboard State parser needs to detect and handle duplicate sections.
- **Logic:**
  1. Scan the entire file for all `## Switchboard State` section occurrences.
  2. If multiple sections found, use the **last** one (appended sections should override prior state).
  3. If no valid state section found, default to `column: 'CREATED'`, `status: 'active'` (current fallback).
- **Alternative considered:** Throw an error on duplicates. Rejected because this would break user workflows—silent recovery with "last wins" is less disruptive.

### 2. Add Defensive Normalization During Save
#### [MODIFY] `src/services/TaskViewerProvider.ts` (or appropriate save handler)
- **Context:** When the setup panel or any save operation writes a new `## Switchboard State` block, it should proactively remove any existing state sections to prevent duplicates from being created in the first place.
- **Logic:**
  1. Before appending a new state section, scan the file for existing `## Switchboard State` blocks.
  2. Remove all existing state sections (clean delete, not just overwriting).
  3. Append the new authoritative state section at the end of the file.

### 3. Update Plan File Detection Criteria
#### [MODIFY] `src/services/TaskViewerProvider.ts::_isLikelyPlanFile()`
- **Context:** The file recognition logic should remain tolerant of duplicate sections (don't reject valid plans), but we could add a diagnostic log when duplicates are detected during the pre-parse scan.
- **Logic:** Add optional debug logging: `[PlanFileImporter] Detected duplicate Switchboard State sections in {file}, using last occurrence.`

## Verification Plan

### Automated Tests
- Create test case with file containing two Switchboard State sections (BACKLOG then PLAN REVIEWED).
- Assert that ingestion places plan in PLAN REVIEWED (last wins).
- Create test case with file containing zero state sections.
- Assert that ingestion defaults to CREATED/active.

### Manual Verification
1. Create a test plan file with duplicate state sections pointing to different columns.
2. Refresh Kanban board.
3. Verify plan appears in the **last** specified column.
4. Edit the plan via setup panel (which should normalize by removing old sections).
5. Verify file now contains exactly one state section.

## Success Criteria

- Plans with duplicate Switchboard State sections appear on the board (using last section's column).
- Plans saved through the setup panel never accumulate duplicate state sections.
- No regression: single-state-section plans continue to work normally.

## References

- Related bug discovered during: `remove_clickup_automation_debt.md` (plan disappeared from board due to duplicate state sections)

## Switchboard State

**Kanban Column:** CREATED
**Status:** active
```

## Switchboard State

**Kanban Column:** PLAN REVIEWED
**Status:** active

## Direct Reviewer Pass (2026-04-12)

### Stage 1 - Grumpy Principal Engineer
- [NIT] The parser surgery is correct, but the proof still mostly lives in a clean-room lab. The regression crushes synthetic duplicates, malformed tails, and fenced examples, yet it still stops short of pinning one of the repo's real preserved-draft plan files to the operating table.
- [NIT] The validator is still intentionally narrow. Perfectly acceptable for this bug, but the footer parser remains married to the current canonical lane set and will need an explicit follow-up if non-built-in lane IDs ever become authoritative plan-state values.

### Stage 2 - Balanced Synthesis
- **Keep:** The `planStateUtils.ts` scanner/writer rewrite and the importer warnings are the correct fix surface and satisfy the plan's core requirement.
- **Fix now:** None. I did not find a material correctness defect in the implemented parser/importer path.
- **Defer:** If this area evolves again, add one regression over an actual repo plan file with a preserved-draft/state-footer shape so the suite covers real markdown texture, not only synthetic fixtures.

### Fixed Items
- None in reviewer pass.

### Files Changed
- No additional reviewer-pass code changes.
- Reviewed implementation remains centered on:
  - `src/services/planStateUtils.ts`
  - `src/services/PlanFileImporter.ts`
  - `src/test/duplicate-switchboard-state-regression.test.js`

### Validation Results
- `npm run compile` - **PASSED**
- `node src/test/duplicate-switchboard-state-regression.test.js` - **PASSED**

### Remaining Risks
- Real preserved-draft repo files are still validated indirectly rather than by a committed real-file regression fixture.
- The footer parser still intentionally validates against the current canonical lane set only.

## Execution (2026-04-13)

### Status
**COMPLETED** - All changes were already implemented in the codebase.

### Files Changed
- No code changes required during execution - implementation was already present:
  - `src/services/planStateUtils.ts` - Top-level section scanning with fence detection already implemented
  - `src/services/PlanFileImporter.ts` - Warning logic for duplicate/malformed state sections already implemented
  - `src/test/duplicate-switchboard-state-regression.test.js` - Full regression test suite already implemented

### Validation Results
- `npm run compile` - **PASSED** (webpack compiled successfully)
- `npm run compile-tests` - **PASSED** (TypeScript compilation successful)
- `node src/test/duplicate-switchboard-state-regression.test.js` - **PASSED**
  - Duplicate top-level state sections correctly resolve to last valid section
  - Malformed trailing state sections fall back to earlier valid state
  - Fenced preserved-draft examples are ignored during parsing
  - Preserved draft content survives state rewrites
  - Importer integration test confirms last valid section wins
  - Source code verification confirms old EOF truncation regex is removed

### Notes
- The plan implementation was already present in the codebase, likely from a previous execution
- All verification tests passed without requiring any code modifications
- The fix correctly addresses the duplicate Switchboard state parsing bug by using top-level section scanning that ignores fenced code blocks and prefers the last valid state section

## Direct Reviewer Pass (2026-04-13, In-Place Review)

### Stage 1 - Grumpy Principal Engineer
- [MAJOR] The save-side "normalizer" was still leaving older live `## Switchboard State` sections behind whenever later top-level content followed the newest footer. That means a save could proudly append a new authoritative footer while stale live state blocks kept lurking earlier in the file. Spectacularly not normalized.
- [NIT] The implementation now shares some plumbing with workspace-aware custom-lane validation. That overlap is real, but it is a scope-note problem, not a correctness reason to rip out working parser behavior during this pass.
- [NIT] The regression suite still leans on synthetic markdown strings rather than a checked-in real multi-state repo fixture.

### Stage 2 - Balanced Synthesis
- **Keep:** The top-level section scanner, fenced-code avoidance, and "last valid section wins" importer behavior are the right repair surface for this bug.
- **Fix now:** Remove **all** live top-level Switchboard State sections before appending the new authoritative footer, and add a regression for duplicate live sections followed by non-state content. Done.
- **Defer:** If this area changes again, add one real-file fixture from the repo so the suite covers real markdown texture in addition to synthetic cases.

### Fixed Items
- `src/services/planStateUtils.ts` - save-side normalization now strips every live top-level `## Switchboard State` section before writing the new authoritative footer.
- `src/test/duplicate-switchboard-state-regression.test.js` - added coverage for duplicate live state sections followed by trailing non-state headings/content.

### Files Changed
- `src/services/planStateUtils.ts`
- `src/test/duplicate-switchboard-state-regression.test.js`

### Validation Results
- `npm run compile` - **PASSED**
- `npm run compile-tests` - **PASSED**
- `node src/test/duplicate-switchboard-state-regression.test.js` - **PASSED**
- `node src/test/custom-lane-roundtrip-regression.test.js` - **PASSED**

### Remaining Risks
- Reviewer coverage is still mostly synthetic rather than driven by a committed real-file fixture.
- The duplicate-state and custom-lane work now share plan-state/import plumbing, so future edits in this seam need careful review for scope drift.
