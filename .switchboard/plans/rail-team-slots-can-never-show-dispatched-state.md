# Rail Team Slots Can Never Show Dispatched State

## Goal

Make a head-only team resolvable on the rail, so its slot can show dispatched state instead of a hardcoded empty.

### Problem analysis

`wireSpawnedTeam` returns `{ ok: true }` at `teamWiring.ts:1382` when `children` is empty, so the three default member-less teams register no `terminals.groups` row.

`buildTeamsForShell` (`terminals.js:1927-1934`) then emits `dispatched`, `groupId` and `queueDepth` as `false`, `null` and `0` whenever `liveGroup` is absent. So for those teams the rail is not showing 'nothing dispatched' — it is showing a value it never had, and cannot distinguish the two.

Related to the seed-team finding in the team-wiring work; check that before implementing.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 4
**Tags:** bugfix, ui

## User Review Required

**Yes — one decision:** register a group row for head-only teams, or resolve the queue by head name. The first changes what a team *is*; the second changes only the lookup.

## Proposed Changes

### `teamWiring.ts:1382` and `terminals.js:1927-1934`
- **Logic:** apply the recorded decision.
- **Edge case:** whichever branch, absent state must be distinguishable from empty state — the current `false/null/0` is the defect, not the display.

## Verification Plan

### Goal Invariants

1. For a head-only team, `dispatched`/`groupId`/`queueDepth` reflect real state, or are rendered as unknown. *(Paired: a team with members is unaffected.)*
