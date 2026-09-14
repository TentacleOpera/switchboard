# Team lead escalation must exhaust cheap recovery before declaring a subtask blocked

<!-- board-collapse-04 -->
> **RESCOPED 2026-09-04 (Board Collapse 04, decision 9).** This is now the **single recovery ladder** for the whole system. *Mission Control's hard-skip escalation must spend a bounded recovery budget first* has been deleted: its premise was the overnight tick loop with cleared context, and no surviving plan builds on that loop.
> > 
> > **Add a first rung: verify the block before acting.** Read the seat's own log (`GET /terminals/<name>/log`) and confirm the seat is actually stuck before spending a recovery attempt. A `blocked` turn-end notice is frequently false — the backstop compares against state that predates the arming registration — so acting on one without checking burns an attempt on a working seat.
> > 
> > **Add the Mission Control hand-off:** when the ladder is exhausted and the lead records a subtask blocked, that is what wakes the controller through the transition path in *A supervised mission has no supervision*. Mission Control does not run its own ladder; it re-dispatches once with a bounded budget and can un-skip an awaiting-input card when the answer lands, as text in the run sheet's resume branch.
> > 
> > **This plan owns the single edit** to the KanbanProvider drive-block wording ("context preserved / ptyClearTerminal is stand-down only"), so it does not race *The lead's acceptance post*. Both are in the seat-release feature; this one lands first.


## Goal

Replace the terminal branch in the coding-team head prompt's escalation clause with an
ordered recovery ladder, so a lead stops reporting "blocked — no higher seat available"
while cheap, obvious fixes remain untried. Teams are unreleased dev work, so this is a clean
text edit with no migration.

### The problem

A team lead abandoned a subtask after two failed review attempts, reporting that
"escalation rules meant max 2 attempts and no higher seat available". The outstanding fix
was small. The lead could have cleared the failing seat and re-prompted it with the named
defects, handed the subtask to an idle seat on its own team, or made the fix itself. It did
none of these — not because it lacked the means, but because the prompt told it to stop.

### Root cause

`NEW_CODING_HEAD_PROMPT` (`src/services/teamWiring.ts:623-629`) states:

> "When a seat fails review on the same subtask twice, do not send that subtask to it a
> third time — escalate one rung along intern → coder → lead, name the specific defects in
> the dispatch, and say in your status report which seat you moved it to and why; **if the
> seat that failed twice is a lead, or your team has no seat above it, stop and report to
> the human** instead of dispatching again (or unattended: record the blocked card to
> `.switchboard/mission-control/reports/` and proceed to the next queue item)."

This is a **single vertical ladder with a terminal rung**. The lead behaved correctly; the
rule is wrong in three specific ways:

1. **It counts attempts against the seat when what is exhausted is the context.** A seat
   whose context is poisoned by two failed attempts is not the same agent as that seat
   cleared and re-prompted with the defects named. The prompt makes no such distinction, so
   "clear and retry" reads as a forbidden third attempt.
2. **Retry is vertical-only.** The prompt does say "dispatch the next subtask to an idle
   seat that has not already worked on it" — but only for the *next* subtask. Lateral
   hand-off of a *failing* subtask to an idle peer is never mentioned.
3. **"escalate one rung along intern → coder → lead" never says what the top rung means.**
   Dispatch to a lead seat, or do it yourself? The surrounding prompt frames the lead
   purely as a dispatcher ("You lead this team. Your coders work the subtasks"), so a lead
   reads "no seat above it" as terminal and never considers its own hands.

### This is not a capability gap

Every recovery route is already reachable by a lead over HTTP, in both hosts:

- `POST /terminals/verb/ptyClearTerminal` with `{"name":"<seat>"}` — handled in
  `src/standalone/bootstrap.ts:1954` and, on the extension side, in
  `TaskViewerProvider.ts:528,562`. No composition-root wiring is missing.
- `POST /terminals/verb/ptySendPrompt` — targeted re-dispatch.
- `POST /terminals/verb/ptyListTerminals` — returns `status` and `lastDataAt` per seat, so
  idleness is observable, and `parentInstanceId` for the team-membership test.
- `/terminals/verb/` has **no verb allowlist** — the route at `LocalApiServer.ts:8137`
  delegates directly to `_handleTerminalVerb` (line 4351) without checking any generated
  allowlist. Any verb is reachable.

The fix is therefore entirely instructional. No new endpoints, no new
service seams, no host-parity work.

### Decisions taken (confirmed with the user)

- **The lead may implement the fix itself, but last** — only when the outstanding defect is
  small and localized, and only after the seat routes are exhausted. Lead context holds the
  whole feature state; burning it on implementation is the same hazard that
  "one subtask per cleared seat before rotation" guards against for coders.
- **The two-attempt cap stays, scoped per seat per context.** Clearing a seat and
  re-dispatching with named defects starts a fresh budget, hard-capped at one such reset per
  seat per subtask so it cannot loop. **Caveat:** this cap is prose in the prompt — the lead
  counts attempts in its own context, and rung 1 tells it to clear the *seat's* context (not
  the lead's), so the lead's count survives. But nothing enforces the cap mechanically; a
  lead that disregards it could loop. The cap is a prompt-level guardrail, not a host-level
  invariant.
- **Scope is the coding head prompt AND the KanbanProvider drive block.** The review-team
  head prompt has no attempt cap at all (adding one is new design, not a fix), and the
  mission-control orchestrator's equivalent dead end (`stallCount >= 3` → hard skip; "an
  escalated item must stay escalated") is unattended, where "try harder" carries real cost.
  Both are separate plans if wanted. The KanbanProvider drive block, however, is a
  coding-team prompt delivered to the same lead at feature dispatch time — it carries its
  own escalation rule and clear-terminal prohibition that directly conflict with the ladder.
  It MUST be updated in the same change or the ladder is dead on arrival.

## Metadata

**Complexity:** 6
**Tags:** backend, reliability, refactor

## User Review Required

## Complexity Audit

### Routine
- Text edit to the escalation clause in the two source copies of the coding head prompt (`teamWiring.ts:621` and `kanban.html:~5060`). The `terminals.js` client mirror is retired — see the Superseded callout in Complexity Audit.
- Text edit to the REVIEW line and two RULES lines in the KanbanProvider drive block.
- Updating/adding test assertions for pinned literals.

### Complex / Risky
- The three copies of `NEW_CODING_HEAD_PROMPT` have **already diverged** in source: `terminals.js` uses `POST /kanban/queue/next` and `against the port in .switchboard/api-server-port.txt` while `teamWiring.ts` and `kanban.html` use `run node "<cliPath>" next`. The byte-identity tests are either failing (source-based: `coding-head-prompt-contract.test.js`) or passing only against a stale `out/` build (`stage-marker-commit-contract.test.js`). This divergence must be resolved before or as part of the ladder edit — otherwise the byte-identity tests cannot pass after recompilation.

  > **Superseded:** "The three copies of `NEW_CODING_HEAD_PROMPT` have already diverged in source: `terminals.js` uses `POST /kanban/queue/next`..."
  > **Reason:** The `terminals.js` client mirror (`NEW_CODING_HEAD_PROMPT_CLIENT`) has been RETIRED. `teamWiring.ts:618` comment records the retirement, and `coding-head-prompt-contract.test.js` (lines 12-13, 70-73, 90-93) now asserts TWO-copy byte-identity (`teamWiring.ts` === `kanban.html`) AND that `NEW_CODING_HEAD_PROMPT_CLIENT` is ABSENT from `terminals.js`. There is no `terminals.js` copy to diverge or reunify. The "source-based test is currently failing" claim is itself stale — the test now passes from source against the two-copy + retirement contract.
  > **Replaced with:** Two copies remain: `teamWiring.ts:621` (`NEW_CODING_HEAD_PROMPT`) and `kanban.html:~5060` (Coding `headPrompt`), asserted byte-identical by `coding-head-prompt-contract.test.js:87`. Apply the escalation-clause replacement to both. The `terminals.js` reunification sub-step (Proposed Change #2) is obsolete — see the Superseded callout there.

- The KanbanProvider drive block (`KanbanProvider.ts:6024,6036-6037`) carries conflicting guidance: "context preserved; resend fixes to the same terminal" and "Manual ptyClearTerminal is for the stand-down case only." Rung 1 of the ladder prescribes the exact opposite. Both surfaces must be reconciled in the same change.
- The replacement text must not introduce `against the port in .switchboard/api-server-port.txt` into the head prompt — the drive block at `KanbanProvider.ts:5839` explicitly tells the lead "Do NOT read .switchboard/api-server-port.txt (the port is above)." The head prompt's ptyClearTerminal instruction should use host-neutral language (e.g. "POST /terminals/verb/ptyClearTerminal with {"name":"<the seat>"}") without referencing the port file.

## Edge-Case & Dependency Audit

### Race Conditions
- Rung 1 clears a seat and re-dispatches. If a callback from the seat's previous attempt arrives between the clear and the re-dispatch, the lead might process a stale report. Mitigation: the clear wipes the seat's context; any in-flight callback reports on the pre-clear state and should be discarded. The prompt should instruct the lead to ignore callbacks from a seat it has just cleared until the re-dispatch lands.
- Rung 2 (lateral hand-off) and the standing "dispatch the next subtask to an idle seat" rule could race if two subtasks are in flight. The ladder applies to a *failing* subtask; the standing rule applies to the *next* subtask. No conflict in principle, but the prompt should be clear that rung 2 is for the failing subtask, not a new one.

### Security
- No new endpoints or auth surfaces. All verbs used are already reachable.

### Side Effects
- `ptyClearTerminal` on a seat drops its `seatBlockCache` entry and `lastWorkContextByTerminal` entry (both hosts). This is the intended effect (fresh context) but also drops any deferred-clear state. The seat is fully reset.
- The drive block's RULES at `KanbanProvider.ts:6045` says "clearBeforePrompt stays false on every dispatch — the host overrides it to true automatically when the plan changes." Rung 1 manually clears via `ptyClearTerminal` *before* the re-dispatch, so `clearBeforePrompt: false` on the re-dispatch is correct (the seat is already clear). No double-clear.

### Dependencies & Conflicts
- **CRITICAL: KanbanProvider drive block conflict.** The drive block at `KanbanProvider.ts:6024` says "resend fixes to the same terminal (context preserved). Escalate after two failures on the same subtask: intern → coder → lead." This is the old vertical-only, context-preserved rule. It must be updated to reference the ladder or removed in favour of the head prompt's ladder. The drive block at `KanbanProvider.ts:6036-6037` says "Clear a terminal only when at rest" and "Manual ptyClearTerminal is for the stand-down case only." These must be updated to permit rung 1's clear-and-re-dispatch.
- **Three-copy divergence.** `terminals.js` `NEW_CODING_HEAD_PROMPT_CLIENT` (line 11478) has diverged from `teamWiring.ts` `NEW_CODING_HEAD_PROMPT` (line 613) and `kanban.html` Coding `headPrompt` (line 4804). The divergence is in the "next card" and "completion post" sections, not the escalation clause. The byte-identity tests (`coding-head-prompt-contract.test.js:84-90`, `stage-marker-commit-contract.test.js:357-361`, `standing-orders-marker-contract.test.js:448-455`) enforce byte-identity. The source-based test is currently failing; the compiled-based tests pass only because `out/` is stale. This divergence must be resolved before the ladder edit can produce a passing byte-identity check.

  > **Superseded:** the "three-copy divergence" and "source-based test is currently failing" claims above.
  > **Reason:** `NEW_CODING_HEAD_PROMPT_CLIENT` is RETIRED from `terminals.js` (`teamWiring.ts:618` comment; `coding-head-prompt-contract.test.js:70-73,90-93` asserts its ABSENCE). The test now asserts TWO-copy byte-identity (`teamWiring.ts` === `kanban.html`, line 87) and passes from source. There is no `terminals.js` copy and no failing source-based test.
  > **Replaced with:** Two copies (`teamWiring.ts:621`, `kanban.html:~5060`), asserted byte-identical. Apply the escalation-clause replacement to both; no reunification step.
- `standing-orders-marker-contract.test.js:462-468` asserts the head prompt includes `run node "<cliPath>" next --from "{head}"`. The replacement text must not alter this sentence (it is outside the escalation clause).
- `standing-orders-marker-contract.test.js:484-496` asserts the head prompt includes the exact unattended escalation sentence. The plan's replacement text preserves this as a substring (within rung 5), so the `includes` check passes.

## Dependencies

None — this is a standalone text edit.

## Adversarial Synthesis

Key risks: (1) the KanbanProvider drive block overrides the head prompt's ladder with conflicting "context preserved" and "stand-down case only" rules — the ladder is unreachable in practice unless the drive block is updated in the same change; (2) the head prompt exists in two byte-identical copies (`teamWiring.ts:621`, `kanban.html:~5060`) — both must receive the identical escalation-clause replacement or the byte-identity test fails (the `terminals.js` client mirror is retired; no reunification step); (3) the one-reset-per-seat cap is unenforceable prose — nothing counts resets mechanically. Mitigations: expand scope to include the drive block's REVIEW line and clear-terminal RULES; apply the same replacement to both copies; acknowledge the cap is a prompt-level guardrail only.

## Proposed Changes

### `src/services/teamWiring.ts` (line 621-648, `NEW_CODING_HEAD_PROMPT`)

**Context:** The escalation clause at lines ~633-636 is the terminal branch being replaced. The rest of the prompt (standing orders, completion post, next-card instruction) is unchanged.

**Logic:** Replace the sentence beginning "When a seat fails review on the same subtask twice…" through "…proceed to the next queue item)." with the five-rung ladder text. Do NOT use `against the port in .switchboard/api-server-port.txt` — the drive block forbids reading that file. Use host-neutral language: `POST /terminals/verb/ptyClearTerminal with {"name":"<the seat>"}`.

**Implementation:**

Replace:
```
When a seat fails review on the same subtask twice, do not send that subtask to it a third time — escalate one rung along intern → coder → lead, name the specific defects in the dispatch, and say in your status report which seat you moved it to and why; if the seat that failed twice is a lead, or your team has no seat above it, stop and report to the human instead of dispatching again (or unattended: record the blocked card to .switchboard/mission-control/reports/ and proceed to the next queue item).
```

With:
```
When a seat fails review on the same subtask twice, do not send that subtask to that seat in that same context again. Work down this ladder and take the first rung that applies, naming the specific defects in every dispatch: (1) clear that seat's context — POST /terminals/verb/ptyClearTerminal with {"name":"<the seat>"} — then re-dispatch the subtask to it with a prompt naming exactly what to fix; a cleared seat is a fresh attempt, not a third one, and you may do this once per seat per subtask; (2) hand the subtask to an idle seat on your team that has not worked on it, clearing it first if it holds unrelated context; (3) escalate one rung along intern → coder → lead; (4) if the outstanding fix is small and localized, make it yourself; (5) only when every rung above is exhausted, stop and report to the human instead of dispatching again (or unattended: record the blocked card to .switchboard/mission-control/reports/ and proceed to the next queue item). Say in your status report which rung you took and why. Never report a subtask blocked for want of a higher seat without having tried rungs 1, 2 and 4.
```

**Edge Cases:**
- The replacement must preserve every literal pinned by `stage-marker-commit-contract.test.js:387-408`: `intern → coder → lead`, `seat fails review on the same subtask twice`, `stop and report to the human instead of dispatching again`.
- Must contain no form of the word "advance" (`!/advanc/i`), no `targetColumn`, and no literal `/kanban/dispatch` — all asserted by the contract tests.
- Must not weaken the team-membership invariant. Rung 2 says "an idle seat **on your team**"; the prompt's standing rule that "a standalone seat of the same role is not yours to drive" is unchanged.
- Must not introduce `against the port in .switchboard/api-server-port.txt` — the head prompt should use host-neutral language (`POST /terminals/verb/ptyClearTerminal with {"name":"<the seat>"}`) so it stays portable to external/cloud agents. (The drive block's prior "Do NOT read api-server-port.txt" line is no longer present in `KanbanProvider.ts` — verified by grep — but the host-neutral-language rule still holds for the head prompt.)

### `src/webview/terminals.js` (line 11478-11509, `NEW_CODING_HEAD_PROMPT_CLIENT`)

> **Superseded:** The entire `terminals.js` sub-step — both the original "edit all three identically" instruction and the later "reunify `terminals.js` with `teamWiring.ts`" two-sub-step revision.
> **Reason:** `NEW_CODING_HEAD_PROMPT_CLIENT` is RETIRED from `terminals.js`. `teamWiring.ts:618` comment records the retirement; `coding-head-prompt-contract.test.js:70-73,90-93` asserts the constant is ABSENT from `terminals.js`. There is no `terminals.js` copy to edit, diverge, or reunify. The "source-based test is currently failing" claim was stale — the test now asserts two-copy identity and the retirement, and passes from source.
> **Replaced with:** No `terminals.js` change. Apply the escalation-clause replacement to the two surviving copies (`teamWiring.ts` and `kanban.html`) only. A coder who follows the original sub-step edits a file that no longer has the symbol and adds a reunification that is already done.

### `src/webview/kanban.html` (line ~5060, Coding team `headPrompt`)

**Context:** This copy matches `teamWiring.ts` in source (asserted byte-identical by `coding-head-prompt-contract.test.js:87`). Apply the same escalation-clause replacement.

**Implementation:** Replace the same escalation-clause sentence as in `teamWiring.ts`. No reunification needed — this copy already matches.

### `src/services/KanbanProvider.ts` (line 6024, 6036-6037, drive block)

**Context:** The drive block is composed at runtime by `_buildDrivePrefix` (line 5988) and prepended to the feature dispatch prompt when `feature_drive_enabled` is true. It is delivered to the lead at feature dispatch time — AFTER the head prompt (at team creation). It carries its own escalation rule and clear-terminal RULES that conflict with the ladder.

> **Superseded:** The plan originally scoped to "the coding head prompt only" and did not mention the KanbanProvider drive block.
> **Reason:** The drive block IS a coding-team prompt — it is composed for the coding team's lead and delivered at feature dispatch. It carries "resend fixes to the same terminal (context preserved). Escalate after two failures on the same subtask: intern → coder → lead" (line 6024) and "Manual ptyClearTerminal is for the stand-down case only" (line 6037). These directly contradict rung 1 (clear and re-dispatch) and the ladder concept. The lead receives both prompts; the drive block, delivered later with more operational specificity, would override the head prompt's ladder in practice.
> **Replaced with:** Expand scope to include three drive-block edits: (1) update the REVIEW line to reference the ladder; (2) update the "Clear a terminal only when at rest" RULE to permit rung 1's clear-and-re-dispatch; (3) update the "Manual ptyClearTerminal is for the stand-down case only" RULE to permit rung 1.

**Implementation:**

1. **Line 6024** — change:
   ```
   REVIEW: On callback, review git diff — not the coder's self-report. Coder self-report does not clear context; resend fixes to the same terminal (context preserved). Escalate after two failures on the same subtask: intern → coder → lead.
   ```
   to:
   ```
   REVIEW: On callback, review git diff — not the coder's self-report. Coder self-report does not clear context; resend fixes to the same terminal (context preserved). After two failures on the same subtask, follow the recovery ladder in your standing orders (clear and retry, lateral hand-off, vertical escalation, lead self-fix, stop) — do not escalate vertically without trying the cheaper rungs first.
   ```

2. **Line 6036** — change:
   ```
   - Clear a terminal only when at rest (completion received AND next work goes elsewhere).
   ```
   to:
   ```
   - Clear a terminal when at rest (completion received AND next work goes elsewhere), or when following rung 1 of the recovery ladder (clear and re-dispatch the same subtask with named defects). The ladder is in your standing orders.
   ```

3. **Line 6037** — change:
   ```
   - The host auto-clears the full team roster once when a new feature run starts, and clears the accepted coder when you POST /kanban/task/complete. Coder self-report does not clear context — do not manually clear between subtasks or fixes. Manual ptyClearTerminal is for the stand-down case only — a terminal you are putting away without dispatching new work to it.
   ```
   to:
   ```
   - The host auto-clears the full team roster once when a new feature run starts, and clears the accepted coder when you POST /kanban/task/complete. Coder self-report does not clear context — do not manually clear between subtasks or fixes. Manual ptyClearTerminal is for the stand-down case, or for rung 1 of the recovery ladder (clear a twice-failed seat and re-dispatch with named defects) — not for routine between-subtask clearing.
   ```

**Edge Cases:**
- The drive block is only composed when `feature_drive_enabled` is true. If the flag is off, the lead gets only the head prompt. The ladder still works in that case. The drive-block edit is a consistency fix for the enabled case.
- The drive block is runtime-composed (not a stored constant), so no migration is needed — the next feature dispatch picks up the new text.

### `src/test/stage-marker-commit-contract.test.js` (line 387-408)

**Context:** Pins load-bearing literals in `NEW_CODING_HEAD_PROMPT`. The three listed above survive the rewrite by design, so the existing assertions should pass unchanged — confirm rather than assume.

**Implementation:** Add assertions for the new guarantees:
- the prompt names `ptyClearTerminal` as an available recovery action;
- the prompt no longer contains the old dead-end fragment `'if the seat that failed twice is a lead, or your team has no seat above it, stop and report to the human'`;
- `stop and report to the human` appears only as the last rung (assert the prompt does not contain the old terminal-branch phrasing).

### `src/test/coding-head-prompt-contract.test.js` (line 84-90)

**Context:** The byte-identity assertions. The test now asserts TWO-copy byte-identity (`teamWiring.ts` === `kanban.html`, line 87) AND that `NEW_CODING_HEAD_PROMPT_CLIENT` is ABSENT from `terminals.js` (lines 70-73, 90-93). Both pass from source today.

**Implementation:** No test changes needed — the `terminals.js` reunification sub-step is obsolete (the constant is retired). Confirm all invariants pass after the two-copy escalation-clause replacement (the replacement is identical in both copies, so byte-identity holds).

### `src/test/standing-orders-marker-contract.test.js` (line 448-455, 462-468, 484-496)

**Context:** Asserts byte-identity between `kanban.html` and `teamWiring.ts` (line 448-455), and that the head prompt includes the `run node "<cliPath>" next` sentence (line 462-468) and the unattended escalation sentence (line 484-496). All three survive the rewrite by design.

**Implementation:** No test changes needed — confirm rather than assume. The byte-identity check (448-455) passes because `kanban.html` and `teamWiring.ts` already match in source and the escalation-clause replacement is identical in both. The `run node` sentence (462-468) is outside the escalation clause and unchanged. The unattended escalation sentence (484-496) is preserved as a substring within rung 5.

## Verification Plan

### Automated Tests
1. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/coding-head-prompt-contract.test.js` — all invariants pass, in particular the TWO-copy byte-identity check (`teamWiring.ts` === `kanban.html`, line 87) and the ABSENCE of `NEW_CODING_HEAD_PROMPT_CLIENT` from `terminals.js` (lines 70-73, 90-93). The `terminals.js` reunification sub-step is obsolete; no three-way check exists.
2. Run `src/test/stage-marker-commit-contract.test.js` — the pinned load-bearing literals still resolve and the new assertions pass. **Requires `npm run compile-tests` first** (imports from `out/`); after recompilation, the byte-identity check (line 357-361) passes because the two source copies are byte-identical.
3. Run `src/test/standing-orders-marker-contract.test.js` — byte-identity (448-455), `run node` sentence (462-468), and unattended escalation sentence (484-496) all pass.
4. `npx tsc --noEmit -p tsconfig.json` — no type regressions.

### Goal Invariants
- Assert `NEW_CODING_HEAD_PROMPT` in `src/services/teamWiring.ts` contains `ptyClearTerminal` and `recovery ladder` (or equivalent ladder phrasing).
- Assert `NEW_CODING_HEAD_PROMPT` does NOT contain `'if the seat that failed twice is a lead, or your team has no seat above it'` (the old dead-end fragment).
- Assert `NEW_CODING_HEAD_PROMPT_CLIENT` is ABSENT from `src/webview/terminals.js` (the client mirror is retired; `coding-head-prompt-contract.test.js:70-73,90-93` enforces this). Paired positive: `teamWiring.ts` and `kanban.html` remain byte-identical after the identical escalation-clause replacement.
- Assert the KanbanProvider drive block at `src/services/KanbanProvider.ts:6024` contains `recovery ladder` (or equivalent reference).
- Assert the KanbanProvider drive block at `src/services/KanbanProvider.ts:6037` contains `rung 1` (or equivalent permission for clear-and-re-dispatch).
- Assert `NEW_CODING_HEAD_PROMPT` does NOT contain `against the port in .switchboard/api-server-port.txt` (port-reference language kept out of the head prompt).

### Manual
5. Manual, extension host: create a fresh Coding team and confirm the lead's standing orders carry the ladder text.
6. Manual, standalone host: same check via the standalone bootstrap. No composition-root wiring changes here — `ptyClearTerminal` is already handled in both hosts (`bootstrap.ts:1954`, `TaskViewerProvider.ts:528`) — but confirm a standalone-spawned lead receives the new text, since both hosts read the same stored group.
7. Confirm a team created before this change still runs. It keeps the old clause (no migration by design); it must not error, and recreating the team must pick up the new text.
8. End-to-end: drive a subtask to two review failures on one seat and confirm the lead clears and re-prompts that seat rather than reporting blocked; then force rung 1 to fail and confirm it moves laterally to an idle team seat before escalating. **Verify with `feature_drive_enabled` ON** to confirm the drive block's updated RULES don't override the ladder.

## Outstanding Questions
- **[user]** The one-reset-per-seat cap is prose in the prompt — nothing enforces it mechanically. A lead that disregards it could clear-and-retry the same seat indefinitely. Should a host-level reset counter be added (separate plan), or is the prompt-level guardrail sufficient? — proceeding on the assumption that the prompt-level guardrail is sufficient for now, given that teams are unreleased dev work and the lead's own context (which is NOT cleared by rung 1) retains the count.

## No migration — teams are unreleased dev work

`headPrompt` is stored per agent group in the DB (`agentGroupInstantiation.ts:162` passes
`group?.headPrompt`), and the kanban.html value is a creation template, so editing the two
source copies governs **newly created teams only**. That would normally demand a
`migrateAgentGroups` step under the repo's migration rule.

It does not here: **the team/lead feature has only ever existed in unreleased dev work**, so it
takes a clean break — no migration, no compat shim, no frozen snapshot constant, no recogniser.
A group carrying the old clause is a dev-install artefact; recreate the team.

Do not add a migration step "just in case". A recogniser for text that never shipped is dead
code that later migrations have to keep matching against.

The KanbanProvider drive block is runtime-composed (not stored), so it needs no migration —
the next feature dispatch picks up the new text automatically.

## Implementation Summary

The terminal branch in the coding head prompt's escalation clause was replaced with a five-rung recovery ladder (clear-and-retry, lateral hand-off, vertical escalation, lead self-fix, stop) in both byte-identical copies (`teamWiring.ts:632-643` and `kanban.html:5059-5070`). The KanbanProvider drive block was reconciled: the REVIEW line now references the ladder, and the two clear-terminal RULES permit rung 1's clear-and-re-dispatch. The `standingOrderFragments.ts` copies (`CODING_HEAD_WORK` and `CODING_HEAD_WORK_WITH_ROUNDS`) were NOT edited — they are outside this plan's scope and carry the old vertical-only clause; a follow-up plan should reconcile them. Five new assertions were added to `stage-marker-commit-contract.test.js` pinning the ladder's presence and the old fragment's absence. The `coding-head-prompt-contract.test.js` byte-identity check passes; the `standing-orders-marker-contract.test.js` Coding headPrompt byte-identity check passes (3 pre-existing unrelated failures remain). The one-reset-per-seat cap is prose only — no host-level enforcement. No migration (teams are unreleased dev work). Compilation was intentionally skipped per the constrained-host directive; the source-based contract tests were run directly.

## Review Findings

Verified without changes. The five-rung ladder is present in both surviving copies and they remain byte-identical (`test:contract:coding-head-prompt` ALL PASSED, including the assertion that `NEW_CODING_HEAD_PROMPT_CLIENT` is absent from `terminals.js`); the old dead-end fragment is gone, `ptyClearTerminal` and `(1) clear` are present, `against the port in .switchboard/api-server-port.txt` is absent, and the five new assertions in `stage-marker-commit-contract.test.js` pass. The three drive-block edits at `KanbanProvider.ts:6085`, `:6097` and `:6098` are applied as specified — the REVIEW line names the ladder and both clear-terminal RULES permit rung 1. No files were changed by this review for this subtask. Validation: `test:contract:coding-head-prompt` ALL PASSED, `test:contract:stage-marker-commit` "NEW_CODING_HEAD_PROMPT keeps every load-bearing literal" passes, `tsc --noEmit` clean apart from four pre-existing TS2835 errors; manual steps 5-8 (fresh team in each host, the `feature_drive_enabled` ON end-to-end drive) were not executed in this pass.

## Deferred Findings

- MAJOR — the drive-block Goal Invariants have no automated check; nothing asserts `KanbanProvider.ts:6085` names the ladder or that `:6098` permits rung 1, so a future edit reverts them silently. `src/services/KanbanProvider.ts:6085`
- MAJOR (pre-existing, not this plan) — `test:contract:stage-marker-commit` reports 4 failures and `test:contract:standing-orders-definitions` 2, all from the uncommitted working-tree change making `loadEffectiveStandingOrders` read-time-only; `test:contract:standing-orders-marker` reports a **Review** headPrompt byte-identity drift, not the Coding one this plan edited. `src/services/teamWiring.ts:2101`
- NIT — the `standingOrderFragments.ts` copies (`CODING_HEAD_WORK`, `CODING_HEAD_WORK_WITH_ROUNDS`) still carry the old vertical-only escalation clause, as the implementation summary records. A lead reading those gets a rule the head prompt contradicts. `src/services/standingOrderFragments.ts`
- NIT — the one-reset-per-seat cap remains prose only, per the plan's Outstanding Question.
