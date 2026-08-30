# A team lead can use the message API unaided

**Complexity:** 5

## Goal

A pty-hosted team lead cannot use POST /terminals/verb/ptySendPrompt correctly without a human intervening. Its dispatch prompt resolves the lead's own seat name and then discards it, forbids the lead from looking it up, and then requires it three times — so the lead cannot fill in origin or the completion post's from field. And when the lead tries to check whether a send landed, the two signals it can reach both mislead: the response body is a bare success with no delivery evidence, and promptCount on the roster is a first-delivery latch that never increments. Together these produced a live incident in which a lead invented a delivery mechanism, blamed the wrong field, and needed the operator to hand it the correct call shape. This feature closes both halves: tell the lead who it is and how to send, and make the API able to answer the question the operator asked.

## How the Subtasks Achieve This

- **Team head prompt withholds the head's own seat name and never teaches the message recipe**: Emits a `YOUR SEAT:` line into both head-prompt builders from the `headName` that `_resolveTeamRosterForPrompt` already resolves and throws away, deletes the self-contradicting "Do NOT check your own terminal name" prohibition, adds `origin` to both STAGING recipes, and adds a MESSAGE recipe for the non-dispatch sends (fix rounds, questions, verdicts) the lead currently has to improvise. This is the half that makes the lead's first attempt correct.
- **ptySendPrompt returns no delivery evidence, and promptCount is a latch wearing a counter's name**: Returns `bytesWritten`, `deliveredAt` and `promptSeq` on the send response, turns `promptCount` into a real per-seat counter instead of a `= 1` latch, and converges the two hosts' response key sets (today `bootPhase` exists only in `ptyHost.ts` and `deliveryReason` only in `bootstrap.ts`). This is the half that lets the lead answer "did it land?" without guessing.

Neither half is sufficient alone. A lead taught the right call shape still cannot verify a send; a lead handed delivery evidence still cannot compose the call. The incident this feature comes from needed both: the lead sent a malformed message, then read a latch as a counter and fabricated a mechanism to explain the value it saw.

**Guard against re-encoding the false mechanism.** The originating session concluded that `origin` was what made the second send land. It was not — `origin` is read only by `computeRosterClearTargets` and only to remove a name from the roster clear set, and that barrier did not run for the call in question. `origin` is a context-preservation field. No prompt, doc, or comment produced by either subtask may describe it as a delivery switch.

## Team Dispatch Instructions

### Team head prompt withholds the head's own seat name and never teaches the message recipe

- **Seat:** coder (complexity 4)
- **Acceptance:**
  - `_resolveTeamRosterForPrompt` returns a `head` field and `_resolveRosterAndPort` passes it through; the head name is still absent from the YOUR TEAM roster lines.
  - Both `_buildBatchDrivePrefix` and `_buildDrivePrefix` emit `YOUR SEAT: <head>`, carry `"origin":"<head>"` in STAGING, carry exactly one `MESSAGE (` block whose curl body has `origin` and no `dispatch`, and interpolate the head name into CLOSE OUT's `from`. Every assertion runs against **both** builders — a one-builder pass is a half-fix.
  - The string `Do NOT check your own terminal name` is gone from the non-external-head output of both builders.
  - `externalHead: true` regression: no `YOUR SEAT:` line, the original prohibition text intact, `<your terminal name>` still present in CLOSE OUT and in both recipes' `origin`.
  - Negative guard holds: neither prefix contains `hollow`, `not delivered`, or `the send is lost`. `origin` is a context-preservation field and the prompt must never describe it as a delivery switch.
  - Existing prompt-contract assertions on `<your terminal name>` and on the prohibition sentence are **re-pointed at the external-head branch**, not deleted.
- **Must not touch:** any file other than `src/services/KanbanProvider.ts` and its tests. Specifically out of scope and named as such in the plan: the member→head report fragments in `teamWiring.ts`, `standingOrderFragments.ts`, `standingOrders.ts` and `linkPresets.ts` (correct-but-inert `origin` additions, their own pass); the `ptySendPrompt` response shape and `.agents/skills/switchboard-orchestration/SKILL.md` (owned by the companion subtask); the static `DRIVE_FEATURE_PREFIX` fallback.

### ptySendPrompt returns no delivery evidence, and promptCount is a latch wearing a counter's name

- **Seat:** coder (complexity 6)
- **Acceptance:**
  - `sendPromptToPty` returns a receipt (`readiness?`, `bytesWritten`, `deliveredAt`, `promptSeq?`); `bytesWritten` is `Buffer.byteLength(text, 'utf8')`, and a non-ASCII prompt is in the test so a `text.length` regression fails.
  - `handle.promptCount = 1` is gone; an unconditional `handle.promptCount += 1` sits after the confirm CR. Two sends to one fake handle leave `promptCount === 2` — the assertion that returns 1 at HEAD.
  - All four `promptCount` readers still compare against `0` (`ptyPromptDelivery.ts:152`, `ptyHost.ts:289`, `bootstrap.ts:439`, `TaskViewerProvider.ts:3629`); `bootPhase` is `true` on the first send and `false` on the second through both hosts.
  - The full call-site list is updated, including `bootstrap.ts`'s `deliverPrompt` closure (line 244) and its internal `terminalDispatchFinished` read — and no arm still tests a bare `?.reason === 'exit'` on a value that is now a receipt.
  - Both hosts' `ptySendPrompt` arms expose `bytesWritten`, `deliveredAt`, `promptSeq`, `bootPhase`, `deliveryReason` and `readiness`, with `readiness`/`deliveryReason` conditioned identically. The convergence check is added to `src/test/pty-route-surface-contract.test.js` in that suite's **source-text** idiom.
  - `.agents/skills/switchboard-orchestration/SKILL.md`'s verb table gains a response block stating that `bytesWritten` exceeds the caller's `data` length by design, that `promptSeq` is the seat's ordinal, and that `lastDataAt` is an output heartbeat.
- **Must not touch:** `src/services/verbSchemas.ts` — `promptSeq` and `bytesWritten` are response fields and a request-schema entry would let a caller set them. Do not add readiness detection to the no-clear path (explicit non-goal). Do not delete `deliveryReason` — standalone callers read it. Do not touch the team head prompt or any lead-facing string in `src/services/KanbanProvider.ts`; the companion subtask owns those.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Team head prompt withholds the head's own seat name and never teaches the message recipe](../plans/feature_plan_20260830120000_head-prompt-teaches-own-seat-name-and-message-recipe.md) — **PLAN REVIEWED** — ID: d42072ec-f640-49c6-8cac-b3efa69ebea2
- [ ] [ptySendPrompt returns no delivery evidence, and promptCount is a latch wearing a counter's name](../plans/feature_plan_20260830121000_ptysendprompt-returns-delivery-evidence.md) — **PLAN REVIEWED** — ID: 6351577c-28f2-447a-b13a-c761e4dff21d
<!-- END SUBTASKS -->

## Dependencies & sequencing

Land **ptySendPrompt returns no delivery evidence** first. The head-prompt subtask's step 5 points the lead at what the response proves; writing that line before the response carries `promptSeq` and `bytesWritten` would ship a prompt that describes fields which do not exist. The API subtask also explicitly defers every lead-facing string to the head-prompt subtask, so the two do not collide on the same files.

File overlap is nil: the head-prompt subtask touches `src/services/KanbanProvider.ts` only; the API subtask touches `src/standalone/ptyPromptDelivery.ts`, `ptyFleetService.ts`, `ptyHost.ts` and `bootstrap.ts`. They can be coded in parallel provided the API subtask's response shape is settled before the head-prompt subtask writes its step-5 documentation block. Both must verify against **both** composition roots — the extension host and the standalone/npx host — per the two-hosts rule.

## Implementation Summary

Both subtasks were coded in parallel and committed together. The head-prompt subtask (KanbanProvider.ts) made `_resolveTeamRosterForPrompt` return a `head` field, emitted `YOUR SEAT:` into both prefix builders, added `origin` to STAGING and a new MESSAGE recipe for non-dispatch sends, and interpolated the head name into CLOSE OUT's `from` — with the old prohibition re-pointed at the external-head branch only. The API subtask (ptyPromptDelivery.ts, ptyHost.ts, bootstrap.ts) introduced `PromptDeliveryReceipt` with `bytesWritten`, `deliveredAt`, and `promptSeq`, turned `promptCount` into a monotonic counter, and converged both hosts' `ptySendPrompt` response key sets. Both subtasks verified against both composition roots; the convergence check was added to `pty-route-surface-contract.test.js`.


## Review Findings

Both halves of the feature landed in commit `2bd5f0c7` and the feature goal is met: a lead now reads its own seat name, a STAGING and a MESSAGE recipe both carrying `origin`, and a `from` it can fill in — and the send it makes comes back with `bytesWritten`, `deliveredAt` and a `promptSeq` that actually advances, on both composition roots. The guard against re-encoding the false mechanism holds: `origin` is described only as context preservation, and the negative assertions on `hollow` / `not delivered` / `the send is lost` are in the contract suite for both builders. Two test defects shipped with the commit were fixed in review — the shared pty stub gained `promptCount: 0`, which silently disabled the clear branch in two existing framing tests, and the cross-host convergence gate sliced bootstrap's arm to a verb that only exists in `ptyHost.ts`, so it could never pass. Files changed in review: `src/test/pty-prompt-delivery-framing.test.js`, `src/test/pty-route-surface-contract.test.js`. All CI-wired suites for this feature are green; `seat-safeguards` (2 failures), `parity:check`/`catalog:check`, `mirror:check` and one `TaskViewerProvider.ts` type error are pre-existing red at HEAD and unrelated to this change.

## Deferred Findings

- NIT — `src/services/KanbanProvider.ts:5717` — head names are not shell-escaped for the single-quoted `-d` argument; an apostrophe in a head name breaks both curl recipes.
- NIT — `src/standalone/bootstrap.ts:2195` — `bootPhase` sampled outside the terminal lock; concurrent cold sends can both report `true`.
- NIT — `src/test/pty-route-surface-contract.test.js:614` — convergence is asserted over source text only; no runtime assertion that `bootPhase` flips false on the second send in either host.
- MAJOR (pre-existing) — `src/generated/verbAllowlist.ts` — `getFeatureWorktreeMode` / `setFeatureWorktreeMode` are allowlisted but have no implementation, failing `parity:check` and `catalog:check`.
- MAJOR (pre-existing) — `src/services/TaskViewerProvider.ts:6949` — type error at HEAD: `'blocked'` not assignable to `'completed' | 'stalled'`.
