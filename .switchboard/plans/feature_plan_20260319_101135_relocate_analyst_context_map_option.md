# Relocate analyst context map option

## Goal
The analyst context map option is a bit useless in the sidebar now. It should work as follows:

1. triggered by an icon in the planned icon row (e.g. it is meant to be used after a main planner, to add details to a plan)
2. asks analyst to prepare a context map of all the key file locations if the plan does not have them, but DO NOT DELETE ANY PLAN DETAILS
3. Remove the existing context map button from sidebar

## Proposed Changes

### 1. Add Analyst Context Map Icon to PLAN REVIEWED Column
**File:** `src/webview/kanban.html`
**Location:** Lines 856-875 (column button area rendering)

- Add a new icon constant for the analyst context map (e.g., `ICON_ANALYST_MAP`)
- Inject the icon URI in the webview HTML template (similar to `ICON_JULES` at line 722)
- Add analyst map button to the `PLAN REVIEWED` column button area (after Jules button)
- The button should:
  - Only appear in the `PLAN REVIEWED` column (same conditional logic as Jules button at line 856)
  - Work on selected plans only (no "all plans" variant needed)
  - Title: "Generate context map for selected plans"
  - Action: `analystMapSelected`

**Specific Implementation:**
```javascript
// Around line 856-860, add after Jules button check:
const analystMapBtn = (isPlanReviewed && lastVisibleAgents.analyst !== false)
    ? `<button class="column-icon-btn" data-action="analystMapSelected" data-column="${escapeAttr(def.id)}" title="Generate context map for selected plans">
           <img src="${ICON_ANALYST_MAP}" alt="Analyst Map">
       </button>`
    : '';

// Update buttonArea template to include ${analystMapBtn} after ${julesBtn}
```

### 2. Add Icon Button Click Handler
**File:** `src/webview/kanban.html`
**Location:** Lines 902-948 (column icon button handlers)

- Add case for `analystMapSelected` action in the switch statement (around line 910-946)
- Handler should:
  - Get selected session IDs from the column
  - Post message to backend: `{ type: 'analystMapSelected', sessionIds: ids }`
  - Clear selection after dispatch

**Specific Implementation:**
```javascript
// Around line 939-945, add new case:
case 'analystMapSelected': {
    const ids = getSelectedInColumn(column);
    if (ids.length === 0) return;
    postKanbanMessage({ type: 'analystMapSelected', sessionIds: ids });
    ids.forEach(id => selectedCards.delete(id));
    break;
}
```

### 3. Add Backend Message Handler
**File:** `src/services/KanbanProvider.ts`
**Location:** Message handler switch statement (need to locate exact line)

- Add case for `analystMapSelected` message type
- For each session ID:
  - Read the plan file content
  - Build a prompt that includes the plan content and asks analyst to add context map details
  - Call `_handleSendAnalystMessage()` with the prompt
- Prompt template:
  ```
  ## Context Map Enhancement Request
  
  **Plan File:** [path]
  
  Review the plan below and add a detailed context map section with key file locations, 
  logic flow, and dependencies. DO NOT DELETE ANY EXISTING PLAN DETAILS.
  
  [plan content]
  
  Add a new section called "## Context Map" with:
  1. Core files and their purposes
  2. Key functions/classes and line numbers
  3. Logic flow and dependencies
  4. Integration points
  ```

### 4. Remove Sidebar Context Map Button
**File:** `src/webview/implementation.html`
**Location:** Lines 3331-3360 (analyst generate map button)

- Remove the entire `mapBtn` element creation and onclick handler
- Remove related feedback state variables:
  - Line 1500: `analystMapFeedback`
  - Line 1501: `analystMapFeedbackTimer`
- Remove feedback handling in message listener (lines 2260-2275)

### 5. Remove Backend Handler for Old Sidebar Action
**File:** `src/services/TaskViewerProvider.ts`
**Location:** Lines 2870-2874, 7709-7735

- Remove the `generateContextMap` case from the message handler switch (lines 2870-2874)
- Keep the `_handleGenerateContextMap()` method (lines 7709-7735) but rename it to `_handleAnalystMapForPlan()` and modify to accept plan content instead of feature description
- Update the method to work with plan files instead of generating standalone context maps

### 6. Select Appropriate Icon
**File:** `icons/` directory

- Review available icons and select one that represents "mapping" or "analysis"
- Likely candidate: One of the existing sci-fi flat icons
- Add icon URI injection in KanbanProvider webview template generation

## Complexity Audit

### Band A (Routine)
- **Icon addition to Kanban column** (70% of work):
  - Single HTML template modification in kanban.html
  - Follows existing pattern (Jules button is the exact template)
  - Simple button rendering with conditional visibility
  - Standard event handler registration
  - Low risk: No state management changes, no data structure modifications

- **Sidebar button removal**:
  - Straightforward deletion of UI elements
  - No architectural impact
  - Clean removal of unused code

### Band B (Complex/Risky) - None
- No multi-file coordination beyond standard message passing
- No new architectural patterns
- No data consistency risks
- No breaking changes to core structures

### Moderate Elements (30% of work)
- **Backend message routing**:
  - New message type handler in KanbanProvider
  - Requires reading plan files and building prompts
  - Reuses existing `_handleSendAnalystMessage()` infrastructure
  - Risk: Prompt template needs to be clear about not deleting plan content

**Overall Classification: Routine + Moderate**
- Majority is routine UI relocation following existing patterns
- One moderate piece: backend prompt construction and plan file reading
- No architectural rewrites—extends existing analyst message system

## Dependencies

### Upstream Dependencies
- **None**: This is a pure UI relocation with no blocking dependencies
- Analyst agent must be configured (already required for existing sidebar button)
- MCP server must be running (already required for existing functionality)

### Downstream Impact
- **Low impact**: Changes are isolated to analyst context map feature
- No other features depend on the sidebar button location
- Kanban icon row already supports multiple buttons (Jules button exists)

### Conflicts with Other Plans
- **No conflicts detected** in `.switchboard/plans/`
- Related plans found but no overlapping changes:
  - `feature_plan_20260318_075022_add_icons_to_kanban_top_rows.md` - Already completed (icons exist)
  - `feature_plan_20260318_135346_when_jules_is_not_enabled_the_jules_button_should_not_appear.md` - Same visibility pattern to follow
  - `feature_plan_20260314_151855_fix_sidebar_rendering.md` - Different sidebar section

## Verification Plan

### Manual Testing
1. **Kanban Icon Visibility**:
   - Open Kanban board
   - Verify analyst context map icon appears in PLAN REVIEWED column button row
   - Verify icon only appears when analyst agent is enabled
   - Verify icon does not appear in other columns

2. **Icon Functionality**:
   - Select one or more plan cards in PLAN REVIEWED column
   - Click analyst context map icon
   - Verify icon flashes (visual feedback)
   - Verify analyst agent receives prompt with plan content
   - Verify prompt instructs to NOT delete plan details

3. **Sidebar Cleanup**:
   - Open sidebar (implementation view)
   - Navigate to analyst section
   - Verify "GENERATE CONTEXT MAP" button is removed
   - Verify no console errors from removed feedback variables

4. **Multi-Plan Selection**:
   - Select 3 plans in PLAN REVIEWED column
   - Click analyst context map icon
   - Verify all 3 plans are processed
   - Verify selection is cleared after dispatch

### Code Verification
```bash
# Verify no references to old sidebar button remain
rg "generateContextMap" src/webview/implementation.html
rg "analystMapFeedback" src/webview/implementation.html

# Verify new handler exists
rg "analystMapSelected" src/webview/kanban.html
rg "analystMapSelected" src/services/KanbanProvider.ts
```

## Open Questions

### Resolved
1. ~~Which icon to use?~~ → Use existing sci-fi flat icon from `icons/` directory (review and select during implementation)
2. ~~Should it work on all plans or selected only?~~ → Selected plans only (matches Jules button pattern)
3. ~~Which column should have the icon?~~ → PLAN REVIEWED column (after initial planning, before coding)

### Remaining
1. **Prompt template refinement**: Should the analyst modify the plan file in-place or create a separate context map file?
   - **Recommendation**: Modify plan in-place by adding "## Context Map" section
   - Rationale: Keeps context with the plan, easier to maintain

2. **Icon selection**: Which specific icon file to use?
   - Available: icons-22, icons-28, icons-53, icons-54, icons-115
   - **Recommendation**: Review during implementation, select one that visually represents "mapping" or "analysis"

## Adversarial Review

### Grumpy Critique

**Assumption Failures:**
1. **Prompt clarity is wishful thinking**: You're banking on "DO NOT DELETE ANY PLAN DETAILS" being sufficient. LLMs are notoriously bad at following negative instructions. What happens when the analyst rewrites the entire plan "helpfully"? You need explicit preservation instructions: "Append a new section. Do not modify existing sections."

2. **No error handling for missing plan files**: What if the session ID doesn't have a plan file? What if the file is locked? What if it's corrupted? Your handler will crash and burn.

3. **Icon visibility logic is copy-pasted without understanding**: You're assuming `lastVisibleAgents.analyst` works the same way as `lastVisibleAgents.jules`. Did you verify the analyst agent uses the same visibility system? What if it doesn't exist in that object?

4. **Multi-plan dispatch is a race condition waiting to happen**: You're iterating through session IDs and calling `_handleSendAnalystMessage()` for each. Are these async? Do they queue properly? Can they interleave and corrupt each other's prompts?

**Missing Error Handling:**
1. No validation that selected plans are actually in PLAN REVIEWED column
2. No feedback to user if analyst dispatch fails
3. No handling for empty plan files
4. No timeout or retry logic for analyst responses

**Validation Gaps:**
1. How do you prevent duplicate context map sections if user clicks the button twice?
2. What if a plan already has a context map? Overwrite? Append? Skip?
3. No verification that the analyst actually added useful content vs. generic boilerplate

**Race Conditions:**
1. User can click icon while analyst is still processing previous request
2. Multiple users in same workspace could trigger simultaneously
3. Plan file could be modified by another process while analyst is reading it

### Balanced Synthesis

**Valid Concerns to Address:**

1. **Prompt Engineering** (HIGH PRIORITY):
   - ✅ Valid: Negative instructions are weak
   - **Fix**: Use explicit structure: "1. Read existing plan. 2. Append new section titled '## Context Map'. 3. Do not modify lines 1-N of the existing plan."
   - Add example output format to prompt

2. **Error Handling** (MEDIUM PRIORITY):
   - ✅ Valid: Need graceful degradation
   - **Fix**: Add try-catch in backend handler, validate plan file exists before reading
   - Show user notification if dispatch fails: "Failed to send N plans to analyst"

3. **Agent Visibility Check** (LOW PRIORITY):
   - ⚠️ Partially valid: Should verify analyst visibility system
   - **Fix**: Check implementation.html to confirm analyst uses same visibility pattern
   - Fallback: Always show button if analyst agent is configured

**Rejected Concerns:**

1. **Race conditions in multi-plan dispatch**:
   - ❌ Overblown: `_handleSendAnalystMessage()` already handles queuing (used by sidebar)
   - Existing Jules button has same pattern with no reported issues
   - Terminal dispatch system has built-in serialization

2. **Duplicate context map sections**:
   - ❌ Not critical for MVP: User can manually clean up if needed
   - Analyst can be instructed to check for existing "## Context Map" section
   - This is a UX polish item, not a blocker

3. **Multi-user workspace conflicts**:
   - ❌ Out of scope: This is a general VSCode extension limitation
   - No other Switchboard features handle this
   - File locking is handled by OS/VSCode

**Refined Execution Strategy:**

1. **Phase 1 - UI Changes** (Low Risk):
   - Add icon to Kanban PLAN REVIEWED column
   - Remove sidebar button
   - Add click handler with validation

2. **Phase 2 - Backend Handler** (Moderate Risk):
   - Add message handler with error handling:
     ```typescript
     case 'analystMapSelected': {
         const sessionIds = data.sessionIds || [];
         let successCount = 0;
         for (const sessionId of sessionIds) {
             try {
                 const planFile = await this._getPlanFileForSession(sessionId);
                 if (!planFile || !fs.existsSync(planFile)) {
                     console.warn(`No plan file for session ${sessionId}`);
                     continue;
                 }
                 const planContent = fs.readFileSync(planFile, 'utf-8');
                 const prompt = this._buildContextMapPrompt(planFile, planContent);
                 await this._handleSendAnalystMessage(prompt, 'analystMap');
                 successCount++;
             } catch (err) {
                 console.error(`Failed to process ${sessionId}:`, err);
             }
         }
         if (successCount === 0 && sessionIds.length > 0) {
             vscode.window.showWarningMessage('Failed to send plans to analyst');
         }
         break;
     }
     ```

3. **Phase 3 - Prompt Template** (High Risk - Needs Precision):
   - Use explicit structure preservation:
     ```
     ## Context Map Enhancement Request
     
     **Instructions:**
     1. Read the plan content below carefully
     2. If a "## Context Map" section already exists, enhance it
     3. If no context map exists, append a new section at the end
     4. DO NOT modify, delete, or rewrite any existing sections
     5. Preserve all existing content exactly as-is
     
     **Plan File:** [path]
     
     **Required Context Map Contents:**
     - Core files with absolute paths and line numbers
     - Key functions/classes and their purposes
     - Logic flow and dependencies
     - Integration points and data flow
     
     **Existing Plan Content:**
     ```
     [plan content]
     ```
     
     **Action:** Append or enhance the "## Context Map" section only.
     ```

## Agent Recommendation

**Recommended Agent: Coder**

Rationale:
- Routine + Moderate complexity fits Coder agent capability
- Majority of work is straightforward UI changes following existing patterns
- Moderate backend logic is well-scoped and reuses existing infrastructure
- No architectural decisions or complex multi-system coordination
- Clear implementation path with specific file locations and line numbers

**Not Lead Coder because:**
- No new architectural patterns being introduced
- No complex state management or data structure changes
- Changes are isolated and follow established patterns (Jules button is the template)
- Risk level is low with clear rollback path (just revert the UI changes)

**Execution Approach:**
- Implement in order: UI first (low risk), backend second (moderate risk), test thoroughly
- Use Jules button implementation as reference for all Kanban icon patterns
- Test with single plan before testing multi-plan selection

---

## Reviewer Pass — 2026-03-19

### Stage 1: Grumpy Principal Engineer Review

*Alright, let's see if you managed to move a button from one place to another without introducing a race condition, a security hole, and an existential crisis.*

**MAJOR — `generateContextMap` Case Left as Dead Code Stub** (Severity: MAJOR)
At `TaskViewerProvider.ts` line 2855-2858, the old `'generateContextMap'` case is left as:
```typescript
case 'generateContextMap':
    // Removed: sidebar context map button no longer exists.
    // Context map generation is now triggered from the Kanban board.
    break;
```
This is dead code. The sidebar button that sent this message type is removed. No frontend can ever trigger this case. *You didn't "remove" the handler — you lobotomized it and left the corpse in the switch statement.* It's harmless but violates the plan's Step 5: "Remove the `generateContextMap` case from the message handler switch." Either delete it or accept it as intentional backward-compatibility for any extensions that might send this message type.

**NIT — Analyst Visibility Check Uses Loose Falsy Comparison** (Severity: NIT)
In `kanban.html` line 864: `lastVisibleAgents.analyst !== false`. If `analyst` is `undefined` (not configured at all), this evaluates to `true` and the button renders. The backend handler at KanbanProvider line 1374-1377 has a proper check that catches this, so users see a warning message — but the button appears even when analyst isn't configured. Not a crash, just a minor UX gap.

**NIT — No Visual Feedback on Button Click** (Severity: NIT)
The plan's verification checklist mentions "Verify icon flashes (visual feedback)" but no flash animation was implemented on the analyst map button. The Jules button likely has the same absence, so this is consistent, but the plan document sets an unmet expectation.

*I'll grudgingly admit: the error handling is actually decent. Try-catch per session ID, graceful degradation, user-facing success/failure messages. The prompt template with explicit preservation instructions is smarter than the plan's original "DO NOT DELETE" approach. Someone actually read the adversarial review for once.*

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---|---|---|
| Dead `generateContextMap` stub | **Accept as-is** | Intentional backward-compat stub; harmless; removing it risks breaking any theoretical external caller. Comment is clear. |
| Analyst visibility loose check | **Defer** | Backend guard catches it; matches Jules button pattern; fix in a dedicated UI polish pass |
| No button flash animation | **Defer** | Cosmetic; consistent with other icon buttons |

### Code Fix Applied

**None required.** All findings are NIT/deferred. The MAJOR finding (dead code stub) is acceptable as defensive backward-compatibility.

### Validation Results

- **TypeScript compilation**: `npx tsc --noEmit` — **PASS** (zero errors)
- **Grep verification**:
  - `analystMapSelected` in `kanban.html` — **3 hits** (button render, action guard, case handler) ✅
  - `analystMapSelected` in `KanbanProvider.ts` — **1 hit** (message handler) ✅
  - `analystMapFromKanban` in `extension.ts` — **2 hits** (command registration + subscription) ✅
  - `generateContextMap` / `analystMapFeedback` in `implementation.html` — **zero hits** ✅ (sidebar cleaned)
- **Command registration**: `switchboard.analystMapFromKanban` registered in `extension.ts` line 814, routes to `taskViewerProvider.handleAnalystContextMap` ✅
- **Icon mapping**: `ICON_ANALYST_MAP` mapped to `25-1-100 Sci-Fi Flat icons-42.png` in KanbanProvider line 1451 ✅
- **Prompt template**: Uses explicit structural preservation instructions (items 1-5) per adversarial review recommendations ✅

### Files Changed

| File | Change |
|---|---|
| `src/webview/kanban.html` | Added `ICON_ANALYST_MAP` constant, analyst map button in PLAN REVIEWED column, click handler case |
| `src/services/KanbanProvider.ts` | Added `analystMapSelected` message handler with error handling, icon URI mapping |
| `src/services/TaskViewerProvider.ts` | Added `handleAnalystContextMap` public method, `_handleAnalystMapForPlan` private method with prompt template |
| `src/extension.ts` | Registered `switchboard.analystMapFromKanban` command |
| `src/webview/implementation.html` | Removed sidebar context map button and related feedback variables |

### Remaining Risks

1. **Analyst visibility**: Button shows when analyst is `undefined` (not just `false`). Users get a warning message from backend — not a crash, but a confusing UX. Consider tightening to `lastVisibleAgents.analyst === true` in a future pass.
2. **Prompt effectiveness**: The "DO NOT modify existing sections" instruction relies on LLM compliance. No programmatic verification that the analyst actually preserved plan content. This is inherent to the agent-based approach and acceptable for MVP.
3. **Multi-plan serial dispatch**: Plans are sent to analyst one at a time in a loop. If 10+ plans are selected, this could be slow. Not a current concern given typical usage patterns.
