# Eight Automatic Clears, and the One That Matters Fires Last-Minute

## Goal

Three clears: one when a seat's work is accepted, one when a feature run starts, one when the
operator stands a terminal down. Every other automatic clear is deleted. The dispatch path issues
no clear at all, so no delivery has to race a context reset.

### Problem analysis

**There are eight automatic clear triggers and they are reached from five endpoints that each
decide independently.** Measured against the tree, 2026-09-12:

| # | Site | Trigger | Kind |
|---|---|---|---|
| 1 | `bootstrap.ts:2932` / `TaskViewerProvider.ts:1064` | work-context (feature) change — team-wide roster clear | barrier |
| 2 | `bootstrap.ts:2976` | `payload.clearBeforePrompt = true` on plan change — **the destination, immediately before its prompt** | last-minute |
| 3 | `bootstrap.ts:2851` | deferred-clear intercept — a seat busy during (1) is cleared on its **next dispatch** | last-minute |
| 4 | `LocalApiServer.ts:4212` `completeCardInternal` | lead posts `/kanban/task/complete` | at rest |
| 5 | `LocalApiServer.ts:4411` `releaseCardInternal` | release | at rest |
| 6 | `LocalApiServer.ts:4727` **and** `:4849` `_handleKanbanRoundComplete` | *"Clear all coder seats (unconditional — a round is a barrier)"*, twice in one handler | at rest |
| 7 | `LocalApiServer.ts:5820` `_completeFeatureCore` | feature complete — every seat including the caller | at rest |
| 8 | `LocalApiServer.ts:6628` `_runQueueDone` | queue done, skipped for team members | at rest |

Manual, and correct: `_handleTerminalsClear` (`:7837`), `ptyClearTerminal` (`bootstrap.ts:2639`),
`ptyClearAllTerminals` (`bootstrap.ts:3095`).

**And a ninth, operator-initiated: the manual send.** A drag-to-terminal drop
(`terminals.js:6651`) posts `ptySendPrompt` with `clearBeforePromptFromConfig: true` — the
operator's own setting decides, and the UI arms a dispatch curtain at `phase: 'clearing'` so the
reset is visible while it happens. This one is **correct and stays**: it is requested, it is
attended, and it is the only clear whose timing the operator chose. It is listed because a plan that
claims to reduce clears to three must say where the fourth went, and because it is the one path that
must keep working unchanged when the host's automatic overrides are deleted — the deletions in
change 3 remove the host's *override* of `clearBeforePrompt`, never the caller's ability to set it.

**Five of the eight are the same event.** Rows 4–8 all mean *this seat's work is finished and
accounted for*. They are five endpoints independently re-deciding one question, each with its own
skip conditions — `:5820` exempts the caller unless `clearLead`, `:6628` exempts team members,
`:4212` exempts a poster that equals the dispatched seat. A seat finishing a subtask that closes a
round that closes a feature passes through three of them.

**The two that are not at rest are the two that cause the bugs.** Rows 2 and 3 clear a seat and then
deliver a prompt to it. That is the only reason the delivery path needs a readiness gate with a
15-second ceiling and a floor: it is compensating for a reset the host chose to perform at the worst
available moment. The host's own drive prefix forbids the lead from doing this
(`KanbanProvider.ts:5975`), and `proactive-terminal-rest-clear-contract.test.js` asserts the
instruction text must never show `clearBeforePrompt: true` — *"that is the race this contract
removes."* The contract pins what the lead is **told**; the host does it anyway on the lead's behalf,
and the contract stays green because its scope is the instruction, not the implementation.

**The at-rest clear is unreliable, which is why the last-minute ones exist.** `completeCardInternal`
skips the clear when `dispatchedSeat === from` (`:4232`). A coder that posts its own completion —
which its dispatch prompt instructs it to do — takes that branch, so no clear happens. Observed on
`Coding-coder-1`, 2026-09-12: completion receipt `cleared: false`. With the at-rest clear skipped,
the dispatch-time clear is the only one left, and it fired into a devin session rollover: the prompt
landed as raw text with a literal `^[[200~` in front of it, unsubmitted, for ~55 minutes until the
lead routed the subtask to `Coding-coder-2`.

**The barrier fires at the wrong moment, not just the wrong place.**

> **Superseded:** Row 1 runs on the **first coder dispatch** of a new feature, inside the same call that then delivers the prompt (`await prepPromise` at `bootstrap.ts:2971`). The idle window the design wants — the lead reading a feature file before it dispatches anything — is 20+ seconds long and is not used. Moving the barrier to the moment the lead **receives** the feature spends that window instead of racing it.
> **Reason:** Code trace contradicts "first coder dispatch" for the common case (head-paced terminal teams). `performKanbanDispatch` → `triggerAction` → `handlePtyVerb('ptySendPrompt', ...)` at `bootstrap.ts:3505` routes the head's feature dispatch through the same `ptySendPrompt` case that holds the team barrier. `resolveWorkContext` (`workContextResolver.ts:73`) gives `workContextKey = featureId || planId`: a feature card keys to its own `planId`, its subtasks key to the same `featureId`, so they **match**. The barrier fires on the **head's feature dispatch** (the first dispatch whose `workContextKey` differs from `lastTeamWorkKey`), sets `lastTeamWorkKey`, and the first coder dispatch takes the same-feature branch (no barrier). The barrier already fires at feature-receipt; the roster clears *before* the head's prompt lands, so the reading window is spent, not raced.
> **Replaced with:** For head-paced terminal teams the roster barrier already fires at feature-receipt (the head's feature dispatch). The actual last-minute clear that races delivery is **row 2** — the destination clear (`payload.clearBeforePrompt = true` at `bootstrap.ts:2987` / `TaskViewerProvider.ts:1121`) which clears the destination right before its prompt. Change 2 is reframed accordingly: the real win is **decoupling the barrier from the dispatch call** so the roster clear does not block the destination's prompt delivery (fire it in `_runQueuePop` ahead of `performKanbanDispatch`, not inside the `await prepPromise` that gates the prompt), and ensuring seat-paced / external-head teams — where the feature goes straight to a coder with no head dispatch — still get a feature-receipt barrier rather than a first-coder-dispatch one. If that decoupling is not wanted, change 2 collapses into "no-op for head-paced; already at feature-receipt" and change 3 carries the entire load. See Outstanding Questions.

## Metadata

- **Complexity:** 5
- **Tags:** infrastructure, reliability, backend, cli

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting the dispatch-time override (`bootstrap.ts:2976`) and its extension-host twin.
- Deleting the duplicate round-complete clear (`LocalApiServer.ts:4727` or `:4849` — one handler, two sites).
- Correcting the `dispatchedSeat === from` branch so a self-reporting coder is not skipped.

### Complex / Risky
- **Collapsing rows 4–8 into one seat-at-rest function.** Each carries a different skip condition
  (`clearLead`, `isTeamMember`, poster-equals-dispatched-seat). The collapse must preserve every
  skip that is load-bearing and drop the ones that are accidental — a wrong merge clears a lead
  mid-turn, which costs a re-auth toll and the state it needs to manage the run.
- **Decoupling the roster barrier from the dispatch call (revised).** The barrier already fires at
  feature-receipt for head-paced teams (the head's feature dispatch, via `triggerAction` →
  `ptySendPrompt` at `bootstrap.ts:3505`). The remaining work is to stop the roster clear from
  **blocking** the destination's prompt (it runs inside `await prepPromise` at `bootstrap.ts:2981`,
  which gates the prompt delivery) — by firing it in `_runQueuePop` ahead of
  `performKanbanDispatch` — and to give seat-paced / external-head teams (no head dispatch) a
  feature-receipt barrier instead of a first-coder-dispatch one. The barrier keys on
  `workContextKey` changing; the trigger site, not the helper, is what moves.
- **Deleting row 3 without stranding a busy seat.** A seat busy during the barrier is deferred
  today and cleared on its next dispatch. With row 3 gone, its clear must arrive from the at-rest
  path instead — which means the at-rest path must be reliable first. Sequencing is not optional:
  changes 1 and 2 land before change 3.
- **Both roots.** `bootstrap.ts` and `TaskViewerProvider.ts` each carry a roster-clear
  implementation (`:2932` / `:1064`) and both must move together. `computeRosterClearTargets` is
  already the shared pure helper; the trigger site is what diverges.

## Edge-Case & Dependency Audit

1. **A lead that never accepts.** If a coder self-reports and the lead never posts acceptance, the
   at-rest clear never fires. The feature-receipt barrier is the backstop — it clears the whole
   roster at the next feature, so an un-accepted seat is cleared within one feature boundary rather
   than never. Assert this rather than assuming it.
2. **A seat mid-turn at feature receipt.** `computeRosterClearTargets` already defers busy seats via
   `busySet` (`lastDataAt` inside `activityLight.livenessWindowMs`). Moving the trigger earlier does
   not change that logic, but it changes *which* seats are busy — at feature receipt the previous
   feature's coders may still be finishing. They are deferred, and change 1 must give them a real
   later clear rather than the row-3 next-dispatch one being deleted.
3. **The head is never cleared by the barrier.** Existing exclusion at
   `computeRosterClearTargets`; it must survive. Clearing the head costs a re-auth toll and the
   orchestration state for the run.
4. **`clearBeforePrompt` remains a caller-supplied field.** This plan deletes the host's *override*
   of it, not the field. An operator or protocol that explicitly passes `true` still gets a
   readiness-gated clear — that path keeps the floor and the gate.
5. **The delivery floor is not removed by this plan.** The floor and the readiness gate stay exactly
   as they are. This plan removes the *reason* they are load-bearing on the dispatch path; it does
   not remove the belt. A warm seat can still be mid-render for reasons this plan does not control
   (a devin session rollover, a CLI restart), and the floor is what covers those.
6. **Do not fold in the rollover problem.** A devin session that ends and restarts on its own is
   invisible to every trigger in this plan. That is
   `an-agent-exit-destroys-the-seat-and-its-error-with-it` (`d7155efc`) and stays there.

## Dependencies

- `an-agent-exit-destroys-the-seat-and-its-error-with-it` (`d7155efc`, Planned) — independent. It
  covers a seat restarting underneath the host; this plan covers when the host itself resets a seat.
  Neither blocks the other.

## Adversarial Synthesis

Key risks: (1) collapsing five endpoints into one function silently drops a skip condition and
clears a lead mid-turn; (2) deleting row 3 before the at-rest path is reliable strands every seat
that was busy at the barrier; (3) the existing proactive-clear contract passes while the host
violates it, so "green" is not evidence this landed — the new assertions must read the host, not the
instruction text; (4) the both-hosts grep misses the extension's colon-form `clearBeforePrompt: true`
and passes while `TaskViewerProvider` still clears on dispatch; (5) `host-auto-clear-on-plan-change.test.js`
tests 3 & 4 pin the behavior change 3 deletes and must be inverted, not listed as green; (6) the
non-team destination clear (`bootstrap.ts:3012` / `TaskViewerProvider.ts:1149`) is a dispatch-time
clear the original plan omitted; (7) change 4's attended cap is already shipped, not a new change.
Mitigations: land changes 1 and 2 before change 3; assert each preserved skip condition by name; pin
the host's dispatch payload with a check that matches both `= true` and `: true` syntax; rewrite the
host-auto-clear assertions as part of change 3; add 3012/1149 to the deletion list; treat the
attended cap as a regression guard.

## Proposed Changes

### 1. One seat-at-rest clear, reached from one place

Replace rows 4–8 with a single `clearSeatAtRest(workspaceRoot, seat, reason)` on `LocalApiServer`,
called by `completeCardInternal`, `releaseCardInternal`, `_handleKanbanRoundComplete`,
`_completeFeatureCore` and `_runQueueDone`. It owns the decision and records which caller asked, so
"why was this seat cleared?" and "why was it not?" are answerable from one function.

Preserve, by name and with a test each: the head/lead exemption (`clearLead`), and the team-member
exemption in `_runQueueDone`. Delete the duplicate call in `_handleKanbanRoundComplete` — one
handler must not clear the roster twice.

**Self-report reaches the at-rest path.** The `dispatchedSeat === from` branch (`:4232`) currently
skips the clear entirely. A self-reporting coder marks the seat at rest and does **not** clear —
context is preserved for the lead's review, which is the existing design and stays. What changes is
that the seat is *recorded as owed a clear*, so change 2's barrier can settle it, rather than the
skip being silent.

> **Clarification — the owed-clear store must be named, not implied.** The original plan says
> "recorded as owed a clear" but names no data structure. The existing `deferredClearsByTeam` set
> (which records deferred seats) is **deleted with row 3** — it cannot be the owed-clear store.
> Either (a) introduce a new `owedClears` set on `LocalApiServer` keyed by `(workspaceRoot, seat)`
> that the feature-receipt barrier drains, with a test that a self-report adds to it and the next
> barrier removes it; or (b) drop the "recorded as owed" claim and rely on the feature-receipt
> barrier as the backstop (edge-case 1 already names it: an un-accepted seat is cleared within one
> feature boundary). Option (b) is simpler and the barrier already clears the whole roster; the
> owed-clear set only buys a *named* reason on the receipt. See Outstanding Questions.

### 2. The roster barrier fires when the lead receives the feature (reframed)

> **Superseded:** Move the trigger from "the first coder dispatch whose `workContextKey` differs" to "the lead is handed a new feature." The clear then runs while the lead reads the feature file — the 20+ second window the current design races instead of spending.
> **Reason:** For head-paced terminal teams the barrier already fires on the head's feature dispatch (feature-receipt) — see the superseded callout in Problem analysis. "Move to feature-receipt" describes a move that already happened. The roster clear also runs *inside* `await prepPromise` (`bootstrap.ts:2981`), which gates the destination's prompt, so it blocks delivery rather than running concurrently with the reading window.
> **Replaced with:** Two concrete moves. (a) **Decouple** the barrier from the dispatch call: fire the roster clear in `_runQueuePop` (`LocalApiServer.ts:3564`) ahead of `performKanbanDispatch` (`:3918`), so it no longer blocks the destination's prompt inside `await prepPromise`. (b) **Cover seat-paced / external-head teams**: where pacing is `'seat'` or the head is external (`useSeatBranch` at `LocalApiServer.ts:3884`), the feature goes straight to a coder with no head dispatch, so the barrier fires on that coder's dispatch — keep it, but ensure it is the feature-receipt barrier (first dispatch of the new `workContextKey`), not a per-coder surprise.

The barrier keeps `computeRosterClearTargets` unchanged: destination/origin/head exclusions and
busy-seat deferral all stand. It gains the destination, because there is no longer a separate
dispatch-time clear for the destination to own.

Both roots: `bootstrap.ts` (barrier inside `case 'ptySendPrompt':` ~`:2869`) and `TaskViewerProvider.ts` (`:983`) move together. `computeRosterClearTargets` is already the shared pure helper (`workContextResolver.ts`); the trigger site is what diverges.

### 3. The dispatch path issues no clear

Delete **every** dispatch-time `clearBeforePrompt = true` override, on both roots:

- **Team-branch destination clear:** `payload.clearBeforePrompt = true` (`bootstrap.ts:2987`) and `payload = { ...payload, clearBeforePrompt: true }` (`TaskViewerProvider.ts:1121`).
- **Non-team destination clear:** `payload.clearBeforePrompt = true` (`bootstrap.ts:3012`) and `TaskViewerProvider.ts:1149` — `lastWorkKey && lastWorkKey !== workContextKey`. This is a third dispatch-time clear site the original plan omitted; the Goal ("the dispatch path issues no clear at all") requires it gone too. A standalone coder (no team) on its second plan is cleared here today.
- **Deferred-clear intercept:** `payload.clearBeforePrompt = true` (`bootstrap.ts:2865`) and `TaskViewerProvider.ts:979`, plus the `deferredClearsByTeam` plumbing that feeds them.

After changes 1 and 2 the destination is already clean when work reaches it, and a deferred seat
gets its clear from the at-rest path or the next feature barrier.

`clearBeforePrompt` survives as a caller-supplied field. The host stops overriding it. The manual
stand-down clear (`TaskViewerProvider.ts:12281`, `clearBeforePrompt: true` with empty `data`) is a
pure `/clear`, NOT a dispatch — it stays.

Update `KanbanProvider.ts:5973-5975` so the lead's instructions describe what the host actually
does. The line *"the host overrides it to true automatically when the plan changes"* becomes false
on this change and must not survive it. Line `:5973` ("the host auto-clears the full team roster
once when a new feature run starts") stays accurate only if change 2's decoupling lands; re-read it
after change 2 and correct if the trigger site moved.

> **Test that breaks on this change — must be rewritten, not listed as green.**
> `host-auto-clear-on-plan-change.test.js` tests 3 and 4 (lines 127–161) assert in source text
> that BOTH hosts set `clearBeforePrompt = true` / `payload.clearBeforePrompt = true` on
> work-context change. This change deletes those exact lines. Those two assertions must be
> **inverted** (assert the override is absent from the dispatch path) as part of this change —
> they are the existing pin of the behavior being removed. Verification item 8 must NOT list
> `test:contract:host-auto-clear` as "all pass" until this rewrite lands; the test fails first,
> then passes again with the inverted assertions.

### 4. The manual send keeps its clear, and keeps the guard (already shipped — preserved)

> **Superseded:** The floor is capped by attendance: 5s attended, 10s unattended. One number for every send was the devin family floor, 15s — the right budget for an automation where a swallowed prompt stalls a run until someone notices, and too long for a send an operator just made and is watching. Applied as `min(familyFloor, cap)`, so it can only shorten: claude and antigravity sit at 3000 and are unchanged in both modes; devin and `unknown` drop to 10s automated, 5s attended. `attended` defaults to **false**.
> **Reason:** This is not a proposed change — it is **already shipped**. `ATTENDED_FLOOR_CAP_MS = 5000` and `UNATTENDED_FLOOR_CAP_MS = 10000` exist at `ptyPromptDelivery.ts:61-62`; `resolveDeliveryFloorMs` applies `Math.min(familyFloorMs(family, timeouts), cap)` at `:78`; `attended` defaults to false at `bootstrap.ts:3051` (`payload.attended === true`) and `TaskViewerProvider`'s twin. `clear-readiness-state-machine.test.js:385` already pins "5s attended / 10s unattended, applied as min(familyFloor, cap)". Presenting shipped code as a Proposed Change sends an implementer to build something that already exists.
> **Replaced with:** No code change. This section is an **invariant to preserve**: change 3's deletions must not touch the attended cap, the family floor, or the manual-send path. The verification items that reference the cap (item 7, Goal Invariant) assert behavior that already holds — they are regression guards, not new-work checks. The manual drop at `terminals.js:6651` keeps `clearBeforePromptFromConfig: true` and the clearing curtain, unchanged.

No change to `terminals.js:6651`. The operator-config'd clear-on-send stays, and it keeps the
readiness gate and the family floor exactly as they are — a manually sent prompt is delivered into
the same CLI, with the same repaint, as an automated one, and the failure of an early paste is the
same lost prompt. The attended cap (`min(familyFloor, cap)`, 5s/10s, default false) is already
live in `ptyPromptDelivery.ts` and stays.

### 5. The contract reads the host, not the instruction text

`proactive-terminal-rest-clear-contract.test.js` asserts the drive prefix never shows
`clearBeforePrompt: true`, and passed for the entire period the host was setting exactly that. Add
assertions against `bootstrap.ts` and `TaskViewerProvider.ts` that no dispatch path assigns
`clearBeforePrompt = true`, so the rule holds where it is executed rather than where it is
described.

> **Clarification — this overlaps with the `host-auto-clear` rewrite in change 3.** The new
> "no dispatch path sets `clearBeforePrompt = true`" assertions are the **inverted** form of
> `host-auto-clear-on-plan-change.test.js` tests 3 & 4. Land them in ONE place (either by inverting
> tests 3 & 4 in `host-auto-clear-on-plan-change.test.js`, or by adding the negative assertions to
> `proactive-terminal-rest-clear-contract.test.js` and deleting tests 3 & 4) — not both, or the two
> tests will drift. The check must match both the `= true` (bootstrap) and `: true`
> (TaskViewerProvider) syntax forms, and must exclude the empty-`data` manual stand-down clear
> (`TaskViewerProvider.ts:12281`).

## Verification Plan

### Automated

1. **Both-hosts invariant — the grep must match both syntaxes.** The standalone uses
   `payload.clearBeforePrompt = true` (assignment); the extension uses
   `payload = { ...payload, clearBeforePrompt: true }` (colon, object property). A grep for
   `clearBeforePrompt = true` matches the assignment and **misses the colon form** — it would pass
   while `TaskViewerProvider.ts` still clears on dispatch. Assert against the source slices the
   existing tests already extract (`SEND_PROMPT_SRC` from `bootstrap.ts` `case 'ptySendPrompt':`,
   `PTY_HOST_VERB_SRC` from `TaskViewerProvider._ptyHostVerb`) and require neither contains a
   dispatch-path `clearBeforePrompt` set to true. The manual stand-down clear
   (`TaskViewerProvider.ts:12281`, empty `data`) is NOT a dispatch and must be excluded from the
   assertion.
2. `_handleKanbanRoundComplete` contains exactly one clear call, not two.
3. Every preserved skip condition has a test naming it: head/lead exemption, team-member exemption
   in the queue-done path.
4. A self-reporting coder's completion returns `cleared: false` with a reason naming the pending
   lead acceptance, and (if option (a) in change 1 is taken) the seat is recorded as owed a clear
   that the next feature-receipt barrier drains.
5. A seat busy at the feature barrier is deferred, and receives a clear from the at-rest path or the
   next barrier — never from a dispatch.
6. The manual drop still posts `clearBeforePromptFromConfig: true` and still arms the clearing
   curtain — assert against `terminals.js`, so change 3's deletions cannot take the operator's own
   clear with them.
7. The attended cap is shorter than the unattended cap, the unattended cap does not exceed the
   family floor it caps, and anything that is not exactly `attended: true` resolves to the longer
   cap. (Regression guard — this already holds in `ptyPromptDelivery.ts:61-78` and
   `clear-readiness-state-machine.test.js:385`; the check is that change 3 did not regress it.)
8. `npm run test:contract:terminal-rest-clear`, `test:contract:clear-readiness`,
   `test:contract:pty-clear-policy` and `test:contract:roster-clear-mid-turn` all pass.
   **`test:contract:host-auto-clear` does NOT pass until change 3 rewrites tests 3 & 4** (lines
   127–161 of `host-auto-clear-on-plan-change.test.js`) to invert the assertion — from "the host
   sets `clearBeforePrompt = true` on work-context change" to "no dispatch path sets it." Run it
   twice: once to confirm it FAILS after the source deletion (proving the old pin was real), once
   to confirm it PASSES after the assertion inversion. A green run without the rewrite means the
   deletion missed a site.

### Goal Invariants

- Assert exactly two AUTOMATIC clear triggers exist — seat-at-rest and the feature-receipt barrier —
  alongside the two operator-initiated ones that are not being reduced: manual stand-down
  (`ptyClearTerminal` / `ptyClearAllTerminals` / `_handleTerminalsClear`) and the config-gated
  clear-on-send (`terminals.js:6651`). Pin the automatic count, so a third added later fails rather
  than accumulating; the operator-initiated ones are requested and are not part of the budget.
- Assert no code path on either host sets `clearBeforePrompt = true` on a dispatch payload —
  checking **both** the `= true` assignment form (bootstrap) and the `: true` object-property form
  (TaskViewerProvider), and excluding the empty-`data` manual stand-down clear.
- Assert `computeRosterClearTargets` still excludes the head, and that the exclusion is covered by a
  test that fails when removed.
- Assert the delivery readiness gate still runs — this plan removes a reason, not a guard. The
  family floor is capped, never removed: assert `min(familyFloor, cap)` for every family and both
  attendance values, and that an undeclared caller takes the longer cap. (Already shipped —
  regression guard.)
- Negative pairing: assert `clearSeatAtRest` is called from all five completion paths, so the
  collapse did not drop a caller while looking tidy.
- **Barrier-timing invariant (revised):** assert the roster barrier fires on the feature-receipt
  dispatch (the head's feature dispatch for head-paced teams; the first coder dispatch of a new
  `workContextKey` for seat-paced / external-head teams), and that the roster clear does NOT run
  inside the `await prepPromise` that gates the destination's prompt — i.e. it is decoupled from the
  delivery critical path. A green "barrier moved" metric that only checks the trigger site is NOT
  sufficient; the decoupling is the actual change.

## Outstanding Questions

- **[user]** Does change 2's decoupling (fire the roster clear in `_runQueuePop` ahead of
  `performKanbanDispatch`, instead of inside `await prepPromise`) justify the added complexity, or
  should change 2 collapse to "no-op for head-paced teams — the barrier already fires at
  feature-receipt" and let change 3 carry the entire load? — proceeding on the assumption that the
  decoupling IS wanted, because the roster clear blocking the destination's prompt inside
  `await prepPromise` is a real latency cost the plan's own Problem analysis objects to, even though
  the "first coder dispatch" framing that motivated it was wrong.
- **[user]** For the self-report owed-clear (change 1): take option (a) — a new `owedClears` set on
  `LocalApiServer` drained by the feature-receipt barrier — or option (b) — drop the "recorded as
  owed" claim and rely on the feature-receipt barrier as the backstop (edge-case 1)? — proceeding
  on the assumption that option (b) is taken (simpler; the barrier already clears the whole roster
  and the owed-clear set only buys a named reason on the receipt), unless the user wants the
  per-seat owed-clear audit trail.
- **[research]** None. All uncertainties in this plan are code-answerable from the switchboard repo
  (verified this session by tracing `triggerAction` → `ptySendPrompt`, `resolveWorkContext`,
  `computeRosterClearTargets`, and the five at-rest clear sites). No external / library / API
  behavior is in doubt; no web research is needed.

---

**Recommendation:** Complexity 5 → **Send to Coder.** The collapse (change 1) and the dispatch-path
deletion (change 3) are the load-bearing work; change 2 is a decoupling refinement the user should
confirm first (Outstanding Questions). Land changes 1 and 2 before change 3 — the at-rest path must
be reliable and the barrier decoupled before the dispatch-time clears are removed, or a busy seat is
stranded with no clear left.

## Review Findings

**The implementation does not exist** — no commit carries this plan's ID and the working tree has no
change to `bootstrap.ts`, `TaskViewerProvider.ts`, `LocalApiServer.ts` or `KanbanProvider.ts`; every
site changes 1–3 name is present unchanged (three dispatch-time `clearBeforePrompt` overrides per
host, both round-complete clear loops, the full `deferredClearsByTeam` plumbing, no `clearSeatAtRest`).
The plan's own discriminator confirms it: verification item 8 requires `test:contract:host-auto-clear`
to FAIL after change 3's deletion, and it passes green. One file was changed in this pass —
`src/test/proactive-terminal-rest-clear-contract.test.js`, whose `return block.join` extraction anchor
was broken by `17cbc519` (the return is now `return substituteCliPath(block.join('\n'))`), so this
CI-wired gate threw at module load and all six of its assertions had been unreachable. All five named
clear suites now pass (`terminal-rest-clear`, `host-auto-clear`, `clear-readiness`, `pty-clear-policy`,
`roster-clear-mid-turn`) after `npm run compile-tests`, and all five are confirmed invoked by CI.

### Review pass 2 (2026-09-13, post-implementation)

The implementation now exists and the goal is met: no dispatch path on either root sets
`clearBeforePrompt` to true, all five at-rest paths route through the new
`LocalApiServer.clearSeatAtRest`, the `deferredClearsByTeam` plumbing is gone from both roots, and
both false `KanbanProvider` instruction lines are corrected. Six files were changed in this pass —
`src/standalone/bootstrap.ts` and `src/services/TaskViewerProvider.ts` (barrier now skips a sibling
already dispatched into the new work context, closing the wipe window the decoupling opened),
`src/services/workContextResolver.ts` (deleted the orphaned `dropDeferredClear` /
`renameDeferredClear` and corrected two docblocks still describing the deleted intercept), and the
`host-auto-clear-on-plan-change`, `dispatch-curtain-and-ufo-contract`, `roster-clear-mid-turn-deferral`
and `prompt-payload-kind-contract` suites. `tsc --noEmit` is clean apart from four pre-existing TS2835
import-extension errors, and all six named clear suites pass and are CI-wired in
`.github/workflows/integration-tests.yml`; `atomic-team-lifecycle`, `team-release-control`,
`terminal-coder-dispatch`, `queue-pipeline`, `completion-asserted-never-inferred` and two
`dispatch-curtain` assertions are red for reasons that reproduce against HEAD content (HTTP 403
cross-site stubs, `res.getHeaders is not a function`, a `return block.join` anchor broken by
`17cbc519`, and other in-flight plans' work). The barrier-timing invariant has no automated check
that can discriminate on live behaviour — passing source-level suites is not evidence the decoupled
barrier behaves correctly against a real fleet, and no live run was performed in this pass.

## Deferred Findings

- MAJOR — The barrier does NOT gain the destination, contrary to change 2's "It gains the destination". `src/services/workContextResolver.ts:232` still skips `destination`, and with the dispatch-time clear deleted, the destination of the first dispatch of a new feature is now cleared by NOTHING unless its previous card was accepted. This bites seat-paced / external-head teams (change 2b), where the feature goes straight to a coder with no head dispatch. Not fixed: with the barrier decoupled (un-awaited), adding the destination would clear the seat concurrently with its own prompt delivery — strictly worse than the race the plan removes. The plan text is self-contradictory here ("destination/origin/head exclusions all stand" and "It gains the destination" in one paragraph) and the revised change-2 callout drops the claim.
- MAJOR — Residual wipe window in the decoupled barrier. `src/standalone/bootstrap.ts:2905` / `src/services/TaskViewerProvider.ts:1007` now skip a seat already carrying the new `workContextKey`, but `toClear` is computed once and the clears then take seconds; a dispatch landing on a target seat AFTER the target set is computed but BEFORE its `clearPty` resolves is still wiped. Narrow in practice — rapid multi-seat dispatch goes through `skipClear`, which bypasses the barrier entirely — so a per-handle re-check at clear time was not worth serialising `Promise.all`.
- MAJOR — The head/lead is no longer cleared at a feature boundary. It is excluded from the barrier by design (`computeRosterClearTargets`, head exclusion, a Goal Invariant) and previously got its reset from the now-deleted team-branch destination override. Its only remaining clear is `_completeFeatureCore` with `clearLead: true` (`src/services/LocalApiServer.ts:5929`), reached from the round-complete last-round delegation. A lead that never closes a round accumulates context across features.
- NIT — `_handleKanbanRoundComplete` still has two coder-seat clear loops (`src/services/LocalApiServer.ts:4851`, `src/services/LocalApiServer.ts:4974`), so verification item 2 ("exactly one clear call") is not satisfied literally. The plan's premise is wrong: the first loop sits inside the `teamRounds.length === 0` stateless fallback, which returns before the round-aware path, so they are mutually exclusive branches and never clear one roster twice. Pinned at exactly two with a comment rather than merged.
- NIT — `deferred` is destructured from `computeRosterClearTargets` and unused in both roots (`src/standalone/bootstrap.ts:2899`, `src/services/TaskViewerProvider.ts:1001`). Harmless (`noUnusedLocals` is off) and kept because it documents the helper's contract at the call site.
- NIT — `_runQueueDone` now reports `clearSkipped` for a non-deliberate skip (`clearTerminalContext` absent, or `terminal.clearBeforePrompt` disabled) where it previously reported nothing (`src/services/LocalApiServer.ts:6738`). More information, not less, and consistent with the source-tagging rule — but `clearSkipped` no longer means only "deliberately preserved for review".

## Implementation Summary

All five changes implemented. Change 1: added `clearSeatAtRest` to `LocalApiServer.ts` and routed all five at-rest clear paths (complete, release, round-complete, feature-complete, queue-done) through it, collapsing the independent deciders into one shared helper that owns `clearTerminalContext`, `markSeatAtRest`, and `onTerminalContextCleared`. Change 2: decoupled the roster barrier from dispatch in both roots — the barrier is no longer awaited and runs concurrently with prompt delivery; a barrier failure is swallowed by the chain's `.catch` and does not fail the dispatch. Change 3: deleted every dispatch-time `clearBeforePrompt = true` override in both roots (deferred-clear intercept, team-branch destination, non-team destination), removed the obsolete `deferredClearsByTeam` plumbing and `recordDeferredClears` seam from both roots and `LocalApiServer`, and corrected both false instruction lines in `KanbanProvider.ts`. Change 5: rewrote `host-auto-clear-on-plan-change.test.js` tests 3 and 4 to assert the dispatch path issues NO forced clear, updated the deferred-clear and destination-override assertions to pin the absence, added `clearSeatAtRest` and round-complete deduplication assertions, and updated `prompt-payload-kind-contract.test.js` and `roster-clear-mid-turn-deferral.test.js` to pin the removed plumbing. The manual stand-down clear, `clearBeforePromptFromConfig`, readiness gates, family floors, and attended/unattended caps are unchanged.
