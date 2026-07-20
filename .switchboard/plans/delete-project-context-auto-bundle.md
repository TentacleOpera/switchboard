# Delete the project-context auto-bundle feature

## Metadata
- **Complexity:** 5
- **Tags:** backend, refactor, cleanup

## What this does

Delete the overengineered "project-context auto-bundle-push" feature in full — backend, providers, and Remote-tab UI. It is a one-way, whole-page-overwrite, coarse-hashed mirror of (constitution + PRDs + dev docs + README) into a single Notion page / Linear project doc, off by default, gated behind a Remote-tab toggle. It is not doc sync; it is a context snapshot dressed as sync. Hosting docs online (GitHub Pages, or the Docs tab's existing per-doc Push / Copy to Online…) is the simpler, correct replacement. **Feature B — the PRD-injection toggle — MUST be preserved** (see below); it shares the `projectContext` prefix but is a different feature.

> Split from the original merge plan (the Dev Docs tab merge is now `merge-dev-docs-into-docs-tab.md`). Content preserved. Independent of the merge — either order.

## ⚠️ Critical scope distinction — TWO `projectContext` features

**Feature A — auto-bundle-push (IN SCOPE, delete entirely):**
- `KanbanProvider`: `projectContextGetStatus`, `projectContextSetEnabled`, `projectContextSyncNow`, `_resolveDevDocsDirForSync`, `_resolveReadmePathForSync`, `_projectContextSyncInFlight`, `_projectContextSyncDebounce`, the `require`/`import` of `projectContextSync`.
- `PlanningPanelProvider`: `_onProjectContextContentChanged`, `_projectContextSyncDebounce`, and every call site.
- `projectContextSync.ts` (delete the file).
- `RemoteProvider.pushProjectContext` + per-provider implementations (Notion/Linear/ClickUp) + `_ensureContextPage` (Notion).
- `SetupPanelProvider` handlers for `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow`.
- `setup.html` "Project Context Sync" section + JS handlers.
- Allowlist entries in `SETUP_VERBS`: `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow`.

**Feature B — PRD-injection toggle (OUT OF SCOPE, DO NOT DELETE):**
- `KanbanProvider.getProjectContextEnabled` (4372), `setProjectContextEnabled` (4382), `_resolveProjectContextEnabled` (4356) — the latter called at **1865, 3451, 3627, 4437** on the dispatch path to inject the active project's PRD into dispatched coder prompts.
- `PlanningPanelProvider` handlers `getProjectContextEnabled` (4358), `setProjectContextEnabled` (4367).
- `planning.js` `projectContextEnabled` echo (8423), `getProjectContextEnabled` post (8429).
- `project.js` `btnProjectContext` UI (376, 563, 1344–1346, 1488, 1507, 1509).
- `standalone/bootstrap.ts` `projectContextEnabled: false` defaults (238, 267).
- `PLANNING_VERBS`: `getProjectContextEnabled`, `setProjectContextEnabled`.
- **Why it stays:** it governs whether the active project's PRD is injected into future dispatched prompts. Deleting it silently breaks per-project PRD context in every dispatched prompt.

**Coder rule:** only delete symbols containing `Sync`, `Status`, `Bundle`, `pushProjectContext`, `_resolveDevDocsDirForSync`, `_resolveReadmePathForSync`. Treat any symbol containing `Enabled` (`getProjectContextEnabled`, `setProjectContextEnabled`, `_resolveProjectContextEnabled`, `projectContextEnabled`) as Feature B — leave it alone.

## Steps

1. **`src/services/PlanningPanelProvider.ts`** — `grep -n "_onProjectContextContentChanged\|_projectContextSyncDebounce" src/services/PlanningPanelProvider.ts` and delete every hit (call sites include the PRD/constitution save paths, e.g. ~9368); confirm zero remain. Do NOT touch `getProjectContextEnabled`/`setProjectContextEnabled`/`_resolveProjectContextEnabled`.
2. **`src/services/KanbanProvider.ts`** — delete `projectContextGetStatus` (2483), `projectContextSetEnabled` (2494), `projectContextSyncNow` (2530), `_resolveDevDocsDirForSync` (2512), `_resolveReadmePathForSync` (2522), the `_projectContextSyncInFlight` set (178), the `_projectContextSyncDebounce` field, and the `projectContextSync` import. Keep the Feature B accessors (4356/4372/4382).
3. **`src/services/remote/projectContextSync.ts`** — delete the file.
4. **`src/services/remote/RemoteProvider.ts`** — remove `pushProjectContext` from the interface; remove `ProjectContextBundle`/`ProjectContextDocument`/`ProjectContextPushResult` types only if no remaining consumers (check `notionOverwriteGuard.ts` + archive/import first).
5. **`src/services/remote/NotionRemoteProvider.ts`** — delete `pushProjectContext` (281) and `_ensureContextPage`.
6. **`src/services/remote/LinearRemoteProvider.ts`** — delete `pushProjectContext` (196).
7. **`src/services/remote/ClickUpRemoteProvider.ts`** — delete the stub `pushProjectContext` (191).
8. **`src/services/remote/notionOverwriteGuard.ts`** — remove the `pushProjectContext` reference (11); keep the guard; prune dead project-context-page branches.
9. **`src/services/SetupPanelProvider.ts`** — delete the `case` blocks at 1377 (`getProjectContextSyncStatus`), 1382 (`setProjectContextSyncEnabled`), 1387 (`projectContextSyncNow`). (The `case` labels are message types, which differ from the KanbanProvider method names.)
10. **`src/webview/setup.html`** — delete the "Project Context Sync" section (heading ~1521: auto checkbox, Sync Now button, status span, last-result div) and the JS handlers at 5308–5329 and 5535–5557 (incl. the `getProjectContextSyncStatus` post at 5535 and `projectContextSyncNow` post at 5557).
11. **`protocol-catalog.json`** — remove the `SETUP_VERBS` entries `getProjectContextSyncStatus`, `setProjectContextSyncEnabled`, `projectContextSyncNow`; run `npm run catalog:generate`. Do NOT remove the `PLANNING_VERBS` Feature B verbs.
> **switchboard-site docs → moved out.** The `remote-boards.md` "Project Context Sync" removal lives in the separate **Website-project** subtask `update-switchboard-site-docs.md`. This plan touches only the `switchboard` extension repo.

## Watch out
- **Feature A vs B conflation is the top risk** — a broad `projectContext` grep-and-delete breaks dispatched prompts. Follow the coder rule.
- `verbAllowlist.ts` is auto-generated — edit `protocol-catalog.json` + regenerate; hand-edits revert.
- **Shared files with `merge-dev-docs-into-docs-tab.md`:** both edit `PlanningPanelProvider.ts` and `protocol-catalog.json` (different symbols/verbs) and both touch `settings-commands.md`. If both run in the same feature worktree, land sequentially to avoid a `verbAllowlist.ts` regen clash.
- `PlanningPanelProvider.ts.bak3` exists in `src/services/` — grep returns duplicate hits; do not edit it.
- `_onProjectContextContentChanged` fires from PRD + constitution save paths — the grep in step 1 must reach every call site; a dangling call breaks the build.

## Verify
- `npm run build` (switchboard) clean.
- `grep -rn "projectContextSync\|pushProjectContext\|_onProjectContextContentChanged\|_resolveDevDocsDirForSync\|_resolveReadmePathForSync\|_projectContextSyncInFlight\|_projectContextSyncDebounce" src/` → 0 hits (Feature A gone).
- `grep -rn "getProjectContextEnabled\|setProjectContextEnabled\|_resolveProjectContextEnabled\|btnProjectContext" src/` → EXPECTED hits present (Feature B intact); dispatch-path calls at 1865/3451/3627/4437 resolve.
- Setup/Remote tab: no "Project Context Sync" section. Project panel "PROJECT CONTEXT: ON/OFF" toggle still works — toggle on → dispatched prompt includes the project PRD; toggle off → omits it.
- (switchboard-site docs are verified in `update-switchboard-site-docs.md`.)
## Review Findings

Review found Feature A only half-deleted, leaving HEAD uncompilable (CRITICAL): `PlanningPanelProvider._onProjectContextContentChanged` and `SetupPanelProvider`'s three sync cases still called the deleted `KanbanProvider.projectContextSyncNow`, and `RemoteProvider` still declared `pushProjectContext` while `NotionRemoteProvider` no longer implemented it; the Linear/ClickUp implementations, the `projectContextPush` capability flag, setup.html's Project Context Sync section + five JS handlers, and the three SETUP_VERBS also remained (MAJOR). Fixes applied: deleted `_onProjectContextContentChanged`/`_projectContextSyncDebounce` and all call sites, the SetupPanelProvider cases, the setup.html section and handlers, `pushProjectContext` from the interface and Linear (`_upsertContextDocument`, `CONTEXT_DOC_TITLE`) and the ClickUp stub, the `ProjectContext*` types and capability flag, and the guard's stale consumer comment, then regenerated the catalog/allowlist. Verification: the plan's Feature A grep returns zero hits and Feature B is intact (8 `_resolveProjectContextEnabled` references in KanbanProvider, PLANNING_VERBS keep `get/setProjectContextEnabled`); build/tests skipped per dispatch flags. Remaining risk: the Remote tab UI needs one manual look to confirm the section's removal left no layout gap.
