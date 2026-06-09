# Fix Kanban Prompt Preview Discrepancy

## Goal
Make the kanban prompts tab preview accurately reflect the prompt that will actually be sent to agents, by including real plan data instead of an empty plans array.

## Metadata
- **Tags:** [frontend, backend, bugfix, UX]
- **Complexity:** 5

## User Review Required
- Should the "context-aware" preview be the default behavior, or should users opt in via a toggle?
- Should the startup bulk preview (`_getDefaultPromptPreviews`) also include real plan data, or remain template-only for performance?

## Complexity Audit

### Routine
- Adding `sessionIds` parameter to `getPromptPreview` message handler
- Passing `sessionIds` through `postKanbanMessage` from frontend
- Building `repoScopeMap` in the preview handler (same pattern as `_generateBatchPlannerPrompt`)
- Adding UI indicator text ("with X plans" / "template only") in the preview section header
- Updating `refreshPreview()` to include selected session IDs

### Complex / Risky
- Auto-detecting the role's source column when no sessionIds are provided (requires a role→column mapping that doesn't currently exist as a single source of truth)
- Two separate preview call sites must both be updated (`getPromptPreview` handler and `_getDefaultPromptPreviews`), or the fix is incomplete

## Edge-Case & Dependency Audit

- **Race Conditions:** `_lastCards` is updated on board refresh. If the user changes role while a refresh is pending, the preview may briefly show stale card data. Mitigation: preview already shows "Loading..." during async generation; the cards array is consistent within a single render cycle.
- **Security:** No sensitive data exposure — plan file paths and topics are already visible in the kanban board UI.
- **Side Effects:** None. Preview generation is read-only and does not modify state.
- **Dependencies & Conflicts:** The `_cardsToPromptPlans` method requires a `repoScopeMap` built from DB queries. The preview handler must replicate this pattern. No conflicts with other features.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Two preview call sites must both be updated — missing `_getDefaultPromptPreviews` leaves the startup preview inaccurate. (2) Building `repoScopeMap` in the preview handler is required for accurate working directory display, adding a DB dependency to preview generation. (3) Role-to-column mapping for auto-detection doesn't exist as a single source of truth. Mitigations: reuse existing `_cardsToPromptPlans` and repoScopeMap-building patterns; define role→column mapping inline from existing dispatch code.

## Problem
The preview prompt shown in the kanban.html prompts tab is not actually sent to the agent. Users have repeatedly asked for this to be fixed (10+ times).

## Root Cause
The preview generation calls `buildKanbanBatchPrompt(role, [], {...})` with an **empty plans array**, while actual agent dispatch calls `buildKanbanBatchPrompt(role, actualPlans, {...})` with the real plan files and context.

**Evidence:**
- Preview handler (KanbanProvider.ts:5464): `buildKanbanBatchPrompt(role, [], {...})`
- Startup preview (KanbanProvider.ts:2072): `buildKanbanBatchPrompt(role as any, [], {...})`
- Actual dispatch (e.g., _generateBatchPlannerPrompt:2263): `buildKanbanBatchPrompt('planner', this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap), {...})`

This means:
- Preview shows: base template + overrides + empty "PLANS TO PROCESS" section
- Actual agent receives: base template + overrides + REAL plan file paths + working directories + dependencies + complexity scores

## Impact
- Users cannot accurately preview what will be sent to agents
- Custom prompt overrides in the prompts tab may not behave as expected
- The preview is misleading and doesn't reflect reality

## Solution Options

### Option 1: Include Sample Plan in Preview
Modify the preview generation to include a sample/dummy plan so the preview shows the actual structure that will be sent.

**Pros:**
- Simple change
- Shows the full structure including plan context
- Users can see how their custom prompts interact with plan data

**Cons:**
- Preview shows dummy data, not actual plans
- May confuse users if they don't realize it's a sample

### Option 2: Make Preview Context-Aware
When generating preview, check if there are plans in the current kanban column and include them in the preview.

**Pros:**
- Preview shows actual plans that will be sent
- Most accurate representation
- Users can see exactly what will be dispatched

**Cons:**
- More complex implementation
- Preview changes based on which column has plans
- Need to handle case where no plans exist

### Option 3: Add Warning/Disclaimer to Preview
Add a visible warning in the prompts tab that the preview is a template-only view and doesn't include plan-specific context.

**Pros:**
- Minimal code change
- Sets user expectations correctly
- Quick fix

**Cons:**
- Doesn't actually fix the discrepancy
- Users still can't see the full prompt

## Recommended Approach
**Option 2** - Make the preview context-aware by including actual plans from the kanban.

## Proposed Changes

### src/services/KanbanProvider.ts

**Context:** The `getPromptPreview` message handler (line 5457) and `_getDefaultPromptPreviews` method (line 2060) both call `buildKanbanBatchPrompt` with an empty plans array `[]`.

**Logic:**
1. In the `getPromptPreview` handler (line 5457), accept an optional `sessionIds` array from the frontend message.
2. If `sessionIds` are provided, filter `_lastCards` by those sessionIds and workspace, then convert to `BatchPromptPlan[]` via `_cardsToPromptPlans` (with repoScopeMap built from DB).
3. If no `sessionIds` are provided, auto-detect cards from the role's typical source column using a role→column mapping derived from existing dispatch code:
   - `planner` → `CREATED`
   - `lead` → `PLAN REVIEWED` (high complexity only)
   - `coder` → `PLAN REVIEWED` (low complexity only)
   - `intern` → `PLAN REVIEWED` (low complexity only)
   - `reviewer` → `LEAD CODED` / `CODER CODED` / `INTERN CODED`
   - `tester` → `CODED`
   - Other roles → all cards
4. If no cards found for the role's column, fall back to empty array (current behavior) and include "(template only)" indicator.
5. In `_getDefaultPromptPreviews` (line 2060), use `_lastCards` filtered by the role's source column instead of `[]`. Build repoScopeMap for each role.

**Implementation:**

```typescript
// Line ~5457: getPromptPreview handler
case 'getPromptPreview': {
    const { role, sessionIds } = msg;  // ADD sessionIds
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || typeof role !== 'string') break;
    try {
        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);

        // NEW: Resolve plans for preview
        let plans: BatchPromptPlan[] = [];
        let planCount = 0;

        if (Array.isArray(sessionIds) && sessionIds.length > 0) {
            // Explicit sessionIds from frontend
            const cards = this._lastCards.filter(c =>
                c.workspaceRoot === workspaceRoot && sessionIds.includes(c.sessionId)
            );
            const repoScopeMap = await this._buildRepoScopeMap(cards, workspaceRoot);
            plans = this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
            planCount = plans.length;
        } else {
            // Auto-detect from role's source column
            const sourceColumn = this._getSourceColumnForRole(role);
            const cards = this._lastCards.filter(c =>
                c.workspaceRoot === workspaceRoot && c.column === sourceColumn
            );
            if (cards.length > 0) {
                const repoScopeMap = await this._buildRepoScopeMap(cards, workspaceRoot);
                plans = this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
                planCount = plans.length;
            }
        }

        const preview = buildKanbanBatchPrompt(role, plans, {
            workspaceRoot,
            clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role] ?? false,
            defaultPromptOverrides,
            gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role] ?? true,
            switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
            advancedReviewerEnabled: role === 'reviewer' ? promptsConfig.advancedReviewerEnabled : undefined,
            dependencyCheckEnabled: role === 'planner' ? promptsConfig.dependencyCheckEnabled : undefined,
            aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgrammingEnabled : undefined,
            splitPlan: role === 'planner' ? promptsConfig.splitPlanEnabled : undefined,
            plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined,
            accurateCodingEnabled: role === 'coder' ? promptsConfig.accurateCodingEnabled : undefined
        });
        this._panel?.webview.postMessage({ type: 'promptPreviewResult', role, preview, planCount });
    } catch (err) {
        this._panel?.webview.postMessage({ type: 'promptPreviewResult', role, preview: 'Error generating preview: ' + (err as Error).message, planCount: 0 });
    }
    break;
}
```

**New helper methods to add:**

```typescript
// Role → source column mapping (derived from existing dispatch logic)
private _getSourceColumnForRole(role: string): string {
    switch (role) {
        case 'planner': return 'CREATED';
        case 'lead': return 'PLAN REVIEWED';
        case 'coder': return 'PLAN REVIEWED';
        case 'intern': return 'PLAN REVIEWED';
        case 'reviewer': return 'LEAD CODED';  // Could also be CODER CODED / INTERN CODED
        case 'tester': return 'CODED';
        default: return '';
    }
}

// Build repoScopeMap from cards (extracted from repeated pattern in dispatch methods)
private async _buildRepoScopeMap(
    cards: KanbanCard[],
    workspaceRoot: string
): Promise<Map<string, string>> {
    const repoScopeMap = new Map<string, string>();
    const db = this._getKanbanDb(workspaceRoot);
    if (await db.ensureReady()) {
        for (const card of cards) {
            const plan = await db.getPlanBySessionId(card.sessionId);
            if (plan?.repoScope) {
                repoScopeMap.set(card.sessionId, plan.repoScope);
            }
        }
    }
    return repoScopeMap;
}
```

**Edge Cases:**
- When `_lastCards` is empty (board not yet loaded), fall back to empty plans array — preview shows template only.
- When role is a custom agent (`custom_agent_*`), these don't use `buildKanbanBatchPrompt` — the existing error handling already covers this.
- Multi-workspace: filter `_lastCards` by `workspaceRoot` to avoid mixing plans from different workspaces.

### src/services/KanbanProvider.ts — `_getDefaultPromptPreviews` (line 2060)

**Context:** This method generates previews for all roles on startup. Currently uses `[]` for plans.

**Logic:** Same pattern as above — use `_lastCards` filtered by role's source column. Build repoScopeMap per role.

**Implementation:**

```typescript
// Line ~2067: Replace empty array with context-aware plans
for (const role of roles) {
    try {
        const sourceColumn = this._getSourceColumnForRole(role);
        const cards = this._lastCards.filter(c =>
            c.workspaceRoot === workspaceRoot && c.column === sourceColumn
        );
        const repoScopeMap = cards.length > 0
            ? await this._buildRepoScopeMap(cards, workspaceRoot)
            : new Map<string, string>();
        const plans = this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);

        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const preview = buildKanbanBatchPrompt(role as any, plans, {
            // ... existing options unchanged ...
        });
        previews[role] = preview;
    } catch {
        previews[role] = 'Preview not available';
    }
}
```

**Edge Cases:**
- `_lastCards` may be empty on first load before board refresh completes. In this case, `cards` will be empty and the preview falls back to template-only (same as current behavior). This is acceptable.

### src/webview/kanban.html — `refreshPreview()` function (line 2505)

**Context:** Currently sends only `{ type: 'getPromptPreview', role: currentRole }`. No sessionIds.

**Logic:** Add optional `sessionIds` parameter. When called with explicit sessionIds, pass them through. When called without, let the backend auto-detect.

**Implementation:**

```javascript
async function refreshPreview(sessionIds) {
    const preview = document.getElementById('promptPreview');
    if (!preview) return;
    const msg = { type: 'getPromptPreview', role: currentRole };
    if (Array.isArray(sessionIds) && sessionIds.length > 0) {
        msg.sessionIds = sessionIds;
    }
    postKanbanMessage(msg);
    preview.value = 'Loading preview...';
}
```

### src/webview/kanban.html — `promptPreviewResult` handler (line 4606)

**Context:** Currently receives `{ role, preview }`. Need to also receive `planCount` for the UI indicator.

**Implementation:**

```javascript
case 'promptPreviewResult': {
    const { role, preview, planCount } = msg;
    if (role !== currentRole) break;
    const previewEl = document.getElementById('promptPreview');
    if (previewEl) previewEl.value = preview || '(No prompt content)';
    // Update indicator
    const indicator = document.getElementById('previewPlanIndicator');
    if (indicator) {
        if (planCount > 0) {
            indicator.textContent = `(with ${planCount} plan${planCount !== 1 ? 's' : ''})`;
            indicator.style.color = 'var(--accent-teal)';
        } else {
            indicator.textContent = '(template only)';
            indicator.style.color = 'var(--text-muted)';
        }
    }
    break;
}
```

### src/webview/kanban.html — Prompts tab UI

**Context:** Add a "Preview with Selected Plans" toggle and plan count indicator.

**Implementation:**
- Add a `<span id="previewPlanIndicator">` next to the preview section header to show "(with X plans)" or "(template only)".
- Add a checkbox/toggle "Use selected plans in preview" that, when enabled, passes the currently selected card sessionIds (from `selectedCards` Set) to `refreshPreview()`.
- When the toggle is disabled, call `refreshPreview()` without sessionIds (backend auto-detects from role's source column).

**Clarification:** The "selected plans" refers to cards selected on the kanban board (via the existing `selectedCards` Set), not a new selection mechanism in the prompts tab. This reuses existing UI infrastructure.

## Files to Modify
- `src/services/KanbanProvider.ts` — `getPromptPreview` case handler (line 5457), `_getDefaultPromptPreviews` (line 2060), new `_getSourceColumnForRole` and `_buildRepoScopeMap` helper methods
- `src/webview/kanban.html` — `refreshPreview()` function (line 2505), `promptPreviewResult` handler (line 4606), prompts tab UI (indicator + toggle)

## Verification Plan

### Automated Tests
- No existing automated test infrastructure found for this component. Manual verification required.

### Manual Verification Steps
1. Open prompts tab, verify preview shows context-aware content (with plans from the role's source column) or "(template only)" if no cards exist
2. Select cards on the kanban board, enable "Use selected plans" toggle, verify preview includes those specific plans
3. Verify custom prompt overrides are applied correctly in both template-only and context-aware modes
4. Test with multiple roles (planner, lead, coder, reviewer, tester) — each should pull from the correct source column
5. Test with empty board (no cards) — preview should fall back to template-only
6. Test with multi-workspace setup — preview should only include cards from the active workspace
7. Verify startup preview (`_getDefaultPromptPreviews`) also includes real plan data

## Recommendation
Complexity 5 → **Send to Coder**

---

## Review Pass — Reviewer-Executor Findings & Fixes

### Review Date: 2026-05-21

### Stage 1: Grumpy Principal Engineer Findings

The core plan data injection (plans array, sessionIds, role→column mapping, complexity routing, UI toggle/indicator) was implemented correctly. However, the `buildKanbanBatchPrompt` **options** object had significant omissions that caused the same class of bug (preview ≠ dispatch) in a different parameter:

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Missing `instruction` option for coder/intern roles — actual dispatch passes `'low-complexity'`, preview omitted it entirely, showing wrong template | **CRITICAL** | **Fixed** |
| 2 | Missing `designDocLink`/`designDocContent` for planner and tester — major prompt section absent; tester dispatch throws without design doc | **CRITICAL** | **Fixed** |
| 3 | Missing `routingMapConfig` for planner — affects complexity routing matrix in prompt | **MAJOR** | **Fixed** |
| 4 | Missing `sourceColumnLabel` for all roles — prompt text missing "from the [column] column" suffix | **MAJOR** | **Fixed** |
| 5 | `pairProgrammingEnabled` source mismatch — dispatch uses `this._autobanState?.pairProgrammingMode` (runtime), preview used `promptsConfig.pairProgrammingEnabled` (static config) | **MAJOR** | **Fixed** |
| 6 | `gitProhibitionEnabled` wrong fallback for planner — dispatch uses top-level `promptsConfig.gitProhibitionEnabled` (defaults `false`), preview used `gitProhibitionByRole?.[role] ?? true` (defaults `true`) | **MAJOR** | **Fixed** |
| 7 | `_getDefaultPromptPreviews` had all the same option omissions | **MAJOR** | **Fixed** |
| 8 | Antigravity prompt generation (line ~2382) had same option omissions — comment says "mirrors getPromptPreview handler logic" | **MAJOR** | **Fixed** |
| 9 | Plan proposed `_getSourceColumnForRole` helper — implementation inlined logic with complexity routing (better) | **NIT** | Kept as-is |
| 10 | Plan said tester column is `CODED` — implementation correctly uses `CODE REVIEWED` | **NIT** | Kept as-is |
| 11 | Indicator CSS `var(--text-secondary)` vs plan's `var(--text-muted)` | **NIT** | Deferred |

### Stage 2: Balanced Synthesis → Actions Taken

All CRITICAL and MAJOR findings were fixed. No findings deferred except the cosmetic CSS variable difference (NIT-11).

### Files Changed by Review

- **`src/services/KanbanProvider.ts`** — Three call sites fixed:
  1. `_getDefaultPromptPreviews` (line ~2096): Added `instruction`, `designDocLink`/`designDocContent`, `routingMapConfig`, `sourceColumnLabel`, fixed `gitProhibitionEnabled` for planner
  2. `getPromptPreview` handler (line ~5691): Same additions + fixed `pairProgrammingEnabled` to use autoban runtime state
  3. Antigravity prompt generation (line ~2382): Same additions (design doc, routing, instruction, sourceColumnLabel, gitProhibitionEnabled fix)
  4. New helper: `_getSourceColumnLabelForRole` (line ~2084) — maps role to column display label matching `DEFAULT_KANBAN_COLUMNS`

### New Helper Method

```typescript
private _getSourceColumnLabelForRole(role: string): string | undefined {
    switch (role) {
        case 'planner': return 'New';           // CREATED → "New"
        case 'lead':
        case 'coder':
        case 'intern': return 'Planned';        // PLAN REVIEWED → "Planned"
        case 'reviewer': return 'Lead Coder';   // LEAD CODED → "Lead Coder" (primary)
        case 'tester': return 'Reviewed';        // CODE REVIEWED → "Reviewed"
        default: return undefined;
    }
}
```

### Key Design Decisions in Fixes

1. **`pairProgrammingEnabled`**: Interactive preview (`getPromptPreview`) now uses `this._autobanState?.pairProgrammingMode` for execution roles, matching `_generateBatchExecutionPrompt`. Startup preview (`_getDefaultPromptPreviews`) keeps `promptsConfig.pairProgrammingEnabled` since autoban state may not be initialized at startup.

2. **`gitProhibitionEnabled`**: Planner now uses `promptsConfig.gitProhibitionEnabled` (top-level property, matching `_generateBatchPlannerPrompt`), while other roles use `promptsConfig.gitProhibitionByRole?.[role] ?? true`.

3. **Design doc loading**: Both planner and tester previews now load `designDocLink`/`designDocContent` using the same Notion-service pattern as the actual dispatch methods. Non-fatal on failure (falls back to URL-only).

### Verification Results

- **TypeScript compilation**: `npx tsc --noEmit` — no new errors (2 pre-existing import path errors unrelated to changes)
- **Webpack build**: `npm run compile` — compiled successfully
- **Automated tests**: No test infrastructure exists for this component; manual verification required per original plan

### Remaining Risks

1. **`pairProgrammingEnabled` in startup preview**: Uses config-based value, not runtime autoban state. If pair programming is activated after startup, the startup preview will be stale until the user manually refreshes. This is acceptable since the interactive preview (which users actively use) correctly reads runtime state.

2. **Reviewer source column**: Preview uses `LEAD CODED` as the primary source column label, but reviewer actually processes cards from `LEAD CODED`, `CODER CODED`, and `INTERN CODED`. The label "Lead Coder" is the most common case but not exhaustive. This matches the actual dispatch behavior where `sourceColumnLabel` comes from the card's actual source column.

3. **Design doc Notion loading**: Preview loads cached Notion content. If the cache is stale, the preview may show outdated design doc content. Same limitation exists in actual dispatch.
