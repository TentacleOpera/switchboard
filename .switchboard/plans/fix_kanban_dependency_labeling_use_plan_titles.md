# Fix Kanban Dependency Labeling - Use Plan Titles Instead of sess_xxx IDs

## Goal
Fix the bug where dependencies in the kanban.html dependencies panel and prompt DEPENDENCY ORDER section are displayed as technical session IDs (`sess_xxx`) instead of human-readable plan titles. The internal `sess_xxx` identity mechanism must be preserved for DB lookups and blocking detection; only the display layer changes.

## Metadata
- **Tags:** [frontend, bugfix, workflow]
- **Complexity:** 4

## User Review Required
None — this is a display-layer bug fix with no product logic changes.

## Current State
- Dependencies are stored internally as session IDs (`sess_XXXXXXXXXXXXX`) for database lookup and blocking detection
- In the kanban dependencies panel, unresolved dependencies display as `sess_1234...` instead of plan titles
- In the prompt DEPENDENCY ORDER section, dependencies are shown as raw `sess_xxx` IDs
- The `planDependencyParser.ts` correctly prefers `sess_*` tokens and falls back to topic strings — this must NOT be changed
- `KanbanProvider._cardsToPromptPlans` does NOT pass `dependencies` or `sessionId` from `KanbanCard` to `BatchPromptPlan`, making the DEPENDENCY ORDER section always empty for KanbanProvider-sourced dispatches

## Root Cause Analysis

### Location 1: kanban.html Dependencies Panel
**File:** `src/webview/kanban.html`
**Function:** `renderDependencyTree` (lines 5679-5756)
**Issue:** Line 5722 falls back to displaying truncated session ID when plan not found in map:
```javascript
const depTitle = depPlan ? escapeHtml(depPlan.topic) : escapeHtml(depId.substring(0, 8)) + '...';
```
Additionally, line 5713 shows truncated session ID in the plan node itself:
```javascript
<div class="plan-id">${escapeHtml(plan.sessionId.substring(0, 8))}...</div>
```
The `planMap` (line 5691) only contains plans from New/Planned columns, so dependencies referencing plans in other columns can never be resolved.

### Location 2: agentPromptBuilder.ts DEPENDENCY ORDER Section
**File:** `src/services/agentPromptBuilder.ts`
**Function:** `buildKanbanBatchPrompt` (lines 220-224)
**Issue:** Line 223 uses raw dependencies string without resolving `sess_xxx` to plan titles:
```typescript
plansWithDeps.map((p, i) => `${i + 1}. [${p.topic}] depends on: ${p.dependencies}`).join('\n')
```
This section is also always empty because `KanbanProvider._cardsToPromptPlans` doesn't pass `dependencies` to `BatchPromptPlan`.

### Location 3: KanbanProvider._cardsToPromptPlans Data Gap
**File:** `src/services/KanbanProvider.ts`
**Function:** `_cardsToPromptPlans` (lines 1851-1868)
**Issue:** The method maps `KanbanCard` → `BatchPromptPlan` but omits both `sessionId` and `dependencies`:
```typescript
return {
    topic: card.topic,
    absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
    complexity: card.complexity,
    workingDir
};
```
Without `sessionId`, the DEPENDENCY ORDER section can't resolve `sess_xxx` tokens to titles. Without `dependencies`, the section is always empty.

## Complexity Audit

### Routine
- Add `sessionId` and `dependencies` fields to `BatchPromptPlan` interface (1 line each)
- Update `KanbanProvider._cardsToPromptPlans` to pass `sessionId` and `dependencies` (2 lines)
- Update kanban.html fallback text from truncated ID to full ID with label (1 line)
- Update kanban.html plan-node ID to show topic instead of truncated sessionId (1 line)
- Update `buildKanbanBatchPrompt` depSection to resolve `sess_xxx` → titles using plans array (5-8 lines)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is a synchronous display transformation, no async state involved.
- **Security:** No impact — `sess_xxx` IDs are internal identifiers, not secrets. Showing them in "Unknown Plan" fallbacks is acceptable.
- **Side Effects:** The `planDependencyParser.ts` must continue to prefer `sess_*` tokens. No changes to that file. The dependency check instruction in `agentPromptBuilder.ts` line 259 already tells planners to emit `sess_XXXXXXXXXXXXX — <topic>` format, which the parser handles correctly. This instruction should NOT be changed to title-only format.
- **Dependencies & Conflicts:** None — no other plans modify these specific code paths.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) Changing the dependency format in plan files from `sess_xxx — topic` to title-only would break `planDependencyParser.ts` identity extraction and kanban.html blocking detection — mitigated by keeping `sess_xxx` as internal identity and only resolving to titles at display time. (2) The DEPENDENCY ORDER section is currently always empty due to `_cardsToPromptPlans` not passing `dependencies` — mitigated by adding `sessionId` and `dependencies` to `BatchPromptPlan`. (3) Plans in non-Active columns can't be resolved in the dependency tree — mitigated by showing clear "Unknown Plan" fallback.

## Proposed Changes

### [src/services/agentPromptBuilder.ts]

**Context:** The `BatchPromptPlan` interface and `buildKanbanBatchPrompt` function need `sessionId` and `dependencies` to resolve `sess_xxx` tokens to plan titles in the DEPENDENCY ORDER section.

**Logic:**
1. Add `sessionId?: string` and `dependencies?: string` to `BatchPromptPlan` interface (line 12-18)
2. In `buildKanbanBatchPrompt`, build a `sessionId → topic` map from the plans array
3. Resolve `sess_xxx` tokens in the DEPENDENCY ORDER section using this map

**Implementation:**

Step 1 — Extend `BatchPromptPlan` interface (line 12-18):
```typescript
export interface BatchPromptPlan {
    topic: string;
    absolutePath: string;
    complexity?: string;
    dependencies?: string;
    workingDir?: string;
    sessionId?: string;       // Clarification: needed to resolve sess_xxx → title in depSection
}
```

Step 2 — Build sessionId→topic map and resolve in depSection (replace lines 220-224):
```typescript
// Build sessionId → topic resolution map for dependency display
const sessionIdToTopic = new Map<string, string>();
plans.forEach(p => {
    if (p.sessionId) sessionIdToTopic.set(p.sessionId, p.topic);
});

const plansWithDeps = plans.filter(p => p.dependencies);
const depSection = plansWithDeps.length > 0
    ? `\n\nDEPENDENCY ORDER: Execute in order; do not start a plan until its dependencies are implemented:\n${
        plansWithDeps.map((p, i) => {
            const depIds = (p.dependencies || '').split(',').map(d => d.trim()).filter(Boolean);
            const resolvedDeps = depIds.map(depId => {
                const resolved = sessionIdToTopic.get(depId);
                return resolved || depId;
            });
            return `${i + 1}. [${p.topic}] depends on: ${resolvedDeps.join(', ')}`;
        }).join('\n')}\n`
    : '';
```

**Edge Cases:**
- If `sessionId` is not provided on a plan, `sessionIdToTopic` won't have an entry and the raw `depId` is shown (graceful fallback)
- If a dependency references a plan not in the current batch, the raw `sess_xxx` is shown (acceptable — the plan may be in a different column)

### [src/services/KanbanProvider.ts]

**Context:** `_cardsToPromptPlans` must pass `sessionId` and `dependencies` from `KanbanCard` to `BatchPromptPlan` so the DEPENDENCY ORDER section can function.

**Implementation:** Update `_cardsToPromptPlans` (lines 1851-1868):
```typescript
private _cardsToPromptPlans(
    cards: KanbanCard[],
    workspaceRoot: string,
    repoScopeMap?: Map<string, string>
): BatchPromptPlan[] {
    return cards.map(card => {
        const repoScope = repoScopeMap?.get(card.sessionId) || '';
        const workingDir = repoScope
            ? resolveWorkingDir(workspaceRoot, repoScope)
            : '';
        return {
            topic: card.topic,
            absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
            complexity: card.complexity,
            workingDir,
            sessionId: card.sessionId,
            dependencies: card.dependencies?.join(', ') || undefined
        };
    });
}
```

**Edge Cases:**
- `card.dependencies` is `string[]` on `KanbanCard` but `string` on `BatchPromptPlan` — join with `, ` for compatibility with the parser's CSV format

### [src/webview/kanban.html]

**Context:** The dependency tree panel shows truncated `sess_xxx` IDs when plans aren't in the `planMap`. The plan-node also shows a truncated session ID.

**Implementation:**

Step 1 — Fix dependency fallback (line 5722):
```javascript
// Before:
const depTitle = depPlan ? escapeHtml(depPlan.topic) : escapeHtml(depId.substring(0, 8)) + '...';
// After:
const depTitle = depPlan ? escapeHtml(depPlan.topic) : `Unknown Plan (${escapeHtml(depId)})`;
```

Step 2 — Fix plan-node ID display (line 5713):
```javascript
// Before:
<div class="plan-id">${escapeHtml(plan.sessionId.substring(0, 8))}...</div>
// After:
<div class="plan-id">${escapeHtml(plan.topic)}</div>
```

**Edge Cases:**
- For "Unknown Plan" fallback, showing the full `depId` (not truncated) helps users identify which plan is missing
- The plan-node ID change replaces the cryptic `sess_1234...` with the plan's topic, which is already shown in the title div below. Consider keeping the session ID but making it secondary (e.g., smaller font, tooltip). **Clarification:** The simplest fix is to remove the `plan-id` div entirely since the `plan-title` div already shows the topic. Alternatively, keep it but show the full sessionId as a tooltip via the `title` attribute.

### [src/services/planDependencyParser.ts]

**No changes needed.** The parser already correctly prefers `sess_*` tokens and falls back to topic strings. The `sess_xxx` format in plan files must be preserved for reliable identity extraction.

### [src/services/agentPromptBuilder.ts — Dependency Check Instruction]

**No changes needed.** The current instruction at line 259 tells planners to emit `sess_XXXXXXXXXXXXX — <topic>` format, which is the correct format for the parser. The display layer (depSection) now resolves these to titles. Changing this instruction to title-only would break the parser's identity extraction.

## Implementation Steps

1. **Extend `BatchPromptPlan` interface** — Add `sessionId?: string` field to `src/services/agentPromptBuilder.ts:12-18`
2. **Update `_cardsToPromptPlans`** — Pass `sessionId` and `dependencies` from `KanbanCard` in `src/services/KanbanProvider.ts:1851-1868`
3. **Resolve deps in depSection** — Build `sessionId → topic` map and resolve `sess_xxx` tokens in `src/services/agentPromptBuilder.ts:220-224`
4. **Fix kanban.html dependency fallback** — Change truncated ID to "Unknown Plan (full ID)" at line 5722
5. **Fix kanban.html plan-node display** — Replace truncated session ID with topic or remove redundant div at line 5713
6. **Update TaskViewerProvider callers** — Verify `src/services/TaskViewerProvider.ts` already passes `sessionId` (it extends `BatchPromptPlan & { sessionId: string }` at line 1896)
7. **Update test fixtures** — Add `sessionId` to `TEST_PLAN` in `test/pair-programming-comprehensive.test.ts:16`

## Files Changed
- `src/services/agentPromptBuilder.ts` — Add `sessionId` to `BatchPromptPlan` interface; resolve `sess_xxx` → titles in depSection
- `src/services/KanbanProvider.ts` — Pass `sessionId` and `dependencies` in `_cardsToPromptPlans`
- `src/webview/kanban.html` — Fix dependency fallback text; fix plan-node ID display
- `test/pair-programming-comprehensive.test.ts` — Add `sessionId` to test fixtures

## Verification Plan

### Automated Tests
- Existing `test/pair-programming-comprehensive.test.ts` should pass after adding `sessionId` to test fixtures
- Existing `test/plan-dependency-parser.test.js` should pass unchanged (no changes to parser)

### Manual Verification
- Open kanban dependencies panel: dependencies show plan titles instead of `sess_1234...`
- DEPENDENCY ORDER section in generated prompts shows plan titles instead of raw `sess_xxx` IDs
- Plans with dependencies in non-Active columns show "Unknown Plan (sess_xxx)" fallback
- Blocking dependency detection still works (internal `sess_xxx` identity preserved)
- `planDependencyParser.ts` still correctly extracts `sess_*` tokens from plan files

## Validation
- Dependencies in kanban panel display as plan titles (e.g., "Fix login bug") instead of "sess_1234..."
- DEPENDENCY ORDER section in prompts shows resolved plan titles
- Unresolved dependencies are clearly labeled as "Unknown Plan (sess_xxx)"
- No regressions in blocking dependency detection
- No changes to `planDependencyParser.ts` — internal `sess_xxx` identity mechanism preserved
- Dependency check instruction unchanged — planners continue to emit `sess_xxx — <topic>` format
