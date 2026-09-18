# A roster clear must not interrupt a seat that is mid-turn

## Goal

The once-per-feature-run roster barrier must skip seats that are working, and must never clear the terminal that issued the dispatch. Today it clears every active roster member except the destination — which reliably includes the team lead, usually while the lead is mid-turn, and usually because the lead itself made the call.

### The problem

Observed 2026-08-28 on the standalone host. The `Coding` team lead dispatched subtask 1 to `Coding-coder-1` via `POST /terminals/verb/ptySendPrompt`. Its own terminal log then shows, while the lead was still executing:

```
⠸⠀ Running tools · 44s (esc twice to interrupt)
── 1 queued ─────────────────────────────── ↑ edit · ↵ send now ──
○ /clear
```

Devin queued the `/clear` and would apply it the moment the turn ended. The lead had a todo list, three subtask assignments, and dispatch state in context; all of it was scheduled for deletion by an operation the lead triggered itself, in the middle of triggering it.

The `/clear` is not wrong in principle — a new feature run genuinely should reset the roster. It is wrong in its target set and its timing.

### Root cause

`TaskViewerProvider.ts:735` (extension host), mirrored at `bootstrap.ts:1971` (standalone):

```ts
const activeMembers = roster.filter(name => liveActiveNames.has(name) && name !== payload.name);
```

The exclusion set has exactly one member: the dispatch **destination**. Two things are missing.

1. **No origin exclusion.** `payload.name` is where the prompt is going, never who asked. When the lead calls `ptySendPrompt` for a coder, the lead is a roster member, is not the destination, and is therefore cleared. The comment above the line reasons carefully about why the destination is excluded ("it is about to receive a prompt, so its clear belongs to the delivery path") and does not consider the caller at all.

2. **No busy check.** `liveActiveNames` is built from `ptyListTerminals` rows with `status === 'active'`, which means the pty exists — not that the seat is at rest. `clearTerminalContext` writes `/clear` into whatever state the CLI is in. Every CLI in the fleet buffers it: Devin queues it visibly, Claude Code leaves it on the input line, and the effect lands at the next turn boundary rather than being rejected.

The rule the barrier should be honouring is already written down and already delivered to agents — the Coding head prompt says *"Clear a terminal only when at rest (completion received AND next work goes elsewhere)."* The host does not apply its own rule to its own clear.

### Why this is not the atomic-team plan's design being wrong

`atomic-team-feature-run-context-lifecycle.md` (CODE REVIEWED, 2026-08-25) built the barrier deliberately, and its review narrowed the target set from "every active member including destination" to siblings-only. That narrowing was correct as far as it went. The caller and the busy state are a third and fourth consideration that neither the plan nor its review raised — this plan adds them rather than reversing anything.

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, reliability

## User Review Required

None.

## Complexity Audit

### Routine

- Threading an origin identity into the barrier decision — `ptySendPrompt` callers that are agents already authenticate, and the concept of origin identity already exists on sibling endpoints: `POST /kanban/queue/done` carries an explicit `from` field (the reporting seat's terminal name), and `POST /kanban/dispatch` derives the origin from the plan record's `dispatched_terminal` via `plausibleOriginTerminal` (`teamWiring.ts:2246`). Neither is a wire field on `ptySendPrompt` itself — this plan adds one.
- Adding a predicate to the `activeMembers` filter in two composition roots.

### Complex / Risky

- **Two hosts, one behaviour.** `TaskViewerProvider.ts:735` and `bootstrap.ts:1971` are hand-mirrored today. A fix in one is a divergence, and the standalone-parity gate is scoped to the browser read-back path, not the composition root. The filter predicate must move into a shared pure helper that both roots import — `workContextResolver.ts` already holds `resolveTeamGroupForTerminal` and is the natural home.
- **"Busy" signal — resolved.** The fleet tracks `status: 'active' | 'exited'` (process liveness), but the per-seat turn-level signal already exists and IS readable synchronously from inside the barrier in both hosts: `lastDataAt` (ms epoch of the most recent PTY output byte), stamped by `PtyFleetService.create`'s `onData` subscription (`ptyFleetService.ts:469`). The standalone barrier already calls `ptyFleetService.listActive()` (`bootstrap.ts:1965`), whose handles carry `lastDataAt` (`ptyFleetService.ts:103`). The extension barrier already calls `ptyListTerminals` (`TaskViewerProvider.ts:726`), whose rows carry `lastDataAt` (`ptyHost.ts:180`). The busy predicate is `now - lastDataAt < livenessWindowMs` (default 90s, `PlanIngestionEngine.ts:541`) → recently emitting → mid-turn → defer. A seat with `lastDataAt === 0` (no heartbeat data) is NOT at rest — it is unknown, and the barrier must defer it, matching the sweep's own `lastDataAt > 0` guard (`PlanIngestionEngine.ts:595`). This was the plan's main open design decision; verification against the source confirms the preferred candidate (the PTY turn-end output-silence detector) works without new infrastructure.
- **Deferring a clear is not the same as skipping it.** A busy seat that is skipped keeps stale context for the whole next feature run. The barrier's whole purpose is that the roster starts clean. A skipped seat needs to be cleared when it *does* come to rest, which means the barrier acquires a deferred-work concept it does not have today.
- **The origin is not always supplied.** `ptySendPrompt` has no `from` field. Board-driven dispatch has no agent origin at all (the operator dragged a card), and there the current behaviour is correct — clear the whole roster. The predicate must treat "no origin" as "exclude nobody", not as "exclude everybody".

## Edge-Case & Dependency Audit

| Case | Required behaviour |
|---|---|
| Operator drags a card into the team (no origin) | Clear all active siblings, as today |
| Lead dispatches to its own coder | Lead excluded as origin; other siblings cleared |
| Lead dispatches to a seat on a *different* team | Origin exclusion is scoped to the resolved roster; a non-member origin is a no-op exclusion |
| Origin names a terminal that is not on the roster | Ignore — never widen the roster from caller-supplied data |
| Seat is busy and is also the destination | Already excluded; delivery path owns its clear |
| Seat is busy and not the origin | Deferred, not skipped — see Proposed Changes 4 and 7 |
| Seat has `lastDataAt === 0` (no heartbeat) | Deferred — "no evidence" is not "at rest"; matches the sweep's `lastDataAt > 0` guard |
| Every roster member is busy | Barrier completes having cleared nobody; the work-context key must NOT be recorded, or the run is marked prepared when it was not |
| `terminal.clearBeforePrompt` is off | Unchanged — no clears for anyone, key recorded, as today |

**Security.** The origin identity is caller-supplied and must be used only to *remove* a name from an existing roster, never to add one or to widen scope. `resolveTeamGroupForTerminal` stays the sole roster source.

**Dependencies.** None blocking. Interacts with `atomic-team-feature-run-context-lifecycle.md` (shipped — this extends its barrier) and with the turn-end silence detector (`feature_plan_20260808083000_pty-turn-end-from-output-silence.md`, shipped — its `lastDataAt` heartbeat is the busy signal this plan reads).

## Dependencies

- `atomic-team-feature-run-context-lifecycle.md` (CODE REVIEWED, 2026-08-25) — shipped. This plan extends its roster barrier; no blocking dependency.
- `feature_plan_20260808083000_pty-turn-end-from-output-silence.md` — shipped. Its `lastDataAt` heartbeat is the busy signal this plan reads from inside the barrier. No blocking dependency; the field already exists on every pty handle (`ptyFleetService.ts:103`) and is already exposed via `ptyListTerminals` (`ptyHost.ts:180`) and `listActive()`.

## Adversarial Synthesis

Key risks: (1) the deferral trigger was unspecified — a deferred seat never dispatched to again would keep stale context indefinitely because the next run's barrier is skipped (same work-context key). Mitigation: intercept the team-barrier's same-feature branch (`clearBeforePrompt = false`) in both roots; if the destination is in the deferred set, override to `true` and remove from the set — the delivery path already does readiness-gated clears. (2) The busy-set construction is host-specific (extension reads `lastDataAt` from verb rows, standalone from in-process handles) — the shared helper must take the busy SET as an input, not derive it, so the helper stays pure while the construction stays trivially host-specific. (3) `lastDataAt === 0` (no heartbeat) must default to deferral, not clearing — "no evidence" is not "at rest".

## Proposed Changes

1. **Add an `origin` field to the prompt-delivery payload** (`ptySendPrompt` / `deliverPrompt`), optional, naming the terminal that requested the send. Populate it on the agent-driven paths; leave absent on operator-driven ones.
2. **Extract the barrier's target-set computation into a shared pure helper** taking `{ roster, liveActive, destination, origin, busySet }` and returning `{ toClear, deferred }` — the names to clear immediately and the names to defer. `busySet` is a `Set<string>` constructed host-side (each root reads `lastDataAt` from its own source and filters on `now - lastDataAt < livenessWindowMs`), NOT derived inside the helper — this keeps the helper pure while acknowledging the busy-set construction is host-specific (extension reads from `ptyListTerminals` verb rows, standalone from `listActive()` handles). Both composition roots call it; a contract test pins that neither host computes the target set itself.
3. **Exclude the origin** from the target set when it is present and on the roster.
4. **Skip busy seats and defer them** — record them in a per-team deferred set (in-memory, joining `_lastWorkContextByTeam` and `_teamPreparationChains`). A deferred seat that never comes to rest before the run ends is cleared by the next run's barrier as normal (different work-context key → barrier fires → clears if at rest). The deferred set is the input to Proposed Change 7.
5. **Do not record the work-context key when the barrier cleared nobody it intended to clear** — a run that could not prepare its roster must be able to try again rather than being marked prepared. When the barrier clears SOME seats but defers others, the key IS recorded (the roster is partially prepared); the deferred seats are handled by Proposed Change 7.
6. **Report the deferral** on the existing `terminalDispatchFinished` lifecycle event with a distinct reason (`'deferred'`), so the pane shows "deferred" rather than a silent success.
7. **Intercept the same-feature branch to clear deferred seats before their next delivery.** When a dispatch targets a seat that is in the team's deferred set, the team-barrier's same-feature branch (`lastTeamWorkKey === workContextKey` → `clearBeforePrompt = false`) must override to `clearBeforePrompt = true` and remove the seat from the deferred set. The delivery path already does readiness-gated clears — no sweep hook, no timer, no new concept. This is the trigger mechanism that Proposed Change 4 deferred: the deferred clear fires at the delivery path, not at a sweep tick. Both roots must wire this in the same branch (`TaskViewerProvider.ts:711` and `bootstrap.ts:1953`).

## Migration

None. The barrier state (`_lastWorkContextByTeam`, `_teamPreparationChains`) is in-memory and per-session; the deferred set joins it. No persisted shape changes.

## Verification Plan

### Goal Invariants

- A lead that dispatches to its own coder is never cleared by that dispatch.
- A seat that is mid-turn never receives a `/clear` from the barrier.
- A seat skipped for being busy is cleared before its next prompt (via the same-feature branch intercept), not left carrying the previous run's context.
- A seat with `lastDataAt === 0` (no heartbeat data) is deferred, not cleared — "no evidence" is not "at rest".
- An operator drag with no origin still clears the full active roster minus the destination.
- Both hosts produce byte-identical target sets for identical inputs to the shared helper.

### Automated Tests

- **Origin exclusion:** roster of 4, origin = head, destination = coder-1 → target set is `{coder-2, intern}`. Assert the head is absent.
- **No origin:** same roster, origin absent → target set is `{head, coder-2, intern}`. Pins that the operator path is unchanged.
- **Off-roster origin:** origin names a terminal not on the roster → target set identical to the no-origin case.
- **Busy deferral:** roster member marked busy → absent from the immediate target set, present in the deferred set; simulate a same-feature dispatch to that seat and assert `clearBeforePrompt` is overridden to `true` and the seat is removed from the deferred set.
- **Busy deferral — no redispatch:** roster member marked busy and never dispatched to again → remains in the deferred set; the next feature run's barrier (different work-context key) clears it if at rest.
- **Missing heartbeat:** seat with `lastDataAt === 0` → deferred (not cleared), matching the sweep's `lastDataAt > 0` guard.
- **All-busy:** every member busy → no clear, and `_lastWorkContextByTeam` is NOT updated for that team.
- **Partial clear + deferral:** 2 of 4 siblings at rest, 2 busy → 2 cleared, 2 deferred, work-context key IS recorded; the 2 deferred seats are cleared via the same-feature branch intercept on their next dispatch.
- **Host parity:** drive the shared helper with a fixed input matrix and assert the extension and standalone roots both delegate to it (source-text contract, in the style of `seat-safeguards-fleet-prompt-path.test.js` — read both `.ts` source files, assert each calls the helper by name).
- **Deferral intercept parity:** source-text contract asserting both roots (`TaskViewerProvider.ts` and `bootstrap.ts`) check the deferred set in the same-feature branch and override `clearBeforePrompt`.
- **Regression — the observed failure:** lead dispatches subtask 1 to coder-1 while itself mid-turn; assert zero writes to the lead's pty.

### Manual

Start a Coding team, drag a feature to it, and watch the lead's pane through its first two subtask dispatches. No `── 1 queued ── ○ /clear` may appear at any point.

## Review Findings

All seven proposed changes landed: the shared pure `computeRosterClearTargets`, host-side `busySet` construction from `lastDataAt`, origin and destination exclusion, deferral, the `terminalDispatchFinished` `reason: 'deferred'` report, the work-context key guard, and the same-feature intercept — mirrored in both roots. Four things were fixed by this review: two CI-red assertions in `host-auto-clear-on-plan-change.test.js` (an orphaned `activeMembers[failedIdx]` reference after the rename to `toClear`, and a `{0,400}` character window that the new deferral intercept pushed the suppression outside of — now brace-matched, plus a paired test that a deferred destination overrides back to `true`); the deferred set's missing lifecycle on close/clear/rename, where an un-rekeyed rename silently defeats the whole feature because `ptyFleetService.rename()` mutates `friendlyName` in place; and `origin`'s wire contract, which was read by both barriers but declared in no schema and documented in no agent-facing table, leaving the plan's own observed failure path (`POST /terminals/verb/ptySendPrompt`) with no way for a lead to supply it. Files changed: `src/services/workContextResolver.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/services/verbSchemas.ts`, `src/test/host-auto-clear-on-plan-change.test.js`, `src/test/roster-clear-mid-turn-deferral.test.js`, `.github/workflows/integration-tests.yml`, and four `.agents` SKILL.md contract files. Validation: `tsc` clean, `eslint` 0 errors, `roster-clear-mid-turn` 45/45, and `host-auto-clear`, `atomic-team-lifecycle`, `dispatch-curtain`, `clear-readiness`, `pty-clear-policy`, `queue-done-relay`, `team-release-control`, `task-complete` plus all four parity gates green.

## Deferred Findings

- MAJOR — The busy signal conflates "mid-turn" with "recently repainted". `lastDataAt` is stamped on every output byte and initialised to `Date.now()` at spawn (`src/standalone/ptyFleetService.ts:460`), so a seat idling at its prompt with a live spinner or status line stays inside the 90 s window and is deferred rather than cleared. Combined with the work-context guard (`src/services/TaskViewerProvider.ts:885`), a permanently-repainting lead means the key is never recorded and the barrier re-runs its whole preparation on every dispatch. The predicate matches the existing sweep precedent (`src/services/PlanIngestionEngine.ts:601`), so this is a property of the chosen signal, not a coding error — but it deserves its own measurement.
- MAJOR — The deferred branch arms a `terminalDispatchPreparing` curtain for a seat it explicitly is not clearing, with a hardcoded `phase: 'clearing'` (`src/services/TaskViewerProvider.ts:851`, `src/standalone/bootstrap.ts:2018`). Already covered by the follow-up plan `a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md`, which also carries the head-exclusion decision; left untouched so that plan lands its own change.
- MAJOR — Standalone's `triggerAction` calls `deliverPrompt` directly (`src/standalone/bootstrap.ts:2386`) instead of routing through the `ptySendPrompt` case, so the board-drag dispatch runs no roster barrier at all in the standalone host. Pre-existing from the atomic-team plan; the extension reaches its barrier because `_attemptDirectTerminalPush` goes through `_ptyHostVerb`.
- NIT — Behavioural tests in `src/test/roster-clear-mid-turn-deferral.test.js:63` report a pass when `out/services/workContextResolver.js` is absent. CI compiles first (`integration-tests.yml:29`), so the coverage holds by step ordering rather than by construction.
- NIT — A roster containing a duplicated name yields a duplicated entry in `toClear` (`src/services/workContextResolver.ts:236`). Harmless: the extra clear is idempotent.
- MAJOR (pre-existing, out of scope) — `test:contract:queue-pipeline` fails two assertions on `_scheduleQueuePop`, removed by commit `25fdb6d9` (the scheduling-consolidation plan), and `test:contract:verb-engine` hard-exits on an unhandled rejection from 2026-07-13 constructor migrations. Both are CI-wired and red for reasons unrelated to this plan.
