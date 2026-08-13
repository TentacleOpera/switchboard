# Clear the Activity Light on Sustained Terminal Quiescence

## Goal

Make a dispatched card's activity light go out when its PTY terminal has stopped producing output for a configurable period, instead of waiting for the plan-file mtime handshake or the blind timeout.

### The problem

Completion detection today has exactly one authority: the dispatched agent appending a COMPLETION REPORT to its plan file, which the watcher observes as an mtime advance and uses as the activity-light OFF-switch (`src/services/agentPromptBuilder.ts:806-808`, `GlobalPlanWatcherService`). This produces two user-visible failures:

1. **Latency.** Claude Code goes completely silent the moment it finishes. The card stays lit until the agent gets around to the plan-file edit, or until the blind timeout expires.
2. **Stuck lights — the more important one.** Agents do not reliably perform the completion edit. When an agent finishes its work but skips or botches the plan-file append, the handshake never fires and the card stays lit indefinitely, until the blind `switchboard.activityLight.timeoutMs` backstop clears it. The board asserts "agent working" about an agent that stopped working long ago. The user has confirmed this happens in practice and that clearing on silence outright is the desired behaviour, accepting the false-positive tradeoff below.

### Root cause

The signal needed to fix this is already collected and already reaches the decision point — it is explicitly discarded there.

- `src/standalone/ptyFleetService.ts:194` stamps `handle.lastDataAt = Date.now()` on every `onData` event. Output recency is tracked per terminal for the whole fleet.
- `getLiveness()` (`ptyFleetService.ts:256`) exposes `{ friendlyName, lastDataAt, status }`, including tombstones for operator-killed terminals.
- That snapshot is wired to the plan-ingestion sweep on both hosts (`src/extension.ts:1078` via `TaskViewerProvider.getFleetLiveness()`; `src/standalone/bootstrap.ts:1516` directly), and read on a 10s timer.
- `src/services/PlanIngestionEngine.ts:290-304` partitions the fleet three ways. `status === 'exited'` force-clears. Active-and-recent stamps `last_liveness_at` to *extend* the window. The third branch — **active but silent longer than `livenessWindowMs`** — carries the comment `no evidence; falls through to the blind timer (do nothing here)` and is inert.

The exact case this plan addresses lands in a branch written to do nothing. This is an unused signal, not a missing one. No new data collection, no new transport, no polling, and no terminal-scraping or vision-based inspection is required.

### Accepted tradeoff

Silence is ambiguous: finished-and-idle, blocked-on-a-permission-prompt, and mid-long-compile are indistinguishable from output recency alone. Clearing on silence therefore admits false positives — a card whose agent is still working can go dark. This is accepted deliberately: an early-dark light is self-correcting (the next byte of output re-stamps liveness and the sweep will not have moved the card), whereas a permanently-lit stale card is not. Scope is strictly limited to the activity light — this plan must not move cards, trigger merge-back, or advance workflow state on quiescence. The mtime handshake remains the sole authority for anything that mutates workflow state.

## Implementation

### 1. New config key

Add `switchboard.activityLight.silenceMs` to `package.json` alongside the existing `switchboard.activityLight.timeoutMs` and `switchboard.activityLight.livenessWindowMs` (`package.json:557`, `:565`). Read the current defaults of those two before choosing this one; `silenceMs` must be meaningfully shorter than `timeoutMs` or the feature is unobservable, and at least as long as `livenessWindowMs` to avoid the two branches contradicting each other. Suggested default 120000 (2 min) — long enough to survive a quiet compile or a thinking pause, far shorter than the blind timeout. `0` disables the behaviour, restoring today's semantics exactly.

Register the key in both config readers so the standalone host sees it: `src/standalone/planIngestionHost.ts:233` and `src/services/GlobalPlanWatcherService.ts:194`, and add it to the `affectsConfiguration` reload guard at `GlobalPlanWatcherService.ts:222`.

### 2. Compute the quiescent set in the sweep

In `PlanIngestionEngine.ts`, fill in the inert third branch. Alongside the existing `liveNames` and `forceTerminals` arrays, build `quiescentTerminals`: entries with `status === 'active'` where `nowMs - entry.lastDataAt >= silenceMs`. When `silenceMs` is 0, leave the array empty.

Note the interaction with the existing branch ordering: the current `else if` tests `< livenessWindowMs`. With `silenceMs >= livenessWindowMs` there is a gap between the two thresholds where a terminal is neither live nor yet quiescent — that gap is correct and must fall through to the blind timer as it does today. Do not collapse the two thresholds into one.

Pass the new array through to `clearStaleWorkingState` as a new `opts.quiescentTerminals` field. Keep it a separate field from `forceTerminals` rather than merging the two sets — they have different clearing semantics (see below) and merging them would silently drop the dispatch-age guard.

### 3. Clear quiescent rows in the DB

`KanbanDatabase.clearStaleWorkingState` (`src/services/KanbanDatabase.ts:9889`) already has the shape needed: `forceTerminals` drives a second UPDATE clearing rows whose `dispatched_terminal` is in the set, regardless of age.

Add a third UPDATE inside the same transaction for `quiescentTerminals`, with one critical difference from the force branch: it **must** carry a minimum-dispatch-age guard, `AND dispatched_at < ?` bound to `now - silenceMs`. Without it there is a live race — a card dispatched seconds ago to a terminal that was idle before dispatch would be cleared immediately, before the agent has emitted its first byte. The exited-terminal force branch does not need this guard (a dead process is unambiguous); the quiescence branch does.

Null `dispatched_at`, `last_liveness_at`, and `blocked_at` exactly as the existing branches do, so a re-dispatch starts from a clean basis. Add the count to `modified`. Rows already cleared by the age or force branches are naturally excluded by the `dispatched_at IS NOT NULL` predicate and will not be double-counted. Extend the method's doc comment to describe the new branch and its guard — the existing comment is load-bearing documentation of the age basis and must stay accurate.

Pass `silenceMs` into the method (it needs the value for the guard cutoff) rather than deriving it from `maxAgeMs`.

### 4. Handle the completion-toast consequence

`src/extension.ts:1070` wires `setOnWorkingStateCleared` to `taskViewerProvider.broadcastAgentCompleted(...)`, which drives the browser Terminals panel's completion toast. Once quiescence clears working state, this fires on quiescence too — meaning a toast saying an agent completed on evidence that is sometimes wrong.

Thread the clear *reason* (`handshake` | `exited` | `quiescent` | `timeout`) through the cleared-state callback and suppress the completion toast for the `quiescent` reason, or word it distinctly. Do not leave the toast firing unconditionally — a confidently-wrong "agent completed" notification is worse than none. The plain light going out carries no such claim, which is why the light itself is safe to clear.

Verify the sweep's existing `_firePlanDiscovered(folder)` call on `cleared > 0` (`PlanIngestionEngine.ts:335`) does not cause an oversight pass to treat a quiescence-cleared card as a completed one; if it does, gate that path on reason as well.

### 5. Logging

The sweep already logs `(liveness: recorded=…, forced=…)`. Add `quiescent=…` to that line. When a card goes dark early and the user asks why, this log is the only forensic trail.

## Verification Plan

1. **Unit — quiescence clears.** Seed a plan row with `dispatched_at` older than `silenceMs` and `dispatched_terminal` set. Feed a liveness provider returning that terminal as `active` with `lastDataAt` older than `silenceMs`. Run the sweep with `timeoutMs` set far enough out that the blind branch cannot fire. Assert the row's `dispatched_at` is NULL and the return count is 1.
2. **Unit — dispatch-age guard.** Same setup but with `dispatched_at` set to now. Assert the row is NOT cleared. This is the race guard; without a test it will regress.
3. **Unit — recent output spares the card.** Terminal `active` with `lastDataAt` = now. Assert not cleared and `last_liveness_at` stamped, i.e. the existing live branch is untouched.
4. **Unit — the threshold gap.** `lastDataAt` between `livenessWindowMs` and `silenceMs`. Assert neither stamped nor cleared — it falls through to the blind timer.
5. **Unit — disabled.** `silenceMs = 0` with an indefinitely silent active terminal. Assert behaviour is byte-identical to today (blind timeout only).
6. **Unit — fleet-less host.** No liveness provider wired. Assert the sweep still runs and the blind timeout still clears, per the existing fleet-less compatibility contract.
7. **Manual.** Dispatch a card to a Claude Code terminal in the browser fleet. Let the agent finish and go silent WITHOUT letting it perform the plan-file edit (or dispatch a plan whose agent is known to skip it). Confirm the light goes out roughly `silenceMs` after the last output, that no completion toast claims success, and that the card has not moved columns.
8. **Manual — false positive is self-correcting.** Dispatch work that includes a long silent step exceeding `silenceMs`. Confirm the light goes out, then confirm that resumed output does not corrupt anything and the eventual mtime handshake still lands correctly.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, ui
**Project:** Browser Switchboard
