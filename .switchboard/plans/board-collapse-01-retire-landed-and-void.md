# Board Collapse 01 — Retire the Landed and the Void

## Goal

Remove from New and Planned every card that describes work already on `main`, work whose plan file does not exist, or work whose premise a shipped commit has invalidated. This is the cheapest and most urgent slice: it is the set of cards that will actively mislead a coder who picks one up.

### Problem analysis

A full read of all 433 cards in New (`CREATED`) and Planned (`PLAN REVIEWED`) on 2026-09-03 found ten classes of stale card. Two carry explicit "DELIVERED — do not dispatch" or "OBSOLETE" banners inside the plan file and still sit in a dispatchable column. One card in New points at a plan file that never existed in git. Three plans instruct edits to a shell helper retired in `96fb16df`. Three plans reserve migration numbers V61, V65 and V66; the schema is at V67 and V66 is already the mission-milestones table. Several plans wait on a Database panel that shipped in `7d71ac56`. Three plans describe a standalone wiring gap that `cf57044b` closed.

Root cause: plan files are write-once-at-the-end and nothing re-reads them when a sibling lands. A card's column reflects where a human dragged it, never whether its content is still true.

## Execution rules

1. Card operations go through the board or `.agents/skills/kanban_operations/*.js`. **Never SQL.**
2. Rescoping edits a plan file in place. The plan id and filename are preserved; only the Goal and Proposed Changes shrink to what remains.
3. **No git working-tree operation** (checkout, stash, reset, pull) while this runs — the watcher re-imports and wipes board-only state. Commits are fine.
4. Deleting a card uses the board's delete path so the `.md` goes with it. Git carries the undo.
5. Add no new cards.

## Metadata

- **Complexity:** 3
- **Tags:** board-hygiene, plans, cleanup

## Proposed Changes

### 1. Move to Completed

- **Remove Retired-Mode UI Notices** (New). Plan file opens "DELIVERED — do not dispatch. Landed 2026-08-24 in `a42cad1f`". Its parent feature *Delete the Dead Paths* still says "three pure removals" — correct that line to two.
- **Agent Instruction Surface** and its three subtasks (Planned). The feature file's Review Findings record all three landed in order `f996edda`, `025de73c`, `d8f9c0b9`, with two reviewer passes and a new contract test wired at `package.json:907`.
- **The CLI board console is a one-shot prompt with 20 exits** (Planned). File ends with an Implementation Summary describing the looping console, `formatConsoleCard`/`compareConsoleCards` and `doDispatch` exit codes as done.

### 2. Delete

- **A queued card has no holder; only completed_at releases a team** (New, id `0023bf40`). `git log --all -- .switchboard/plans/a-queued-card-has-no-holder.md` returns nothing; the file has never existed. A Reviewed card carries the same title against a different file. Delete the New row.
- **`POST /kanban/move` Is Dead in Standalone — and 13 More `LocalApiServer` Options** (Planned). Verified at HEAD: `bootstrap.ts` now supplies `moveCard`, `onPhoneAFriend`, `clearTerminalContext`, `resolveTeamPacing` and `resolveTeamMembers`. Its one surviving idea — an option-supply parity assertion — is already owned by *A composition-root parity gate that actually fails*; add one line there recording that inheritance before deleting.

### 3. Rescope in place

Each edit is: correct the Goal, strike the step that has landed, and add a one-line note naming the commit that closed it.

- **Phone-a-Friend Never Reaches a PTY Fleet Seat** — drop "wire `onPhoneAFriend` in `bootstrap.ts`"; keep the fleet-first lookup and the port accessor fix.
- **The lead's acceptance post is the only thing that releases a seat** — drop step 1 (wire `clearTerminalContext` in the standalone root); keep the four silent no-ops and the `cleared:false` surfacing.
- **Mission Control cannot see teams over HTTP** — delete its appended "standalone does not wire `resolveTeamPacing`/`resolveTeamMembers`" finding; that is now false.
- **Add file-based IPC transport**, **No shipped Switchboard client sends an Authorization header**, **Three skills instruct agents to use POSIX-only tooling**, **Sandbox-Surviving Board Liveness via a Unix Domain Socket** — all four edit `.agents/skills/_lib/sb_api_call.sh`, deleted in `96fb16df`. Retarget every reference to `.agents/skills/_lib/cli-call.js`, through which all eight `kanban_operations` scripts now route. The auth-header plan shrinks to that one file and is noted as folding into *Out-of-process agents cannot authenticate to the standalone API*.
- **Cache plan write-sets in kanban.db** (V61), **The Plan Log Renders start/stop To Nobody** (V65), **Milestones — long-term goals that cards belong to** (V66) — replace each reserved number with "the next free migration version at implementation time". Delete the write-set plan's "if staging is dropped, renumber this to V60" instruction.
- **Both remaining subtasks of Storage Has One Home** — the Database panel shipped in `7d71ac56` and the Setup tab's DB section is retired. Retarget export/import and the corrected backup copy to the Database panel; delete "command palette entries are the user-facing path until the Database panel lands" and "Setup-panel copy is interim".
- **Dispatch-Analysis: board-mirror and write-set-cache subtasks** — both sequence behind `feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md`, retired and deleted when the real STAGING column landed in `52404992`. Remove the dependency and the `staged_at` references; anchor on the live STAGING column.
- **Partially landed, make the Goal match the remainder:** *A terminal you cannot see keeps streaming* (only the `isTerminalRendered` predicate remains; suspend/resume, `?lastSeq=` resume and the replay ring shipped in `a870fa8e`); *Tailnet Mode Accepts The Node's Own MagicDNS Names* (changes 1–6 implemented, only the IPv6 listener remains); *Feature Subtask Block Goes Invisible on Stale Feature File Read* (symptom (a) closed in `c8798b9c`, `3c5d671d`); *Ticket detail H1* (changes 4 and 5 already at HEAD); *Extract the kanban column-set derivation* (about 60% in the working tree, only the extraction remains); *The CLI is a peer control surface* (`switchboard api` landed in `96fb16df`).
- **Storage layer overhaul feature file** — "Recommends `node:sqlite`" contradicts its own subtask's DECIDED block. Change to `better-sqlite3`.
- **Document the storage topology, deployment modes and remote loop** — shrink to the two facts true today (the `agy` controller seat, the notification loop). Delete the trigger-line mechanism that schedules documentation for unshipped designs. "Four combinations" becomes three; the fourth was refused on 2026-09-01.

## Verification Plan

- Record New and Planned counts from `.switchboard/kanban-state-created.md` and `kanban-state-plan-reviewed.md` before and after. Expect about 8 fewer top-level cards.
- No active card in either column points at a missing file: for every `plan_file` in those columns, the path exists on disk.
- `grep -rl "sb_api_call" .switchboard/plans` returns nothing among active plans.
- `grep -rlE "V6[0-6]_SQL|migration V6[0-6]|takes V61" .switchboard/plans` returns nothing among active plans.
- No active plan in either column contains "DELIVERED — do not dispatch" or "OBSOLETE — do not dispatch".
- `git status` shows only `.switchboard/plans/**` and `.switchboard/features/**` changed. No `src/` changes.
