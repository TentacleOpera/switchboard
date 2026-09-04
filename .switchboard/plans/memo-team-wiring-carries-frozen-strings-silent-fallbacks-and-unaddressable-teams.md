# Team Wiring Carries Frozen String Piles, Silent Fallbacks, and Teams Nothing Can Address

## Goal

`teamWiring.ts` and its client mirror must stop accumulating frozen copies of prompt text, stop degrading silently when a roster is not the shape they expect, and record enough about a started team that other subsystems can address it.

### Problem analysis

Eleven reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. They share one file and one root cause: the module identifies things by **exact text or by name**, so every revision adds a recogniser and every unexpected shape falls through to a default.

Two of them are the codebase's own named failure mode — a fallback indistinguishable from a real value.

## Metadata

- **Complexity:** 6
- **Tags:** teams, prompts, both-hosts, bugfix

## User Review Required

Change 2 is an author decision. The rest are defects.

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

`teamWiring.ts:2398-2414` — `rosterOf` keeps only strings. The conservative `return true` covers "no db or settings", a thrown read, and zero groups. A roster that parses but contains member **objects** rather than name strings falls through to `return false`, silently disabling reviewer delegation.

This is the fallback-indistinguishable-from-a-value class: "these two are not on the same team" and "I could not read the roster" return the same answer.

### 5. The reviewer callback follows delegation mode instead of the coder

Both install sites guard `installReviewerCallbackOrder` with `if (coder && originLead)` (`TaskViewerProvider.ts:7965`, `:22274`), and there is no other install path. With delegation off, the mechanical pre-check's coder reports to its lead rather than the reviewer.

Its sibling: the cross-team guard at `:7959-7963` and `:22268-22273` sets `originLead = undefined` on a failed `terminalsShareTeam` rather than resolving the reviewer's own lead, so a shared reviewer with a valid same-team coder still falls back to fix-it-yourself. One card should settle both, because change 4 changes when that guard fires.

### 6. A pty-spawned team cannot be addressed by name

`teamWiring.ts:1589` writes `name: headName`, `:1594` writes `head: headName`, and `:1393` derives `groupId` as `'team_' + encode(headName)`. The docblock at `:1582` records that `definitionId` is absent for pty-verb spawns.

`LinearAutomationService.ts:260-270` matches a team on `g.name === teamName`, `g.id === 'team_' + encode(teamName)`, or `definitionId` — all three miss unless the team's name happens to equal its head seat's name.

### 7. Team head is decided by claim order, and a seed team is not recorded at all

`head` is stamped into `switchboard.prompts.terminals.groups` (`teamWiring.ts:1594`), but `/command` reads `ptyListAgentGroups`, which serves `terminals.agentGroups`, whose TEAMS-tab writer emits no head key. Two teams sharing a `headRole` are therefore separated only by claim order.

And `teamWiring.ts:1385-1390` early-returns `{ ok: true }` when `childNames.length === 0`, before the groupId derivation and the group write — so **starting a member-less seed team persists nothing**. The fix for the head ambiguity is unreliable without this, because the row it would read does not exist.

Both hosts need the change: either put the live-groups key on the wire, or serve a `definitionId → head` map.

### 8. `resolveTeamSeats` and the roster gate are untestable through the UI

`startTeamById` refuses to start a team whose head role is already live and unparented (`teamWiring.ts:1231-1244`), returning `{ success: false }` before the instantiator. So the roster plan's "two lead-headed teams" scenario cannot be set up through the interface at all.

`resolveTeamSeats` (`command.js:1237`) is a pure function and `filterByProject` (`:685`) is another, and **zero test files read `src/webview/command.js`** — 2,045 lines with no coverage. Unit-test the pure functions rather than trying to drive the UI.

## Verification Plan

1. A standing-order revision needs no new text recogniser; the row's version drives migration, and the client mirror carries no body constants.
2. Whichever way change 2 is decided, no comment describes a branch that does not exist and no contract pins a constant that has been deleted.
3. A coder-less team fails visibly at spawn; no installed order contains `{coder}`.
4. A roster of member objects returns the same delegation answer as the equivalent roster of strings, and an unreadable roster is distinguishable from a genuine "not shared".
5. With delegation off, a reviewer's mechanical pre-check still routes the coder to the reviewer; a shared reviewer with a same-team coder resolves that coder's lead.
6. A team spawned through the pty verb is addressable by the automation service.
7. Starting a member-less team writes a group row; two teams sharing a head role are distinguishable on the `/command` wire.
8. `src/test` contains assertions over `resolveTeamSeats` and `filterByProject`.
