# Research Tab UX Fixes — Clear Inputs, Update Copy, Remove Stale UI, Fix Folder Dropdown

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix

## Goal

Fix five UX papercuts in the Research tab of the Planning panel (`planning.html` / `planning.js`) that cause manual cleanup, stale information, and a broken folder selector.

## Problems & Root Cause

1. **Manual input clearing after copy.** The "COPY PROMPT TEMPLATE" button copies the generated meta-prompt but leaves the user's topic in the `research-prompt-input` textarea. Users must clear it manually before drafting the next research topic.
2. **Outdated step 2 instructions.** Item 4 in Step 2 tells the user to "copy the resulting markdown output," which is ambiguous. Google AI Studio's response menu at the top right has a specific "Copy as markdown" action that should be referenced.
3. **Stale free-tier note.** A grey text block below Step 2 explains Gemini Flash's free tier limits. This information is no longer relevant to the current workflow and clutters the UI.
4. **Persistent import status.** After a successful research document import, the status text `Imported: <docTitle>` is written to `#research-import-status` and stays visible indefinitely. It never auto-clears, creating visual noise and making it unclear whether a *new* import has started.
5. **Research destination folder dropdown is always empty.** The `research-destination-folder` `<select>` is only populated in the `localFoldersListed` message handler. However, the webview never sends `listLocalFolders` — it only sends `refreshSource` for `local-folder`, which triggers `localDocsReady`. That handler (`handleLocalFolderPathUpdated`) updates `state.localFolderPaths` and re-renders the Local Docs tree, but it never populates the Research tab's dropdown. Result: even when folders are configured and visible in the Local Docs tab, the Research tab shows an empty dropdown.

## Proposed Changes

### `src/webview/planning.js`

1. **Clear research prompt input on copy.** In the `btn-copy-research-prompt` click handler (around line 380), after successfully writing the prompt to the clipboard, set `document.getElementById('research-prompt-input').value = ''`.
2. **Auto-clear import status.** In the `importResearchDocResult` handler (around line 3354), after setting the success text, add a `setTimeout` (e.g., 4000 ms) to clear `#research-import-status` text content. This keeps the confirmation visible long enough to read but removes it before the next interaction.
3. **Sync research dropdown on folder updates.** In `handleLocalFolderPathUpdated` (around line 2827), after updating `state.localFolderPaths`, mirror the same dropdown-population logic that currently exists in the `localFoldersListed` handler: select `#research-destination-folder`, clear and rebuild its `<option>` list from `state.localFolderPaths`, restore the persisted `lastResearchFolder` selection if valid, and toggle `#research-no-folders-warning` visibility. Extracting a small helper (e.g., `populateResearchFolderSelect(paths)`) is preferred to avoid code duplication.

### `src/webview/planning.html`

4. **Update Step 2 item 4 text.** Change line 3136 from:
   ```html
   <li>Run the prompt and copy the resulting markdown output.</li>
   ```
   to:
   ```html
   <li>Run the prompt and use the response menu at the top right to copy as markdown.</li>
   ```
5. **Remove free-tier note.** Delete the grey `planning-card-description` block at lines 3139-3141 that contains the `<strong>Note about free tier:</strong>` text.

## Acceptance Criteria

- [ ] Clicking "COPY PROMPT TEMPLATE" clears the Central Question textarea immediately after copying.
- [ ] Step 2, item 4 reads: "Run the prompt and use the response menu at the top right to copy as markdown."
- [ ] The grey Gemini Flash free-tier note is no longer visible.
- [ ] After importing a research document, the "Imported: …" status disappears automatically after ~4 seconds.
- [ ] When local folders are configured, the Research tab's "Destination Folder" dropdown lists them correctly and retains the last selected folder across sessions.

## Risks

- **Low.** All changes are localized to the Research tab UI. No backend or data-layer modifications are required. The dropdown fix only reuses existing state and DOM APIs.
- **Edge case:** If `handleLocalFolderPathUpdated` is called before the Research tab DOM is rendered (e.g., on initial load before the user switches to the Research tab), the helper must safely no-op when `#research-destination-folder` is not found — which is already the pattern used in the `localFoldersListed` handler.

## Files to Modify

- `src/webview/planning.js`
- `src/webview/planning.html`
