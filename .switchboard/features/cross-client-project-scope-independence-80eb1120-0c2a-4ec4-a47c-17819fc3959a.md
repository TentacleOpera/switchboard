# Cross-Client Project Scope Independence

**Complexity:** 9

## Goal

Make the Kanban board's project scope independent per client, so the VS Code webview and the browser cockpit can sit on different projects without corrupting each other.

Today a single shared singleton decides three things at once: which cards the board is sent, where newly authored plans and features get filed, and which project-scoped settings are in effect. All three are last-writer-wins across clients, so one client's project switch silently blanks the other's board, misfiles its plans, and swaps its effective settings.

The set closes that in two passes: request-scoped state is threaded per initiator, then push-scoped state is rendered per connection.

## How the Subtasks Achieve This

- **Kanban Project Filter — Client-Local View, Per-Initiator Authoring Scope**: Fixes everything that has an initiator. Three proven bugs: `_refreshBoardImpl` still server-filters the card set while the other two card-source paths send it unfiltered (the root cause of the reported "project switch didn't work" blank board); **nine** client-initiated authoring sites read a last-writer-wins global to decide where new plans and features get filed; and project-scoped settings resolve against that same global at read time. Threads an initiator project through the verb payload — the only per-client channel available, since `handleServiceVerb` carries no client identity — and resolves it through one shared precedence helper.
- **Per-Connection Client Identity and Scoped Push Rendering**: Fixes what has no initiator. Server-initiated pushes (`updateBoard.routingConfig`, `updateColumnDragDropModes.modes`, `cliTriggersState.enabled`, and `overrideState`) are composed once and fanned out to every client, so they always carry whichever project was switched to last. Gives each WebSocket connection its own declared project scope, renders those four payloads per connection across fourteen emit sites, and models the VS Code webview as a connection so the editor is not a privileged default.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Kanban Project Filter — Client-Local View, Per-Initiator Authoring Scope](../plans/kanban-project-filter-client-local.md) — **CODE REVIEWED** — ID: c0de3d94-827a-4875-bb4d-0d7f5d3ca5db
- [ ] [Per-Connection Client Identity and Scoped Push Rendering](../plans/per-connection-scoped-push-rendering.md) — **CODE REVIEWED** — ID: 45f5cf10-1a94-4902-a59f-0143cde93231
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strictly ordered — these cannot run in parallel.**

1. *Kanban Project Filter — Client-Local View, Per-Initiator Authoring Scope* must merge first.
2. *Per-Connection Client Identity and Scoped Push Rendering* starts only after it.

Two independent reasons:

- **Same-file collision.** Both subtasks edit `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, and `src/services/verbSchemas.ts`. The project's orchestration discipline is explicit that the same provider file serialises — different files parallelise, the same file does not.
- **Shared precedence helper.** Subtask 2 reuses the `_projectTier` / `resolveAuthoringProject` precedence rule that subtask 1 introduces. Its `!== undefined`-not-truthiness contract (an explicitly-unassigned client must resolve to *no project tier*, not inherit the shared default) is the single most likely thing to be implemented wrong; two subtasks authoring two copies of it would reintroduce the class of bug this feature exists to remove.

- **Shared extraction.** Subtask 2's `overrideState` factory builds on the pure `_buildOverrideState(...)` that subtask 1 extracts out of `_postOverrideState` in its step 6. Concurrent work would do the extraction twice and collide.

Subtask 2 also **flips two contracts subtask 1 deliberately pins**: subtask 1's test 13 asserts that push payloads remain shared, and its test 17 asserts the refresh cluster still broadcasts singleton-rendered `overrideState`. Both exist so the boundary between the two passes is a tested fact rather than silent drift. Subtask 2 replaces each with its inverse — update them, do not delete them.

**Subtask 1 does not close its own bug 2 on its own.** It stops `setProjectFilter` from broadcasting `overrideState` and returns it in the verb body, which is correct and is the half that has an initiator — but three refresh-cluster emitters (`KanbanProvider.ts:2022`, `:3523`, `:3688`) keep broadcasting the singleton-rendered value on every board refresh, silently reverting it seconds later. Subtask 2's `overrideState` conversion is what makes the fix hold. Do not mark bug 2 closed on subtask 1 alone; subtask 1's test 7 passing is necessary, not sufficient.

Within subtask 1, stage 1 (the unfiltered card set) is independently shippable and fixes the user-visible bug on its own; ship it early if the blank-board symptom needs to go away before the rest lands. Its step 2 (the occupancy workaround) is independent of step 1 and can ship separately again.

## Reconciliation record (improve-feature pass, 2026-07-28)

The subtask **set is unchanged** — two plans, same split, same order. No merge, split, or deletion was warranted: the two address genuinely different mechanisms (request-scoped threading vs. per-connection rendering) over largely different primary files, the dependency is hard and already documented, and subtask 1's stage 1 is independently shippable. What changed is the **boundary between them** and the accuracy of both.

**One scope transfer.** `overrideState` was identified as a fourth scope-dependent push type. Subtask 1 keeps the half with an initiator (return-in-body from `setProjectFilter`); the three refresh-cluster emitters move to subtask 2 alongside the other eleven emit sites. Subtask 1 pins the remainder with a new test 17; subtask 2 flips it.

**Contended surfaces and their single reconciled end-state:**

| Surface | Owner | Reconciled end-state |
|---|---|---|
| `_projectTier(initiatorProject?)` | subtask 1 introduces | subtask 2 calls it with the connection's scope — one precedence rule, never two |
| `_buildOverrideState(scope)` | subtask 1 extracts | subtask 2 converts its caller to a factory |
| `overrideState` push | subtask 1: verb-body half | subtask 2: refresh-cluster half + the `!this._panel` guard relaxation |
| `updateBoard` / `updateColumnDragDropModes` / `cliTriggersState` | subtask 1: out of scope, pinned by test 13 | subtask 2: per-connection factories |
| `kanban.html` dropdown branch | subtask 1 adds `initiatorProject` to verb payloads | subtask 2 wraps all five `boardProjectFilter` assignments in one declaring helper — built on top of subtask 1's code, not replacing it |
| `verbSchemas.ts` | subtask 1: `initiatorProject` on the authoring verbs | subtask 2: `setPushScope`. Append-only, serialised |
| `TaskViewerProvider.ts:17432` | neither | **not a dead local** — subtask 1's instruction to delete it was factually wrong and has been withdrawn |

**Corrections applied during the pass** (both plans carry the detail inline as Superseded blocks): subtask 1's authoring read-site table went from four sites to **nine** (the missed ClickUp importer at `TaskViewerProvider.ts:6762` is a sixty-six-line-away sibling of the Linear one already listed); `:4627` was reclassified out of the deferred push floor into stage 4 (it is a generated-prompt read with a real initiator, not a broadcast); `exportPromptSettings:919` was added as a scoped read that bypasses all four accessors; the drag-drop push was renamed from `updateColumns` to `updateColumnDragDropModes` so both plans name the same message; and subtask 2's emit-site count went from ten to fourteen. Both plans' remaining numeric claims were re-verified against the source (35 `_refreshBoard` call sites and 75 cached-field reads are both exact).
