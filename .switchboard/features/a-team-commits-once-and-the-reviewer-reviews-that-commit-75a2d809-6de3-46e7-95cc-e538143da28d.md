# A Team Commits Once, And The Reviewer Reviews That Commit

**Complexity:** 6

## Goal

A commit is a completed body of work. Today a team produces one commit per subtask, each swept out of a shared working tree by whichever member finished first, and none of them is the feature - the 2026-08-17 incident put a peer's unfinished sidebar work and about forty files of unrelated churn into one coder's commit.

This feature makes a team commit once, as its head: members report instead of committing, the head closes the body, and that commit carries the stage and the plan ids of the work it closes. The reviewer is then handed that commit as its review unit, replacing a review step that today infers its target from plan file prose and whatever happens to be sitting in the tree.

## How the Subtasks Achieve This

- **A Coder's Commit Sweeps the Whole Shared Tree**: bounds *what enters* any commit. Moves the staging-scope rule out of the opt-in commit clause — where it has been gated behind a `gitCommitStrategy` no role in this workspace sets — and into the always-on safety guardrail, so it reaches every committer regardless of configuration. The clause is anchored on the work being committed rather than on authorship, because under this feature the head commits files it did not write.

- **A Lead-Dispatched Plan Is Never Registered**: makes the seat→plan dispatch record a property of the delivery layer instead of a `curl` a lead must remember. That record is what the stall sweep, the turn-end notifier and the trailer plan ids all read, so every mechanism downstream of it inherits its reliability. Also fixes a shipped regex that captures `"6"` out of a UUID plan id.

- **A Team Commits Once, As Its Head**: the spine. A non-head member of a live team is told not to commit; the head is told to commit the body. Team membership does the gating, so there is no new setting — role config keeps working unchanged for every seat that is not a team member, and the board dispatch path stays ungated because it bypasses the head entirely.

- **A Lead-Dispatched Coder's Commits Carry No Stage Trailers**: marks the head's commit with the stage and the plan ids of the work it closes, resolving those ids from the head's team roster rather than from its own (empty) dispatch record. This is what turns a commit into something findable.

- **The Reviewer Is Never Told What To Review**: consumes those trailers to resolve the coded commit and names it in the reviewer's prompt. Today no prompt in the product points a reviewer at a diff, a commit or a range — this supplies a review unit that has never existed, and degrades to exactly today's text when no commit resolves.

## Reconciled end-state

*Recorded by the improve-feature reconciliation pass, 2026-08-17. Four defects existed between the subtasks — not inside them. All four are now fixed in the subtask files; this section is the merge map so a coder implements to one design.*

**The set was not restructured.** No merge, no split, no deletion. Each subtask owns a distinct surface and a distinct root cause, and each is independently verifiable. Folding #2/#3/#4 into one "seat delivery layer" plan was considered and rejected: it would produce a single plan with three unrelated root causes, one undifferentiated verification plan, and no way to gate between the behaviour change and the plumbing.

**The contended surfaces, and who owns each:**

| Surface | Owner | Other subtasks |
| :--- | :--- | :--- |
| `GIT_SAFETY_DIRECTIVE` (`agentPromptBuilder.ts:553`) + its 3 mirrors | #1 | none |
| `extractPastedDispatchIdentity` → `src/services/dispatchIdentity.ts` | #2 | none |
| `resolveTeamStanding` (`standingOrders.ts`) | **#3 defines** | **#4 consumes `.members`** |
| `SeatDirectiveOptions` / `buildSeatDirectiveBlock` (`:1007-1068`) | #4 | none |
| Reviewer `promptParts` (`:1682-1691`) | #5 | none |
| `_ptyHostVerb` (`TaskViewerProvider.ts:487-644`) | **shared** | #2, #3, #4 |
| `deliverPrompt` (`bootstrap.ts:246-319`) | **shared** | #2, #3, #4 |
| `seat-safeguards-fleet-prompt-path.test.js` | **shared** | #3 (+8 cases), #4 (+10 cases) |

**Intra-function ordering inside the two shared bodies.** The plan order below fixes *which plan lands when*; this fixes *where each plan's code sits*, and it is not derivable from the plan order:

1. **#2's parse** reads the original `payload.data` / `text` — topmost, before any block is appended or rewritten.
2. **#3's config hoist + `resolveTeamStanding`** — must precede both the seat-options override and #4's lookup.
3. **#4's `planIds` resolution** — reads `standing.members`, then composes the block.

**The four cross-subtask defects fixed in this pass:**

1. **Signature contradiction (#3 ↔ #4).** #3 declared `resolveTeamStanding` returning `{inTeam, isHead, teamId?, headName?}`; #4's implementation read a `roster` off that call. #3 now returns `members: string[]` (roster verbatim, `[]` when not in a team); #4 consumes `standing.members` and filters the head out itself. Without this, #4 would not have compiled against its own prerequisite, and the likely repair — a hand-rolled `groups.find(...).members` in both hosts — is the exact drift #3's extract-the-predicate rule exists to prevent.
2. **False root cause (#2).** `ptySendPrompt` was described as writing no dispatch record. It does, on both hosts, whenever the caller supplies a `payload.dispatch` object — strictly, refusing the send on `attributed === 0`. #2 now guards its parse-based registration on `!hasDispatch`, so the two writers are mutually exclusive rather than racing one row's `dispatched_at`.
3. **Delivery-layer cache, missed by every subtask (#4).** Both hosts memoise the composed seat block per `agentInstanceId` and suppress an unchanged one. #4 makes that block dispatch-varying by putting `planIds` in it. The ids must be sorted, or DB row order alone re-sends the entire seat block on every message to that seat; and `SeatDirectiveOptions`' doc comment — which states dispatch-scoped inputs are "deliberately absent" — must be amended in the same change.
4. **Mirror-shape asymmetry (#1).** The two webview copies of `GIT_SAFETY_DIRECTIVE` are pinned by extractors with different capabilities: `terminals.js` is read with `'([^']*)'` and must stay **one unbroken literal**; `kanban.html` is read with `readQuotedChain` and may stay `+`-joined. This is also the real reason apostrophes are barred — the char class truncates at the raw quote regardless of escaping.

**Line-number drift.** Every subtask's file references were re-anchored against the working tree during this pass. The largest movers: seat-block composition `TaskViewerProvider.ts` 491 → 594-597; `bootstrap.ts` 256 → 281-284; `SeatDirectiveOptions` 1010-1024 → 1019-1034; `terminals.js` parser 7438 → 7452 and its regex 7450 → 7463; `KanbanProvider` git call sites 12443/12454 → 12463/12476.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A Coder's Commit Sweeps the Whole Shared Tree, Including Its Peers' Unfinished Work](../plans/agent-commits-sweep-the-whole-shared-tree.md) — **CODE REVIEWED** — ID: b93fd9a7-bd7a-4e8a-9856-1643f69604f4
- [ ] [A Lead-Dispatched Coder's Commits Carry No Stage Trailers, So Coded Work Reads as Unmarked](../plans/lead-dispatched-commits-carry-no-stage-trailers.md) — **CODE REVIEWED** — ID: 6bef84f4-726d-437c-8ad2-dbc3f34af9d9
- [ ] [A Team Commits Once, As Its Head — Members Never Commit Their Own Subtasks](../plans/a-team-commits-once-as-its-head.md) — **CODE REVIEWED** — ID: 2b16329d-449b-492c-b813-5cbf0ec1dc15
- [ ] [The Reviewer Is Never Told What To Review — It Is Handed Plan Paths and a Dirty Tree](../plans/the-reviewer-is-never-told-what-to-review.md) — **CODE REVIEWED** — ID: fa698121-1cc5-4fbd-b7be-78fdf6dccfa2
- [ ] [A Lead-Dispatched Plan Is Never Registered, So Every Backstop Downstream Is Blind](../plans/a-lead-dispatched-plan-is-never-registered.md) — **CODE REVIEWED** — ID: 3e13cb1c-0d5a-4af0-b766-572ac0dbd994
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strictly sequential.** Four of the five edit the same two function bodies — the seat-block composition in `TaskViewerProvider._ptyHostVerb` and `standalone/bootstrap.ts` `deliverPrompt` — and four touch `src/services/agentPromptBuilder.ts`. One stream, one plan at a time. Do not parallelise any pair.

Execution order, and why each position is load-bearing:

1. **A Coder's Commit Sweeps the Whole Shared Tree** — no prerequisites, and it edits a constant (`GIT_SAFETY_DIRECTIVE`) rather than the contended function bodies. Goes first so it is not stuck behind the chain.
2. **A Lead-Dispatched Plan Is Never Registered** — before #4, which reads the dispatch records this writes. Landing it later leaves #4 resolving stage-only trailers.
3. **A Team Commits Once, As Its Head** — before #4 and #5. It exports `resolveTeamStanding`, which #4 reuses for the head's roster, and it forces a head to a committing strategy, which is what makes #4's trailer instruction actually emit rather than sit behind the shipped `notSpecified` default.
4. **A Lead-Dispatched Coder's Commits Carry No Stage Trailers** — hard prerequisite for #5. Without trailers on the head's commit there is nothing for the reviewer's query to find.
5. **The Reviewer Is Never Told What To Review** — last. It is the only consumer, and it is the step that makes the preceding four visible as a product behaviour rather than as plumbing.

**External conflicts.** `src/webview/kanban.html` (touched by #1) is contended by the *Teams You Can See, Start and Trust* feature's remaining subtasks — serialise behind them. The seat-block function bodies are also contended by `a-lead-dispatched-agent-is-told-less-than-a-board-dispatched-one.md` (`d91d7daf`, PLAN REVIEWED), which fixes the completion-report half of the same seam; sequence it before or after this feature, never during.

**Gate between #3 and #4.** #3 changes what a live team is told about committing, and it is the only subtask that alters behaviour for a seat an operator is actively using. Verify it by hand — the manual steps are written for it — before starting #4.

## Review Findings

All five subtasks reviewed in-place against their plan files, landed in `d0a9eae4`. One CRITICAL and two MAJOR found and fixed: `resolveTeamStanding` resolved headship only from the `team-head` standing order, which `wireSpawnedTeam` writes only for a team with a non-empty `headPrompt` — one of three shipped team types — so every other team gagged its members while its head kept the shipped `notSpecified` default and was told to commit nothing, which also starved subtask #4's trailers and subtask #5's review unit; headship now resolves from the always-written `team` order's `parent` as well. The two MAJORs were red CI gates: a hoist comment in `bootstrap.ts` put the token `applyStandingOrders` textually above `buildSeatDirectiveBlock` and tripped the source-text ordering assertion, and `paste-attribution-contract.test.js:56` pinned the exact `\d+` plan-id regex subtask #2 exists to correct. Files changed by this review: `src/services/standingOrders.ts`, `src/standalone/bootstrap.ts`, `src/test/paste-attribution-contract.test.js`, `src/test/seat-safeguards-fleet-prompt-path.test.js`. Validation: `tsc -p tsconfig.test.json` clean, `eslint src` 0 errors, and seat-safeguards 94/0, stage-marker-commit 44/0, standing-orders-marker 55/0, terminal-plan-attribution 40/0, paste-attribution 8/0, team-scoped-routing 41/0, multi-parent-terminals 29/0, team-autostart-scope 22/0 — all eight suites are CI-wired in `.github/workflows/integration-tests.yml`. Remaining risks, both accepted per the plans: `selectOrders` ANDs the shared predicate onto its inline test rather than replacing it (narrower only for a multi-team seat), and a team-member reviewer receives `Do NOT commit` on `ptySendPrompt` while its real board dispatch stays ungated.
