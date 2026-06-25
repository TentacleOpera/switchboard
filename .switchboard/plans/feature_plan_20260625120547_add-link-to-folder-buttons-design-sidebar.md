# Add "Link to Folder" Buttons to design.html Sidebar Tabs

## Goal

### Problem
In `design.html`, every tab (Design Docs, Briefs, HTML Previews, Images) renders its sidebar as a **flat list** of document cards topped only by a single "Manage Folders" button. There are **no per-folder "Link" buttons** like the ones that exist in `planning.html`'s sidebar.

### Background
`planning.html` (driven by `planning.js` `renderUnifiedDocs`) groups documents by their configured source folder and renders a `source-folder-header` for each folder. Each header carries three action buttons:
- **Link** → `vscode.postMessage({ type: 'linkToFolder', folderPath })` → copies the resolved absolute folder path to the clipboard.
- **+** (Create) → `createLocalDoc` → prompts for a new doc name.
- **Import** → `importResearchDoc` → imports from clipboard.

The "Link" button is the critical one for the user's workflow: it copies the absolute folder path so the user can paste it into an agent prompt and tell the agent exactly where to write files.

`design.html` (driven by `design.js`) has four parallel render functions — `renderDesignDocs`, `renderBriefsDocs`, `renderHtmlDocs`, `renderImagesDocs` — none of which group by source folder or emit any folder-level action buttons. Each only emits a `sidebar-folders-btn` ("Manage Folders") that opens the folders modal.

### Root Cause
Two gaps combine to produce the missing feature:

1. **Frontend (`design.js`):** The four render functions never build `source-folder-header` / `folder-link-btn` elements. They iterate `docNodes` flat and call `renderDocCard` directly. The CSS classes (`.folder-link-btn`, `.folder-create-btn`, `.folder-import-btn`, `.source-folder-header`, `.folder-subheader`) are **already present** in `design.html` (lines ~743–780) — copied over from planning but never wired up in JS.

2. **Backend (`DesignPanelProvider.ts`):** The message dispatcher handles `linkToDocument` (line 1599) but has **no `linkToFolder` case**. The `linkToFolder` handler only exists in `PlanningPanelProvider.ts` (`_handleLinkToFolder`, line 5791), which resolves the folder path and writes it to the clipboard.

The user's pain — "hard to tell agents where to write things to" — is directly caused by gap #1 (no UI to trigger it) compounded by gap #2 (no backend to fulfill it even if the UI existed).

## Metadata
- **Tags:** frontend, backend, ui, ux, feature
- **Complexity:** 4/10
- **Files touched:** `src/webview/design.js`, `src/services/DesignPanelProvider.ts`
- **Risk:** Low — additive UI + a new message handler that mirrors an existing, proven handler in PlanningPanelProvider.

## User Review Required

- **None.** All decisions are settled in this plan. Scope is deliberately limited to the per-folder **Link** button (Create/Import deferred per edge case #6); the multi-root validation strategy is specified below; no product-level choices remain open.

## Complexity Audit

### Routine
This is a parity port of an existing, working feature from the planning tab to the design tab:

- The CSS already exists in `design.html` (no stylesheet changes needed) — **verified**: `.folder-subheader`, `.source-folder-header`, `.folder-link-btn` are present (design.html lines ~714–777).
- The backend handler to mirror (`_handleLinkToFolder`) is ~50 lines and self-contained.
- The frontend change is a per-tab grouping loop that reuses the same DOM structure planning.js already uses.
- No data migrations, no settings schema changes, no kanban/DB writes.
- No new dependencies; reuses `LocalFolderService.resolveFolderPath` plus the per-kind getters `getDesignFolderPaths` / `getBriefsFolderPaths` / `getHtmlFolderPaths` / `getImagesFolderPaths` (all **verified** to exist and to return resolved-absolute paths — LocalFolderService.ts lines 387, 742, 824, 896).
- No confirm dialogs (per project rules — and `window.confirm` is a no-op in webviews anyway).
- The "Link" action is read-only (clipboard write + info toast); it cannot destroy data.

### Complex / Risky
- **Multi-root validation (the one real risk).** The frontend sends only an absolute `folderPath` with no owning-root hint, and `DesignPanelProvider` has **no `_getLocalFolderServiceForFolder` helper** (that helper exists only in `PlanningPanelProvider`). If the handler validates containment against only the primary root's configured folders, a folder belonging to a *non-primary* root will fail the `isWithinAllowed` check and surface a spurious error toast. **Mitigation:** build `allowedPaths` as the union of all four folder kinds across **all** workspace roots (see the corrected handler in Proposed Changes §1). This makes validation root-agnostic, matching how the frontend addresses folders.
- **Four-tab duplication.** design.js renders four separate tabs, so the grouping logic must be factored into a shared helper rather than copy-pasted four times.

## Edge-Case & Dependency Audit

1. **Multiple workspace roots.** `DesignPanelProvider` iterates `_getWorkspaceRoots()` and merges files across roots into one node list, tagging each with `_root`. `folderPathsByRoot` is a `Record<root, string[]>`. The `linkToFolder` handler must resolve the folder path against the correct root — mirror PlanningPanelProvider's approach: try `resolveFolderPath` via the service for the root that owns the folder, falling back to scanning all roots' folder paths for a match.

2. **Subfolder node IDs (`<index>:<relativePath>`).** PlanningPanelProvider's `_handleLinkToFolder` special-cases `^\d+:` prefixed paths (subfolder IDs). Design tab node IDs use the same `${folderIndex}:${relativePath}` scheme (see `linkToDocument` handler at DesignPanelProvider.ts:1600–1604). The new handler must support both raw absolute folder paths (from `folderPaths`) and `index:relative` subfolder IDs.

3. **Empty / unconfigured folders.** A tab may have `folderPaths` configured but zero documents (fresh setup). The folder headers with Link buttons should still render for configured folders even when empty, so the user can copy a folder path before any docs exist. Planning.js only renders headers for folders that have docs (`if (folderDocs.length === 0) return;`) — for design tabs we should render a header per *configured* folder path regardless of doc count, since the whole point is to expose the path even when empty.

4. **Folder path resolution & safety.** Reuse the same `allowedPaths` containment check PlanningPanelProvider uses (lines 5826–5830) to avoid copying arbitrary filesystem paths. If the folder doesn't exist or isn't within a configured folder, show an error toast — do not write to clipboard.

5. **Search filter interaction.** Each design tab has a search box (`state.designDocsSearch`, etc.). When a search is active, planning.js forces collapsed=false. The folder headers should still appear during search (group the filtered docs by sourceFolder); if a configured folder has zero matching docs during search, hide that header (standard search-collapse behavior) but keep showing it when no search is active (per edge case #3).

6. **No `createLocalDoc` / `importResearchDoc` parity required.** The user's issue is specifically about *linking* (copying the path) to tell agents where to write. Create/Import buttons are secondary. To keep scope tight and risk low, this plan adds **only the Link button** per folder. Create/Import can be added later if desired. (The CSS for create/import already exists, so a future addition is trivial.)

7. **`dist/` is not the source of truth.** Per project rules, do not audit or touch `dist/`. All edits go to `src/`.

### Structured audit

- **Race Conditions:** None. The render functions run synchronously on each `*DocsReady` message; the Link click handler fires a one-shot `postMessage`. The backend handler is async but performs only reads (`fs.existsSync`) and a clipboard write — no shared mutable state, no queue, no debounce interaction. The existing `_designDocsDebounce`/`_htmlDocsDebounce` timers govern list rebuilds, not this handler.
- **Security / Path safety:** The handler must reject any folder not contained within a configured folder (`isWithinAllowed`), exactly as the planning handler does, so an attacker-supplied or stale `folderPath` cannot copy arbitrary filesystem paths. Containment uses `resolvedFolder === p || resolvedFolder.startsWith(p + path.sep)` to prevent prefix-spoofing (e.g. `/foo-evil` matching `/foo`). Clipboard write happens **only after** both the containment check and `fs.existsSync` pass.
- **Side Effects:** Two, both benign and user-visible: a clipboard overwrite and an information/error toast. No file writes, no DB writes, no kanban transitions.
- **Dependencies & Conflicts:** Reuses `LocalFolderService` per-kind getters and `resolveFolderPath` (verified public API). No new imports (`fs`, `path`, `vscode`, `LocalFolderService` already imported — DesignPanelProvider.ts lines 2–8). No conflict with the existing `linkToDocument` case (verified: no `linkToFolder` case currently exists). The shared `buildFolderLinkHeader` helper is net-new and referenced only by the four render functions.

## Dependencies

- None. This plan is self-contained; it does not depend on any other in-flight Switchboard session.

## Adversarial Synthesis

**Risk Summary:** The single material risk is multi-root path validation — because the frontend sends a bare absolute path and `DesignPanelProvider` lacks the planning-side `_getLocalFolderServiceForFolder` helper, validating against only the primary root would reject legitimate non-primary-root folders. Mitigation: build `allowedPaths` as the union of all four folder kinds across **all** workspace roots, making validation root-agnostic. Secondary, lower risks (empty-folder header rendering, search-collapse behavior, subfolder-id handling) are addressed in the edge-case audit; all are read-only and cannot destroy data.

## Proposed Changes

### 1. `src/services/DesignPanelProvider.ts` — add `linkToFolder` handler

Add a new `case 'linkToFolder'` in the message dispatcher (near the existing `case 'linkToDocument'` at line 1599), plus a private `_handleLinkToFolder` method modeled on `PlanningPanelProvider._handleLinkToFolder`.

```ts
// In the message switch (after the linkToDocument case):
case 'linkToFolder': {
    await this._handleLinkToFolder(this._getWorkspaceRoot(), String(message.folderPath || ''));
    break;
}
```

```ts
/**
 * Resolve a folder path (absolute, or `<index>:<relativePath>` subfolder id)
 * to an absolute path, verify it sits within a configured design/briefs/html/images
 * folder, and copy it to the clipboard so the user can paste it into an agent prompt.
 * Mirrors PlanningPanelProvider._handleLinkToFolder.
 */
private async _handleLinkToFolder(workspaceRoot: string | undefined, folderPath: string): Promise<void> {
    try {
        if (!folderPath) {
            throw new Error('No folder path provided');
        }

        // Build the allowed-folder set across ALL roots and ALL four kinds up front.
        // The frontend sends a bare absolute path with no owning-root hint, and
        // DesignPanelProvider has no _getLocalFolderServiceForFolder helper (that
        // helper exists only in PlanningPanelProvider). Validating against a single
        // root would reject legitimate folders from non-primary roots. So we make
        // both resolution and validation root-agnostic.
        const allowedPaths: string[] = [];
        for (const root of this._getWorkspaceRoots()) {
            const svc = this._getLocalFolderService(root);
            allowedPaths.push(
                ...svc.getDesignFolderPaths(),
                ...svc.getBriefsFolderPaths(),
                ...svc.getHtmlFolderPaths(),
                ...svc.getImagesFolderPaths(),
            );
        }

        let resolvedFolder = '';

        if (/^\d+:/.test(folderPath)) {
            // Subfolder id `<index>:<relativePath>` — join against every allowed
            // base and take the first that exists on disk.
            const relativePath = folderPath.substring(folderPath.indexOf(':') + 1);
            for (const base of allowedPaths) {
                const candidate = path.join(base, relativePath);
                if (fs.existsSync(candidate)) {
                    resolvedFolder = candidate;
                    break;
                }
            }
            if (!resolvedFolder) throw new Error('Subfolder not found');
        } else {
            // Frontend sends already-resolved absolute paths (getDesignFolderPaths
            // et al. return resolved-absolute). resolveFolderPath returns an
            // absolute path unchanged; for a relative fallback it resolves against
            // the given (or primary) root.
            const svc = this._getLocalFolderService(workspaceRoot || this._getWorkspaceRoots()[0] || '');
            resolvedFolder = svc.resolveFolderPath(folderPath);
        }

        const isWithinAllowed = allowedPaths.some(
            p => resolvedFolder === p || resolvedFolder.startsWith(p + path.sep)
        );
        if (!isWithinAllowed) {
            throw new Error('Folder is not within a configured folder');
        }
        if (!fs.existsSync(resolvedFolder)) {
            throw new Error('Folder does not exist');
        }
        await vscode.env.clipboard.writeText(resolvedFolder);
        vscode.window.showInformationMessage(`Folder path copied to clipboard: ${resolvedFolder}`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to link to folder: ${String(err)}`);
    }
}
```

> **Verified notes:**
> - `DesignPanelProvider` already imports `fs`, `path`, `vscode`, and `LocalFolderService` (lines 2–8). No new imports needed.
> - `resolveFolderPath` and the four per-kind getters (`getDesignFolderPaths`, `getBriefsFolderPaths`, `getHtmlFolderPaths`, `getImagesFolderPaths`) all exist on `LocalFolderService` and return resolved-absolute paths (LocalFolderService.ts 195, 387, 742, 824, 896).
> - `_getWorkspaceRoots()` (line 386) and `_getLocalFolderService(root)` (line 390) exist. `_getWorkspaceRoot` is the constructor-injected accessor returning `string | undefined` — hence the `workspaceRoot: string | undefined` signature and the `|| this._getWorkspaceRoots()[0]` fallback.
> - There is no existing `linkToFolder` case in the dispatcher (verified), so this is purely additive. The dispatch case can simply call `await this._handleLinkToFolder(this._getWorkspaceRoot(), String(message.folderPath || ''));`

### 2. `src/webview/design.js` — add per-folder "Link" headers to each tab

Add a shared helper that builds a `source-folder-header` row (label + Link button) for a given folder path, then call it at the top of each tab's doc list. The helper mirrors the DOM planning.js builds at lines 2135–2200 but is trimmed to just the Link action.

```js
/**
 * Build a folder header row with a "Link" button that copies the folder path.
 * folderPath is the absolute configured folder path; folderPathsByRoot is the
 * map sent in the *Ready messages so we can derive a display name.
 */
function buildFolderLinkHeader(folderPath, docCount) {
    const header = document.createElement('div');
    header.className = 'folder-subheader source-folder-header';
    header.title = folderPath;

    const label = document.createElement('span');
    label.style.fontWeight = 'bold';
    const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
    label.textContent = `${folderName}${docCount != null ? ` (${docCount})` : ''}`;
    header.appendChild(label);

    const linkBtn = document.createElement('button');
    linkBtn.className = 'folder-link-btn';
    linkBtn.textContent = 'Link';
    linkBtn.title = 'Copy folder path to clipboard';
    linkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'linkToFolder', folderPath });
    });
    header.appendChild(linkBtn);

    return header;
}
```

Then in **each** of the four render functions (`renderDesignDocs`, `renderBriefsDocs`, `renderHtmlDocs`, `renderImagesDocs`), after the `docList` element is created and **before** iterating `docNodes`, insert folder headers. Two behaviors:

- **No search active:** render one `buildFolderLinkHeader(folderPath, count)` for every configured folder path in `folderPaths` (even if count is 0), so the user can always copy any configured folder's path.
- **Search active:** group the *filtered* `docNodes` by `node.metadata?.sourceFolder` and render a header only for folders that have matching docs (standard search-collapse).

Example insertion point in `renderDesignDocs` (after line ~501, before the `docNodes.forEach`):

```js
const search = String(state.designDocsSearch || '').trim().toLowerCase();
// ... existing search filter on docNodes ...

// Render folder Link headers.
const folderPathsList = folderPaths || [];
if (search) {
    // Group filtered docs by sourceFolder; only show folders with matches.
    const byFolder = new Map();
    docNodes.forEach(d => {
        const sf = d.metadata?.sourceFolder;
        if (!sf) return;
        if (!byFolder.has(sf)) byFolder.set(sf, []);
        byFolder.get(sf).push(d);
    });
    [...byFolder.entries()].forEach(([sf, docs]) => {
        docList.appendChild(buildFolderLinkHeader(sf, docs.length));
    });
} else {
    // Show every configured folder, even empty ones.
    const countByFolder = new Map();
    docNodes.forEach(d => {
        const sf = d.metadata?.sourceFolder;
        if (sf) countByFolder.set(sf, (countByFolder.get(sf) || 0) + 1);
    });
    folderPathsList.forEach(fp => {
        docList.appendChild(buildFolderLinkHeader(fp, countByFolder.get(fp) || 0));
    });
    // Also surface any sourceFolders seen on docs that aren't in folderPaths
    // (defensive — shouldn't normally happen).
    const configuredSet = new Set(folderPathsList);
    countByFolder.forEach((cnt, sf) => {
        if (!configuredSet.has(sf)) docList.appendChild(buildFolderLinkHeader(sf, cnt));
    });
}
```

Repeat the same block in `renderBriefsDocs`, `renderHtmlDocs`, and `renderImagesDocs`, swapping in the tab's own `search` state field (`state.briefsDocsSearch`, `state.htmlDocsSearch`, `state.imagesDocsSearch`) and the tab's own `folderPaths` variable (already destructured from `rootEntry` in each function).

> The CSS classes referenced (`.folder-subheader`, `.source-folder-header`, `.folder-link-btn`) already exist in `design.html` lines ~700–780, so no stylesheet edits are required.

## Verification Plan

### Automated Tests
- No automated tests are added for this change (additive UI + a read-only clipboard handler). The existing suite is sufficient as a regression guard and will be run separately by the user. Compilation/type-checking is likewise deferred to the user (per this session's skip directives) — when the user does build, confirm there are no new TypeScript errors in `DesignPanelProvider.ts` (the `workspaceRoot: string | undefined` signature plus the all-roots `allowedPaths` loop type-check cleanly against the existing helpers).

### Manual Verification
1. **Build/type check (deferred to user):** confirm `DesignPanelProvider.ts` has no new TypeScript errors.
2. **Manual — Design Docs tab:**
   - With ≥1 configured design folder containing docs: a folder header with a "Link" button appears per configured folder; clicking "Link" copies the absolute path and shows the info toast; pasting elsewhere yields the correct absolute path.
   - With a configured folder that is empty: the header + Link button still appear (count `0`), and "Link" still copies the path.
   - Type a search term: only folders with matching docs show headers; non-matching folders hide.
3. **Manual — Briefs / HTML Previews / Images tabs:** repeat step 2 for each tab; confirm the Link button and clipboard copy work identically.
4. **Multi-root workspace:** with two workspace roots each configuring a design folder, confirm the correct absolute path is copied for a folder from the non-primary root (verifies the root-scan fallback in `_handleLinkToFolder`).
5. **Subfolder IDs:** if a doc lives in a subfolder, confirm a Link button whose `folderPath` is an `index:relative` style id resolves correctly (path exists check passes and the right absolute path is copied). If the design tabs don't currently emit subfolder-level headers (this plan only emits top-level configured-folder headers), this case is N/A but the handler must still not crash on such an id.
6. **Error path:** temporarily point a configured folder at a deleted directory, click Link → expect an error toast "Failed to link to folder: Folder does not exist" and nothing written to the clipboard.
7. **No confirm dialogs:** confirm no `window.confirm` / modal gate was introduced (per project rules).

---

## Recommendation

**Complexity 4/10 → Send to Coder.** The work is a well-scoped parity port: additive frontend (one shared helper + four insertion points) plus one read-only backend handler that mirrors a proven one. The only non-trivial judgment call — root-agnostic multi-root validation — is now fully specified in the corrected handler above.
