# Clean Imported Docs and Local Folder Integration

Integrate clipboard research imports and document imports with the user's configured local docs folder. Write imported documents directly into the first configured local doc directory as clean markdown files (without YAML front-matter), displaying a configuration error if no local doc folder is configured. Also clean up the research prompt generation template to remove redundant repetition of the central question.

## Goal

Redirect all document imports (Notion, ClickUp, Linear, clipboard research) from the hidden `.switchboard/docs/` directory into the user's first configured local docs folder, writing clean markdown without YAML front-matter, and fix the research prompt template's redundant sub-question repetition.

## Metadata

**Tags:** [frontend, backend, UX]
**Complexity:** 5

## User Review Required

> [!NOTE]
> All document imports (Notion, ClickUp, Linear, and clipboard research docs) will now save directly into the first folder configured in your **LOCAL DOCS** tab (e.g. `docs/` or `research/`).
> If you have no folders configured on that tab, attempting to import a document will now show an explicit configuration error.
>
> **Existing imports** in `.switchboard/docs/` are **not affected** — they continue to work as-is. Only *new* imports go to the local docs folder.

## Complexity Audit

### Routine
- Adding `'research-clipboard': 'Research'` to `SOURCE_DISPLAY_NAMES` in planning.js
- Replacing `${customPrompt}` with a static string in `generateResearchPrompt()` sub-question 1
- Updating the delete confirmation dialog text from `.switchboard/docs?` to reference local docs
- Stripping YAML front-matter from write path (already done for input content at lines 153 and 216; need to stop *generating* it in `_writeDocToDocsDir`)

### Complex / Risky
- Redirecting `_writeDocToDocsDir` destination from `.switchboard/docs/` to the first local docs folder path — changes the core write path used by 3 public methods
- Removing YAML front-matter generation while maintaining `docName` resolution in `_handleFetchDocsFile` — requires a 3-tier fallback (DB → H1 header → filename slug)
- Ensuring the delete handler (`deleteImportedDoc`) can resolve paths for both legacy (`.switchboard/docs/`) and new (local docs folder) imports
- Refreshing the local docs tree after a successful import (different DOM container from the imported-docs list)

## Edge-Case & Dependency Audit

**Race Conditions:**
- `_writeQueue` in PlannerPromptWriter already serializes writes per workspace root (lines 21, 145-148, 201-204, 258-261). No new race condition from changing the destination directory.

**Security:**
- Writing to user-configured local docs folder: must validate the resolved path is within the configured folder (prevent path traversal via `docTitle`). `LocalFolderService.resolveFolderPath()` already handles `~` expansion and relative-to-absolute resolution.
- The delete handler must not allow deletion outside configured folder paths — existing `deleteFile()` in LocalFolderService already has path traversal protection (lines 411-414).

**Side Effects:**
- Existing imports in `.switchboard/docs/` remain untouched. The `_handleFetchImportedDocs` heal scan still walks `.switchboard/docs/` for legacy entries. No data loss.
- The `designDocLink` configuration update (lines 88-99) currently points at `.switchboard/docs/` paths. After redirect, new imports will set `designDocLink` to the local docs folder path. This is a behavior change — the design doc link will now point at a user-visible file rather than a hidden one.

**Dependencies & Conflicts:**
- `PlanningPanelCacheService.registerImport()` stores `filePath` from the write result. After redirect, this will store the local docs folder path. The DB-based `resolveImportedDocPath()` will correctly resolve new imports. Legacy entries still resolve to `.switchboard/docs/`.
- The `_handleFetchDocsFile` fallback (line 2336-2339) constructs a `.switchboard/docs/` path. For new imports, the DB lookup succeeds first, so this fallback is only reached for legacy entries. No conflict.
- The `writeFromCache` method (line 252-338) reads from `.switchboard/{source}-cache.md` and then calls `_writeDocToDocsDir`. After redirect, the cache read still works (unchanged), but the write destination changes. This is correct behavior.

## Dependencies

None

## Adversarial Synthesis

Key risks: front-matter removal breaks `docName` resolution in `_handleFetchDocsFile` unless a DB-first fallback is implemented; the delete handler's path fallback still assumes `.switchboard/docs/` for missing DB entries; and the local docs tree refresh after import targets a different DOM container than the imported-docs list. Mitigations: implement 3-tier docName resolution (DB → H1 header → filename), ensure DB registration is preserved for all write paths, and trigger `_sendLocalDocsReady()` from the backend after a successful import to refresh the correct tree.

## Proposed Changes

### Extension Services (Backend)

---

#### [MODIFY] [PlannerPromptWriter.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlannerPromptWriter.ts)

* Resolve the target directory for document imports using the first folder path in `research.localFolderPaths` from the `LocalFolderService` (via `this._options.getLocalFolderService(workspaceRoot).getFolderPaths()[0]`).
* Raise an error with the message `"No local docs folder configured. Add a folder in the LOCAL DOCS tab before importing."` if `getFolderPaths()` returns an empty array.
* In `_writeDocToDocsDir` (lines 53-126):
  - Replace the hardcoded `.switchboard/docs/` destination (line 67) with the resolved local docs folder path.
  - Remove the YAML front-matter generation block (lines 74-82). Write only the raw content to disk.
  - Change the filename convention from `slug_hash.md` to `slug.md` for user-visible folders. Handle collisions by appending an incrementing suffix (e.g. `slug_1.md`, `slug_2.md`).
  - Preserve the `designDocLink` update logic (lines 88-99) — it will now point at the local docs folder path.
  - Preserve the import registry registration (called from `writeContentToDocsDir` lines 158-176 and `writeFromPlanningCache` lines 220-237) — the `filePath` in the DB will now store the local docs folder path.
* **Clarification**: The `mkdir` call (line 68) should use the resolved local docs folder path. If the folder doesn't exist yet, create it. This matches the existing `recursive: true` behavior.

#### [MODIFY] [PlanningPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts)

* In `_handleFetchDocsFile` (lines 2318-2386):
  - Replace the front-matter-based `docName` resolution (lines 2354-2358) with a 3-tier fallback:
    1. **DB lookup first** (already available via `cacheService.resolveImportedDocPath` and import registry metadata — add a `resolveImportedDocName` method or query the import entry's `docName` field).
    2. **Top-level `# H1` header** — parse `content.match(/^#\s+(.+)$/m)` to extract the first H1 as docName.
    3. **Filename-as-slug** — derive docName from the filename by removing the hash suffix and replacing underscores with spaces.
  - Remove the front-matter stripping line (line 2362) since new imports won't have front-matter. Keep it as a defensive measure for legacy files: `const displayContent = content.replace(/^---\n[\s\S]*?\n---\n/, '');` — this is already idempotent (no-op if no front-matter exists).

* In `deleteImportedDoc` handler (lines 1183-1222):
  - Update the warning message (line 1187) from `Delete "${docName}" from .switchboard/docs?` to `Delete "${docName}" from local docs?`.
  - The DB-based path resolution (lines 1196-1200) already stores the correct `filePath` for new imports. The fallback (line 1204) still constructs `.switchboard/docs/` paths — this is acceptable for legacy entries only. No change needed for the fallback path.

* In `_handleImportResearchDoc` (lines 2696-2754):
  - After a successful import, also call `this._sendLocalDocsReady()` to refresh the local docs tree in the webview. This ensures the newly imported document appears in the LOCAL DOCS tab immediately.
  - **Clarification**: This is the mechanism for the frontend's "remove empty-state placeholder" requirement — the local docs tree refresh will naturally replace the empty state with the new file listing.

### Webview Interface (Frontend)

---

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js)

* In `SOURCE_DISPLAY_NAMES` (line 311-316), add the missing entry:
  ```javascript
  'research-clipboard': 'Research'
  ```

* In `generateResearchPrompt()` (lines 2397-2456), change sub-question 1 (line 2434) from:
  ```javascript
  1. ${customPrompt} — core framing
  ```
  to:
  ```javascript
  1. Core framing of the central question and key definitions
  ```

* In `handleImportedDocsReady()` (lines 1675+):
  - After populating the imported docs list, also remove any `.empty-state` placeholder from the **local docs tree** container (not the imported-docs list). The local docs tree is rendered by `_sendLocalDocsReady` messages. Specifically, after a successful import, the backend sends a `localDocsReady` message which rebuilds the tree — the empty state is naturally removed when the tree has content. No additional frontend code is needed if the backend triggers `_sendLocalDocsReady()` after import (as specified above).

## Verification Plan

### Automated Tests
* Run the existing test suite:
  ```bash
  npm test
  ```
  *(Skipped per session directive — user will run separately.)*

### Manual Verification
1. Open the Switchboard panel and switch to the **LOCAL DOCS** tab. Ensure no local folders are configured.
2. Go to the **CLIPBOARD IMPORT** or **RESEARCH** tab, enter a query, click **COPY PROMPT**, and verify the copied text does not contain duplicate copies of the central question.
3. Click **IMPORT RESEARCH DOC** with no folders configured and verify a clean error message is shown: "No local docs folder configured. Add a folder in the LOCAL DOCS tab before importing."
4. Add a local folder in the **LOCAL DOCS** tab (e.g. `docs`).
5. Go back and import the research doc again. Verify the import succeeds.
6. Verify the imported document appears directly in the main file list of the **LOCAL DOCS** tab (the empty-state placeholder should be gone).
7. Open the generated file in VS Code and verify it contains only clean markdown content with no YAML front-matter at the top.
8. Verify that **existing** imported docs in `.switchboard/docs/` still appear in the imported docs list and can be previewed/deleted normally.
9. Verify the delete confirmation dialog now says "from local docs?" instead of "from .switchboard/docs?".
10. Verify the `SOURCE_DISPLAY_NAMES` shows "Research" (not "research-clipboard") for clipboard imports in the imported docs header.

## Recommendation

Complexity 5 → **Send to Coder**
