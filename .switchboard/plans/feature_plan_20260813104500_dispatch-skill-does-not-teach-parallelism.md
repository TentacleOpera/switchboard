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

The consequence surfaced later in the same run: one coder ran five consecutive subtasks and three fix rounds on `clearBeforePrompt: false`, accumulating exactly the context the sibling subtask *Clear The Coder Between Subtasks* exists to eliminate — while two coders sat idle with empty contexts.

**Rotating to an idle coder gives a clean context and a warm terminal at the same time, and it costs nothing.** That is the whole argument, and it holds independently of anything the clear path does:

- A `/clear` buys a clean context on a coder that is already busy-adjacent; rotation buys a clean context *and* uses a machine that would otherwise be idle. Only rotation converts context hygiene into throughput.
- Rotation is decided by the head agent from data it already has (`ptyListTerminals`). It needs no transport behaviour to be correct, no config default to hold, and no field to be passed — so it cannot regress when any of those change.
- The two mechanisms compose. Rotation is the right default for a *new subtask*; the clear decision is the right lever for *reusing* a terminal when the pool is exhausted. Neither replaces the other.

Deliberately **not** an argument: "rotation is the only thing that works while the clear path is broken." That framing appeared in an earlier revision and is now factually wrong — the transport plan *A Prompt Sent To A PTY Terminal Does Not Submit* has landed (`CLI_AGENT_REGEX` is deleted from the code and `src/test/pty-prompt-delivery-framing.test.js:235` guards its absence). A rule justified by a temporary breakage expires with the breakage; the rule above does not.

### Why this is a skill defect and not just an agent error

The head agent's reasoning was wrong and it owned that. But a protocol document whose sequencing section contains four braking clauses and zero accelerating ones will reproduce this on every run, with every agent. The skill is the durable artefact; the reasoning is not.

## Metadata

**Complexity:** 4
**Tags:** docs, agent-protocol, dx
**Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3
> **Reason:** 3 was scored when this was "prose in one markdown file, no code". It now spans four files across two source-of-truth trees (`.agents/` skill, `AGENTS.md`, `ClaudeCodeMirrorService.ts`) plus two generated artefacts, and it carries three judgement calls a mechanical pass gets wrong: the target file is not in the state its sibling's completion report describes; `mirror:check` goes green with two stale description copies standing; and the missing clear rule must be *reported*, not absorbed. 4 = "multi-file changes, moderate logic" is the honest band, and it moves routing from Intern to Coder — which matters, because dropping exactly this kind of cross-file wiring is the failure mode the sibling subtask exists to counter.
> **Replaced with:** **Complexity:** 4

## Current state of the target file (verified at HEAD `1bd39f4a`, 2026-08-14)

Read this before editing — the file is **not** in the state a reader of the sibling plans would expect.

- `.agents/skills/terminal-coder-dispatch/SKILL.md` was **added** in `1bd39f4a` and exists in no earlier commit, no other ref, and no worktree.
- §7 is exactly the four-brake paragraph quoted under *Root cause 1*, verbatim. It contains **no** subtask-transition rule.
- §1 still carries the blanket rule *"`clearBeforePrompt: false` is mandatory and non-obvious"* (line 51) and the claim that an omitted field defaults to `true` and sends `/clear`.
- §9 is exactly the pool-sizing paragraph quoted under *Root cause 4*.
- The frontmatter description is `Drive a feature's subtasks through a coder terminal — dispatch, callback, review, resend. The attended long-running single-coder pattern.`

The sibling card *Clear The Coder Between Subtasks* sits in **CODE REVIEWED** and its completion report claims it rewrote §1/§4/§6, replaced the blanket clear rule with a two-row table, added a "no passed-review send" transition rule to §7, and corrected the defaults claim. **None of that is in the tree.** Its *code* half did land — `STANDING_ORDERS_MARKER` is renamed at `src/services/standingOrders.ts:12` and `src/test/standing-orders-marker-contract.test.js` exists — so the card is half-delivered, not undelivered. Write §7 against the text that is actually there; do not assume the transition rule exists, and do not re-author it here (see *Dependencies & Conflicts*).

## User Review Required

None.

## Complexity Audit

### Routine

- Prose and a worked example in one markdown file, mirrored to `.claude/` by the existing generator.
- Two one-line string edits outside the skill: the `descriptionFallback` literal in `ClaudeCodeMirrorService.ts` and the skills-table row in `AGENTS.md`. No logic changes anywhere.
- §7 is self-contained; the change adds cases to it rather than restructuring the skill.
- No persisted state, no migration, nothing versioned.

### Complex / Risky

- **The failure mode of over-correcting is worse than the bug.** A skill that reads "parallelise wherever possible" produces concurrent edits to one file, which is the documented burndown hazard this project has already been bitten by. The new rules must be strictly additive to the existing brakes, never a replacement.
- **This is a behaviour change in an agent protocol.** The same class of risk the sibling *Clear The Coder Between Subtasks* plan flagged: a misread reintroduces the opposite defect. State the decision as a procedure with an explicit order of evaluation, not as a principle to weigh.
- Skill discovery is host-split — Claude Code resolves through `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts`), Antigravity reads the filesystem — so editing one copy leaves one host on stale instructions.

## Edge-Case & Dependency Audit

### Race Conditions

- None in code. The hazard the change must not create is a *dispatch* race: two coders editing one file. That is what the pairwise rule (step 3) exists to prevent. It runs **after** independence is established rather than before, precisely so it can only ever *remove* pairs from a candidate batch — a contention check placed first reads as a gate on forming a batch at all, which is the collapse this plan exists to stop.

### Security

- None.

### Side Effects

- More concurrent coders means more simultaneous agent CLIs, each consuming quota. The skill already tells the head to size against the pool rather than the subtask count; the new rules must not encourage creating terminals (§9 already forbids that).
- A parallel dispatch produces interleaved completion reports. The head reviews each against its own plan, which it already does — but the skill should say the review is per-subtask, not per-batch, so a head does not wait for a batch that has no barrier.
- **This path carries no prompt add-ons, and this plan does not change that.** §4's dispatch prompt is composed by the head agent and delivered with `ptySendPrompt`; it never passes through `buildKanbanBatchPrompt`, so nothing in `ROLE_ADDONS` reaches a driven coder — including the sibling subtask's effort directive. Parallelising the dispatch therefore multiplies the number of coders working *without* that counter-directive. That is an accepted boundary, not a regression: the one-line prompt convention is deliberate, and the coder reads the plan file, which carries the scope. Named here so the interaction is on the record rather than discovered later as a surprise.

### Dependencies & Conflicts

- **The transport plan has landed; this plan no longer leans on it.** `feature_plan_20260813103000_pty-prompt-delivery-never-submits.md` is in CODE REVIEWED and its change is in the tree — `CLI_AGENT_REGEX` is gone from the code, the confirm CR is unconditional, and `src/test/pty-prompt-delivery-framing.test.js:235` fails if the gate ever returns. Root cause 4 has been rewritten to stand on its own merits accordingly. Nothing in this plan is blocked on it.
- **The `Clear The Coder Between Subtasks` skill edit is MISSING from the tree, and that is a live hazard — not resolved history.** An earlier revision of this plan described that subtask as *shipped*, having "rewrote §1, §4, §6 and added a subtask-transition section". Verified false at `1bd39f4a`: the skill file was added in that commit with none of those edits (see *Current state of the target file*). Its code half landed; its document half did not. The card nevertheless sits in **CODE REVIEWED**. Consequences for this plan, in order of importance:
  1. **Write §7 against the file, not against the sibling's report.** The four braking clauses this plan quotes are the whole of §7 today. Preserving "every existing brake verbatim" means preserving those four and nothing else — there is no transition rule to preserve.
  2. **Do not re-author the missing clear rule here.** It is a separate card with its own reviewed design (a two-row clear table, plus a "no passed-review send" rule). Re-writing it inside this plan would duplicate reviewed work and risk contradicting it. Flag the gap to the operator; do not absorb it.
  3. **If that card is re-run, it must land before this plan's §7 rewrite** — or its transition rule must be folded into the new step list as an additional step rather than appended to a paragraph that will no longer exist. Two agents editing §7 concurrently is the collision the one-stream-per-file rule exists to prevent, and this time the file genuinely is contended.

## Dependencies

- **None.** This plan is self-contained: it edits one markdown source of truth, regenerates its mirror, and updates three copies of one description string. Nothing must land first.

  > **Superseded:** `sess_20260813104500 — terminal-coder-dispatch: declared-independence, chain-head and pool-rotation rules`
  > **Reason:** That is a session identifier for the authoring session of this very plan, not a dependency — it names this plan's own work. It also uses the deprecated `session_id` form (`plan_id` is canonical), so a reader trying to resolve it finds nothing. A self-referential entry in a Dependencies section reads as an unmet blocker and stalls dispatch.
  > **Replaced with:** **None**, stated explicitly.

## Adversarial Synthesis

Key risks: an accelerating rule read as licence for same-file concurrency, reintroducing the collision hazard the brakes exist to prevent; a "chain head is free" rule misapplied to the second element of a chain; and a worked example that becomes stale when the referenced feature changes. Mitigations: express the whole thing as an ordered procedure where the pairwise file check runs **after** independence is established and can only ever *remove* pairs from a concurrent batch, never add them; state the chain-head rule as "exactly the first unstarted element, and only while it is unstarted"; and write the example against a synthetic feature rather than a real one so it cannot rot. The objective check is that a head reading the new §7 against the *Teams as the main model* feature file produces a three-way opening dispatch rather than a one-way one.

Two risks were added by this pass, both discovered by checking claims against the tree rather than against sibling reports:

- **Editing a file that is not in the state the plans describe.** A sibling card in CODE REVIEWED reported rewriting §1/§4/§6 and adding a §7 transition rule; none of it is in the tree. An implementer who trusted that report would try to preserve a rule that does not exist, or would restructure §7 around it and produce a section that matches neither the file nor the report. Mitigation: the *Current state of the target file* section states the verified HEAD text up front, and Verification 10 asserts the missing rule is reported rather than quietly re-authored.
- **A one-line reword with a four-site blast radius.** The retired subtitle is duplicated in the manifest's `descriptionFallback` and in `AGENTS.md`'s skills table, neither of which `mirror:check` compares. The gate goes green with two stale copies standing — the same shape as the layer-skip failure its sibling feature exists to counter. Mitigation: the four-site table in Implementation Notes and the explicit grep in Verification 9.

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

- `.agents/skills/terminal-coder-dispatch/SKILL.md` is the source of truth; `.claude/` is a generated mirror resolved through `MIRROR_MANIFEST` (`src/services/ClaudeCodeMirrorService.ts:47`, this skill's entry at `:82`). Edit `.agents/` and regenerate; do not hand-edit the mirror, and do not edit only one.
- **The mirror's frontmatter legitimately differs from the source's** — `buildSkillMd` (`ClaudeCodeMirrorService.ts:411`) adds `name:`, quotes the `description:` value, and appends `user-invokable: false` for this skill (`invocation: 'no-user'`). A plain `diff` of the two files therefore always shows a three-line frontmatter delta. That is correct output, not drift; do not "fix" it by hand-editing the mirror. The real gate is `npm run mirror:check` (`scripts/check-claude-mirror.js`), which regenerates from `.agents/` into a temp dir and compares SHA-256 per file.
- Keep every existing brake in §7 verbatim. This plan adds cases; it softens nothing. The "never infer independence from absence" clause in particular must survive intact — it is correct and it is the fallback.
- Do not add a rule that encourages creating terminals. §9's prohibition stands: each terminal is a running agent CLI, and creation is not on the documented verb rail for agents.
- Keep the example synthetic. A worked example naming a real feature file rots the moment that feature ships.
- **The subtitle lives in four places, not one.** The phrase *"The attended long-running single-coder pattern"* contributed to the one-stream reading and is inaccurate for a multi-subtask feature. Rewording only the frontmatter leaves three stale copies:

  | # | Location | Status | Action |
  |---|---|---|---|
  | 1 | `.agents/skills/terminal-coder-dispatch/SKILL.md:2` — `description:` | source of truth | reword |
  | 2 | `src/services/ClaudeCodeMirrorService.ts:83` — `descriptionFallback` | duplicate literal; used only if the source loses its `description`, so inert today | reword to match #1 |
  | 3 | `AGENTS.md:116` — skills-table row ("Attended long-running single-coder driving…") | source of truth for the protocol doc | reword |
  | 4 | `.claude/skills/…/SKILL.md:3` and `CLAUDE.md:147` | generated from #1 and #3 | regenerate, never hand-edit |

  > **Superseded:** "Reword the description in the frontmatter, and remember the frontmatter is what the mirror manifest surfaces as the skill's one-line summary."
  > **Reason:** Half right and misleading in the other half. The manifest does not *surface* the frontmatter — it carries its own `descriptionFallback` string (`ClaudeCodeMirrorService.ts:83`) which is a second hard-coded copy of the same sentence, and `AGENTS.md:116` is a third. An implementer following the old note would reword one copy, watch `mirror:check` go green (it compares generated output, not the manifest literal), and leave the phrase this plan is trying to retire sitting in two source-of-truth files.
  > **Replaced with:** the four-site table above.

## Proposed Changes

### `.agents/skills/terminal-coder-dispatch/SKILL.md`

- **Context.** §7 *Sequencing across subtasks* contains four braking clauses and no accelerating one. §9 sizes the pool but never says which terminal to use. The frontmatter description says "single-coder pattern".
- **Logic.** Sequencing becomes an ordered procedure whose steps narrow monotonically; pool selection gains a rotation rule.
- **Implementation.** Rewrite §7 as the five-step procedure with the anti-pattern callout and a synthetic worked example. Add the rotation paragraph to §9. Reword the frontmatter description so it does not read as one-coder-by-design.
- **Edge Cases.** Preserve every existing constraint verbatim. The pairwise step must be expressed as *removing* pairs from a batch, never as a gate on forming one. §7 at HEAD is the four-brake paragraph and nothing else — it carries no subtask-transition rule, whatever the *Clear The Coder Between Subtasks* completion report says (see *Current state of the target file*).

### `src/services/ClaudeCodeMirrorService.ts`

- **Context.** `MIRROR_MANIFEST` (`:47`) holds this skill's entry at `:82`, including a `descriptionFallback` (`:83`) that is a verbatim second copy of the frontmatter description.
- **Logic.** One-line string change, no behaviour change. The fallback is only read when the source has no `description:`, so this is drift removal rather than a functional fix — but leaving it makes the retired phrase the value the mirror falls back to the moment anyone touches that frontmatter.
- **Implementation.** Update the `descriptionFallback` literal to match the new frontmatter description exactly.
- **Edge Cases.** Do not change `source`, `name`, or `invocation: 'no-user'` — the skill stays non-user-invokable.

### `AGENTS.md`

- **Context.** Line 116 is this skill's row in the *Available Skills* table, reading "Attended long-running single-coder driving — …". `AGENTS.md` is a source of truth; `CLAUDE.md` is generated from it and must not be hand-edited.
- **Implementation.** Reword the row to match the new description. Regenerate `CLAUDE.md` rather than editing line 147 directly.
- **Edge Cases.** This is the copy an agent most often reads when deciding whether the skill applies, so a stale row here defeats the reword even if all three other copies land.

### `.claude/skills/terminal-coder-dispatch/SKILL.md` (and `CLAUDE.md`)

- **Context.** Generated mirror; Claude Code resolves skills through `MIRROR_MANIFEST`, so a stale mirror leaves one host on the old rule.
- **Implementation.** Regenerate from `.agents/`. Do not hand-edit.
- **Edge Cases.** Confirm the five-step procedure and the rotation paragraph are both present in the mirror before considering the change complete. Expect the frontmatter to differ from the source by design (`name`, quoted description, `user-invokable: false`) — that delta is generated output, not drift.

## Verification Plan

1. **The reported case, replayed.** Give a head `.switchboard/features/teams-as-the-main-model-91252564-84b7-4d7e-b216-95d78dbfbe0d.md` and the new §7. Its opening dispatch must be **three** subtasks — the two under that file's `### Start any time, in parallel with anything` heading (*Clear The Coder Between Subtasks*, *A Terminal Shows The Wrong Agent CLI*) plus the head of its six-subtask chain (*Retire The Delegate Join Contract*) — not one. Verified present at HEAD: eight subtasks, two unconstrained, a strict six-chain. Note the file also carries a *release* gate ("subtask 3 must not be released without subtask 6") which constrains shipping, not dispatch — a head that dispatches two because it read the release gate as a dispatch gate has failed this test in a second, distinct way worth recording.
2. **The brake still holds.** Give a head a feature whose sequencing section is absent. It must go sequential in file order and say so.
3. **Pairwise, not global.** Give a head a feature where two of six subtasks share a file. Those two must serialise against each other; the other four must not be affected.
4. **Chain head only.** Confirm the head dispatches the first chain element concurrently and does **not** dispatch the second until the first lands.
5. **Pool cap.** Give a head five parallel-safe subtasks and two coders. It must dispatch two and hold three, and must not attempt to create terminals.
6. **Rotation.** Across a multi-subtask run, confirm consecutive subtasks go to different coders while idle ones remain, and that a fix resend goes back to the coder that did the work.
7. **Review is per-subtask.** Confirm the head reviews and advances each subtask as its report lands, rather than waiting for a batch.
8. **Both skill copies agree.** Run `npm run mirror:check` — it regenerates the mirror from `.agents/` and compares SHA-256 per file, which is the check a hand-diff only approximates. If running it is impractical in this pass (it needs `out/services/ClaudeCodeMirrorService.js`), fall back to diffing the two **bodies** and confirm the five-step procedure and the rotation paragraph appear in both; ignore the three-line frontmatter delta, which is generated by design.
9. **The retired subtitle is gone everywhere.** `grep -rn "single-coder" .agents/ .claude/ AGENTS.md CLAUDE.md src/services/ClaudeCodeMirrorService.ts` must return no hit for this skill in any of the four sites listed in Implementation Notes. One surviving copy in `AGENTS.md` or the manifest fallback is the likely miss, and neither is caught by `mirror:check`.
10. **The missing sibling rule is reported, not re-authored.** Confirm the finished §7 contains no clear/`clearBeforePrompt` transition rule, and that the completion report tells the operator that *Clear The Coder Between Subtasks* sits in CODE REVIEWED with its document half absent from the tree. This is a hand-off, not a fix, and it must not be silently absorbed.

### Automated Tests

None applicable — the artefact is a protocol document, and its behaviour is only observable through an agent following it. Verification is the replay in step 1, which is a concrete pass/fail against a feature file that still exists in the repo.

## Recommendation

Complexity 4 → **Send to Coder** (4-6 band).
