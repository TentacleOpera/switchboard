# A Dispatch Lands on a Real PTY-Backed Seat, or Says Why Not

**Complexity:** 6

## Goal

Make seat resolution honest. Teams are PTY-only, so no team automation may fall back to a non-PTY path; complexity routing should prefer its tier but degrade across the live terminal pool rather than stall, sending everything to the one coding agent if that is all there is; and a team that could not give a seat a CLI must report it instead of silently spawning a bare shell.

## How the Subtasks Achieve This

- **Enforce PTY-only for team automations** — closes every non-PTY fallback across team creation, dispatch, schedule queue pop, terminal selection, team-scoped role resolution and worktree terminal creation.
- **Complexity routing degrades to the live terminal pool** — prefers the tier when it is available and otherwise degrades across what is actually alive; with one coding agent, everything goes to it.
- **Team start silently spawns bare shells for roles with no startup command** — reports the seats it could not give a CLI to, instead of spawning a bare shell and saying nothing.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Team start silently spawns bare shells for roles with no startup command](../plans/feature_plan_20260819092741_team-start-reports-commandless-seats.md) — **CODER CODED** — ID: 4139b10e-8f84-40a7-8ace-3569062de542
- [ ] [Enforce PTY-Only for Team Automations](../plans/enforce-pty-only-for-team-automations.md) — **CODER CODED** — ID: 83a75c14-b93a-499f-a49f-a7170a61e1db
- [ ] [Complexity Routing Degrades to the Live Terminal Pool](../plans/complexity-routing-degrade-to-live-pool.md) — **CODER CODED** — ID: 8fee0dcb-b3b2-4af8-baa2-5321d26e0278
<!-- END SUBTASKS -->

## Dependencies & sequencing

PTY-only lands first: it narrows the pool that complexity routing then degrades across, so routing built against the wider pool would need reworking. The commandless-seats report is independent of both.

## Implementation Summary

Team automation now resolves and delivers exclusively through live PTY seats across extension and standalone hosts, with explicit failure when no eligible seat exists. Complexity routing preserves the preferred tier but degrades bidirectionally through live, visible PTY roles, including `recommendedRole` and single-agent cases. Team startup now reports roles missing startup commands while preserving non-fatal spawn behavior. Verification for this run used full diff review and whitespace checks; automated tests and compilation were skipped by directive.


## Review Findings

Reviewed commit `6db5751` across all three subtasks. The feature goal — seat resolution that either lands on a real PTY seat or says why not — is achieved, with two defects fixed in this pass: `_createAutobanTerminal` was omitting `worktreePath` from the `ptyCreateTerminal` payload (leaving every worktree seat unmatched by `_findTerminalNameByWorktreePathAndRole`, so `ensureWorktreeTerminals` would have spawned a fresh terminal on every call with the per-worktree cap also blind), and the scheduled queue pop's teamless coding-head fallback had been deleted outright rather than narrowed to PTY, which broke the feature's own headline case of a single live coding agent taking everything. Also fixed: the `MAX_TERMINALS_PER_ROLE` cap was counting a registry read that drops all PTY rows, a `!info.hidden` filter that no writer in the codebase populates, and a `getAliveCodingTerminalNames` docblock left describing the VS Code cross-reference the commit removed. Files changed: `src/services/TaskViewerProvider.ts`, `src/test/queue-pipeline-contract.test.js`, `src/test/standalone-agent-team-isolation-contract.test.js`. Verification: `tsc -p tsconfig.test.json` clean, `eslint` 0 errors on changed files, `standalone-parity:check` and `host-seam-parity:check` green, and nine CI-wired contract suites green including the four new mutation-verified guards; the core PTY-vs-VS-Code creation behaviour still has only source-text discriminators and the manual checks were not executed, so that half of the verdict is provisional.

## Deferred Findings

- MAJOR — `.github/workflows/integration-tests.yml` — `npm test` (vscode-test) is not invoked by any CI job, so `src/test/kanban-complexity.test.ts` (the commit's only coverage of `resolveAutoDispatchColumn` degradation, hidden-column refusal and pair-mode refusal) never runs in CI.
- MAJOR — `src/services/KanbanProvider.ts:1626` — `resolveRoutedRole`'s default-on degradation ignores column visibility while the other two degradation sites honour it, so `recommendedRole` can name a role dispatch will refuse.
- MAJOR — `src/services/KanbanProvider.ts:1363`, `:2332` — `codingHeadLive` still excludes intern-headed teams although `resolveCodingHeadFromGroups` now returns them.
- MAJOR — `src/services/TaskViewerProvider.ts:11374` — `_selectAutobanTerminal`'s PTY filter is unconditional rather than fleet-gated, so a fleet-less install selects no autoban terminal at all.
- NIT — `src/services/TaskViewerProvider.ts:11411` — `_createAutobanTerminal`'s `reveal` parameter is now unused; new terminals are never focused.
- NIT — `src/services/TaskViewerProvider.ts:11497` — `setTerminalAgentInfo` writes an unsuffixed key that `getActualTerminalAgentNames()` prunes on its next call.
- NIT — `src/services/TaskViewerProvider.ts:27543` — `_ensureSurvivorTerminal` still creates a VS Code terminal ungated (scheduler job seat, not a team role).
- NIT — `src/services/KanbanProvider.ts:1625` — the live-pool read happens before the `degradeLivePool` flag is tested.
- NIT — `src/services/agentGroupInstantiation.ts:184` — `instantiateExternalHeadedTeam` does not report `commandlessRoles`, so externally-headed teams still start commandless members silently.
