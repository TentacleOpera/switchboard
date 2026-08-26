# Standing Orders on Terminal Establish and Clear

**Complexity:** 5

## Goal

Today standing orders are delivered as a suffix appended to every prompt sent to a terminal — they ride on dispatch, not on terminal lifecycle. This means a terminal that is cleared (context reset) loses its standing orders until the next dispatch carries them back in. It also means role-specific instructions (like the planner workflow prompt) must be manually pasted into terminals, because there is no role-scoped standing order that applies to every terminal of a given role.

This feature adds a `role` scope to the standing orders system and delivers standing orders at two terminal lifecycle moments: when a terminal is established (spawned or role-assigned) and after a terminal is cleared. A role-scoped order applies to every terminal with that role — planners get the planner workflow, coders get the coding directives, reviewers get the review protocol — automatically, without manual paste and without waiting for the next dispatch to carry them.

## How the Subtasks Achieve This

- **Role Scope in Standing Orders**: Adds a `role` scope to `StandingOrderScope` and teaches `selectOrders` to resolve it from the terminal registry (`_terminalAgentInfo`). A role-scoped order applies to every terminal whose role matches, regardless of team membership. This is the foundation — without it, there is no way to say "all planners get this instruction."
- **Deliver Standing Orders on Terminal Establish**: When a terminal is spawned or has its role assigned, the system sends the terminal its applicable standing orders as a one-shot prompt (not appended to a dispatch — a standalone delivery). The terminal sees its orders immediately on establishment, not after the first dispatch.
- **Deliver Standing Orders After Clear**: When a terminal is cleared (via `clearTerminalContext` or the `/clear` clipboard paste), the system re-sends the terminal's applicable standing orders as a one-shot prompt after the clear completes. A cleared terminal re-establishes its orders without waiting for the next dispatch.

## Dependencies & sequencing

- **Role scope lands first.** The establish/clear delivery subtasks need to know which orders apply to the terminal being established or cleared — the role scope is how they resolve.
- **Establish delivery and clear delivery can proceed in parallel** once the role scope is in place. They share the same resolution path (`selectOrders` + role) but plug into different lifecycle hooks.

Rough order: role scope → (establish delivery ‖ clear delivery).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standing Orders: Add a `role` Scope](../plans/standing-orders-role-scope.md) — **CODE REVIEWED** — ID: d31aab82-5a6a-4ea2-880b-25fd55aceaee
- [ ] [Deliver Standing Orders on Terminal Establish](../plans/standing-orders-deliver-on-establish.md) — **CODE REVIEWED** — ID: 84fea818-4e44-442b-9c4a-631ff4cf0a1d
- [ ] [Deliver Standing Orders After Terminal Clear](../plans/standing-orders-deliver-after-clear.md) — **CODE REVIEWED** — ID: b8ffd075-79fe-4b96-818a-a74c0857a7e9
<!-- END SUBTASKS -->

## Completion Summary

All three subtasks implemented and committed. Role scope added `'role'` to `StandingOrderScope`, a `role?` field to `StandingOrder`, `roleMap` parameter to `selectOrders`/`applyStandingOrders`/`renderStandaloneOrdersBlock`, and updated `scopeRank` (role at rank 1). Establish delivery added `_deliverStandingOrdersOnEstablish` in `TaskViewerProvider.ts`, centralized the hook in `setTerminalAgentInfo`, routed worktree/orchestrator spawn sites through it (registration sweep excluded), and skips the orchestrator role. Clear delivery added `_deliverStandingOrdersAfterClear` helper wired into both `cleared:true` return points in `clearTerminalContext`. Files changed: `src/services/standingOrders.ts`, `src/services/TaskViewerProvider.ts`, `src/services/LocalApiServer.ts`, `src/standalone/bootstrap.ts`. No issues encountered.

## Review Findings

All three subtasks reviewed together; the feature's core mechanism was sound but the delivery call was wrong in a way no gate could see. Three CRITICALs fixed: (1) the one-shot ran with `clearBeforePrompt` defaulting **on**, so every establish/clear delivery pasted `/clear` before its own payload — on the clear path that races the clear-then-dispatch chain in `LocalApiServer.ts:2210/:4108` and could wipe a task prompt a seat had just been given; (2) `addonsComposed: true` suppresses only the seat block, so both `_ptyHostVerb` and `sendRobustText` re-ran `applyStandingOrders` over the already-rendered block — stripping it and re-appending one recomputed under a different name keyspace (and with no `roleMap` on the VS Code path), which drops the role rules and can yield an empty payload; (3) the `scopeRank` renumber left `test:contract:standing-orders-marker` red in CI and the `terminals.js` mirror unsynced. Also fixed: dual-keyspace `roleMap` (establish passes the IDE-suffixed key, clear passes the unsuffixed `friendlyName`), a 1500ms CLI-boot grace on establish, and the orchestrator skip narrowed to establish only. Files changed: `src/services/TaskViewerProvider.ts`, `src/webview/terminals.js`, `src/test/standing-orders-marker-contract.test.js`; validation: typecheck + `npm run compile` clean, `standing-orders-marker` 63/0 (was 55/1) with 7 new role-scope tests, 11 adjacent contract gates unchanged — `push-routing:check` and `seat-safeguards` are red on `main` independently of this feature (`KanbanProvider.ts`, and audit counts already 11-vs-7 before these commits).
