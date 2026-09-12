# Team Lifecycle: Start, Membership and Release

**Complexity:** 6

## Goal

Fix the three phases of a team's life — how it starts, how its membership survives completion, and how it is released — plus the team-wiring debt those phases sit on. Starting a lone terminal must not create a phantom team and a host coming up must spawn nothing until work asks for one; a team member must not be cleared as a standalone agent just because its team group is unreadable at the moment it posts `queue/done`; and "free the team" must be separable from "the work is finished" so agents stop asserting done just to unlock the queue. Underneath, the team-wiring layer must stop identifying things by frozen text and stop degrading silently on unexpected roster shapes, so the subsystems that address a team can actually do so.

## How the Subtasks Achieve This

- **Team Wiring Carries Frozen String Piles, Silent Fallbacks, and Teams Nothing Can Address**: the shared wiring layer. Replaces exact-text recognisers with a version stamp on the standing-order row, fails loud on an unresolved `{coder}` placeholder, resolves object rosters in `rosterOf` (so reviewer delegation is not silently dropped), makes pty-spawned teams addressable by the automation service, and carries the `head` key on the `/command` wire so two teams sharing a head role are distinguishable. The other subtasks depend on this layer being trustworthy.
- **A team member whose group is not in config at completion resolves to "not a team" and is silently cleared**: the membership phase. Tags the team-group resolution source (`{ groups, source }`) and caches the dispatching team group id at dispatch time, so `queue/done` preserves a team member's scrollback when config resolution fails or returns empty — the AGENTS.md fallback-indistinguishable-from-a-value fix, one layer down from the parent card.
- **A Head-Only Definition Registers a Phantom Team on Every Start**: the start phase (registration). Confirms `wireSpawnedTeam`'s self-guard (`teamWiring.ts:1684`) is the single chokepoint that already prevents member-less starts from registering a team, removes the now-redundant duplicate guard, and stops a head terminal being named after its definition (the "Lead team" bug) — so starts don't produce phantom or unreadable teams.
- **Delete Auto-Start**: the start phase (boot). Removes the `startTeamsOnLoad` boot sweep and retires the `startOnLoad` field (clear-on-read), while explicitly keeping `startWorktree` (load-bearing for manual starts), so a freshly started host has no live seats until something asks for one.
- **Completion Is the Only Way to Release a Team, So It Gets Posted Before the Work Is Done**: the release phase. Adds a non-completion release verb (coupled with forcing `outcome` on completion, so completion stays meaningful), adds `outcome`/`workflow` to the `plans` row, and rewrites the queue's 409 + the agent-facing skills to name the release door — so an agent frees its team without claiming the work is done, and completions carry what happened.

## Dependencies & sequencing

- **Subtasks 3 (phantom team) and 4 (auto-start) are independent and low-complexity — land first.** Neither shares a mutable surface with the others; both are quick wins that immediately improve the start phase.
- **Subtasks 2 (completion membership) and 5 (release vs complete) share the plans-adjacent schema.** Subtask 2 extends the dispatch record with a team-group id; subtask 5 adds `outcome`/`workflow` columns to the `plans` row. Both are `ALTER TABLE` migrations landing in the same delivery — coordinate them as one migration version (or adjacent versions), not two competing passes. They are otherwise independent in logic (subtask 2 is `queue/done`-scoped; subtask 5 adds a release verb through `completeCardInternal`) and can land in either order once the migration is coordinated.
- **Subtask 1 (team wiring) is the broadest and largely independent.** Its internal couplings: change 1 (version stamp) + change 2 (delete `OLD_HEADPROMPT`) must land host-and-client-mirror-and-contract-pin in one diff; change 4 (`rosterOf`) + change 5 (reviewer callback) should land together because change 4 changes when the cross-team guard fires. Subtask 1's change 7 member-less half is dropped on subtask 3's authority (the `wireSpawnedTeam:1684` self-guard), so subtask 1 does NOT depend on subtask 3 landing first — the drop is by superseded callout, not by code.
- **Prerequisite / guard:** subtask 1 change 2 (delete `OLD_HEADPROMPT_V2_FRAGMENT`) is a clean break authorised only because teams have never shipped — it is flagged User Review Required; confirm that assumption before the coder deletes the constant, both branches, the false comment, and the contract pin together. Subtask 5 inverts a deliberate, commented design (no release valve); its changes 1, 2, and 4 must ship together or the feature is a green test on a dead verb.

## Team Dispatch Instructions

### Team Wiring Carries Frozen String Piles, Silent Fallbacks, and Teams Nothing Can Address
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - A standing-order revision needs no new text recogniser; the row's version drives migration, and the client mirror (`terminals.js`) carries no body constants.
  - A coder-less team fails visibly at spawn; no installed order contains the literal `{coder}`.
  - A roster of member objects returns the same delegation answer as the equivalent roster of strings (via `rosterOf` resolving object members to `friendlyName`); the conservative `return true` catch/empty arms are unchanged.
  - A team spawned through the pty verb is addressable by `LinearAutomationService`; two teams sharing a head role are distinguishable on the `/command` wire (the `head` key is served). The member-less-seed-team write is NOT added.
  - `src/test` contains assertions over `resolveTeamSeats`, `filterByProject`, AND `rosterOf`/`terminalsShareTeam`.
- **Must not touch:** the active card *Completion Directive Becomes a Standing Order* owns the definition-text write — do not duplicate its version stamp. Do not re-add a member-less-seed-team group write (subtask 3's `wireSpawnedTeam:1684` self-guard stands).

### A team member whose group is not in config at completion resolves to "not a team" and is silently cleared
- **Seat:** Coder (complexity 5)
- **Acceptance:**
  - `_readRegisteredTeamGroups` returns a tagged result `{ groups, source }` with `source` one of `'config'`, `'empty'`, `'read-failed'` — not a bare array.
  - The plan row (or side table) carries a team group id after dispatch at every dispatch site in both composition roots (`bootstrap.ts` and `TaskViewerProvider.ts`/`extension.ts`).
  - `queue/done` preserves the seat when the dispatch record says team member AND resolution is uncertain (failed or empty); it clears a genuine standalone (no team group id) as before.
  - `feature/complete` with team group removed still degrades safely (roster falls back to `[from]`, caller guard clears nothing).
- **Must not touch:** the `feature/complete` path's safe-degradation behaviour (already correct). Coordinate the `ALTER TABLE` version with the release-vs-complete subtask, not duplicate it.

### A Head-Only Definition Registers a Phantom Team on Every Start
- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - Instantiating a definition with `members: []` adds no row to `switchboard.prompts.terminals.groups`; with one delegate it adds exactly one `team_` row (regression guard on the existing `wireSpawnedTeam:1684` self-guard).
  - A head terminal's name never equals its definition's name for a head-only definition.
  - If the `bootstrap.ts:2361` duplicate guard is removed, the standalone `ptyStartTeam` path still registers no team for `members: []`.
- **Must not touch:** the legacy roster-row prune for definition-names-as-members (owned by `groups-are-ephemeral-teams-are-durable-one-store-cannot-be-both`). Do not add a second `children.length` guard duplicating `wireSpawnedTeam`'s.

### Delete Auto-Start
- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - A freshly started host has no live seats until something asks for one; `startOnLoad` is read by no code path and cleared on read from stored definitions.
  - `ptyStartTeam` and the START TEAM button still start a team when called.
  - `startWorktree` is NOT retired — a team with `startWorktree` set, started manually, still spawns into its worktree; the UI worktree input remains authorable independent of the (removed) auto-start checkbox.
- **Must not touch:** `startWorktree` (load-bearing for manual starts via `startAgentGroupById`/`startTeamForWorkspace`). Orphan reaping is out of scope (noted, not blocked).

### Completion Is the Only Way to Release a Team, So It Gets Posted Before the Work Is Done
- **Seat:** Coder (complexity 5)
- **Acceptance:**
  - `POST /kanban/task/complete` without an `outcome` is refused (for new posts after migration).
  - A release frees the team for `POST /kanban/queue/next` and the card does NOT read as completed anywhere; a release does NOT write `completed_at`.
  - A completed card's row carries its `outcome`/`workflow`, readable without going to `plan_events`.
  - The `409` body and both skill files (`switchboard-orchestration`, `kanban_operations`) name the release door, not completion.
  - The internal `round-complete`/`feature-complete` callers supply an outcome (not rejected).
- **Must not touch:** the `completeCardInternal` `completed_at`-keyed idempotency (a release needs its own "already released" guard, not a reuse of the completion idempotency). Coordinate the `ALTER TABLE` version with the completion-membership subtask. Do not retroactively enforce the outcome invariant on the 193 historical empty-outcome rows.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Team Wiring Carries Frozen String Piles, Silent Fallbacks, and Teams Nothing Can Address](../plans/memo-team-wiring-carries-frozen-strings-silent-fallbacks-and-unaddressable-teams.md) — **CODE REVIEWED** — ID: 470c39fd-44b8-47ec-ba66-61509c559f18
- [ ] [A team member whose group is not in config at completion resolves to "not a team" and is silently cleared](../plans/a-team-member-whose-group-is-not-in-config-at-completion-resolves-to-not-a-team-and-is-silently-cleared.md) — **CODE REVIEWED** — ID: 5e497cab-61d6-441e-8ba8-663ce3f62363
- [ ] [A Head-Only Definition Registers a Phantom Team on Every Start](../plans/a-head-only-definition-registers-a-phantom-team-on-every-start.md) — **CODE REVIEWED** — ID: 3540ee1a-9db2-4e13-893d-4b621cd08266
- [ ] [Delete Auto-Start](../plans/teams-start-when-a-card-needs-them-not-at-boot.md) — **CODE REVIEWED** — ID: ed7aebbe-d909-4890-b78c-3aedf9a68121
- [ ] [Completion Is the Only Way to Release a Team, So It Gets Posted Before the Work Is Done](../plans/completion-is-the-only-way-to-release-a-team-so-it-gets-posted-early.md) — **CODE REVIEWED** — ID: c56a329e-82a3-4d55-9b48-bb29e94ce500
<!-- END SUBTASKS -->

## Completion Summary

All five subtasks implemented, reviewed, and committed in a single delivery unit (commit 307078f3). Subtask 1 (team wiring) replaced frozen order-body recognisers with a version stamp, deleted the V2 fragment and its contract pin, made coder-less teams fail loudly, extracted rosterOfGroup for object-member resolution, installed reviewer callbacks unconditionally on coder resolution, made pty-spawned teams addressable by automation, and served the live head key on the /command wire in both hosts. Subtask 2 (completion membership) tagged team-group reads with source, cached the dispatching team group id at dispatch time (V76), and made queue/done preserve team members on uncertain resolution. Subtask 3 (phantom team) removed the redundant guard and fixed head naming. Subtask 4 (auto-start) removed the boot sweep and retired startOnLoad. Subtask 5 (release vs complete) added the release valve (V77), forced outcome on completion, and updated the 409 and both skill files to name the release door.


## Review Findings

Reviewed all five subtasks against commit `307078f3`; fixed two CRITICALs, four MAJORs and two NITs across `teamWiring.ts`, `TaskViewerProvider.ts`, `KanbanDatabase.ts`, `LocalApiServer.ts`, `kanban.html`, `package.json`, `.github/workflows/integration-tests.yml` and two test files. The CRITICALs were a version stamp that had become a licence to overwrite an operator-authored team prompt, and an unawaited DB promise that made subtask 1's `head` key work on the standalone host and silently never on the extension host — the exact composition-root divergence this feature exists to close. The MAJORs were the dispatch-time team-group stamp missing the board-drag path (now resolved in the one DB writer both roots and every dispatch path converge on, with the second writer deleted), a release valve that could return success having freed nothing, an edit to the shipped `MIGRATION_V74_SQL` body, and two gate holes: subtask 1's 334-line test file had no npm script or CI step and had never run, and subtask 3's and subtask 5's named checks did not exist. Change 4 of subtask 5 — the `.agents` skill-file edits, the plan's own load-bearing adoption mechanism — was written but left uncommitted by the implementation and is included here. Validation: `npx tsc --noEmit` clean apart from the four pre-existing `TS2835`; `team-wiring-roster-seats` 41/41 and `atomic-team-lifecycle` 10/10 (both previously not-run or red), with `team-scoped-routing`, `schema-workspace-id`, `coding-head-prompt`, `queue-done-relay`, `verb-engine-kanban` and eight more green; every remaining red suite reproduces with these fixes stashed and, where spot-checked, at `c6a71581` — the commit's own parent.

## Deferred Findings

- MAJOR `src/services/LocalApiServer.ts:6545` — subtask 2's core mechanism (preserve a team member when the config read is uncertain) has no automated check in any suite; that verdict is provisional.
- NIT `src/services/LocalApiServer.ts:544` — `onTeamReleased` is wired by NEITHER composition root, so the advance-when-ready hook is inert on both hosts (pre-existing, and the exact `Promise<void>` seam AGENTS.md names).
- NIT `src/webview/terminals.js:11412` — `NEW_CODING_HEAD_PROMPT_CLIENT` now has zero consumers but stays pinned by `coding-head-prompt-contract.test.js`.
- NIT `src/services/LocalApiServer.ts:8751` — a partial config-key read failure still tags `source: 'config'`.
- NIT `src/services/KanbanDatabase.ts:3671` — `clearReleasedAt` has no caller, so a re-dispatched card keeps a stale `released_at`.
- NIT `src/test/team-autostart-workspace-scope.test.js:346` — the auto-start deletion is asserted on source text, not on an empty live terminal registry as the plan specified.
- NIT — `terminals.autostart.lastRunAt` is now an orphan config row with no writer and no reaper.
- NIT `package.json` — `test:contract:terminal-operations-no-periodic-reopen` and `test:contract:composer` are defined but invoked by no workflow (pre-existing, unrelated to this feature).
