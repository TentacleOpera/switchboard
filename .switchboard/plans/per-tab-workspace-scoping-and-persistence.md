# Per-Tab Workspace Scoping + Persistent Navigation — MASTER OVERVIEW

## Metadata
- **Tags:** frontend, backend, refactor, feature, epic
- **Complexity:** 8 (split into 6 sub-plans, complexity 2–5 each)
- **Split into:** see Sub-Plans table below — implement sub-plans, not this file

## User Review Required
- None — all scope decisions were pre-approved on 2026-06-12 (default root behavior, Online Docs filter default, and globalState persistence strategy).
- Re-review only if implementation reveals a need for new confirmation dialogs or user-facing breaking changes (project rule: no confirmation dialogs).

## Goal
Every tab in the Planning panel and Design panel gets its own independent workspace dropdown (the kanban pattern), and every tab's workspace selection — plus the Tickets tab's full ClickUp/Linear navigation — persists across panel close/reopen and VS Code restarts via `globalState` keyed by workspace root.

**Core principle (user requirement, stated explicitly):** the user multitasks across repos constantly — e.g. kanban on `switchboard` while browsing tickets for `viaapp`. No tab may share a workspace root with another tab, and nothing may assume one "active" workspace per panel.

**End-state exit criterion:** the global `currentWorkspaceRoot` variable in `planning.js` is **deleted entirely**. The full reference inventory (below) shows every use is either tickets-scope (migrate), a kanban epic-ops bug (fix to per-card root), or a dead-code fallback (drop). Nothing legitimate depends on it.

## Sub-Plans

| # | File | Scope | Complexity | Depends on |
|---|---|---|---|---|
| 0 | `fix-kanban-epic-ops-workspace-root.md` | Kanban epic ops use per-card root (standalone bug fix) | 2 | none |
| 1 | `workspace-scoping-1-shared-infrastructure.md` | `workspaceItems` broadcast + per-root globalState persistence service | 4 | none |
| 2 | `workspace-scoping-2-tickets-tab.md` | Tickets workspace dropdown + full `currentWorkspaceRoot` migration + per-root nav persistence (the original bug) | 5 | 1 |
| 3 | `workspace-scoping-3-stitch-tab.md` | Stitch workspace dropdown + root threading in DesignPanelProvider | 4 | 1 |
| 4 | `workspace-scoping-4-research-notebooklm.md` | Research + NotebookLM explicit roots; sever Research↔LocalDocs coupling | 3 | 1 |
| 5 | `workspace-scoping-5-online-docs-and-persistence-sweep.md` | Online Docs filter + persist all remaining tabs' selections; delete `currentWorkspaceRoot` | 3 | 1, 2 (deletion step) |

Recommended order: 0 (any time) → 1 → 2 → 3/4/5 in any order, except sub-plan 5's final deletion step requires 2 complete.

## Background & Problem Analysis

Audit of all 9 tabs (2026-06-12):

| Panel | Tab | Status | Detail |
|---|---|---|---|
| Planning | Kanban | ⚠️ browse correct, epic ops buggy | Own dropdown `kanban-workspace-filter` (`planning.js:3432`); but epic operations send global root — see sub-plan 0 |
| Planning | Local Docs | ✅ correct (not persisted) | Own dropdown `local-workspace-filter` (`planning.js:217`), filters by `metadata.root` |
| Planning | Tickets | ❌ global | Every fetch sends shared `currentWorkspaceRoot`; nav saved only to `vscode.setState` (`planning.js:5891`) which dies with the panel — the original Sprint-116 bug |
| Planning | Online Docs | ❌ merged | All roots' docs merged in one list (`planning.js:1509`), no filter |
| Planning | Research | ❌ implicit global | Import sends no `workspaceRoot` (`planning.js:398`); destination-folder list driven by the **Local Docs** tab's filter (`planning.js:1489`) — cross-tab coupling |
| Planning | NotebookLM | ❌ implicit global | Bundle/import messages carry no root; backend falls back via `_getWorkspaceRoot() \|\| allRoots[0]` (`PlanningPanelProvider.ts:308`) |
| Design | HTML Previews | ✅ correct (not persisted) | `html-workspace-filter` (`design.html:3395`), `state.htmlWorkspaceRootFilter` (`design.js:28`) |
| Design | Design System | ✅ correct (not persisted) | `design-workspace-filter` (`design.html:3346`), `state.designWorkspaceRootFilter` (`design.js:29`) |
| Design | Stitch | ❌ no workspace concept | All ops hardcode `this._getWorkspaceRoot()` (`DesignPanelProvider.ts:1008, 1073, 1155`); all output to that single root's `.stitch/` |

Persistence today is `vscode.setState()` (webview state), which survives only panel hide — **not** panel close (panels are `createWebviewPanel`, `PlanningPanelProvider.ts:266`, no serializer) and not reload/restart.

## Full `currentWorkspaceRoot` reference inventory (41 refs, planning.js)

Classified 2026-06-12 after plan review flagged the original undercount. Every reference falls in one of four groups; none are legitimate uses to preserve.

**Group 1 — Tickets-tab call sites (~28 refs) → migrate to `ticketsWorkspaceRoot` (sub-plan 2):**
- Declaration/setter: `55` (declaration), `3137` (`integrationProviderPreference` handler)
- ClickUp restore-chain message handlers: `3047` (`clickupSpacesLoaded` → loadFolders), `3072` (`clickupFoldersLoaded` → loadLists)
- Ticket action buttons: `4585` (importAllTickets), `4602` (editTicket), `4649` (pushTicket local), `4667` (pushTicket online), `4678` (deleteTicketConfirmed), `4690` (changeTicketStatus), `4722` (postTicketComment), `4786` (downloadAttachment), `4904` (clickupCreateTask/linearCreateIssue)
- Local tickets: `5017` (listLocalTickets)
- Hierarchy dropdown handlers + selection saves: `5507`, `5512` (space select → save + loadFolders), `5530` (folder select → save), `5540` (folder select → loadLists), `5559` (list select → save)
- Loaders / agent delegation: `5778` (linearLoadProject), `5785` (linearLoadTaskDetails), `5798` (clickupLoadProject), `5810`, `5826` (clickupLoadTaskDetails), `5835` (clickupLoadSpaces), `5844` (import), `5854` (refine), `5881` (sendTicketToAgent)

**Group 2 — Kanban epic operations (4 refs) → per-card root (sub-plan 0):**
- `3826` (getEpicDetails), `3838` (addSubtaskToEpic), `3847` (deleteEpic — destructive against potentially the wrong repo), `3860` (removeSubtaskFromEpic)

**Group 3 — Local Docs folder-management fallbacks (5 refs) → fallback to `allRoots[0]` instead (sub-plan 5):**
- `932` (removeLocalFolder), `987` (removeTicketsFolder), `989` (removeLocalFolder), `4547` (addTicketsFolder), `4549` (addLocalFolder) — all `state.localWorkspaceRootFilter || currentWorkspaceRoot`

**Group 4 — Defensive response-handler defaults (3 refs) → drop fallback (sub-plan 5):**
- `1885`, `2623`, `2631` — `msg.workspaceRoot || currentWorkspaceRoot || ''`; backend always sends `workspaceRoot` on these messages, fallback is near-dead code

## Why globalState keyed by root (not workspaceState, not setState)
- `vscode.setState`: dies when the panel tab is closed → the reported bug.
- `workspaceState`: keyed to the VS Code window's workspace, so (a) one flat blob would leak ClickUp IDs across repos in a multi-root window, (b) the same repo opened standalone vs in a multi-root workspace gets different buckets.
- `context.globalState` with a per-root map `{ [resolvedRootPath]: tabState }`: state follows the repo regardless of window arrangement, each repo remembered independently, survives restarts. Matches how ClickUp/Linear integration config is already per-root in `.switchboard/`.

Dev-only project: delete the old `vscode.setState` tickets persistence outright, no migration.

## Resolved Decisions (user-approved 2026-06-12)
- **Tickets default root on first open:** when no persisted selection exists, default to the first root that has a ClickUp/Linear integration configured; fall back to `allRoots[0]` if none do.
- **Online Docs filter default:** "All Workspaces" (matches kanban).
- **Plan split approved:** master plan is an overview only; coder agents implement the numbered sub-plans.

## Cross-cutting rules for ALL sub-plans
1. **NO confirmation dialogs anywhere** (hard project rule — `confirm()` is a silent no-op in webviews).
2. **Race handling:** every workspace-scoped response message must carry `workspaceRoot`; webviews drop responses whose root ≠ the tab's current selection.
3. **Stale persisted roots:** dropdown items come from live `workspaceFolders`; if a persisted root isn't among them, fall back to the tab's default and leave the globalState entry alone.
4. **Build:** `npm run compile` after changes — webviews are served from `dist/webview/`.
5. **Regression guard:** `src/test/kanban-linear-project-tab-regression.test.js` must pass; entering the tickets tab twice must not double-fetch (`ticketsInitialized`/`ticketsLoadedOnce` semantics at `planning.js:348-366` preserved).

## Adversarial Synthesis
The biggest failure mode is a half-migrated tickets tab: some messages carrying the new root while a missed call site still reads the global, producing cross-repo data corruption worse than today. Mitigation: the Group 1 inventory above is the authoritative checklist for sub-plan 2, and sub-plan 5 deletes the `currentWorkspaceRoot` declaration so any straggler becomes a loud ReferenceError instead of silent wrong-repo traffic. Second failure mode: the init handshake regressing the don't-refetch-per-visit fix (`planning.js:349-351`). Third: a missed Stitch path writing designs into the wrong repo's `.stitch/` — sub-plan 3 enumerates all handler paths.
