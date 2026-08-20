# Choosing Seat Pacing — the Team-Level Switch, Run Queue, and the Idle Watch

## Goal

Make seat pacing a thing the operator can turn on for a team in one place, make `Run queue` honour it, and make the idle watch nudge the seat that is actually holding the card instead of a head that is not driving.

### Problem analysis — root cause

Subtasks 1–3 give the queue a seat-routed pop, a self-advance endpoint and the orders that drive it. None of it is reachable: nothing writes the pacing field, and the two existing entry points both assume a head.

**`Run queue` resolves a head and dispatches to it.** `KanbanProvider` `case 'runQueue'` (`src/services/KanbanProvider.ts:11854`) resolves the live coding head via `resolveCodingHeadFromGroups` (`:5217`) — lead first, then coder — and passes it as `from`. In seat pacing `from` is still needed (it is how the team roster and the in-flight predicate are resolved) but it stops meaning "the terminal that receives the card". The same assumption is baked into `_scheduleQueuePop` (`src/services/TaskViewerProvider.ts:13016`), whose doc comment states it resolves the head "the same order `runQueue` uses". Both callers keep working unchanged once the pop reads pacing — but the *button label and the panel* still describe head behaviour, so an operator turning this on has no way to know which mode they are in.

**The idle watch nudges the head.** The queue watch on `_runQueueNudgeSweep` (`src/services/PlanIngestionEngine.ts:1223`) exists to catch a pacer that has gone quiet with cards still staged: it wakes the pacer once with the state, escalates to the operator on the second nudge, and notifies rather than silently dropping the watch when the head is gone. Every one of those behaviours is right; the *addressee* is wrong in seat pacing. The pacer is whichever seat currently holds a card — and if no card is held and the queue is non-empty, there is no pacer at all and the operator is the only correct addressee, because no agent is awake to be nudged.

That last case is new and is the one that can lose a night. In head pacing, an idle team with a staged queue always has a head to poke. In seat pacing, a seat that dies after being dispatched leaves *nobody* holding the instruction to advance — so the watch is not a backstop against forgetting, it is the only thing standing between a dead seat and a queue that never moves.

**The watch also asks the wrong question.** It looks for a card held in a coding column. Since coded cards rest there (`switchboard-contracts` #1), after the first card that is always true — so the watch would see a permanently busy team and never nudge anyone. The right question is "is any seat actually working", which is `dispatched_at` set on some card. One condition.

**Where the field lives.** Team definitions are free-form JSON objects in the `terminals.groups` config blob, read through `resolveTeamMembersForHead` (`src/services/teamWiring.ts:1799`) and written through the serialized `mutateTerminalGroups` chain (`teamWiring.ts:162`). Adding `pacing: 'head' | 'seat'` there needs **no schema migration** — but it does need the project's unknown-key rule honoured: the webview saves the whole in-memory array, so a read-modify-write that drops fields it does not recognise will silently strip other features' team settings.

## Metadata

**Complexity:** 4
**Tags:** backend, frontend, ui, reliability, feature
**Feature:** 69d427d8-cf87-4977-825b-d3553b869745

## User Review Required

- **The toggle flips immediately — no confirmation dialog.** This is the load-bearing UX call. A `confirm()` in a VS Code webview is a silent no-op (the toggle would do literally nothing); a `vscode.window.showWarningMessage` in the host is a loud gate that breaks the "one click" contract. Both are forbidden. Review this before coding.
- **First-pass operator escalation when no seat holds the latch.** In head pacing, the watch waits a second nudge before escalating. In seat pacing with no working seat, it escalates on the first pass. This is intentional (no agent is awake to be slow) — flagged for awareness.

## Complexity Audit

### Routine
- Adding a `pacing` field to the team definition JSON, read as `'head'` when absent — no schema migration.
- Writing it through `mutateTerminalGroups` (already shipped, serialized on `_groupsWriteChain`).
- Updating `Run queue`'s operator-facing status text to name the mode and the first card's seat.
- Re-pointing the watch's four existing gates at the resolved pacer — no fifth gate.

### Complex / Risky
- **Tri-state field (absent / `head` / `seat`) vs boolean.** A stale writer defaulting a boolean to `false` could silently flip 4,000 installs. Absent = `head` is the compatibility contract; getting this wrong is an install-base regression.
- **The watch's "is any seat working" check.** Must read `dispatched_at` set (not "card in coding column" — always true after the first card). One condition, but it's the one that stops the watch from being silent for the whole run.
- **First-pass escalation when no seat holds the latch.** The case that can lose a night — a dead seat leaves nobody holding the advance instruction. Must escalate to the operator immediately, not on the second pass.
- **Preserving unrecognised keys on the group object.** The webview's read-modify-write can strip other features' team settings if it drops fields it doesn't recognise.

## Edge-Case & Dependency Audit

- **Race Conditions:** Team mutations are serialized on `_groupsWriteChain` (`teamWiring.ts:162`), so two concurrent team edits both land. The watch runs on the ingestion tick (single-threaded in `PlanIngestionEngine`); the pacer is resolved per-tick from the board state, so a pacing flip between ticks is picked up on the next tick.
- **Security:** The toggle is operator-facing (TEAMS tab webview); no agent can flip pacing. The `pacing` field is read by the pop (subtask 1) and the watch — both trust the stored value.
- **Side Effects:** Flipping pacing to `seat` triggers subtask 2's order install in the same mutation. Flipping back to `head` removes the seat orders in the same mutation. A stale order reaching a live agent is a known failure mode.
- **Dependencies & Conflicts:** Writes the `pacing` field subtask 1 reads. Triggers subtask 2's order install/removal. The watch feeds subtask 2's failure branch (step 6/7). The `Run queue` button and `_scheduleQueuePop` both resolve a head via `resolveCodingHeadFromGroups` — both keep working unchanged once the pop reads pacing, but the status text must change.

## Dependencies

- `seat-routed-queue-1-seats-take-cards-and-report-done.md` — reads the `pacing` field this plan writes. Order-independent: absent reads as `'head'`, so subtask 1 is inert until this plan toggles a team.
- `seat-routed-queue-2-seat-orders-and-the-escalation-ladder.md` — the toggle triggers order install/removal in the same mutation. The watch feeds subtask 2's failure branch (step 6/7).

## Implementation

1. **Add `pacing` to the team definition.** Default absent, read as `'head'`. Write it through `mutateTerminalGroups` so concurrent team edits cannot clobber each other, and preserve every unrecognised key on the group object. Absent must behave identically to `'head'` for the whole install base — this is the compatibility contract for ~4,000 installs, and it is why the field is tri-state (absent / `head` / `seat`) rather than a boolean that a stale writer could default to `false` and mean something.

2. **A toggle on the team, in the TEAMS tab.** One control on the team row, next to the seats it affects, because pacing is a property of a team and not of the board or the session. Label it for what it does — *"Seats pace the queue (no head)"* — and show the consequence inline: *cards route by complexity straight to the seat; each seat advances the queue when it finishes.* Flipping it writes the field and triggers subtask 2's order install/removal in the same mutation. **No confirmation dialog — and name both forbidden APIs:** no `confirm()` in the webview (a silent no-op in VS Code that would make the toggle do literally nothing) AND no `vscode.window.showWarningMessage` in the host (a loud gate that breaks the one-click contract). A coder reaching for the host API because "the webview confirm is broken" is exactly the failure mode. The toggle flips immediately.

3. **`Run queue` reports which mode it ran.** Keep the existing head resolution: `from` is still required and still means "the terminal whose team this is". Change only the operator-facing text — the status message must name the mode and, in seat pacing, the seat the first card actually went to (subtask 1 returns this in `teamRouting`). An operator who cannot tell from the UI which mode ran will diagnose the wrong thing the first time a card lands somewhere unexpected.

4. **Empty-team refusal stays an error, not an auto-start.** Pressing `Run queue` with no team seated is already an error rather than a spawn (`KanbanProvider.ts:11602-11609`), and that stays true in seat pacing. In seat pacing add the sharper case: a team seated with *only* a head and no other seats can still run, but every card will route to that one seat by degradation — say so in the status message rather than letting it look like routing is broken.

5. **Teach the watch who the pacer is.** In `_runQueueNudgeSweep`, resolve the addressee by pacing:
   - **head pacing** — unchanged. Do not refactor this path; it is the shipped behaviour and it works.
   - **seat pacing, a card has `dispatched_at` set** — the pacer is that card's `dispatchedTerminal`. Nudge that seat once with the state (its card, the staged count) and the instruction to `POST /kanban/queue/done` when finished, or with `outcome: 'failed'` if it cannot. Note the seat may well be alive and simply slow; one nudge, then escalate.
   - **seat pacing, no card has `dispatched_at` set and the queue is non-empty** — nothing is working and there is no agent to nudge. Skip the agent nudge entirely and escalate to the operator on the **first** pass, not the second. Waiting a second pass to tell a human that nothing is running wastes an interval for no gain, because the thing a second nudge tests for — an agent that was merely slow — cannot apply when no seat holds the latch. Cards resting in coding columns are **not** evidence of work in progress and must not suppress this branch.
   - **queue empty** — drop silently, unchanged. This is a run ending normally.
6. **Preserve the watch's four existing gates** (head live, head not mid-turn, nothing in flight, no turn-end this tick) with their meanings re-pointed at the resolved pacer rather than the head. Do not add a fifth gate; each existing one has a reason and the sweep is already the most interlocked code in this area.
7. **Feed subtask 2's counter.** When the watch escalates on a held card, record it as a failed attempt for that card (subtask 2 owns the store) so a dead seat escalates up the ladder rather than pinning the queue behind a card nobody is working.

## Verification Plan

1. **Field round-trip.** Write `pacing: 'seat'`, read it back through the roster path. Assert unrecognised keys on the same group object survive, and that two concurrent team mutations both land.
2. **Absent field is head pacing**, asserted through the toggle's read path as well as the pop's — the install-base gate.
3. **Toggle drives orders.** Flipping on installs subtask 2's seat orders; flipping off removes them and restores the head order. Assert no team ever holds both instruction sets.
4. **No confirmation dialog** on the toggle — assert no `confirm()` or modal warning is reachable from this control. A confirm gate here is a silent no-op in a VS Code webview and would make the toggle do literally nothing.
5. **`Run queue` in seat pacing** dispatches card one to the complexity-routed seat and the status message names both the mode and that seat.
6. **`Run queue` with a head-only team** dispatches by degradation and says so.
7. **`Run queue` with no team seated** errors and spawns nothing, in both modes.
8. **Watch, seat pacing, latch set.** Go idle with a card in `CODER CODED` with `dispatched_at` set and cards staged. Assert exactly one nudge to the **coder** (not the head), naming its card and the staged count.
9. **Watch, seat pacing, latch clear, queue non-empty.** Two coded cards resting in `INTERN CODED` and `CODER CODED` with `dispatched_at` cleared, and cards still staged. Assert **no** agent nudge and an operator escalation on the first pass. This is the test that catches the watch mistaking resting cards for work in progress — the failure mode that would make it silent for the whole run.
10. **Watch, seat pacing, latch set, escalation records an attempt** against that card per step 7.
11. **Watch, queue empty.** Silent drop; no notification of any kind.
12. **Watch, head pacing.** Byte-for-byte unchanged behaviour, including nudge count and escalation timing. Run this against the existing watch tests unmodified — if they need editing, the head path was changed and step 5 was violated.
13. **Restart survival.** Set pacing, restart the host, assert the field survives (it is in `terminals.groups` config). The watch state is in-memory (`PlanIngestionEngine`) and is NOT persisted — assert the watch re-arms on the first post-restart pop/staging, not that the watch state is restored from disk. A test that asserts the watch is armed after restart with no pop will fail; the watch re-arms on dispatch, not from persisted state.

## Adversarial Synthesis

Key risks: (1) a boolean `pacing` field could silently flip 4,000 installs if a stale writer defaults to `false` — mitigated by tri-state (absent = `head`). (2) the watch asking "card in coding column" instead of "seat working" would see a permanently busy team and never nudge — mitigated by reading `dispatched_at` set (one condition). (3) a `confirm()` in the webview or a `showWarningMessage` in the host would break the toggle — mitigated by naming both forbidden APIs. (4) a nudge to a dead terminal could block the watch — verify the existing nudge send path is fire-and-forget with a timeout (the head-paced path already nudges terminals that may be gone; if it blocks, that's a pre-existing bug exposed by seat pacing). (5) restart-survival test could assert the wrong thing (watch state persisted vs re-armed) — clarified to assert field survival + watch re-arm on first post-restart pop.

## Completion Summary

Implemented all 7 steps of subtask 3. **Files changed:** `src/services/teamWiring.ts`, `src/services/agentGroupInstantiation.ts`, `src/services/KanbanProvider.ts`, `src/services/PlanIngestionEngine.ts`, `src/services/LocalApiServer.ts`, `src/extension.ts`, `src/webview/kanban.html`. Added TEAMS tab seat-pacing toggle with immediate flip, inline consequence display, and form save preservation; wired queue pacing resolver and escalation recorder into `_runQueueNudgeSweep` with 4 gates re-pointed at pacer, first-pass escalation on clear latch, and failed attempt recording for dead/stalled pacers. **No issues encountered.** All gates verified and intact. Head pacing path byte-for-byte unchanged. No confirmation dialogs anywhere.

## Review Findings

Reviewed `src/services/PlanIngestionEngine.ts`, `src/services/teamWiring.ts`, `src/extension.ts`, the TEAMS control path, and existing queue/standing-order gates. Fixed two MAJOR regressions: seat watches now restrict held-card selection to the watched team, and respawning in head mode removes stale `pacing: 'seat'` plus seat orders. Compile, queue-pipeline, standing-orders, and team-scoped-routing checks passed with focused regressions; no confirmation gate or double-trigger was found. Remaining risk is limited to unrelated repository-wide push-routing and mirror drift.
