# Reviewer Findings Become Short Backlog Cards, Not a Memo Nobody Drains

## Goal

A reviewer's remaining risks must land on the board as individually addressable cards in Backlog, each linking to the plan it was found reviewing, at the moment the review ends. They must stop accumulating in a file that nothing consumes.

### Problem analysis

Reviewer findings are valuable. The 2026-09-04 drain of `.switchboard/memo.md` triaged 214 accumulated entries and **103 of them were real, current, unowned defects** — including a green CI gate that was holding a bug in place, ten unowned findings on a Linear surface that shipped the day before, and a `kind:"message"` payload field that lets any HTTP caller strip a coder's safeguards. That is a 48% signal rate. The mechanism is producing good work.

The mechanism is also losing it.

**Why the memo fails.** `REVIEWER_RISKS_TO_MEMO_DIRECTIVE` (`agentPromptBuilder.ts:1117`) tells every reviewer to append each remaining risk to `.switchboard/memo.md`, and `reviewerRisksToMemo` is a shipped default. Nothing drains it unless the operator runs `process memo`. So it grows monotonically: by the drain it held 214 entries and 98 KB.

Three consequences, all observed:

- **The findings are invisible.** They are not on the board, so they are not searchable, not dispatchable, not assignable to a column, and no one reviewing the board sees them.
- **They rot.** 19 entries were stale and 23 had been fixed by the time anyone read them. Several existed only because a gate was red on the day they were written; the drain found five of those gates green.
- **Draining is destructive and all-or-nothing.** The memo skill's contract is one plan file per entry, then clear. Running it on 214 entries would have created 214 cards and taken the board from 124 top-level to over 330, undoing a hygiene pass in one command. A `memo-to-plans` job is scheduled **daily** to do exactly that. And the file is untracked by git, so the clear is unrecoverable.

**The fix is to skip the middle step.** A finding worth writing down is worth a card. Write the card.

**The landing mechanism already exists and is unused.** `planMetadataUtils.ts:84-85` parses a column field out of the plan body, and `PlanIngestionEngine.ts:2010` honours it, falling back to `CREATED` only when the field is absent. So a plan file that names `BACKLOG` lands in Backlog today, with no new code. Nothing in the reviewer path uses this.

## Metadata

- **Complexity:** 4
- **Tags:** reviewer, prompts, plans, board-hygiene

## User Review Required

None. The one judgement call, whether Backlog is the right column, is answered in change 1 and is reversible by editing one word in the directive.

## Proposed Changes

### 1. Replace the memo directive with a plan-file directive

Rewrite `REVIEWER_RISKS_TO_MEMO_DIRECTIVE` in `src/services/agentPromptBuilder.ts` — and rename it, since the memo is no longer where the risks go — so a reviewer writes **one short plan file per remaining risk** into the workspace's `.switchboard/plans/`, instead of appending to a memo.

Keep two things from the existing directive verbatim, because both were learned the hard way:

- The absolute-path override. If a path line follows the directive, it is authoritative.
- **Never write to a worktree-local `.switchboard/`.** A worktree's copy is discarded on cleanup, which loses the finding. This hazard is identical for plan files and must survive the rewrite.

**Backlog, not New.** New is the planning lane and its cards are candidates for dispatch. A reviewer finding has not been planned by anyone and must not be picked up as though it had. Backlog is a holding column that is visible, searchable and triageable — which is everything the memo was not.

### 2. Define the short-plan shape, and hold reviewers to it

These are not full plans and must not be written as though they were. The shape:

```markdown
# <one sentence naming the defect>

<COLUMN-FIELD>: BACKLOG

**Found reviewing:** [<plan title>](<plan-file>.md) — <planId>

## What is wrong

<two to four sentences. What the code does, what it should do.>

## Evidence

<the file:line the reviewer actually read, or the command they ran and its output.>

## Metadata

- **Complexity:** <1-10>
- **Tags:** <from the reviewed plan's area>
```

`<COLUMN-FIELD>` above stands in for the real field name, which change 4 quotes verbatim from the parser. This plan does not spell it literally, because the unanchored regex in change 4 would then read this file's own template and import **this card** into Backlog. That is not a stylistic dodge — it is the defect, reproduced. Before the fix, the first bare occurrence in this file resolved the column to `metadata`, which is not a column at all.

Three rules, each earned from the drain:

- **Evidence is mandatory and must be first-hand.** The triage disproved entries by running the gate they named. An entry whose claim cannot be checked is worthless; 29 were dropped as noise for exactly this.
- **One finding per file.** The memo's blank-line-separated blob had to be split by a script before it could be read.
- **No speculation.** "This might be a problem" is not a finding. If the reviewer did not check, they do not file.

### 3. Link back, and make the link resolvable

The `**Found reviewing:**` line is the linkout. It carries both a relative markdown link, so it is clickable in any preview, and the planId, so it survives a file rename. The link is a bare filename because the finding and the plan it came from are siblings in the same `.switchboard/plans/` directory.

Parsing it into a stored field is **not** part of this change. A body link needs no parser and no migration, and the drain showed the reader is usually a human deciding whether a finding still matters. If the board later wants to group findings by their origin card, add the parse then.

### 4. Fix the column regex before relying on it

`planMetadataUtils.ts:85` matches `/kanbanColumn[:\s]+(\w+)/i` against the **whole file**. Two problems, and this change is what makes them load-bearing:

- `\w+` cannot match a column with a space, so `PLAN REVIEWED` is unreachable. `BACKLOG` works, which is why this plan uses it, but the limitation should be recorded rather than discovered later.
- The pattern is unanchored, so the literal string `kanbanColumn` **anywhere in the file** sets the column. A reviewer filing a finding *about* column handling would name it in their evidence and silently redirect their own card.

Anchor it to a metadata line at the start of a line, and accept a quoted multi-word value.

### 5. Retire the memo path for reviewers, and cap the scheduled job

With reviewers writing plans, `reviewerRisksToMemo` has no producer. Retire the toggle, and leave `memo.md` to its other purpose — the operator's own capture surface, which is a different thing and still wanted.

Then cap the `memo-to-plans` scheduled job. It is one of four job definitions scaffolded by `ScheduledJobsService.ts:581-589`, it carries `schedule: daily`, and its instruction is "process each entry into a distinct plan file... clear or truncate on completion". With no reviewer traffic the memo is small and operator-authored, which is the case that job was written for, so keep it and bound it: refuse to run above a threshold, say 20 entries, and report instead of generating a hundred cards unattended.

Note that this is **shipped state**. The job file is scaffolded to disk, so installs already carry a copy of the old text. Changing the scaffold does not change theirs. Either rewrite the on-disk file when its content matches a known previous version, or accept that existing installs keep the uncapped job and say so.

### 6. Three call sites emit this directive, and two of them omit the path line

The directive is not emitted once. It has three emitters, and they do not behave the same:

| Emitter | Emits `MEMO FILE:` absolute path? |
|---|---|
| `agentPromptBuilder.ts:2170` (kanban reviewer) | Yes, when `workspaceRoot` is available |
| `agentPromptBuilder.ts:2820` (`buildCustomAgentPrompt`) | **No** |
| `AgentSkillExporter.ts:270` (skill export) | **No** |

So on two of three paths the reviewer is already resolving the path itself, against a directive that warns it must not be a worktree's copy. That is the worktree hazard, live, today — and it is why change 1 keeps the warning rather than assuming a path line will always be there.

Rewriting the constant fixes the text on all three, but each emitter needs its own check that the plans directory it names is the right one. The skill-export path additionally writes the directive to **disk**, so exported skills in existing installs carry the old memo instruction until re-exported.

### 7. Rewrite the tests, do not delete them

Eight tests in `agentPromptBuilder.test.ts:196-264` assert on this directive: that it is injected by default for the reviewer, omitted when disabled, absent from every non-reviewer role, that it renders an absolute path from `workspaceRoot` and omits that line without one, and that the toggle flows through `buildCustomAgentPrompt` and `normalize`.

Every one of those assertions is still a real invariant under the new directive. The role-scoping tests in particular must survive unchanged in intent — a findings directive leaking into a coder's prompt would have coders filing cards mid-implementation.

Note for whoever codes this: `npm test` is not wired into CI, so these tests do not gate. They will not catch a regression on their own; run them by hand.

### 8. Say what happens to Backlog

Volume does not disappear; it becomes addressable. 103 findings would have been 103 Backlog cards, which is a lot of Backlog.

That is still strictly better than one 98 KB file, because each is searchable, individually dismissible, and visible to anyone looking at the board. But the plan should say plainly that **Backlog needs periodic triage**, and that a finding sitting there for months is a signal to close it rather than to add another.

## Edge-Case & Dependency Audit

1. **Filename collisions.** Two reviewers filing in the same minute must not overwrite each other. Slugify the title and suffix a short id.
2. **The worktree hazard is the main risk.** Reviewers often run in a worktree. If the directive's path resolution is got wrong, findings vanish on cleanup exactly as before — worse, silently, since there is no memo to inspect.
3. **Project pinning.** These plans should carry no `**Project:**` line. The importer's auto-stamp handles it, and a wrong pin is worse than none.
4. **Backlog is a valid column** on this board today (58 cards). Confirm it is present before relying on it; a workspace that has hidden it needs a fallback.
5. **Do not use this for review-blocking defects.** A defect that should stop the review is raised in the review, not filed for later. This path is for *remaining* risks, which is what the existing directive already says.
6. **The archive stays.** `.switchboard/reviews/memo-archive-2026-09-04.md` holds the 214 entries and is tracked. Nothing here should remove it.

## Verification Plan

1. A reviewer completing a review with two remaining risks produces two plan files, and both cards appear in **Backlog** without any manual move.
2. Each card's body carries a working link to the plan under review and its planId.
3. Each card carries first-hand evidence: a file and line, or a command and its output.
4. A finding filed from a worktree lands in the main checkout's `.switchboard/plans/`, and survives worktree cleanup.
5. A plan file that mentions `kanbanColumn` only in its prose lands in New, not in whatever column that prose named.
6. `reviewerRisksToMemo` has no producer, and `.switchboard/memo.md` is not written by any reviewer path.
7. The `memo-to-plans` job refuses above its threshold and reports, rather than creating cards unattended.
8. Two reviewers filing simultaneously produce two files, not one.
9. All three emitters produce the new directive, and each names a plans directory that survives worktree cleanup.
10. The eight directive tests are rewritten against the new behaviour and pass, including the role-scoping ones. Run them by hand; CI does not.
11. A coder, lead coder and researcher prompt contain no findings directive.
