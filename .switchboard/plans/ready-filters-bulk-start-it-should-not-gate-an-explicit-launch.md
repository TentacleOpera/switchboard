# The ready flag gates the Launch button, turning an explicit mission start into a two-click pattern

## Goal

Stop `mission.ready` from disabling Launch on a mission the user has explicitly selected. `ready` is a
**filter for bulk and unattended start** — "start available missions", the `start-ready-mission`
schedule action — not a precondition for starting one on purpose.

### Problem Analysis

**The gate is one line, and it is UI-only.** `src/webview/mission-control.js:205`:

```js
_setEnabled('mc-launch', !!m && m.ready && status === 'not-started');
```

So a mission you have selected cannot be launched until you first click *mark ready*
(`mc-ready-mission`, enabled at `:208` precisely when `!m.ready`). Two clicks, in order, to do one
intentional thing.

**The backend does not agree with the UI.** `launchMission` (`KanbanProvider.ts:14496`) guards on:
database available, mission exists, **has at least one member**, `runState !== 'in-flight'`,
`runState !== 'completed'`. There is **no `ready` check**. The service layer already implements the
intended behaviour — an explicit launch of a specific mission succeeds regardless of the flag. Only the
button disagrees.

**What `ready` is actually for.** It is the human's arming flag for *unattended* start, and every other
reader treats it that way: the READY badge (`:112`), the mark-ready control (`:208`, `:456`), and the
`start-ready-mission` schedule action (`:28`, *"Start a ready mission"*). Those uses are correct and
stay. Filtering which missions a schedule or a bulk "start available missions" command may pick up is a
real job. Gating a hand-picked launch is a second job it acquired by accident, and the first job works
whether or not the second exists.

**It is the shape `CLAUDE.md` prohibits.** *"NEVER add confirmation dialogs. NO EXCEPTIONS… no
two-click patterns."* This is not a `confirm()` — `ready` has an independent purpose, so it is not a
pure confirm gate — but its use at `:205` is a deliberate extra click standing between the user and an
action on an item they have already selected, with no backend requirement behind it. That is the
pattern the rule exists to remove.

### Root Cause

One flag, two readers, one of them wrong. `ready` answers *"may an unattended process start this?"*
The Launch button asked it *"may the user start this?"* — a different question with a different
answer, and nothing in the service layer ever asked it.

### Non-goals

- **Not removing `ready`.** The badge, the mark-ready control, and the schedule action all keep it.
- **Not changing `launchMission`.** It is already correct.
- **Not touching `runState`.** It is derived from member cards and never persisted
  (`KanbanDatabase.ts:11306`); nothing here writes a status.

## Metadata

**Complexity:** 2
**Tags:** bugfix, ui, ux
**Feature:** 73ebf150-50f9-4e8f-b9db-58af49202c6a

## User Review Required

**No.** No open questions. The fix is a one-line predicate change; the optional change 3 is a UX refinement, not a decision that gates the work.

## Complexity Audit

### Routine
- Dropping the `ready` term from the Launch predicate at `src/webview/mission-control.js:205` — one line.
- Leaving `mc-ready-mission`, the READY badge, and the `start-ready-mission` schedule action untouched.

### Complex / Risky
- **Change 3 (optional) must mirror `launchMission`'s member set.** If the no-members disabled state is taken, the UI predicate must compute members as `[...(plans || []), ...(features || [])]` — exactly `KanbanProvider.ts:14571`. A `plans`-only check would light up Launch for a feature-only mission and then fail at the backend, moving the lie from `ready` to `plans`-only.
- None otherwise — the headline fix has no design surface.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `updateMissionControls` runs synchronously on selection/render; `launchMission` is a separate call.
- **Security:** None.
- **Side Effects:** None beyond the intended one — an unready mission with members becomes launchable. `ready`'s real job (filtering unattended/bulk start) is untouched (verification 2).
- **Dependencies & Conflicts:** None. Independent of the other three subtasks; ships at any point. No shared file writes (`mission-control.js:205` is touched only here).

## Dependencies

- **None.** Independent one-line fix with no upstream or downstream coupling to the front-door, run-sheet, or supervision subtasks. May ship at any point.

## Adversarial Synthesis

Key risk: if the optional change 3 (disable on no-members) is taken, the UI predicate must compute members as `plans ∪ features` matching `launchMission` exactly, or a feature-only mission shows Launch enabled and then fails at the backend. Mitigation: state the member-set computation explicitly in change 3, or leave change 3 untaken. The headline fix (drop `ready`) is sound and needs no further work.

## Proposed Changes

1. **Drop the `ready` term from the Launch predicate** at `src/webview/mission-control.js:205`:

   ```js
   _setEnabled('mc-launch', !!m && status === 'not-started');
   ```

   `status === 'not-started'` stays — launching an in-flight or completed mission is meaningless and
   `launchMission` rejects both anyway, so the button should match.

2. **Leave `mc-ready-mission` as it is** (`:208`). Marking ready remains available and still means
   "this may be started unattended". It simply stops being a prerequisite for a manual launch.

3. **Consider surfacing the real precondition instead.** `launchMission` refuses with *"Mission has no
   members to launch."* That is the condition that genuinely blocks a launch, and it is currently
   invisible until the user clicks. If a disabled state is wanted, disable on **no members**, not on
   `!ready` — a gate that reflects a real backend guard rather than inventing one.

4. **Do not add the gate to the MCP surface.** `mission_update` may set `ready`; nothing in
   `switchboard_dispatch` or a future mission-launch tool may require it. Recorded here so the tool
   surface does not reimplement the bug it is being fixed out of.

## Verification Plan

1. **An unready mission launches.** Create a mission with `ready = 0` and at least one member, select
   it, and assert Launch is enabled and succeeds. This is the reported behaviour and must fail against
   the current tree.
2. **`ready` still filters unattended start.** Assert the `start-ready-mission` schedule action picks
   up a `ready` mission and skips an unready one. The flag's real job must be untouched — a fix that
   makes `ready` inert has removed a feature, not a gate.
3. **The badge and the mark-ready control still work.** Assert the READY badge renders for
   `ready = 1`, and that `mc-ready-mission` is offered exactly when `!m.ready && not-started`.
4. **In-flight and completed stay disabled.** Assert Launch is disabled for both, matching
   `launchMission`'s own guards rather than duplicating a different rule.
5. **No members is the only remaining hard block.** Assert a member-less mission fails with *"Mission
   has no members to launch."* — and, if change 3 is taken, that the button is disabled for that
   reason and no other.
6. **Both hosts.** `mission-control.js` is served to the extension webview and to standalone via
   `headlessPanelHtml.getMissionControlHtml` (`headlessPanelHtml.ts:233`), so a single edit covers
   both — assert the standalone-served panel carries the same predicate rather than assuming it.

### Goal Invariants

- **`ready` is absent from the `mc-launch` enable predicate** at `src/webview/mission-control.js:205`
  (negative — the gate is gone from the place the goal says it should not be).
- **An unready mission with at least one member has Launch enabled** when `status === 'not-started'`
  (positive — the explicit-launch path works regardless of the flag).
- **`ready` still gates `start-ready-mission` and `mc-ready-mission`** (positive — the flag's real
  job survives in the readers that should keep it).
