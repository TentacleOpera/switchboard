# Merge Dev Docs tab into Docs tab and delete the project-context auto-bundle feature

## Metadata
- **Complexity:** 6
- **Tags:** frontend, backend, refactor, ui, ux, feature
- **Project:** Website

## Goal

Delete the Dev Docs tab and fold its two genuinely useful affordances ("+ New Doc" and "Draft with agent") into the existing Docs tab, so there is one tab for browsing/editing/pushing markdown docs — governed by the Docs tab's existing Manage Folders model (user-curated list of arbitrary folders anywhere on disk, including `switchboard-site/src/pages/docs`). At the same time, delete the overengineered "project-context auto-bundle-push" feature in full — backend, providers, and Remote-tab UI — since hosting docs on GitHub Pages (or any static host) is the simpler, correct answer to the problem that feature was built to solve.

### Problem analysis

The Dev Docs tab was built on a different backend model than the Docs tab:

- **Docs tab** — `renderUnifiedDocs` reads from a user-curated list of arbitrary local folders (managed via the Manage Folders modal), plus online sources (ClickUp/Linear/Notion/Antigravity). Per-card actions: `Link Doc`, `Delete`, `Set Context`, `Serve & Open`, `Sync`. Has Edit/Save/Push/Copy to Online… in the top strip. Folder list lives in `LocalFolderService` config (`folderPaths`).
- **Dev Docs tab** — `renderDevDocsList` reads from **one configured folder per workspace** (`switchboard.devDocsFolder`, default `docs`), plus the root `README.md`. No folder list, no Manage Folders modal, no per-card actions. Top strip has Edit/Save/Delete (delete only in edit mode), plus `+ New Doc` and `Draft with agent`.

The Dev Docs model is strictly worse: it forces every workspace to use the same folder name (`docs/`), cannot point at folders outside a workspace root (so `switchboard-site/src/pages/docs` is invisible), and lacks the per-card actions users expect from the tab it visually resembles. The "fix" of adding per-workspace overrides only compounds the mistake — the Docs tab already solved this with a folder list.

Separately, the project-context auto-bundle-push feature (`projectContextSyncNow` + `assembleProjectContextBundle` + `pushProjectContext` on each provider) is overengineered for a problem GitHub Pages solves. It is a one-way, whole-page-overwrite, coarse-hashed mirror of (constitution + PRDs + dev docs + README) into a single Notion page / Linear project doc, off by default, gated behind a Remote-tab toggle. It is not doc sync; it is a context snapshot for remote agents, dressed up as doc sync. The Docs tab's existing per-doc Push and Copy to Online… are the actual "push to online" features that make sense, and they already work.

### Root cause

Two separate features (Dev Docs tab + project-context auto-bundle) were built on a "one configured folder per workspace" assumption that doesn't match how real repos organize docs (each repo has its own convention; docs often live in a sibling repo hosted on GitHub Pages). The Docs tab's folder-list model is the correct model. The auto-bundle feature is a solution to a problem that doesn't exist when docs are simply hosted online.

## Scope

**In scope:**
1. Delete the Dev Docs tab from `planning.html` (HTML, CSS, JS in `planning.js`).
2. Move `+ New Doc` and `Draft with agent` buttons into the Docs tab's controls strip, wired to the existing `createLocalDoc` flow (with a folder picker when no folder is selected) and a new `draftImproveLocalDoc` message (renamed from `draftImproveDevDoc`, same prompt-building logic, but the file path is the selected local doc's path).
3. Add **README** as a source-filter option in the Docs tab's `docs-source-filter` dropdown. Semantics: when "README" is selected, show only files whose basename (case-insensitive) is `readme.md` from any configured local folder. Reuses the Dev Docs tab's `sourceType: 'readme'` distinction at the filter level.
4. Delete the project-context auto-bundle-push feature in full:
   - `src/services/remote/projectContextSync.ts` — delete the file.
   - `src/services/KanbanProvider.ts` — delete `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow`, `_resolveDevDocsDirForSync`, `_resolveReadmePathForSync`, the `_projectContextSyncInFlight` set, the `_projectContextSyncDebounce` field, and the require/import of `projectContextSync`.
   - `src/services/PlanningPanelProvider.ts` — delete `_onProjectContextContentChanged`, `_projectContextSyncDebounce`, and every call site (in `saveDevDoc`, `deleteDevDoc`, `importDevDocFromClipboard`, and any PRD/constitution save paths that fire it).
   - `src/services/remote/RemoteProvider.ts` — remove `pushProjectContext` from the `RemoteProvider` interface.
   - `src/services/remote/NotionRemoteProvider.ts` — delete `pushProjectContext` and `_ensureContextPage`.
   - `src/services/remote/LinearRemoteProvider.ts` — delete `pushProjectContext`.
   - `src/services/remote/ClickUpRemoteProvider.ts` — delete the stub `pushProjectContext`.
   - `src/services/remote/notionOverwriteGuard.ts` — remove any reference to `pushProjectContext` (the guard itself stays; it guards other Notion writes).
   - `src/services/SetupPanelProvider.ts` — delete the handlers for `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow` message types (lines around 1378–1391).
   - `src/webview/setup.html` — delete the "Project Context Sync" section (lines 1518–1537): the auto checkbox, the Sync Now button, the status span, the last-result div, and the JS handlers at lines 5308–5329 and 5538–5557.
   - `src/generated/verbAllowlist.ts` — remove `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow` from `PLANNING_VERBS` (regenerated from the source-of-truth verb list, not hand-edited — confirm the generator location before editing).
5. Delete the now-orphaned Dev Docs backend in `PlanningPanelProvider.ts`:
   - `_listDevDocs`, `_resolveDevDocPath`, `_devDocsFolder`, `_devDocsFolderRelative`, `_setupActiveDevDocWatcher`, `_importDevDocFromClipboard`.
   - Message handlers: `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `importDevDocFromClipboard`, `draftImproveDevDoc`, `deleteDevDoc`.
   - The `devDocsList` / `devDocContent` / `devDocSaved` / `devDocCreated` / `devDocDeleted` / `importDevDocResult` webview message types.
6. Delete the `switchboard.devDocsFolder` setting from package.json `contributes.configuration` (it has no remaining consumers after the bundle feature is removed).
7. Remove the `data-tab="devdocs"` button and the `#devdocs-content` section from `planning.html`, plus the Dev Docs CSS block (lines 3582–3656) and the Dev Docs JS block in `planning.js` (lines 12279–12469).
8. Remove the `devdocs` branch from `enterEditMode` / `exitEditMode` / `state.dirtyFlags` / `applySidebarState` / `persistTab` and any persisted state keys (`devdocs.root`, `devdocsListCollapsed`).

**Out of scope:**
- The Docs tab's existing per-doc Push, Copy to Online…, Save as PRD, Save as Constitution, Edit/Save/Cancel — all unchanged.
- The Docs tab's online-source pull integration (ClickUp/Linear/Notion/Antigravity) — unchanged.
- The NotebookLM tab — unchanged.
- The HTML tab — unchanged.
- The constitution and PRD authoring surfaces (constitution tab, PRDs tab) — unchanged. They still save to disk; they just no longer fire the auto-bundle push.
- The `LocalFolderService` — unchanged. The Docs tab's folder-list model is what we're standardizing on.
- Any migration of existing `switchboard.devDocsFolder` config values — the setting is deleted; users who set it lose the override (acceptable; the Docs tab's Manage Folders is the replacement).

## Implementation plan

### Phase 1 — Docs tab absorbs Dev Docs affordances (frontend first, so the UX is testable early)

1. **`planning.html`** — In the Docs tab controls strip (`#controls-strip-docs`, lines 3704–3726), add two buttons after `btn-set-constitution`:
   - `<button id="btn-create-doc" class="strip-btn" title="Create a new markdown doc in a configured folder">+ New Doc</button>`
   - `<button id="btn-agent-doc" class="strip-btn" disabled title="Copy a Draft/Improve prompt to clipboard">Draft with agent</button>`
   Add `readme` to the `docs-source-filter` select (after `antigravity`):
   - `<option value="readme">README</option>`

2. **`planning.js`** — Wire `btn-create-doc`:
   - If a folder is currently selected in the sidebar (a `sourceFolder` is active), send `createLocalDoc` with that `folderPath` (reuses the existing `_handleCreateLocalDoc` backend — no new message type).
   - If no folder is selected and the user has at least one folder configured, open a quick-pick of configured folders, then send `createLocalDoc` with the picked folder's path.
   - If no folders are configured, show a toast: "Add a folder via Manage Folders first."

3. **`planning.js`** — Wire `btn-agent-doc`:
   - Enabled when a local doc is selected in the sidebar (mirror the `btn-push-doc` enable/disable logic, gated on `state.activeSource` being local).
   - On click, send a new `draftImproveLocalDoc` message with `{ path, title, hasContent }` derived from the active doc.

4. **`planning.js`** — Add a new backend message handler `draftImproveLocalDoc` in `PlanningPanelProvider.ts` (copy of the `draftImproveDevDoc` logic at lines 2763–2788, but the path is the selected local doc's absolute path; the workspace root is derived from the folder's owning workspace; no `_resolveDevDocPath` gate — use the existing local-doc path resolution the Docs tab already trusts).

5. **`planning.js`** — Implement the README source filter:
   - In `renderUnifiedDocs`, when `state.docsSourceFilter` includes `'readme'` (or equals it — confirm whether the filter is an array or a single value; the current code at line 3544 treats it as a set), filter the local `docNodes` to those whose `name` (case-insensitive) is `readme.md`. Online sources are hidden when README is the active filter.
   - The existing `sourceType: 'readme'` badge styling from Dev Docs (lines 12355–12360) can be reused on cards if desired — optional polish.

### Phase 2 — Delete the Dev Docs tab surface

6. **`planning.html`** — Remove lines 3698 (the `data-tab="devdocs"` button), 3979–4015 (the `#devdocs-content` section), and 3582–3656 (the Dev Docs CSS block).

7. **`planning.js`** — Remove lines 12279–12469 (the entire Dev Docs JS block: element refs, state vars, `buildSidebarToggleRow` for devdocs, `renderDevDocsList`, `selectDevDoc`, all the button handlers, the `loadDevDocs` / `devDocsList` / `devDocContent` / `devDocSaved` / `devDocCreated` / `devDocDeleted` / `importDevDocResult` message handlers).

8. **`planning.js`** — Remove the `devdocs` branch from `enterEditMode`, `exitEditMode`, `state.dirtyFlags.devdocs`, `applySidebarState('devdocs', …)`, `persistTab('devdocs.root', …)`, and the `devdocsListCollapsed` persisted-state key.

9. **`planning.js`** — Remove the `devdocs` entry from the edit-mode button map at line 8140.

### Phase 3 — Delete the Dev Docs backend

10. **`PlanningPanelProvider.ts`** — Delete the message handlers `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `importDevDocFromClipboard`, `draftImproveDevDoc`, `deleteDevDoc` (lines 2668–2806). Keep the new `draftImproveLocalDoc` handler added in step 4.

11. **`PlanningPanelProvider.ts`** — Delete the private methods `_listDevDocs`, `_resolveDevDocPath`, `_devDocsFolder`, `_devDocsFolderRelative`, `_setupActiveDevDocWatcher`, `_importDevDocFromClipboard`, and any Dev Docs watcher state fields.

12. **`package.json`** — Remove `switchboard.devDocsFolder` from `contributes.configuration`.

### Phase 4 — Delete the project-context auto-bundle feature

13. **`PlanningPanelProvider.ts`** — Delete `_onProjectContextContentChanged`, `_projectContextSyncDebounce`, and every call site (in the now-deleted Dev Docs handlers — already gone in step 10 — plus any PRD/constitution save paths that still call it; trace and remove).

14. **`KanbanProvider.ts`** — Delete `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow`, `_resolveDevDocsDirForSync`, `_resolveReadmePathForSync`, the `_projectContextSyncInFlight` set, the `_projectContextSyncDebounce` field, and the require of `projectContextSync`. Remove the methods from the class's public interface and any exported verb entries.

15. **`src/services/remote/projectContextSync.ts`** — Delete the file.

16. **`src/services/remote/RemoteProvider.ts`** — Remove `pushProjectContext` from the `RemoteProvider` interface and the `ProjectContextBundle` / `ProjectContextDocument` / `ProjectContextPushResult` types if they have no remaining consumers (check `notionOverwriteGuard.ts` and any archive/import code before deleting the types).

17. **`src/services/remote/NotionRemoteProvider.ts`** — Delete `pushProjectContext` and `_ensureContextPage`.

18. **`src/services/remote/LinearRemoteProvider.ts`** — Delete `pushProjectContext`.

19. **`src/services/remote/ClickUpRemoteProvider.ts`** — Delete the stub `pushProjectContext`.

20. **`src/services/remote/notionOverwriteGuard.ts`** — Remove any reference to `pushProjectContext`. The guard itself stays (it guards other Notion writes).

21. **`src/services/SetupPanelProvider.ts`** — Delete the handlers for `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow` (around lines 1378–1391).

22. **`src/webview/setup.html`** — Delete the "Project Context Sync" section (lines 1518–1537) and the JS handlers at lines 5308–5329 and 5538–5557.

23. **`src/generated/verbAllowlist.ts`** — Remove `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow`, `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `importDevDocFromClipboard`, `draftImproveDevDoc`, `deleteDevDoc` from `PLANNING_VERBS`. **Confirm whether this file is hand-edited or generated** — if generated, edit the source-of-truth verb list and regenerate; do not hand-edit the generated file.

### Phase 5 — Update switchboard-site docs

The published docs at `switchboard-site/src/pages/docs/` reference the Dev Docs tab and the Project Context Sync feature in seven places. All must be updated in the same change so the published docs match the shipped product.

24. **Delete `switchboard-site/src/pages/docs/artifacts/dev-docs.md`** — the entire page documents a tab that no longer exists.

25. **`switchboard-site/src/pages/docs/artifacts/planning-artifacts.md`** — three edits:
    - Frontmatter `description` (line 4): remove "dev docs" from "docs, stakeholder HTML previews, Google AI Studio research, dev docs, and NotebookLM."
    - The tabs table (line 25): delete the `| [Dev Docs](/switchboard-site/docs/artifacts/dev-docs) | … |` row.
    - Line 34: replace "the [Research](/switchboard-site/docs/artifacts/research) tab writes to your chosen docs folder, [Dev Docs](/switchboard-site/docs/artifacts/dev-docs) writes into your repo's docs folder, and plan imports create cards on the board." with text that no longer references Dev Docs — Research writes to your chosen docs folder, plan imports create cards on the board.

26. **`switchboard-site/src/pages/docs/artifacts/docs.md`** — add the new affordances to the Docs tab page so the merged tab is fully documented:
    - In "The sidebar" section (around line 27), add `+ New Doc` (top strip) and `Draft with agent` (top strip, copies a Draft/Improve prompt for the selected local doc) to the bullet list alongside the existing folder/card actions.
    - In "Browsing" (line 48), add **README** to the list of source filter options, with one line explaining what it does (filters to `readme.md` files across configured folders).

27. **`switchboard-site/src/pages/docs/artifacts/research.md`** — update the `next` frontmatter (lines 9–10): Dev Docs is gone, so `next` should point to NotebookLM (`/docs/artifacts/notebooklm`).

28. **`switchboard-site/src/pages/docs/artifacts/notebooklm.md`** — update the `prev` frontmatter (lines 5–7): Dev Docs is gone, so `prev` should point to Research (`/docs/artifacts/research`).

29. **`switchboard-site/src/pages/docs/integrations/remote-boards.md`** — delete the entire "Project Context Sync" section (lines 56–63): the heading, the two bullets (Auto-sync after saving, Sync Context Now), and the "Switchboard is the source of truth…" line. The "Sync Health" section above it and the "Provider-specific setup" section below it stay.

30. **`switchboard-site/src/pages/docs/reference/settings-commands.md`** — delete the `switchboard.devDocsFolder` row from the settings table (line 122).

31. **Build the site** to confirm the Astro content collection still compiles with the deleted page and updated frontmatter — `cd switchboard-site && npm run build` (or the project's equivalent — confirm in `switchboard-site/package.json`). A broken `prev`/`next` chain or a dangling internal link will fail the build.

### Phase 6 — Verification

32. Run `npm run build` in `switchboard/` (or the project's equivalent — confirm in `package.json`) and fix any TypeScript errors from removed types/methods.

33. Run `npm run lint` if configured.

34. Run `npm run build` in `switchboard-site/` and confirm the docs site builds cleanly with no broken links.

35. Manual smoke test in VS Code:
    - Open the planning panel. Confirm the Dev Docs tab is gone.
    - In the Docs tab, click Manage Folders, add `switchboard-site/src/pages/docs`. Confirm the Astro docs appear in the sidebar.
    - Click `+ New Doc`. Confirm it creates a new markdown file in the selected folder.
    - Select a doc, click `Draft with agent`. Confirm a prompt is copied to clipboard.
    - Select the README source filter. Confirm only `readme.md` files appear.
    - Open the Setup/Remote tab. Confirm the "Project Context Sync" section is gone.
    - Confirm the Docs tab's existing Edit/Save/Push/Copy to Online… still work on an imported online doc.
    - Open the published docs site locally (`switchboard-site && npm run dev`) and confirm: the Artifacts page no longer lists Dev Docs, the Dev Docs page 404s (or is gone from the nav), the Research → NotebookLM prev/next chain works, the Remote Boards page no longer has a Project Context Sync section, and the settings reference no longer lists `switchboard.devDocsFolder`.

## Verification plan

- [ ] `npm run build` in `switchboard/` passes with no TypeScript errors.
- [ ] `npm run lint` passes (if configured).
- [ ] `npm run build` in `switchboard-site/` passes with no broken links.
- [ ] Dev Docs tab is no longer present in the planning panel tab strip.
- [ ] Docs tab's `+ New Doc` button creates a markdown file in the active folder (or prompts for a folder if none active).
- [ ] Docs tab's `Draft with agent` button copies a Draft/Improve prompt to clipboard for the selected local doc.
- [ ] Docs tab's source filter includes "README" and filters to `readme.md` files only.
- [ ] Docs tab's existing Edit/Save/Push/Copy to Online…/Save as PRD/Save as Constitution still work.
- [ ] Manage Folders modal still works and can add `switchboard-site/src/pages/docs` (or any arbitrary folder).
- [ ] Per-card Delete and Link Doc buttons still work on Docs tab cards.
- [ ] Setup/Remote tab no longer shows the "Project Context Sync" section.
- [ ] `switchboard-site/src/pages/docs/artifacts/dev-docs.md` is deleted.
- [ ] `switchboard-site/src/pages/docs/artifacts/planning-artifacts.md` no longer lists Dev Docs in the tabs table or the description.
- [ ] `switchboard-site/src/pages/docs/artifacts/docs.md` documents `+ New Doc`, `Draft with agent`, and the README filter.
- [ ] `switchboard-site/src/pages/docs/artifacts/research.md` `next` points to NotebookLM.
- [ ] `switchboard-site/src/pages/docs/artifacts/notebooklm.md` `prev` points to Research.
- [ ] `switchboard-site/src/pages/docs/integrations/remote-boards.md` no longer has a "Project Context Sync" section.
- [ ] `switchboard-site/src/pages/docs/reference/settings-commands.md` no longer lists `switchboard.devDocsFolder`.
- [ ] Published docs site (run `npm run dev` in `switchboard-site/`) shows no Dev Docs page, no broken prev/next chain, no broken internal links.
- [ ] No remaining references to `projectContextSync`, `pushProjectContext`, `devDocsFolder`, `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `deleteDevDoc`, `draftImproveDevDoc`, `importDevDocFromClipboard`, `_listDevDocs`, `_resolveDevDocPath`, `_devDocsFolder`, `_onProjectContextContentChanged` in `src/` (verify with `grep`).
- [ ] `switchboard.devDocsFolder` is no longer in `package.json` contributes.configuration.

## Risks and edge cases

- **Verb allowlist generation** — `src/generated/verbAllowlist.ts` may be auto-generated. Editing it by hand could be reverted by the next generation. Confirm the source-of-truth verb list location and edit that instead; regenerate the allowlist.
- **Persisted state cleanup** — Users who have `devdocsListCollapsed` or `devdocs.root` in `vscode.getState()` will have orphaned keys. Harmless (ignored), but a one-time cleanup on panel load is cheap: if the keys exist, delete them and re-persist.
- **`switchboard.devDocsFolder` removal** — Users who set a custom value lose the override. The Docs tab's Manage Folders is the replacement; document this in the changelog/release notes if applicable.
- **PRD/constitution save paths** — `_onProjectContextContentChanged` may be called from PRD and constitution save handlers outside Dev Docs (the comment at line 9366 says "after any project-context content write"). Trace every call site before deleting the method; ensure no remaining call sites dangle.
- **`notionOverwriteGuard.ts`** — The guard may have logic specific to the project-context page that becomes dead. Audit after the bundle feature is removed; prune dead branches but keep the guard for other Notion writes.
- **`isProject` dead branch** — The backend routes Dev Docs messages to `this._projectPanel` when `isProject` is true, but `project.html` has no Dev Docs tab. This is dead code today and gets deleted with the Dev Docs backend; no separate action needed.
- **README filter semantics** — The Docs tab's `docsSourceFilter` is currently a set (line 3544: `new Set(state.docsSourceFilter || [...])`). Adding `readme` as a single-value option means either (a) treating `readme` as a special "only READMEs" mode that overrides the set, or (b) adding `readme` as a member of the set. Option (a) matches the Dev Docs tab's existing dropdown semantics and is what users will expect. Implement (a).
- **switchboard-site prev/next chain** — Deleting `dev-docs.md` breaks the `prev`/`next` frontmatter chain on `research.md` and `notebooklm.md`. Both must be repointed (Research → NotebookLM, NotebookLM ← Research) or the Astro DocsLayout will render dead links. The build in step 31 catches this, but fix it in steps 27–28 before building.
- **switchboard-site internal links** — Any other page in the docs site that links to `/docs/artifacts/dev-docs` or to the `#project-context-sync` anchor on `remote-boards.md` will become a broken link. Before building, grep the entire `switchboard-site/src/pages/docs/` tree for `dev-docs` and `project-context-sync` references and remove or repoint them. The build will catch dangling links, but a pre-build grep is faster.
