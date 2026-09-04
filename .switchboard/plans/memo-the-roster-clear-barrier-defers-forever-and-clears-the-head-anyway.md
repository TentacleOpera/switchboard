# The Roster Clear Barrier Defers Forever, Clears the Head Anyway, and Measures Busy With a Hardcoded Window

## Goal

The barrier that decides which team seats may be cleared before a dispatch must reach a stable state: it must stop re-firing on every dispatch, must not clear the seat it is meant to exclude, and must decide "busy" from a value the operator can tune rather than a literal.

### Problem analysis

Nine reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and each verified against HEAD. They are one mechanism, and several are each other's cause. Filed together because fixing one without the others leaves the barrier in a different broken state rather than a working one.

The barrier lives in `TaskViewerProvider._ptyHostVerb` with a parallel implementation in `bootstrap.ts`. It exists so a roster clear never interrupts a seat mid-turn, and so a team's head is never wiped by a dispatch aimed at it.

**It does neither reliably.**

## Metadata

**Complexity:** 6
**Tags:** teams, dispatch, both-hosts, bugfix
**Project:** Browser Switchboard

## User Review Required

Two decisions are called out below and marked. Neither blocks the rest.

## Complexity Audit

### Routine
- Pruning the deferred set when the barrier clears a seat (finding 1).
- Gating the delivery-path `clearBeforePrompt: true` on the target not being the head (finding 2).
- Backfilling `head` in the member branch of `resolveTeamGroupForTerminal` (finding 3).
- Routing `triggerAction` through the barrier in standalone (finding 4).
- Adding a config seam for the liveness window in `LocalApiServer` (finding 5).

### Complex / Risky
- The re-fire gate (finding 1): recording the work-context key even when nothing was cleared could suppress a genuinely needed later pass. Proceeding on the assumption that recording unconditionally is correct — the re-fire is the worse failure (barrier runs forever on every dispatch).
- Legacy team rows with no `head` (finding 3): a read-time default is safer than a migration, since a migration can't reach rows that no longer exist in active use but may still be in settings files.
- The busy predicate (finding 6): `lastDataAt` cannot distinguish mid-turn from repainting. Must measure real idle CLI output before changing the predicate — a shorter window on a chatty CLI makes this worse.
- Standalone after-clear wiring (finding 7): adds a new call to `_deliverStandingOrdersAfterClear` from standalone's `clearTerminalContext`, which currently calls `relayStartupOrientation` instead. This is a composition-root wiring change — the exact class CLAUDE.md warns about.
- Clear vocabulary sweep (finding 8): documentation/skill-file change, not a barrier mechanism change. Deferrable.

## Edge-Case & Dependency Audit

**Race Conditions:** The deferred-set pruning (finding 1) and the same-feature intercept (`:847-850`) both mutate `_deferredClearsByTeam`. The pruning happens after the barrier clears; the intercept happens on the next same-context dispatch. No race — they're serialised by `teamPreparationChains`.

**Security:** No new surface — all changes are internal to the barrier and config plumbing.

**Side Effects:** Routing `triggerAction` through the barrier (finding 4) means a board-drag dispatch now runs the roster clear, which it didn't before. A board drag to a coder column could clear other coders' terminals. This is the correct behaviour (the barrier exists for this), but it's a visible change for standalone users who drag cards.

**Dependencies & Conflicts:**
- Sibling plan `the-curtain-is-armed-from-intent-not-from-a-clear-that-happened.md` step 2 excludes already-clean seats from `toClear`. This plan's finding 1 prunes the deferred set when a seat is cleared. They touch different output arrays of the same barrier call. Land the already-clean exclusion first (it reduces what enters `toClear`), then this plan's pruning (it cleans up `deferred`).
- Sibling plan `after-clear-standing-orders-block-is-a-taskless-prompt.md` owns the framing of the after-clear orders block. This plan's finding 7 wires standalone to call `_deliverStandingOrdersAfterClear` — without that wiring, the sibling plan's fix is extension-only. Finding 7 must land before or with the sibling plan.

## Dependencies

- `the-curtain-is-armed-from-intent-not-from-a-clear-that-happened.md` — step 2 (already-clean exclusion) should land first; this plan's finding 1 (deferred-set pruning) coordinates with it.
- `after-clear-standing-orders-block-is-a-taskless-prompt.md` — finding 7 wires the standalone after-clear delivery that the sibling plan's fix depends on. Finding 7 must land before or with the sibling plan.

## Adversarial Synthesis

Key risks: (1) nine findings in one plan is a mega-plan, but the inter-dependencies justify keeping them together — fixing one without the others leaves the barrier in a different broken state; (2) finding 7 overlaps with the sibling standing-orders plan — the wiring fix belongs HERE, and the sibling plan's framing fix applies to the shared method once wired; (3) finding 8 (clear vocabulary) is scope creep — it's a doc sweep, not a barrier fix, and should be deferred to a separate plan; (4) the two `[decision]` markers need stated assumptions for an unattended run. Mitigations: work findings in order (1→2→3→4→5→7, with 6 as measurement before 5, and 8 deferrable), own the standalone wiring here, defer finding 8, and state assumptions for both decisions.

## Proposed Changes

### 1. The deferred set is add-only, so the barrier re-fires forever

Names are added to `_deferredClearsByTeam` at `TaskViewerProvider.ts:900-905`, and the only removal is the same-feature intercept at `:847-850`. A seat the barrier itself later clears is never pruned.

Worse, the work-context key is written only when `toClear.length > 0 || deferred.length === 0` (`:978`). On a team whose only idle seat is the head, `toClear` is empty and `deferred` is not, so the key is never recorded and **the next dispatch re-runs the whole barrier** — permanently.

Remove from the set when the barrier clears a seat (call `dropDeferredClear` for each name in `toClear` after the clears complete), and decide the re-fire gate. **[decision]** Recording the key even when nothing was cleared is the obvious fix; proceeding on the assumption that this is correct — the re-fire is the worse failure (barrier runs forever on every dispatch), and a genuinely needed later pass would be triggered by a new work context key, not by the same one. Confirm that recording unconditionally does not suppress a genuinely needed later pass — if a seat becomes dirty after the barrier recorded the key, the next dispatch with the same work context key would skip the barrier, but the same-feature intercept at `:847-850` catches deferred seats, and a seat that was clean and becomes dirty is dispatched to (which writes a new `_lastWorkContextByTerminal` entry), so the barrier would fire on the next NEW work context. The assumption holds.

### 2. The delivery path clears the head the barrier just excluded

After `await prepPromise`, `clearBeforePrompt: true` is set unconditionally at `TaskViewerProvider.ts:988-990`, with the same shape at `bootstrap.ts:2350-2352`. A dispatch addressed to the head therefore wipes the head, which is exactly what the exclusion exists to prevent.

Gate the flag on the resolved target not being the excluded head: `if (clearEnabled && payload.name !== teamInfo.head)`. Apply the same gate in both hosts.

### 3. Legacy team rows carry no head, so the exclusion is inert for them

`resolveTeamGroupForTerminal`'s head branch derives `headId` (`workContextResolver.ts:132`) and defaults `head: headGroup.head || terminalName` (`:140`). The member branch at `:155` returns `head: g.head` raw. A team row written before `head` existed therefore has no head, and an idle lead on such a row is cleared mid-feature.

Backfill in the member branch the same way the head branch does: `head: g.head || terminalName` (where `terminalName` is the terminal being resolved, not a global default). **[decision]** Proceeding with a read-time default rather than a migration — a migration can't reach rows that no longer exist in active use but may still be in settings files, and the read-time default is the same pattern the head branch already uses. Establish whether such rows still exist in the wild before shipping; if they do, a migration can follow, but the read-time default is the fix that works regardless.

### 4. Standalone's board-drag dispatch runs no barrier at all

`bootstrap.ts:2636` calls `deliverPrompt` directly inside the `triggerAction` case, while the barrier lives in the `ptySendPrompt` case at `:2272-2341`. A card dragged on the board dispatches through a path with no roster protection on one host and full protection on the other.

This is a composition-root divergence with no gate. Route `triggerAction` through the same barrier — either by calling `handlePtyVerb('ptySendPrompt', ...)` from the `triggerAction` case after terminal resolution, or by extracting the barrier into a shared function both cases call. Add a source-text parity assertion so it cannot separate again.

### 5. "Busy" is a hardcoded 90-second window in a file with no config seam

`LocalApiServer.ts:5322` reads `const livenessWindowMs = 90000;` while `PlanIngestionEngine.ts:506`, `bootstrap.ts:2262` and `TaskViewerProvider.ts:882` all take `activityLight.livenessWindowMs` from configuration. `LocalApiServer` has no configuration accessor at all — grep for `getConfigNumber`, `getConfiguration` or `configProvider` in that file returns nothing.

The deliverable is the options-callback seam, with this literal as its first consumer. A tunable that three of four readers honour is not tunable. Wire a `livenessWindowMs` option into `LocalApiServer`'s options object (the same pattern the other three use), defaulting to 90000 for backward compatibility, and replace the literal at `:5322` with the option value.

### 6. The busy predicate cannot tell mid-turn from repainting

The window is applied to `lastDataAt`, so a lead whose CLI repaints a status line is permanently "busy", always deferred, and the barrier re-prepares on every dispatch. Recorded only as a Deferred Finding inside the already-landed `a-roster-clear-must-not-interrupt-a-seat-mid-turn.md`, which is not an active card.

**Measure before changing.** Sample real idle CLI output for each seat family before choosing a new predicate; a shorter window on a chatty CLI makes this worse rather than better. The measurement must produce a decision criterion: "for CLI family X, idle output arrives at interval Y, so the predicate should be `now - lastDataAt > max(Y * 2, livenessWindowMs)`" or similar. A measurement with no decision criterion is a ritual, not a guard.

### 7. Two hosts, two after-clear behaviours

`bootstrap.ts:3344`'s `clearTerminalContext` ends with `relayStartupOrientation([terminalName])`, where the extension's equivalent calls `_deliverStandingOrdersAfterClear` (`TaskViewerProvider.ts:11327`, `:11372`).

This corrects the scope of the sibling card *The after-clear standing-orders block is a task-less prompt*, whose plan stated that standalone "reaches this method through its own bootstrap path" and needs no wiring change. That is false — **the wiring fix belongs HERE.** Add a call to `_deliverStandingOrdersAfterClear` (or its standalone equivalent) from standalone's `clearTerminalContext`, replacing or augmenting the `relayStartupOrientation` call. The sibling plan's framing fix then applies to both hosts.

The standalone host does not have a `TaskViewerProvider` instance with `_deliverStandingOrdersAfterClear`. The wiring must either: (a) call through the `taskViewerProvider` reference that standalone already holds (if it exposes the method), or (b) extract the delivery logic into a shared function both hosts can call. Prefer (b) — it avoids adding a new cross-host method dependency.

### 8. Two clear vocabularies, split by audience

`KanbanProvider.ts:5946` and `:5950` teach leads `ptyClearTerminal`, and `terminals.js:9854/9989/10017` POST it directly, while `.agents/workflows/switchboard.md:82` and both Mission Control skills name `POST /terminals/clear` as canonical. The shipped clear-endpoint plan scoped its doc changes to three skill files only.

Settle on one and sweep both audiences. **Deferrable** — this is a documentation/skill-file sweep, not a barrier mechanism change. Recommend splitting to a separate plan so it doesn't block the barrier fixes.

## Verification Plan

### Automated Tests

1. Dispatch twice in a row to a team whose only idle seat is the head. The barrier prepares once, not twice; the work-context key is recorded after the first.
2. Dispatch to a team head. The head is not cleared.
3. A team row with no `head` key resolves an excluded head through the member branch.
4. Drag a card to a coder column on **both** hosts. Both run the roster barrier; a source-text parity assertion covers it.
5. `grep -n "90000" src/services/LocalApiServer.ts` returns nothing; the window comes from configuration and changing the setting changes the behaviour.
6. The idle-output measurement is recorded in the plan before any predicate change lands.
7. The after-clear card carries the correction from change 7 — standalone's `clearTerminalContext` calls the standing-orders delivery, not just `relayStartupOrientation`.
8. One clear vocabulary appears in lead-facing and agent-facing text (deferrable — finding 8).

### Goal Invariants

- `dropDeferredClear` is called for each name in `toClear` after the barrier clears complete (extension: `TaskViewerProvider.ts`, standalone: `bootstrap.ts`).
- The work-context key is recorded unconditionally after the barrier runs (not gated on `toClear.length > 0 || deferred.length === 0`).
- `clearBeforePrompt: true` at `TaskViewerProvider.ts:988-990` and `bootstrap.ts:2350-2352` is gated on `payload.name !== teamInfo.head`.
- `resolveTeamGroupForTerminal` member branch at `workContextResolver.ts:155` returns `head: g.head || terminalName`, not `head: g.head` raw.
- `bootstrap.ts` `triggerAction` case calls through the roster barrier, not `deliverPrompt` directly.
- `LocalApiServer.ts:5322` does NOT contain the literal `90000` — the value comes from a config option.
- `bootstrap.ts` `clearTerminalContext` calls a standing-orders delivery function, not just `relayStartupOrientation`.

**Recommendation:** Complexity 6 → Send to Coder. Work findings in order: 1→2→3→4→5→7, with 6 as a measurement before 5, and 8 deferrable to a separate plan.
