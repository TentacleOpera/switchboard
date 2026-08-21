# Close the review hole that let a correct fix silently invert a plan's goal

## Goal

Make it structurally impossible for a review pass to satisfy a plan's mechanics while reversing its purpose, and make it impossible for a change to pass every local gate while being dead on a user install. Both failures happened in the same commit, both were invisible to every existing check, and neither was concealed — the machinery simply never asked the questions that would have caught them.

### Problem Analysis

**The incident.** `move-protocols-out-of-skill-discovery.md` moved 33 protocol definitions out of `.agents/skills/` so CLI skill discovery would stop injecting their names and descriptions into every system prompt. Destination: `.switchboard/protocols/`.

A reviewer pass (`33d4f3d`) found a genuine CRITICAL:

> "`.vscodeignore` excludes `.switchboard/**`, and neither seeding path … copies anything outside `.agents/`. All 33 protocols and every path reference the extension emits were dead on any user install, while grep/compile/lint/manual checks all passed because the files exist in this repo."

The fix relocated them to `.agents/protocols/`, rewrote ~45 references across 31 files, and added compatibility keys to `RETIRED_WORKFLOW_PATH_MAP`. Shipping was restored. The token goal was preserved. And the plan's other purpose — getting 424K of non-discoverable content out of the scaffolded workspace — was silently dropped, because the work now put it back in `.agents/`.

Nothing in the process was dishonest. The commit message states plainly what it did and why. The gap is that **no gate compared the outcome to the plan's purpose**, and no human was asked to approve a change of destination.

**Failure 1 — verification asserts the mechanism, not the intent.** `improve-plan`'s required section schema (`.agents/protocols/improve-plan/SKILL.md`, section 9) specifies:

```
9. **## Verification Plan**
   - ### Automated Tests
```

That is the entire specification. It asks for tests of the change. A plan whose purpose is *"X must no longer be in Y"* therefore gets tests asserting *"X is now at Z"* — which pass just as happily when Z turns out to be inside Y. There is no required negative assertion, so the one test that would have caught this (`assert .agents/ contains no protocols`) was never written, because nothing asked for it.

**Failure 2 — local gates verify the dev tree, not the artifact.** `CLAUDE.md` already records the shape of this: *"`dist/` is NOT used during development or testing … all testing is done via an installed VSIX."* The protocol incident is the same class one level up — grep, compile, lint and manual inspection all passed because **the files exist in this repo**. Nothing checked what a packaged extension actually contains. `.vscodeignore` is a second, invisible source of truth about what ships, and no test reads it.

**Failure 3 — a reviewer may change a plan's destination without escalation.** The reviewer had the authority and the correctness to fix the blocker. What was missing was a rule that changing *where the work lands* — as opposed to how it is implemented — is an author decision, not a reviewer decision, however right the reviewer is about the blocker.

### Root Cause

Verification is specified in terms of the diff rather than in terms of the goal, so correctness is checked against what changed instead of against what the change was for. Compounded by a verification surface that is the developer's working tree rather than the shipped artifact, which makes an entire class of defect (present here, absent for users) invisible to every fast check.

### Non-goals

- Reducing reviewer authority to fix real blockers. The finding in `33d4f3d` was excellent and must remain possible to make.
- Adding a confirmation dialog anywhere. Per project rule, no confirm gates — escalation here means a plan-file state and a board signal, not a modal.
- Rewriting the protocol migration itself (separate plan).
- Building a general CI system. This adds specific assertions to existing gates.

## Metadata

**Complexity:** 5
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

- Adding a required `### Goal Invariants` subsection to `improve-plan`'s section-9 schema, with a stated rule that at least one invariant must be a negative assertion when the goal is a removal or relocation.
- Adding the same requirement to `improve-feature`.
- A `scripts/check-packaged-artifact.js` that builds or reads a VSIX and asserts a supplied list of paths is present or absent.
- Documenting the escalation rule in `CONSTITUTION.md` under the existing "Performance & Testing Standards" section.

### Complex / Risky

- **A schema addition that authors treat as boilerplate is worse than nothing.** `improve-plan` already warns that an empty-but-present `## Outstanding Questions` heading is "a schema violation, not 'done'" — the same failure mode applies here, and harder, because a vacuous invariant ("assert the feature works") looks like compliance. The schema must require invariants to be *executable assertions naming concrete paths, symbols or counts*, and the plan-review pass must reject prose.
- **Deciding when a negative assertion is required.** "The goal is a removal or relocation" needs a test an author can apply without interpretation. Proposal: if the Goal contains any of *move, relocate, remove, delete, retire, stop, out of, no longer*, a negative invariant is mandatory. Crude, and it will produce false positives — which is the right direction for a gate whose failure mode is silence.
- **Packaging checks are slow and easy to skip.** Building a VSIX is not a per-commit operation. It needs to run where it cannot be bypassed (release gate, or a scheduled job), and its absence must be visible rather than silent. A check nobody runs is the problem this plan exists to fix, reproduced.
- **`.vscodeignore` is a second source of truth about what ships.** Any assertion about packaged contents must derive from it rather than restating it, or the two drift and the test becomes a lie that passes.
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

**"This is process for a one-off mistake."** It is not one-off in kind. The same shape — a local gate passing because the dev tree differs from the shipped artifact — is already documented in `CLAUDE.md` for `dist/`, and `SCHEMA_WORKTREE_COLUMN_DEFS` exists because another invariant was checked at the wrong layer. Two independent instances of "the check looked right and measured the wrong thing" argue for a structural answer.

**"A reviewer who finds a CRITICAL should just fix it."** They should, and they did. The claim is narrower: fixing *how* is theirs, changing *where* is the author's. The reviewer in this incident produced excellent work and a clear commit message; the failure was the absence of a rule requiring the destination change to come back, not any lapse on their part.

**"Goal invariants will become boilerplate."** The most likely way this fails, which is why the schema demands executable assertions naming concrete paths or counts and why the plan-review pass must reject prose. Even so, expect partial compliance — a plan with one real invariant is still strictly better than the current zero.

**"Just add the one missing test to the protocol plan and move on."** That fixes this instance. The generalisation is cheap by comparison and covers the next one, which will not look like this one.

## Proposed Changes

1. **`improve-plan` section 9 gains `### Goal Invariants`** — at least one executable assertion, mandatory negative assertion when the Goal contains removal or relocation language, prose rejected.
2. **Same addition to `improve-feature`.**
3. **`scripts/check-packaged-artifact.js`** — takes a manifest of must-exist and must-not-exist paths, resolves what a VSIX actually contains, derives exclusions from `.vscodeignore` rather than restating them. Wired into the release gate.
4. **`CONSTITUTION.md`** gains the escalation rule under "Performance & Testing Standards": a reviewer may change implementation freely; changing a destination or goal named in the plan's Goal or Goal Invariants returns the card to the author with the finding recorded.
5. **A `### Review Deviations` section** appended to a plan when a reviewer changes anything goal-level — inert prose, author-facing, never a directive.
6. **Backfill goal invariants** into the eight storage-programme plans, since several are removals (`.agents/` out of the repo, presets retired, guard deleted) and would fail their own new gate.

### Migration

Forward-only. Plans already in flight keep their current schema; the requirement applies to plans authored after the protocol update lands.

## Verification Plan

### Automated Tests

- **Schema enforcement:** a plan whose Goal says "move X out of Y" and which has no negative invariant must be rejected by the plan-review pass. A plan with a vacuous invariant ("assert it works") must also be rejected.
- **Regression against the actual incident:** reconstruct the pre-fix state — protocols at `.switchboard/protocols/`, all references rewritten — and assert `check-packaged-artifact.js` reports them missing from the VSIX. This is the test that would have caught `33d4f3d`'s blocker before review.
- **Regression against the goal inversion:** with protocols at `.agents/protocols/`, assert a goal invariant of the form "no protocol under `.agents/`" fails. This is the test that would have caught the remedy.
- **`.vscodeignore` derivation:** add an exclusion to `.vscodeignore` and assert the packaged check picks it up without editing the check.
- **Escalation path:** simulate an agent reviewer concluding a destination must change; assert a `### Review Deviations` section is written and the card returns to the author's column via the sanctioned API path, not SQL.
- **Forward-only:** assert an existing plan with no `### Goal Invariants` section still passes review.
- **No confirm gates introduced:** grep the diff for `confirm(`, `window.confirm`, `showWarningMessage` — escalation must be a state, not a modal.

### Goal Invariants

- `improve-plan/SKILL.md` and `improve-feature/SKILL.md` both contain a required `### Goal Invariants` subsection under section 9.
- `scripts/check-packaged-artifact.js` exists, is referenced by the release gate, and contains no hardcoded copy of any `.vscodeignore` pattern.
- `CONSTITUTION.md` contains the reviewer-escalation rule.
- No file changed by this plan introduces a `confirm(`, `window.confirm(` or modal `showWarningMessage` call.

## Outstanding Questions

- **[user]** Where does the packaged-artifact check run — release gate only, or also a scheduled job on the default branch? Proceeding on the assumption of release gate plus a nightly, so a breakage is caught within a day rather than at release.
- **[user]** Should the keyword trigger for mandatory negative assertions be automatic or author-declared? Proceeding with automatic, accepting false positives, on the grounds that the failure mode being fixed is silence.
- Do any existing plans on the board have goals that the new schema would retro-invalidate? The forward-only rule covers it, but the count is worth knowing before the protocol update ships.
