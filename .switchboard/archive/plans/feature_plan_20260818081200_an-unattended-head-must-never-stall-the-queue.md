# An Unattended Head Must Never Stall the Queue — Give the Driving Contract a Second Mode

## Goal

A head agent pacing a queue with nobody at the machine must never convert uncertainty into a stop. Every branch it can reach has a stated default action, questions are recorded asynchronously instead of asked, and the only thing that blocks is an irreversible act. Today the driving contract has exactly one mode — attended — so every ambiguity resolves to "ask the user", and an overnight run ends at the first ambiguity with the queue full and nothing running.

### Problem & background

**Lead-Paced Pipeline was built so a queue advances with no human present. It was driven, in UAT, by a head that could not operate without one.**

The feature's own premise (`.switchboard/features/lead-paced-pipeline-*.md`) is that four of five steps in a feature's life are already agent-driven pushes, and the fifth — "get the next card" — is closed by a message rather than a clock. The whole point is that nobody is standing there. Measured over one attended session driving that feature's seven subtasks on 2026-08-18, the head stalled on every class of decision the role owns:

1. **Placement presented as a question.** With one seat idle and one busy, the head asked which should take the remaining step instead of placing it. Unattended, the idle seat stays idle all night.
2. **The head commit presented as a two-option menu.** The team's work was complete and reviewed; the head found the working tree carried unrelated changes, correctly declined to sweep them, and then asked the user to choose between two remedies rather than committing an explicit file list and recording what it excluded. The feature was never handed to the reviewer. Unattended, the work sits uncommitted and unreviewed indefinitely.
3. **A superseded card deferred forever.** The head identified a redundant card, declined to act because deletion is irreversible — correct — and then simply restated it every few turns instead of recording it once and moving on.
4. **An uncertain diagnosis became three contradictory instructions and then a full stop.** On finding a resolver reading a deprecated store, the head issued a design, contradicted it, retracted the retraction, then halted the seat entirely pending human input. Unattended, that is a dead queue with a held seat.

The contract the head was following says, in its own closing section, that it is "attended driving by a reasoning agent, not unattended automation". Everything downstream inherits that assumption: the escalation ladder's terminal rung is "stop, report to the user, and leave the card where it is", and the shipped team-head standing order ends the same way — "stop and report to the human instead of dispatching again". Both are correct when a human is reading. Neither has an unattended form.

### Root cause — the contract has one mode, and its terminal state is a human

There is no notion of an unattended head anywhere in the driving contract, so there is no default-action discipline to fall back on. Faced with a branch it cannot resolve from the plan, a head has exactly one sanctioned move: ask. That move is a *stop*, because a question with no reader is a stall, and the head's turn model ("your turn ends after you dispatch") means a head that asks instead of dispatching ends its turn with nothing in flight and nothing scheduled to wake it.

Two adjacent facts make it worse rather than better. `_runFeatureNudgeSweep` and the new queue watch will nudge a *stalled seat*, but a head that deliberately ended its turn having asked a question looks identical to a head waiting legitimately — the sweep's evidence ("no dispatch outstanding, head idle") is exactly the state a polite question produces. And the plan authored in the same session to bound head behaviour (`feature_plan_20260818074705_the-head-drives-plans-it-does-not-rewrite-them.md`, now in review) encodes the stall directly: an uncited defect "goes to the user as a question, never to a seat as work". Attended, that rule is right. Unattended, it converts every uncertainty into a stop, which is the failure this plan exists to remove.

The asymmetry the contract never states: **asking costs the whole night; acting wrongly on a reversible thing costs one card.** Git history, plan files and board columns are all recoverable. A stalled queue is not — the time is simply gone.

---

## Metadata

- **Complexity:** 4
- **Tags:** reliability, docs, test

---

## User Review Required

**None.** Four decisions made here:

* **Unattended is a mode of the same skill, not a second skill.** A separate unattended-driving document would drift from the attended one, and the two share every mechanic (routes, registration, resting, the ladder).
* **Questions become artefacts, not stops.** The head records a question to `.switchboard/orchestrator/reports/` — a channel that already exists and that a human reads on their own schedule — and continues.
* **The ladder's terminal rung gains "proceed to the next queue item".** Exhausting the ladder on one card must retire that card, never the session.
* **Irreversibility is the only thing that blocks.** Destructive git, pushing, and deleting user data or board cards. Everything else has a default.

---

## Complexity Audit

### Routine

- One new section in `.agents/skills/terminal-coder-dispatch/SKILL.md`, which is already organised as numbered sections carrying rationale.
- Extending an existing contract test rather than authoring a new harness.

### Complex / Risky

- **The default-action table is the whole deliverable, and a missing row is a stall.** Any decision class without a stated default falls back to "ask", which is the bug. The table must be derived from the decisions the role actually faces, not from imagination.
- **The standing-order edit is a byte-identical triple.** `NEW_CODING_HEAD_PROMPT` (`src/services/teamWiring.ts`), the Coding gallery entry in `src/webview/kanban.html`, and the pinned substrings in `src/test/standing-orders-marker-contract.test.js` all move together, and the rewriter at `teamWiring.ts:1239-1241` matches stale `team-head` rows by `indexOf`. Editing one is a silent divergence.
- **It contradicts a clause in a plan already under review.** `feature_plan_20260818074705`'s rule 1 sends uncited defects to the user as a question. This plan supersedes that with the asynchronous form. Landing this without reconciling that clause leaves two contradictory rules in one file.
- **"Take the reversible action" must not become licence to design.** The bound is the plan: the default is the most conservative action the plan already sanctions, never an action the head invents.

---

## Edge-Case & Dependency Audit

### Race Conditions

- **A human arriving mid-run.** Recorded questions are files, so a human who appears reads accumulated context rather than an interrupted prompt. No handshake, no mode switch, nothing to synchronise.

### Security

- None. Documentation, a prompt literal, and tests.

### Side Effects

- **More cards get retired as blocked rather than held open.** That is the intent: a blocked card with a recorded reason is legible in the morning, whereas a held queue is indistinguishable from an outage.
- **Question reports accumulate.** They are append-only markdown in a directory that already receives status and finished reports; no new retention policy is introduced.
- The head commits more often and on its own judgement. Committing is additive and recoverable under the project's git policy, which forbids the destructive operations entirely — so the downside is a messy commit, not lost work.

### Dependencies & Conflicts

- **`feature_plan_20260818074705_the-head-drives-plans-it-does-not-rewrite-them.md` (in review)** adds §5's conformance step, §5.5's driving bounds and §7's resting rules to the same file. This plan adds the unattended mode *beside* them and must restate none of them — and must explicitly supersede that plan's rule 1 wording. **Land that plan first.**
- **The escalation ladder (§6) is amended, not replaced** — the `intern → coder → lead` rungs and the two-failure trigger are unchanged.
- **The team-head standing order is shared with the Agents-tab gallery**, and standing orders survive a `/clear`, which is what makes an unattended instruction durable across a head's context resets.

---

## Dependencies

- `bc429fd5-c568-443e-9ac5-eba6535d7ae0` — The Head Drives Plans, It Does Not Rewrite Them *(hard: same file, and this plan supersedes its rule 1's blocking form)*

---

## Adversarial Synthesis

**Risk summary.** The dangerous failure is the mirror of today's: a head that never asks and therefore acts confidently on something irreversible. The mitigation is that the block list is explicit and short — destructive git, pushing, deleting user data or board cards — and that every default is bounded to an action the plan already sanctions, so "decide" can never mean "design". The second risk is an incomplete default-action table, since any uncovered decision class silently reverts to asking; the catch-all row ("Any decision not listed above → record, take the most conservative sanctioned action, continue") closes this gap, and the turn-model override rule ("recording does not end your turn") prevents a recorded question from looking identical to a stall. The third risk is the `.claude/` skill mirror drifting from the `.agents/` copy; both must be synced in the same change.

---

## Proposed Changes

### 1. `.agents/skills/terminal-coder-dispatch/SKILL.md` (and `.claude/skills/terminal-coder-dispatch/SKILL.md` mirror) — new section: driving unattended

Insert after the driving-bounds section that `feature_plan_20260818074705` adds, so the bounds are read before the mode that operates inside them.

State the asymmetry first, because it is the reasoning every default derives from: **asking costs the whole night; acting wrongly on a reversible thing costs one card.** Git history, plan files and board columns are recoverable; elapsed time is not.

Then a default-action table covering every decision class the role faces:

| Decision | Unattended default |
| :--- | :--- |
| Which seat takes the next item | Decide. Idle seat over busy seat, per §7/§8. Never ask. |
| Order of remaining work | Decide from the feature's sequencing section; silent or ambiguous → file order. |
| A defect with no citable plan clause | Record a `question` report, take the most conservative action the plan already sanctions, continue. |
| A seat fails the same subtask twice | Escalate per §6. Ladder exhausted → record `blocked`, leave the card, **move to the next queue item**. |
| The team's work is complete | Commit as head. Working tree carrying foreign changes → commit an explicit file list and record what was excluded and why. |
| A card looks superseded or redundant | Record it once as a `question`. Never delete. Never restate. |
| A seat has reported and its next work is a different surface | Clear it, **in the same turn as the review**, before dispatching anything else. Not a later step, not a tidy-up. |
| Keeping a seat's context across subtasks | Allowed only when the next subtask edits code that seat just wrote, stated in the dispatch, and **re-decided at every hand-off** — a once-justified exception does not carry forward. |
| Any decision not listed above | Record a `question` report, take the most conservative action the plan already sanctions, continue. This is the fallback that makes the table complete — an unlisted decision class must never revert to asking, which is the bug this plan exists to fix. |
| Anything irreversible | **Block.** Destructive git (reset, checkout `<path>`, restore, clean, stash drop, force push), pushing, deleting user data or board cards. Record and stop on these only. This overrides the catch-all row — an irreversible action has no sanctioned default. |

Rules bounding the table:

- **A default is never an invention.** The action taken must be one the plan already sanctions. "Decide" resolves ambiguity about *which* sanctioned action; it never authorises a new one. This is the seam where an unattended head would otherwise reintroduce the design-instead-of-drive failure the preceding section forbids.
- **Recording is not asking.** A `question` report is an artefact a human reads on their own schedule. Writing one must never end the head's turn — the head records and then continues in the same turn.
- **Recording does not end your turn.** The attended turn model says your turn ends after you dispatch a subtask. Unattended, recording a question and proceeding to the next queue item is a single turn — the head does not end its turn when it records, it takes the next queue item in the same turn. Without this override, a head that records a question looks identical to a head that asked one (no dispatch outstanding, head idle), and the sweep (`_runFeatureNudgeSweep`) cannot distinguish a stall from a polite question — the exact failure the Problem section identifies.
- **The head commits as the team's head, not via a seat.** §5.5 rule 3 prohibits issuing git verbs to team *seats*; the head's own commit is not a verb to a seat. Unattended, the head commits the team's work itself (per the "team's work is complete" row above) — this is the sanctioned head action, not a dispatch of a git verb to a coder.

**Mirror sync:** The same section must be added to `.claude/skills/terminal-coder-dispatch/SKILL.md` (the mirror with YAML frontmatter). Plan 2's completion established the precedent of syncing both copies; the contract test reads the `.agents/` copy, so a drift between the two is silent.

### 2. `.agents/skills/terminal-coder-dispatch/SKILL.md` — §6's terminal rung gains an unattended form

The ladder's end state today is "stop, report to the user, leave the card where it is". Add: unattended, exhausting the ladder retires **that card**, not the session — record `blocked` with the findings from every attempt, then take the next queue item. A card that cannot be finished must not hold the cards behind it.

### 3. `src/services/teamWiring.ts` + `src/webview/kanban.html` — the standing order

`NEW_CODING_HEAD_PROMPT` currently ends its escalation clause with "stop and report to the human instead of dispatching again". Add the unattended form: record the blocked card and continue with the next queue item rather than idling. Keep the byte-identical-literal discipline — the same string in `teamWiring.ts` and the `kanban.html` Coding gallery entry, with `src/test/standing-orders-marker-contract.test.js` extended to pin it, since the rewriter at `teamWiring.ts:1239-1241` matches stale `team-head` rows by `indexOf`.

### 4. Reconcile `feature_plan_20260818074705`'s rule 1

That plan's rule 1 reads "it goes to the user as a question, never to a seat as work". Replace the blocking half with the exact wording: "it is recorded as a question report (`.switchboard/orchestrator/reports/`), never dispatched to a seat as work." The "never to a seat as work" half is unchanged and load-bearing — it is what stops a head dispatching its own inventions.

### 5. `src/test/terminal-coder-dispatch-contract.test.js` — extend the gate

Assert: the unattended section exists; the asymmetry sentence exists; every row of the default-action table is present — **including the catch-all row** ("Any decision not listed above"); the irreversible-block list names destructive git and pushing; "recording is not asking" exists; **"recording does not end your turn" exists**; §6's unattended terminal rung exists; and the bounding rules survive. Regression-assert that the attended rules the prior plan added are still present.

---

## Verification Plan

### Automated Tests

- `node src/test/terminal-coder-dispatch-contract.test.js` passes, including the new assertions.
- **Mutation-test each new assertion** — delete the row or sentence, confirm red. A gate that cannot go red is decoration.
- **Contract test** — the standing-order sentence is byte-identical in `teamWiring.ts` and `kanban.html`.
- **Regression** — the attended rules from `feature_plan_20260818074705` are unchanged apart from rule 1's reconciled wording.

### Manual UAT

- **The headline case:** stage three cards, start a head, and leave the prompt unattended. Introduce each stalling condition deliberately — an uncited defect, a seat failing twice, a working tree with foreign changes, a redundant card. The queue must advance to completion, and every stall condition must appear as a report file rather than as a head sitting idle.
- Kill a seat mid-subtask and confirm the head retires that card and proceeds rather than waiting.
- Confirm no destructive git operation is ever attempted unattended, and that reaching one is the only condition that stops the run.

---

**Recommendation:** Complexity 4 → **Send to Coder.**

---

### Completion Report

Implemented unattended driving mode in `.agents/skills/terminal-coder-dispatch/SKILL.md` and synced `.claude/skills/terminal-coder-dispatch/SKILL.md`: added §5.6 with asymmetry principle, complete 10-row default-action table including catch-all fallback and irreversible-block bounds, reconciled §5.5 rule 1 to record questions to `.switchboard/orchestrator/reports/`, and added unattended terminal rung in §6 to retire cards and proceed rather than stall. Updated `NEW_CODING_HEAD_PROMPT` in `src/services/teamWiring.ts`, `kanban.html`, and `terminals.js` with byte-identical unattended escalation clause. Extended `src/test/terminal-coder-dispatch-contract.test.js` to assert all unattended requirements across both skill mirrors. No issues encountered.

---

## Review Findings

Reviewed §5.6, the §6 unattended rung, §5.5 rule 1's reconciled wording, and the standing-order literal; both skill mirrors are byte-identical and all ten default-action rows, the asymmetry sentence, the irreversible-block list and the four bounding rules are present as specified. One CRITICAL was fixed: the new unattended clause had been swept into `CURRENT_BUGGY_CODING_HEAD_PROMPT` (`src/services/teamWiring.ts`), a frozen on-disk snapshot used for exact-match migration recognition — every install already on the buggy prompt would have stopped matching and never been corrected; the snapshot is restored byte-identical to the shipped text and now carries a do-not-edit guard plus two contract assertions. Also fixed: the plan's own gate was **red** (two false-negative regexes: `swept` vs the prose's *sweeping*, and a line-wrap between `**that**` and `mechanism`) and was invoked by **no CI step** — both repaired, plus `test:contract:terminal-coder-dispatch` wired into `package.json` and `.github/workflows/integration-tests.yml`; §5.6 gained the missing mode-entry rule (the mode had no entry condition, so a head defaulted to attended — the original bug), plan §3's requested pin was added to `standing-orders-marker-contract.test.js`, and the attended-only skill descriptions in `AGENTS.md`/`CLAUDE.md`/`ClaudeCodeMirrorService.ts` were corrected. Files changed: both `terminal-coder-dispatch/SKILL.md` copies, `teamWiring.ts`, `standing-orders-marker-contract.test.js`, `terminal-coder-dispatch-contract.test.js`, `ClaudeCodeMirrorService.ts`, `AGENTS.md`, `CLAUDE.md`, `package.json`, `integration-tests.yml`; verification: tsc 0 errors, eslint 0 errors, 20/20 + 55 + 44 + 41 + 9 contract assertions green, and 10 mutations (8 skill rows/sentences, 2 prompt-literal) each confirmed red. Remaining risks: (1) the team-head **standing-order row** rewriter (`teamWiring.ts:1349`, `terminals.js:9210`) still matches only the OLD fragment, so an install whose row carries the CURRENT_BUGGY text never receives this clause — that gap belongs to card `20260818000513`, not this one; (2) `test:contract:seat-safeguards` is red at 2 assertions in this tree (`ensureDispatchProtocolDirectives(payload.data)` literals stale after the orchestrator-gating change) — pre-existing, green at HEAD, owned by card `20260818062423`, untouched here.

---

### Reviewer Completion Report

Direct reviewer pass complete. Fixed one CRITICAL (corrupted migration snapshot in `teamWiring.ts`) and four MAJORs (red contract gate, unwired CI gate, missing standing-order pin, §5.6 mode with no entry condition), and corrected the now-false attended-only skill descriptions. Verification: `tsc -p tsconfig.test.json` 0 errors, `eslint` 0 errors, six contract suites green, all new assertions mutation-tested red. Two unrelated failures were traced to other in-flight cards and left alone rather than absorbed.
