# The Dispatch Skill Teaches Only The Conservative Half Of Sequencing

## Goal

Make `terminal-coder-dispatch` produce a dispatch plan that uses the coder pool it was given, instead of serialising an eight-subtask feature onto one terminal while two sit idle.

### The problem

Observed on the first driven run of a full feature (*Teams as the main model*, eight subtasks, three coder terminals). The head agent read the feature file, correctly quoted its chain ordering, and then dispatched **one** subtask, leaving two coders idle. It did so despite the feature file containing a section heading that reads, verbatim:

> ### Start any time, in parallel with anything

The operator caught it and asked why. The head's own post-mortem: it had collapsed a per-file contention rule into a global one, and had never asked the separate question *"can the chain head start now?"* — which it could, since the chain head depended on nothing.

Cost: roughly two subtasks of wall-clock on a run of eight, and the error is systematic rather than incidental — nothing in the skill would have caught it on the next run either.

### Root cause 1 — §7 only handles the silent case

`.agents/skills/terminal-coder-dispatch/SKILL.md` §7 *Sequencing across subtasks* reads:

> Read the feature's `## Dependencies & sequencing` section. Honour ordering statements, and treat "not concurrently" as a hard serialisation when driving more than one coder. When the section is silent or ambiguous, go **sequential in file order** — never infer independence from absence.

Every clause is a brake. "Honour ordering statements" and "treat *not concurrently* as hard serialisation" both constrain; "when silent, go sequential" constrains; "never infer independence from absence" constrains. There is **no clause that acts on declared independence** — the case where the feature file has done the analysis and says these subtasks are parallel-safe.

An agent following §7 to the letter and reading a feature file that grants parallelism has no instruction telling it to use that grant. The conservative default silently wins by being the only rule present.

### Root cause 2 — no rule for the chain head

Every feature with a dependency chain has a **first** element, and it depends on nothing by definition. It is dispatchable on turn one, concurrently with any unconstrained subtask.

§7 never mentions this. The skill's model is "unconstrained subtasks" versus "the chain", with the chain treated as one indivisible serial unit that begins after — rather than a sequence whose head is available immediately. On the observed run, subtask 3 (the chain head) sat undispatched behind two unrelated subtasks for no reason a reader of the skill could have identified as wrong.

### Root cause 3 — per-file contention is stated as a set-wide rule

The PRD's orchestration discipline says *"One agent stream per provider file. Same-file parallel edits collide."* Individual plans restate it: *"Sibling subtasks also edit `terminals.js` … under the project's one-stream-per-file rule they serialise against each other."*

Both are correct and both are **pairwise** — they constrain the specific subtasks sharing a file. Neither says "if any file is contended, serialise everything", but that is how it was read, because the skill offers no worked example of applying a pairwise constraint to a set. On the observed feature, `terminals.js` was touched by four of eight subtasks, which was enough for the whole set to collapse into one stream.

### Root cause 4 — the skill has no rule for choosing a terminal from the pool

§9 tells the head to enumerate the pool and stop if it is too small. Nothing tells it **which** terminal to use for a given subtask, or that using a different one is a lever at all.

The consequence surfaced later in the same run: one coder ran five consecutive subtasks and three fix rounds on `clearBeforePrompt: false`, accumulating exactly the context the sibling subtask *Clear The Coder Between Subtasks* exists to eliminate — while two coders sat idle with empty contexts. **Rotating to an idle coder gives a clean context with no `/clear` involved**, which matters disproportionately right now because the clear path is itself broken (see *Dependencies*). The skill frames context hygiene solely as a `clearBeforePrompt` decision; pool rotation achieves the same end without touching the transport.

### Why this is a skill defect and not just an agent error

The head agent's reasoning was wrong and it owned that. But a protocol document whose sequencing section contains four braking clauses and zero accelerating ones will reproduce this on every run, with every agent. The skill is the durable artefact; the reasoning is not.

## Metadata

**Complexity:** 3
**Tags:** docs, agent-protocol, dx

## User Review Required

None.

## Complexity Audit

### Routine

- Prose and a worked example in one markdown file, mirrored to `.claude/` by the existing generator. No code.
- §7 is self-contained; the change adds cases to it rather than restructuring the skill.
- No persisted state, no migration, nothing versioned.

### Complex / Risky

- **The failure mode of over-correcting is worse than the bug.** A skill that reads "parallelise wherever possible" produces concurrent edits to one file, which is the documented burndown hazard this project has already been bitten by. The new rules must be strictly additive to the existing brakes, never a replacement.
- **This is a behaviour change in an agent protocol.** The same class of risk the sibling *Clear The Coder Between Subtasks* plan flagged: a misread reintroduces the opposite defect. State the decision as a procedure with an explicit order of evaluation, not as a principle to weigh.
- Skill discovery is host-split — Claude Code resolves through `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts`), Antigravity reads the filesystem — so editing one copy leaves one host on stale instructions.

## Edge-Case & Dependency Audit

### Race Conditions

- None in code. The hazard the change must not create is a *dispatch* race: two coders editing one file. That is what the pairwise rule exists to prevent and why it stays first in the evaluation order.

### Security

- None.

### Side Effects

- More concurrent coders means more simultaneous agent CLIs, each consuming quota. The skill already tells the head to size against the pool rather than the subtask count; the new rules must not encourage creating terminals (§9 already forbids that).
- A parallel dispatch produces interleaved completion reports. The head reviews each against its own plan, which it already does — but the skill should say the review is per-subtask, not per-batch, so a head does not wait for a batch that has no barrier.

### Dependencies & Conflicts

- **Sibling in spirit, not in file:** `feature_plan_20260813103000_pty-prompt-delivery-never-submits.md`. That plan fixes the transport; this one fixes the dispatch reasoning. They touch different things — that one is `ptyPromptDelivery.ts` and friends, this one is a skill document — but they interact: until the transport is fixed, `clearBeforePrompt: true` is unsafe, which makes **pool rotation the only working context-hygiene mechanism**. Root cause 4 should be written so it stands on its own merits and does not read as a workaround that expires.
- Touches the same file as the shipped subtask *Clear The Coder Between Subtasks*, which rewrote §1, §4, §6 and added a subtask-transition section. This plan edits §7 and §9. Different sections, same file — serialise, do not run concurrently.

## Dependencies

- `sess_20260813104500 — terminal-coder-dispatch: declared-independence, chain-head and pool-rotation rules`

## Adversarial Synthesis

Key risks: an accelerating rule read as licence for same-file concurrency, reintroducing the collision hazard the brakes exist to prevent; a "chain head is free" rule misapplied to the second element of a chain; and a worked example that becomes stale when the referenced feature changes. Mitigations: express the whole thing as an ordered procedure where the pairwise file check runs **after** independence is established and can only ever *remove* pairs from a concurrent batch, never add them; state the chain-head rule as "exactly the first unstarted element, and only while it is unstarted"; and write the example against a synthetic feature rather than a real one so it cannot rot. The objective check is that a head reading the new §7 against the *Teams as the main model* feature file produces a three-way opening dispatch rather than a one-way one.

## Design

### §7 becomes an ordered procedure, not a set of principles

The current section is a list of considerations, which is what let a reader apply one and stop. Replace it with a numbered procedure evaluated in order, where each step can only narrow the batch produced by the previous one:

1. **Read the declared sequencing.** If the feature states subtasks are independent or parallel-safe — in any form, including a section heading — that statement is **authoritative**. It is the output of analysis already done against the codebase; do not re-derive it and do not override it with your own file inspection.
2. **Identify the chain head.** For each declared dependency chain, its first unstarted element depends on nothing and is dispatchable **now**, concurrently with the independent subtasks from step 1. Only the first; the second element waits for the first to land.
3. **Apply pairwise file contention.** For the candidate set from steps 1–2, serialise **only the specific pairs** that edit the same file. A contended file removes one subtask from the current batch — it does not collapse the batch. Two subtasks touching disjoint, named regions of one file may run concurrently only if both regions are stated in their dispatch prompts.
4. **Cap at pool size.** Dispatch up to the number of live coders. Do not create terminals (§9).
5. **When the sequencing section is silent or ambiguous**, and only then, go sequential in file order — never infer independence from absence.

Step 5 is the current rule, demoted to the fallback it always was. Steps 1–4 are what is missing.

### State the anti-pattern explicitly

Add the observed failure by name, because a rule an agent has to derive is a rule it will skip:

> **Do not collapse a pairwise constraint into a global one.** "Subtasks A and B both edit `x.js`, so they serialise" does not imply "the feature serialises". Ask the contention question once per *pair*, not once per feature.

### Rotate across the pool

Add to §9, which currently only sizes the pool:

> Prefer a **fresh coder** for each new subtask while idle coders remain, rotating through the pool before reusing a terminal. A fresh terminal starts with a clean context, which is the same outcome `clearBeforePrompt: true` buys on the first prompt of a subtask — without depending on the clear path. Reuse the *same* coder only for fix resends within a subtask, which by definition need the context of the work being corrected. A coder that has run several subtasks back-to-back is carrying every one of them.

### One worked example

Close §7 with a short worked dispatch plan over a synthetic eight-subtask feature — two declared-independent, a six-chain, one file contended across three of them — showing the opening batch and the reason each subtask is in or out. The observed failure was a reasoning collapse, not a missing fact, so the section needs to show the decision being made, not only state the rule.

## Implementation Notes

- `.agents/skills/terminal-coder-dispatch/SKILL.md` is the source of truth; `.claude/` is a generated mirror resolved through `MIRROR_MANIFEST`. Edit `.agents/` and regenerate; do not hand-edit the mirror, and do not edit only one.
- Keep every existing brake in §7 verbatim. This plan adds cases; it softens nothing. The "never infer independence from absence" clause in particular must survive intact — it is correct and it is the fallback.
- Do not add a rule that encourages creating terminals. §9's prohibition stands: each terminal is a running agent CLI, and creation is not on the documented verb rail for agents.
- Keep the example synthetic. A worked example naming a real feature file rots the moment that feature ships.
- The skill's subtitle — *"The attended long-running single-coder pattern"* — contributed to the one-stream reading and is now inaccurate for a multi-subtask feature. Reword the description in the frontmatter, and remember the frontmatter is what the mirror manifest surfaces as the skill's one-line summary.

## Proposed Changes

### `.agents/skills/terminal-coder-dispatch/SKILL.md`

- **Context.** §7 *Sequencing across subtasks* contains four braking clauses and no accelerating one. §9 sizes the pool but never says which terminal to use. The frontmatter description says "single-coder pattern".
- **Logic.** Sequencing becomes an ordered procedure whose steps narrow monotonically; pool selection gains a rotation rule.
- **Implementation.** Rewrite §7 as the five-step procedure with the anti-pattern callout and a synthetic worked example. Add the rotation paragraph to §9. Reword the frontmatter description so it does not read as one-coder-by-design.
- **Edge Cases.** Preserve every existing constraint verbatim. The pairwise step must be expressed as *removing* pairs from a batch, never as a gate on forming one.

### `.claude/skills/terminal-coder-dispatch/SKILL.md`

- **Context.** Generated mirror; Claude Code resolves skills through `MIRROR_MANIFEST`, so a stale mirror leaves one host on the old rule.
- **Implementation.** Regenerate from `.agents/`. Do not hand-edit.
- **Edge Cases.** Confirm the five-step procedure and the rotation paragraph are both present in the mirror before considering the change complete.

## Verification Plan

1. **The reported case, replayed.** Give a head the *Teams as the main model* feature file and the new §7. Its opening dispatch must be three subtasks — the two declared-independent plus the chain head — not one.
2. **The brake still holds.** Give a head a feature whose sequencing section is absent. It must go sequential in file order and say so.
3. **Pairwise, not global.** Give a head a feature where two of six subtasks share a file. Those two must serialise against each other; the other four must not be affected.
4. **Chain head only.** Confirm the head dispatches the first chain element concurrently and does **not** dispatch the second until the first lands.
5. **Pool cap.** Give a head five parallel-safe subtasks and two coders. It must dispatch two and hold three, and must not attempt to create terminals.
6. **Rotation.** Across a multi-subtask run, confirm consecutive subtasks go to different coders while idle ones remain, and that a fix resend goes back to the coder that did the work.
7. **Review is per-subtask.** Confirm the head reviews and advances each subtask as its report lands, rather than waiting for a batch.
8. **Both skill copies agree.** Diff `.agents/` against the `.claude/` mirror; the procedure and the rotation rule must be present in both.

### Automated Tests

None applicable — the artefact is a protocol document, and its behaviour is only observable through an agent following it. Verification is the replay in step 1, which is a concrete pass/fail against a feature file that still exists in the repo.

## Recommendation

Complexity 3 → **Send to Intern**.
