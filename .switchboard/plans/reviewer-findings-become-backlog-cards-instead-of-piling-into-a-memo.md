# Reviewer Findings Become Short Backlog Cards, Not a Memo Nobody Drains

kanbanColumn: CREATED

## Goal

A reviewer's remaining risks land on the board as short, individually addressable cards in Backlog, each linking to the plan it was found reviewing, at the moment the review ends. They stop accumulating in a file that nothing consumes.

*(The line above this section is the mechanism this plan is about, used on this plan. It names New explicitly so the template further down can show the real syntax without routing this card.)*

### Problem analysis

Reviewer findings are worth keeping. The 2026-09-04 drain of `.switchboard/memo.md` triaged 214 accumulated entries and **103 were real, current, unowned defects** — a 48% signal rate. The mechanism produces good work and then loses it.

`REVIEWER_RISKS_TO_MEMO_DIRECTIVE` (`agentPromptBuilder.ts:1117`) tells every reviewer to append each remaining risk to `.switchboard/memo.md`, and it is on by default. Nothing drains that file unless the operator runs `process memo`. So it grows: 214 entries, 98 KB, none of it on the board, none of it searchable, and 42 of the entries either stale or already fixed by the time anyone read them. Meanwhile a `memo-to-plans` job is scheduled daily to convert every entry into its own card, which on that backlog would have taken the board from 124 top-level cards to over 330 in one unattended run. The file is untracked by git, so its clear is unrecoverable.

**The fix is to skip the middle step.** A finding worth writing down is worth a card. Write the card.

**No new mechanism is needed.** `planMetadataUtils.ts:84` already parses a landing column out of the plan body, and `PlanIngestionEngine.ts:2010` already honours it, defaulting to `CREATED` only when it is absent. A plan file that names `BACKLOG` lands in Backlog today.

## Metadata

- **Complexity:** 3
- **Tags:** reviewer, prompts, plans, board-hygiene

## User Review Required

None.

## Proposed Changes

### 1. Rewrite the directive so reviewers write plans, not memo entries

Rewrite `REVIEWER_RISKS_TO_MEMO_DIRECTIVE` in `src/services/agentPromptBuilder.ts` — and rename it, since the memo is no longer the destination — so a reviewer writes **one short plan file per remaining risk** into `.switchboard/plans/`, instead of appending to a memo.

Two things carry over from the existing directive unchanged, because both were learned the hard way:

- **The absolute-path override.** If a path line follows the directive, it is authoritative.
- **Never write to a worktree-local `.switchboard/`.** A worktree's copy is discarded on cleanup, which loses the finding. The hazard is identical for plan files.

That second point needs care, because the constant has three emitters and they differ. `agentPromptBuilder.ts:2170` appends an absolute path line when a workspace root is available; `buildCustomAgentPrompt` (`:2820`) and `AgentSkillExporter.ts:270` emit the directive with **no path line at all**. On those two paths the reviewer is already resolving the directory itself, which is exactly the case the warning exists for. Rewriting the constant reaches all three, but each needs its own check that the directory it lands in survives cleanup.

**Backlog, not New.** New is the planning lane and its cards are dispatch candidates. A reviewer finding has not been planned by anyone and must not be picked up as though it had. Backlog is visible, searchable and triageable, which is everything the memo was not.

### 2. The short-plan shape

These are not full plans and must not be written as though they were:

```markdown
# <one sentence naming the defect>

kanbanColumn: BACKLOG

**Found reviewing:** [<plan title>](<plan-file>.md) — <planId>

## What is wrong

<two to four sentences. What the code does, what it should do.>

## Evidence

<the file:line the reviewer read, or the command it ran and the output.>

## Metadata

- **Complexity:** <1-10>
- **Tags:** <from the reviewed plan's area>
```

Three rules on the content, each earned from the drain:

- **Evidence is mandatory and first-hand.** The triage disproved entries by running the gate they named; 29 were dropped as unverifiable noise. If the reviewer did not check it, they do not file it.
- **One finding per file.** The memo's blank-line-separated blob had to be split by script before it could be read.
- **No speculation.** "This might be a problem" is not a finding.

Two rules on the shape, both load-bearing:

- **The column line goes directly under the title, above all prose.** The parser takes the *first* match in the file, so a declaration at the top cannot be overridden by a later mention of the field in the body — which matters here, because these findings quote code for a living.
- **The link is a bare filename.** The finding and the plan it came from are siblings in `.switchboard/plans/`. It carries the plan id too, so the reference survives a rename.

### 3. Retire the memo path and cap the job

With reviewers writing plans, the `reviewerRisksToMemo` toggle has no producer. Retire it, and leave `memo.md` to its other purpose — the operator's own capture surface, which is a different thing and still wanted.

Then cap `memo-to-plans`. It is one of four job definitions scaffolded by `ScheduledJobsService.ts:581-589`, runs daily, and its instruction is to turn every entry into a plan file and clear the memo. With no reviewer traffic the memo stays small and operator-authored, which is the case that job was written for — so keep it and bound it: above a threshold, say 20 entries, it reports instead of generating cards unattended.

That job file is **shipped state**. It is scaffolded to disk, so installs already hold the uncapped text and editing the scaffold does not change theirs. Either rewrite the on-disk copy when it matches a known previous version, or accept that existing installs keep the old job and say so.

## Edge-Case & Dependency Audit

1. **The worktree hazard is the main risk**, and two of the three emitters send no path line. Get this wrong and findings vanish on cleanup exactly as before — worse, silently, with no memo left to inspect.
2. **Filename collisions.** Two reviewers filing in the same minute must not overwrite each other. Slugify the title, suffix a short id.
3. **No `**Project:**` line.** The importer's auto-stamp handles it; a wrong pin is worse than none.
4. **Backlog must exist on the board** (58 cards here today). A workspace that has disabled it needs a fallback.
5. **Not for review-blocking defects.** Anything that should stop the review is raised in the review. This path is for *remaining* risks, which is what the directive already says.
6. **Backlog needs periodic triage.** 103 findings would have been 103 Backlog cards. Each is searchable and individually dismissible, which one 98 KB file was not — but a finding sitting there for months is a signal to close it, not to add another.
7. **The archive stays.** `.switchboard/reviews/memo-archive-2026-09-04.md` holds the original 214 entries and is tracked.

## Verification Plan

1. A reviewer finishing a review with two remaining risks produces two plan files, and both cards appear in **Backlog** with no manual move.
2. Each carries a working link to the reviewed plan and its plan id, and first-hand evidence.
3. A finding whose body mentions the column field in prose still lands in Backlog, not in whatever that prose named.
4. A finding filed from a worktree lands in the main checkout and survives cleanup — checked on all three emitters, including the two that send no path line.
5. Coder, lead coder and researcher prompts contain no findings directive.
6. `reviewerRisksToMemo` has no producer, and no reviewer path writes `.switchboard/memo.md`.
7. `memo-to-plans` reports instead of generating cards above its threshold.
8. The eight directive tests at `agentPromptBuilder.test.ts:196-264` are rewritten against the new behaviour, not deleted — the role-scoping ones are still real invariants. Run them by hand; that suite does not gate CI.
