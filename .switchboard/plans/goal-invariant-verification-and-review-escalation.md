# Make the reviewer assess the goal, not just the steps

## Goal

Make it structurally impossible for a review pass to satisfy a plan's mechanics while reversing its purpose, and make it impossible for a change to pass every local gate while being dead on a user install. Both failures happened in the same commit, both were invisible to every existing check, and neither was concealed — the machinery simply never asked the questions that would have caught them.

### Problem Analysis

**The incident.** `move-protocols-out-of-skill-discovery.md` moved 33 protocol definitions out of `.agents/skills/` so CLI skill discovery would stop injecting their names and descriptions into every system prompt. Destination: `.switchboard/protocols/`.

A reviewer pass (`33d4f3d`) found a genuine CRITICAL:

> "`.vscodeignore` excludes `.switchboard/**`, and neither seeding path … copies anything outside `.agents/`. All 33 protocols and every path reference the extension emits were dead on any user install, while grep/compile/lint/manual checks all passed because the files exist in this repo."

The fix relocated them to `.agents/protocols/`, rewrote ~45 references across 31 files, and added compatibility keys to `RETIRED_WORKFLOW_PATH_MAP`. Shipping was restored. The token goal was preserved. And the plan's other purpose — getting 424K of non-discoverable content out of the scaffolded workspace — was silently dropped, because the work now put it back in `.agents/`.

Nothing in the process was dishonest. The commit message states plainly what it did and why. The gap is that **no gate compared the outcome to the plan's purpose**, and no human was asked to approve a change of destination.

**Failure 1 — the reviewer assesses the change against the plan's *steps*, not its *goal*.**

`agentPromptBuilder.ts:1842` composes the reviewer around:

> "assess the actual code changes against the **plan requirements** inline, fix valid material issues, then verify."

"Plan requirements" resolves in practice to the listed implementation steps. A reviewer that satisfies every step has done its job by that instruction, even when the outcome inverts what the plan was for — the protocols were relocated (steps satisfied, shipping restored) while the goal (out of the scaffold) was reversed, and nothing asked the second question.

**Intent checking belongs to the reviewer, not to an optional role.** Switchboard does have an intent reviewer — the acceptance tester (`agentPromptBuilder.ts:1948`) is the "Product Acceptance / Intent Reviewer", and its base text names this failure mode exactly: *"Flag both directions: requirements/intent not met, and code that satisfies the plan's letter but misses the product's intent."* But that role is deliberately additional, its `ACCEPTANCE TESTED` column carries `autobanEnabled: false` so nothing advances into it, and it is not run in practice because the observed intent-failure rate does not justify its token cost. A fundamental check must not depend on an optional role.

Its baseline also would not have caught this. The tester measures against *"the PRD as the primary intent baseline… the plan as the implementation record (not the yardstick)"*. The protocols move was internal refactoring with no PRD entry — "remove 424K of scaffold from every user repo" is not a product requirement — so the intent existed only in the plan's `## Goal`, the one artefact that role is told not to measure against.

**And the reviewer prompt can carry this as base text.** An earlier revision of this plan claimed an unconditional clause would fail `src/test/minimal-prompt.test.js`. It would not: all fourteen of that file's minimality and add-on assertions target the **planner** role, and its single reviewer call (line 161) is a newline-normalisation check. The minimal-prompt principle exists because the planner's job is "read the workflow file and follow it" against a user-swappable file — baking methodology into that default would fight the `workflowFilePath` extension point. The reviewer has no such constraint and already carries substantial base instructions. So no add-on and no flag is needed.

**Failure 2 — local gates verified the dev tree, not the artifact. Already fixed, by the same reviewer, and better than this plan originally proposed.** The gap was real at the time: grep, compile, lint and manual inspection all passed because the files existed in the dev repo. But `33d4f3d` also produced `src/test/vsix-packaging-contract.test.js`, which reproduces vsce's `collectFiles` filter exactly — including the trap that a negation in `.vscodeignore` overrides every ignore pattern regardless of line order — and asserts against that filter rather than by reading the file. It pins the incident directly:

> "This has already happened once: the skill-injection-cleanup feature moved 33 protocols to `.switchboard/protocols/`, which `.vscodeignore` excludes wholesale — the files existed in the dev repo, so every grep, compile, lint and manual check passed while the shipped artifact contained none of them. Nothing else can see this: the seeding code is correct, the paths are correct, and the only broken thing is membership in the zip."

So this plan does **not** need to build a packaged-artifact checker. What remains is coverage and placement: confirm the test runs in a gate that cannot be skipped, and extend it beyond `node-pty` and `.agents/` to anything else the extension seeds or emits paths into.

**And this materially strengthens the case for the other two failures.** The reviewer had excellent verification instincts, identified an invisible defect class, and wrote a faithful artifact-level regression test for it — and the plan's goal was still inverted. The missing capability was never testing skill. It was that nothing asserted the *intent*, and nothing required a destination change to return to the author.

**The same test now demonstrates the problem it was written to prevent.** Its protocol assertion is:

```js
assert.ok(fs.existsSync(PROTOCOLS),
  'protocols must live under .agents/protocols/ — .switchboard/** is excluded from the VSIX, '
  + 'so a protocol placed there ships to nobody.');
```

That pins *the destination the reviewer chose*, not *the goal the plan had*. It is a correct test of shipping and a wrong test of intent, and it now actively blocks the follow-up work that restores the original goal. A goal invariant would have read "no protocol body ships as a scaffolded file" — which is satisfiable at `.agents/protocols/` only by failing, and that failure is the signal that was missing.

**Failure 3 — a reviewer may change a plan's destination without escalation.** The reviewer had the authority and the correctness to fix the blocker. What was missing was a rule that changing *where the work lands* — as opposed to how it is implemented — is an author decision, not a reviewer decision, however right the reviewer is about the blocker.

### Root Cause

Verification is specified in terms of the diff rather than in terms of the goal, so correctness is checked against what changed instead of against what the change was for. Compounded by a verification surface that is the developer's working tree rather than the shipped artifact, which makes an entire class of defect (present here, absent for users) invisible to every fast check.

### The schema change governs Switchboard's own methodology only

The planner workflow file is a **deliberate extension point**. `kanban.html:3464` presents it as a user-editable path with third-party examples offered as equals:

| Path | Label |
| :--- | :--- |
| `.agents/protocols/improve-plan/SKILL.md` | Switchboard Native |
| `.claude/get-shit-done/agents/gsd-planner.md` | GSD |
| `.claude/superpowers/skills/writing-plans.md` | Superpowers |

with a matching `plannerFeatureWorkflowFilePath` field for features. The product decision is explicit: users may bring their own methodology, plans will differ in shape as a result, and Switchboard does not force its own.

So this plan adds `### Goal Invariants` to **`improve-plan`'s and `improve-feature`'s** required-section schema — a change to Switchboard's own protocol, governing only the plans those protocols author. It must not become a board-wide gate.

**The distinction is load-bearing.** A check that rejects any plan lacking `### Goal Invariants` would reject every GSD- and Superpowers-authored plan, which is precisely the forcing the product has decided against. Any enforcement must key off *"was this authored by Switchboard's planner"*, never *"is this a plan on the board"*. The storage layer already models this correctly — `parsePlanMetadata` returns empty values rather than erroring when the Switchboard sections are absent, so a third-party plan imports cleanly with `Unknown` complexity and no tags. The gate must be at least as tolerant as the importer already is.

### A second place the same assumption is embedded

`COMPLEXITY_SCORING_DIRECTIVE` (`agentPromptBuilder.ts:1359`) instructs a dispatched agent to "add a `## Complexity Audit` section with `### Routine` and `### Complex / Risky` subsections" — Switchboard's heading names. It is gated on `addons.complexityScoringSkill`, which **defaults to enabled** (`"When false (explicitly), omits the complexity-scoring step"`).

So a user who points `workflowFilePath` at GSD or Superpowers and leaves that add-on alone gets Switchboard's section structure grafted onto a plan authored under a different methodology. The capability — classify steps by complexity before splitting — is methodology-neutral; the prescribed headings are not.

This is out of scope to change here, and flagged because it is the same class as the gate risk above: a Switchboard-schema assumption riding inside something presented as a generic capability toggle. The narrow fix, if wanted, is to have the directive request a complexity classification without dictating heading names, leaving the shape to whatever methodology authored the plan. Recorded as an Outstanding Question rather than a change, because it is a product call.

### Non-goals

- Imposing Switchboard's section schema on plans authored by another methodology. `workflowFilePath` is a supported extension point; GSD and Superpowers plans are expected to look different, and nothing in the system requires them not to.
- Reducing reviewer authority to fix real blockers. The finding in `33d4f3d` was excellent and must remain possible to make.
- Adding a confirmation dialog anywhere. Per project rule, no confirm gates — escalation here means a plan-file state and a board signal, not a modal.
- Rewriting the protocol migration itself (separate plan).
- Building a general CI system. This adds specific assertions to existing gates.
- Enforcing any section schema on plans authored by a third-party methodology. See above — that is a product decision already made, and this plan must not quietly reverse it.

## Metadata

**Complexity:** 4
**Tags:** docs, test, reliability, devops, refactor

## User Review Required

Yes — one decision.

**How hard should the escalation be?** When a reviewer concludes a plan's destination or stated goal cannot stand:
- **(a) Advisory** — record the deviation in the plan file and proceed. Cheapest; relies on someone reading it.
- **(b) Blocking** — the reviewer stops, writes the finding, and the card returns to the author's column. Safest; costs a round trip on every genuine blocker.
- **(c) Blocking only when the *Goal* or a Goal Invariant changes**, advisory for everything else.

**Recommendation: (c).** Implementation detail is exactly what a reviewer should be changing freely; a destination named in the Goal is what the author is choosing. Drawing the line at the Goal Invariant section makes the boundary mechanical rather than a judgement call.

## Complexity Audit

### Routine

- Adding the intent clause to `reviewerBaseInstructions` (`agentPromptBuilder.ts:1874`) without reflowing the two pinned strings.
- Offering (not requiring) `### Goal Invariants` in `improve-plan` / `improve-feature`.
- Adding must-not-exist assertions to the existing `src/test/vsix-packaging-contract.test.js`, and checking which gate runs it.
- Documenting the escalation rule in `CONSTITUTION.md` under the existing "Performance & Testing Standards" section.

### Complex / Risky

- **Scoping the gate is the highest-risk part of this plan.** The natural implementation — "reject a plan with no Goal Invariants" — is wrong, and wrong in a way that only shows up for users on GSD or Superpowers, i.e. not for anyone testing it. The check needs the authoring methodology as an input, which means either a marker the Switchboard planner writes, or keying off the configured `workflowFilePath` at dispatch time. Neither is free, and getting it wrong ships methodology lock-in as a side effect of a verification improvement.
- **The clause must not turn the reviewer into a line-by-line auditor.** It adds a goal question on top of the existing step assessment; it must not imply that any deviation from the listed steps is a defect. Deviations that still serve the goal are fine — the point is to notice when the steps were followed and the goal was not served.
- **A verdict the reviewer skims is worth nothing.** The reviewer prompt is already long. This has to demand a stated answer that appears in the review output, so its absence is visible.
- **A prompt clause the reviewer treats as boilerplate is worse than nothing.** The reviewer prompt is already long, and a vague addition ("also consider the goal") will be skimmed. It needs to demand a stated verdict — for a removal or relocation goal, the reviewer must say where the thing now is and whether it is gone from where the goal said it should not be. A verdict is checkable in the review output; a consideration is not.
- **A schema addition that authors treat as boilerplate is worse than nothing.** `improve-plan` already warns that an empty-but-present `## Outstanding Questions` heading is "a schema violation, not 'done'" — the same failure mode applies here, and harder, because a vacuous invariant ("assert the feature works") looks like compliance. The schema must require invariants to be *executable assertions naming concrete paths, symbols or counts*, and the plan-review pass must reject prose.
- **Deciding when a negative assertion is required.** "The goal is a removal or relocation" needs a test an author can apply without interpretation. Proposal: if the Goal contains any of *move, relocate, remove, delete, retire, stop, out of, no longer*, a negative invariant is mandatory. Crude, and it will produce false positives — which is the right direction for a gate whose failure mode is silence.
- **Where the existing packaging test runs is the open question, not whether it works.** It reproduces the filter faithfully and needs no rebuild of a VSIX, so it is cheap — but a check nobody runs is the problem this plan exists to fix, reproduced. Confirm its gate.
- **A must-not-exist assertion is easier to satisfy by deletion than by intent.** "Assert `.agents/protocols/` is absent" passes if someone deletes the directory without migrating the content. Negative invariants therefore need a paired positive: absent *here*, resolvable *there*. The protocols plan states both; the schema should require both.
- **The escalation path has to work for an agent reviewer.** Reviews here are performed by dispatched agents, not only humans. "Return the card to the author" must be expressible as something an agent does — a plan-file state plus a board move via the sanctioned API path — not an instruction it can narrate without performing.

## Edge-Case & Dependency Audit

**Race conditions**
- A reviewer escalating while the author is editing the same plan file: the escalation writes a distinct section rather than rewriting the Goal, so both edits merge.

**Security**
- None directly. Note that a plan file is agent-authored content later read as instructions, so an escalation section must be inert prose, never a directive an agent could execute.

**Side effects**
- Requiring goal invariants makes plans longer and slightly slower to write. That is the intended trade: the incident cost a rewrite of ~45 references across 31 files and lost the goal anyway.
- Some existing plans on the board have no `### Goal Invariants` section. The schema change must be forward-only — never retro-invalidate a plan already in flight, or every card in review fails its own gate.
- The packaged-artifact check will likely find other things already broken. That is a benefit, but it means the first run is a triage exercise, not a green tick.

**Migration**
- `improve-plan` and `improve-feature` are protocol content shipped in released versions, so the schema change reaches existing installs via the normal protocol-update path. Older plans remain valid; the new section is required only for plans authored after the change.

## Dependencies

- Independent of the storage programme. Can ship immediately and would make every plan in that programme safer.
- Touches `improve-plan` / `improve-feature` protocol bodies, so it interacts with the protocols-as-rows plan only in that both edit the same content — no ordering constraint.

## Adversarial Synthesis

**"This is process for a one-off mistake."** It is not one-off in kind. The same shape — a gate passing because it measured the wrong layer — appears three times already: `CLAUDE.md` documents it for `dist/`, `SCHEMA_WORKTREE_COLUMN_DEFS` exists because a schema invariant was checked at the wrong layer, and the protocol packaging test itself now pins a destination instead of a goal. Three independent instances of "the check looked right and measured the wrong thing" argue for a structural answer.

**"A reviewer who finds a CRITICAL should just fix it."** They should, and they did. The claim is narrower: fixing *how* is theirs, changing *where* is the author's. The reviewer in this incident produced excellent work and a clear commit message; the failure was the absence of a rule requiring the destination change to come back, not any lapse on their part.

**"Goal invariants will become boilerplate."** The most likely way this fails, which is why the schema demands executable assertions naming concrete paths or counts and why the plan-review pass must reject prose. Even so, expect partial compliance — a plan with one real invariant is still strictly better than the current zero.

**"Just add the one missing test to the protocol plan and move on."** That fixes this instance. The generalisation is cheap by comparison and covers the next one, which will not look like this one.

## Proposed Changes

1. **Add the intent clause to `reviewerBaseInstructions`** (`agentPromptBuilder.ts:1874`) as unconditional base text — no add-on, no flag. It must ask for a stated verdict rather than a consideration, because a verdict is checkable in the review output:

   > Assess the change against the plan's stated **goal**, not only its listed steps. State whether the goal is achieved. If the goal is a removal or relocation, name where the thing now is and whether it is gone from where the goal said it should not be. If you changed the destination or approach the plan specified, say so explicitly and flag it for the author.

   Methodology-neutral by construction: it reads the goal as written, so it works identically on a Switchboard plan and on a GSD- or Superpowers-authored one.

   **Implementation constraint:** two strings around this block are byte-pinned by tests — the reviewer-prompt regression gate pins "assess the actual code changes against the plan requirements", and `team-scoped-role-routing.test.js` pins "fix valid material issues, then verify." Attach a clause; do not reflow either.

2. **Leave the acceptance tester alone.** It stays additional and stays off by default. Recorded separately below is a proposal for when it *is* worth its cost, but nothing in this plan depends on it running.
3. **Optionally** offer `### Goal Invariants` in `improve-plan` / `improve-feature` as a *recommended* section, never a gate. A plan that states its own invariant gives the tester something concrete to measure, which is useful precisely when there is no PRD.
3. **Extend `src/test/vsix-packaging-contract.test.js`** rather than building a new checker — it already reproduces vsce's filter faithfully. Add must-*not*-exist assertions alongside its existing must-exist ones, so a goal invariant of the form "X no longer ships" is expressible in the same place. Confirm it runs in a gate that cannot be skipped.
4. **`CONSTITUTION.md`** gains the escalation rule under "Performance & Testing Standards": a reviewer may change implementation freely; changing a destination or goal named in the plan's Goal or Goal Invariants returns the card to the author with the finding recorded.
5. **A `### Review Deviations` section** appended to a plan when a reviewer changes anything goal-level — inert prose, author-facing, never a directive.
6. **Backfill goal invariants** into the eight storage-programme plans, since several are removals (`.agents/` out of the repo, presets retired, guard deleted) and would fail their own new gate.

### Migration

Forward-only. Plans already in flight keep their current schema; the requirement applies to plans authored after the protocol update lands.

## Verification Plan

### Automated Tests

- **Reviewer goal verdict:** compose a reviewer prompt and assert it requires a stated verdict on the plan's goal. Assert it appears with no add-ons enabled, since this is base text.
- **Planner default unaffected:** `src/test/minimal-prompt.test.js` still passes in full — the clause is reviewer-scoped and must not reach the planner default, whose minimality is the tested principle.
- **Methodology neutrality:** point `workflowFilePath` at a GSD path and a Superpowers path; assert the reviewer instruction is unchanged and carries the goal clause in both cases, since it reads a Goal rather than a section schema.
- **No tester dependency:** assert the goal verdict is present with the `ACCEPTANCE TESTED` column disabled entirely.
- **Pinned strings intact:** the reviewer-prompt regression gate and `team-scoped-role-routing.test.js` both still pass.
- **Regression against the goal inversion (the gap that remains):** with protocols at `.agents/protocols/`, assert a goal invariant of the form "no protocol body ships as a scaffolded file" fails. The packaging half of this is already covered by `vsix-packaging-contract.test.js`; this is the half nothing checks.
- **Paired invariant enforcement:** a plan offering only a must-not-exist assertion, with no matching "resolvable there" assertion, must be rejected.
- **Must-not-exist expressible:** add a must-not-exist entry to `vsix-packaging-contract.test.js` and assert it fails when the path ships.
- **Escalation path:** simulate an agent reviewer concluding a destination must change; assert a `### Review Deviations` section is written and the card returns to the author's column via the sanctioned API path, not SQL.
- **Forward-only:** assert an existing plan with no `### Goal Invariants` section still passes review.
- **Methodology pluralism (the regression this plan could cause):** author a plan in GSD shape and one in Superpowers shape — neither carrying `## Goal`, `## Metadata` or `### Goal Invariants` — and assert both import cleanly, appear on the board, dispatch, and are never rejected by any gate this plan adds. This test must exist before the gate ships, not after.
- **No confirm gates introduced:** grep the diff for `confirm(`, `window.confirm`, `showWarningMessage` — escalation must be a state, not a modal.

### Goal Invariants

- `reviewerBaseInstructions` contains the goal clause as unconditional base text. No new add-on flag was introduced, `testerBase` is unchanged, and the two pinned strings are byte-identical to their current values.
- No change requires a section that a GSD- or Superpowers-authored plan would lack.
- `src/test/vsix-packaging-contract.test.js` supports must-not-exist assertions, still contains no hardcoded copy of any `.vscodeignore` pattern, and runs in a named gate.
- `CONSTITUTION.md` contains the reviewer-escalation rule.
- No file changed by this plan introduces a `confirm(`, `window.confirm(` or modal `showWarningMessage` call.

## Outstanding Questions

- **[user]** Should `COMPLEXITY_SCORING_DIRECTIVE` stop prescribing `## Complexity Audit` / `### Routine` / `### Complex / Risky` and instead request a complexity classification in whatever shape the active methodology uses? Proceeding on the assumption that the current behaviour is acceptable because the add-on is opt-out, but it does impose Switchboard's headings on third-party plans by default.
- **[user]** Which gate currently runs `vsix-packaging-contract.test.js`, and can it be skipped? Proceeding on the assumption it needs an explicit release-gate wiring plus a nightly, so a breakage surfaces within a day rather than at release.
- **[user]** When is the acceptance tester worth its token cost? Its unique baseline is the PRD plus the constitution's invariants, so once the reviewer covers plan-goal intent the only thing left that is distinctly its own is PRD conformance — "does this deliver what the PRD promised", a different question from "does this match the plan". On internal refactors there is no PRD, which predicts the low observed failure rate: it is being asked to check intent against a baseline that does not exist. A mechanical trigger would be to run it only on plans that carry a PRD reference, skipping the column otherwise — no per-card judgment, tokens spent only where it has a yardstick. Recorded as a proposal, not part of this plan.
- Do any existing plans on the board have goals that the new schema would retro-invalidate? The forward-only rule covers it, but the count is worth knowing before the protocol update ships.
