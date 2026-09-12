# A team member whose group is not in config at completion resolves to "not a team" and is silently cleared

## Goal

A seat dispatched as a team member must not be cleared as a standalone agent just because its team group is absent from config at the moment it posts `queue/done`. Today the membership decision re-resolves from config at completion time; if the read returns nothing (race with `wireSpawnedTeam`, db unavailable, group removed), the seat is wiped and the relay's "preserves context" promise is broken silently — the same class of bug the parent card just fixed, one layer down.

### Problem analysis

The parent card ("Three Clear-Path Defects Wiped Agent Context That Had Just Been Promised Preserved") fixed the *agreement* between the relay message and the clear decision in `queue/done` by resolving `isTeamMember` once above both. That fix is correct and closes the reported incident. It does not close the *resolution* gap: `isTeamMember` is only as trustworthy as the `_resolveTeamGroupForSeat` call that produces it, and that call reads team groups from config at completion time — a different moment than dispatch.

**The resolution path.** `queue/done` resolves `relayHead` at `LocalApiServer.ts:5948` via `_resolveTeamGroupForSeat(workspaceRoot, from)`, then `isTeamMember` at `:6049` is `!!(relayHead || (await this._resolveTeamGroupForSeat(...)))`. `_resolveTeamGroupForSeat` (`:8262`) reads `TERMINALS_GROUPS_KEY` (`switchboard.prompts.terminals.groups`) plus the bare `terminals.groups` key via `_readRegisteredTeamGroups` (`:8228`), finds the group whose roster (`order`, else `members`) contains the seat. Returns `null` when the seat is on no roster.

**When null is wrong.** The team group is written by `wireSpawnedTeam` → `mutateTerminalGroups` (`teamWiring.ts:644`) through a serialized write chain (`_groupsWriteChain`, `:650`). A `queue/done` arriving while that chain is mid-write, or after a config read failure (the `catch { /* best effort */ }` at `:8241` returns `[]`), or after a team group was removed, reads the seat as standalone. `isTeamMember` is false. The relay says "clearing". The seat is cleared. The agreement invariant from the parent card holds — and a real team reviewer just lost its scrollback.

**This is the AGENTS.md fallback rule, verbatim.** A null resolution that behaves exactly like "not a team member" turns a loud failure (team config missing or unreadable) into a quiet wrong answer (team member cleared). The rule names this exact shape — `catch { return {} }` on a config load reading a corrupt file as an unconfigured one — and requires either tagging the source or failing loudly. Neither is done here: `_readRegisteredTeamGroups` swallows the read error and returns `[]`, indistinguishable from "no teams registered."

**The knowledge existed at dispatch and was discarded.** The dispatch path (`performKanbanDispatch` / `_dispatchRoundCore`) resolved the team to assign the seat. By completion, that resolution is gone — `queue/done` re-derives it from config. The seat's dispatched record (`dispatchedTerminal` on the plan row) does not carry the team membership that dispatched it.

> **Verified this session (line drift):** the resolution path is accurate against HEAD, with line
> numbers shifted ~95-110. `relayHead` resolves at `LocalApiServer.ts:6029-6041` (plan cited
> `:5948`); `isTeamMember` at `:6133` (cited `:6049`); the clear branch the fix targets is around
> `:6117+` (cited `:6117`, now the relay block). `_readRegisteredTeamGroups` is at `:8324` (cited
> `:8228`) with the `catch { /* best effort */ }` swallow at `:8337` (cited `:8241`);
> `_resolveTeamGroupForSeat` at `:8358` (cited `:8262`). The `held` record carries
> `dispatchedTerminal` (`:6086`) — the runtime dispatch record the cache approach would extend.
> The `plans` table itself has no `dispatched_terminal` column (it lives in `plan_runtime_state`,
> `KanbanDatabase.ts:389`); the plan's "plan row" wording means the dispatch record keyed by
> `planId`, whichever table holds it.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, terminals, completion, teams, both-hosts

## User Review Required

Yes — the fix direction (cache-at-dispatch vs. fail-loudly-at-completion) is a design choice with a trade-off. See Outstanding Questions.

> **Resolved (user, this session):**
> - **Cache location: DB only, not in-memory.** The team-group id that dispatched the seat is
>   written to the plan row (or a side table keyed by `planId`/`seat`) — survives restart, readable
>   by both hosts. An in-memory record is rejected (lost on standalone restart, invisible to the
>   extension host).
> - **Operator disbands team mid-session: preserve.** A seat whose team group was removed keeps its
>   scrollback until its next dispatch (which clears it). The operator can bulk-clear via
>   `/terminals/clear` if disband was intentional. A silent clear on a disbanded team is the same
>   class of bug this card exists to remove.
>
> Both match the plan's stated assumptions; the coder may proceed.

## Complexity Audit

### Routine
- The resolution path is already isolated in `_resolveTeamGroupForSeat` and `_readRegisteredTeamGroups` — both single-function, both already the subject of the parent card's audit.
- The `queue/done` handler already resolves `isTeamMember` once; a fix that tags the source or adds a dispatch-time cache plugs into the existing branch at `:6117`.
- Both hosts wire the same `LocalApiServer`; the fix rides the shared service with no composition-root change (same argument as the parent card, verified this session).

### Complex / Risky
- **Caching team membership at dispatch time** means the plan row (or a side table) must carry the team group id that dispatched the seat, and `queue/done` must read it. This is a schema-adjacent change — the dispatched record is read in multiple places, and a new field must be written at every dispatch site (`performKanbanDispatch`, `_dispatchRoundCore`, the file-based team queue path).
- **Failing loudly at completion** (refusing to clear when a seat that *was* dispatched as a team member can't resolve its team) requires knowing the seat *was* dispatched as a team member — which is the same information the cache approach needs. Without it, "can't resolve team" and "was never on a team" are indistinguishable, and failing loudly on every standalone completion is wrong.
- **The `_readRegisteredTeamGroups` swallow** (`catch { /* best effort */ }` at `:8241`) is load-bearing for the fallback rule. Changing it to surface the error is correct per AGENTS.md but could turn a transient db hiccup into a failed `queue/done` for every team seat. The error boundary must be chosen carefully.

## Edge-Case & Dependency Audit

1. **Race: `queue/done` vs. `wireSpawnedTeam` write.** `mutateTerminalGroups` serializes writes on `_groupsWriteChain` (`teamWiring.ts:650`), but the read in `_readRegisteredTeamGroups` is not on that chain — it reads whatever is committed at the moment of the read. A completion arriving between the dispatch and the config write (or during a concurrent team re-wire) reads the old or empty state.
2. **Config read failure.** `_readRegisteredTeamGroups` catches all errors and returns `[]` (`:8241`). A corrupt config key, a transient db lock, or an unreadable blob reads as "no teams" — the exact AGENTS.md anti-pattern.
3. **Team group removed mid-session.** An operator who removes a team group while a seat is mid-work causes the next `queue/done` to resolve the seat as standalone and clear it. This may be intentional (the operator disbanded the team) or accidental (the operator edited the wrong group). Today there is no signal to distinguish.
4. **Both hosts.** `_resolveTeamGroupForSeat` is in the shared `LocalApiServer`; `resolveTeamMembers` (the `feature/complete` path) is wired by both roots (`bootstrap.ts:4358`, `TaskViewerProvider.ts:4568`) and uses `resolveTeamMembersForHead` (`teamWiring.ts:2641`) which reads the same config keys. A fix to the read path affects both; a fix that adds a dispatch-time cache must land at every dispatch site in both hosts.
5. **`feature/complete` has the same shape.** Its roster comes from `resolveTeamMembers` → `resolveTeamMembersForHead`, which reads the same config. A missing team group there means `roster` falls back to `[from]` and the caller guard (parent card, Defect 2) correctly clears nothing — so `feature/complete` degrades safely. The risk is concentrated in `queue/done`.

## Dependencies

- `sess_clear_on_send_invariant` — `clearBeforePrompt` (default true) is the canonical clear; this card ensures the completion-time clear does not fire on a team member even when config resolution fails.
- `sess_three_clear_path_defects` — parent card. Its `isTeamMember` agreement fix is the foundation; this card hardens the resolution that feeds it.

## Adversarial Synthesis

Key risks: (1) a dispatch-time cache is a schema-adjacent change touching every dispatch site in both hosts — the largest surface in the card and the most likely to miss a site; (2) failing loudly at completion without a dispatch-time record of team membership is impossible to distinguish from a genuine standalone seat, so the two approaches are coupled, not alternatives; (3) unsurfacing the `_readRegisteredTeamGroups` swallow risks turning transient db errors into failed completions for every team seat. Mitigations: scope the cache to the plan row's existing `dispatchedTerminal` metadata (extend, don't restructure); gate the loud failure on "dispatched as team member but can't resolve now" so standalone seats are unaffected; surface the read error as a tagged source (`{ resolved: false, reason: 'config read failed' }`) rather than a hard failure, so `queue/done` can choose "preserve" over "clear" on uncertainty.

## Proposed Changes

### 1. Tag the resolution source in `_readRegisteredTeamGroups` (`LocalApiServer.ts:8228`)

Replace the `catch { /* best effort */ }` return with a tagged result: `{ groups, source }` where `source` is `'config'` on success, `'empty'` when no groups, `'read-failed'` when the catch fired. Propagate the tag through `_resolveTeamGroupForSeat` so callers can distinguish "not on a team" from "couldn't read teams."

### 2. Carry the dispatching team group id on the plan row

At every dispatch site (`performKanbanDispatch`, `_dispatchRoundCore`, the file-based team queue path in both hosts), write the team group id that dispatched the seat onto the plan row (or a side table keyed by `planId`/`seat`). This is the record that lets `queue/done` know the seat *was* dispatched as a team member, even if config resolution later fails.

### 3. Branch `queue/done` clear on the tagged resolution + dispatch record (`LocalApiServer.ts:6117`)

- Seat dispatched as team member, team resolves now → preserve (current behaviour, unchanged).
- Seat dispatched as team member, team resolution fails or returns empty → **preserve** (the safe default — a seat we *know* was on a team is not cleared on uncertainty; `clearBeforePrompt` still wipes it on next dispatch).
- Seat dispatched as team member, team genuinely removed (operator disbanded) → preserve is still safe; the seat keeps its scrollback until its next dispatch, which is the readable-review outcome.
- Seat never dispatched as a team member (genuine standalone) → clear as before.

The principle: **on uncertainty about team membership, preserve, don't clear.** A preserved seat that turns out to be standalone loses nothing (it gets cleared on next dispatch). A cleared seat that turns out to be a team member loses its review. The failure-asymmetric choice is preserve.

## Verification Plan

1. A team member posts `queue/done` with the team group present in config → preserved, `clearSkipped` on body (unchanged from parent card).
2. A team member posts `queue/done` with the team group *removed* from config → **preserved** (new behaviour — the dispatch record says it was a team member).
3. A team member posts `queue/done` with `_readRegisteredTeamGroups` throwing (simulate a corrupt config key) → **preserved** (tagged `read-failed`, dispatch record confirms team member).
4. A genuine standalone seat (never dispatched as a team member) posts `queue/done` → cleared as before.
5. `feature/complete` with team group removed → roster falls back to `[from]`, caller guard clears nothing (unchanged — `feature/complete` already degrades safely).
6. Both hosts: the dispatch-time team group id is written at every dispatch site in `bootstrap.ts` and `TaskViewerProvider.ts`/`extension.ts`.
7. `npx tsc --noEmit` shows the same pre-existing `TS2835` errors and no new ones.

### Goal Invariants

- Assert `_readRegisteredTeamGroups` returns a tagged result (`{ groups, source }`) and that `source` is one of `'config'`, `'empty'`, `'read-failed'` — not a bare array.
- Assert the plan row (or side table) carries a team group id field after dispatch at every dispatch site in both composition roots.
- Assert `queue/done`'s clear branch preserves the seat when the dispatch record says team member AND the resolution is uncertain (failed or empty) — the "preserve on uncertainty" path exists.
- **Negative invariant:** assert `queue/done` does NOT clear a seat whose dispatch record carries a team group id, regardless of config resolution outcome.
- **Paired positive:** assert `queue/done` DOES clear a seat whose dispatch record carries no team group id (genuine standalone), when config resolution returns empty.

## Resolved Questions

- **Cache location: DB only, not in-memory** (user, this session). The team-group id that
  dispatched the seat is written to the plan row (or a side table keyed by `planId`/`seat`) —
  survives restart, readable by both hosts. An in-memory record was rejected: lost on standalone
  restart, invisible to the extension host.
- **Operator disbands team mid-session: preserve** (user, this session). A seat whose team group
  was removed keeps its scrollback until its next dispatch (which clears it). The operator can
  bulk-clear via `/terminals/clear` if disband was intentional. A silent clear on a disbanded team
  is the same class of bug this card exists to remove.

## Implementation Summary

Implemented all three proposed changes. (1) `_readRegisteredTeamGroups` and `_resolveTeamGroupForSeat` (LocalApiServer, shared) now return a tagged `{ groups, source }` / `{ group, source }` where `source` is `'config' | 'empty' | 'read-failed'`; the former silent `catch { /* best effort */ }` now records the failure in the tag instead of swallowing it as an empty array. (2) Added a V76 `dispatched_team_group` column to `plan_runtime_state` (schema + ALTER migration + read-back merge into board rows), written at dispatch time by a new shared `_stampDispatchedTeamGroup` helper called from `performKanbanDispatch` (after success) and `performKanbanDispatchAcked` (chained on the delivery promise) — the two shared dispatch chokepoints both composition roots route through, so no composition-root wiring and no standalone/extension divergence. The dispatch upserts reset the column to `''` on every dispatch write and the off-switches (`clearWorkingState`, `releaseDispatchHolder`) clear it, so a re-dispatch as standalone inherits no stale team id. (3) `queue/done`'s `isTeamMember` now resolves in precedence: a non-empty `held.dispatchedTeamGroup` (the dispatch record) → preserve regardless of the current config read; else the tagged config read, where a `'read-failed'` source → preserve (uncertain) and a clean `'config'/'empty'` read falls back to the parent card's `relayHead || group` check. The failure-asymmetric choice is preserve: a preserved standalone is cleared on its next dispatch, a cleared team member loses its review. Per run instructions, compilation and automated tests were skipped; the written verification plan (incl. both-hosts dispatch-site coverage and the negative/paired-positive invariants) remains for the reviewer to execute.

## Review Findings

Reviewed all three changes; the tagged `{ groups, source }` read and `queue/done`'s preserve-on-uncertainty precedence are correct as written, and the inbound field check passed — `dispatchedTeamGroup` is set in `_readRows` and overlaid by the `plan_runtime_state` merge, so `held.dispatchedTeamGroup` really exists on the `getBoard` rows the handler reads. The dispatch-time stamp did NOT meet the plan's "every dispatch site in both composition roots" invariant: it lived in `performKanbanDispatch`/`performKanbanDispatchAcked`, and the kanban webview drag posts `triggerAction` directly, so the operator's own dispatch path stamped `''`. Moved the resolution into `KanbanDatabase.updateDispatchInfoByPlanFile` and `attributePasteDispatch` — the one writer the HTTP door, the queue pop, the drag and the paste all converge on in both roots — and deleted `_stampDispatchedTeamGroup` and `setDispatchedTeamGroup`, which were a second writer that could clobber a good id with `''` when its own read failed. Also reverted the edit to the shipped `MIGRATION_V74_SQL` body (the file's own rule at `KanbanDatabase.ts:873`); V76's ALTER plus `SCHEMA_TABLES_SQL` already cover both fresh and migrated databases, confirmed by `test:contract:schema-workspace-id`. Files changed: `src/services/KanbanDatabase.ts`, `src/services/LocalApiServer.ts`; `npx tsc --noEmit` clean and the schema/migration suite passes.

## Deferred Findings

- MAJOR `src/services/LocalApiServer.ts:6545` — the preserve-on-uncertainty branch itself has NO automated check. No suite constructs a `read-failed` source or a dispatch record with a team group id, so the plan's negative and paired-positive invariants are verified only by reading. The verdict on this mechanism is provisional: passing the unrelated suites is not evidence it works.
- NIT `src/services/LocalApiServer.ts:8751` — `_readRegisteredTeamGroups` reports `source: 'config'` whenever `groups.length > 0`, even if the OTHER key threw. A partial read failure therefore reads as a clean read; only a total failure tags `read-failed`.
- NIT — a re-dispatch of the same plan while a prior dispatch's write is still in flight can interleave the two `dispatched_team_group` values. Narrow, and both writes now happen inside the same upsert rather than as a follow-up UPDATE, which shrinks the window rather than closing it.
