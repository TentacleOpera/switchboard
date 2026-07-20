# Merge the Dev Docs tab into the Docs tab

## Metadata
- **Complexity:** 4
- **Tags:** frontend, backend, refactor, ui, docs

## What this does

Delete the Dev Docs tab and fold its two useful affordances (`+ New Doc`, `Draft with agent`) into the existing Docs tab, so there's one tab for markdown docs, governed by the Docs tab's Manage Folders model. **Docs stay undifferentiated** — no per-folder role, no `DEV` badge, no accessor (the source filter stays sources-only). Deleting the project-context auto-bundle is a *separate* subtask (`delete-project-context-auto-bundle.md`) — not here.

> Split from the original merge plan; the auto-bundle deletion moved to its own subtask. Content preserved.

## Steps

### 1 — Docs tab gains the two buttons (frontend)
- **`src/webview/planning.html`** — in the Docs controls strip (`#controls-strip-docs`, lines 3704–3726), after `btn-set-constitution` add:
  - `<button id="btn-create-doc" class="strip-btn" title="Create a new markdown doc in a configured folder">+ New Doc</button>`
  - `<button id="btn-agent-doc" class="strip-btn" disabled title="Copy a Draft/Improve prompt to clipboard">Draft with agent</button>`
  - Do NOT touch `docs-source-filter` (stays sources-only). Do NOT add a folder-role selector to Manage Folders.
- **`src/webview/planning.js`** — wire `btn-create-doc`: gate on `state.activeSource === 'local'`; if a local folder is selected send `createLocalDoc` with its `folderPath` (reuses `_handleCreateLocalDoc`, no new message type); else quick-pick a configured folder; else toast "Add a folder via Manage Folders first." Wire `btn-agent-doc`: enabled only when a local doc is selected (mirror `btn-push-doc`); on click post `draftImproveLocalDoc` with `{ path, title, hasContent }`.
- **`src/services/PlanningPanelProvider.ts`** — add the `draftImproveLocalDoc` handler: copy of `draftImproveDevDoc` (lines 2763–2788), but path = the selected local doc's absolute path, workspace root derived from the folder's owning workspace, no `_resolveDevDocPath` gate (use the Docs tab's existing local-doc path resolution).

### 2 — Delete the Dev Docs tab surface (frontend)
- **`planning.html`** — remove the `data-tab="devdocs"` button (3698), the `#devdocs-content` section (3979–4015), and the Dev Docs CSS block (3582–3656).
- **`planning.js`** — delete the contiguous Dev Docs JS block via `grep -n "renderDevDocsList\|devdocs" src/webview/planning.js` (line 12280 through ~12585 — the last `renderDevDocsList()` call, NOT 12469). Then remove the `devdocs` branch from `enterEditMode`, `exitEditMode`, `state.dirtyFlags.devdocs`, `applySidebarState('devdocs', …)`, `persistTab('devdocs.root', …)`, the `devdocsListCollapsed` key, and the edit-mode button-map entry (line 8140). Add a one-time cleanup on panel load: if `devdocsListCollapsed`/`devdocs.root` exist in `vscode.getState()`, delete and re-persist.

### 3 — Delete the Dev Docs backend
- **`PlanningPanelProvider.ts`** — delete handlers `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `importDevDocFromClipboard`, `draftImproveDevDoc`, `deleteDevDoc` (2668–2806; keep `draftImproveLocalDoc` from step 1). Delete private methods `_listDevDocs`, `_resolveDevDocPath`, `_devDocsFolder`, `_devDocsFolderRelative`, `_setupActiveDevDocWatcher`, `_importDevDocFromClipboard`, and their watcher state fields. Delete the `devDocsList`/`devDocContent`/`devDocSaved`/`devDocCreated`/`devDocDeleted`/`importDevDocResult` message types.
- **`package.json`** — remove `switchboard.devDocsFolder` from `contributes.configuration` (line 207).

### 4 — Verb allowlist (auto-generated — edit source + regenerate)
- **`protocol-catalog.json`** — remove the `PLANNING_VERBS` Dev Docs verbs (`loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `deleteDevDoc`, `draftImproveDevDoc`, `importDevDocFromClipboard`); **add** `draftImproveLocalDoc`. Then `npm run catalog:generate` to regenerate `src/generated/verbAllowlist.ts` (do NOT hand-edit the generated file). Do NOT remove `getProjectContextEnabled` / `setProjectContextEnabled` — those are the PRD-injection toggle (owned by the auto-bundle subtask, must stay).

### 5 — switchboard-site docs → moved out
All docs-site edits for this change (delete `dev-docs.md`; edit `planning-artifacts.md` and `docs.md`) live in the separate **Website-project** subtask `update-switchboard-site-docs.md`. This plan touches only the `switchboard` extension repo.

## Watch out
- **`+ New Doc` / `Draft with agent` must gate on `state.activeSource === 'local'`** — never send an online source ID (ClickUp/Linear/Notion/Antigravity) as `folderPath`.
- The Dev Docs JS block ends ~12585, not 12469 — a naive line-range delete strands orphaned handlers. Use the grep.
- **Shared files with `delete-project-context-auto-bundle.md`:** both edit `PlanningPanelProvider.ts` and `protocol-catalog.json` (different symbols/verbs). If both run in the same feature worktree, land them sequentially to avoid a regen/edit clash on `verbAllowlist.ts`.
- Docs stay undifferentiated — no folder role, no `README` filter entry. Root `README.md` is handled by the Create Plans bundler; to browse it in the Docs tab, add the repo root as a managed folder.

## Verify
- `npm run build` (switchboard) clean; Dev Docs tab absent from the planning tab strip.
- `+ New Doc` creates a file in the active local folder (or quick-picks / toasts); disabled-path check: does not send an online source ID as `folderPath`. `Draft with agent` copies a prompt for the selected local doc; disabled when an online source is selected.
- `docs-source-filter` unchanged (no `readme` entry); Manage Folders has no role selector; existing Edit/Save/Push/Copy-to-Online/Save-as-PRD/Save-as-Constitution and per-card Delete/Link still work.
- `grep -rn "devDocsFolder\|loadDevDocs\|readDevDoc\|saveDevDoc\|createDevDoc\|deleteDevDoc\|draftImproveDevDoc\|importDevDocFromClipboard\|_listDevDocs\|_resolveDevDocPath\|_devDocsFolder" src/` → 0 hits. `draftImproveLocalDoc` present in `PLANNING_VERBS`.
- (switchboard-site docs are verified in `update-switchboard-site-docs.md`.)
