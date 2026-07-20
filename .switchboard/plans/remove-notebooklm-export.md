# Remove the NotebookLM export

## Metadata
- **Complexity:** 3
- **Tags:** backend, frontend, refactor, cleanup, docs

_(No project named and no PROJECT PIN directive — lands unassigned, reassign on the board.)_

## What this does

Remove the whole-repo NotebookLM export and all its entry points. It bundles the entire git repo (code included), which pulls external planning agents toward implementation — the opposite of the docs-not-code principle the Create Plans tab establishes. Pure deletion across seven surfaces. Removing it also frees the `planning.html` tab slot that `create-plans-tab-docs-only-agent-intake.md` fills, so **land this first** if both are in flight.

On-disk output: the export only ever wrote generated files under `.switchboard/NotebookLM/`. Stop generating; leave any existing folder in place (disposable output, no user data) and mention the removal in release notes.

> Split from the original create-plans plan (the tab build is now `create-plans-tab-docs-only-agent-intake.md`). Content preserved.

## Steps — six code surfaces (delete symbol-by-symbol; a partial removal leaves dangling allowlist verbs that compile but point at deleted handlers)

1. **`src/services/ContextBundler.ts`** — delete `bundleWorkspaceContext` (line 64) (or remove all call sites — prefer delete; the Create Plans docs bundler is separate).
2. **`src/services/PlanningPanelProvider.ts`** — delete `_handleAirlockExport` (9385) and the message cases `airlock_export` (3367), `airlock_openNotebookLM` (3372), `airlock_openAIStudio` (3376 — keep only if AI Studio is used elsewhere; check), `airlock_openFolder` (3380), `importNotebookLMPlans` (3353), `notebookDefaultRoot` (2648). Remove the `bundleWorkspaceContext` import.
3. **`src/extension.ts`** — delete the `switchboard.importNotebookLMPlans` command registration (962–965).
4. **`src/services/TaskViewerProvider.ts`** — delete `importNotebookLMPlans` (18907) and any private helpers it alone uses.
5. **`src/webview/planning.html` + `planning.js`** — delete the NOTEBOOKLM tab button (planning.html:3699) and its content pane + JS handlers (planning.js: 2701, 4924, 5022, 5086, 12502, 12538).
6. **`protocol-catalog.json`** — remove the NotebookLM verb entries (15 matches); run `npm run catalog:generate` (do NOT hand-edit `src/generated/verbAllowlist.ts`).
> **switchboard-site docs → moved out.** Deleting the `notebooklm.md` page and reconciling the Artifacts prev/next chain live in the separate **Website-project** subtask `update-switchboard-site-docs.md`. This plan touches only the `switchboard` extension repo.

## Watch out
- **Symbol-by-symbol, not a broad grep** — a leftover allowlist verb compiles fine but points at a deleted handler.
- The NotebookLM *docs-site page* removal and the Artifacts prev/next chain reconciliation are handled in `update-switchboard-site-docs.md`, not here.
- **Tab strip shared with the Create Plans build** — this removes the NOTEBOOKLM button; that subtask adds CREATE PLANS in the vacated slot. Land this first, or reconcile the strip when the second lands.
- `airlock_openAIStudio` (3376): confirm AI Studio isn't used elsewhere before deleting its case.

## Verify
- `npm run build` (switchboard) clean.
- The NotebookLM export action is absent from the planning UI.
- `grep -rn -i "notebooklm\|bundleWorkspaceContext\|_handleAirlockExport\|importNotebookLMPlans\|airlock_export" src/ protocol-catalog.json src/generated/verbAllowlist.ts` → only intended/zero hits (no dangling verb pointing at a deleted handler).
- (switchboard-site docs are verified in `update-switchboard-site-docs.md`.)
## Review Findings

Review confirmed the seven-surface deletion essentially landed: `bundleWorkspaceContext`, `_handleAirlockExport`, the airlock/notebook message cases, the extension command, `importNotebookLMPlans`, the NOTEBOOKLM tab, and all catalog verbs are gone. One MAJOR remnant — `ContextBundler.ts` was left as an 8-line husk whose comment claimed to host the docs bundler that didn't exist — is resolved by the Create Plans subtask's `bundleDocsContext` now actually living there. Intentional leftovers: the Airlock send-to-coder/sync feature on implementation.html still writes patches to `.switchboard/NotebookLM/` and uses "NotebookLM" in two error strings (live separate feature, out of this plan's scope — rename candidate for a follow-up), and `context-bundler.test.ts` keeps a stale docstring reference to `bundleWorkspaceContext` in a pure reimplementation test. Verification grep shows only those intended hits; build/tests skipped per dispatch flags.
