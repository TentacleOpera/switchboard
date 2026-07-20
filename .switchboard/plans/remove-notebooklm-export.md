# Remove the NotebookLM export

## Metadata
- **Complexity:** 3
- **Tags:** backend, frontend, refactor, cleanup, docs

_(No project named and no PROJECT PIN directive — lands unassigned, reassign on the board.)_

## What this does

Remove the whole-repo NotebookLM export and all its entry points. It bundles the entire git repo (code included), which pulls external planning agents toward implementation — the opposite of the docs-not-code principle the Create Plans tab establishes. Pure deletion across seven surfaces. Removing it also frees the `planning.html` tab slot that `create-plans-tab-docs-only-agent-intake.md` fills, so **land this first** if both are in flight.

On-disk output: the export only ever wrote generated files under `.switchboard/NotebookLM/`. Stop generating; leave any existing folder in place (disposable output, no user data) and mention the removal in release notes.

> Split from the original create-plans plan (the tab build is now `create-plans-tab-docs-only-agent-intake.md`). Content preserved.

## Steps — seven surfaces (delete symbol-by-symbol; a partial removal leaves dangling allowlist verbs that compile but point at deleted handlers)

1. **`src/services/ContextBundler.ts`** — delete `bundleWorkspaceContext` (line 64) (or remove all call sites — prefer delete; the Create Plans docs bundler is separate).
2. **`src/services/PlanningPanelProvider.ts`** — delete `_handleAirlockExport` (9385) and the message cases `airlock_export` (3367), `airlock_openNotebookLM` (3372), `airlock_openAIStudio` (3376 — keep only if AI Studio is used elsewhere; check), `airlock_openFolder` (3380), `importNotebookLMPlans` (3353), `notebookDefaultRoot` (2648). Remove the `bundleWorkspaceContext` import.
3. **`src/extension.ts`** — delete the `switchboard.importNotebookLMPlans` command registration (962–965).
4. **`src/services/TaskViewerProvider.ts`** — delete `importNotebookLMPlans` (18907) and any private helpers it alone uses.
5. **`src/webview/planning.html` + `planning.js`** — delete the NOTEBOOKLM tab button (planning.html:3699) and its content pane + JS handlers (planning.js: 2701, 4924, 5022, 5086, 12502, 12538).
6. **`protocol-catalog.json`** — remove the NotebookLM verb entries (15 matches); run `npm run catalog:generate` (do NOT hand-edit `src/generated/verbAllowlist.ts`).
7. **`switchboard-site/src/pages/docs/artifacts/notebooklm.md`** — delete the page and repoint the `prev`/`next` frontmatter chain on its neighbours before the Astro build, or DocsLayout renders dead links.

## Watch out
- **Symbol-by-symbol, not a broad grep** — a leftover allowlist verb compiles fine but points at a deleted handler.
- **prev/next chain interaction:** `merge-dev-docs-into-docs-tab.md` deletes `dev-docs.md` and repoints `research.md` `next` → `notebooklm`; this subtask deletes `notebooklm.md`; `create-plans-tab-docs-only-agent-intake.md` adds `create-plans.md`. Reconcile the Artifacts sequence against the pages actually present at build time — the Astro build fails on a dangling chain, so fix it before building.
- **Tab strip shared with the Create Plans build** — this removes the NOTEBOOKLM button; that subtask adds CREATE PLANS in the vacated slot. Land this first, or reconcile the strip when the second lands.
- `airlock_openAIStudio` (3376): confirm AI Studio isn't used elsewhere before deleting its case.

## Verify
- `npm run build` (switchboard) clean.
- The NotebookLM export action is absent from the planning UI.
- `grep -rn -i "notebooklm\|bundleWorkspaceContext\|_handleAirlockExport\|importNotebookLMPlans\|airlock_export" src/ protocol-catalog.json src/generated/verbAllowlist.ts` → only intended/zero hits (no dangling verb pointing at a deleted handler).
- `switchboard-site` builds with no dead links; `notebooklm.md` gone; the Artifacts prev/next chain resolves against the pages present.
