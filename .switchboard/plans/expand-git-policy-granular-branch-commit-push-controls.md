# Expand the Git Policy into Granular Branch / Commit / Push Controls in the Prompt Builder

**Plan ID:** e927095c-659f-4aef-8e5c-ec53c9d93b8c

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
- **One binary control** — the per-role `gitProhibition` add-on. Defined in `src/webview/sharedDefaults.js` in both `DEFAULT_ROLE_CONFIG` (lines ~18–32) and `ROLE_ADDONS` (lines ~58+, one `gitProhibition` checkbox entry per role). On = inject the string; off = omit entirely. No middle setting.
- **~10 assembly call sites** in `agentPromptBuilder.ts` all read `const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : ''` (lines 901, 998, 1050, 1107, 1154, 1193, 1231, 1261, 1323, 1374) plus a generic suffix applier at line 1507 (`if (addons?.gitProhibitionEnabled) …`) used by the custom-agent / generic path. **Clarification (verified):** each of those 10 sites consumes a *local* `gitProhibitionEnabled` resolved from `options` at **two resolution sites** — line 734 (`?? true`, non-planner roles) and line 845 (`?? false`, planner branch). Any replacement must also resolve the new strategy fields at these two points, or `buildGitPolicyBlock` receives `undefined` for every strategy.
- **A second consumer** — `src/services/AgentSkillExporter.ts:183` emits `GIT_PROHIBITION_DIRECTIVE` into exported agent skills. **Clarification (verified):** the addons object reaching `appendAddonSection` is built by one of *two* feeders — `normalizeBuiltinAddons` (built-in roles, `AgentSkillExporter.ts:83–128`) or `parseCustomAgentAddons` (custom agents, `src/services/agentConfig.ts:167+`). Neither maps the new strategy fields today; both must be extended or the exporter silently reverts the feature for every exported skill.
- **Renderer already supports radios** — `renderRoleAddons()` (`kanban.html:3356`) renders `type:'radio'` add-on groups generically (see the existing `subagentPolicy` radio), reading/writing `roleConfigs[role].addons[addon.id]`. So new selectors drop into existing machinery.
- **Custom agents get a truncated fallback list** — `kanban.html:3363–3368` gives `custom_agent_*` roles only three add-ons (Workflow File, Worktrees Per Plan, Apply Feature Directives) — it omits even the guardrail. This is a gap: custom agents are supposed to receive every add-on.
- **`CustomAgentAddons` lives in `src/services/agentConfig.ts`** (interface at lines 3–58; allowlist parser `parseCustomAgentAddons` at 167+). This file is a required touch point (see Proposed Changes step 1) — the plan's original draft omitted it.

## Metadata

**Complexity:** 5
**Tags:** feature, backend, frontend, refactor

## User Review Required

Yes — review the six wiring additions (steps 1, 4, 5, 6 and the `worktreeActive`-source + defaulting clarifications) before dispatch. These make the plan's *original* stated scope actually function; they add no new product behavior. Specifically confirm:
- Adding `claude_designerConfig` loading to `_getPromptsConfig` (so claude_designer's new radios take effect at dispatch — today claude_designer is absent from `KanbanProvider.ts` entirely and rides the `?? true` default at line 4025).
- The mixed-batch worktree rule (suppress the Branch clause globally if *any* plan in the batch carries a worktree).
- The defaulting contract (config layer defaults code roles to work-on-main; `buildGitPolicyBlock` is pure and treats `undefined`/`notSpecified` identically).

## Complexity Audit

### Routine
- Adding three `type:'radio'` add-on definitions to `ROLE_ADDONS` for four roles in `sharedDefaults.js` — mirrors the existing `subagentPolicy` radio pattern exactly; the generic radio renderer + save path already handle persistence.
- Adding three default keys to `DEFAULT_ROLE_CONFIG` for the four code-writing roles.
- Extending the `custom_agent_*` fallback array in `kanban.html:3363–3368` with the guardrail checkbox + three radio groups (or the full shared add-on set).
- Composing the `GIT POLICY:` block from four clause strings in a fixed order (Branch → Commit → Push → Safety) — pure string assembly.
- Echoing the `*ByRole` map pattern three more times in `_getPromptsConfig` (the file already repeats this pattern for `gitProhibitionByRole`, `skipCompilationByRole`, `skipTestsByRole`, etc.).
- Replacing 10 identical ternary lines + 1 generic applier line with `buildGitPolicyBlock(...)` calls — mechanical, one-for-one.
- The static planner Add-ons section (`kanban.html:2890–2962`) stays guardrail-only — no change there.

### Complex / Risky
- **Wiring sprawl across 5 files** (`agentConfig.ts`, `sharedDefaults.js`, `kanban.html`, `agentPromptBuilder.ts`, `KanbanProvider.ts`, `AgentSkillExporter.ts`) — the contract changes must stay in sync across the interface, the parser, the config maps, the resolution sites, the builder, and both exporter feeders. A miss in any one silently degrades the feature (e.g. exporter emits guardrail-only skills; custom-agent definitions forget the radios on reload).
- **`claude_designer` was never wired into `KanbanProvider`** — loading `claude_designerConfig` and threading it through the new `*ByRole` maps is a correction to a pre-existing omission, touching a role the original plan assumed already worked.
- **`worktreeActive` signal source** — the builder must read worktree state from the per-plan aggregation at `agentPromptBuilder.ts:781` (`worktreePaths = [...new Set(plans.map(p => p.worktreePath)...)]`), NOT from `options.worktreePath` (which `KanbanProvider.resolvedOptions` at 4014–4036 never sets). Mixed-batch handling is an accepted edge case.
- **Defaulting contract** — `undefined` (unconfigured) vs `'notSpecified'` (explicit emit-nothing) must be distinguished at the config layer, or unconfigured custom agents silently get no Branch/Commit/Push clauses, violating the work-on-main default.

## Edge-Case & Dependency Audit

**Race Conditions:** None. The git-policy block is composed synchronously inside `buildKanbanBatchPrompt` / `buildCustomAgentPrompt` from already-resolved per-role config. No concurrent writes to role config during a single prompt build.

**Security:** The Safety guardrail clause (forbid `git reset --hard`, `git checkout <path>`/`git restore`, `git clean`, `git stash drop/clear`, force-push, branch/worktree deletion) is the *salvaged* half of the original string and must remain byte-for-byte as strong — do not soften it while splitting. The `newBranch` + `pushWhenDone` combination is the only path that authorizes a remote push; it must carry the "do not force-push" qualifier verbatim.

**Side Effects:** Removing `GIT_PROHIBITION_DIRECTIVE` after the swap is safe — grep confirms the only source consumers are the 12 references in `agentPromptBuilder.ts` (1 declaration + 10 ternaries + 1 generic applier) and 2 in `AgentSkillExporter.ts` (import + emit). No other source file references it. Keep the `GIT POLICY:` literal marker at the start of the composed block so any existing substring-based tests/assertions remain valid.

**Dependencies & Conflicts:**
- **Feature-worktree orchestration directives** (`FEATURE_ORCHESTRATION_DIRECTIVE_PER_SUBTASK` / `_HIGH_LOW`, `agentPromptBuilder.ts:483/500`) already emit worktree/branch language per subtask/tier. The new Branch clause MUST be suppressed when those are active, or the prompt contradicts itself (one line says "create a branch", the next says "work in your assigned worktree"). This is the worktree interaction rule in Proposed Changes.
- **`useWorktreesPerPlan`** is unchanged and out of scope (see Non-goals) — it instructs agents to create their own *untracked* worktrees and is orthogonal to the Branch/Commit/Push selectors.
- **Planner guardrail key inconsistency (pre-existing, not introduced):** `sharedDefaults.js` planner has `gitProhibition: false`; `KanbanProvider._getPromptsConfig` (4269/4274) reads `plannerConfig?.addons?.gitProhibition ?? config.get('planner.gitProhibitionEnabled', false)`. The static planner section (`kanban.html:2923`, `plannerAddonGitProhibition`) is a *second* planner guardrail control, separate from `ROLE_ADDONS.planner`. The planner stays guardrail-only — no branch/commit/push leaks into either planner path.
- **Custom-agent `gitProhibition` vs `gitProhibitionEnabled` key mismatch (pre-existing):** `buildCustomAgentPrompt` line 1507 reads `addons?.gitProhibitionEnabled` (set by `parseCustomAgentAddons` on the *agent definition*), while the Prompts-tab UI persists `gitProhibition` (the role-config key). Replacing line 1507 with `buildGitPolicyBlock(...)` reading the UI keys (`gitProhibition`, `gitBranchStrategy`, etc.) **fixes** this inconsistency — the role-config toggle will then actually flow to the custom-agent prompt.

## Dependencies

- None. Single-plan change; no prerequisite sessions or plans. (The git-safety-guardrail worktree-reconciliation plan and the prompt-builder redundancy-cleanup plan are related history, not blockers — both already shipped their string edits to `GIT_PROHIBITION_DIRECTIVE`, which this plan supersedes by splitting it.)

## Adversarial Synthesis

Key risks: the plan's original draft omitted the `agentConfig.ts` contract/parser, the `_getPromptsConfig` map *producers*, the `claude_designer` wiring, the two strategy-resolution sites (734/845), both exporter feeders, and the real `worktreeActive` signal source — six load-bearing wires whose absence would silently make the feature no-op for custom agents, claude_designer, and exported skills. Mitigations: add `agentConfig.ts` as step 1; build the three `*ByRole` maps and load `claude_designerConfig` in step 5; resolve strategies at 734/845 and derive `worktreeActive` from the line-781 aggregation in step 4; extend `normalizeBuiltinAddons` + `parseCustomAgentAddons` in step 6; pin defaulting at the config layer so `buildGitPolicyBlock` stays pure.

## Proposed Changes

### Locked design decisions

1. **Granular toggles**, not presets: three independent radio selectors (Branch / Commit / Push) plus the independent Safety-guardrail checkbox.
2. **Default = work-on-main**: `Branch: Current` · `Commit: When done` · `Push: Don't push` · `Guardrail: on`.
3. **Role scope**: the Branch/Commit/Push selectors attach to code-writing roles — **lead, coder, intern, claude_designer** — and to **all custom agents**. Reviewer / tester / analyst / researcher / ticket_updater keep the **guardrail only** (branching is meaningless for them). The guardrail checkbox stays on every role, as today.
4. **No migration** — the Prompts-tab add-on config for these fields is **unreleased**. Clean break; new fields simply default in. (The `gitProhibition` guardrail key is retained as the guardrail control.)
5. **No per-plan worktree option (scope decision).** A "Branch: Worktree" option was considered and **cut**. Rationale: the extension deliberately makes the *feature* the smallest worktree unit (the Worktrees tab manages these); a Switchboard project churns ~100 plans/week, so per-plan worktrees would balloon the tab and disk churn by 10–100× and re-introduce a granularity the project already rejected. The refusal + defensive-branching problem is fully solved by the prescriptive Branch(current/new)/Commit/Push/Guardrail controls — none of which need worktree provisioning. Working-tree isolation for concurrent agents remains served by the existing feature-worktree system. This removes all dispatch-side provisioning code from scope.

### New directive vocabulary (the exact strings)

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

### Interaction with existing feature worktrees (read-only; no new provisioning)

Feature worktree modes (`per-subtask` / `high-low`) already resolve an assigned `worktreePath` into the prompt builder options, and the feature orchestration directives already emit worktree instructions. To avoid contradicting them, `buildGitPolicyBlock` reads whether a worktree is already assigned and adapts — **it never creates anything**:
- Worktree already assigned → **suppress the composer's Branch clause** (the feature directive owns branch/worktree language). Anchor the Commit clause to that worktree ("commit inside your assigned worktree"). Push/Safety clauses still emit normally.
- No worktree assigned → emit the Branch clause per the user's selection (`current` / `newBranch` / `notSpecified`).

**Clarification (verified — corrects the original draft):** the "worktree assigned" signal must be derived from the per-plan aggregation at `agentPromptBuilder.ts:781` (`worktreePaths = [...new Set(plans.map(p => p.worktreePath).filter(...))]`), NOT from `options.worktreePath`. `KanbanProvider.resolvedOptions` (4014–4036) never sets a top-level `worktreePath`; worktrees flow through `plans[].worktreePath` (`BatchPromptPlan.worktreePath`, line 75). So `buildGitPolicyBlock` should receive a boolean `worktreeActive = worktreePaths.length > 0` (computed once in `buildKanbanBatchPrompt` where the aggregation already happens) rather than a single `worktreePath` string.

**Mixed-batch edge case:** if a batch mixes worktree-assigned and non-worktree plans, the single git-policy block applies the global rule — suppress the Branch clause whenever *any* plan carries a worktree (the feature-orchestration directive owns worktree/branch language for those plans; non-worktree plans sharing a batch with worktree plans is an accepted rarity). Document this in the builder's comment.

This is pure awareness of state the codebase already computes — no dispatch-side hook, no `git worktree add`, no `worktrees`-table writes are added by this plan.

### Roles matrix

|| Role | Branch/Commit/Push selectors | Guardrail |
||---|---|---|
|| lead, coder, intern, claude_designer | ✅ | ✅ |
|| custom_agent_* | ✅ | ✅ |
|| reviewer, tester, analyst, researcher, ticket_updater | ❌ | ✅ |
|| planner | ❌ | ✅ |

**Clarification (verified — required for the matrix to hold):** `claude_designer` is **absent from `KanbanProvider.ts` entirely** (no `claude_designerConfig` loaded in `_getPromptsConfig`, lines 4188–4196; not in any `*ByRole` map). Today it rides the `?? true` default at line 4025 for the guardrail only. For claude_designer's new selectors to take effect at dispatch, step 5 must load `claude_designerConfig` and include `claude_designer` in all three new strategy maps (and optionally in `gitProhibitionByRole` for parity). Without this, the radios render in the UI (sharedDefaults provides them) but are a no-op at dispatch.

### File-by-file changes

#### 1. `src/services/agentConfig.ts` — extend the `CustomAgentAddons` contract (REQUIRED — omitted by original draft)
- **Interface (lines 3–58):** add three optional fields to `CustomAgentAddons`:
  - `gitBranchStrategy?: 'current' | 'newBranch' | 'notSpecified';`
  - `gitCommitStrategy?: 'whenDone' | 'incremental' | 'dontCommit' | 'notSpecified';`
  - `gitPushStrategy?: 'noPush' | 'pushWhenDone' | 'notSpecified';`
  - Keep `gitProhibitionEnabled?: boolean;` (the custom-agent *definition* key; the role-config UI key `gitProhibition` is merged separately in `KanbanProvider.generateUnifiedPrompt`).
- **`parseCustomAgentAddons` allowlist (lines 167+):** add three allowlist reads so custom-agent *definitions* persist the strategies across reload — mirroring the existing `subagentPolicy` enum allowlist (line 194):
  - `if (s.gitBranchStrategy && ['current','newBranch','notSpecified'].includes(s.gitBranchStrategy as string)) a.gitBranchStrategy = s.gitBranchStrategy as any;`
  - same for `gitCommitStrategy` (`['whenDone','incremental','dontCommit','notSpecified']`) and `gitPushStrategy` (`['noPush','pushWhenDone','notSpecified']`).
  - Without this, `parseCustomAgentAddons` **strips** the new fields on every load and custom-agent definitions silently forget the user's selection.

#### 2. `src/webview/sharedDefaults.js` — defaults & selectors
- In `DEFAULT_ROLE_CONFIG`, for **lead, coder, intern, claude_designer**, add to `addons`: `gitBranchStrategy: 'current'`, `gitCommitStrategy: 'whenDone'`, `gitPushStrategy: 'noPush'`. Keep `gitProhibition: true` (guardrail). Leave the other roles unchanged (guardrail only).
- In `ROLE_ADDONS`, for those same four roles, add three `type:'radio'` add-on definitions — `gitBranchStrategy` (default `'current'`; options current / newBranch / notSpecified), `gitCommitStrategy` (default `'whenDone'`; options whenDone / incremental / dontCommit / notSpecified), `gitPushStrategy` (default `'noPush'`; options noPush / pushWhenDone / notSpecified). Keep the existing `gitProhibition` checkbox entry. **No worktree option.**

#### 3. `src/webview/kanban.html` — custom-agent parity
- Extend the `custom_agent_*` fallback add-on array (`kanban.html:3363–3368`) to include the `gitProhibition` checkbox and the three git radio groups (ideally the full shared add-on set, since custom agents receive all add-ons). Give the three radios `default` values of `current` / `whenDone` / `noPush` so the UI shows the work-on-main default before the user first toggles. The existing radio renderer (`renderRoleAddons`, 3379+) + save path handle persistence with no other changes.
- The static planner Add-ons section (`kanban.html:2890–2962`) stays **guardrail-only** (planner is not code-touching); no branch/commit/push there.

#### 4. `src/services/agentPromptBuilder.ts` — split & compose
- Add a `GIT_SAFETY_DIRECTIVE` constant (guardrail-only text — the salvaged string above). Retain `GIT_PROHIBITION_DIRECTIVE` only if still referenced elsewhere after the swap; otherwise remove it (grep confirms no other source consumers).
- Extend the `PromptBuilderOptions` interface (near line 184) with `gitBranchStrategy?`, `gitCommitStrategy?`, `gitPushStrategy?` (string unions), keeping `gitProhibitionEnabled?` for the guardrail.
- **Resolve the new strategies at the two existing resolution sites (REQUIRED — omitted by original draft):** at line 734 (`const gitProhibitionEnabled = options?.gitProhibitionEnabled ?? true;`) add `const gitBranchStrategy = options?.gitBranchStrategy;` / `gitCommitStrategy` / `gitPushStrategy` (default `undefined` — the config layer owns work-on-main defaults; the builder treats `undefined` as emit-nothing). At line 845 (planner branch, `?? false`) add the same three resolutions. These locals feed the 10 ternary replacements below.
- Add `buildGitPolicyBlock({ branch, commit, push, guardrail, worktreeActive })` implementing the vocabulary + the feature-worktree interaction rules above. **`worktreeActive` is a boolean** derived by the caller from `worktreePaths.length > 0` (line 781 aggregation) — not a `worktreePath` string. The builder is **pure**: `undefined` and `'notSpecified'` both mean "emit no clause for that dimension"; `guardrail` emits only when truthy. Returns `''` when nothing is enabled. Keep the `GIT POLICY:` literal marker as the block prefix.
- Replace all ~10 `gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : ''` sites with `buildGitPolicyBlock(...)` calls, passing the locally-resolved strategies + `gitProhibitionEnabled` + the `worktreeActive` boolean computed once in `buildKanbanBatchPrompt`. Non-code roles pass no strategy fields (they default to `undefined` → only the guardrail clause is emitted, preserving current behavior for them).
- Replace the generic suffix applier at line 1507 with `buildGitPolicyBlock(...)` sourced from `addons.gitBranchStrategy / gitCommitStrategy / gitPushStrategy / gitProhibition` (UI keys — this is the custom-agent path; `mergedAddons` in `KanbanProvider.generateUnifiedPrompt` carries these from `roleConfigAddons`). Pass `worktreeActive` derived from the custom-agent path's own plan aggregation. **This change also fixes the pre-existing `gitProhibitionEnabled`-vs-`gitProhibition` key mismatch** by reading the UI key directly.

#### 5. `src/services/KanbanProvider.ts` — thread the new options (read-only)
- **Load `claude_designerConfig` (REQUIRED — omitted by original draft):** in `_getPromptsConfig` (lines 4188–4196), add `const claudeDesignerConfig: any = this._getRoleConfig('claude_designer');` so claude_designer is queryable for the new maps.
- **Build the three new `*ByRole` maps (REQUIRED — the producers that line 4025 reads from):** in the return object of `_getPromptsConfig` (alongside `gitProhibitionByRole` at 4273–4283), add:
  - `gitBranchStrategyByRole: { planner: 'notSpecified', lead: leadConfig?.addons?.gitBranchStrategy ?? 'current', coder: coderConfig?.addons?.gitBranchStrategy ?? 'current', intern: internConfig?.addons?.gitBranchStrategy ?? 'current', claude_designer: claudeDesignerConfig?.addons?.gitBranchStrategy ?? 'current', reviewer: 'notSpecified', tester: 'notSpecified', analyst: 'notSpecified', researcher: 'notSpecified', ticket_updater: 'notSpecified' }`
  - `gitCommitStrategyByRole:` same shape, code roles default `'whenDone'`, non-code roles `'notSpecified'`.
  - `gitPushStrategyByRole:` same shape, code roles default `'noPush'`, non-code roles `'notSpecified'`.
  - The `?? '<default>'` here is the **single source of the work-on-main default** for built-in code roles (locked decision #2). Non-code roles get `'notSpecified'` so they emit no clause.
- **Read the maps into `resolvedOptions` (lines 4014–4036):** add three lines alongside `gitProhibitionEnabled` (4025):
  - `gitBranchStrategy: promptsConfig.gitBranchStrategyByRole?.[role] ?? 'notSpecified',`
  - `gitCommitStrategy: promptsConfig.gitCommitStrategyByRole?.[role] ?? 'notSpecified',`
  - `gitPushStrategy: promptsConfig.gitPushStrategyByRole?.[role] ?? 'notSpecified',`
  - No new dispatch logic, no worktree provisioning — the existing per-plan `worktreePath` resolution for feature worktrees is untouched and flows into `buildGitPolicyBlock` via the line-781 aggregation.
- **Custom-agent defaulting (REQUIRED for locked decision #2 to hold):** in `generateUnifiedPrompt`'s custom-agent branch (3966–3970, `mergedAddons`), after merging, apply work-on-main defaults to absent strategy fields: `if (mergedAddons.gitBranchStrategy === undefined) mergedAddons.gitBranchStrategy = 'current';` (same for `gitCommitStrategy → 'whenDone'`, `gitPushStrategy → 'noPush'`). This ensures a custom agent whose Prompts-tab UI was never opened still gets work-on-main at dispatch (the UI radio `default` only governs rendering, not persistence).

#### 6. `src/services/AgentSkillExporter.ts` — consistency (extend BOTH feeders)
- **`normalizeBuiltinAddons` (lines 83–128 — REQUIRED, omitted by original draft):** add same-name pass-through for the three strategy fields (mirroring the `subagentPolicy` pass-through at 106–112):
  - `if (builtinAddons.gitBranchStrategy !== undefined) out.gitBranchStrategy = builtinAddons.gitBranchStrategy;` (same for `gitCommitStrategy`, `gitPushStrategy`).
  - Without this, built-in role exports call `buildGitPolicyBlock` with `undefined` strategies and emit a guardrail-only skill.
- **`parseCustomAgentAddons` (in `agentConfig.ts`, step 1) already allowlists the fields** — that covers the custom-agent export feeder.
- **`appendAddonSection` (line 179–186):** replace the `GIT_PROHIBITION_DIRECTIVE` emit (lines 180–186) with `buildGitPolicyBlock(...)` built from the exported agent's add-on config (`gitBranchStrategy / gitCommitStrategy / gitPushStrategy / gitProhibitionEnabled`), so exported skills carry the same composed policy. Import `buildGitPolicyBlock` from `agentPromptBuilder.ts`.

## Verification Plan

### Automated Tests

> **Note:** Per session directives, the planner did **not** run `npm run compile` or the automated test suite during this planning pass — these are for the implementation phase. The unit additions below describe what the implementer must add/verify.

- **Unit** (`src/test/agent-prompt-builder-subagents.test.js`, imports from `../../out/services/agentPromptBuilder`): code roles emit Branch+Commit+Push+Safety with the new defaults; non-code roles emit Safety only; guardrail off omits the Safety clause; each strategy enum value produces its exact clause; `notSpecified` (and `undefined`) emit nothing for that dimension; when a plan carries a `worktreePath` (feature worktree active) the Branch clause is suppressed while Commit/Push/Safety still emit (no contradiction with the feature orchestration directive); mixed-batch (some plans with worktree, some without) suppresses the Branch clause globally.
- **Exported-skill consistency** (`src/test/` or manual): exporting a lead coder with `gitBranchStrategy: 'newBranch'` + `gitPushStrategy: 'pushWhenDone'` produces a skill file whose `### Git Safety Guardrail` section contains the composed `GIT POLICY:` block with the newBranch + pushWhenDone + Safety clauses (not the legacy single string).
- **Custom-agent persistence:** a custom-agent definition saved with `gitBranchStrategy: 'current'` round-trips through `parseCustomAgentAddons` without the field being stripped (regression test for the step-1 allowlist addition).
- **Manual:** Prompts tab → Coder → three radios render, persist across reload, and change the live preview. Custom agent → radios render (parity). Planner → guardrail checkbox only (no branch/commit/push). Dispatch with `Branch: Current` on `main` → prompt says stay on current branch, commit when done, no push; no new branch is created. Dispatch a card that has a feature worktree → prompt references the feature worktree, not a fresh branch. Export a Coder skill → skill file contains the composed `GIT POLICY:` block matching the role's selections.

## Non-goals / known limitations

- **No worktree granularity change.** Working-tree isolation stays at the feature level via the existing Worktrees tab. A per-plan worktree option was explicitly cut (see decision 5). If a genuine need appears — many *concurrent standalone (non-feature)* plans colliding on the same working tree — it can be added later as a focused feature.
- **`useWorktreesPerPlan` is unchanged** and still instructs agents to create their own (untracked) worktrees. Out of scope here; flag for a future plan if its orphan worktrees become a pain point.
- No global/settings-level default; controls remain per-role add-ons persisted in the existing role config, as today.

---

**Recommendation: Send to Coder.** (Complexity 5 — Mixed band: majority-routine radio/string/config-map work across 6 files, with the `claude_designer` wiring correction, the `worktreeActive`-signal correction, and the defaulting contract as the moderate, well-scoped risks.)

## Review Findings

All six wiring points landed correctly: `buildGitPolicyBlock` + `GIT_SAFETY_DIRECTIVE` (agentPromptBuilder.ts), strategy resolution at both sites (847/975), `worktreeActive` from the line-903 aggregation, the three `*ByRole` maps + `claude_designerConfig` load + custom-agent defaulting (KanbanProvider.ts), both exporter feeders (AgentSkillExporter.ts / agentConfig.ts allowlist), the four-role radios (sharedDefaults.js), and the custom-agent UI parity (kanban.html); `GIT_PROHIBITION_DIRECTIVE` is fully removed (only comment refs remain). **Fix applied:** `KanbanProvider.ts:3997` — the Safety guardrail was defaulted on for built-in code roles but *not* for custom agents, so a never-saved custom agent rendered the guardrail checkbox checked yet dispatched without the clause (violating locked decision #2 "Guardrail: on"); added a `mergedAddons.gitProhibition` default that fires only when both guardrail keys are unset (explicit off in either key is preserved). Verified statically (no compile/tests per session directives): grep confirms no orphaned `GIT_PROHIBITION_DIRECTIVE` consumers, all 11 `buildGitPolicyBlock` call sites resolve their strategy locals in scope, and the role matrix (code roles get radios; planner/reviewer/tester/analyst/researcher/ticket_updater get guardrail-only) matches sharedDefaults. Remaining risks: (1) a stray `src/test/agent-prompt-builder-subagents.test.js.tmp` artifact appears committed — harmless but should be cleaned up; (2) in feature `none`-mode the base orchestration directive's optional "activate worktree isolation" line coexists with a `Branch: current` clause — an accepted soft-overlap per plan line 125 ("no worktree assigned → emit the Branch clause"), not a defect.
