# Merge Dev Docs tab into Docs tab and delete the project-context auto-bundle feature

## Metadata
- **Complexity:** 6
- **Tags:** frontend, backend, refactor, ui, ux, feature, docs
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

### ⚠️ Critical scope distinction — TWO "project context" features exist

The codebase contains **two distinct features** whose symbols share the `projectContext` prefix. This plan targets **only Feature A**. Feature B MUST be preserved.

- **Feature A — auto-bundle-push (IN SCOPE, delete entirely):**
  - `KanbanProvider`: `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow`, `_resolveDevDocsDirForSync`, `_resolveReadmePathForSync`, `_projectContextSyncInFlight`, `_projectContextSyncDebounce`, the `require`/`import` of `projectContextSync`.
  - `PlanningPanelProvider`: `_onProjectContextContentChanged`, `_projectContextSyncDebounce`, and every call site.
  - `projectContextSync.ts` (delete the file).
  - `RemoteProvider.pushProjectContext` + per-provider implementations (Notion/Linear/ClickUp) + `_ensureContextPage` (Notion).
  - `SetupPanelProvider` handlers for `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow` (lines 1377–1393).
  - `setup.html` "Project Context Sync" section + JS handlers.
  - Allowlist entries in `SETUP_VERBS`: `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow`.

- **Feature B — PRD-injection toggle (OUT OF SCOPE, DO NOT DELETE):**
  - `KanbanProvider.getProjectContextEnabled` (line 4372) and `KanbanProvider.setProjectContextEnabled` (line 4382) — public accessors.
  - `KanbanProvider._resolveProjectContextEnabled` (line 4356) — private resolver, called at lines **1865, 3451, 3627, 4437** on the dispatch path to inject the active project's PRD into dispatched coder prompts.
  - `PlanningPanelProvider` handlers `getProjectContextEnabled` (line 4358) and `setProjectContextEnabled` (line 4367).
  - `planning.js` listener for `projectContextEnabled` echo (line 8423) and `getProjectContextEnabled` post (line 8429).
  - `project.js` `btnProjectContext` UI (lines 376, 563, 1344–1346, 1488, 1507, 1509) — the Project panel's "PROJECT CONTEXT: ON/OFF" toggle.
  - `standalone/bootstrap.ts` `projectContextEnabled: false` defaults (lines 238, 267).
  - Allowlist entries in `PLANNING_VERBS`: `getProjectContextEnabled`, `setProjectContextEnabled`.
  - **Why it stays:** this toggle governs whether the active project's PRD is injected into future dispatched prompts. It has nothing to do with the Notion/Linear bundle push. Deleting it silently breaks per-project PRD context in every dispatched prompt.

**Coder rule:** when grepping `projectContext` to delete Feature A, treat any symbol containing `Enabled` (specifically `getProjectContextEnabled`, `setProjectContextEnabled`, `_resolveProjectContextEnabled`, `projectContextEnabled`) as **Feature B — leave it alone**. Only delete symbols containing `Sync`, `Status`, `Bundle`, `pushProjectContext`, `_resolveDevDocsDirForSync`, `_resolveReadmePathForSync`.

## User Review Required

Yes — this plan deletes a shipped tab and a shipped backend feature. Before dispatch, the user should confirm:
1. The Dev Docs tab is safe to delete (no external docs/workflows depend on the `switchboard.devDocsFolder` setting or the `loadDevDocs`/`saveDevDoc`/etc. message contract).
2. The project-context auto-bundle-push (Feature A) is safe to delete (no remote agents currently rely on the mirrored "Switchboard Project Context" Notion page or Linear project doc).
3. The PRD-injection toggle (Feature B) is correctly preserved — confirm the user wants to keep per-project PRD injection into dispatched prompts.
4. The README filter semantics (single-value "mode switch" that overrides the multi-select source set) match user expectation.

## Complexity Audit

### Routine
- Deleting the Dev Docs HTML/CSS/JS block from `planning.html` and `planning.js` — contiguous block removal.
- Deleting `projectContextSync.ts` and the per-provider `pushProjectContext` methods — straightforward method/file deletion.
- Deleting the `switchboard.devDocsFolder` setting from `package.json`.
- Updating `switchboard-site` docs pages (frontmatter, table rows, section deletion) — prose edits.
- Renaming `draftImproveDevDoc` → `draftImproveLocalDoc` — copy the prompt-building logic, swap the path source.

### Complex / Risky
- **Disentangling Feature A from Feature B** in `KanbanProvider.ts` and `PlanningPanelProvider.ts` — both features share the `projectContext` prefix and live in the same files. A broad grep-and-delete will nuke the PRD-injection toggle (Feature B) and break dispatched prompts. Requires symbol-by-symbol deletion guided by the "coder rule" above.
- **Allowlist regeneration** — `src/generated/verbAllowlist.ts` is auto-generated (`npm run catalog:generate`, source: `protocol-catalog.json`). Must edit the source-of-truth verb list, not hand-edit the generated file. The verbs to remove are in `SETUP_VERBS` (not `PLANNING_VERBS`) and the message-type names differ from the KanbanProvider method names.
- **`+ New Doc` folder-context gating** — the Docs tab's active selection can be an online source (ClickUp/Linear/Notion/Antigravity), which is not a local folder. The button must gate on `state.activeSource === 'local'` and fall back to a folder quick-pick.
- **README filter semantics** — `docsSourceFilter` is a multi-select source set; README is a file-type predicate, not a source. Mixing them in one dropdown requires a "mode switch" override. Must be labeled `README (local only)` so users understand it's a mode, not a co-selectable source.
- **`_onProjectContextContentChanged` call-site tracing** — the debounced auto-push is fired from PRD and constitution save paths outside Dev Docs. Every call site must be found and removed; a single dangling call into a deleted method breaks the build (or worse, silently no-ops if the method is left as a stub).
- **switchboard-site prev/next chain** — deleting `dev-docs.md` breaks the `prev`/`next` frontmatter chain on `research.md` and `notebooklm.md`. Both must be repointed before the Astro build or DocsLayout renders dead links.

## Edge-Case & Dependency Audit

**Race Conditions**
- The debounced `_projectContextSyncDebounce` timer may fire after its owner method is deleted if a save event is in flight when the deletion lands. Not a runtime concern post-deletion (the code is gone), but the coder must ensure no queued microtask references a deleted method at runtime during a hot-reload — unlikely in a shipped extension, but verify the debounce is cleared, not just orphaned.
- The Docs tab's `createLocalDoc` backend may race with a folder-list refresh if the user adds a folder and immediately clicks `+ New Doc`. Existing behavior; not introduced by this plan.

**Security**
- No new surface. The deletion removes the `pushProjectContext` provider methods that wrote whole-page overwrites to Notion/Linear — a net security improvement (fewer privileged write paths).
- The `notionOverwriteGuard.ts` stays; it guards other Notion writes. Audit after deletion for dead branches specific to the project-context page, but keep the guard.

**Side Effects**
- Users who set `switchboard.devDocsFolder` lose the override. Acceptable — Manage Folders is the replacement. Document in release notes.
- Users who relied on the auto-bundle Notion page / Linear project doc for remote-agent context lose that mirror. The plan's thesis is that GitHub Pages (or any static host) is the correct replacement; confirm with the user before dispatch.
- Persisted state keys `devdocsListCollapsed` and `devdocs.root` become orphaned in `vscode.getState()`. Harmless (ignored), but a one-time cleanup on panel load is cheap.

**Dependencies & Conflicts**
- `src/generated/verbAllowlist.ts` is auto-generated from `protocol-catalog.json`. Hand-editing is reverted on the next `npm run catalog:generate`. The source-of-truth verb list must be edited and the allowlist regenerated.
- `PlanningPanelProvider.ts.bak3` exists in `src/services/`. Not in scope to delete, but the coder will get duplicate symbol hits when grepping. Do not edit the `.bak3` file.
- The `remote-boards.md` line 25 ClickUp row references "No Project Context Sync either" — a prose reference (not a link) that the Astro build will NOT catch. Must be edited manually in the same change as the section deletion at lines 56–63.
- The Dev Docs JS block in `planning.js` extends from the `devdocsSourceFilter` element ref (line 12280) through ~line 12585 (the last `renderDevDocsList()` call), not 12469 as a naive line-range delete would assume. Use `grep -n "renderDevDocsList\|devdocs" src/webview/planning.js` and delete the contiguous block.

## Dependencies

- None. This plan is self-contained. No `sess_XXXXXXXXXXXXX` prerequisites.

## Adversarial Synthesis

Key risks: (1) conflating Feature A (auto-bundle-push, in scope) with Feature B (PRD-injection toggle, must be preserved) — a broad `projectContext` grep-and-delete will break dispatched prompts; (2) the allowlist correction (SETUP_VERBS not PLANNING_VERBS; message-type names not method names) — a wrong allowlist edit leaves orphaned verbs that compile fine but point at deleted handlers; (3) the `+ New Doc` button missing the `state.activeSource === 'local'` gate — sending an online source ID as `folderPath` is a runtime bug. Mitigations: explicit Feature B preservation callout with symbol list and coder rule; corrected allowlist section with exact message-type names; symmetric source gate on both new buttons; grep-based contiguous block deletion for the Dev Docs JS.

## Proposed Changes

### `src/webview/planning.html`
- **Context:** Docs tab controls strip (`#controls-strip-docs`, lines 3704–3726) and the `docs-source-filter` select. Dev Docs tab surface (lines 3698 button, 3979–4015 section, 3582–3656 CSS).
- **Logic:** Add two buttons after `btn-set-constitution`:
  - `<button id="btn-create-doc" class="strip-btn" title="Create a new markdown doc in a configured folder">+ New Doc</button>`
  - `<button id="btn-agent-doc" class="strip-btn" disabled title="Copy a Draft/Improve prompt to clipboard">Draft with agent</button>`
- **Implementation:** Add `readme` to the `docs-source-filter` select (after `antigravity`): `<option value="readme">README (local only)</option>`. The `(local only)` suffix signals the mode-switch semantics — picking README overrides the multi-select source set and shows only `readme.md` files from configured local folders.
- **Edge Cases:** Remove the `data-tab="devdocs"` button (line 3698), the `#devdocs-content` section (lines 3979–4015), and the Dev Docs CSS block (lines 3582–3656).

### `src/webview/planning.js`
- **Context:** Docs tab rendering (`renderUnifiedDocs` at line 3519, `docsSourceFilter` state at line 39, filter Set at line 3544, filter change handler at line 2382). Dev Docs JS block (lines 12280–~12585). Edit-mode button map (line 8140). `enterEditMode` / `exitEditMode` / `state.dirtyFlags` / `applySidebarState` / `persistTab` branches.
- **Logic — `btn-create-doc` wiring:**
  - Gate on `state.activeSource === 'local'` (mirrors `btn-agent-doc`). If the active selection is an online source (ClickUp/Linear/Notion/Antigravity), do NOT send its ID as `folderPath` — fall through to the folder-picker path.
  - If a local folder is currently selected (`sourceFolder` active and `state.activeSource === 'local'`), send `createLocalDoc` with that `folderPath` (reuses the existing `_handleCreateLocalDoc` backend — no new message type).
  - If no local folder is selected and the user has at least one folder configured, open a quick-pick of configured folders, then send `createLocalDoc` with the picked folder's path.
  - If no folders are configured, show a toast: "Add a folder via Manage Folders first."
- **Logic — `btn-agent-doc` wiring:**
  - Enabled when a local doc is selected in the sidebar (gated on `state.activeSource === 'local'`, mirroring `btn-push-doc`).
  - On click, send a new `draftImproveLocalDoc` message with `{ path, title, hasContent }` derived from the active doc.
- **Logic — README source filter:**
  - In `renderUnifiedDocs`, when `state.docsSourceFilter` includes `'readme'` (or equals `['readme']`), filter the local `docNodes` to those whose `name` (case-insensitive) is `readme.md`. Online sources are hidden when README is the active filter. This is a "mode switch" (Option (a) from the original Risks section) — `readme` overrides the multi-select set, matching the Dev Docs tab's existing dropdown semantics.
  - The existing `sourceType: 'readme'` badge styling from Dev Docs (lines 12355–12360) can be reused on cards — optional polish.
- **Implementation — Dev Docs block deletion:** Use `grep -n "renderDevDocsList\|devdocs" src/webview/planning.js` and delete the contiguous block from the `devdocsSourceFilter` element ref (line 12280) through the last `renderDevDocsList()` call (~line 12585).

  > **Superseded:** Remove lines 12279–12469 (the Dev Docs JS block).
  > **Reason:** The block extends to ~line 12585 (the last `renderDevDocsList()` call), not 12469. A naive 12279–12469 delete leaves a dangling tail of orphaned handlers and a `renderDevDocsList` call that references a deleted function.
  > **Replaced with:** Delete the contiguous block identified by `grep -n "renderDevDocsList\|devdocs" src/webview/planning.js`, from line 12280 through ~line 12585.

- **Implementation — state cleanup:** Remove the `devdocs` branch from `enterEditMode`, `exitEditMode`, `state.dirtyFlags.devdocs`, `applySidebarState('devdocs', …)`, `persistTab('devdocs.root', …)`, the `devdocsListCollapsed` persisted-state key, and the `devdocs` entry from the edit-mode button map (line 8140). Add a one-time cleanup on panel load: if `devdocsListCollapsed` or `devdocs.root` exist in `vscode.getState()`, delete them and re-persist.

### `src/services/PlanningPanelProvider.ts`
- **Context:** Dev Docs backend (handlers at lines 2668–2806, private methods `_listDevDocs`/`_resolveDevDocPath`/`_devDocsFolder`/`_devDocsFolderRelative`/`_setupActiveDevDocWatcher`/`_importDevDocFromClipboard`). Auto-bundle debounce (`_onProjectContextContentChanged`, `_projectContextSyncDebounce`, call sites at line 9368 and the PRD/constitution save paths). Feature B PRD-injection handlers (lines 4358, 4367 — DO NOT DELETE).
- **Logic — new `draftImproveLocalDoc` handler:** Copy of the `draftImproveDevDoc` logic (lines 2763–2788), but the path is the selected local doc's absolute path; the workspace root is derived from the folder's owning workspace; no `_resolveDevDocPath` gate — use the existing local-doc path resolution the Docs tab already trusts.
- **Implementation — Dev Docs backend deletion:** Delete the message handlers `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `importDevDocFromClipboard`, `draftImproveDevDoc`, `deleteDevDoc` (lines 2668–2806). Keep the new `draftImproveLocalDoc` handler. Delete the private methods `_listDevDocs`, `_resolveDevDocPath`, `_devDocsFolder`, `_devDocsFolderRelative`, `_setupActiveDevDocWatcher`, `_importDevDocFromClipboard`, and any Dev Docs watcher state fields. Delete the `devDocsList` / `devDocContent` / `devDocSaved` / `devDocCreated` / `devDocDeleted` / `importDevDocResult` webview message types.
- **Implementation — auto-bundle deletion:** Delete `_onProjectContextContentChanged`, `_projectContextSyncDebounce`, and every call site.

  > **Superseded:** "trace and remove" every `_onProjectContextContentChanged` call site in PRD/constitution save paths.
  > **Reason:** "Trace and remove" is a hope, not an instruction. The coder needs a concrete search step.
  > **Replaced with:** Run `grep -n "_onProjectContextContentChanged\|_projectContextSyncDebounce" src/services/PlanningPanelProvider.ts` and delete every hit. Confirm zero hits remain before building.

- **Edge Cases — Feature B preservation:** DO NOT DELETE `getProjectContextEnabled` (line 4358), `setProjectContextEnabled` (line 4367), or any reference to `_resolveProjectContextEnabled`. These are the PRD-injection toggle (Feature B), a separate feature. See the "Critical scope distinction" section above.

### `src/services/KanbanProvider.ts`
- **Context:** Auto-bundle methods (lines 2483–2620) and Feature B accessors (lines 4356–4391). Note: a `.bak3` sibling file exists in `src/services/` — do not edit it; grep will return duplicate hits from it.
- **Implementation — Feature A deletion:** Delete `projectContextGetStatus` (line 2483), `projectContextSetEnabled` (line 2494), `projectContextSyncNow` (line 2530), `_resolveDevDocsDirForSync` (line 2512), `_resolveReadmePathForSync` (line 2522), the `_projectContextSyncInFlight` set (line 178), the `_projectContextSyncDebounce` field, and the `require`/`import` of `projectContextSync`. Remove the methods from the class's public interface.
- **Edge Cases — Feature B preservation:** DO NOT DELETE `getProjectContextEnabled` (line 4372), `setProjectContextEnabled` (line 4382), or `_resolveProjectContextEnabled` (line 4356). The latter is called at lines **1865, 3451, 3627, 4437** on the dispatch path — deleting it breaks per-project PRD injection into dispatched prompts.

### `src/services/remote/projectContextSync.ts`
- **Implementation:** Delete the file.

### `src/services/remote/RemoteProvider.ts`
- **Implementation:** Remove `pushProjectContext` from the `RemoteProvider` interface. Remove the `ProjectContextBundle` / `ProjectContextDocument` / `ProjectContextPushResult` types **only if** they have no remaining consumers — check `notionOverwriteGuard.ts` and any archive/import code before deleting the types.

### `src/services/remote/NotionRemoteProvider.ts`
- **Implementation:** Delete `pushProjectContext` (line 281) and `_ensureContextPage`.

### `src/services/remote/LinearRemoteProvider.ts`
- **Implementation:** Delete `pushProjectContext` (line 196).

### `src/services/remote/ClickUpRemoteProvider.ts`
- **Implementation:** Delete the stub `pushProjectContext` (line 191).

### `src/services/remote/notionOverwriteGuard.ts`
- **Implementation:** Remove any reference to `pushProjectContext` (line 11). The guard itself stays — it guards other Notion writes. Audit after the bundle feature is removed for dead branches specific to the project-context page; prune dead branches but keep the guard.

### `src/services/SetupPanelProvider.ts`
- **Context:** Auto-bundle handlers at lines 1377–1393. The `case` labels are `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow` — these are the **message types**, which differ from the KanbanProvider **method names** (`projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow`) that the handlers call.

  > **Superseded:** Delete the handlers for `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow` (lines 1378–1391).
  > **Reason:** The plan named the KanbanProvider method names, not the `case` labels. A coder grepping `case 'projectContextGetStatus'` gets zero hits.
  > **Replaced with:** Delete the `case` blocks at lines 1377 (`getProjectContextSyncStatus`), 1382 (`setProjectContextSyncEnabled`), and 1387 (`projectContextSyncNow`). These call into KanbanProvider methods that are being deleted in the same change.

### `src/webview/setup.html`
- **Context:** "Project Context Sync" section at line 1521 (plan originally said 1518–1537; the heading is at 1521 — confirm exact range before deleting). JS handlers at lines 5308–5329 and 5535–5557.
- **Implementation:** Delete the "Project Context Sync" section: the auto checkbox, the Sync Now button, the status span, the last-result div. Delete the JS handlers at lines 5308–5329 and 5535–5557 (including the `getProjectContextSyncStatus` post at 5535 and the `projectContextSyncNow` post at 5557).

### `src/generated/verbAllowlist.ts` (AUTO-GENERATED — do not hand-edit)
- **Context:** File header reads `// AUTO-GENERATED — do not edit; run \`npm run catalog:generate\`. // Source: protocol-catalog.json providers.<Name>.verbs[]`. The verbs to remove are in `SETUP_VERBS` (line 15), NOT `PLANNING_VERBS`.

  > **Superseded:** Remove `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow` from `PLANNING_VERBS`.
  > **Reason:** (1) Those verbs are NOT in `PLANNING_VERBS` — they're in `SETUP_VERBS` (line 15). (2) The names listed are KanbanProvider method names; the allowlist keys on **message types**, which differ. (3) The plan also missed `getProjectContextSyncStatus` and `setProjectContextSyncEnabled`.
  > **Replaced with:** Edit the source-of-truth verb list in `protocol-catalog.json` (find it via `grep -rn "projectContextSyncNow" protocol-catalog.json` or the catalog generator source). Remove the `SETUP_VERBS` entries: `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow`. Also remove the `PLANNING_VERBS` entries for the deleted Dev Docs verbs: `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `deleteDevDoc`, `draftImproveDevDoc`, `importDevDocFromClipboard`. Then run `npm run catalog:generate` to regenerate `verbAllowlist.ts`. DO NOT remove `getProjectContextEnabled` or `setProjectContextEnabled` from `PLANNING_VERBS` — those are Feature B (PRD-injection toggle) and must stay.

### `package.json`
- **Implementation:** Remove `switchboard.devDocsFolder` from `contributes.configuration` (line 207).

### `switchboard-site/src/pages/docs/artifacts/dev-docs.md`
- **Implementation:** Delete the file.

### `switchboard-site/src/pages/docs/artifacts/planning-artifacts.md`
- **Implementation:** Three edits:
  - Frontmatter `description` (line 4): remove "dev docs" from "docs, stakeholder HTML previews, Google AI Studio research, dev docs, and NotebookLM."
  - The tabs table (line 25): delete the `| [Dev Docs](/switchboard-site/docs/artifacts/dev-docs) | … |` row.
  - Line 34: replace "the [Research](/switchboard-site/docs/artifacts/research) tab writes to your chosen docs folder, [Dev Docs](/switchboard-site/docs/artifacts/dev-docs) writes into your repo's docs folder, and plan imports create cards on the board." with text that no longer references Dev Docs — Research writes to your chosen docs folder, plan imports create cards on the board.

### `switchboard-site/src/pages/docs/artifacts/docs.md`
- **Implementation:** Add the new affordances to the Docs tab page:
  - In "The sidebar" section (around line 27), add `+ New Doc` (top strip) and `Draft with agent` (top strip, copies a Draft/Improve prompt for the selected local doc) to the bullet list alongside the existing folder/card actions.
  - In "Browsing" (line 48), add **README (local only)** to the list of source filter options, with one line explaining what it does (filters to `readme.md` files across configured local folders; overrides the multi-select source set).

### `switchboard-site/src/pages/docs/artifacts/research.md`
- **Implementation:** Update the `next` frontmatter (lines 9–10): Dev Docs is gone, so `next` should point to NotebookLM (`/docs/artifacts/notebooklm`).

### `switchboard-site/src/pages/docs/artifacts/notebooklm.md`
- **Implementation:** Update the `prev` frontmatter (lines 5–7): Dev Docs is gone, so `prev` should point to Research (`/docs/artifacts/research`).

### `switchboard-site/src/pages/docs/integrations/remote-boards.md`
- **Implementation:** Two edits:
  - **Line 25 (ClickUp row of the provider comparison table):** remove the clause "No Project Context Sync either." Once the feature is gone, this clause references nothing. The rest of the ClickUp row stays.
  - **Lines 56–63 (the "Project Context Sync" section):** delete the heading, the two bullets (Auto-sync after saving, Sync Context Now), and the "Switchboard is the source of truth…" line. The "Sync Health" section above it and the "Provider-specific setup" section below it stay.

### `switchboard-site/src/pages/docs/reference/settings-commands.md`
- **Implementation:** Delete the `switchboard.devDocsFolder` row from the settings table (line 122).

## Verification Plan

### Automated Tests
- None in scope (per session directive: skip automated tests).

### Manual Verification (build + smoke)
- [ ] `npm run catalog:generate` regenerates `verbAllowlist.ts` with the bundle verbs gone from `SETUP_VERBS` and the Dev Docs verbs gone from `PLANNING_VERBS`, while `getProjectContextEnabled` / `setProjectContextEnabled` REMAIN in `PLANNING_VERBS`.
- [ ] `npm run build` in `switchboard/` passes with no TypeScript errors from removed types/methods. (Per session directive: skip compilation — the coder/lead runs this when implementing; the plan does not run it during planning.)
- [ ] `npm run lint` passes (if configured).
- [ ] `npm run build` in `switchboard-site/` passes with no broken links.
- [ ] `grep -rn "projectContextSync\|pushProjectContext\|_onProjectContextContentChanged\|_resolveDevDocsDirForSync\|_resolveReadmePathForSync\|_projectContextSyncInFlight\|_projectContextSyncDebounce" src/` returns zero hits (Feature A fully gone).
- [ ] `grep -rn "getProjectContextEnabled\|setProjectContextEnabled\|_resolveProjectContextEnabled\|btnProjectContext" src/` returns the EXPECTED hits (Feature B preserved) — confirm `KanbanProvider.ts` lines 4356, 4372, 4382, 4437 and the dispatch-path calls at 1865, 3451, 3627 still resolve.
- [ ] `grep -rn "devDocsFolder\|loadDevDocs\|readDevDoc\|saveDevDoc\|createDevDoc\|deleteDevDoc\|draftImproveDevDoc\|importDevDocFromClipboard\|_listDevDocs\|_resolveDevDocPath\|_devDocsFolder" src/` returns zero hits.
- [ ] `grep -rn "dev-docs\|project-context-sync" switchboard-site/src/pages/docs/` returns zero hits (all docs references updated).
- [ ] `switchboard.devDocsFolder` is no longer in `package.json` contributes.configuration.
- [ ] Dev Docs tab is no longer present in the planning panel tab strip.
- [ ] Docs tab's `+ New Doc` button creates a markdown file in the active local folder (or prompts for a folder if none active; or toasts if no folders configured). Confirm it does NOT send an online source ID as `folderPath` when an online source is selected.
- [ ] Docs tab's `Draft with agent` button copies a Draft/Improve prompt to clipboard for the selected local doc. Confirm it is disabled when an online source is selected.
- [ ] Docs tab's source filter includes "README (local only)" and filters to `readme.md` files only (overriding the multi-select source set).
- [ ] Docs tab's existing Edit/Save/Push/Copy to Online…/Save as PRD/Save as Constitution still work.
- [ ] Manage Folders modal still works and can add `switchboard-site/src/pages/docs` (or any arbitrary folder).
- [ ] Per-card Delete and Link Doc buttons still work on Docs tab cards.
- [ ] Setup/Remote tab no longer shows the "Project Context Sync" section.
- [ ] Project panel's "PROJECT CONTEXT: ON/OFF" toggle (Feature B) still works — toggling it on/off persists and is reflected in the dispatch path (confirm via a dispatched prompt that includes/omits the active project's PRD accordingly).
- [ ] `switchboard-site/src/pages/docs/artifacts/dev-docs.md` is deleted.
- [ ] `switchboard-site/src/pages/docs/artifacts/planning-artifacts.md` no longer lists Dev Docs in the tabs table or the description.
- [ ] `switchboard-site/src/pages/docs/artifacts/docs.md` documents `+ New Doc`, `Draft with agent`, and the README (local only) filter.
- [ ] `switchboard-site/src/pages/docs/artifacts/research.md` `next` points to NotebookLM.
- [ ] `switchboard-site/src/pages/docs/artifacts/notebooklm.md` `prev` points to Research.
- [ ] `switchboard-site/src/pages/docs/integrations/remote-boards.md` no longer has a "Project Context Sync" section AND the ClickUp row no longer says "No Project Context Sync either."
- [ ] `switchboard-site/src/pages/docs/reference/settings-commands.md` no longer lists `switchboard.devDocsFolder`.
- [ ] Published docs site (run `npm run dev` in `switchboard-site/`) shows no Dev Docs page, no broken prev/next chain, no broken internal links.

## Uncertain Assumptions

No uncertain assumptions. All factual claims (file paths, line numbers, symbol names, allowlist locations, the two-feature split, the auto-generated allowlist, the switchboard-site prev/next chain, the `remote-boards.md` line 25 reference) were verified against the codebase during this improve pass. No web research is needed.

## Implementation plan

### Phase 1 — Docs tab absorbs Dev Docs affordances (frontend first, so the UX is testable early)

1. **`planning.html`** — In the Docs tab controls strip (`#controls-strip-docs`, lines 3704–3726), add two buttons after `btn-set-constitution`:
   - `<button id="btn-create-doc" class="strip-btn" title="Create a new markdown doc in a configured folder">+ New Doc</button>`
   - `<button id="btn-agent-doc" class="strip-btn" disabled title="Copy a Draft/Improve prompt to clipboard">Draft with agent</button>`
   Add `readme` to the `docs-source-filter` select (after `antigravity`):
   - `<option value="readme">README (local only)</option>`

2. **`planning.js`** — Wire `btn-create-doc`:
   - Gate on `state.activeSource === 'local'` (mirrors `btn-agent-doc`). If the active selection is an online source, do NOT send its ID as `folderPath`.
   - If a local folder is currently selected (`sourceFolder` active and `state.activeSource === 'local'`), send `createLocalDoc` with that `folderPath` (reuses the existing `_handleCreateLocalDoc` backend — no new message type).
   - If no local folder is selected and the user has at least one folder configured, open a quick-pick of configured folders, then send `createLocalDoc` with the picked folder's path.
   - If no folders are configured, show a toast: "Add a folder via Manage Folders first."

3. **`planning.js`** — Wire `btn-agent-doc`:
   - Enabled when a local doc is selected in the sidebar (gated on `state.activeSource === 'local'`, mirroring `btn-push-doc`).
   - On click, send a new `draftImproveLocalDoc` message with `{ path, title, hasContent }` derived from the active doc.

4. **`planning.js`** — Add a new backend message handler `draftImproveLocalDoc` in `PlanningPanelProvider.ts` (copy of the `draftImproveDevDoc` logic at lines 2763–2788, but the path is the selected local doc's absolute path; the workspace root is derived from the folder's owning workspace; no `_resolveDevDocPath` gate — use the existing local-doc path resolution the Docs tab already trusts).

5. **`planning.js`** — Implement the README source filter:
   - In `renderUnifiedDocs`, when `state.docsSourceFilter` includes `'readme'` (or equals `['readme']`), filter the local `docNodes` to those whose `name` (case-insensitive) is `readme.md`. Online sources are hidden when README is the active filter. This is a "mode switch" — `readme` overrides the multi-select set.
   - The existing `sourceType: 'readme'` badge styling from Dev Docs (lines 12355–12360) can be reused on cards if desired — optional polish.

### Phase 2 — Delete the Dev Docs tab surface

6. **`planning.html`** — Remove the `data-tab="devdocs"` button (line 3698), the `#devdocs-content` section (lines 3979–4015), and the Dev Docs CSS block (lines 3582–3656).

7. **`planning.js`** — Delete the contiguous Dev Docs JS block identified by `grep -n "renderDevDocsList\|devdocs" src/webview/planning.js`, from the `devdocsSourceFilter` element ref (line 12280) through the last `renderDevDocsList()` call (~line 12585). This includes: element refs, state vars, `buildSidebarToggleRow` for devdocs, `renderDevDocsList`, `selectDevDoc`, all button handlers, and the `loadDevDocs` / `devDocsList` / `devDocContent` / `devDocSaved` / `devDocCreated` / `devDocDeleted` / `importDevDocResult` message handlers.

8. **`planning.js`** — Remove the `devdocs` branch from `enterEditMode`, `exitEditMode`, `state.dirtyFlags.devdocs`, `applySidebarState('devdocs', …)`, `persistTab('devdocs.root', …)`, and the `devdocsListCollapsed` persisted-state key. Add a one-time cleanup on panel load: if those keys exist in `vscode.getState()`, delete them and re-persist.

9. **`planning.js`** — Remove the `devdocs` entry from the edit-mode button map at line 8140.

### Phase 3 — Delete the Dev Docs backend

10. **`PlanningPanelProvider.ts`** — Delete the message handlers `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `importDevDocFromClipboard`, `draftImproveDevDoc`, `deleteDevDoc` (lines 2668–2806). Keep the new `draftImproveLocalDoc` handler added in step 4.

11. **`PlanningPanelProvider.ts`** — Delete the private methods `_listDevDocs`, `_resolveDevDocPath`, `_devDocsFolder`, `_devDocsFolderRelative`, `_setupActiveDevDocWatcher`, `_importDevDocFromClipboard`, and any Dev Docs watcher state fields.

12. **`package.json`** — Remove `switchboard.devDocsFolder` from `contributes.configuration` (line 207).

### Phase 4 — Delete the project-context auto-bundle feature (Feature A only — preserve Feature B)

13. **`PlanningPanelProvider.ts`** — Run `grep -n "_onProjectContextContentChanged\|_projectContextSyncDebounce" src/services/PlanningPanelProvider.ts` and delete every hit. Confirm zero hits remain. DO NOT touch `getProjectContextEnabled` (line 4358), `setProjectContextEnabled` (line 4367), or `_resolveProjectContextEnabled` references — those are Feature B.

14. **`KanbanProvider.ts`** — Delete `projectContextGetStatus` (line 2483), `projectContextSetEnabled` (line 2494), `projectContextSyncNow` (line 2530), `_resolveDevDocsDirForSync` (line 2512), `_resolveReadmePathForSync` (line 2522), the `_projectContextSyncInFlight` set (line 178), the `_projectContextSyncDebounce` field, and the `require`/`import` of `projectContextSync`. DO NOT delete `getProjectContextEnabled` (line 4372), `setProjectContextEnabled` (line 4382), or `_resolveProjectContextEnabled` (line 4356) — those are Feature B.

15. **`src/services/remote/projectContextSync.ts`** — Delete the file.

16. **`src/services/remote/RemoteProvider.ts`** — Remove `pushProjectContext` from the `RemoteProvider` interface. Remove `ProjectContextBundle` / `ProjectContextDocument` / `ProjectContextPushResult` types only if no remaining consumers (check `notionOverwriteGuard.ts` and archive/import code first).

17. **`src/services/remote/NotionRemoteProvider.ts`** — Delete `pushProjectContext` (line 281) and `_ensureContextPage`.

18. **`src/services/remote/LinearRemoteProvider.ts`** — Delete `pushProjectContext` (line 196).

19. **`src/services/remote/ClickUpRemoteProvider.ts`** — Delete the stub `pushProjectContext` (line 191).

20. **`src/services/remote/notionOverwriteGuard.ts`** — Remove any reference to `pushProjectContext` (line 11). The guard itself stays. Audit for dead branches specific to the project-context page; prune dead branches but keep the guard.

21. **`src/services/SetupPanelProvider.ts`** — Delete the `case` blocks at lines 1377 (`getProjectContextSyncStatus`), 1382 (`setProjectContextSyncEnabled`), and 1387 (`projectContextSyncNow`). These call into KanbanProvider methods being deleted in step 14.

22. **`src/webview/setup.html`** — Delete the "Project Context Sync" section (heading at line 1521; confirm exact range): the auto checkbox, the Sync Now button, the status span, the last-result div. Delete the JS handlers at lines 5308–5329 and 5535–5557 (including the `getProjectContextSyncStatus` post at 5535 and the `projectContextSyncNow` post at 5557).

23. **`src/generated/verbAllowlist.ts`** (AUTO-GENERATED — do not hand-edit) — Edit the source-of-truth verb list in `protocol-catalog.json` (find via `grep -rn "projectContextSyncNow" protocol-catalog.json` or the catalog generator source). Remove from `SETUP_VERBS`: `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow`. Remove from `PLANNING_VERBS`: `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `deleteDevDoc`, `draftImproveDevDoc`, `importDevDocFromClipboard`. Run `npm run catalog:generate` to regenerate. DO NOT remove `getProjectContextEnabled` or `setProjectContextEnabled` from `PLANNING_VERBS` — Feature B.

### Phase 5 — Update switchboard-site docs

The published docs at `switchboard-site/src/pages/docs/` reference the Dev Docs tab and the Project Context Sync feature in seven places. All must be updated in the same change so the published docs match the shipped product.

24. **Delete `switchboard-site/src/pages/docs/artifacts/dev-docs.md`** — the entire page documents a tab that no longer exists.

25. **`switchboard-site/src/pages/docs/artifacts/planning-artifacts.md`** — three edits:
    - Frontmatter `description` (line 4): remove "dev docs" from "docs, stakeholder HTML previews, Google AI Studio research, dev docs, and NotebookLM."
    - The tabs table (line 25): delete the `| [Dev Docs](/switchboard-site/docs/artifacts/dev-docs) | … |` row.
    - Line 34: replace "the [Research](/switchboard-site/docs/artifacts/research) tab writes to your chosen docs folder, [Dev Docs](/switchboard-site/docs/artifacts/dev-docs) writes into your repo's docs folder, and plan imports create cards on the board." with text that no longer references Dev Docs — Research writes to your chosen docs folder, plan imports create cards on the board.

26. **`switchboard-site/src/pages/docs/artifacts/docs.md`** — add the new affordances to the Docs tab page so the merged tab is fully documented:
    - In "The sidebar" section (around line 27), add `+ New Doc` (top strip) and `Draft with agent` (top strip, copies a Draft/Improve prompt for the selected local doc) to the bullet list alongside the existing folder/card actions.
    - In "Browsing" (line 48), add **README (local only)** to the list of source filter options, with one line explaining what it does (filters to `readme.md` files across configured local folders; overrides the multi-select source set).

27. **`switchboard-site/src/pages/docs/artifacts/research.md`** — update the `next` frontmatter (lines 9–10): Dev Docs is gone, so `next` should point to NotebookLM (`/docs/artifacts/notebooklm`).

28. **`switchboard-site/src/pages/docs/artifacts/notebooklm.md`** — update the `prev` frontmatter (lines 5–7): Dev Docs is gone, so `prev` should point to Research (`/docs/artifacts/research`).

29. **`switchboard-site/src/pages/docs/integrations/remote-boards.md`** — two edits:
    - **Line 25 (ClickUp row):** remove the clause "No Project Context Sync either." The rest of the row stays.
    - **Lines 56–63 (the "Project Context Sync" section):** delete the heading, the two bullets (Auto-sync after saving, Sync Context Now), and the "Switchboard is the source of truth…" line. The "Sync Health" section above and "Provider-specific setup" section below stay.

30. **`switchboard-site/src/pages/docs/reference/settings-commands.md`** — delete the `switchboard.devDocsFolder` row from the settings table (line 122).

31. **Build the site** to confirm the Astro content collection still compiles with the deleted page and updated frontmatter — `cd switchboard-site && npm run build` (or the project's equivalent — confirm in `switchboard-site/package.json`). A broken `prev`/`next` chain or a dangling internal link will fail the build.

### Phase 6 — Verification

32. Run `npm run catalog:generate` and confirm the regenerated `verbAllowlist.ts` has the bundle verbs gone from `SETUP_VERBS`, the Dev Docs verbs gone from `PLANNING_VERBS`, and `getProjectContextEnabled` / `setProjectContextEnabled` STILL present in `PLANNING_VERBS`.

33. Run `npm run build` in `switchboard/` and fix any TypeScript errors from removed types/methods. (Per session directive: skip compilation during planning — the implementing coder runs this.)

34. Run `npm run lint` if configured.

35. Run `npm run build` in `switchboard-site/` and confirm the docs site builds cleanly with no broken links.

36. Manual smoke test in VS Code:
    - Open the planning panel. Confirm the Dev Docs tab is gone.
    - In the Docs tab, click Manage Folders, add `switchboard-site/src/pages/docs`. Confirm the Astro docs appear in the sidebar.
    - Click `+ New Doc`. Confirm it creates a new markdown file in the selected local folder. Confirm it does NOT send an online source ID when an online source is selected.
    - Select a doc, click `Draft with agent`. Confirm a prompt is copied to clipboard. Confirm the button is disabled when an online source is selected.
    - Select the README (local only) source filter. Confirm only `readme.md` files appear.
    - Open the Setup/Remote tab. Confirm the "Project Context Sync" section is gone.
    - Open the Project panel. Confirm the "PROJECT CONTEXT: ON/OFF" toggle (Feature B) still works — toggle it on, dispatch a prompt, confirm the active project's PRD is injected; toggle it off, dispatch again, confirm the PRD is omitted.
    - Confirm the Docs tab's existing Edit/Save/Push/Copy to Online… still work on an imported online doc.
    - Open the published docs site locally (`switchboard-site && npm run dev`) and confirm: the Artifacts page no longer lists Dev Docs, the Dev Docs page 404s (or is gone from the nav), the Research → NotebookLM prev/next chain works, the Remote Boards page no longer has a Project Context Sync section AND the ClickUp row no longer says "No Project Context Sync either," and the settings reference no longer lists `switchboard.devDocsFolder`.

## Risks and edge cases

- **Verb allowlist generation** — `src/generated/verbAllowlist.ts` is auto-generated (confirmed: file header says `// AUTO-GENERATED — do not edit; run \`npm run catalog:generate\`. // Source: protocol-catalog.json providers.<Name>.verbs[]`). Editing it by hand would be reverted by the next generation. Edit `protocol-catalog.json` and regenerate.
- **Feature A vs Feature B conflation** — the biggest risk. Both features share the `projectContext` prefix and live in the same files. A broad grep-and-delete will nuke the PRD-injection toggle (Feature B) and break dispatched prompts. Follow the "coder rule" in the "Critical scope distinction" section: only delete symbols containing `Sync`, `Status`, `Bundle`, `pushProjectContext`, `_resolveDevDocsDirForSync`, `_resolveReadmePathForSync`; treat any symbol containing `Enabled` as Feature B and leave it alone.
- **Persisted state cleanup** — Users who have `devdocsListCollapsed` or `devdocs.root` in `vscode.getState()` will have orphaned keys. Harmless (ignored), but a one-time cleanup on panel load is cheap: if the keys exist, delete them and re-persist.
- **`switchboard.devDocsFolder` removal** — Users who set a custom value lose the override. The Docs tab's Manage Folders is the replacement; document this in the changelog/release notes if applicable.
- **PRD/constitution save paths** — `_onProjectContextContentChanged` may be called from PRD and constitution save handlers outside Dev Docs (the comment at line 9366 says "after any project-context content write"). The concrete grep step in step 13 catches every call site; confirm zero hits remain before building.
- **`notionOverwriteGuard.ts`** — The guard may have logic specific to the project-context page that becomes dead. Audit after the bundle feature is removed; prune dead branches but keep the guard for other Notion writes.
- **`isProject` dead branch** — The backend routes Dev Docs messages to `this._projectPanel` when `isProject` is true, but `project.html` has no Dev Docs tab. This is dead code today and gets deleted with the Dev Docs backend; no separate action needed.
- **README filter semantics** — The Docs tab's `docsSourceFilter` is currently an array (line 39: `['local', 'clickup', 'linear', 'notion', 'antigravity']`), wrapped in a Set at line 3544, and set to `[value]` on single-value selection (line 2382). Adding `readme` as a single-value option means treating `readme` as a special "only READMEs" mode that overrides the set (Option (a) from the original plan). This matches the Dev Docs tab's existing dropdown semantics and is what users will expect. The dropdown option is labeled `README (local only)` so the mode-switch is visible. Implement (a).
- **switchboard-site prev/next chain** — Deleting `dev-docs.md` breaks the `prev`/`next` frontmatter chain on `research.md` and `notebooklm.md`. Both must be repointed (Research → NotebookLM, NotebookLM ← Research) or the Astro DocsLayout will render dead links. The build in step 31 catches this, but fix it in steps 27–28 before building.
- **switchboard-site internal links** — Any other page in the docs site that links to `/docs/artifacts/dev-docs` or to the `#project-context-sync` anchor on `remote-boards.md` will become a broken link. Before building, grep the entire `switchboard-site/src/pages/docs/` tree for `dev-docs` and `project-context-sync` references and remove or repoint them. The build will catch dangling links, but a pre-build grep is faster. NOTE: `remote-boards.md` line 25 ("No Project Context Sync either") is a PROSE reference, not a link — the build will NOT catch it; it must be edited manually in step 29.
- **`PlanningPanelProvider.ts.bak3`** — a backup file exists in `src/services/`. Not in scope to delete, but grep will return duplicate symbol hits. Do not edit the `.bak3` file.

## Recommendation

Complexity 6 → **Send to Coder**. The plan is now fully scoped with the two-feature split made explicit, the allowlist correction in place, and the asymmetric source gate fixed. A coder can execute it phase-by-phase with the grep-based verification gates catching any missed references.
