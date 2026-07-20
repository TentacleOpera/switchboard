# Merge Dev Docs tab into Docs tab and delete the project-context auto-bundle feature

## Metadata
- **Complexity:** 5
- **Tags:** frontend, backend, refactor, ui, ux, feature, docs
- **Project:** Website

## Goal

Delete the Dev Docs tab and fold its two genuinely useful affordances ("+ New Doc" and "Draft with agent") into the existing Docs tab, so there is one tab for browsing/editing/pushing markdown docs — governed by the Docs tab's existing Manage Folders model (a user-curated list of arbitrary folders anywhere on disk, including `switchboard-site/src/pages/docs`). **Docs are docs.** The one thing the Dev Docs tab encoded that a flat folder list does not — "these docs describe current behaviour" — is dropped entirely, not re-homed as a per-folder role. It carries no weight downstream: the Create Plans tab bundles *all* managed docs without partitioning them, so there is nothing to classify. At the same time, delete the overengineered "project-context auto-bundle-push" feature in full — backend, providers, and Remote-tab UI — since hosting docs on GitHub Pages (or any static host / platform) is the simpler, correct answer to the problem that feature was built to solve.

### Problem analysis

The Dev Docs tab was built on a different backend model than the Docs tab:

- **Docs tab** — `renderUnifiedDocs` reads from a user-curated list of arbitrary local folders (managed via the Manage Folders modal), plus online sources (ClickUp/Linear/Notion/Antigravity). Per-card actions: `Link Doc`, `Delete`, `Set Context`, `Serve & Open`, `Sync`. Has Edit/Save/Push/Copy to Online… in the top strip. Folder list lives in `LocalFolderService` config (`folderPaths`).
- **Dev Docs tab** — `renderDevDocsList` reads from **one configured folder per workspace** (`switchboard.devDocsFolder`, default `docs`), plus the root `README.md`. No folder list, no Manage Folders modal, no per-card actions. Top strip has Edit/Save/Delete (delete only in edit mode), plus `+ New Doc` and `Draft with agent`.

The Dev Docs model is strictly worse: it forces every workspace to use the same folder name (`docs/`), cannot point at folders outside a workspace root (so `switchboard-site/src/pages/docs` is invisible), and lacks the per-card actions users expect from the tab it visually resembles. The "fix" of adding per-workspace overrides only compounds the mistake — the Docs tab already solved this with a folder list.

Separately, the project-context auto-bundle-push feature (`projectContextSyncNow` + `assembleProjectContextBundle` + `pushProjectContext` on each provider) is overengineered for a problem GitHub Pages solves. It is a one-way, whole-page-overwrite, coarse-hashed mirror of (constitution + PRDs + dev docs + README) into a single Notion page / Linear project doc, off by default, gated behind a Remote-tab toggle. It is not doc sync; it is a context snapshot for remote agents, dressed up as doc sync. The Docs tab's existing per-doc Push and Copy to Online… are the actual "push to online" features that make sense, and they already work.

### Root cause

Two separate features (Dev Docs tab + project-context auto-bundle) were built on a "one configured folder per workspace" assumption that doesn't match how real repos organize docs (each repo has its own convention; docs often live in a sibling repo hosted on GitHub Pages, or in Notion/ClickUp). The Docs tab's folder-list model is the correct model. The auto-bundle feature is a solution to a problem that doesn't exist when docs are simply hosted online.

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
4. **Docs stay undifferentiated — no per-folder role and no README source-filter entry are added.** This deliberately reverses the 2026-07-19 amendment, which added a per-folder role (Intent | Dev docs) to feed a Create Plans "dev-docs" toggle. **That toggle has been cut** (see `create-plans-tab-docs-only-agent-intake.md`), so its ground-truth machinery is cut with it: no role selector, no `DEV` badge, no `getDevDocFolders()` accessor. The `docs-source-filter` dropdown stays sources-only. Root `README.md` is not surfaced by any filter; the Create Plans bundler includes it directly, and a user who wants to browse/edit it in the Docs tab can add the repo root as a managed folder.

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
- **`_onProjectContextContentChanged` call-site tracing** — the debounced auto-push is fired from PRD and constitution save paths outside Dev Docs. Every call site must be found and removed; a single dangling call into a deleted method breaks the build (or worse, silently no-ops if the method is left as a stub).
- **switchboard-site prev/next chain** — deleting `dev-docs.md` breaks the `prev`/`next` frontmatter chain on `research.md` and `notebooklm.md`. Both must be repointed before the Astro build or DocsLayout renders dead links. (See the note under `research.md` below: the Create Plans plan *deletes* `notebooklm.md`, so the target depends on ship order.)

## Edge-Case & Dependency Audit

**Race Conditions**
- The debounced `_projectContextSyncDebounce` timer may fire after its owner method is deleted if a save event is in flight when the deletion lands. Not a runtime concern post-deletion (the code is gone), but the coder must ensure the debounce is cleared, not just orphaned.
- The Docs tab's `createLocalDoc` backend may race with a folder-list refresh if the user adds a folder and immediately clicks `+ New Doc`. Existing behavior; not introduced by this plan.

**Security**
- No new surface. The deletion removes the `pushProjectContext` provider methods that wrote whole-page overwrites to Notion/Linear — a net security improvement (fewer privileged write paths).
- The `notionOverwriteGuard.ts` stays; it guards other Notion writes. Audit after deletion for dead branches specific to the project-context page, but keep the guard.

**Side Effects**
- Users who set `switchboard.devDocsFolder` lose the override. Acceptable — Manage Folders is the replacement. Document in release notes.
- Users who relied on the auto-bundle Notion page / Linear project doc for remote-agent context lose that mirror. The plan's thesis is that hosting docs online (GitHub Pages, or the Docs tab's existing per-doc Push) is the correct replacement; confirm with the user before dispatch.
- Persisted state keys `devdocsListCollapsed` and `devdocs.root` become orphaned in `vscode.getState()`. Harmless (ignored), but a one-time cleanup on panel load is cheap.

**Dependencies & Conflicts**
- `src/generated/verbAllowlist.ts` is auto-generated from `protocol-catalog.json`. Hand-editing is reverted on the next `npm run catalog:generate`. The source-of-truth verb list must be edited and the allowlist regenerated.
- `PlanningPanelProvider.ts.bak3` exists in `src/services/`. Not in scope to delete, but the coder will get duplicate symbol hits when grepping. Do not edit the `.bak3` file.
- The `remote-boards.md` line 25 ClickUp row references "No Project Context Sync either" — a prose reference (not a link) that the Astro build will NOT catch. Must be edited manually in the same change as the section deletion at lines 56–63.
- The Dev Docs JS block in `planning.js` extends from the `devdocsSourceFilter` element ref (line 12280) through ~line 12585 (the last `renderDevDocsList()` call), not 12469 as a naive line-range delete would assume. Use `grep -n "renderDevDocsList\|devdocs" src/webview/planning.js` and delete the contiguous block.

## Dependencies

- **Upstream:** none. This plan is self-contained. No `sess_XXXXXXXXXXXXX` prerequisites.
- **Downstream:** `create-plans-tab-docs-only-agent-intake.md` reuses the consolidated Docs tab and the renamed `draftImproveLocalDoc` handoff (for its optional "improve my docs" button), and takes the `planning.html` tab slot vacated by NotebookLM (which *that* plan deletes). **There is NO accessor contract and NO strict sequencing** — the earlier "merge must ship first so the folder-role accessor exists" dependency is gone with the folder role. The two plans are independent and can ship in either order; they only both touch the `planning.html` tab strip (different tabs — this one removes Dev Docs, that one removes NotebookLM). If both are in flight, whoever lands second reconciles the tab strip and the switchboard-site prev/next chain.

## Adversarial Synthesis

Key risks: (1) conflating Feature A (auto-bundle-push, in scope) with Feature B (PRD-injection toggle, must be preserved) — a broad `projectContext` grep-and-delete will break dispatched prompts; (2) the allowlist correction (SETUP_VERBS not PLANNING_VERBS; message-type names not method names) — a wrong allowlist edit leaves orphaned verbs that compile fine but point at deleted handlers; (3) the `+ New Doc` button missing the `state.activeSource === 'local'` gate — sending an online source ID as `folderPath` is a runtime bug. Mitigations: explicit Feature B preservation callout with symbol list and coder rule; corrected allowlist section with exact message-type names; symmetric source gate on both new buttons; grep-based contiguous block deletion for the Dev Docs JS.

## Proposed Changes

### `src/webview/planning.html`
- **Context:** Docs tab controls strip (`#controls-strip-docs`, lines 3704–3726) and the `docs-source-filter` select. Dev Docs tab surface (lines 3698 button, 3979–4015 section, 3582–3656 CSS).
- **Logic:** Add two buttons after `btn-set-constitution`:
  - `<button id="btn-create-doc" class="strip-btn" title="Create a new markdown doc in a configured folder">+ New Doc</button>`
  - `<button id="btn-agent-doc" class="strip-btn" disabled title="Copy a Draft/Improve prompt to clipboard">Draft with agent</button>`
- **Implementation:** Do NOT touch the `docs-source-filter` select — it is a list of sources and stays sources-only. Do NOT add any per-folder role selector to the Manage Folders modal — docs are undifferentiated (see User Review #4).
- **Edge Cases:** Remove the `data-tab="devdocs"` button (line 3698), the `#devdocs-content` section (lines 3979–4015), and the Dev Docs CSS block (lines 3582–3656).

### `src/webview/planning.js`
- **Context:** Docs tab rendering (`renderUnifiedDocs` at line 3519, `docsSourceFilter` state at line 39, filter change handler at line 2382). Dev Docs JS block (lines 12280–~12585). Edit-mode button map (line 8140). `enterEditMode` / `exitEditMode` / `state.dirtyFlags` / `applySidebarState` / `persistTab` branches.
- **Logic — `btn-create-doc` wiring:**
  - Gate on `state.activeSource === 'local'` (mirrors `btn-agent-doc`). If the active selection is an online source (ClickUp/Linear/Notion/Antigravity), do NOT send its ID as `folderPath` — fall through to the folder-picker path.
  - If a local folder is currently selected (`sourceFolder` active and `state.activeSource === 'local'`), send `createLocalDoc` with that `folderPath` (reuses the existing `_handleCreateLocalDoc` backend — no new message type).
  - If no local folder is selected and the user has at least one folder configured, open a quick-pick of configured folders, then send `createLocalDoc` with the picked folder's path.
  - If no folders are configured, show a toast: "Add a folder via Manage Folders first."
- **Logic — `btn-agent-doc` wiring:**
  - Enabled when a local doc is selected in the sidebar (gated on `state.activeSource === 'local'`, mirroring `btn-push-doc`).
  - On click, send a new `draftImproveLocalDoc` message with `{ path, title, hasContent }` derived from the active doc.
- **Implementation — Dev Docs block deletion:** Use `grep -n "renderDevDocsList\|devdocs" src/webview/planning.js` and delete the contiguous block from the `devdocsSourceFilter` element ref (line 12280) through the last `renderDevDocsList()` call (~line 12585). This includes element refs, state vars, `buildSidebarToggleRow` for devdocs, `renderDevDocsList`, `selectDevDoc`, all button handlers, and the `loadDevDocs` / `devDocsList` / `devDocContent` / `devDocSaved` / `devDocCreated` / `devDocDeleted` / `importDevDocResult` message handlers. (A naive 12279–12469 delete leaves a dangling tail — use the grep.)
- **Implementation — state cleanup:** Remove the `devdocs` branch from `enterEditMode`, `exitEditMode`, `state.dirtyFlags.devdocs`, `applySidebarState('devdocs', …)`, `persistTab('devdocs.root', …)`, the `devdocsListCollapsed` persisted-state key, and the `devdocs` entry from the edit-mode button map (line 8140). Add a one-time cleanup on panel load: if `devdocsListCollapsed` or `devdocs.root` exist in `vscode.getState()`, delete them and re-persist.

### `src/services/PlanningPanelProvider.ts`
- **Context:** Serves both `project.html` and `planning.html` through the same `_handleMessage` router; replies route via `isProject ? _projectPanel : _panel`. Dev Docs backend (handlers at lines 2668–2806, private methods `_listDevDocs`/`_resolveDevDocPath`/`_devDocsFolder`/`_devDocsFolderRelative`/`_setupActiveDevDocWatcher`/`_importDevDocFromClipboard`). Auto-bundle debounce (`_onProjectContextContentChanged`, `_projectContextSyncDebounce`, call sites at line 9368 and the PRD/constitution save paths). Feature B PRD-injection handlers (lines 4358, 4367 — DO NOT DELETE).
- **Logic — new `draftImproveLocalDoc` handler:** Copy of the `draftImproveDevDoc` logic (lines 2763–2788), but the path is the selected local doc's absolute path; the workspace root is derived from the folder's owning workspace; no `_resolveDevDocPath` gate — use the existing local-doc path resolution the Docs tab already trusts.
- **Implementation — Dev Docs backend deletion:** Delete the message handlers `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `importDevDocFromClipboard`, `draftImproveDevDoc`, `deleteDevDoc` (lines 2668–2806). Keep the new `draftImproveLocalDoc` handler. Delete the private methods `_listDevDocs`, `_resolveDevDocPath`, `_devDocsFolder`, `_devDocsFolderRelative`, `_setupActiveDevDocWatcher`, `_importDevDocFromClipboard`, and any Dev Docs watcher state fields. Delete the `devDocsList` / `devDocContent` / `devDocSaved` / `devDocCreated` / `devDocDeleted` / `importDevDocResult` webview message types.
- **Implementation — auto-bundle deletion:** Run `grep -n "_onProjectContextContentChanged\|_projectContextSyncDebounce" src/services/PlanningPanelProvider.ts` and delete every hit. Confirm zero hits remain before building.
- **Edge Cases — Feature B preservation:** DO NOT DELETE `getProjectContextEnabled` (line 4358), `setProjectContextEnabled` (line 4367), or any reference to `_resolveProjectContextEnabled`. These are the PRD-injection toggle (Feature B). See the "Critical scope distinction" section above.

### `src/services/KanbanProvider.ts`
- **Context:** Auto-bundle methods (lines 2483–2620) and Feature B accessors (lines 4356–4391). A `.bak3` sibling file exists in `src/services/` — do not edit it; grep will return duplicate hits from it.
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
- **Implementation:** Remove any reference to `pushProjectContext` (line 11). The guard itself stays. Audit after the bundle feature is removed for dead branches specific to the project-context page; prune dead branches but keep the guard.

### `src/services/SetupPanelProvider.ts`
- **Context:** Auto-bundle handlers at lines 1377–1393. The `case` labels are `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow` — these are the **message types**, which differ from the KanbanProvider **method names** (`projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow`) that the handlers call.
- **Implementation:** Delete the `case` blocks at lines 1377 (`getProjectContextSyncStatus`), 1382 (`setProjectContextSyncEnabled`), and 1387 (`projectContextSyncNow`). These call into KanbanProvider methods being deleted in the same change.

### `src/webview/setup.html`
- **Context:** "Project Context Sync" section at line 1521 (confirm exact range before deleting). JS handlers at lines 5308–5329 and 5535–5557.
- **Implementation:** Delete the "Project Context Sync" section: the auto checkbox, the Sync Now button, the status span, the last-result div. Delete the JS handlers at lines 5308–5329 and 5535–5557 (including the `getProjectContextSyncStatus` post at 5535 and the `projectContextSyncNow` post at 5557).

### `src/generated/verbAllowlist.ts` (AUTO-GENERATED — do not hand-edit)
- **Context:** File header reads `// AUTO-GENERATED — do not edit; run \`npm run catalog:generate\`. // Source: protocol-catalog.json providers.<Name>.verbs[]`. The verbs to remove are in `SETUP_VERBS` (line 15), NOT `PLANNING_VERBS`.
- **Implementation:** Edit the source-of-truth verb list in `protocol-catalog.json` (find via `grep -rn "projectContextSyncNow" protocol-catalog.json` or the catalog generator source). Remove the `SETUP_VERBS` entries: `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow`. Also remove the `PLANNING_VERBS` entries for the deleted Dev Docs verbs: `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `deleteDevDoc`, `draftImproveDevDoc`, `importDevDocFromClipboard`. **Add** the new `draftImproveLocalDoc` verb to `PLANNING_VERBS`. Then run `npm run catalog:generate` to regenerate `verbAllowlist.ts`. DO NOT remove `getProjectContextEnabled` or `setProjectContextEnabled` from `PLANNING_VERBS` — those are Feature B (PRD-injection toggle) and must stay.

### `package.json`
- **Implementation:** Remove `switchboard.devDocsFolder` from `contributes.configuration` (line 207).

### `switchboard-site/src/pages/docs/artifacts/dev-docs.md`
- **Implementation:** Delete the file.

### `switchboard-site/src/pages/docs/artifacts/planning-artifacts.md`
- **Implementation:** Three edits:
  - Frontmatter `description` (line 4): remove "dev docs" from "docs, stakeholder HTML previews, Google AI Studio research, dev docs, and NotebookLM."
  - The tabs table (line 25): delete the `| [Dev Docs](/switchboard-site/docs/artifacts/dev-docs) | … |` row.
  - Line 34: replace the sentence referencing Dev Docs writing into your repo's docs folder with text that no longer references Dev Docs — Research writes to your chosen docs folder, plan imports create cards on the board.

### `switchboard-site/src/pages/docs/artifacts/docs.md`
- **Implementation:** Document the merged tab's new affordances (do NOT document any folder-role concept — there is none):
  - In "The sidebar" section (around line 27), add `+ New Doc` (top strip) and `Draft with agent` (top strip, copies a Draft/Improve prompt for the selected local doc) to the bullet list alongside the existing folder/card actions.
  - In "Browsing" (line 48), note that the merged Docs tab is now the single home for markdown docs (including what the old Dev Docs tab held) and that the source filter lists sources only.

### `switchboard-site/src/pages/docs/artifacts/research.md`
- **Implementation:** Update the `next` frontmatter (lines 9–10): Dev Docs is gone, so `next` should point to NotebookLM (`/docs/artifacts/notebooklm`). **Note:** the Create Plans plan deletes `notebooklm.md` and adds `create-plans.md`. If that plan has already landed, point `next` at `create-plans` instead. The Astro build fails on a dangling chain either way, so reconcile against the actual pages present at build time.

### `switchboard-site/src/pages/docs/artifacts/notebooklm.md`
- **Implementation:** Update the `prev` frontmatter (lines 5–7): Dev Docs is gone, so `prev` should point to Research (`/docs/artifacts/research`). (If the Create Plans plan has already deleted this page, this edit is moot — that plan reconciles the chain.)

### `switchboard-site/src/pages/docs/integrations/remote-boards.md`
- **Implementation:** Two edits:
  - **Line 25 (ClickUp row):** remove the clause "No Project Context Sync either." The rest of the row stays.
  - **Lines 56–63 (the "Project Context Sync" section):** delete the heading, the two bullets (Auto-sync after saving, Sync Context Now), and the "Switchboard is the source of truth…" line. The "Sync Health" section above and "Provider-specific setup" section below stay.

### `switchboard-site/src/pages/docs/reference/settings-commands.md`
- **Implementation:** Delete the `switchboard.devDocsFolder` row from the settings table (line 122).

## Verification Plan

### Automated Tests
- None in scope (per session directive: skip automated tests).

### Manual Verification (build + smoke)
- [ ] `npm run catalog:generate` regenerates `verbAllowlist.ts` with the bundle verbs gone from `SETUP_VERBS`, the Dev Docs verbs gone from `PLANNING_VERBS`, `draftImproveLocalDoc` added to `PLANNING_VERBS`, and `getProjectContextEnabled` / `setProjectContextEnabled` still present in `PLANNING_VERBS`.
- [ ] `npm run build` in `switchboard/` passes with no TypeScript errors from removed types/methods.
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
- [ ] The `docs-source-filter` dropdown contains ONLY sources — confirm no `readme` entry was added and no per-folder role selector exists in Manage Folders.
- [ ] Docs tab's existing Edit/Save/Push/Copy to Online…/Save as PRD/Save as Constitution still work.
- [ ] Manage Folders modal still works and can add `switchboard-site/src/pages/docs` (or any arbitrary folder).
- [ ] Per-card Delete and Link Doc buttons still work on Docs tab cards.
- [ ] Setup/Remote tab no longer shows the "Project Context Sync" section.
- [ ] Project panel's "PROJECT CONTEXT: ON/OFF" toggle (Feature B) still works — toggling it on/off persists and is reflected in the dispatch path (confirm via a dispatched prompt that includes/omits the active project's PRD accordingly).
- [ ] switchboard-site: `dev-docs.md` deleted; `planning-artifacts.md` no longer lists Dev Docs; `docs.md` documents `+ New Doc` and `Draft with agent` (and does NOT invent a folder-role concept); the prev/next chain resolves against the pages actually present; `remote-boards.md` has no "Project Context Sync" section and the ClickUp row no longer says "No Project Context Sync either"; `settings-commands.md` no longer lists `switchboard.devDocsFolder`.
- [ ] Published docs site (`npm run dev` in `switchboard-site/`) shows no Dev Docs page and no broken links.

## Implementation plan

### Phase 1 — Docs tab absorbs Dev Docs affordances (frontend first, so the UX is testable early)

1. **`planning.html`** — In the Docs tab controls strip (`#controls-strip-docs`, lines 3704–3726), add the two buttons after `btn-set-constitution` (`btn-create-doc`, `btn-agent-doc`). Do NOT touch the `docs-source-filter` select, and do NOT add a folder-role selector to Manage Folders.
2. **`planning.js`** — Wire `btn-create-doc` (gate on `state.activeSource === 'local'`; use active local folder, else quick-pick, else toast).
3. **`planning.js`** — Wire `btn-agent-doc` (enabled when a local doc is selected; posts `draftImproveLocalDoc` with `{ path, title, hasContent }`).
4. **`PlanningPanelProvider.ts`** — Add the `draftImproveLocalDoc` handler (copy of `draftImproveDevDoc` at 2763–2788; path is the selected local doc's absolute path; no `_resolveDevDocPath` gate).

### Phase 2 — Delete the Dev Docs tab surface

5. **`planning.html`** — Remove the `data-tab="devdocs"` button (line 3698), the `#devdocs-content` section (lines 3979–4015), and the Dev Docs CSS block (lines 3582–3656).
6. **`planning.js`** — Delete the contiguous Dev Docs JS block identified by `grep -n "renderDevDocsList\|devdocs" src/webview/planning.js` (line 12280 through ~12585).
7. **`planning.js`** — Remove the `devdocs` branch from `enterEditMode`, `exitEditMode`, `state.dirtyFlags.devdocs`, `applySidebarState('devdocs', …)`, `persistTab('devdocs.root', …)`, the `devdocsListCollapsed` key, and the edit-mode button map entry (line 8140). Add the one-time state cleanup on panel load.

### Phase 3 — Delete the Dev Docs backend

8. **`PlanningPanelProvider.ts`** — Delete the message handlers `loadDevDocs`, `readDevDoc`, `saveDevDoc`, `createDevDoc`, `importDevDocFromClipboard`, `draftImproveDevDoc`, `deleteDevDoc` (lines 2668–2806). Keep `draftImproveLocalDoc` from step 4.
9. **`PlanningPanelProvider.ts`** — Delete the private methods `_listDevDocs`, `_resolveDevDocPath`, `_devDocsFolder`, `_devDocsFolderRelative`, `_setupActiveDevDocWatcher`, `_importDevDocFromClipboard`, and any Dev Docs watcher state fields.
10. **`package.json`** — Remove `switchboard.devDocsFolder` from `contributes.configuration` (line 207).

### Phase 4 — Delete the project-context auto-bundle feature (Feature A only — preserve Feature B)

11. **`PlanningPanelProvider.ts`** — `grep -n "_onProjectContextContentChanged\|_projectContextSyncDebounce"` and delete every hit; confirm zero remain. DO NOT touch `getProjectContextEnabled`/`setProjectContextEnabled`/`_resolveProjectContextEnabled`.
12. **`KanbanProvider.ts`** — Delete `projectContextGetStatus` (2483), `projectContextSetEnabled` (2494), `projectContextSyncNow` (2530), `_resolveDevDocsDirForSync` (2512), `_resolveReadmePathForSync` (2522), `_projectContextSyncInFlight` (178), `_projectContextSyncDebounce`, and the `projectContextSync` import. DO NOT delete the Feature B accessors (4356/4372/4382).
13. **`src/services/remote/projectContextSync.ts`** — Delete the file.
14. **`src/services/remote/RemoteProvider.ts`** — Remove `pushProjectContext` from the interface; remove the `ProjectContext*` types only if no remaining consumers.
15. **`NotionRemoteProvider.ts`** — Delete `pushProjectContext` (281) and `_ensureContextPage`.
16. **`LinearRemoteProvider.ts`** — Delete `pushProjectContext` (196).
17. **`ClickUpRemoteProvider.ts`** — Delete the stub `pushProjectContext` (191).
18. **`notionOverwriteGuard.ts`** — Remove the `pushProjectContext` reference (11); keep the guard; prune dead project-context branches.
19. **`SetupPanelProvider.ts`** — Delete the `case` blocks at 1377/1382/1387.
20. **`setup.html`** — Delete the "Project Context Sync" section (heading ~1521) and JS handlers (5308–5329, 5535–5557).
21. **`protocol-catalog.json` → regenerate** — Remove the `SETUP_VERBS` and Dev Docs `PLANNING_VERBS` entries; add `draftImproveLocalDoc`; run `npm run catalog:generate`. Keep Feature B verbs.

### Phase 5 — Update switchboard-site docs

22. Delete `dev-docs.md`.
23. `planning-artifacts.md` — three edits (description, tabs table row, line 34).
24. `docs.md` — document `+ New Doc` and `Draft with agent`; do NOT invent a folder-role concept.
25. `research.md` / `notebooklm.md` — repoint the prev/next chain against the pages actually present at build time (see the cross-plan note above).
26. `remote-boards.md` — line 25 clause + lines 56–63 section.
27. `settings-commands.md` — delete the `switchboard.devDocsFolder` row.
28. Build the site (`cd switchboard-site && npm run build`) — a broken prev/next chain or dangling link fails the build.

### Phase 6 — Verification

29. Run the greps and smoke tests in the Verification Plan above; confirm Feature B intact and the site builds cleanly.

## Risks and edge cases

- **Feature A vs Feature B conflation** — the biggest risk. Follow the coder rule: only delete `Sync`/`Status`/`Bundle`/`pushProjectContext`/`_resolveDevDocsDirForSync`/`_resolveReadmePathForSync`; treat any `Enabled` symbol as Feature B.
- **Verb allowlist generation** — edit `protocol-catalog.json` and regenerate; hand-edits to `verbAllowlist.ts` are reverted.
- **Persisted state cleanup** — orphaned `devdocsListCollapsed` / `devdocs.root` keys are harmless; a one-time cleanup on panel load is cheap.
- **`switchboard.devDocsFolder` removal** — users with a custom value lose the override; Manage Folders is the replacement (release notes).
- **PRD/constitution save paths** — `_onProjectContextContentChanged` fires from PRD and constitution saves; the grep in step 11 catches every call site.
- **`notionOverwriteGuard.ts`** — audit for dead project-context branches; keep the guard.
- **`isProject` dead branch** — Dev Docs messages routed to `_projectPanel` were dead (project.html has no Dev Docs tab); deleted with the backend.
- **Dev-docs discoverability after the tab is gone** — nothing is *named* "dev docs" anymore, and that is fine: those files are just markdown in a managed folder now, edited in the Docs tab like any other. The old tab's discoverability was weaker than it looked — it silently showed a hardcoded `docs/` folder and appeared empty for any repo whose docs live elsewhere. Document the single Docs-tab home on the site (`docs.md`).
- **switchboard-site prev/next chain** — deleting `dev-docs.md` breaks the chain on `research.md`/`notebooklm.md`; the Create Plans plan also deletes `notebooklm.md`. Reconcile against the pages present at build time; the build catches a dangling chain.
- **`PlanningPanelProvider.ts.bak3`** — grep returns duplicate hits; do not edit the `.bak3` file.

## Recommendation

Complexity 5 → **Send to Coder**. The two-feature split is explicit, the allowlist correction is in place, and the folder-role apparatus is removed (docs are undifferentiated). A coder can execute phase-by-phase with the grep-based verification gates catching missed references.
