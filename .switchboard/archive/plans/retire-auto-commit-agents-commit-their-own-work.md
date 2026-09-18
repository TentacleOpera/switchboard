# Retire Auto-Commit — Leads and Reviewers Commit, and a Review Commit Means Done

## Goal

Delete `autoCommitForCodeReview`. Commit responsibility moves to the roles that already have a per-role commit strategy — the lead and the reviewer — and a reviewer's commit becomes the git-visible marker that a plan is finished.

### Why

**Two committers, one of them blind.** `GIT_COMMIT_CLAUSES.whenDone` (`agentPromptBuilder.ts:574`) already tells a dispatched agent to commit when finished. `autoCommitForCodeReview` (`TaskViewerProvider.ts:6898`) separately runs `git add -A` before code review. With both active the agent makes a real commit and the extension then commits **whatever is left** — board bookkeeping, under a generic message (`switchboard: auto-commit before code review (<topic>, <timestamp>)`).

**The tree is never clean.** `.switchboard/plans/` and `.switchboard/features/` are deliberately un-ignored (`.gitignore:52-56` — `.switchboard/*` excluded, then `!.switchboard/plans/` and `!.switchboard/features/` re-included) and the board rewrites status metadata into them on import, on card move, on feature reconcile. From a real commit here (`0269d6a`): eleven plan and feature files of 4-line churn alongside three files of actual work, under a message describing only the work.

**A review commit is a completion signal.** It is unambiguous, in git, and it means *reviewed* rather than *written* — which the orchestrator persona's "Verify via Git (status of record)" section (`.agents/skills/switchboard-orchestrator/SKILL.md:94`) already asks for and has no clean source of today.

**The per-role mechanism exists, but it deliberately excludes the reviewer — and that exclusion is the real decision here.** `gitCommitStrategyByRole` (`KanbanProvider.ts:5397`) resolves `lead`, `coder`, `intern` and `claude_designer` from role config and hardcodes the rest to `'notSpecified'`. That is not an oversight: `sharedDefaults.js:62` scopes the three git-policy radios to *"the four code-writing roles"*, the reviewer's default addons carry `gitProhibition` and none of the three strategies (`sharedDefaults.js`, `DEFAULT_ROLE_CONFIG.reviewer`), and the UI renders `ROLE_ADDONS[role]` so the control never appears for a reviewer. All three layers agree. Nothing is silently ignored and there is no dead control.

**But the classification is wrong.** The reviewer *does* write code: `agentPromptBuilder.ts:1437` instructs it to "assess the actual code changes against the plan requirements inline, **fix valid material issues**, then verify." A role that fixes bugs is a code-writing role. The same applies to the planner, which authors plan files — its own work product, tracked in git.

So this is not a boundary being crossed. It is three layers consistently implementing a misclassification, and the fix is to correct the classification for the two roles that need it.

### The deletion is eight files, not one

> **Superseded:** "**1. Delete auto-commit** — `autoCommitForCodeReview`, the `switchboard.kanban.autoCommitOnCodeReview` setting, its `globalState` read, and the call site."
> **Reason:** Four items, all singular, understates the surface by roughly 4×. The flag is plumbed through a webview toggle, a state↔config bridge, a startup-commands **response body** read by two consumers, a Setup panel push, and **two** call sites — not one. A partial removal leaves a toggle that saves a value nothing reads (a dead control, which contract #6 of the project PRD forbids) or a `handleGetStartupCommands` body whose shape one consumer still expects.
> **Replaced with:** The full inventory below. Remove it in one commit; a half-removal is worse than none.

The complete surface, verified by grep:

| File | Sites |
| :--- | :--- |
| `src/webview/setup.html` | `:749` checkbox markup (+ its label row), `:2817` change listener, `:3113` hydration inside `case 'startupCommands'`, `:3355` `case 'autoCommitOnCodeReviewSetting'` |
| `src/services/SetupPanelProvider.ts` | `:144` fallback object field, `:735` `autoCommitOnCodeReviewSetting` push |
| `src/services/stateConfigBridge.ts` | `:35` `STATE_KEY_TO_CONFIG` entry |
| `src/services/TaskViewerProvider.ts` | `:1862` mirror-map entry, `:6869` return-type field, `:6871-6877` `Promise.all` element + return, `:6879-6894` `handleGetAutoCommitOnCodeReviewSetting`, `:6898-6913` `autoCommitForCodeReview`, `:11184` `saveStartupCommands` guard, `:11230-11231` state write |
| `src/services/KanbanProvider.ts` | `:4712`, `:4726`, `:4739`, `:4744` startup-commands shape, `:4748-4753` `getAutoCommitOnCodeReview`, `:4777-4778`, `:4799` save paths, `:7235-7253` `_autoCommitIfCodeReviewTransition`, **and both** call sites `:7266` **and** `:7348` |

There is **no `package.json` contribution** — `switchboard.kanban.autoCommitOnCodeReview` is a `globalState` key plus a `config`-table row via the bridge, never a VS Code setting. Nothing in `KanbanDatabase._runConfigMigrations` references it.

**Persisted values are left alone.** `stateConfigBridge.ts:21-24` states the contract: *"Keys absent from this map are intentionally dropped."* Removing the map entry is the sanctioned retirement path — the synthesized `state.json` stops carrying the key, the orphaned `kanban.autoCommitOnCodeReview` config row and the `globalState` value stay on disk, inert. Do **not** write a cleanup migration to delete them; a retired boolean flag that nothing reads costs nothing, and a delete migration against ~4,000 installs is risk for no gain.

## What changes

**1. Delete auto-commit** across all eight files above, in one commit.

**2. Give the planner and the reviewer a commit strategy — three changes each, all required.** Missing any one leaves a control that does nothing or an option nobody can set:

- `sharedDefaults.js` — add `gitCommitStrategy: 'notSpecified'` to that role's entry in `DEFAULT_ROLE_CONFIG`.
- `sharedDefaults.js`, `ROLE_ADDONS.<role>` — add `GIT_COMMIT_STRATEGY_RADIO` so the control renders. Place it next to the existing `gitProhibition` checkbox, matching where the four code-writing roles put it.
- `KanbanProvider.ts:5397-5407` — read `<role>Config?.addons?.gitCommitStrategy`, as `lead` and `coder` do, including the `'incremental'` → `'notSpecified'` normalisation for shape consistency.

`plannerConfig` and `reviewerConfig` are **already in scope** at that site — both are dereferenced a few lines below in `switchboardSafeguardsByRole` (`KanbanProvider.ts:5421-5430`). No new config resolution is needed.

Also update the comment block at `sharedDefaults.js:61-64` ("Attached to the four code-writing roles") — it becomes false the moment this lands, and a stale comment here is exactly what let the misclassification persist unexamined.

Together with the lead, that gives one committer per pipeline stage: planner, lead, reviewer.

**Commit strategy only — not branch, not push.** Not because these roles are barred from writing code (they are not), but because nothing here needs them and each radio is another way for a dispatch to go sideways. There is no principled reason to withhold them later if a use appears.

Leave the `'incremental'` → `'notSpecified'` mapping intact — a retired value, not this plan's business.

**3. Tighten `whenDone`.** "Stage all your changes" is the same greedy instruction that made the extension's version messy — an agent following it literally runs `git add -A` and sweeps the board churn itself. It should say: stage the files you changed, by path; never `git add -A` or `git add .`; nothing under `.switchboard/` except this plan's own file, whose completion report is part of the work; one commit, message describing the change.

**`whenDone` is shared by every role that can be given a commit strategy** — lead, coder, intern, `claude_designer`, and now planner and reviewer. This is a global prompt-text change, not a reviewer-scoped one: every existing dispatch with `gitCommitStrategy: 'whenDone'` gets the new text on the next dispatch. That is the intent — the greedy instruction is wrong for all of them — but it must be a deliberate decision, not a side effect noticed later. The clause is a pure string in a pure builder (`buildGitPolicyBlock`, `agentPromptBuilder.ts:601`), so nothing persisted changes and there is no migration.

**4. Both options, independently settable.** Lead commits, reviewer commits, either, or neither. `dontCommit` stays for dispatches where work is deliberately left in the tree.

`tester`, `analyst`, `researcher` and `ticket_updater` stay as they are. They are excluded for the same deliberate reason, and nothing here needs them.

> **Superseded:** "`planner`, `tester`, `analyst`, `researcher` and `ticket_updater` stay as they are."
> **Reason:** Self-contradictory — §2 of the same plan gives the planner a commit strategy. Listing it again among the roles that "stay as they are" would leave a coder implementing one half or the other.
> **Replaced with:** The list above, with `planner` removed.

## Metadata

**Complexity:** 5
**Tags:** refactor, backend, reliability

> **Superseded:** **Complexity:** 3
> **Reason:** 3 assumed a four-site deletion. The verified surface is eight files including a webview, a state↔config bridge and a response-body shape with two consumers, plus six wiring changes across two roles and a global prompt-clause rewrite. Multi-file coordination on shipped state is the 5-6 band.
> **Replaced with:** **Complexity:** 5

## User Review Required

None. The classification correction (reviewer and planner are code-writing roles) is argued from the shipped reviewer instruction at `agentPromptBuilder.ts:1437` and is the plan's premise, not an open question. Scoping to commit-only, retiring the flag without a cleanup migration, and applying the `whenDone` rewrite globally are all decided above.

## Complexity Audit

### Routine
- Deleting a function and its two call sites.
- Adding `GIT_COMMIT_STRATEGY_RADIO` to two `ROLE_ADDONS` entries and `gitCommitStrategy` to two `DEFAULT_ROLE_CONFIG` entries — copying an existing pattern verbatim.
- Two lines in `gitCommitStrategyByRole`, with both config objects already in scope.
- Rewriting one string constant.

### Complex / Risky
- **`handleGetStartupCommands` is a response body with two consumers.** Per project PRD contract #4 (return-in-body), verbs return their data in the HTTP body. Dropping `autoCommitOnCodeReview` from the returned object changes that shape; `setup.html:3113` and `KanbanProvider.ts:4726/4739/4744` must drop their reads in the same change or one consumer reads `undefined` where it expected a boolean.
- **Two call sites, not one** (`KanbanProvider.ts:7266` and `:7348`). Deleting one leaves auto-commit live on the other path.
- **The `whenDone` rewrite is global.** Four existing roles change behaviour, not just the two being added.
- **Removing a `saveStartupCommands` guard changes an accept/reject boundary.** `TaskViewerProvider.ts:11184` is part of an `||` chain deciding whether a payload is actionable; excise the term without breaking the chain, and confirm a payload carrying *only* the retired key is now correctly treated as a no-op rather than throwing.

## Edge-Case & Dependency Audit

**Race Conditions**
- Deleting `_autoCommitIfCodeReviewTransition` **removes** a race: it currently runs `git add -A && git commit` inside the move path, concurrently with the plan watcher rewriting files under `.switchboard/plans/`. That is precisely how unrelated churn landed in `0269d6a`. Nothing new is introduced — a synchronous, blocking git subprocess is taken out of a card move.
- The agent's own commit is inherently serialised with its own work, so there is no equivalent window on the replacement path.

**Security**
- Strictly reduces surface: one fewer place the extension shells out to `git` with `-A` on a tree it does not control.

**Side Effects**
- **Uncommitted work will be left in the tree where auto-commit previously swept it up.** Any operator who relied on the flag being ON now gets a dirty tree at `CODE REVIEWED` unless the lead or reviewer is set to `whenDone`. The flag is off by default (`TaskViewerProvider.ts:6890` — "only an explicit `true` enables auto-commit"), so the default install is unaffected, but this is a real behaviour change for anyone who turned it on.
- The Setup panel loses a toggle. That is a visible UI change, intended, and preferable to a toggle wired to nothing.
- Two new radios appear in the planner and reviewer role config, defaulting to `notSpecified` — so no emitted prompt changes until an operator sets one. This satisfies the project PRD's "new capabilities ship default-OFF".

**Dependencies & Conflicts**
- Touches `setup.html`, `SetupPanelProvider.ts`, `stateConfigBridge.ts`, `TaskViewerProvider.ts`, `KanbanProvider.ts`, `sharedDefaults.js`, `agentPromptBuilder.ts`.
- **Shared surface with `stage-markers-in-commit-trailers.md`:** both edit `GIT_COMMIT_CLAUSES.whenDone` in `agentPromptBuilder.ts`. **This plan owns the rewrite; the markers plan extends the rewritten text.** Land this one first. Per the project PRD's one-agent-stream-per-provider-file rule, they must not be coded in parallel.
- No overlap with `coding-team-sends-the-feature-to-review-not-each-subtask.md` (`kanban.html`, `teamWiring.ts`, `terminals.js`).
- Verification item 4 below ("identifiable as a review commit") is **delivered by the markers plan, not this one** — see the callout there.

## Dependencies

- `sess_git_policy_granular — buildGitPolicyBlock and the three strategy radios`
- `sess_state_config_bridge — STATE_KEY_TO_CONFIG retirement semantics`
- `sess_stage_markers — GIT_COMMIT_CLAUSES.whenDone (downstream consumer of this rewrite)`

## Adversarial Synthesis

Key risks: a partial deletion leaving a dead Setup toggle or a startup-commands body one consumer still reads; missing the second `_autoCommitIfCodeReviewTransition` call site; and a global `whenDone` rewrite silently changing four existing roles' prompts. Mitigations: delete all eight files' worth of sites in one commit and grep to zero, drop the response-body field and both its readers together, and state the global scope of the clause change up front rather than discovering it in review. Residual: operators who had the flag ON get a dirty tree until they set a per-role strategy — accepted, since the flag is off by default and the replacement is strictly better attributed.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

- **Context:** Owns the flag read (`:6879-6894`), the committer (`:6898-6913`), the startup-commands aggregate (`:6864-6877`), the mirror-map entry (`:1862`) and the save path (`:11184`, `:11230-11231`).
- **Logic:** Delete `autoCommitForCodeReview` and `handleGetAutoCommitOnCodeReviewSetting` entirely. Remove the field from the `handleGetStartupCommands` return type, its element from the `Promise.all`, and its key from the returned object. Remove the mirror-map row and both save-path references.
- **Implementation:** The `Promise.all` destructuring is positional — remove the array element and the binding together or the remaining bindings shift by one. This is the single highest-risk edit in the plan.
- **Edge Cases:** `promisify`/`cp` imports may become unused if nothing else in the file uses them — check before removing.

### `src/services/KanbanProvider.ts`

- **Context:** Holds `getAutoCommitOnCodeReview` (`:4748`), `_autoCommitIfCodeReviewTransition` (`:7235`), its two call sites (`:7266`, `:7348`), four startup-commands shape sites, two save sites, and `gitCommitStrategyByRole` (`:5397`).
- **Logic:** Delete the getter, the transition helper and **both** call sites. Drop the field from the four startup-commands sites and the two save sites. Add `planner` and `reviewer` reads to `gitCommitStrategyByRole`.
- **Implementation:** `plannerConfig` / `reviewerConfig` already exist in scope (used at `:5421-5430`). Mirror the `lead` line exactly, including the `'incremental'` normalisation.
- **Edge Cases:** `gitBranchStrategyByRole` and `gitPushStrategyByRole` keep `planner: 'notSpecified'` and `reviewer: 'notSpecified'` hardcoded — commit-only is deliberate, and a coder copying all three lines would over-deliver.

### `src/webview/sharedDefaults.js`

- **Context:** `DEFAULT_ROLE_CONFIG` (`:19+`), `GIT_COMMIT_STRATEGY_RADIO` (`:72`), `ROLE_ADDONS` (`:120+`).
- **Logic:** Add `gitCommitStrategy: 'notSpecified'` to `DEFAULT_ROLE_CONFIG.planner.addons` and `.reviewer.addons`. Add `GIT_COMMIT_STRATEGY_RADIO` to `ROLE_ADDONS.planner` and `ROLE_ADDONS.reviewer`. Update the `:61-64` comment.
- **Implementation:** The file opens with "CRITICAL: DO NOT CHANGE DEFAULTS UNLESS SPECIFICALLY ASKED" — `'notSpecified'` is the no-op default and changes no emitted prompt, which is what keeps that rule satisfied.
- **Edge Cases:** Add **only** the commit radio. Adding the branch or push radio creates a control `gitCommitStrategyByRole`'s siblings will never read — a dead control.

### `src/webview/setup.html` and `src/services/SetupPanelProvider.ts`

- **Context:** The toggle's markup, listener, two hydration paths and the provider push/fallback.
- **Logic:** Delete all six sites.
- **Implementation:** Remove the whole label/row wrapper around `:749`, not just the `<input>`, or an empty row survives in the layout.
- **Edge Cases:** `case 'autoCommitOnCodeReviewSetting'` (`:3355`) and the `:735` push are a matched pair — remove both or the provider posts a message nothing handles.

### `src/services/stateConfigBridge.ts`

- **Context:** `STATE_KEY_TO_CONFIG` (`:27-49`).
- **Logic:** Remove the `autoCommitOnCodeReview` row.
- **Implementation:** Nothing else; the file's own contract comment (`:21-24`) makes an absent key an intentional drop.
- **Edge Cases:** Leave the persisted `kanban.autoCommitOnCodeReview` config row and the `globalState` value on disk. No cleanup migration.

### `src/services/agentPromptBuilder.ts`

- **Context:** `GIT_COMMIT_CLAUSES.whenDone` (`:574`), consumed by `buildGitPolicyBlock` (`:601`) at twelve call sites plus `AgentSkillExporter.ts:193`.
- **Logic:** Rewrite `whenDone` per §3.
- **Implementation:** A single string constant. `buildGitPolicyBlock` stays pure and its signature is unchanged by this plan.
- **Edge Cases:** The worktree branch appends `" Commit inside your assigned worktree."` (`:621`) — the new text must still read correctly with that sentence appended. `dontCommit` is untouched.
- **Also correct the stale comment at `:1292-1294`.** The `planner` branch carries "planner is non-code-touching; strategies resolve to `undefined`/`notSpecified` so only the guardrail clause can fire." That becomes false the moment §2 lands, and the planner branch's shadowed `gitCommitStrategy` (`:1296`) will now resolve to a real value. Leaving it is how the next reader re-derives the misclassification this plan exists to fix.

## Verification Plan

1. Nothing in `src/` references `autoCommitForCodeReview`, `handleGetAutoCommitOnCodeReviewSetting`, `getAutoCommitOnCodeReview`, `_autoCommitIfCodeReviewTransition`, `autoCommitOnCodeReview` or `auto-commit-code-review-toggle`. A single grep, zero hits, across `.ts`, `.js` and `.html`.
2. The commit-strategy control appears in the reviewer's role config, and setting it to `whenDone` produces a `GIT POLICY:` block with a commit clause in the reviewer's dispatch prompt — all three layers wired, not two.
2a. The reviewer gains **no** branch or push strategy control.
2b. Same for the planner.
3. A reviewer finishing a review produces one commit containing the reviewed changes — no other plan or feature files.
4. *(Delivered by `stage-markers-in-commit-trailers.md`, not by this plan.)*

   > **Superseded:** "That commit is identifiable as a review commit, so 'reviewed' can be read from git rather than inferred."
   > **Reason:** Nothing in this plan makes a commit *identifiable* — it only makes the reviewer commit at all. The commit's message is whatever the agent writes, and no marker exists until the trailers land. Left here, this item is unpassable and inverts the feature's own ordering (this plan lands first).
   > **Replaced with:** This plan's contract is *"a reviewer commits its own review"*. Identifiability is `stage-markers-in-commit-trailers.md`'s contract and is verified there.

5. Lead and reviewer strategies are independent — setting one does not change the other.
6. Board churn in `.switchboard/plans/` remains uncommitted after both.
7. `dontCommit` on any role still leaves that role's work in the working tree.
8. No `git add -A` and no `git add .` appears anywhere in the emitted policy text, for any role.
9. Moving a card to `CODE REVIEWED` performs no git operation of any kind — confirmed on both `moveCardToColumnWithReason` and the second former call site.
10. The Setup panel renders with no gap or empty row where the toggle was.
11. A `saveStartupCommands` payload carrying only the retired key is a no-op — no throw, no state write.
12. Defaults are unchanged for a fresh install: planner and reviewer both resolve `gitCommitStrategy: 'notSpecified'`, so no `GIT POLICY:` commit clause is emitted for either until an operator opts in.

### Automated Tests

- `src/test/minimal-prompt.test.js` and `src/test/agent-prompt-builder-subagents.test.js` reference git-policy text — read them before rewriting `whenDone`; any that assert the old "stage all your changes" wording must be updated in the same commit.
- Add a case asserting `gitCommitStrategyByRole.reviewer` and `.planner` resolve from role config rather than the hardcoded `'notSpecified'`.

*Per session directive, compilation and automated tests are not run as part of this pass — the coder runs them.*

**Recommendation: Send to Coder** (complexity 5).

## Completion Report — whenDone rewrite (agentPromptBuilder.ts)

Rewrote `GIT_COMMIT_CLAUSES.whenDone` (`agentPromptBuilder.ts:576`) per §3: the clause now instructs the agent to stage changed files by explicit path, forbids `git add -A` / `git add .`, excludes everything under `.switchboard/` except the plan's own file (completion report is part of the work), and asks for one commit with a descriptive message. `buildGitPolicyBlock`'s signature is unchanged and `dontCommit` is untouched; the worktree append at `:623` still reads correctly with the new text ("...describing the change. Commit inside your assigned worktree."). No commit trailers or stage markers were added — those belong to the downstream `stage-markers-in-commit-trailers.md` subtask. Per session directive, compilation and tests were skipped; `kanban.html`, `teamWiring.ts`, and `terminals.js` were not touched.

## Completion Report — Sections 1 & 2 (auto-commit deletion + planner/reviewer commit strategy)

**Section 1 — auto-commit deleted across all eight files.** Drove the 41-hit grep surface to zero. `stateConfigBridge.ts`: removed the `autoCommitOnCodeReview` `STATE_KEY_TO_CONFIG` row (persisted `globalState` value and `kanban.autoCommitOnCodeReview` config row left on disk, inert — no cleanup migration). `TaskViewerProvider.ts`: removed the `_GLOBAL_TO_STATE_KEY` mirror row; rewrote `handleGetStartupCommands` to drop the field from its return type, the positional `Promise.all` destructuring, and the return object (binding + array element removed together); deleted `handleGetAutoCommitOnCodeReviewSetting` and `autoCommitForCodeReview` outright; excised the `|| typeof data.autoCommitOnCodeReview === 'boolean'` term from the `saveStartupCommands` accept/reject guard and the matching state-write block (a payload carrying only the retired key is now a correct no-op). `cp`/`promisify` imports retained — still used at five other sites. `KanbanProvider.ts`: dropped `autoCommitOnCodeReview` from both `_getStartupCommands` return shapes and the catch fallback; deleted `getAutoCommitOnCodeReview`; removed both save-path writes (provider and legacy state.json); deleted `_autoCommitIfCodeReviewTransition` and **both** call sites (`moveCardToColumnWithReason` and the `if (targetColumn === 'CODE REVIEWED')` block in `moveCardToColumnByPlanFileWithReason`); removed the now-dead `sessionId` local in the latter to avoid a `noUnusedLocals` error. `SetupPanelProvider.ts`: cleaned the fallback return and deleted the `case 'getAutoCommitOnCodeReviewSetting'` handler. `setup.html`: removed the toggle's `<label>` markup, its load-callback `postMessage`, its change listener, the `case 'startupCommands'` hydration lines, and the `case 'autoCommitOnCodeReviewSetting'` block. `src/generated/verbAllowlist.ts` was **regenerated, not hand-edited** — ran `npm run catalog:generate`, which rewrote `protocol-catalog.json` (613 arms, 525 verbs) and `verbAllowlist.ts` from the edited source; `getAutoCommitOnCodeReviewSetting` no longer appears in either. Final grep across `src/` for all six retired symbols: zero hits.

**Section 2 — planner and reviewer given a commit strategy, three layers each.** `sharedDefaults.js`: added `gitCommitStrategy: 'notSpecified'` to `DEFAULT_ROLE_CONFIG.planner.addons` and `.reviewer.addons`; added `GIT_COMMIT_STRATEGY_RADIO` to `ROLE_ADDONS.planner` and `ROLE_ADDONS.reviewer` next to the existing `gitProhibition` entry (commit radio only — no branch/push radio, which would be a dead control); updated the stale `:61-64` comment from "four code-writing roles" to name the six commit-capable roles. `KanbanProvider.ts:gitCommitStrategyByRole`: replaced the hardcoded `planner: 'notSpecified'` and `reviewer: 'notSpecified'` with reads off `plannerConfig`/`reviewerConfig` addons, mirroring the `lead` line including the `'incremental'` → `'notSpecified'` normalisation; both config objects confirmed in scope (declared at `:5273`/`:5276`, already dereferenced below in `switchboardSafeguardsByRole`). `gitBranchStrategyByRole` and `gitPushStrategyByRole` left hardcoded `notSpecified` for both roles — commit-only is deliberate. `agentPromptBuilder.ts`: corrected the stale `:1371` planner comment ("non-code-touching; strategies resolve to undefined/notSpecified") to reflect that the planner now carries a real commit strategy.

**Off-limits surfaces untouched:** `kanban.html`, `teamWiring.ts`, `terminals.js`; no commit trailers or stage markers added. Per session directive, compilation and automated tests were not run. Residual (out of scope, not fixed): the `GIT_COMMIT_STRATEGY_RADIO` "Commit When Done" option tooltip in `sharedDefaults.js:74` still reads "Stage all changes and create a single descriptive commit" — it predates and slightly contradicts the rewritten `whenDone` clause text, but the tooltip is a UI label, not the emitted clause, and §3 scoped the rewrite to the string constant only.

## Review Findings

**Verdict: passed after fixes.** §1 verified clean — all six retired symbols grep to zero across `src/` (verification item 1), `verbAllowlist.ts` and `protocol-catalog.json` were regenerated rather than hand-edited, and both `_autoCommitIfCodeReviewTransition` call sites are gone. §3 verified — no emitted policy text prescribes `git add -A` or `git add .` for any strategy, and the retired "stage all your changes" wording is absent. One MAJOR fixed in review: §2's planner wiring was a **dead control** — `CODE_TOUCHING_ROLES` (`agentPromptBuilder.ts:1222`) omitted `planner`, so `assembleSuffix` dropped the planner's whole `gitBlock` and the radio, the default and the resolved `gitCommitStrategyByRole.planner` value could never reach an emitted prompt; verification item 2b was unpassable. Fixed by adding `planner` to the set — default-safe, because at the planner's shipped defaults (`gitProhibition: false`, every strategy `notSpecified`) `buildGitPolicyBlock` returns `''` and `assembleSuffix` filters it out, so no default prompt changes; this also revives the planner's previously-dead Git Safety Guardrail checkbox, which is correct under this plan's own premise. Remaining risk unchanged from the plan: operators who had auto-commit ON get a dirty tree until they set a per-role strategy. Verification run in full (not skipped): `compile-tests` clean, `lint` 0 errors, `compile` (webpack) clean, and the new `test:contract:stage-marker-commit` pins commit-only scoping — planner and reviewer carry the commit radio and neither gains a branch or push control.
