# Expand the Git Policy into Granular Branch / Commit / Push Controls in the Prompt Builder

## Goal

Replace the single, binary "Git Safety Guardrail" prompt add-on with a set of **granular, prescriptive git controls** (Branch strategy · Commit strategy · Push strategy · an independent Safety guardrail) that compile to imperative directives in dispatched prompts. The new default matches a work-on-`main` workflow and stops agents from creating branches defensively. **Worktree isolation is deliberately out of scope** — it stays at the existing feature-level granularity (see Scope decision).

### The problem

Agents dispatched from the Prompts tab exhibit two contradictory symptoms:
1. They **refuse legitimate git operations** ("I can't do git operations") when asked to commit/push.
2. They **create branches at random**, leaving the user to clean up branch sprawl.

### Root cause (not just a permissive-vs-strict tradeoff)

The entire policy is one fixed string, `GIT_PROHIBITION_DIRECTIVE` (`src/services/agentPromptBuilder.ts:378`):

> "You may create worktrees and branches, stage, and commit your own work. You MUST NOT run work-discarding commands… Do not push or merge to **shared branches**."

The user works on `main`. `main` **is** a shared branch. So the directive tells the agent to "commit your own work" while simultaneously forbidding it from touching the branch it's standing on. The escape hatch the same sentence explicitly offers — *"you may create branches"* — is exactly what the agent reaches for: it creates a new branch to have somewhere "allowed" to commit. That is the mechanism behind **both** symptoms:
- **Refusal** — the MUST-NOT / "don't touch shared branches" language makes the agent report a git restriction when asked to commit to `main`.
- **Sprawl** — the "you may create branches" permission, triggered by the shared-branch prohibition, produces defensive branch creation.

The fix is to make the directive **prescriptive** (tell the agent exactly what to do) and **user-selected**, instead of permission-style ("you *may*…") language that different agents interpret as "should" vs. "avoid."

### Background: how the policy is wired today

- **One directive string** — `GIT_PROHIBITION_DIRECTIVE` (`agentPromptBuilder.ts:378`), conflating a safety guardrail (forbid destructive ops) with permission to branch/commit and a shared-branch push ban.
- **One binary control** — the per-role `gitProhibition` add-on. Defined in `src/webview/sharedDefaults.js` in both `DEFAULT_ROLE_CONFIG` (lines ~21–31) and `ROLE_ADDONS` (lines ~58+, one `gitProhibition` checkbox entry per role). On = inject the string; off = omit entirely. No middle setting.
- **~10 assembly call sites** in `agentPromptBuilder.ts` all read `const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : ''` (lines 901, 998, 1050, 1107, 1154, 1193, 1231, 1261, 1323, 1374) plus a generic suffix applier at line 1507 (`if (addons?.gitProhibitionEnabled) …`) used by the custom-agent / generic path.
- **A second consumer** — `src/services/AgentSkillExporter.ts:183` emits `GIT_PROHIBITION_DIRECTIVE` into exported agent skills.
- **Renderer already supports radios** — `renderRoleAddons()` (`kanban.html:3356`) renders `type:'radio'` add-on groups generically (see the existing `subagentPolicy` radio), reading/writing `roleConfigs[role].addons[addon.id]`. So new selectors drop into existing machinery.
- **Custom agents get a truncated fallback list** — `kanban.html:3363–3368` gives `custom_agent_*` roles only three add-ons (Workflow File, Worktrees Per Plan, Apply Feature Directives) — it omits even the guardrail. This is a gap: custom agents are supposed to receive every add-on.

## Metadata

**Complexity:** 4
**Tags:** feature, backend, frontend, refactor

## Locked design decisions

1. **Granular toggles**, not presets: three independent radio selectors (Branch / Commit / Push) plus the independent Safety-guardrail checkbox.
2. **Default = work-on-main**: `Branch: Current` · `Commit: When done` · `Push: Don't push` · `Guardrail: on`.
3. **Role scope**: the Branch/Commit/Push selectors attach to code-writing roles — **lead, coder, intern, claude_designer** — and to **all custom agents**. Reviewer / tester / analyst / researcher / ticket_updater keep the **guardrail only** (branching is meaningless for them). The guardrail checkbox stays on every role, as today.
4. **No migration** — the Prompts-tab add-on config for these fields is **unreleased**. Clean break; new fields simply default in. (The `gitProhibition` guardrail key is retained as the guardrail control.)
5. **No per-plan worktree option (scope decision).** A "Branch: Worktree" option was considered and **cut**. Rationale: the extension deliberately makes the *feature* the smallest worktree unit (the Worktrees tab manages these); a Switchboard project churns ~100 plans/week, so per-plan worktrees would balloon the tab and disk churn by 10–100× and re-introduce a granularity the project already rejected. The refusal + defensive-branching problem is fully solved by the prescriptive Branch(current/new)/Commit/Push/Guardrail controls — none of which need worktree provisioning. Working-tree isolation for concurrent agents remains served by the existing feature-worktree system. This removes all dispatch-side provisioning code from scope.

## New directive vocabulary (the exact strings)

The composer emits a single `GIT POLICY:` block, concatenating only the enabled clauses in this order — **Branch → Commit → Push → Safety**.

**Branch**
- `current` → "Do all work on the current branch. Do NOT create new branches or worktrees."
- `newBranch` → "Before making any changes, create ONE new git branch named descriptively for this task, and do all work on that single branch. Do not create additional branches."
- `notSpecified` → *(emit no branch clause)*

**Commit**
- `whenDone` → "When you have finished the task, stage all your changes and create a single descriptive commit."
- `incremental` → "Commit at each logical checkpoint with a clear message so progress is captured incrementally."
- `dontCommit` → "Do NOT commit. Leave all changes in the working tree for the user to review."
- `notSpecified` → *(emit no commit clause)*

**Push**
- `noPush` → "Do NOT push to any remote."
- `pushWhenDone` → "After committing, push the working branch to its remote. Do not force-push."
- `notSpecified` → *(emit no push clause)*

**Safety guardrail** (independent checkbox; the salvaged half of today's string)
- on → "Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — commit first, then correct forward."

## Interaction with existing feature worktrees (read-only; no new provisioning)

Feature worktree modes (`per-subtask` / `high-low`) already resolve an assigned `worktreePath` into the prompt builder options, and the feature orchestration directives already emit worktree instructions. To avoid contradicting them, `buildGitPolicyBlock` reads whether a worktree is already assigned (`options.worktreePath` set, or a feature worktree mode active) and adapts — **it never creates anything**:
- Worktree already assigned → **suppress the composer's Branch clause** (the feature directive owns branch/worktree language). Anchor the Commit clause to that worktree ("commit inside your assigned worktree"). Push/Safety clauses still emit normally.
- No worktree assigned → emit the Branch clause per the user's selection (`current` / `newBranch` / `notSpecified`).

This is pure awareness of state the codebase already computes — no dispatch-side hook, no `git worktree add`, no `worktrees`-table writes are added by this plan.

## Implementation steps

### 1. `src/webview/sharedDefaults.js` — defaults & selectors
- In `DEFAULT_ROLE_CONFIG`, for **lead, coder, intern, claude_designer**, add to `addons`: `gitBranchStrategy: 'current'`, `gitCommitStrategy: 'whenDone'`, `gitPushStrategy: 'noPush'`. Keep `gitProhibition: true` (guardrail). Leave the other roles unchanged (guardrail only).
- In `ROLE_ADDONS`, for those same four roles, add three `type:'radio'` add-on definitions — `gitBranchStrategy` (default `'current'`; options current / newBranch / notSpecified), `gitCommitStrategy` (default `'whenDone'`; options whenDone / incremental / dontCommit / notSpecified), `gitPushStrategy` (default `'noPush'`; options noPush / pushWhenDone / notSpecified). Keep the existing `gitProhibition` checkbox entry. **No worktree option.**

### 2. `src/webview/kanban.html` — custom-agent parity
- Extend the `custom_agent_*` fallback add-on array (`kanban.html:3363–3368`) to include the `gitProhibition` checkbox and the three git radio groups (ideally the full shared add-on set, since custom agents receive all add-ons). The existing radio renderer + save path handle persistence with no other changes.
- The static planner Add-ons section (`kanban.html:2890–2962`) stays **guardrail-only** (planner is not code-touching); no branch/commit/push there.

### 3. `src/services/agentPromptBuilder.ts` — split & compose
- Add a `GIT_SAFETY_DIRECTIVE` constant (guardrail-only text). Retain `GIT_PROHIBITION_DIRECTIVE` only if still referenced elsewhere; otherwise remove after the swap.
- Extend the options interface (near line 184) with `gitBranchStrategy?`, `gitCommitStrategy?`, `gitPushStrategy?` (string unions), keeping `gitProhibitionEnabled?` for the guardrail.
- Add `buildGitPolicyBlock({ branch, commit, push, guardrail, worktreePath, worktreeActive })` implementing the vocabulary + the feature-worktree interaction rules above; returns `''` when nothing is enabled.
- Replace all ~10 `gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : ''` sites with `buildGitPolicyBlock(...)`. Non-code roles pass no strategy fields → only the guardrail clause is emitted (preserves current behavior for them).
- Replace the generic suffix applier at line 1507 with `buildGitPolicyBlock(...)` sourced from `addons.gitBranchStrategy/gitCommitStrategy/gitPushStrategy/gitProhibition` — this is the custom-agent path.

### 4. `src/services/KanbanProvider.ts` — thread the new options (read-only)
- In `generateUnifiedPrompt` / `resolvedOptions` (~line 4014), for code roles, read the three new per-role add-ons into `resolvedOptions.gitBranchStrategy/gitCommitStrategy/gitPushStrategy` alongside the existing `gitProhibitionEnabled`. No new dispatch logic, no worktree provisioning — the existing `worktreePath` resolution for feature worktrees is untouched and simply flows into `buildGitPolicyBlock`.

### 5. `src/services/AgentSkillExporter.ts` — consistency
- Replace the `GIT_PROHIBITION_DIRECTIVE` emit (line 183) with `buildGitPolicyBlock(...)` built from the exported agent's add-on config, so exported skills carry the same composed policy.

## Roles matrix

| Role | Branch/Commit/Push selectors | Guardrail |
|---|---|---|
| lead, coder, intern, claude_designer | ✅ | ✅ |
| custom_agent_* | ✅ | ✅ |
| reviewer, tester, analyst, researcher, ticket_updater | ❌ | ✅ |
| planner | ❌ | ✅ |

## Testing / verification

- **Unit** (`src/test/agent-prompt-builder-subagents.test.js`): code roles emit Branch+Commit+Push+Safety with the new defaults; non-code roles emit Safety only; guardrail off omits the Safety clause; each strategy enum value produces its exact clause; `notSpecified` emits nothing for that dimension; when `worktreePath` is set (feature worktree active) the Branch clause is suppressed while Commit/Push/Safety still emit (no contradiction with the feature orchestration directive).
- **Manual**: Prompts tab → Coder → three radios render, persist across reload, and change the live preview. Custom agent → radios render (parity). Planner → guardrail checkbox only (no branch/commit/push). Dispatch with `Branch: Current` on `main` → prompt says stay on current branch, commit when done, no push; no new branch is created. Dispatch a card that has a feature worktree → prompt references the feature worktree, not a fresh branch.

## Non-goals / known limitations

- **No worktree granularity change.** Working-tree isolation stays at the feature level via the existing Worktrees tab. A per-plan worktree option was explicitly cut (see decision 5). If a genuine need appears — many *concurrent standalone (non-feature)* plans colliding on the same working tree — it can be added later as a focused feature.
- **`useWorktreesPerPlan` is unchanged** and still instructs agents to create their own (untracked) worktrees. Out of scope here; flag for a future plan if its orphan worktrees become a pain point.
- No global/settings-level default; controls remain per-role add-ons persisted in the existing role config, as today.
