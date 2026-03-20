# Airlock sprint planning

## Goal
Make the airlock feature more useful for sprint planning.

1. On bundle export, export a list of all plans in the kanban NEW column (CREATED column)
2. Insert a 'copy sprint planning prompt' button as step 3 (move existing step 3 to step 4), that generates a prompt instructing NotebookLM to create detailed implementation plans for each plan in the NEW column, following the how_to_plan guide
3. Change the step 4 (create plan from notebook) to reference the new 'import from clipboard' button in the kanban NEW column instead

## Implementation Steps

### Step 1: Export NEW column plans list on bundle export
**File**: `src/services/TaskViewerProvider.ts`, **Lines 9040-9068**

In the `_handleAirlockExport` method, after writing `how_to_plan.md` (line 9060), add code to export the NEW column plans:

```typescript
// 4. Export list of plans in NEW column for sprint planning
const kanbanDb = this._getKanbanDb(workspaceRoot);
if (kanbanDb && await kanbanDb.ensureReady()) {
    const workspaceId = await this._getOrCreateWorkspaceId(workspaceRoot, kanbanDb);
    if (workspaceId) {
        const allPlans = await kanbanDb.getBoard(workspaceId);
        const newColumnPlans = allPlans.filter(p => p.kanban_column === 'CREATED');
        
        if (newColumnPlans.length > 0) {
            const plansList = newColumnPlans.map((p, idx) => 
                `${idx + 1}. **${p.topic}** (${p.complexity || 'unspecified'})\n   - Session: ${p.session_id}\n   - Created: ${new Date(p.created_at).toLocaleDateString()}`
            ).join('\n\n');
            
            const plansListPath = path.join(airlockDir, `${timestamp}-new_column_plans.md`);
            const plansContent = `# Plans in NEW Column\n\nTotal: ${newColumnPlans.length} plans\n\n${plansList}`;
            await fs.promises.writeFile(plansListPath, plansContent, 'utf8');
        }
    }
}
```

### Step 2: Add "Copy Sprint Planning Prompt" button as new Step 3
**File**: `src/webview/implementation.html`, **Lines 2793-2804**

**Current structure**:
- Step 1: Bundle Code (lines 2733-2755)
- Step 2: Upload to NotebookLM (lines 2757-2791)
- Step 3: Create plan from response (lines 2793-2804)

**New structure**:
- Step 1: Bundle Code (unchanged)
- Step 2: Upload to NotebookLM (unchanged)
- **Step 3: Copy Sprint Planning Prompt (NEW)**
- Step 4: Create plan from response (renumbered)

Insert after line 2791 (after Step 2's button row):

```javascript
// Step 3: Copy Sprint Planning Prompt
const s3Header = document.createElement('div');
s3Header.style.cssText = 'padding:8px 8px 2px; font-size:9px; color:var(--accent-green); font-family:var(--font-mono); letter-spacing:1px; font-weight:bold;';
s3Header.innerText = '3. COPY SPRINT PLANNING PROMPT';
container.appendChild(s3Header);

const s3Desc = document.createElement('div');
s3Desc.style.cssText = 'padding:0 8px 6px; font-size:10px; color:var(--text-secondary);';
s3Desc.innerText = 'Generate a prompt for NotebookLM to create detailed implementation plans for all plans in the NEW column.';
container.appendChild(s3Desc);

const copySprintBtn = document.createElement('button');
copySprintBtn.className = 'secondary-btn';
copySprintBtn.style.cssText = 'width:calc(100% - 16px); margin:0 8px 8px;';
copySprintBtn.innerText = 'COPY SPRINT PROMPT';
copySprintBtn.onclick = () => {
    const prompt = `Review the "new_column_plans.md" file in the uploaded sources. For each plan listed:

1. Read the "how_to_plan.md" guide to understand the planning framework
2. Generate a highly detailed implementation plan following the guide's structure
3. Include:
   - Specific file paths and line numbers
   - Step-by-step implementation instructions
   - Dependencies and potential conflicts
   - Complexity audit (Band A/B classification)
   - Verification steps

Format each plan as a separate markdown block with clear headers so I can copy each plan individually.

Start with the first plan and work through all plans in the list.`;
    
    navigator.clipboard.writeText(prompt).then(() => {
        copySprintBtn.innerText = '✓ COPIED';
        setTimeout(() => { copySprintBtn.innerText = 'COPY SPRINT PROMPT'; }, 2000);
    });
};
container.appendChild(copySprintBtn);
```

### Step 3: Renumber and update Step 4 description
**File**: `src/webview/implementation.html`, **Lines 2793-2804**

Change existing Step 3 to Step 4 and update description:

**Before**:
```javascript
s3Header.innerText = '3. CREATE PLAN FROM RESPONSE';
s3Desc.innerText = 'Have Notebook make a Feature plan using the How to plan guide. When the plan is ready, use CREATE to open a new ticket in edit mode, paste the result, and save it to your Kanban. If the plan needs improvement, use Autoban or manually send to the Planner agent.';
```

**After**:
```javascript
s4Header.innerText = '4. IMPORT PLANS FROM NOTEBOOK';
s4Desc.innerText = 'After NotebookLM generates the detailed plans, copy each plan individually. In the Kanban view, click the 📋 "Import plan from clipboard" button in the NEW column header to import each plan. The imported plans will be added to the NEW column and can be sent to the Planner agent for review if needed.';
```

### Step 4: Add message handler for sprint prompt copy
**File**: `src/services/TaskViewerProvider.ts`

Add handler in the message switch statement (around line 8900-9000):

```typescript
case 'airlock_copySprintPrompt': {
    // Prompt is generated client-side, no backend action needed
    break;
}
```

## Dependencies
- `src/services/TaskViewerProvider.ts` (Lines 9040-9068 for export, message handler)
- `src/webview/implementation.html` (Lines 2791-2804 for UI changes)
- **Blocks**: None
- **Blocked by**: None
- **Related**: Kanban import from clipboard button (already exists at `kanban.html:840`)

## Verification Plan
1. **Export test**: Click "BUNDLE CODE" → Check `.switchboard/airlock/` for `*-new_column_plans.md` file
2. **Plans list test**: Create 2-3 plans in NEW column → Bundle → Verify plans list contains all NEW column plans with correct metadata
3. **Sprint prompt test**: Click "COPY SPRINT PROMPT" → Verify clipboard contains prompt referencing `new_column_plans.md` and `how_to_plan.md`
4. **Import test**: Generate plans in NotebookLM → Copy plan → Click 📋 button in Kanban NEW column → Verify plan imports correctly
5. **UI test**: Verify step numbering is correct (1, 2, 3, 4) and descriptions are clear

## Complexity Audit

### Band A (Routine)
- ✅ Single-file changes (TaskViewerProvider.ts for export, implementation.html for UI)
- ✅ Reuses existing patterns (file export similar to `how_to_plan.md` export, button creation follows existing airlock buttons)
- ✅ Low risk (additive changes, no modifications to existing logic)
- ✅ Small scope (~40 lines total: 15 for export, 25 for UI)

**Complexity**: **Band A (Routine)**
**Recommended Agent**: **Coder**

## Adversarial Review

**Grumpy Critique**: 
"The plan says 'export a list of all plans in the kanban NEW column' but doesn't specify the format. JSON? Markdown? Plain text? And where does this list go—into the bundle? A separate file? The clipboard? Also, the plan wants to add a 'copy sprint planning prompt' button that references 'the how to plan guide' but doesn't specify what this prompt should say. Is it a generic prompt? Does it include the plan list? And the 'import from clipboard' button already exists at line 840 of `kanban.html`, so what exactly needs to be updated in step 4? The plan is vague about the actual implementation."

**Balanced Synthesis**: 
Valid concerns about format and destination. Implementation clarifies:
1. **Format**: Markdown file (`*-new_column_plans.md`) with numbered list of plans including topic, complexity, session ID, and creation date
2. **Destination**: `.switchboard/airlock/` directory alongside the code bundle (same pattern as `how_to_plan.md` at line 9051)
3. **Prompt content**: Explicit prompt text that references both `new_column_plans.md` and `how_to_plan.md`, instructs NotebookLM to generate detailed plans following the guide structure
4. **Step 4 update**: Change description text from "use CREATE to open a new ticket" to "click the 📋 Import plan from clipboard button in the NEW column header"

The kanban import button already exists (confirmed at `kanban.html:840`), so Step 4 only needs a description update to guide users to that existing button. This is purely additive—no breaking changes to existing workflows.

## Reviewer Pass — 2026-03-19

### Stage 1: Grumpy Principal Engineer

**[NIT]** *Plan line numbers are stale.* The plan references "Lines 9040-9068" for `_handleAirlockExport` and "Lines 2793-2804" for the UI steps. Actual locations: export logic at lines 8866-8920 in `TaskViewerProvider.ts`, UI steps at lines 2781-2816 in `implementation.html`. Expected drift, but the plan now lies to you about where to find things.

**[NIT]** *The plan's Step 4 ("Add message handler for sprint prompt copy") is dead code in the plan.* The plan proposed a `case 'airlock_copySprintPrompt'` handler with a comment "Prompt is generated client-side, no backend action needed." The implementation correctly omitted this — there's no point adding a no-op case handler. But the plan step still exists, suggesting work that was correctly not done. Slightly confusing for plan traceability, but harmless.

**[NIT]** *Property name mismatch between plan pseudocode and actual types.* The plan's Step 1 pseudocode uses `p.kanban_column`, `p.session_id`, `p.created_at` (snake_case). The actual `KanbanPlanRecord` interface uses `kanbanColumn`, `sessionId`, `createdAt` (camelCase). The implementation correctly uses camelCase. The plan pseudocode was aspirational, not copy-pasteable. *A plan that writes code for a different type system. How avant-garde.*

**[NIT]** *Step 4 description references `[⋯]` button.* The description at line 2813 says `click the [⋯] "Import plan from clipboard" button`. This references the icon change from Plan 5. If Plan 5's implementation changes (e.g., back to text), this description becomes stale. Tight coupling between plan descriptions, but acceptable since they ship together.

**Verdict**: Four NITs, zero functional issues. The three-part implementation (export, sprint prompt button, renumbered Step 4) is clean, additive, and correctly uses the existing patterns.

### Stage 2: Balanced Synthesis

- **Keep**: All three implementation components:
  - NEW column plans export in `_handleAirlockExport` (lines 8893-8911) — correctly uses `KanbanPlanRecord` camelCase properties, filters by `kanbanColumn === 'CREATED'`, outputs well-formatted markdown
  - Sprint planning prompt button as Step 3 (lines 2781-2803) — client-side clipboard copy, prompt text matches plan spec exactly
  - Step 4 renumbered with updated description (lines 2805-2814) — references the kanban import button correctly
- **Fix now**: Nothing. All findings are documentation-level NITs.
- **Defer**: Clean up plan pseudocode property names if this plan is referenced as a template for future DB access patterns.

### Code Fixes Applied
None required — no CRITICAL or MAJOR findings.

### Verification Results
- **TypeScript compile**: `npx tsc --noEmit` → **PASS** (exit code 0, zero errors)
- **Code trace (export)**: `_handleAirlockExport` → `kanbanDb.getBoard(workspaceId)` → filters `kanbanColumn === 'CREATED'` → writes `*-new_column_plans.md` with topic, complexity, sessionId, createdAt ✓
- **Code trace (UI)**: Steps numbered 1→2→3→4, sprint prompt button copies hardcoded prompt referencing `new_column_plans.md` and `how_to_plan.md` ✓
- **Type safety**: `KanbanPlanRecord` interface confirms `kanbanColumn`, `sessionId`, `createdAt` are valid camelCase properties ✓

### Files Changed
- `src/services/TaskViewerProvider.ts` (lines 8893-8911: NEW column plans export in `_handleAirlockExport`)
- `src/webview/implementation.html` (lines 2781-2816: Step 3 sprint prompt button + Step 4 renumbered)

### Remaining Risks
- If the kanban DB has zero plans in CREATED column, the `new_column_plans.md` file is not exported (by design — line 8901 checks `newColumnPlans.length > 0`). The sprint prompt in NotebookLM would reference a missing file. This is acceptable — the prompt is advisory, and NotebookLM will simply note the missing source.

### Status: ✅ APPROVED
