# The Roster Clear Barrier Defers Forever, Clears the Head Anyway, and Measures Busy With a Hardcoded Window

## Goal

The barrier that decides which team seats may be cleared before a dispatch must reach a stable state: it must stop re-firing on every dispatch, must not clear the seat it is meant to exclude, and must decide "busy" from a value the operator can tune rather than a literal.

### Problem analysis

Nine reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and each verified against HEAD. They are one mechanism, and several are each other's cause. Filed together because fixing one without the others leaves the barrier in a different broken state rather than a working one.

The barrier lives in `TaskViewerProvider._ptyHostVerb` with a parallel implementation in `bootstrap.ts`. It exists so a roster clear never interrupts a seat mid-turn, and so a team's head is never wiped by a dispatch aimed at it.

**It does neither reliably.**

## Metadata

- **Complexity:** 6
- **Tags:** teams, dispatch, both-hosts, bugfix

## User Review Required

Two decisions are called out below and marked. Neither blocks the rest.

## Proposed Changes

### 1. The deferred set is add-only, so the barrier re-fires forever

Names are added to `_deferredClearsByTeam` at `TaskViewerProvider.ts:900-905`, and the only removal is the same-feature intercept at `:846-853`. A seat the barrier itself later clears is never pruned.

Worse, the work-context key is written only when `toClear.length > 0 || deferred.length === 0` (`:978`). On a team whose only idle seat is the head, `toClear` is empty and `deferred` is not, so the key is never recorded and **the next dispatch re-runs the whole barrier** — permanently.

Remove from the set when the barrier clears a seat, and decide the re-fire gate. **[decision]** Recording the key even when nothing was cleared is the obvious fix; confirm that does not suppress a genuinely needed later pass.

### 2. The delivery path clears the head the barrier just excluded

After `await prepPromise`, `clearBeforePrompt: true` is set unconditionally at `TaskViewerProvider.ts:987-990`, with the same shape at `bootstrap.ts:2325`. A dispatch addressed to the head therefore wipes the head, which is exactly what the exclusion exists to prevent.

Gate the flag on the resolved target not being the excluded head.

### 3. Legacy team rows carry no head, so the exclusion is inert for them

`resolveTeamGroupForTerminal`'s head branch derives `headId` (`workContextResolver.ts:132`) and defaults `head: headGroup.head || terminalName` (`:140`). The member branch at `:155` returns `head: g.head` raw. A team row written before `head` existed therefore has no head, and an idle lead on such a row is cleared mid-feature.

Backfill in the member branch the same way the head branch does. **[decision]** Establish whether such rows still exist in the wild before deciding between a read-time default and a migration.

### 4. Standalone's board-drag dispatch runs no barrier at all

`bootstrap.ts:2610` calls `deliverPrompt` directly inside the `triggerAction` case, while the barrier lives in the `ptySendPrompt` case at `:2337-2346`. A card dragged on the board dispatches through a path with no roster protection on one host and full protection on the other.

This is a composition-root divergence with no gate. Route `triggerAction` through the same barrier, and add a source-text parity assertion so it cannot separate again.

### 5. "Busy" is a hardcoded 90-second window in a file with no config seam

`LocalApiServer.ts:5322` reads `const livenessWindowMs = 90000;` while `PlanIngestionEngine.ts:506`, `bootstrap.ts:2231` and `TaskViewerProvider.ts:877` all take `activityLight.livenessWindowMs` from configuration. `LocalApiServer` has no configuration accessor at all — grep for `getConfigNumber`, `getConfiguration` or `configProvider` in that file returns nothing.

The deliverable is the options-callback seam, with this literal as its first consumer. A tunable that three of four readers honour is not tunable.

### 6. The busy predicate cannot tell mid-turn from repainting

The window is applied to `lastDataAt`, so a lead whose CLI repaints a status line is permanently "busy", always deferred, and the barrier re-prepares on every dispatch. Recorded only as a Deferred Finding inside the already-landed `a-roster-clear-must-not-interrupt-a-seat-mid-turn.md`, which is not an active card.

**Measure before changing.** Sample real idle CLI output for each seat family before choosing a new predicate; a shorter window on a chatty CLI makes this worse rather than better.

### 7. Two hosts, two after-clear behaviours

`bootstrap.ts:3294`'s `clearTerminalContext` ends at `:3318` with `relayStartupOrientation`, where the extension's equivalent calls `_deliverStandingOrdersAfterClear` (`TaskViewerProvider.ts:11327`, `:11372`).

This corrects the scope of the active card *The after-clear standing-orders block is a task-less prompt*, whose plan states at lines 146-147 that standalone "reaches this method through its own bootstrap path" and needs no wiring change. That is false. Record the correction on that card rather than duplicating its work.

### 8. Two clear vocabularies, split by audience

`KanbanProvider.ts:5946` and `:5950` teach leads `ptyClearTerminal`, and `terminals.js:9854/9989/10017` POST it directly, while `.agents/workflows/switchboard.md:82` and both Mission Control skills name `POST /terminals/clear` as canonical. The shipped clear-endpoint plan scoped its doc changes to three skill files only.

Settle on one and sweep both audiences.

## Verification Plan

1. Dispatch twice in a row to a team whose only idle seat is the head. The barrier prepares once, not twice; the work-context key is recorded after the first.
2. Dispatch to a team head. The head is not cleared.
3. A team row with no `head` key resolves an excluded head through the member branch.
4. Drag a card to a coder column on **both** hosts. Both run the roster barrier; a source-text parity assertion covers it.
5. `grep -n "90000" src/services/LocalApiServer.ts` returns nothing; the window comes from configuration and changing the setting changes the behaviour.
6. The idle-output measurement is recorded in the plan before any predicate change lands.
7. The after-clear card carries the correction from change 7.
8. One clear vocabulary appears in lead-facing and agent-facing text.
