# Research Tab UX Fixes — Clear Inputs, Update Copy, Remove Stale UI, Fix Folder Dropdown

## Goal

Fix five UX papercuts in the Research tab of the Planning panel (`planning.html` / `planning.js`) that cause manual cleanup, stale information, and a broken folder selector.

### Problems & Root Cause

1. **Manual input clearing after copy.** The "COPY PROMPT TEMPLATE" button copies the generated meta-prompt but leaves the user's topic in the `research-prompt-input` textarea. Users must clear it manually before drafting the next research topic.
2. **Outdated step 2 instructions.** Item 4 in Step 2 tells the user to "copy the resulting markdown output," which is ambiguous. Google AI Studio's response menu at the top right has a specific "Copy as markdown" action that should be referenced.
3. **Stale free-tier note.** A grey text block below Step 2 explains Gemini Flash's free tier limits. This information is no longer relevant to the current workflow and clutters the UI.
4. **Persistent import status.** After a successful research document import, the status text `Imported: <docTitle>` is written to `#research-import-status` and stays visible indefinitely. It never auto-clears, creating visual noise and making it unclear whether a *new* import has started.
5. **Research destination folder dropdown is always empty.** The `research-destination-folder` `<select>` is only populated in the `localFoldersListed` message handler (lines 3398-3440). However, the webview never sends `listLocalFolders` — it only sends `refreshSource` for `local-folder`, which triggers `localFolderPathUpdated`. That handler (`handleLocalFolderPathUpdated`, lines 2827-2843) updates `state.localFolderPaths` and re-renders the Local Docs tree, but it never populates the Research tab's dropdown. Result: even when folders are configured and visible in the Local Docs tab, the Research tab shows an empty dropdown.

## Metadata

- **Tags:** frontend, ui, ux, bugfix
- **Complexity:** 3

## User Review Required

- Confirm that clearing the Central Question textarea after copy is desired behavior (users who iterate on the same topic will need to re-type). The clear is delayed 2 seconds to align with the "COPIED" button feedback, giving a brief window to notice.
- Confirm that error status messages should remain persistent (not auto-cleared), while success messages auto-dismiss after 4 seconds.

## Complexity Audit

### Routine
- Clear textarea after copy (single line added to existing setTimeout)
- Update Step 2 item 4 text (single HTML line change)
- Remove free-tier note (delete 3 HTML lines)
- Auto-clear import status (add setTimeout with timeout ID tracking)

### Complex / Risky
- Extract `populateResearchFolderSelect` helper and call from two code paths — requires careful extraction of 38 lines of inline logic from `localFoldersListed` handler (lines 3402-3439) into a reusable function, then calling it from both `localFoldersListed` and `handleLocalFolderPathUpdated`. Must guard all DOM lookups with `if` checks since Research tab DOM may not be rendered yet.

## Edge-Case & Dependency Audit

- **Race Conditions:** Rapid successive imports will cause overlapping `setTimeout` calls for status auto-clear. Mitigated by tracking timeout ID (`researchStatusTimeout`) and calling `clearTimeout` before setting a new timeout.
- **Security:** No concerns. All changes are client-side DOM manipulation with no user input escaping or external data handling.
- **Side Effects:** The `populateResearchFolderSelect` helper toggles the import button's `disabled`/`opacity` state. When called from `handleLocalFolderPathUpdated`, this means the import button state updates on every folder path change — which is correct behavior (disable import when no folders exist).
- **Dependencies & Conflicts:** The `localFoldersListed` handler (lines 3398-3440) and `handleLocalFolderPathUpdated` (lines 2827-2843) both modify `state.localFolderPaths`. The helper reads from `state.localFolderPaths` indirectly (via parameter), so no conflict. The `lastResearchFolder` persistence via `vscode.getState()/setState()` is already used consistently.

## Dependencies

None — all changes are self-contained within the Research tab UI.

## Adversarial Synthesis

Key risks: (1) textarea clear may surprise users iterating on the same topic — mitigated by 2-second delay aligned with button feedback; (2) untracked setTimeout for status auto-clear causes stale timeouts to wipe new status text — mitigated by timeout ID tracking with `clearTimeout`; (3) helper extraction must guard all three DOM lookups (`folderSelect`, `warningEl`, `importBtn`) since Research tab DOM may not be rendered when `handleLocalFolderPathUpdated` fires on initial load.

## Proposed Changes

### `src/webview/planning.js`

1. **Clear research prompt input on copy (delayed).** In the `btn-copy-research-prompt` click handler, the textarea clear should be delayed to align with the existing 2-second "COPIED" feedback window. At line 395, inside the existing `setTimeout` callback that resets the button text, add the textarea clear:

   **Current code (lines 393-397):**
   ```javascript
   await navigator.clipboard.writeText(prompt);
   copyResearchPromptBtn.innerText = 'COPIED';
   setTimeout(() => {
       if (copyResearchPromptBtn) copyResearchPromptBtn.innerText = originalText;
   }, 2000);
   ```

   **Updated code:**
   ```javascript
   await navigator.clipboard.writeText(prompt);
   copyResearchPromptBtn.innerText = 'COPIED';
   setTimeout(() => {
       if (copyResearchPromptBtn) copyResearchPromptBtn.innerText = originalText;
       const researchInput = document.getElementById('research-prompt-input');
       if (researchInput) researchInput.value = '';
   }, 2000);
   ```

   This clears the textarea at the same moment the button reverts from "COPIED" to its original label, giving the user a 2-second window to notice the copy succeeded before the input is cleared. The `if (researchInput)` guard prevents errors if the element is absent.

2. **Auto-clear import status with timeout tracking.** Add a module-level timeout ID variable near the top of the file (after the `state` object declaration, around line 9):

   ```javascript
   let researchStatusTimeout = null;
   ```

   Then in the `importResearchDocResult` handler's success branch (after line 3366, before the `} else {` at line 3367), add auto-clear logic for **both** status elements:

   ```javascript
   // Auto-clear success status after 4 seconds
   if (researchStatusTimeout) clearTimeout(researchStatusTimeout);
   researchStatusTimeout = setTimeout(() => {
       if (researchStatusEl) researchStatusEl.textContent = '';
       if (statusEl) statusEl.textContent = '';
       researchStatusTimeout = null;
   }, 4000);
   ```

   This clears both `#research-import-status` and `#status` after 4 seconds. The `clearTimeout` call prevents a previous timeout from wiping new status text if the user triggers another import quickly. Error messages (the `else` branch at line 3367) are NOT auto-cleared — they persist until the next action, ensuring the user sees failure feedback.

3. **Extract `populateResearchFolderSelect` helper and call from both code paths.**

   **3a.** Add the helper function after `handleLocalFolderPathUpdated` (after line 2843):

   ```javascript
   function populateResearchFolderSelect(paths) {
       const folderSelect = document.getElementById('research-destination-folder');
       const warningEl = document.getElementById('research-no-folders-warning');
       const importBtn = document.getElementById('btn-import-research-doc-clipboard');

       const hasFolders = paths && paths.length > 0;

       if (warningEl) {
           warningEl.style.display = hasFolders ? 'none' : 'block';
       }
       if (importBtn) {
           importBtn.disabled = !hasFolders;
           importBtn.style.opacity = hasFolders ? '1' : '0.4';
       }

       if (folderSelect) {
           folderSelect.innerHTML = '';
           (paths || []).forEach(p => {
               const opt = document.createElement('option');
               opt.value = p;
               opt.textContent = p.split('/').pop() || p;
               folderSelect.appendChild(opt);
           });

           if (hasFolders) {
               if (state.lastResearchFolder && paths.includes(state.lastResearchFolder)) {
                   folderSelect.value = state.lastResearchFolder;
               } else {
                   state.lastResearchFolder = paths[0];
                   const currentPersisted = vscode.getState() || {};
                   vscode.setState({ ...currentPersisted, lastResearchFolder: state.lastResearchFolder });
                   folderSelect.value = state.lastResearchFolder;
               }
           } else {
               state.lastResearchFolder = null;
               const currentPersisted = vscode.getState() || {};
               vscode.setState({ ...currentPersisted, lastResearchFolder: null });
           }
       }
   }
   ```

   All three DOM lookups (`folderSelect`, `warningEl`, `importBtn`) are guarded with `if` checks, so the helper safely no-ops when the Research tab DOM hasn't been rendered yet (e.g., on initial load before the user switches to the Research tab).

   **3b.** Replace the inline dropdown logic in the `localFoldersListed` handler (lines 3402-3439) with a single call:

   **Current code (lines 3398-3440):**
   ```javascript
   case 'localFoldersListed':
       state.localFolderPaths = msg.paths || [];
       renderFolderList(state.localFolderPaths);
       renderFolderListModal();
       const folderSelect = document.getElementById('research-destination-folder');
       const warningEl = document.getElementById('research-no-folders-warning');
       const importBtn = document.getElementById('btn-import-research-doc-clipboard');
       
       const hasFolders = msg.paths && msg.paths.length > 0;
       
       if (warningEl) {
           warningEl.style.display = hasFolders ? 'none' : 'block';
       }
       if (importBtn) {
           importBtn.disabled = !hasFolders;
           importBtn.style.opacity = hasFolders ? '1' : '0.4';
       }

       if (folderSelect) {
           folderSelect.innerHTML = '';
           (msg.paths || []).forEach(p => {
               const opt = document.createElement('option');
               opt.value = p;
               opt.textContent = p.split('/').pop() || p;
               folderSelect.appendChild(opt);
           });

           if (hasFolders) {
               if (state.lastResearchFolder && msg.paths.includes(state.lastResearchFolder)) {
                   folderSelect.value = state.lastResearchFolder;
               } else {
                   state.lastResearchFolder = msg.paths[0];
                   const currentPersisted = vscode.getState() || {};
                   vscode.setState({ ...currentPersisted, lastResearchFolder: state.lastResearchFolder });
                   folderSelect.value = state.lastResearchFolder;
               }
           } else {
               state.lastResearchFolder = null;
               const currentPersisted = vscode.getState() || {};
               vscode.setState({ ...currentPersisted, lastResearchFolder: null });
           }
       }
       break;
   ```

   **Updated code:**
   ```javascript
   case 'localFoldersListed':
       state.localFolderPaths = msg.paths || [];
       renderFolderList(state.localFolderPaths);
       renderFolderListModal();
       populateResearchFolderSelect(msg.paths || []);
       break;
   ```

   **3c.** Add the helper call to `handleLocalFolderPathUpdated` (after line 2842, before the closing `}`):

   **Current code (lines 2827-2843):**
   ```javascript
   function handleLocalFolderPathUpdated(msg) {
       const { folderPath, folderPaths, nodes } = msg;
       if (folderPaths) {
           state.localFolderPaths = folderPaths;
       } else if (folderPath) {
           state.localFolderPaths = [folderPath];
       }
       renderFolderList(state.localFolderPaths);
       renderFolderListModal();

       // Delegate to renderLocalDocs to ensure consistent source-folder grouping
       renderLocalDocs({
           sourceId: 'local-folder',
           nodes: nodes || [],
           folderPaths: state.localFolderPaths
       });
   }
   ```

   **Updated code:**
   ```javascript
   function handleLocalFolderPathUpdated(msg) {
       const { folderPath, folderPaths, nodes } = msg;
       if (folderPaths) {
           state.localFolderPaths = folderPaths;
       } else if (folderPath) {
           state.localFolderPaths = [folderPath];
       }
       renderFolderList(state.localFolderPaths);
       renderFolderListModal();
       populateResearchFolderSelect(state.localFolderPaths);

       // Delegate to renderLocalDocs to ensure consistent source-folder grouping
       renderLocalDocs({
           sourceId: 'local-folder',
           nodes: nodes || [],
           folderPaths: state.localFolderPaths
       });
   }
   ```

### `src/webview/planning.html`

4. **Update Step 2 item 4 text.** At line 3136, change:

   ```html
   <li>Run the prompt and copy the resulting markdown output.</li>
   ```

   to:

   ```html
   <li>Run the prompt and use the response menu at the top right to copy as markdown.</li>
   ```

5. **Remove free-tier note.** Delete lines 3139-3141, the grey `planning-card-description` block:

   ```html
   <div class="planning-card-description" style="margin-top: 12px; font-size: 11px; color: var(--text-secondary);">
       <strong>Note about free tier:</strong> Gemini Flash models are free with generous limits (5,000 search queries/month). Search Grounding uses Google Search to find up-to-date sources.
   </div>
   ```

## Acceptance Criteria

- [ ] Clicking "COPY PROMPT TEMPLATE" clears the Central Question textarea after the 2-second "COPIED" feedback window.
- [ ] Step 2, item 4 reads: "Run the prompt and use the response menu at the top right to copy as markdown."
- [ ] The grey Gemini Flash free-tier note is no longer visible.
- [ ] After importing a research document, the "Imported: …" status disappears automatically after ~4 seconds from both `#research-import-status` and `#status`.
- [ ] Rapid successive imports do not cause status text to vanish prematurely (timeout ID tracking prevents stale timeouts).
- [ ] Error status messages remain persistent (not auto-cleared).
- [ ] When local folders are configured, the Research tab's "Destination Folder" dropdown lists them correctly and retains the last selected folder across sessions.
- [ ] The dropdown populates both when `localFoldersListed` fires and when `handleLocalFolderPathUpdated` fires.
- [ ] The `populateResearchFolderSelect` helper safely no-ops when Research tab DOM elements are not yet rendered.

## Verification Plan

### Automated Tests

- No automated tests required. All changes are UI-only (webview DOM manipulation) with no backend or data-layer impact. Manual verification via the Research tab in the Planning panel is sufficient:
  1. Enter a topic, click "COPY PROMPT TEMPLATE" → verify textarea clears after 2 seconds.
  2. Verify Step 2 item 4 text and absence of free-tier note.
  3. Import a research doc → verify status auto-clears after ~4 seconds from both status elements.
  4. Trigger a second import quickly → verify first status doesn't wipe the second.
  5. Configure local folders → verify dropdown populates in Research tab.
  6. Add/remove folders → verify dropdown updates accordingly.

## Risks

- **Low.** All changes are localized to the Research tab UI. No backend or data-layer modifications are required. The dropdown fix only reuses existing state and DOM APIs.
- **Edge case:** If `handleLocalFolderPathUpdated` is called before the Research tab DOM is rendered (e.g., on initial load before the user switches to the Research tab), the helper safely no-ops — all three DOM lookups (`folderSelect`, `warningEl`, `importBtn`) are guarded with `if` checks, consistent with the existing pattern in the `localFoldersListed` handler.
- **Edge case:** If the user wants to iterate on the same research topic after copying, the textarea will be cleared. The 2-second delay provides a brief window to notice, and the topic must be re-typed. This is the explicitly requested behavior.

## Files to Modify

- `src/webview/planning.js`
- `src/webview/planning.html`

## Recommendation

Complexity 3 → **Send to Intern**
