# Fix Airlock Tab Structure and Copy

## Goal
Restructure the Airlock tab to properly separate "Clipboard Plan Import" and "NotebookLM/Airlock" workflows as distinct top-level sections, fix descriptive text, and remove the misplaced horizontal divider.

## Metadata
**Tags:** UI, frontend
**Complexity:** 4

## User Review Required
> [!NOTE]
> Visual-only change to the Agents → Airlock sub-tab. No data model, backend, or persistence changes. The webview will re-render on next tab switch; no manual steps required.

## Complexity Audit
### Routine
- Update `clipDesc.innerText` string to add the "Ask your web agent…" prefix (single-line text change)
- Add a new `<div>` element with helper text above the Copy Agent Prompt button (4–5 lines of DOM creation mirroring existing patterns)
- Remove the 4-line `clipDivider` block (lines 3587–3590)
- Reorder DOM appends so Clipboard Import section is rendered before the Airlock/NotebookLM section

### Complex / Risky
- Splitting `createWebAiAirlockPanel()` into two functions (`createClipboardImportPanel()` and `createAirlockPanel()`) requires relocating the `updateSeparatorPreview()` helper and event listeners into the correct function scope. The `clipDropdown` and `clipCustomInput` closures must remain accessible to both the event handlers and the Copy Agent Prompt button's `onclick`.
- The Sprint Planning Prompt button (Step 3) reads `airlock-separator-preset` and `airlock-separator-input` by `document.getElementById` from a *different* panel. After the split, those IDs will live in `createClipboardImportPanel()` — this cross-panel dependency must be preserved via the existing `getElementById` lookups (which already work globally on the webview DOM), but it's a subtle coupling that could break if rendering order changes.
- Two call sites append the airlock panel (`renderAgentList` line 3372 onboarding guard, and line 3491 normal path). Both must be updated to append both new panels in the correct order.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. All DOM manipulation is synchronous within `renderAgentList`. The `vscode.postMessage({ type: 'getClipboardSeparatorPattern' })` call fires after both panels are in the DOM — no timing issue.
- **Security:** No user input is rendered as HTML; all content uses `innerText`/`textContent`. No XSS risk.
- **Side Effects:** The `webai-status` status line element currently lives inside the Airlock panel. Decision: keep it in the Airlock (NotebookLM) panel since it's used for bundle-export feedback. Alternatively, it could move to Clipboard Import — but the existing message handlers reference it for airlock export status, so leaving it in the Airlock panel is safest.
- **Dependencies & Conflicts:** No other pending plans in the `.switchboard/plans/` folder modify `createWebAiAirlockPanel()`. The closest plan (`brain_6f3b0fa...md`) references this function in a diff but appears to be an already-merged brain plan. No conflicts detected.

## Adversarial Synthesis

### Grumpy Critique
"Oh wonderful, another 'just restructure the DOM' ticket that pretends it's trivial. Let me count the ways this goes wrong:

1. **Cross-panel ID coupling is a ticking bomb.** The Sprint Planning Prompt button in the *Airlock* panel does `document.getElementById('airlock-separator-preset')` to read a dropdown that will now live in a *different* panel. Sure, `getElementById` works globally, but this is implicit coupling with zero documentation. If someone later lazy-loads or conditionally renders the Clipboard panel, the Sprint button silently falls back to `### PLAN N START` — no error, just wrong behavior. You've turned a single-function closure into a cross-function contract with no type safety.

2. **Two call sites, one memory.** Lines 3372 and 3491 both call `createWebAiAirlockPanel()`. The plan says 'update both' but doesn't specify the *order* of the two new `appendChild` calls at each site. If one site puts Airlock before Clipboard Import, you get inconsistent UX depending on whether you hit the onboarding guard or normal path.

3. **The `vscode.postMessage({ type: 'getClipboardSeparatorPattern' })` call** currently fires at the end of `createWebAiAirlockPanel`. After the split, which function owns it? If it ends up in `createAirlockPanel` but the dropdown lives in `createClipboardImportPanel`, the response handler won't find the dropdown until after both panels render. The plan doesn't address this.

4. **No test.** There's a verification plan that says 'open the extension and click things.' For a complexity-4 change touching two call sites with cross-panel coupling, this deserves at least a smoke-test assertion that both panels render and the element IDs exist."

### Balanced Response
Grumpy's concerns are valid but manageable:

1. **Cross-panel ID coupling:** This is pre-existing — the Sprint button *already* uses `getElementById` rather than closure references. The split doesn't make it worse. Adding a code comment at the Sprint button documenting the cross-panel dependency is sufficient. No architectural change needed for a complexity-4 task.

2. **Two call sites, consistent order:** The implementation steps below explicitly specify the order at both call sites: `createClipboardImportPanel()` first, then `createAirlockPanel()`.

3. **`getClipboardSeparatorPattern` ownership:** This message requests separator state to populate the dropdown. It belongs in `createClipboardImportPanel()` since the dropdown lives there. The implementation steps below place it there explicitly.

4. **Testing:** The verification plan is manual but adequate for a pure UI restructure with no logic changes. The element IDs are unchanged, so existing message handlers continue to work. If the project later adds webview DOM tests, these panels would be natural candidates.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** All changes are in a single file. Complete code blocks provided below.

### Airlock Panel Split
#### [MODIFY] `src/webview/implementation.html`

- **Context:** The function `createWebAiAirlockPanel()` (line 3498) currently creates a single container with both the Clipboard Import section and the NotebookLM workflow. It must be split into two independent panel functions, each returning its own `agent-row` container.

- **Logic:**
  1. Rename `createWebAiAirlockPanel()` → `createClipboardImportPanel()`. This function keeps: the Clipboard Import header, description, dropdown, custom input, hint, preview, error display, helper text (new), and Copy Agent Prompt button. It also fires `getClipboardSeparatorPattern`.
  2. Create a new `createAirlockPanel()` function containing: the AIRLOCK header, intro text, status line, and Steps 1–4 (Bundle Code, Upload, Sprint Prompt, Import).
  3. Remove the `clipDivider` block (lines 3587–3590).
  4. Update the `clipDesc.innerText` to prepend "Ask your web agent to write feature plans for import. ".
  5. Add a helper text `<div>` before the Copy Agent Prompt button: "Use this prompt to ask the agent to format the plans with the above separator."
  6. Update both call sites (lines 3372 and 3491) to append `createClipboardImportPanel()` then `createAirlockPanel()`.

- **Implementation:**

**Step A — Replace `createWebAiAirlockPanel` with `createClipboardImportPanel`:**

Replace the entire function at line 3498 through line 3753 with:

```javascript
function createClipboardImportPanel() {
    const container = document.createElement('div');
    container.className = 'agent-row';

    // Header
    const header = document.createElement('div');
    header.className = 'row-header';
    const identity = document.createElement('div');
    identity.className = 'agent-identity';
    const dot = document.createElement('div');
    dot.className = 'status-dot green';
    const name = document.createElement('div');
    name.className = 'agent-name';
    name.innerText = 'CLIPBOARD PLAN IMPORT';
    identity.appendChild(dot);
    identity.appendChild(name);
    header.appendChild(identity);
    container.appendChild(header);

    // Description
    const clipDesc = document.createElement('div');
    clipDesc.style.cssText = 'padding:6px 8px; font-size:10px; color:var(--text-secondary); line-height:1.4;';
    clipDesc.innerText = 'Ask your web agent to write feature plans for import. Import multiple plans by pasting a single markdown block. The separator pattern below splits content into individual plan files.';
    container.appendChild(clipDesc);

    // Preset dropdown
    const clipDropdownRow = document.createElement('div');
    clipDropdownRow.style.cssText = 'display:flex; gap:4px; align-items:center; padding:0 8px 4px;';

    const clipDropdownLabel = document.createElement('span');
    clipDropdownLabel.style.cssText = 'font-size:10px; color:var(--text-secondary); white-space:nowrap;';
    clipDropdownLabel.innerText = 'Separator:';
    clipDropdownRow.appendChild(clipDropdownLabel);

    const clipDropdown = document.createElement('select');
    clipDropdown.id = 'airlock-separator-preset';
    clipDropdown.style.cssText = 'flex:1; font-family:var(--font-mono); font-size:10px; background:var(--bg-dim); color:var(--text-primary); border:1px solid var(--border-dim); border-radius:3px; padding:3px 4px;';
    clipDropdownRow.appendChild(clipDropdown);
    container.appendChild(clipDropdownRow);

    // Custom pattern input (hidden by default)
    const clipCustomRow = document.createElement('div');
    clipCustomRow.id = 'airlock-separator-custom-row';
    clipCustomRow.style.cssText = 'display:none; padding:0 8px 4px;';

    const clipCustomInput = document.createElement('input');
    clipCustomInput.id = 'airlock-separator-input';
    clipCustomInput.type = 'text';
    clipCustomInput.placeholder = '### PLAN [N] START';
    clipCustomInput.style.cssText = 'width:100%; font-family:var(--font-mono); font-size:10px; box-sizing:border-box;';
    clipCustomRow.appendChild(clipCustomInput);
    container.appendChild(clipCustomRow);

    // N placeholder hint
    const clipHint = document.createElement('div');
    clipHint.style.cssText = 'padding:0 8px 4px; font-size:9px; color:var(--text-secondary); font-family:var(--font-mono);';
    clipHint.innerText = '[N] = auto-numbered placeholder (1, 2, 3...)';
    container.appendChild(clipHint);

    // Live preview
    const clipPreview = document.createElement('div');
    clipPreview.id = 'airlock-separator-preview';
    clipPreview.style.cssText = 'margin:0 8px 8px; font-size:10px; color:var(--text-secondary); padding:6px 8px; background:var(--bg-dim); border:1px solid var(--border-dim); border-radius:4px; font-family:var(--font-mono); white-space:pre-line; line-height:1.4;';
    container.appendChild(clipPreview);

    // Error display
    const clipError = document.createElement('div');
    clipError.id = 'airlock-separator-error';
    clipError.style.cssText = 'min-height:0; padding:0 8px; color:var(--accent-red); font-size:10px; font-family:var(--font-mono);';
    container.appendChild(clipError);

    // --- Helper: update preview from pattern ---
    function updateSeparatorPreview(pattern) {
        if (!pattern) { clipPreview.textContent = ''; return; }
        const ex1 = pattern.replace(/\[N\]/g, '1');
        const ex2 = pattern.replace(/\[N\]/g, '2');
        clipPreview.textContent = 'Preview matches:\n' + ex1 + '\n' + ex2;
    }

    // --- Event: dropdown change ---
    clipDropdown.addEventListener('change', () => {
        const key = clipDropdown.value;
        clipCustomRow.style.display = key === 'custom' ? 'block' : 'none';
        clipError.textContent = '';
        vscode.postMessage({ type: 'setClipboardSeparatorPreset', preset: key });
        const opt = clipDropdown.options[clipDropdown.selectedIndex];
        if (key !== 'custom' && opt.dataset.pattern) {
            updateSeparatorPreview(opt.dataset.pattern);
        }
    });

    // --- Event: custom input change ---
    clipCustomInput.addEventListener('change', () => {
        clipError.textContent = '';
        vscode.postMessage({ type: 'setClipboardSeparatorPattern', pattern: clipCustomInput.value });
        updateSeparatorPreview(clipCustomInput.value);
    });

    // --- Helper text above Copy Agent Prompt button ---
    const copyPromptHint = document.createElement('div');
    copyPromptHint.style.cssText = 'padding:0 8px 4px; font-size:10px; color:var(--text-secondary); line-height:1.4;';
    copyPromptHint.innerText = 'Use this prompt to ask the agent to format the plans with the above separator.';
    container.appendChild(copyPromptHint);

    // --- Copy Agent Prompt button ---
    const copyPromptBtn = document.createElement('button');
    copyPromptBtn.className = 'secondary-btn';
    copyPromptBtn.style.cssText = 'width:calc(100% - 16px); margin:0 8px 8px;';
    copyPromptBtn.innerText = '\u{1F4CB} COPY AGENT PROMPT';
    copyPromptBtn.onclick = () => {
        const currentPattern = clipDropdown.value === 'custom'
            ? clipCustomInput.value || '### PLAN [N] START'
            : (clipDropdown.options[clipDropdown.selectedIndex]?.dataset?.pattern || '### PLAN [N] START');
        const ex1 = currentPattern.replace(/\[N\]/g, '1');
        const ex2 = currentPattern.replace(/\[N\]/g, '2');
        const prompt = `Please output all features/plans as a single markdown block with each plan separated by this exact format:\n\n${ex1}\n[plan 1 content here]\n\n${ex2}\n[plan 2 content here]\n\n[etc...]\n\nEach plan should have its own H1 title (# Plan Title) and full content. I will copy the entire block and import it into my planning system which will automatically split it into separate plan files.`;
        navigator.clipboard.writeText(prompt).then(() => {
            copyPromptBtn.innerText = '\u2713 COPIED';
            setTimeout(() => { copyPromptBtn.innerText = '\u{1F4CB} COPY AGENT PROMPT'; }, 2000);
        });
    };
    container.appendChild(copyPromptBtn);

    // --- Request initial separator state ---
    vscode.postMessage({ type: 'getClipboardSeparatorPattern' });

    return container;
}

function createAirlockPanel() {
    const container = document.createElement('div');
    container.className = 'agent-row';

    // Header
    const header = document.createElement('div');
    header.className = 'row-header';
    const identity = document.createElement('div');
    identity.className = 'agent-identity';
    const dot = document.createElement('div');
    dot.className = 'status-dot green';
    const name = document.createElement('div');
    name.className = 'agent-name';
    name.innerText = 'AIRLOCK';
    identity.appendChild(dot);
    identity.appendChild(name);
    header.appendChild(identity);
    container.appendChild(header);

    // Intro
    const intro = document.createElement('div');
    intro.style.cssText = 'padding:6px 8px; font-size:10px; color:var(--text-secondary); font-family:var(--font-mono); line-height:1.5;';
    intro.innerText = 'The Airlock allows you to upload all your code into NotebookLM to access unlimited Gemini quota for planning features and diagnosing bugs.';
    container.appendChild(intro);

    // Status line (used for bundle export feedback)
    const statusLine = document.createElement('div');
    statusLine.id = 'webai-status';
    statusLine.style.cssText = 'padding:2px 8px; font-size:10px; color:var(--text-secondary); font-family:var(--font-mono);';
    container.appendChild(statusLine);

    // Step 1: Bundle Code
    const s1Header = document.createElement('div');
    s1Header.style.cssText = 'padding:8px 8px 2px; font-size:9px; color:var(--accent-green); font-family:var(--font-mono); letter-spacing:1px; font-weight:bold;';
    s1Header.innerText = '1. BUNDLE CODE';
    container.appendChild(s1Header);

    const s1Desc = document.createElement('div');
    s1Desc.style.cssText = 'padding:0 8px 6px; font-size:10px; color:var(--text-secondary);';
    s1Desc.innerText = 'Package code into docx files for NotebookLM compatibility.';
    container.appendChild(s1Desc);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'secondary-btn';
    exportBtn.id = 'webai-export-btn';
    exportBtn.style.cssText = 'width:calc(100% - 16px); margin:0 8px 8px;';
    exportBtn.innerText = 'BUNDLE CODE';
    exportBtn.onclick = () => {
        exportBtn.disabled = true;
        exportBtn.innerText = 'BUNDLING...';
        exportBtn.classList.add('dispatching');
        vscode.postMessage({ type: 'airlock_export' });
    };
    container.appendChild(exportBtn);

    // Step 2: Upload to NotebookLM
    const s2Header = document.createElement('div');
    s2Header.style.cssText = 'padding:8px 8px 2px; font-size:9px; color:var(--accent-green); font-family:var(--font-mono); letter-spacing:1px; font-weight:bold;';
    s2Header.innerText = '2. UPLOAD TO NOTEBOOKLM';
    container.appendChild(s2Header);

    const s2Desc = document.createElement('div');
    s2Desc.style.cssText = 'padding:0 8px 6px; font-size:10px; color:var(--text-secondary);';
    s2Desc.innerText = 'Create new Notebook and upload all files in the airlock folder as sources';
    container.appendChild(s2Desc);

    const s2BtnRow = document.createElement('div');
    s2BtnRow.style.cssText = 'display:flex; gap:8px; padding:0 8px 8px;';

    const openNotebookBtn = document.createElement('button');
    openNotebookBtn.className = 'secondary-btn is-teal';
    openNotebookBtn.style.flex = '1';
    openNotebookBtn.style.minWidth = '0';
    openNotebookBtn.innerText = 'OPEN NOTEBOOKLM';
    openNotebookBtn.onclick = () => {
        vscode.postMessage({ type: 'airlock_openNotebookLM' });
    };
    s2BtnRow.appendChild(openNotebookBtn);

    const openFolderBtn = document.createElement('button');
    openFolderBtn.className = 'secondary-btn';
    openFolderBtn.style.flex = '1';
    openFolderBtn.style.minWidth = '0';
    openFolderBtn.innerText = 'OPEN FOLDER';
    openFolderBtn.onclick = () => {
        vscode.postMessage({ type: 'airlock_openFolder' });
    };
    s2BtnRow.appendChild(openFolderBtn);

    container.appendChild(s2BtnRow);

    // Step 3: Copy Sprint Planning Prompt
    // NOTE: This button reads 'airlock-separator-preset' and 'airlock-separator-input'
    // via getElementById — those elements live in createClipboardImportPanel().
    // This cross-panel dependency works because both panels share the same webview DOM.
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
        const dd = document.getElementById('airlock-separator-preset');
        const ci = document.getElementById('airlock-separator-input');
        let sepPattern = '### PLAN N START';
        if (dd) {
            if (dd.value === 'custom' && ci) {
                sepPattern = ci.value || sepPattern;
            } else {
                const opt = dd.options[dd.selectedIndex];
                if (opt && opt.dataset.pattern) sepPattern = opt.dataset.pattern;
            }
        }
        const ex1 = sepPattern.replace(/\[N\]/g, '1');
        const ex2 = sepPattern.replace(/\[N\]/g, '2');
        const prompt = `Review the "new_column_plans.md" file in the uploaded sources. For each plan listed:\n\n1. Read the "how_to_plan.md" guide to understand the planning framework\n2. Generate a highly detailed implementation plan following the guide's structure\n3. Include:\n   - Specific file paths and line numbers\n   - Step-by-step implementation instructions\n   - Dependencies and potential conflicts\n   - Complexity audit (Routine / Complex classification)\n   - Verification steps\n\n**IMPORTANT - Multi-Plan Format:**\nWhen generating multiple plans in a single response, you MUST use plan markers to delimit each plan. This enables automatic import into Switchboard:\n\n- Before each plan, add a marker line: ${ex1} (where N is the plan number)\n- The plan's H1 title should immediately follow the marker\n- Example:\n  ${ex1}\n  \n  # First Plan Title\n  [plan content...]\n  \n  ${ex2}\n  \n  # Second Plan Title\n  [plan content...]\n\nWork through all plans in the list, using the marker format above.`;
        navigator.clipboard.writeText(prompt).then(() => {
            copySprintBtn.innerText = '\u2713 COPIED';
            setTimeout(() => { copySprintBtn.innerText = 'COPY SPRINT PROMPT'; }, 2000);
        });
    };
    container.appendChild(copySprintBtn);

    // Step 4: Import plans from notebook
    const s4Header = document.createElement('div');
    s4Header.style.cssText = 'padding:8px 8px 2px; font-size:9px; color:var(--accent-green); font-family:var(--font-mono); letter-spacing:1px; font-weight:bold;';
    s4Header.innerText = '4. IMPORT PLANS FROM NOTEBOOK';
    container.appendChild(s4Header);

    const s4Desc = document.createElement('div');
    s4Desc.style.cssText = 'padding:0 8px 6px; font-size:10px; color:var(--text-secondary);';
    s4Desc.innerText = 'After NotebookLM generates the detailed plans, copy the entire response. In the Kanban view, click the [\u22EF] "Import plan from clipboard" button in the NEW column header. If multiple plans with markers are detected, they will be automatically split into separate plan files.';
    container.appendChild(s4Desc);

    return container;
}
```

**Step B — Update call site 1 (onboarding guard, line ~3372):**

Replace:
```javascript
agentListWebai.appendChild(createWebAiAirlockPanel());
```
With:
```javascript
agentListWebai.appendChild(createClipboardImportPanel());
agentListWebai.appendChild(createAirlockPanel());
```

**Step C — Update call site 2 (normal render path, line ~3491):**

Replace:
```javascript
agentListWebai.appendChild(createWebAiAirlockPanel());
```
With:
```javascript
agentListWebai.appendChild(createClipboardImportPanel());
agentListWebai.appendChild(createAirlockPanel());
```

- **Edge Cases Handled:**
  - Cross-panel `getElementById` dependency documented with inline comment at the Sprint Prompt button
  - Both call sites use identical ordering (Clipboard Import first, Airlock second)
  - `getClipboardSeparatorPattern` message fires from `createClipboardImportPanel()` where the dropdown lives
  - `webai-status` element stays in `createAirlockPanel()` where export status handlers expect it

## Verification Plan
### Manual Testing
1. Open the extension webview and navigate to the Agents → Airlock sub-tab
2. Verify "CLIPBOARD PLAN IMPORT" appears as a top-level section with its own green header dot
3. Verify the descriptive text reads "Ask your web agent to write feature plans for import. Import multiple plans by pasting a single markdown block. The separator pattern below splits content into individual plan files."
4. Verify "Use this prompt to ask the agent to format the plans with the above separator." appears above the Copy Agent Prompt button
5. Verify no random horizontal line appears in the clipboard section
6. Verify "AIRLOCK" appears as a separate top-level section below Clipboard Plan Import with its own green header dot
7. Verify all 4 NotebookLM steps (Bundle Code, Upload, Sprint Prompt, Import) remain intact under the Airlock section
8. Test that the Copy Agent Prompt button copies the correct prompt with the selected separator
9. Test that the separator preset dropdown and custom input still function
10. Test that the Sprint Prompt button correctly reads the separator from the Clipboard Import panel
11. Test that the Bundle Code button triggers export and the status line updates

### Automated Tests
- No existing automated tests cover webview DOM structure. Manual verification is sufficient for this complexity level.

## Review Results (2026-04-05)

### Implementation Status: COMPLETE

### Files Changed
- `src/webview/implementation.html` — split `createWebAiAirlockPanel()` into `createClipboardImportPanel()` + `createAirlockPanel()`, removed `clipDivider`, updated description text, added helper text, updated both call sites

### Review Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | MAJOR | `copySprintBtn` fallback `sepPattern` was `'### PLAN N START'` (no brackets), making `replace(/\[N\]/g, ...)` a no-op — sprint prompt markers would not be numbered | Fixed: changed to `'### PLAN [N] START'` (line 3741) |

### Fixes Applied
- Fixed fallback separator pattern in `copySprintBtn.onclick` from `'### PLAN N START'` to `'### PLAN [N] START'` so the regex replacement produces numbered markers

### Validation
- TypeScript check: pre-existing error only (unrelated ArchiveManager import), no new issues
- Old function `createWebAiAirlockPanel` fully removed (0 references)
- `clipDivider` block fully removed (0 references)
- Both call sites updated with consistent ordering

### Remaining Risks
- Cross-panel `getElementById` coupling between Sprint Prompt button and Clipboard Import dropdown is documented but fragile — if panels are ever conditionally rendered, this would silently fall back to defaults

### Verdict: Ready

## Switchboard State
**Kanban Column:** LEAD CODED
**Status:** active
**Last Updated:** 2026-04-06T11:26:01.324Z
**Format Version:** 1
