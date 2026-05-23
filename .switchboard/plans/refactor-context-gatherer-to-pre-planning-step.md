# Refactor Context Gatherer to Pre-Planning Research Step

## Goal

Transform the Context Gatherer from a broken clipboard relay workflow into a simple pre-planning research agent that writes context briefs directly into plan files, repositioning the column between NEW and PLAN REVIEWED.

## Metadata

**Tags:** backend, workflow, reliability
**Complexity:** 6

## User Review Required

> [!IMPORTANT]
> **`hideWhenNoAgent` decision:** The plan currently sets `hideWhenNoAgent: false`, which means the CONTEXT GATHERER column always appears in the kanban board even when no gatherer agent is configured. All other optional built-in columns (`RESEARCHER`, `SPLITTER`, etc.) default to `hideWhenNoAgent: true`. Recommendation: keep `true` for consistency unless the intent is to always show the column as a drag target regardless of agent configuration.

> [!WARNING]
> **`VALID_KANBAN_COLUMNS` change is cosmetically-only:** Reordering the string in the Set definition in `KanbanDatabase.ts` has zero functional effect on column ordering or validation — it's a documentation/readability tweak only. Included for completeness but is lowest priority.

## Complexity Audit

### Routine
- Column config change in `agentConfig.ts` (single-line property updates)
- Add `CONTEXT GATHERER` to `VALID_KANBAN_COLUMNS` Set string (cosmetic ordering)
- Remove `RelayPromptService` import and `_relayPromptService` property from `KanbanProvider.ts`
- Remove `_generateRelayPrompt` method from `KanbanProvider.ts` (verified unused after relay migration)
- Remove `RelayPromptService` import and `_relayPromptService` property from `TaskViewerProvider.ts`
- Remove `_handleRelayColumnMove` method from `TaskViewerProvider.ts` (verified no call sites)
- Remove `copy-gather` button event listener and HTML from `kanban.html`
- Remove `isGatherToCoded` + `copyExecutePrompt` silent clipboard block from `kanban.html`
- Create new `gatherer.md` persona file
- Update `case 'CONTEXT GATHERER'` role switch in `TaskViewerProvider.ts` (line 1638) to return `'PLAN REVIEWED'`
- Add `gatherer → 'PLAN REVIEWED'` to `_targetColumnForRole` in `TaskViewerProvider.ts`

### Complex / Risky
- **Adding `gatherer` role to `buildKanbanBatchPrompt` in `agentPromptBuilder.ts`:** `buildKanbanBatchPrompt` throws for unknown roles (line 806). Without a `gatherer` branch, any autoban or card-copy dispatch for the gatherer column will throw at runtime. The prompt content must align with the gatherer persona's instructions (write context brief to plan file, then advance to PLAN REVIEWED).
- **`_getNextKanbanColumnForSession case 'CONTEXT GATHERER'`:** Currently routes to `this._targetColumnForRole(await this._resolvePlanReviewedDispatchRole(...))` — i.e., to a coded column. After refactor, this must return `'PLAN REVIEWED'`. Changing column routing logic can affect card advancement in the sidebar review flow.
- **`_generatePromptForColumn` `case 'gather': role = null`:** After `kind` changes to `'review'`, this case becomes dead. But `case 'review': role = null` also sets null — meaning the gatherer's role must be picked up through the explicit `roleSourceDef?.role` path (`gatherer` from column definition), not through the kind switch. This is correct as long as the column definition has `role: 'gatherer'`, which it does.

## Edge-Case & Dependency Audit

### Race Conditions
- None identified. The gatherer runs sequentially as a pre-planning step; no parallel state risk.

### Security
- Persona file appends to plan file directly — no security concerns beyond normal file write access.

### Side Effects
- Removing `isGatherToCoded` from `kanban.html` eliminates the silent clipboard copy when dragging from CONTEXT GATHERER to coded columns. This was only meaningful under the old (broken) relay workflow. No functional regression.
- Setting `autobanEnabled: true` means the autoban engine will attempt to dispatch the gatherer role. The `buildKanbanBatchPrompt` **must** have a `gatherer` branch before enabling autoban, or it will throw.
- `_workflowNameForDispatchRole` in `TaskViewerProvider.ts` does not include `gatherer` in its workflowMap — calls for gatherer will return `undefined` (no workflow name logged). This is acceptable; gatherer isn't a named workflow in the current system. Document as a known gap.

### Dependencies & Conflicts
- No plan files currently in CONTEXT GATHERER column (feature was unused). Zero migration risk.
- `RelayPromptService.ts` deletion: must verify no other import/reference sites beyond `KanbanProvider.ts` and `TaskViewerProvider.ts`. Do: `grep -r "RelayPromptService" src/` before deleting.
- `copyGatherPrompt` and `copyExecutePrompt` handlers in `KanbanProvider.ts` (lines 6035, 6052) already use `_generatePromptForColumn` (not relay) — confirmed by code read. The `_generateRelayPrompt` method is already dead code. Safe to remove.

## Dependencies

- None — this feature was completely unused.

## Adversarial Synthesis

Key risks: (1) `buildKanbanBatchPrompt` throws for unknown roles — `gatherer` must be added before enabling `autobanEnabled: true`, or the autoban engine will crash on dispatch; (2) `_getNextKanbanColumnForSession` currently routes CONTEXT GATHERER to coded columns (lead/coder/intern), not PLAN REVIEWED — this must be fixed or card advancement is broken after the refactor; (3) `_targetColumnForRole('gatherer')` returns null — must add a mapping. Mitigations: implement all three in a single atomic change; test by manually dragging a card into CONTEXT GATHERER and verifying the Copy Prompt and autoban dispatch both work end-to-end.

## Proposed Changes

### `src/services/agentConfig.ts`

**Change column order and kind** (line 92):

```typescript
// BEFORE:
{ id: 'CONTEXT GATHERER', label: 'Context Gatherer', role: 'gatherer', order: 150, kind: 'gather', source: 'built-in', autobanEnabled: false, dragDropMode: 'disabled', hideWhenNoAgent: true },

// AFTER:
{ id: 'CONTEXT GATHERER', label: 'Context Gatherer', role: 'gatherer', order: 50, kind: 'review', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
```

**Changes:**
- `order: 150` → `order: 50` (between CREATED/order:0 and PLAN REVIEWED/order:100)
- `kind: 'gather'` → `kind: 'review'` (planning/research step, not a special gather kind)
- `autobanEnabled: false` → `autobanEnabled: true` (enable CLI dispatch)
- `dragDropMode: 'disabled'` → `dragDropMode: 'cli'` (enable drag-drop)
- `hideWhenNoAgent: true` kept (consistent with RESEARCHER, SPLITTER)

---

### `src/services/KanbanDatabase.ts`

**Update column order in VALID_COLUMNS** (line 409) — cosmetic only:

```typescript
// BEFORE:
'CREATED', 'BACKLOG', 'PLAN REVIEWED', 'CONTEXT GATHERER', 'LEAD CODED', ...

// AFTER:
'CREATED', 'BACKLOG', 'CONTEXT GATHERER', 'PLAN REVIEWED', 'LEAD CODED', ...
```

---

### `src/services/KanbanProvider.ts`

**Remove relay-specific handling:**

1. Remove import (line 34):
   ```typescript
   // DELETE:
   import { RelayPromptService, type RelayConfig } from './RelayPromptService';
   ```

2. Remove property (line 137):
   ```typescript
   // DELETE:
   private _relayPromptService: RelayPromptService;
   ```

3. Remove initialization (line 264):
   ```typescript
   // DELETE:
   this._relayPromptService = new RelayPromptService();
   ```

4. Remove `_generateRelayPrompt` method entirely (lines 378–433).

5. Remove `case 'gather': role = null; break;` (line 2844) — dead after kind change:
   ```typescript
   // DELETE this line:
   case 'gather': role = null; break; // CONTEXT GATHERER has dragDropMode:disabled
   ```

6. `case 'CONTEXT GATHERER': return 'gatherer';` at line 6344 in `_columnToRole` — **KEEP this**. It correctly maps the column to the gatherer role for prompt dispatch. No change needed here.

---

### `src/services/TaskViewerProvider.ts`

**Remove relay column move handler:**

1. Remove import (line 63):
   ```typescript
   // DELETE:
   import { RelayPromptService, RelayConfig } from './RelayPromptService';
   ```

2. Remove property (line 341):
   ```typescript
   // DELETE:
   private readonly _relayPromptService = new RelayPromptService();
   ```

3. Remove `_handleRelayColumnMove` method entirely (lines 2491–2540).
   - **Pre-condition:** Confirm no call sites: `grep -n "_handleRelayColumnMove" src/services/TaskViewerProvider.ts`

4. **Update `_getNextKanbanColumnForSession`** (line 1638) — fix routing to PLAN REVIEWED:
   ```typescript
   // BEFORE:
   case 'CONTEXT GATHERER':
       return this._targetColumnForRole(await this._resolvePlanReviewedDispatchRole(sessionId, workspaceRoot));

   // AFTER:
   case 'CONTEXT GATHERER':
       return 'PLAN REVIEWED';
   ```

5. **Update `_targetColumnForRole`** (around line 1448) — add gatherer mapping:
   ```typescript
   // In the switch statement, add before `default:`:
   case 'gatherer':
       return 'PLAN REVIEWED';
   ```

6. `case 'CONTEXT GATHERER': return 'gatherer';` at line 1413 — **KEEP**. Correct role mapping.

7. `case 'CONTEXT GATHERER': return 'gatherer';` at line 1477 in `_roleForKanbanColumn` — **KEEP**. Correct role mapping.

---

### `src/services/agentPromptBuilder.ts`

**Add gatherer to `buildKanbanBatchPrompt`** — insert before the final `throw` at line 806:

```typescript
if (role === 'gatherer') {
    const gathererBase = `You are operating as the **Context Gatherer** — a pre-planning research specialist.

Read the persona at \`.agent/personas/gatherer.md\` and follow it step-by-step.`;

    let baseInstructions = resolveBaseInstructions('gatherer', gathererBase, options);
    if (cavemanOutputEnabled) {
        baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
    }

    const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
    const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
    const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
    const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
        .filter(Boolean)
        .join('\n\n');

    const promptParts = [
        baseInstructions,
        safeguardsBlock,
        suffixBlock,
        `PLANS TO PROCESS:\n${planList}`
    ].filter(Boolean).join('\n\n');

    return normalizeNewlines(promptParts);
}
```

Also update the error message at line 806 to include `gatherer`:
```typescript
throw new Error(`Unknown role '${role}' in buildKanbanBatchPrompt. Built-in roles: planner, reviewer, tester, lead, coder, intern, analyst, ticket_updater, researcher, splitter, gatherer. Custom agents should be handled at the call site, not here.`);
```

---

### `src/services/RelayPromptService.ts`

**Delete entire file** — no longer needed. Before deleting, verify no remaining imports:
```bash
grep -r "RelayPromptService" src/
```
Expected: zero results after removing the imports from KanbanProvider.ts and TaskViewerProvider.ts.

---

### `src/webview/kanban.html`

**Remove gather/execute copy buttons:**

1. **Remove `copy-gather` button event listener** (lines 3949–3964):
   ```javascript
   // DELETE this entire block:
   document.querySelectorAll('.card-btn.copy-gather').forEach(btn => {
       btn.addEventListener('click', () => {
           const sessionId = btn.dataset.session || '';
           const planId = btn.dataset.planId || '';
           const workspaceRoot = btn.dataset.workspaceRoot;
           postKanbanMessage({ type: 'copyGatherPrompt', sessionId, planId, workspaceRoot });
           // Visual feedback
           const originalText = btn.textContent;
           btn.textContent = 'COPIED';
           btn.disabled = true;
           setTimeout(() => {
               btn.textContent = originalText;
               btn.disabled = false;
           }, 2000);
       });
   });
   ```

2. **Remove `copyGatherBtn` HTML generation** (lines 4075–4077):
   ```javascript
   // DELETE:
   const copyGatherBtn = (card.column === 'CONTEXT GATHERER')
       ? `<button class="card-btn copy-gather" ...>📋 Copy Gather</button>`
       : '';
   ```
   Also remove `${copyGatherBtn}` from the card HTML template (line 4105).

3. **Remove `isGatherToCoded` + `copyExecutePrompt` silent block** (lines 4577, 4601–4604):
   ```javascript
   // DELETE line 4577:
   const isGatherToCoded = sourceColumnForPrompt === 'CONTEXT GATHERER' && codedColumns.includes(effectiveTargetColumn);

   // DELETE lines 4601–4604:
   // Silent clipboard copy for gather -> coded transition (single card only)
   if (isGatherToCoded && forwardIds.length === 1) {
       postKanbanMessage({ type: 'copyExecutePrompt', sessionId: forwardIds[0], targetColumn: effectiveTargetColumn, workspaceRoot });
   }
   ```

---

### `.agent/personas/gatherer.md`

**Create new file:**

```markdown
# Context Gatherer Persona

You are operating as the **Context Gatherer** — a pre-planning research specialist.

**Your responsibilities:**
1. **Plan Analysis**: Read the plan file to understand the feature or change being proposed.
2. **Codebase Research**: Explore the codebase to find relevant files, functions, and components mentioned in the plan.
3. **Context Mapping**: Identify dependencies, related code, and potential impact areas.
4. **Brief Generation**: Write a concise context brief section directly into the plan file.
5. **Handoff**: Move the card to PLAN REVIEWED when the context brief is complete.

**Behavioral rules:**
- You are a "planner-lite" — focus on research, not full planning detail.
- Keep context briefs concise (2000-3000 tokens max).
- Include file paths, line numbers, and short code excerpts where relevant.
- Flag missing files, unclear requirements, or knowledge gaps.
- Do NOT write implementation code or suggest fixes.
- Append your context brief to the plan file under a "## Context Brief" section.

**Context Brief Format:**
```markdown
## Context Brief

**Key Files:**
- `path/to/file.ts` — [one-line purpose]

**Key Functions/Classes:**
- `functionName()` in `file.ts` — [what it does, relation to plan]

**Dependencies:**
- [List any external dependencies or services]

**Relevant Code Sections:**
[Short 10-30 line excerpts with line numbers]

**Unknowns / Ambiguities:**
- [List any unclear requirements or missing context]
```

**After completing the context brief:**
1. Save the plan file with the appended context brief
2. Move the card to the PLAN REVIEWED column
3. Report completion with the plan file path
```

---

## Verification Plan

### Manual Verification

1. **Column position**: Confirm CONTEXT GATHERER appears between NEW and PLAN REVIEWED in kanban UI (order 50, between 0 and 100).
2. **Visibility**: Confirm column is hidden when no gatherer agent is configured (hideWhenNoAgent: true).
3. **Drag-drop**: Confirm cards can be dragged into CONTEXT GATHERER column.
4. **CLI dispatch**: Confirm clicking a card in CONTEXT GATHERER generates a gatherer prompt (not an error).
5. **Plan file update**: After gatherer runs, confirm plan file has "## Context Brief" section appended.
6. **Auto-advance**: Confirm card moves to PLAN REVIEWED (not a coded column) after gatherer completes.
7. **Cleanup**: Confirm no relay-related code remains — no `copy-gather` buttons, no `isGatherToCoded` logic, no `RelayPromptService` references.
8. **No throw**: Confirm `buildKanbanBatchPrompt('gatherer', [...])` does not throw.

### Automated Tests

- None (per session constraints).

---

## Edge Cases

- **Plan file not found**: Gatherer should error and not move card.
- **Plan file locked**: Gatherer should retry or error gracefully.
- **Empty plan**: Gatherer should flag as unknown and still write brief with minimal context.
- **Large codebase**: Gatherer should limit research to plan-mentioned files only (keep it fast).
- **`_workflowNameForDispatchRole('gatherer')`**: Returns `undefined` (not in workflowMap). This means no workflow name is logged to the runsheet. Acceptable for now; document as known gap.

## Risks

- **None** — The feature was completely unused, so no migration concerns. Zero active cards in CONTEXT GATHERER column.

---

**Recommendation: Send to Coder** (Complexity 6 — multi-file changes, moderate logic, but all changes are well-scoped extensions of existing patterns.)
