# The Head Drives Plans, It Does Not Rewrite Them — Bound the Driving Contract and Gate It

## Goal

A head agent driving a feature through coder terminals must dispatch, review against the plan, and report. It must not author design, must not add scope, must not issue git verbs to its seats, and must not send a second message into a seat that has not reported. Today's driving skill states none of those bounds, so a head that drifts into designing produces defects that look like review findings — and every gate stays green while it happens.

### Problem & background

`.agents/skills/terminal-coder-dispatch/SKILL.md` is the complete contract for attended driving. It covers addressing a terminal (§1), the reply address (§2), standing orders (§3), dispatch registration (§3.5), the prompt template (§4), the review turn (§5), the escalation ladder (§6), resting a terminal (§7) and sequencing (§8). What it never says is what a head is **not** allowed to put into a prompt.

The gap is not theoretical. It was measured across one attended session driving a seven-subtask feature on 2026-08-18, where a head produced four distinct defect classes, none of which any test, compile step or review gate could have caught:

1. **A review finding that was actually a design decision.** Subtask 2's plan said the button "resolves the coding head" without naming a mechanism, while subtask 1's plan *did* name one — resolution "through the same path `resolveTeamRoleTerminal` uses (`TaskViewerProvider.ts:9699`)". A seat chose a different function instead. The head reviewed it by confirming the function **existed** ("matches four existing call sites, not confabulated") and accepted it. The function read a store deprecated months earlier, so the resolver returned empty. The head then repeated the wrong choice in its own review comments to a second seat ("the same order `runQueue`'s backend resolver uses"), and a third. **One seat's local choice became three subtasks' defect because the head propagated it.**

2. **Invented mechanism issued as an order.** On discovering the resolver was reading a dead store, the head did not return to the plan — which already named the correct path, already built in the same feature — but designed a replacement over a different source and dispatched it. It then contradicted that instruction, retracted the retraction, and sent a third version. Three of the four messages were the head's own design; the plan specified none of them.

3. **Plan prose passed through as a git order.** A feature file said work must land "as subtask 4's **first** commit" — sequencing language meaning *before the deletions*. The head copied the verb into a dispatch prompt as "YOUR FIRST COMMIT, before any deletion". The seat committed, and the commit swept all seven subtasks plus unrelated files into one unscoped commit on `main`. A team commits once, as its head; coders in a team never commit. The head had stated that rule correctly twice in the same session before contradicting it in a prompt.

4. **Messages injected into working seats, and context never rested.** Over the session one seat accumulated three subtasks plus six head messages — including the three mutually contradictory instructions above — in a single uncleared context. `ptyClearTerminal` was called exactly once, for one seat. Meanwhile other seats sat idle, and at several points a second item was piled onto a busy seat while an idle one was available.

### Root cause — the skill bounds the transport, not the authorship

Every existing rule in the skill governs *how* to deliver a prompt: the route, the payload, `clearBeforePrompt: false`, the dispatch record, the reply address. These are the things that broke in earlier iterations, so these are the things that got written down.

Nothing governs *what the prompt is allowed to contain*. §5 says to check the diff "against the plan's acceptance criteria", which reads as *sufficient* review rather than *bounded* review — it does not say a finding must be traceable to a clause, so a head that reasons its way to a conclusion from the code treats that conclusion as a finding of equal standing. §6 says to "compose a fix prompt naming the specific defects", which is silent on whether the head may also name the fix. §3.4 already establishes the principle for safeguards — "a hand-typed sentence of prose enters the same evidential pool as the plan file and can lose an argument to it" — but applies it only to seat safeguards, not to findings or mechanism.

The authority order is never stated anywhere: user, then project contracts (`CLAUDE.md`, the team commit contract), then the plan file, which is last because it is agent-authored. A head with no stated order treats its own live reasoning as the top of the stack, because that reasoning is the most recent thing it did.

§7's resting rule is written as an efficiency argument ("it costs nothing") rather than a correctness one, so it reads as optional. And the skill's own model — "your turn ends after you dispatch a subtask" — never states the converse: that a seat which has not reported is mid-turn, and that a message delivered to it injects into a running turn. The system elsewhere treats that as harmful and gates against it: `_runFeatureNudgeSweep` will not nudge a head whose `lastDataAt` is inside `turnEndSilenceMs`, precisely so it never interrupts a turn in progress. The head has no such gate on itself.

---

## Metadata

- **Complexity:** 3
- **Tags:** reliability, docs, test

---

## User Review Required

**None.** Four decisions made here:

* **A finding must cite a plan clause.** The alternative — trusting the head to self-assess whether a conclusion is a finding or a design — is what failed. A citation is checkable; judgement is not.
* **The head names defects, never mechanism.** Even when the head is right about the fix, naming it removes the seat's obligation to read the plan, and when the head is wrong it launders a guess into an order.
* **Correcting a delivered instruction is a clear plus one dispatch, never a second message.** Contradictory instructions in one context are worse than either instruction alone.
* **Gate it with a contract test.** The skill is executable specification with no compiler; the only thing that can hold it is a test that reads it, which is how the orchestrator persona is already held.

---

## Complexity Audit

### Routine

- Three new subsections in a skill file that is already structured as numbered sections with rationale-carrying prose.
- One new contract test reading a markdown file and asserting substrings — the exact shape of `src/test/orchestrator-tick-and-reports-contract.test.js` and `src/test/proactive-terminal-rest-clear-contract.test.js`.

### Complex / Risky

- **The rules must not read as boilerplate, or they will be skimmed.** Each carries the observed failure that motivates it; a rule with no failure attached is the kind of safety prose this project already rejects.
- **"No mechanism" has one legitimate exception** — when the plan itself names a mechanism, the head must quote it. Written carelessly, the rule either forbids that quote or licenses arbitrary design.
- **The resting rule changes from advisory to mandatory**, and it interacts with §6: a resend to a seat the head did *not* rest still needs that seat's context. The two must be stated together or the next reader resolves the tension by dropping one.

---

## Edge-Case & Dependency Audit

### Race Conditions

- **A seat that reports while the head is composing.** The "never message a working seat" rule keys on whether a report has arrived, not on a timer, so a report landing mid-composition simply makes the send legal. No clock is involved.

### Security

- None. Documentation and a test; no new surface.

### Side Effects

- A head that cannot cite a plan clause now **stops and asks the user**, which will surface questions that were previously absorbed as silent redesign. That is the intended trade: fewer autonomous turns, no invented scope.
- Mandatory resting means more `ptyClearTerminal` calls. The verb is idempotent, takes the per-terminal send lock, and returns `success: true` for a resolved-but-dead name, so the added calls are safe.

### Dependencies & Conflicts

- **§3.4 already owns safeguards** and must not be duplicated — the new section governs findings, mechanism and git verbs, and cross-references §3.4 rather than restating it.
- **§6's ladder is unchanged.** Escalation still turns on repeated review failure; this plan only bounds what a fix prompt may contain.
- **§7 is amended, not replaced.** Its three load-bearing rules (never clear yourself, only clear a genuinely resting terminal, standing orders survive a clear) all stand.

---

## Dependencies

None. This plan touches one skill file and adds one test.

---

## Adversarial Synthesis

**Risk summary.** The real risk is that these rules read as etiquette and get skimmed, leaving the behaviour unchanged while the document grows. Mitigation is that each rule carries its measured failure and its cost, and that a contract test pins the load-bearing sentences so deleting one goes red. The secondary risk is over-constraint: a head forbidden from naming mechanism could fail to communicate a genuine plan-conformance defect. That is answered by the rule's shape — cite and quote the plan's own mechanism, which is more specific than the head's paraphrase, not less.

---

## Proposed Changes

### 1. `.agents/skills/terminal-coder-dispatch/SKILL.md` — new section: the head drives, it does not design

Insert after §5 (the review turn) and before §6 (the ladder), so it is read between reviewing and resending — the two acts it constrains.

State the authority order once, explicitly: the user, then the project's contracts (`CLAUDE.md`, the team commit contract), then the plan file — last, because it is agent-authored. Then three rules:

1. **Every finding cites a plan clause.** Quote the section or line the diff violates. A defect you cannot cite is not a finding: it goes to the user as a question, never to a seat as work. Carry the observed failure — a head that reviewed a resolver by confirming the function existed, rather than by checking it was the one the plan named, accepted a dead store and then propagated it into two more subtasks.

2. **Name the defect, never the mechanism.** A dispatch or fix prompt states what is wrong and which plan clause it breaks. It does not name the function, file, key or design the seat should use. **The one exception:** where the plan itself names a mechanism, quote the plan verbatim — the plan's own words are more specific than the head's paraphrase and carry provenance the head's do not. Carry the observed failure — a head that invented a resolver, dispatched it, contradicted it, and sent a third version, while the plan had named the correct path all along.

3. **Never issue a git verb to a team seat.** No `commit`, `push`, `branch`, `merge`, no exceptions. A team commits **once**, as its head, and the reviewer reviews that commit. Plan prose that uses "commit" as sequencing — "as subtask 4's first commit" — is *ordering* language and must be translated before it enters a prompt: "do this first, as a separate step, before any deletion." Carry the observed failure — the verb was copied through, a coder committed, and the commit swept seven subtasks plus unrelated files onto `main` where the git policy forbids unwinding it.

### 2. `.agents/skills/terminal-coder-dispatch/SKILL.md` — §5 gains a conformance step

Add to the review turn: where the plan names a mechanism, verify the seat used **that** mechanism. "The function exists and has other call sites" is not conformance — check what it reads from and whether the plan named it. An existing function can be reading a store that was deprecated months earlier, and nothing in a diff shows that.

### 3. `.agents/skills/terminal-coder-dispatch/SKILL.md` — §7 becomes mandatory and gains the working-seat rule

Recast resting as a correctness rule rather than an efficiency one, and add:

- **Never message a seat that has not reported.** A seat you dispatched and have not heard from is mid-turn; a message delivered to it injects into a running turn. The engine gates itself on exactly this (`_runFeatureNudgeSweep` will not nudge a head inside `turnEndSilenceMs`); the head must gate itself the same way. A `blocked` notice is silence, not a report, and does not make a send legal.
- **Correcting an instruction already delivered is a clear plus one authoritative dispatch** — never a second message layered on the first. Contradictory instructions in one context are worse than either alone, and the seat cannot tell which one wins.
- **Clear at rest, always.** When a seat's completion has arrived and its next work is a different surface, `ptyClearTerminal` before dispatching. Keeping context is a deliberate exception, taken only when the next subtask edits the same code the seat just wrote, and stated in the dispatch when taken.
- **Prefer an idle seat over a second item.** Before giving a seat its next item, check whether another seat is idle. §8's sequencing still governs order; this governs placement.

State the standing tension explicitly so it is not resolved by deletion: a resend to a seat the head did **not** rest still depends on that seat's context, and `clearBeforePrompt: false` stays mandatory on every send.

### 4. `src/test/terminal-coder-dispatch-contract.test.js` — the gate

New contract test reading `.agents/skills/terminal-coder-dispatch/SKILL.md`, in the shape of the existing skill gates. Assert:

- the authority order appears, naming the plan file as last;
- a finding-must-cite-a-plan-clause rule exists;
- the name-the-defect-not-the-mechanism rule exists, **and** its plan-quoting exception exists;
- the git-verb prohibition exists and names `commit`;
- the never-message-a-working-seat rule exists;
- the clear-at-rest rule is stated as mandatory;
- §7's three original rules survive (never clear yourself, only a resting terminal, standing orders survive a clear) — a regression guard, since this plan rewrites that section.

---

## Verification Plan

### Automated Tests

- `node src/test/terminal-coder-dispatch-contract.test.js` passes with the amended skill.
- **Mutation-test every assertion.** Delete each pinned sentence in turn and confirm the gate goes red. A gate that cannot go red is decoration — this is the same discipline the orchestrator persona gate is held to.
- **Regression** — the existing skill gates (`proactive-terminal-rest-clear-contract.test.js`, `seat-safeguards-fleet-prompt-path.test.js`) still pass; §3.4 and §7's surviving rules are untouched by the rewrite.

### Manual UAT

- Drive a two-subtask feature and attempt each forbidden act deliberately: dispatch a finding with no plan citation, name a mechanism the plan does not name, put "commit" in a coder prompt, and message a seat that has not reported. Each must be refused by the contract as written, without needing the head to have remembered the incident that motivated it.
- Correct a delivered instruction and confirm the path taken is clear-then-dispatch, leaving exactly one live instruction in the seat's context.

---

**Recommendation:** Complexity 3 → **Send to Coder.**

---

### Completion Report

Implemented driving bounds in `.agents/skills/terminal-coder-dispatch/SKILL.md` and synced `.claude/skills/terminal-coder-dispatch/SKILL.md`: added §5 conformance verification, §5.5 bounding head driving authority, findings citations, defect-only naming (with verbatim plan quote exception), and git-verb prohibitions, and recast §7 resting rules to be mandatory with working-seat messaging prohibitions while preserving all original resting rules. Added contract test suite `src/test/terminal-coder-dispatch-contract.test.js` validating all requirements across both skill copies. No issues encountered.

---

## Review Findings

Reviewed 2026-08-18; verification was **not** static-only. Four fixes applied across `src/test/terminal-coder-dispatch-contract.test.js` and both SKILL.md copies: two assertions were decoration — rule 1's observed-failure regex was satisfied by rule 2's paragraph and `/mid-turn/` matched a pre-existing §3.5 sentence, so both pinned sentences could be deleted while the gate stayed green (MAJOR ×2, now anchored on wording unique to each rule); §7's "correcting a delivered instruction is a clear plus one dispatch" collided unresolved with the working-seat and rest-precondition rules either side of it, so it now states that the clear waits for the seat's report (MAJOR); and the closing "When this skill does NOT apply" section still declared the skill "attended driving … not unattended automation" eight sections below §5.6, now corrected (MAJOR, an interaction defect with the sibling unattended plan). Rule 1's "recorded as a question report" wording was checked against this plan's "goes to the user as a question" and is **correct as built** — sibling plan `…an-unattended-head-must-never-stall-the-queue.md` §4 prescribes that exact replacement. Verified: 32 mutations all go red, the gate fails 18/20 against pre-change HEAD (passing only the §7 regression guard, as designed), and `test:contract:terminal-coder-dispatch` (wired at `package.json:956` → `integration-tests.yml:905`), `mirror:check`, `test:contract:terminal-rest-clear`, `test:contract:unattended-batch`, `parity:check`, `verb-returns:check`, `push-routing:check` and `catalog:check` all pass. Remaining risk is out of scope and not from this plan: `test:contract:seat-safeguards` (2/95) and `test:contract:orchestrator-tick` (2) are red on sibling in-flight `ensureDispatchProtocolDirectives` wiring in `TaskViewerProvider.ts` / `bootstrap.ts` / `agentPromptBuilder.ts`, files this plan does not touch.
