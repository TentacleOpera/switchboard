# A Coder's Commit Sweeps the Whole Shared Tree, Including Its Peers' Unfinished Work

## Goal

Stop a fleet coder from committing files it did not touch. Add a staging-scope clause to the git-safety directive every dispatched agent receives, so "commit your work" means "stage the files this plan named" rather than `git add -A`. The directive today enumerates the commands that *destroy* work and says nothing about which files to *stage* — and the one instruction it does give ("commit first, then correct forward") actively pushes an agent toward committing, with `git add -A` as the shortest path.

### Problem analysis and root cause

**Observed, not hypothesised.** On 2026-08-17, during the *Teams You Can See, Start and Trust* feature, two coders (`lead-1-coder-1`, `lead-1-coder-2`) were driven concurrently in **one shared working tree** on file-disjoint subtasks — the documented `terminal-coder-dispatch` pattern, and correct under the one-stream-per-file rule.

`lead-1-coder-1` finished its subtask and committed as `226b7f09`. It ran `git add -A`. The commit contains:

| Category | Content |
| :--- | :--- |
| **Intended** | 5 files: `teamWiring.ts`, `KanbanProvider.ts`, `TaskViewerProvider.ts`, `bootstrap.ts`, `team-autostart-workspace-scope.test.js` |
| **A peer's unfinished work** | `src/webview/terminals.html` (57 lines), `src/webview/terminals.js` (255 lines) — `lead-1-coder-2`'s in-flight subtask |
| **Unrelated tree churn** | ~40 files: `.agents/` and `.claude/` skills, `.github/workflows/integration-tests.yml`, a dozen plan and feature files |

The coder self-reported it accurately: *"git add -A bundled in untracked plans/features from other coders' working tree into the same commit — not destructive, just not isolated."*

**Root cause.**

> **Superseded:** *"the directive constrains destruction, not staging scope"* — read as *nothing anywhere bounds what enters a commit*.
> **Reason:** Half right, and the missing half is the whole mechanism. A staging-scope rule **does** exist, and it is nearly the sentence this plan proposes. `GIT_COMMIT_CLAUSES.whenDone` (`agentPromptBuilder.ts:575`) reads: *"When you have finished the task, stage the files you changed by explicit path — never `git add -A` or `git add .`. Do not stage anything under `.switchboard/` except this plan's own file …"*. It landed in `2268fb5e` at 12:29 on 2026-08-17 — **33 minutes before** `226b7f09` at 13:02. The coder was not un-instructed because the instruction was unwritten; it was un-instructed because the instruction was **gated**.
> **Replaced with:** The staging rule lives inside the **Commit clause**, which `buildGitPolicyBlock` emits only when `commit && commit !== 'notSpecified' && GIT_COMMIT_CLAUSES[commit]` (`:673`). `resolveSeatPromptOptions` (`KanbanProvider.ts:5296`) resolves `gitCommitStrategyByRole?.[role] ?? 'notSpecified'`, and this workspace's stored coder config carries **no `gitCommitStrategy` key at all**:
>
> ```
> $ sqlite3 .switchboard/kanban.db \
>     "select value from config where key='switchboard.prompts.roleConfig_coder';"
> … "addons": { …, "gitProhibition": true, … }   # no gitCommitStrategy
> ```
>
> So the coder resolved to `notSpecified` → **no Commit clause** → no staging rule. The guardrail resolves `gitProhibitionByRole?.[role] ?? true` and was ON, which is why the safety directive quoted below was in fact *the only git text that reached the seat*. **The fix is unchanged and the reason for it is now stronger: put the staging rule where it is unconditional.**

`GIT_SAFETY_DIRECTIVE` (`src/services/agentPromptBuilder.ts:553`) reads in full:

> Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout \`<path>\` / git restore, git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — commit first, then correct forward.

Every clause is about *not losing* work. Nothing bounds *what enters a commit*. An agent obeying this directive to the letter — as this one did; it discarded nothing — still sweeps its peers' work in. The directive's closing instruction makes it likelier, not less likely: an agent told to "commit first" reaches for the fastest total stage.

**Why the harm is real even though nothing was destroyed.** The git policy holds — no work was lost, and this plan proposes no history rewrite. The damage is to *correctability*:

1. **No isolated commit to correct forward from.** `226b7f09` is the only commit carrying coder-2's sidebar work, under coder-1's message and authorship. If the sidebar subtask fails review, there is no commit that is just that subtask.
2. **A commit message that misdescribes its contents.** `fix(team-verbs): resolve team defs from board's selected root, not pinned root` is accurate for 5 files and silent about ~45 others. `git log -S` archaeology — the codebase's documented debugging idiom — lands on a commit whose subject explains nothing about the line it found.
3. **It re-triggers the plan watcher.** A working-tree-changing git op makes the watcher re-import plan files; the wider the commit, the more board state is touched by a change that was supposed to be five source files.

**Why this is a directive bug and not a coder bug.** The seat safeguard block is the *only* git instruction a dispatched coder receives — it rides the delivery layer (`_ptyHostVerb` / `deliverPrompt`) precisely so behaviour does not depend on what a lead remembers to type. A failure mode reachable by an agent that followed that block exactly is a gap in the block.

**Scope note — worktree mode is deliberately excluded.** `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` (`:566`) is selected when `worktreePerPlanActive` (`:698`). That mode gives each plan its own worktree, so the agent *is* the only writer of its tree and `git add -A` stages nothing that is not its own. Adding the clause there would be boilerplate against a condition that cannot occur. The two constants are already separate literals with divergent text; this widens that divergence on purpose.

## Metadata

**Complexity:** 3
**Tags:** bugfix, reliability, test

## User Review Required

None. The clause text, its quoting, its placement in one of the two constants, and the mirror set are all determined by the existing contract tests and by the worktree-mode exclusion argued above.

## Complexity Audit

### Routine

- Appending one sentence to one exported string constant.
- Propagating that sentence to the mirrors the contract tests already pin.

### Complex / Risky

- **This prose exists in four places and only three are test-pinned.** Editing the source of truth alone turns two contract tests red; editing three of the four leaves a silent drift in the fourth.

  | Copy | Location | Pinned by |
  | :--- | :--- | :--- |
  | Source of truth | `agentPromptBuilder.ts:553` | — |
  | Worktree variant | `agentPromptBuilder.ts:566` | **nothing** |
  | Webview mirror | `terminals.js:8831-8832` (`GIT_SAFETY_DIRECTIVE_CLIENT`) | `standing-orders-marker-contract.test.js:252` (byte equality) |
  | Shipped team prompts | `kanban.html` `SHIPPED_TEAM_TYPES` (`:4643` array; safety text at `:4656`, `:4672`, `:4703`) | `standing-orders-marker-contract.test.js:295` (all three prompts must *end with* the constant verbatim) |

  The worktree variant being unpinned is the trap: it is the copy a reader is most likely to "keep in sync" out of symmetry, and doing so is wrong here.

- **The two webview mirrors have DIFFERENT append shapes, because their two extractors differ.** This is not a style choice; getting it wrong turns a byte-equality test red for a reason that reads as unrelated to the edit.

  | Mirror | Test extractor | Append shape |
  | :--- | :--- | :--- |
  | `terminals.js` | `/GIT_SAFETY_DIRECTIVE_CLIENT\s*=\s*\n?\s*'([^']*)'/` | **One unbroken single-quoted literal.** `[^']*` stops at the first closing quote, so a `+`-joined chain captures only the first segment and the assertion compares a truncated string. |
  | `kanban.html` | `readQuotedChain(...)` — reassembles `+`-joined segments | A `+ '…'` continuation segment is fine, and is the existing shape of all three prompts. |

  `terminals.js:8831-8832` is currently one literal on a single line. Keep it one literal: append inside the existing quotes even though the line gets long. Do **not** reformat it into a chain for readability.

- **The apostrophe ban is enforced by that same `[^']*` extractor, not by JavaScript.** An escaped `\'` is legal inside a single-quoted string — `kanban.html` already uses `feature\'s` at `:4667` — but `[^']*` terminates the capture at the raw `'` regardless of the backslash, so an apostrophe anywhere in the `terminals.js` mirror truncates the extracted value and fails byte equality. That is the real mechanism, and it is why the ban applies even though the string would parse fine.

  A **fifth** consumer needs no edit and is worth knowing about: `teamWiring.ts` **imports** `GIT_SAFETY_DIRECTIVE` (`:7`) and appends it when composing a team's standing order (`:813`, `:1008`). Newly wired and newly migrated teams therefore pick the clause up automatically. Neither migration recogniser is at risk — `migrateTeamPairOrders` matches `PRE_REWRITE_CALLBACK_INSTRUCTION` by equality and `migrateCodingTeamOrders` matches the fragment `'satisfied with it, hand it to review yourself'`. Neither reads the git-safety text, so lengthening it breaks no recognition.

- **The clause must contain no apostrophe. Backticks are not only safe — they are required.**

  > **Superseded:** *"A clause containing an apostrophe would terminate the single-quoted mirror, and a clause containing a backtick needs escaping host-side. **The clause must contain neither.**"*
  > **Reason:** The apostrophe half is correct; the backtick half is false, and acting on it breaks a test. `GIT_SAFETY_DIRECTIVE` **already contains backticks** (``git checkout \`<path>\``) and every mirror already carries them: the host is a template literal so they are written `\``, the extractor unescapes with `.replace(/\\`/g, '`')`, and both the `terminals.js` and `kanban.html` copies are *single-quoted*, where a backtick is an ordinary character needing no escape — the test's own comment says so. Worse, a backtick-free clause turns `stage-marker-commit-contract.test.js:173` **red**: that test strips `` /never `git add -A`/g `` (backticks required) and then asserts no bare `git add -A` survives. A clause reading `never git add -A` is not stripped, so the assertion fails.
  > **Replaced with:** Write `git add -A` and `git add .` in backticks, matching the surrounding prose and the `whenDone` clause. Apostrophes remain barred — not because the mirror would fail to parse (an escaped `\'` is legal, and `kanban.html:4667` already uses one) but because the `terminals.js` byte-equality extractor is `'([^']*)'` and truncates the capture at the raw quote. This choice keeps every existing contract test green with no test edit.
  >
  > Verified against the current stripper at `stage-marker-commit-contract.test.js:177`: it removes `` /never `git add -A`/g `` and then asserts `` /(?<!never `)git add -A/ `` finds nothing. The proposed clause's `` never `git add -A` `` is stripped whole; the residual `` or `git add .` `` is not matched by that assertion. Green with no test edit.

- **The clause deliberately duplicates the `whenDone` staging rule, and the duplication must stay.** With this change a seat configured `whenDone` receives the rule twice — once in the Commit clause, once in the guardrail. Do **not** resolve that by trimming `whenDone`: the guardrail is an independent checkbox and can be off (the shipped `planner` role has `gitProhibition: false`), so each clause must stand alone. Two adjacent sentences of prompt text is the correct price for a rule that must reach an agent under either configuration.

- **The committer is not always the author, so the clause must not say "your task".** Three seats commit under the team model, and only one of them wrote what it is committing: a team head commits its members' body of work, a reviewer commits its own fixes on top of the head's commit, and a solo board-dispatched coder commits its own subtask. Wording anchored on authorship is wrong for the first and pushes it toward the greedy stage this plan exists to forbid. Anchor on the **work being committed** — see the superseded callout under Proposed Changes.

- **This does not make the staging rule redundant once teams commit once.** `a-team-commits-once-as-its-head.md` removes the *intra-team* collision by silencing members, but the original incident was ~45 files, of which only two were the peer's subtask. The rest — `.agents/` and `.claude/` skills, `.github/workflows/`, a dozen plan and feature files — is tree churn that a head running `git add -A` sweeps in just as readily, along with any concurrent solo coder or second team sharing the tree.

- **One line, not a paragraph.** The established convention for agent-facing safety prose in this codebase is a single line. A multi-sentence rationale here becomes boilerplate the model skims, and it is duplicated into four files.

- **Teams already on disk carry the old prose.** `SHIPPED_TEAM_TYPES` prompts are copied into a team's stored `prompt` at adopt time, so ~4,000 installs hold teams whose prompt predates this clause. This is shipped state.

## Edge-Case & Dependency Audit

**Race Conditions** — none. The constants are read at prompt-composition time.

**Security** — none. No new input is accepted from any wire; this is outbound prompt text.

**Side Effects** — every dispatched agent's prompt grows by one line whenever the guardrail is on (its `?? true` default). Agents in worktree mode see no change. Agents with the guardrail explicitly disabled see no change.

**Migration** — the constants are code and update with the VSIX. Teams **already adopted** hold a copied `prompt` in `terminals.agentGroups` and do not pick up the new clause. That is the same behaviour as every prior edit to this prose (the `migrateCodingTeamOrders` pass exists precisely because adopted prompts go stale), and re-authoring stored operator-editable prompts is out of scope for a one-line clause. Newly adopted teams get it immediately. **Do not add a migration pass for this** — the delivery-layer directive is what actually reaches a seat, and it updates with the code.

**Dependencies & Conflicts** — touches `src/services/agentPromptBuilder.ts`, `src/webview/terminals.js`, `src/webview/kanban.html`.
- `kanban.html` is contended by the *Teams You Can See, Start and Trust* feature's remaining subtasks (it is modified in the working tree right now) — serialise behind them under the one-stream-per-file rule.
- `agentPromptBuilder.ts` is contended by `lead-dispatched-commits-carry-no-stage-trailers.md`, `a-team-commits-once-as-its-head.md` and `the-reviewer-is-never-told-what-to-review.md` (all in different regions — the seat/git-policy plumbing and the reviewer block, not the constant at `:553`). Serialise; this plan can go first, and should, since it is the only one of the four with no prerequisites.

## Dependencies

- None as a prerequisite. `226b7f09` is the evidence, not a dependency. This plan proposes no change to that commit — correcting it forward is not required and rewriting it is barred by the git policy.
- `src/test/stage-marker-commit-contract.test.js` is a **guard**, not a prerequisite: its `:173` case (`no emitted policy text prescribes \`git add -A\` or \`git add .\`, for any strategy`) reads the guardrail output and constrains how the clause may be written. It must stay green unmodified.

## Adversarial Synthesis

**Risk summary.** The dominant risk is not the clause but its propagation and its quoting: four copies with only three pinned, and the unpinned one (`GIT_SAFETY_DIRECTIVE_WORKTREE_MODE`) is the copy a tidy-minded implementer will "fix" for symmetry — silently telling worktree agents not to use the one staging command that is correct in an isolated tree. The second risk is writing the command names bare: an apostrophe breaks the single-quoted mirrors, and a backtick-free `git add -A` slips past `stage-marker-commit-contract.test.js:173`'s stripper and turns it red for a reason that reads as unrelated. Mitigations: the worktree exclusion is argued above and asserted as a negative test; the clause is specified below as apostrophe-free with both command names in backticks, exactly matching the existing prose and the stripper the test already applies; and the mirror byte-equality tests catch any copy left behind.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` — one clause, one constant

- **Context:** `GIT_SAFETY_DIRECTIVE` (`:553`). Leave `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` (`:566`) **unchanged** — see the scope note.
- **Logic:** append to the end of the existing template literal, with the backticks escaped as the surrounding literal already escapes them:

```
 Stage by explicit path only the files belonging to the work you are committing — never \`git add -A\` or \`git add .\` — other agents may be working the same tree.
```

  Rendered value: `Stage by explicit path only the files belonging to the work you are committing — never `git add -A` or `git add .` — other agents may be working the same tree.` No apostrophes, one sentence. The em-dashes match the surrounding prose style and are safe in every quoting context.

  > **Superseded:** *"Stage only the files **your task** changed — never …"*
  > **Reason:** Anchoring on "your task" assumes the committer is the author, which the team commit model breaks. Under `a-team-commits-once-as-its-head.md` the head commits a body of work its **members** wrote — read literally, "the files your task changed" tells it to stage nothing, and read loosely it is exactly the ambiguity that makes `git add -A` attractive, since a head genuinely does want several seats' files. Anchoring on *the work being committed* is correct for all three committers: the head (its team's body), the reviewer (its own fixes), and a solo coder off the board (its own subtask).
  > **Replaced with:** the sentence above. Same length class, same quoting properties, no apostrophes, both commands still in backticks.

- **Edge Cases:** the constant is a single-line template literal; keep it single-line so the test's greedy `(.*)` match still spans it. The extraction regex anchors on `GIT_SAFETY_DIRECTIVE\s*=`, which cannot match `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE`, and `.match()` returns the first hit — so `:553` remains the extracted constant.

### `src/webview/terminals.js` — the hand-copied mirror

- **Context:** `GIT_SAFETY_DIRECTIVE_CLIENT` (`:8831` declaration, `:8832` value), **one unbroken single-quoted literal on a single line**. The webview cannot import TypeScript, which is why the copy exists.
- **Logic:** append the identical sentence with **literal, unescaped** backticks — inside single quotes a backtick is an ordinary character, exactly as the existing ``git checkout `<path>` `` in this same string already demonstrates. Byte equality with the host constant (after the host's `\`` → `` ` `` unescape) is asserted, so this is a mechanical copy, not a re-wording.
- **Edge Cases:** append **inside the existing quotes**. The test's extractor is `'([^']*)'` — a `+`-joined chain captures only the first segment and fails byte equality against the full host constant. The line will exceed 300 characters; that is the correct outcome, not something to tidy.

### `src/webview/kanban.html` — the shipped team prompts

- **Context:** `SHIPPED_TEAM_TYPES` (`:4643`), whose three per-team `prompt` strings hand-copy the git-safety text as single-quoted `+`-joined chains ending at `:4658`, `:4674`, `:4705`. Pinned by the second contract test, which reads them with `readQuotedChain` and requires each prompt to **end with** the constant verbatim.
- **Logic:** append the identical sentence — literal backticks, same as `terminals.js` — to all three copies, keeping it the last text in each prompt.
- **Edge Cases:** unlike `terminals.js`, this extractor reassembles `+`-joined segments, so a new `+ '…'` continuation is fine and matches the existing shape. `headPrompt` (Coding only) is read by a separate assertion and carries no git-safety text — leave it alone.

### `src/test/standing-orders-marker-contract.test.js` — pin the exclusion

- **Context:** the two existing byte-equality tests need no change; they will enforce the mirrors automatically.
- **Logic:** add one negative assertion — `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` does **not** contain `git add -A`. This is the only guard against a future symmetry edit, and it documents the reason in its failure message.

## Verification Plan

### Automated Tests

1. `npm run test:contract:standing-orders-marker` (or the packaged script for `standing-orders-marker-contract.test.js`) — the two byte-equality tests pass, proving all four mirrors moved together, and the new negative assertion passes.
2. `stage-marker-commit-contract.test.js` passes **unmodified**, in particular `:173` (`no emitted policy text prescribes \`git add -A\` or \`git add .\`, for any strategy`). A failure there means the clause was written without backticks.
3. Grep the clause is absent from worktree mode: `grep -n "git add -A" src/services/agentPromptBuilder.ts` returns the `whenDone` clause and the base guardrail only, never the `_WORKTREE_MODE` line.
4. Grep for the one real quoting hazard in the new clause: it contains no `'`.
5. Grep the `terminals.js` mirror is still a single literal: `grep -n "GIT_SAFETY_DIRECTIVE_CLIENT" -A2 src/webview/terminals.js` shows one `'…'` with no `+` continuation. A chain there is the silent-truncation failure named above.
6. `npm run lint`.

### Manual

6. Dispatch any plan to a non-worktree coder seat and read the prompt it receives: the staging clause is present in the safeguard block, and present even when the seat has no commit strategy configured — which is the shipped default and the condition that produced the incident.
6a. Read the prompt a **team head** receives: the same clause is present and reads coherently for a seat committing work it did not author.
7. Dispatch with the per-plan worktree option active: the prompt carries the worktree-mode directive and **no** staging clause.
8. Adopt a shipped team from the TEAMS tab and inspect its stored `prompt` in `terminals.agentGroups` — the clause is present in the newly adopted copy.
9. Drive two coders concurrently in one tree on file-disjoint subtasks, as in the reproduction. When the first finishes and commits, `git show --stat` names only its own files, and the second coder's changes remain unstaged in the working tree.

---

**Recommendation:** Complexity 3 → **Send to Intern.**

## Completion Report

Implemented explicit staging-scope clause across `GIT_SAFETY_DIRECTIVE` in `src/services/agentPromptBuilder.ts`, the webview client mirror `GIT_SAFETY_DIRECTIVE_CLIENT` in `src/webview/terminals.js`, and all 3 shipped team prompt templates in `src/webview/kanban.html`. Added a negative contract assertion in `src/test/standing-orders-marker-contract.test.js` ensuring `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` excludes the staging-scope restriction. No issues encountered during implementation.


## Review Findings

Reviewed against the plan as source of truth; no findings. The clause landed in `GIT_SAFETY_DIRECTIVE` only (`agentPromptBuilder.ts:562`), with `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` correctly untouched and now pinned by the new negative assertion in `standing-orders-marker-contract.test.js`; all four mirrors moved together (`terminals.js` still one unbroken literal, `kanban.html` `+`-joined as its extractor requires), and the clause is apostrophe-free with both commands in backticks so `stage-marker-commit-contract.test.js:173`'s stripper still passes. Validation: `standing-orders-marker` 55/0, `stage-marker-commit` 44/0, `tsc -p tsconfig.test.json` clean, `eslint src` 0 errors. Remaining risk: teams already adopted on disk carry the pre-clause prompt — explicitly out of scope per the plan's Migration note, since the delivery-layer directive is what actually reaches a seat.
