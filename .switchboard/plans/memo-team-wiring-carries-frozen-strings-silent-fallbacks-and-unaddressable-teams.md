# Team Wiring Carries Frozen String Piles, Silent Fallbacks, and Teams Nothing Can Address

## Goal

`teamWiring.ts` and its client mirror must stop accumulating frozen copies of prompt text, stop degrading silently when a roster is not the shape they expect, and record enough about a started team that other subsystems can address it.

### Problem analysis

Eleven reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. They share one file and one root cause: the module identifies things by **exact text or by name**, so every revision adds a recogniser and every unexpected shape falls through to a default.

Two of them are the codebase's own named failure mode — a fallback indistinguishable from a real value.

> **Verified this session (line drift — file grew ~250-850 lines):** all eight findings are present
> on HEAD; line numbers below are updated where checked. Change 1: `LEGACY_CONTEXT_AWARE_COMPLETION_ORDER_BODY` at `teamWiring.ts:391`, `_V2` at `:424`; the install recogniser at `:2124`. Change 2: `OLD_HEADPROMPT_V2_FRAGMENT` at `:853` (was `:611`); rewrite branch at `:2155` (was `:1822`); mirror at `terminals.js:11515/11558` (was `:12350/12365`); contract pin at `stage-marker-commit-contract.test.js:464`. Change 3: `{coder}` warn at `teamWiring.ts:1790-1798` (was `:1487-1493`); Review preset `members: []` at `:542`. Change 4: `terminalsShareTeam` at `:2700` (was `:2398`), `rosterOf` at `:2735`, catch `return true` at `:2732`, empty `return true` at `:2733`, object-roster `return false` at `:2748`. Change 5: `installReviewerCallbackOrder` call sites at `TaskViewerProvider.ts:8712` and `:23131` (was `:7965`, `:22274`); cross-team guard at `:8695-8699` (was `:7959-7963`); `coder && originLead` guard at `:8701`. Change 6: `LinearAutomationService.ts:260-270` (exact). Change 7: member-less early return at `teamWiring.ts:1684` and `:1691` (was `:1385-1390`); head stamp at `:1594`-area. Change 8: `resolveTeamSeats`/`filterByProject` in `src/webview/command.js`.

## Metadata

- **Complexity:** 6
- **Tags:** teams, prompts, both-hosts, bugfix

## User Review Required

Change 2 is an author decision. The rest are defects.

> **Resolved (user, this session):** change 2 — **delete** `OLD_HEADPROMPT_V2_FRAGMENT`, both
> rewrite branches, the false "V1" comment, and the contract pin
> (`stage-marker-commit-contract.test.js:464`) together. Clean break authorised: teams have never
> shipped, so no released install carries the V2 fragment in a persisted order. The coder may
> proceed with the deletion.

## Complexity Audit

### Routine
- Change 1's version stamp is a single column + a migration branch keyed on version, not body text. The recogniser deletions are mechanical once the stamp exists.
- Change 3 (fail-loud on `{coder}`) is a single branch flip from `console.warn` to a thrown/refused spawn.
- Change 6 (addressability) is adding `definitionId` (or a stable id) to the pty-spawn group write and a match arm in `LinearAutomationService.ts:260-270`.
- Change 8 is unit tests over pure functions — no UI driving.

### Complex / Risky
- **Change 1 + the client mirror.** `migrateCodingTeamOrdersClient` (`terminals.js:11532`) is a hand-mirror of the host migrator; a version stamp must land in BOTH in the same diff or the mirror drifts again. The contract pin at `stage-marker-commit-contract.test.js:464` asserts `OLD_HEADPROMPT_V2_FRAGMENT` exists in exactly two files — change 2's deletion must update that contract in lockstep or the test fails.
- **Change 4's real surface is `rosterOf`, not the catch arm.** `rosterOf` (`teamWiring.ts:2735`) drops non-string members; the catch/empty arms return `true` (conservative same-team). The fix is resolving object members to `friendlyName`, not touching the catch arm — see the superseded note on change 4.
- **Change 7 is partially superseded by subtask 3.** The member-less-seed-team half is moot: `wireSpawnedTeam:1684` already self-guards member-less starts out of registration (confirmed this session, blamed 2026-08-14). Only the head-ambiguity-on-the-wire half survives — see change 7.
- **Change 5 touches two install sites in one host.** Both `installReviewerCallbackOrder` call sites (`TaskViewerProvider.ts:8712`, `:23131`) are in the extension host; the standalone host routes team starts through `instantiateAgentGroupCore`/`ptyStartTeam`, so verify whether the reviewer-callback install is reachable from standalone at all (composition-root parity — the AGENTS.md trap).

## Edge-Case & Dependency Audit

- **Race Conditions:** change 1's version-stamp migration runs at install time inside `wireSpawnedTeam`'s serialized write chain (`_groupsWriteChain`); a concurrent re-wire reads the stamped version. No new race.
- **Security:** change 6 adds an id to the group write consumed by `LinearAutomationService`; the id is derived, not user-controlled, so no injection surface.
- **Side Effects:** change 2 deletes `OLD_HEADPROMPT_V2_FRAGMENT` and its contract pin — a clean break is authorised only because teams have never shipped (no released install carries the V2 fragment in a persisted order). If that assumption is wrong, this is a missing migration.
- **Dependencies & Conflicts:** change 7's member-less half conflicts with subtask 3 (phantom team) — resolved by dropping that half. Change 1 must coordinate with the active card *Completion Directive Becomes a Standing Order* (it writes the definition's text but says nothing about versioning the row — do not duplicate the stamp). Change 5's standalone reachability is a composition-root question (AGENTS.md parity trap).

## Dependencies

- Subtask 3 (phantom team) — confirms `wireSpawnedTeam:1684` self-guards member-less starts; change 7's member-less half is dropped on that authority.
- Active card *Completion Directive Becomes a Standing Order* — owns the definition-text write; change 1's version stamp must not duplicate it.

## Adversarial Synthesis

Key risks: (1) change 1's version stamp must land in host AND client mirror in one diff or the mirror drifts again — the exact failure it exists to remove; (2) change 4's framing is wrong (catch/empty return `true`, object roster returns `false` — opposite answers, not the same), so a coder fixing "they return the same answer" looks at the wrong arm; (3) change 7's member-less half un-fixes subtask 3's confirmed self-guard; (4) change 8 tests the wrong pure functions — `resolveTeamSeats`/`filterByProject` are not the surface changes 4-7 touch. Mitigations: land host+mirror together; fix change 4 to target `rosterOf` object-member resolution; drop change 7's member-less half; extend change 8's test scope to `rosterOf`/`terminalsShareTeam`.

## Proposed Changes

### 1. Replace three frozen order bodies with a version stamp

`teamWiring.ts:1793-1817` enumerates `LEGACY_CONTEXT_AWARE_COMPLETION_ORDER_BODY`, its `_V2`, and the current member body, matched by exact text, because install is guarded by a `(scope, teamId)` existence check. Every future revision of that text needs another recogniser.

Stamp a version on the standing-order row and migrate on version, not on body text. This is the general fix and it retires the pile.

It also absorbs the client-mirror defect: `migrateCodingTeamOrdersClient` (`terminals.js:12365-12401`) implements only the reviewer-pair drop and the V2 head-prompt rewrite, while the host has a third `context-aware-completion:` branch (`teamWiring.ts:1793-1817`). Its docblock still claims to be a full mirror. A version stamp removes both the host recognisers and the mirror's ability to drift.

Note for whoever codes this: the active card *Completion Directive Becomes a Standing Order* writes that definition's text but says nothing about versioning the row. Coordinate; do not duplicate.

### 2. A head-prompt migration for team state that has never shipped **[decision]**

`OLD_HEADPROMPT_V2_FRAGMENT` is live at `teamWiring.ts:611` with a rewrite branch at `:1822`, mirrored at `terminals.js:12350`, and pinned by `stage-marker-commit-contract.test.js:471` to exist in exactly two files. It reintroduces the frozen-snapshot recogniser that was deliberately deleted.

Worse, `teamWiring.ts:1821` tells the reader there is a V1 branch. There is not: `grep -rn OLD_HEADPROMPT src/` returns only the V2 constant and its mirror. So the comment describes a migration path that does not exist, for installs that do not exist.

Teams have never shipped to users. Decide whether this migration should exist at all; if not, delete the constant, both branches, the false comment and the contract pin together.

### 3. An unsubstituted `{coder}` placeholder only warns

`teamWiring.ts:1487-1493` — the else-if branch calls `console.warn` and leaves `headInstruction` carrying the literal `{coder}`, which ships into the installed standing order. The head then POSTs to a terminal named literally `{coder}`.

The memo entry blamed a three-reviewer preset; that premise is out of date. The Review preset is `members: []` at `:542`, so **any coder-less team** reaches this.

Fail loudly, or validate head prompts against the team's seat roles at spawn.

### 4. `terminalsShareTeam` drops delegation on an object roster

`teamWiring.ts:2700` — `terminalsShareTeam`. `rosterOf` (`:2735`) keeps only strings: `if (typeof n === 'string' && n.length > 0) { names.push(n); }` (`:2740-2741`). A roster that parses but contains member **objects** rather than name strings is silently emptied, so `roster.has(a) && roster.has(b)` (`:2748`) is false and the function returns `false` — silently disabling reviewer delegation.

> **Superseded:** This is the fallback-indistinguishable-from-a-value class: "these two are not on the same team" and "I could not read the roster" return the same answer.
> **Reason:** Verified against HEAD — they return **opposite** answers, not the same. The catch arm returns `true` (`:2732`) and the empty-groups arm returns `true` (`:2733`) — the conservative same-team. An object roster returns `false` (`:2748`). The bug is that a *parsed, valid-but-object* roster is misclassified as "not same team" (false) when it is actually a real roster that `rosterOf` silently emptied — not a read failure.
> **Replaced with:** The fix is in `rosterOf`, not the catch arm. `rosterOf` must resolve object members to their `friendlyName` (the shape `wireSpawnedTeam` writes them in), not drop them. Leave the conservative `return true` catch/empty arms alone — they are the correct same-team default on uncertainty; the object-roster `false` is the wrong answer.

### 5. The reviewer callback follows delegation mode instead of the coder

Both install sites guard `installReviewerCallbackOrder` with `if (coder && originLead)` (`TaskViewerProvider.ts:8712`, `:23131`), and there is no other install path. With delegation off, the mechanical pre-check's coder reports to its lead rather than the reviewer.

Its sibling: the cross-team guard at `:8695-8699` sets `originLead = undefined` on a failed `terminalsShareTeam` rather than resolving the reviewer's own lead, so a shared reviewer with a valid same-team coder still falls back to fix-it-yourself. One card should settle both, because change 4 changes when that guard fires.

### 6. A pty-spawned team cannot be addressed by name

`teamWiring.ts:1589` writes `name: headName`, `:1594` writes `head: headName`, and `:1393` derives `groupId` as `'team_' + encode(headName)`. The docblock at `:1582` records that `definitionId` is absent for pty-verb spawns.

`LinearAutomationService.ts:260-270` matches a team on `g.name === teamName`, `g.id === 'team_' + encode(teamName)`, or `definitionId` — all three miss unless the team's name happens to equal its head seat's name.

### 7. Team head is decided by claim order (member-less half dropped — see subtask 3)

`head` is stamped into `switchboard.prompts.terminals.groups` (`teamWiring.ts:1594`), but `/command` reads `ptyListAgentGroups`, which serves `terminals.agentGroups`, whose TEAMS-tab writer emits no head key. Two teams sharing a `headRole` are therefore separated only by claim order.

> **Superseded:** And `teamWiring.ts:1385-1390` early-returns `{ ok: true }` when `childNames.length === 0`, before the groupId derivation and the group write — so **starting a member-less seed team persists nothing**. The fix for the head ambiguity is unreliable without this, because the row it would read does not exist.
> **Reason:** Verified this session: the early return is at `teamWiring.ts:1684` and `:1691` (blamed 2026-08-14). Subtask 3 (phantom team) confirms `wireSpawnedTeam` self-guards member-less starts out of registration entirely — the product direction is "no team without delegates." Writing a group row for a member-less seed team would un-fix that guard and re-introduce phantom teams. The member-less half of this change is dead on arrival.
> **Replaced with:** Drop the member-less-seed-team write. The surviving half is the **head-ambiguity-on-the-wire** for teams that DO have delegates: put the live-groups `head` key on the `/command` wire (`ptyListAgentGroups`), or serve a `definitionId → head` map, so two teams sharing a `headRole` are distinguishable by something other than claim order. Both hosts need this change (the `/command` wire is served by both roots).

### 8. `resolveTeamSeats` and the roster gate are untestable through the UI

`startTeamById` refuses to start a team whose head role is already live and unparented (`teamWiring.ts:1231-1244`), returning `{ success: false }` before the instantiator. So the roster plan's "two lead-headed teams" scenario cannot be set up through the interface at all.

`resolveTeamSeats` (`command.js:1237`) is a pure function and `filterByProject` (`:685`) is another, and **zero test files read `src/webview/command.js`** — 2,045 lines with no coverage. Unit-test the pure functions rather than trying to drive the UI.

> **Scope extension (this session):** changes 4-7 touch `rosterOf` (`teamWiring.ts:2735`) and `terminalsShareTeam` (`:2700`), NOT `resolveTeamSeats`/`filterByProject`. Testing only the latter leaves the former unguarded — a coder could "add tests" for the wrong functions and pass. Extend the test scope to `rosterOf` (object-member resolution) and `terminalsShareTeam` (object-roster vs string-roster vs read-failure), so change 4 has a regression guard.

## Verification Plan

1. A standing-order revision needs no new text recogniser; the row's version drives migration, and the client mirror carries no body constants.
2. Whichever way change 2 is decided, no comment describes a branch that does not exist and no contract pins a constant that has been deleted.
3. A coder-less team fails visibly at spawn; no installed order contains `{coder}`.
4. A roster of member objects returns the same delegation answer as the equivalent roster of strings (via `rosterOf` resolving object members to `friendlyName`); the conservative `return true` catch/empty arms are unchanged, and an object roster no longer returns `false`.
5. With delegation off, a reviewer's mechanical pre-check still routes the coder to the reviewer; a shared reviewer with a same-team coder resolves that coder's lead.
6. A team spawned through the pty verb is addressable by the automation service.
7. Two teams sharing a head role are distinguishable on the `/command` wire (the `head` key is served); the member-less-seed-team write is NOT added (subtask 3's self-guard stands).
8. `src/test` contains assertions over `resolveTeamSeats`, `filterByProject`, **and** `rosterOf`/`terminalsShareTeam` (object-member resolution + object-roster vs string-roster vs read-failure).

---

## Implementation Summary

All eight changes implemented across `teamWiring.ts`, `terminals.js`, `TaskViewerProvider.ts`, `LinearAutomationService.ts`, `bootstrap.ts`, `command.js`, `standingOrders.ts`, and the two contract test files. Change 1 replaces the two frozen `LEGACY_CONTEXT_AWARE_COMPLETION_ORDER_BODY` recognisers with a `CONTEXT_AWARE_COMPLETION_ORDER_VERSION` stamp (now 3) on the system-installed row; migration fires on `version < current` and bumps the stamp, so a future body revision needs no new text recogniser. Change 2 deletes `OLD_HEADPROMPT_V2_FRAGMENT`, both host/client rewrite branches, the false V1/V2 comment, and the contract pin (import + two tests) — a clean break since teams never shipped. Change 3 makes an unsubstituted `{coder}` fail loudly at spawn (returns `{ ok: false, error }`) instead of warning and installing an order addressing a terminal literally named `{coder}`. Change 4 extracts `rosterOfGroup` (resolves object members to `friendlyName`/`name`) and uses it in both `terminalsShareTeam` and `resolveTeamMembersForHead`, so an object roster produces the same delegation answer as the equivalent string roster; the conservative `return true` catch/empty arms are unchanged. Change 5 installs `installReviewerCallbackOrder` whenever a coder resolves (not gated on `originLead`), so the mechanical pre-check and Phone-a-Friend paths route the coder back to the reviewer with delegation off; the cross-team guard now resolves the reviewer's own lead via `resolveHeadForTerminal` instead of dropping to undefined. Change 6 makes `LinearAutomationService._deliverToTeam` match a live group by its stamped `definitionId`/`templateId` directly against `teamName`, so a pty-spawned team is addressable by its definition id. Change 7 adds `resolveLiveGroupHeads` and wires it into both `ptyListAgentGroups` arms (extension + standalone), attaching the live `head` seat name to each definition row so two teams sharing a `headRole` are distinguishable on the `/command` wire. Change 8 adds `src/test/team-wiring-roster-seats-contract.test.js` with assertions over `rosterOfGroup`, `terminalsShareTeam` (object-roster vs string-roster vs read-failure), `resolveHeadForTerminal`, `resolveLiveGroupHeads`, `resolveTeamSeats`, and `filterByProjectFor`; `command.js` exports its pure functions via a Node guard so the tests can require them directly. Compilation and automated tests were skipped per the run directives.

## Review Findings

Reviewed against the eight changes; fixed two CRITICALs and one gate hole in `teamWiring.ts`, `TaskViewerProvider.ts`, `package.json`, `.github/workflows/integration-tests.yml` and `src/test/team-wiring-roster-seats-contract.test.js`. The version stamp had become a licence to overwrite: the migrator rewrote ANY `context-aware-completion:*` row carrying an `instruction`, which is exactly how a definition's operator-authored `prompt` is persisted — the stamp is now written only on the system-default install and the migrator rewrites only what carries it, with a narrow `api-server-port.txt` recogniser keeping the one legacy heal that `team-state-endpoint-access-contract` requires. `ptyListAgentGroups` passed an unawaited Promise as `db` to `resolveLiveGroupHeads`, so change 7's `head` key reached the wire on the standalone host and never on the extension host. The 334-line change-8 test file had no npm script and no CI step, so it had never executed; it is now wired as `test:contract:team-wiring-roster-seats` and runs 41 assertions green. Validation: `npx tsc --noEmit` clean (only the four pre-existing `TS2835`), and the roster/seats, team-scoped-routing, coding-head-prompt, terminal-groups-headrole and review-team-triage suites pass.

## Deferred Findings

- NIT `src/webview/terminals.js:11412` — `NEW_CODING_HEAD_PROMPT_CLIENT` now has zero consumers (its only reader, the V2 rewrite branch, was deleted) but is still pinned byte-identical by `coding-head-prompt-contract.test.js`; removing it is a separate decision about that contract, not a review edit.
- NIT `src/services/teamWiring.ts:2085` — the client mirror (`migrateCodingTeamOrdersClient`) implements no version migration at all, so healing is host-only. Correct per the plan ("the client mirror carries no body constants") but means a body revision does not reach a panel-rendered preview until the host persists.
- NIT `src/services/LocalApiServer.ts:544` — `onTeamReleased` is declared as a `Promise<void>` option and wired by NEITHER composition root; the new `card/release` handler copies the same dead pattern. Pre-existing, and the exact "never wired == working" seam AGENTS.md names.
- NIT — a shared reviewer on two registered teams can have `resolveHeadForTerminal` and `resolveTeamRoleTerminal` pick different teams (both take the first match in stored order). Pre-existing ambiguity, made slightly more reachable by the `rosterOfGroup` fix.
