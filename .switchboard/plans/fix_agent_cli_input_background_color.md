# Fix: Agent CLI Command Input Boxes Regressed to White Background

## Goal
Restore the dark background color for agent CLI command input boxes in the terminal operations panel, which have regressed to bright white.

## Metadata
**Tags:** frontend, ui, bugfix
**Complexity:** 2

## User Review Required
> [!NOTE]
> This is a visual regression fix only. No data migration, command routing, or agent behavior changes are required.

## Complexity Audit
### Routine
- Add a scoped dark-theme rule in `src/webview/implementation.html` for text inputs inside `.startup-row`.
- Keep the selector narrow enough that checkboxes and non-command controls remain untouched.
- Verify the hover and focus border states still match the theme variables already used elsewhere in the webviews.
### Complex / Risky
- None

## Background
The input boxes for agent CLI commands in the terminal operations panel and onboarding panel are displaying with a bright white background instead of the expected dark theme color. This is a visual regression that breaks dark-theme consistency.

### Affected Elements
1. **Terminal Operations Panel** (`src/webview/implementation.html`):
   - Input elements with `data-role` attributes for each agent (planner, lead, coder, intern, reviewer, tester, analyst, team-lead)
   - Example: `<input type="text" data-role="planner" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;">`

2. **Onboarding Panel** (`src/webview/implementation.html`):
   - Input elements with IDs like `onboard-cli-planner`, `onboard-cli-lead`, etc.
   - Example: `<input type="text" id="onboard-cli-planner" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;">`

### Current Styling Issue
These inputs only have inline `style="flex:1;"`, which controls layout but not background color. They are inheriting the browser default input background instead of the dark theme.

### Comparison with Working Implementation
In `src/webview/setup.html`, the `.startup-row input` selector correctly sets:
```css
.startup-row input,
.startup-row select {
    width: 100%;
    background: #0a0a0a;
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
}
```

`src/webview/implementation.html` has the same `.startup-row` structure but is missing the matching input styling rule.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. This is a static CSS change.
- **Security:** None. No scripting, IPC, or credential flow changes.
- **Side Effects:** The selector will affect every text input inside `.startup-row` in `src/webview/implementation.html`, which is the intended scope for the onboarding and terminal-operations command boxes.
- **Dependencies & Conflicts:**
  - **Potential merge hotspot:** `Move Configuration Components to Central Setup Panel` (`sess_1775836086369`, Reviewed) also edits `src/webview/implementation.html`. If that migration removes or relocates `.startup-row` markup, the background rule may need to move with it.
  - **Potential overlap:** `Fix Team Lead UI Visibility` (`sess_1775819612843`, Reviewed) and `Fix: Team Lead Should Not Be Active by Default and Should Be Moved to Dedicated Accordion` (`sess_1775874881556`, Planned) both touch the same `implementation.html` role rows. This bugfix is style-only, but line-level merges may still be needed.
  - No active Kanban dependency blocks this fix.

## Grumpy Critique
> Oh, splendid — the UI decided text boxes should look like printer paper, and the first instinct is "just add a CSS rule." Fine. But if you style the selector too broadly, you could repaint unrelated controls. If you style it too narrowly, you fix one panel and leave the other glaring white like a kitchen appliance.
>
> And do not hand-wave the file overlap. This repository already has other plans poking at the same `implementation.html` startup rows. A visual patch that ignores those merge hotspots is exactly how a one-line fix turns into a week of rebasing.

## Balanced Synthesis
The safest path is still a single scoped CSS rule in `src/webview/implementation.html`, mirroring the dark input styling already used in `src/webview/setup.html`. The selector should target text inputs only, which covers both onboarding and terminal-operations command boxes without disturbing checkboxes or other controls. The plan remains low-risk, but the same-file overlap with nearby UI plans should be called out so the implementation is merged carefully.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### `src/webview/implementation.html`
#### [MODIFY] `src/webview/implementation.html`
- **Context:** The command inputs in both onboarding and terminal operations live in the same `.startup-row` pattern, but `implementation.html` lacks the dark background rule that `setup.html` already uses.
- **Logic:** Add one narrowly scoped rule immediately after the existing `.onboard-step .startup-row { margin-bottom: 6px; }` block so the text inputs inherit the dark theme without changing checkbox styling or layout.
- **Implementation:**
```diff
@@
         .onboard-step .startup-row {
             margin-bottom: 6px;
         }
+
+        .startup-row input[type="text"] {
+            background: #0a0a0a;
+            color: var(--text-primary);
+            border: 1px solid var(--border-color);
+            padding: 6px 8px;
+            font-family: var(--font-mono);
+            font-size: 11px;
+        }
+
+        .startup-row input[type="text"]:focus,
+        .startup-row input[type="text"]:hover {
+            border-color: var(--border-bright);
+            outline: none;
+        }
```
- **Edge Cases Handled:** The selector targets only text inputs, so checkboxes and other existing `.startup-row` controls remain unchanged.

#### [OPTIONAL CLARIFICATION] `src/webview/implementation.html`
- **Context:** If future same-file migration work relocates the command rows into a different container, the same rule should follow those inputs rather than be duplicated.
- **Logic:** Keep the fix attached to the real DOM container that owns the affected inputs.
- **Implementation:**
```css
.cli-command-input {
    background: var(--panel-bg2);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    width: 100%;
}

.cli-command-input:focus,
.cli-command-input:hover {
    border-color: var(--border-bright);
    outline: none;
}
```
- **Edge Cases Handled:** This fallback is only useful if the inputs later need an explicit class for a broader layout migration; it does not change the current recommendation.

## Verification Plan
### Automated Tests
- No new automated test is required for a pure CSS regression fix.

### Manual Verification
1. Open the sidebar webview and navigate to **AGENT VISIBILITY & CLI COMMANDS**.
2. Confirm the command text inputs now use the dark theme background instead of white.
3. Open the onboarding flow and confirm the same inputs render identically there.
4. Hover and focus a command input to confirm the border highlight still appears.

### Related Files
- `src/webview/implementation.html` — contains the affected inputs and needs the CSS fix.
- `src/webview/setup.html` — reference implementation with the correct dark input styling.

**Agent Recommendation:** Send to Coder.

## Reviewer Execution Update

### Stage 1 (Grumpy Principal Engineer)
> **NIT** The selector is properly scoped, so mercifully we did not repaint every checkbox in the panel like a carnival prize. The only remaining annoyance is duplication: `setup.html` and `implementation.html` now carry near-identical dark-input rules, which is exactly how theme drift creeps in later when someone updates one file and forgets the other.

### Stage 2 (Balanced)
Keep the fix. No CRITICAL or MAJOR defect was found, and no production code change was needed in this review pass. The current implementation uses the narrowest sensible selector, preserves the existing hover/focus treatment, and has a dedicated regression test proving the rule is present.

### Fixed Items
- No reviewer-applied production code fixes were needed.

### Files Changed
- Observed implementation files:
  - `src/webview/implementation.html`
  - `src/test/agent-cli-input-background-regression.test.js`
- Reviewer update: `.switchboard/plans/fix_agent_cli_input_background_color.md`

### Validation Results
- `node src/test/agent-cli-input-background-regression.test.js` → passed
- `npm run compile` → passed
- `npx tsc --noEmit` → pre-existing TS2835 at `src/services/KanbanProvider.ts:2197` for `await import('./ArchiveManager')`

### Remaining Risks
- The dark input styling is duplicated across webviews, so future theme refinements may need a shared styling cleanup.
- This remains a CSS/source regression fix; it has no browser-level visual snapshot coverage.
