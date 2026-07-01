# Reframe Git Prohibition as a Git Safety Guardrail (unblock worktrees, forbid destructive undo)

**Plan ID:** 3f0a9c2e-1b7d-4e6a-9c11-8a2f5d6e4b90

## Goal

Resolve the contradiction between the `gitProhibition` add-on and the ultracode / worktree-per-plan directives, and refocus the directive on the risk it should actually be guarding against.

### Core problem & root cause

Every dispatch prompt concatenates the git block and the subagent/worktree block into one `suffixBlock` (`src/services/agentPromptBuilder.ts`, e.g. `:734`). Those two blocks contradict each other:

- **Git prohibition** (`agentPromptBuilder.ts:314`) bans *all* state-mutating git, explicitly listing `branch` and `checkout`.
- **Worktree / ultracode directives** (`WORKTREES_PER_PLAN_DIRECTIVE :365`, `EPIC_ORCHESTRATION_DIRECTIVE :367`, per-subtask `:383`, high-low `:400`) instruct the agent to *create and use git worktrees*.

`git worktree add` inherently creates a **branch** and performs a **checkout** — both on the banned list. So an agent that faithfully obeys the git policy must refuse to create the worktree. This fires by default: `gitProhibition` defaults **ON** for lead/coder/intern/reviewer (`src/webview/sharedDefaults.js`), so the moment a user enables ultracode (kanban epic toggle) or `useWorktreesPerPlan`, both blocks ship together unreconciled. The user does nothing wrong.

Even the *pre-provisioned* worktree modes break downstream, because the worktree workflow needs the subagent to **commit** on its own branch — also banned.

### Reframed intent (from user)

The real problem the prohibition should solve is **not** "touching git." It is agents getting lazy and using `reset` / `checkout` (and destructive plans involving deletions/reverts) to undo mistakes **without first checking the worktree is clean** — silently destroying uncommitted work. The current blanket ban both (a) breaks worktrees and commits (the safe/needed ops) and (b) doesn't reliably stop the dangerous ops anyway (some agents still ask to checkout).

**Decision (confirmed):** Narrow the prohibition. Repurpose the `gitProhibition` toggle from a blanket "no git" into a **git safety guardrail**:
- **Permit** the constructive ops the workflow needs: `git worktree add`, `git branch` / `git checkout -b` (create), `git add`, `git commit`.
- **Forbid** the destructive / work-discarding ops: `git reset` (any mode), `git checkout <path>` / `git restore` to discard, `git clean`, `git stash drop`/`clear`, force-push, branch/worktree deletion (`branch -D`, `worktree remove --force`), and history rewrites.
- **Gate** deletions/reverts behind a clean-tree check: verify `git status` is clean and work is committed *first*; perform deletions as tracked, committed changes — never as a destructive "undo." Correct forward, don't discard.

## Non-goals

- Not changing how worktrees are provisioned, routed, or merged (`KanbanProvider`, `KanbanDatabase` worktree logic untouched).
- Not adding a new toggle or removing the `gitProhibition` toggle — its stored boolean and id stay valid; only its *meaning/copy* changes.
- Not touching the outer Claude Code task-harness git rules (designated-branch/push) — those are separate from the extension's dispatched prompts.

## Open sub-decision (needs a one-line answer, does not block drafting)

**Push handling.** The reframed directive is centered on destructive-undo safety. Should it still softly instruct "do not push/merge to shared branches — hand completed work back for pushing/merging"?
- **Recommended:** keep a single closing line to that effect (preserves the original hand-back intent without blocking local commits). Adjustable to "silent on push" if you'd rather not constrain it.

## Approach

Single source of truth: all call sites reference the `GIT_PROHIBITION_DIRECTIVE` constant, so the behavioral change is one string edit. Keep the literal marker `GIT POLICY` in the new text so existing substring-based tests remain valid.

### Proposed new directive text (for review — wording is the deliverable)

> **GIT POLICY (safety guardrail):** You MAY use git for isolation and progress: creating worktrees (`git worktree add`), creating branches (`git branch`, `git checkout -b`), staging (`git add`), and committing your own work (`git commit`). You MUST NOT run work-discarding or history-destroying commands — `git reset` (any mode), `git checkout <path>` / `git restore` to discard changes, `git clean`, `git stash drop`/`clear`, force pushes, or branch/worktree deletion — because these silently destroy uncommitted work. Before any deletion or revert, FIRST run `git status` and confirm the working tree is clean and your work is committed; make deletions as tracked changes you then commit. Never "undo" a mistake by discarding — commit first, then correct forward. Do not push or merge to shared branches; return completed work to the parent agent or user for that.

(Last line is the "push handling" sub-decision above.)

## Implementation steps

1. **Rewrite the directive** — `src/services/agentPromptBuilder.ts:314`: replace `GIT_PROHIBITION_DIRECTIVE`'s body with the safety-guardrail text above, preserving the `GIT POLICY` marker. No call-site changes needed (all 10+ `gitBlock` sites and the batch builder at `:1306` consume the constant).

2. **Reconcile ordering (verify only)** — confirm the guardrail and the worktree/subagent blocks no longer contradict now that worktree creation + commits are explicitly permitted. No code change expected; this is a read-through of the `suffixBlock` assembly in each role branch.

3. **Update UI copy** — the "Git Prohibition" label/tooltip now mis-describes the behavior:
   - `src/webview/kanban.html:2925-2928`: retitle to e.g. "Git Safety Guardrail", update `title`/`tooltip` to "Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions."
   - `src/webview/sharedDefaults.js` (all `gitProhibition` label/tooltip entries, `:65,80,99,119,134,149,166,179,192,205`): same label/tooltip copy. **Keep the `id: 'gitProhibition'` and all `default` values unchanged** — no stored-state migration needed (id and boolean semantics preserved; a checked box still means "apply the git policy").

4. **Update tests** — most only assert the `GIT POLICY` substring and continue to pass. Audit and adjust any that assert the *old specific wording* ("state-mutating", "checkout", "Return completed work ... for committing"):
   - `src/test/minimal-prompt.test.js` (`:55,66` presence/absence; `:241` list) — presence-only, should pass; verify.
   - `src/test/agent-prompt-builder-subagents.test.js` (`:84,88,90,99,225,226`) — presence-only, should pass; verify.
   - Grep the whole `src/test` tree for `state-mutating`, `for committing`, `Read-only commands` and update any exact-text assertions.
   - Add one new assertion: when both `gitProhibitionEnabled: true` **and** a worktree mode/`useWorktreesPerPlanEnabled: true` are set, the prompt contains both the worktree instruction and the guardrail, and the guardrail explicitly permits `worktree` (guards against the regression returning).

5. **Doc/comment sweep** — update the JSDoc at `agentPromptBuilder.ts:134` ("git prohibition directive is included") to describe the guardrail semantics. Check `src/extension.ts:3327` comment context (legacy `no_git_for_agents.md` cleanup) — no code change, just confirm nothing else re-describes the old ban.

6. **Compile & run tests** — `npm run compile` for type-check; run the prompt-builder test suites.

## Risks & edge cases

- **Copy drift:** the `gitProhibition` id is referenced in many default blocks; label/tooltip must be changed consistently across all of them (and only the copy, never the id/default). A partial edit leaves mixed labeling.
- **Hidden exact-text test:** a snapshot/preview test (e.g. `kanban-default-prompt-previews.test.js`) may embed the full old sentence. The grep in step 4 must cover `src/test/**` and any preview generators, not just the files named above.
- **Behavior change for plain roles:** roles with `gitProhibition` on but no worktree mode will now be *allowed* to commit (previously implied hand-back). This is intended per the reframing (risk = data loss, not commits), but is a behavioral shift worth calling out in the changelog/commit message.
- **Marker coupling:** tests depend on the literal `GIT POLICY` string; the new text must retain it verbatim.
- **Published extension:** no persisted-state schema changes here (directive is generated at dispatch, not stored; toggle id/defaults unchanged), so no migration is required per the repo's migration rule.

## Metadata

**Complexity:** 4
**Tags:** backend, refactor, reliability, ux

## Review Findings

Reviewed commit `1ec10da` against plan steps 1–6. The directive rewrite (`agentPromptBuilder.ts:314`) matches the proposed text verbatim and preserves the `GIT POLICY` marker; all 10 `sharedDefaults.js` role entries and the `kanban.html` label/tooltip were updated consistently with `id`/`default` unchanged (no migration). The new regression test `testGitGuardrailCoexistsWithWorktrees` asserts the guardrail + worktree directive coexist and that the old blanket-ban wording is gone; a grep of `src/test/**` confirms no remaining exact-text assertions of the old wording (only the intentional negative regex). Fixed one missed item from step 5's doc sweep: `TaskViewerProvider.ts:163` comment still claimed "false = allow git commands", which is now wrong (true also permits constructive git) — rewritten to describe guardrail semantics. Verification: compilation and automated tests skipped per session directives; type/snapshot regressions are not expected since no signatures, defaults, or persisted state changed. Remaining risks: `extension.ts:660,3327` legacy-cleanup comments and test `console.log` labels still say "git prohibition" — cosmetic only (they reference the preserved toggle id / historical file removal), deferred.
