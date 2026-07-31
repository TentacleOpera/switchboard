# Decouple the Agent-Managed Worktrees toggle from Feature Subagent Policy

## Goal

Make the **Agent-Managed Worktrees** toggle emit worktree instructions only. Subagent behaviour becomes the exclusive responsibility of the **Feature Subagent Policy** radio, and its `default` position emits no subagent language at all — genuinely deferring to the execution platform, as its label promises.

### The problem

In the Prompts tab, two controls in the Features group overlap:

- **Agent-Managed Worktrees** (`useWorktreesPerPlan`) — a boolean toggle.
- **Feature Subagent Policy** (`featureSubagentPolicy`) — a 4-way radio: `default` / `noSubagents` / `useSubagents` / `customSubagent`.

Turning the worktree toggle **off** currently causes the dispatch prompt to say *"do NOT create git worktrees **or spawn subagents** for this dispatch"* — a hard subagent prohibition issued by a control that is not the subagent control, while the dedicated subagent control sits next to it reading "Default (platform decides)".

### Root cause

`buildFeatureSubagentClause()` — `src/services/agentPromptBuilder.ts:811-840` — has two structurally different branches:

**Branch A, `policy === 'default'` (`:817-821`)** — the worktree flag decides *both* axes on its own:

| `useWorktreesPerPlan` | emitted text |
| --- | --- |
| ON | `Use your native subagent or orchestration capabilities to handle each subtask. If your tool supports worktree-per-plan isolation, activate it now. …` |
| OFF | `Handle the subtasks yourself in a sensible order — do NOT create git worktrees or spawn subagents for this dispatch. ` |

**Branch B, every other policy (`:823-839`)** — the two axes are composed independently as `worktreeClause + subagentClause`, which is the correct orthogonal model.

So the radio is honoured in three of its four positions and silently overridden in the fourth. Note that in Branch A, `default` never actually defers in *either* direction: ON forces subagents, OFF forbids them. It is not a "platform decides" setting — it is an alias for two hard-coded combinations.

**Why it exists:** the worktree toggle predates the radio. It shipped as a single master switch for "agent-managed orchestration" — worktrees *and* subagents as one bundle — and the bundling is still documented as intentional in its tooltip (`src/webview/sharedDefaults.js:142`): *"Off = the agent implements subtasks directly — no worktrees, no subagents."* When the 4-way policy was added later it was bolted on as Branch B, and the legacy bundled behaviour was preserved verbatim as Branch A instead of being decomposed into the new model.

**Why it bites in practice:** `featureSubagentPolicy: 'default'` and `useWorktreesPerPlan: false` are both the shipped defaults for lead, coder, and intern (`sharedDefaults.js:24,25,28`). Out of the box, *every* feature dispatch therefore carries a hard subagent ban while the UI shows "Default — let the execution platform decide". The label and the emitted prompt disagree at the factory setting.

### Two secondary contradictions from the same design

1. **Branch B's worktree-off clause over-reaches.** `:825` emits `Do NOT create git worktrees for this dispatch; implement the subtasks directly. ` — "implement the subtasks directly" is a subagent statement smuggled into a worktree clause. With `policy === 'useSubagents'` the composed output reads *"…implement the subtasks directly. Use your native subagent or orchestration capabilities to handle each subtask."* — self-contradictory in consecutive sentences.

2. **`WORKTREES_PER_PLAN_DIRECTIVE` (`:793`) conflates the same two axes** in the ON direction — *"process each plan as an isolated unit **using your native subagent or orchestration capabilities**, creating a dedicated git worktree per plan…"*. It is exported into generated skill files via `AgentSkillExporter.ts:317`, so the conflation leaks into `.claude/skills` and `.agents/skills` output too.

### Decision

Option 1 of the two considered: the worktree clause becomes **truly silent** on subagents in both directions. `default` emits no subagent sentence; the radio is the only thing that can produce one.

---

## Metadata

**Complexity:** 4
**Tags:** bugfix, refactor, ui, backend

---

## User Review Required

Yes — before implementation. Two judgement calls the user should confirm:

1. **The "No migration" call rests on user confirmation that the `featureSubagentPolicy` / Agent-Managed Worktrees pairing has never shipped in a released VSIX.** The plan records this as user-confirmed. Per the repo rule (~4,000 installs, older versions in the wild), a wrong call here silently changes the meaning of saved `featureSubagentPolicy: 'default'` configs in place. If there is ANY chance a released version persisted this key, a migration/compat step is required instead of a clean break. Confirm the release history before proceeding.
2. **The neutral ordering line (`Work through the subtasks in a sensible order.`) is preserved on all three `buildFeatureSubagentClause` call paths** (see Proposed Changes §2). The original plan only patched one path; the improve pass extends it. Confirm the custom-agent feature path should keep the ordering guidance rather than go silent.

---

## Complexity Audit

### Routine
- Rewriting `buildFeatureSubagentClause` to a single composition path — deleting the `default` early return and routing all four policies through the existing `worktreeClause + subagentClause` model that Branch B already uses.
- Rewording `WORKTREES_PER_PLAN_DIRECTIVE` to strip the subagent half — a string-literal edit with two known consumers.
- Updating the `useWorktreesPerPlan` tooltip at 4 duplicated sites — copy replacement, no logic.
- Updating two test assertions and adding a policy×worktree matrix — mechanical test authoring against known strings.

### Complex / Risky
- **Three call sites of `buildFeatureSubagentClause` diverge in how they frame the feature dispatch**, and the neutral ordering line must be preserved on each without doubling it up where sequencing wording already exists:
  - `:868` `resolveFeatureOrchestrationDirective` (lead/reviewer/intern via `featureDirectiveBlock`) — gets the new ordering line directly.
  - `:1528` coder feature branch — bypasses `resolveFeatureOrchestrationDirective`; its `featureExecutionBlock` (`:1505`, *"Execute each subtask plan in full before moving to the next"*) already carries sequencing, so the new line must NOT be added here.
  - `:1878` `buildCustomAgentPrompt` — bypasses `resolveFeatureOrchestrationDirective` AND has no `featureExecutionBlock`; it loses the old "in a sensible order" wording with no replacement unless the improve-pass extension is applied (see §2).
- **Semantic change to the shipped default output.** With `featureSubagentPolicy: 'default'` + worktrees off (the factory setting), the emitted clause changes from a hard subagent ban to a single worktree-negative sentence. This is the intended fix, but it is a behaviour change visible to every out-of-the-box feature dispatch — reviewers must accept that "Default" now genuinely says nothing about subagents.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- None. `buildFeatureSubagentClause` is a pure string function with no shared mutable state; all inputs are read once per prompt build.

**Security**
- None. No secrets, credentials, or user-controlled interpolation enter the clause. `customSubagentName` is already trimmed and only interpolated into a fixed template (`:833-836`); the refactor preserves that path verbatim.

**Side Effects**
- **Prompt-text behaviour change at the factory setting.** Every default feature dispatch for lead/coder/intern/reviewer currently emits a subagent ban; after the change it emits only `Do NOT create git worktrees for this dispatch.` Agents that previously read the ban as a hard constraint will no longer receive it from the worktree toggle. This is the point of the plan, but it is a real downstream behavioural shift for any agent relying on the old wording.
- **Skill export output changes.** `### Worktrees Per Plan` sections in generated `.claude/skills` and `.agents/skills` files lose the subagent half of `WORKTREES_PER_PLAN_DIRECTIVE`. Existing exported skill files on disk are not auto-regenerated; users must re-export to pick up the new wording.
- **Test semantics shift.** The coder feature-mode regression test (`agentPromptBuilder.test.ts:375`) currently asserts the presence of `Handle the subtasks yourself`; after the refactor that string no longer appears in the default path, so the assertion must be rewritten or it will fail.

**Dependencies & Conflicts**
- `buildGitPolicyBlock` (`:547-586`) is passed `worktreePerPlanActive: useWorktreesPerPlanEnabled || featureMode === true` on the coder path (`:1522`) — i.e. forced true in feature mode regardless of the toggle. It emits NO subagent language (the flag only selects the worktree-safe git guardrail variant), so it cannot re-introduce the conflation. Confirmed safe.
- The custom-agent path (`:1927`) sets `worktreePerPlanActive: addons?.useWorktreesPerPlan === true` — NOT forced true in feature mode, unlike the coder path. This is a pre-existing inconsistency between the two feature paths, unrelated to this plan, but worth noting: the two paths already disagree on git-block worktree handling. Out of scope to fix here.
- The non-feature `subagentPolicy` radio (`:1885-1898` in `buildCustomAgentPrompt`, and `SUBAGENT_POLICY_RADIO` in the UI) never interacted with the worktree toggle and is untouched. `src/test/agent-prompt-builder-subagents.test.js` covers that path and must stay green.
- The planner's hardcoded clause (`:862-867`) is deliberately bypassed and must remain untouched — it is not driven by the worktree toggle.

---

## Dependencies

- None. No prerequisite plans or sessions.

---

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the neutral ordering line is only preserved on 1 of 3 `buildFeatureSubagentClause` call paths in the original plan — the custom-agent feature path silently regresses; (2) the "no migration" call depends entirely on user-confirmed release history, and a wrong call silently rebinds saved `default` configs. Mitigations: extend §2 to patch the custom-agent path (coder path is already covered by `featureExecutionBlock`); re-confirm with the user that the pairing never shipped before dropping the compat shim. The core decoupling — `default` emits no subagent language, the radio owns subagents, the toggle owns worktrees — is sound and achieves the stated goal on all three call sites.

---

## Scope

### In scope

- `src/services/agentPromptBuilder.ts` — `buildFeatureSubagentClause`, `resolveFeatureOrchestrationDirective`, `WORKTREES_PER_PLAN_DIRECTIVE`.
- `src/services/AgentSkillExporter.ts` — the exported worktree section.
- Tooltip copy for `useWorktreesPerPlan` — 4 duplicated copies.
- Affected tests.

**No migration.** The repo rule is that shipped state must be migrated, but the Feature Subagent Policy / Agent-Managed Worktrees pairing has not been released — confirmed by the user. Nobody's saved config depends on the old bundled behaviour, so `featureSubagentPolicy: 'default'` changes meaning in place with no compat shim. Do not add one.

### Out of scope (flagged, not changed)

- **The planner's hardcoded clause** (`agentPromptBuilder.ts:862-867`). Planner feature dispatches bypass `buildFeatureSubagentClause` entirely and emit a fixed *"Process the subtask plan files yourself in a sensible order — do NOT create git worktrees or spawn subagents for this dispatch."* This is a deliberate role constant with a documented rationale (`:855-861`): planners restructure plan files, never ship product code, and the execution-coded verbs would mis-route them. It is not driven by the worktree toggle, so it is not part of this clash. Leave the text as-is.
- **The planner's Feature Subagent Policy radio is nonetheless shown and ignored** (`kanban.html:3165-3184`, rendered for the planner role; the levers are intentionally discarded at `:861`). Same *class* of defect as this plan — a control offered but not honoured — but a separate UI concern. Recorded in Follow-ups.
- The non-feature **Subagent Policy** radio (`subagentPolicy`, `:1885-1898`). Unaffected; it never interacted with the worktree toggle.

---

## Proposed Changes

### 1. Rewrite `buildFeatureSubagentClause` as a single composition path

`src/services/agentPromptBuilder.ts:811-840`. Delete the `policy === 'default'` early return (`:817-821`) so all four policies flow through one code path.

**Worktree clause** — worktrees only, no execution verbs:

```
worktreesEnabled
  ? `Use a dedicated git worktree for each subtask to prevent file conflicts (worktree-per-plan isolation). `
  : `Do NOT create git worktrees for this dispatch. `
```

The OFF string drops `; implement the subtasks directly` (fixes secondary contradiction 1). Keep the explicit negative — it is a real guardrail against an agent provisioning worktrees unprompted, and it pairs with `buildGitPolicyBlock`'s `worktreePerPlanActive` handling.

**Subagent clause** — driven solely by `policy`:

| policy | clause |
| --- | --- |
| `default` | `''` — emit nothing |
| `noSubagents` | unchanged from `:829` |
| `useSubagents` | unchanged from `:831` |
| `customSubagent` | unchanged from `:832-837`, including the blank-name fallback to the `useSubagents` text |

Return `${worktreeClause}${subagentClause}` as today. With the shipped defaults the whole clause collapses to the single sentence `Do NOT create git worktrees for this dispatch.`

Update the JSDoc at `:803-810`, which currently states the old contract ("ON → the agent self-provisions worktrees + dispatches subagents … OFF (default) → the agent implements the subtasks directly, no worktrees/subagents"). Replace with the orthogonal contract and a note that `default` is deliberately silent.

### 2. Preserve the lost ordering guidance neutrally — on ALL THREE call paths

> **Superseded:** Add the neutral ordering line back as fixed, role-neutral text in `resolveFeatureOrchestrationDirective` (`:869-872`) only, between the subagent/worktree part and the delivery-unit line.
> **Reason:** `buildFeatureSubagentClause` has THREE call sites, not one. The original step only patched `resolveFeatureOrchestrationDirective` (path 1, lead/reviewer/intern). The coder feature branch (`:1528`, path 2) bypasses it but is coincidentally covered by `featureExecutionBlock` (`:1505`, *"Execute each subtask plan in full before moving to the next"*). The custom-agent feature path (`buildCustomAgentPrompt:1878`, path 3) bypasses `resolveFeatureOrchestrationDirective` AND has no `featureExecutionBlock` — under the old Branch A it received *"Handle the subtasks yourself in a sensible order — …"* and after the refactor receives only `Do NOT create git worktrees for this dispatch.`, silently losing the ordering guidance with no replacement (its only other sequencing source is `BATCH_EXECUTION_RULES`, which is gated on `switchboardSafeguards` being on at `:1902-1904`). The original step's claim to "preserve the lost ordering guidance" was therefore unmet on path 3.
> **Replaced with:** Preserve the neutral ordering line on all three paths, with no doubling where sequencing already exists:
> - **Path 1 — `resolveFeatureOrchestrationDirective` (`:869-872`):** insert `Work through the subtasks in a sensible order.\n` between `subagentAndWorktreePart` and the `All subtasks are part of a single delivery unit` line, exactly as the original step proposed.
> - **Path 2 — coder feature branch (`:1528`):** do NOT add the line. `featureExecutionBlock` (`:1505`) already emits *"Execute each subtask plan in full before moving to the next; if a subtask hits an issue, report it clearly and continue with the remaining subtasks when safe."* — adding the neutral line would double up sequencing wording.
> - **Path 3 — `buildCustomAgentPrompt` (`:1878`/`:1907-1909`):** when `isFeature` is true, append `\n\nWork through the subtasks in a sensible order.` to `subagentBlock` (or emit it as a separate appended line right after the `subagentBlock` append at `:1907-1909`). This restores the ordering guidance the old Branch A provided, independent of the `switchboardSafeguards` toggle. It says nothing about *who* does the work, so it composes correctly with every policy.
>
> The planner branch (`:863-866`) already carries its own ordering wording (*"Process the subtask plan files yourself in a sensible order"*) — do not touch it.

The neutral line:

```
Work through the subtasks in a sensible order.
```

### 3. Reword `WORKTREES_PER_PLAN_DIRECTIVE`

`:793`. Strip the subagent half:

```
Where possible, process each plan as an isolated unit, creating a dedicated git worktree per plan
to prevent file conflicts between concurrent tasks.
```

Verify the two consumers still read correctly: `AgentSkillExporter.ts:317` (inside the `### Worktrees Per Plan` section) and the reference in the comment at `:1159`.

### 4. Confirm all three `buildFeatureSubagentClause` call sites inherit the fix

No signature change, so all three pick it up automatically — but each must be read to confirm the surrounding prose does not re-introduce subagent language:

- `:868` — `resolveFeatureOrchestrationDirective`, the built-in-role feature path.
- `:1528` — the coder feature branch, which bypasses `featureDirectiveBlock` and emits `featureSubagentBlock` directly alongside `featureExecutionBlock`.
- `:1878` — `buildCustomAgentPrompt`, the custom-agent feature path.

Also re-read `AgentSkillExporter.ts:291-320`: the `### Subagent Usage` section is driven by the non-feature `subagentPolicy` and should be left alone, but confirm the two adjacent sections no longer contradict each other once `WORKTREES_PER_PLAN_DIRECTIVE` changes.

### 5. Update the tooltip — 4 copies

Current text: *"Opt into agent-managed orchestration: the agent uses its native subagent/orchestration capabilities to process each subtask in an isolated git worktree, then reviews and merges. Off = the agent implements subtasks directly — no worktrees, no subagents."*

Replacement:

> Give each subtask its own isolated git worktree to prevent file conflicts. Off = subtasks are implemented in the main working tree. Whether the agent uses subagents is controlled separately by Feature Subagent Policy.

Apply at all four sites — `src/webview/sharedDefaults.js:142` (lead), `:163` (coder), `:210` (intern), and `src/webview/kanban.html:3627`. The kanban.html copy is a duplicated literal, not an import; it must be edited in place or it will drift.

### 6. Update tests

`src/services/__tests__/agentPromptBuilder.test.ts`:

- `:375` — asserts the coder feature-mode prompt contains `'Handle the subtasks yourself'`. That string no longer exists in any branch (`noSubagents` emits the distinct *"Handle **all** subtasks yourself"*). Rewrite to assert the new default-path output: the prompt contains `Do NOT create git worktrees for this dispatch.` and does **not** contain `subagent`.
- `:365` — asserts the planner prompt does *not* contain `'Handle the subtasks yourself'`. Still passes but becomes vacuous (the coder default path no longer emits it either, so the negative no longer distinguishes planner from coder). Re-point it at a string the planner branch actually distinguishes itself by, keeping the planner-vs-coder wording split under test.
- **Add an assertion that the custom-agent feature path (`buildCustomAgentPrompt`) emits the neutral ordering line** `Work through the subtasks in a sensible order.` in feature mode with `default` policy + worktrees off — this locks in the §2 path-3 fix and prevents the regression the original plan would have introduced.

Add new coverage for the decoupling — the matrix is the whole point of the change:

| worktrees | policy | expected |
| --- | --- | --- |
| OFF | `default` | worktree-negative sentence; **no** occurrence of `subagent` |
| ON | `default` | worktree-positive sentence; **no** occurrence of `subagent` |
| OFF | `useSubagents` | worktree-negative + subagent-positive, no contradiction (no `implement the subtasks directly`) |
| ON | `noSubagents` | worktree-positive + explicit ban |
| ON | `customSubagent` (named) | worktree-positive + the named-subagent authorisation |
| OFF | `customSubagent` (blank name) | worktree-negative + the generic subagent fallback |

Assert the same matrix through `buildCustomAgentPrompt` (`:1878`) so the custom-agent path cannot regress independently — it duplicated this logic before and is the likeliest place for drift.

Also check `src/test/agent-prompt-builder-subagents.test.js` — it covers the non-feature `subagentPolicy` path and should stay green untouched.

---

## Verification Plan

> **Superseded:** The original verification plan listed `npx tsc --noEmit`, running `agentPromptBuilder.test.ts`, and running `agent-prompt-builder-subagents.test.js` as automated gates.
> **Reason:** Per session directives, compilation and automated tests are skipped in this verification pass.
> **Replaced with:** Manual verification only (the automated gates remain recommended for the implementing agent to run on their own, but are not part of this plan's verification steps).

### Automated Tests
- Skipped per session directive (SKIP COMPILATION, SKIP TESTS). The implementing agent should run `npx tsc --noEmit` and the two test files (`src/services/__tests__/agentPromptBuilder.test.ts`, `src/test/agent-prompt-builder-subagents.test.js`) on their own before declaring the change done; they are not gates of this plan.

### Manual verification (in the installed VSIX, per repo rules — `dist/` is not the test surface)
1. Prompts tab → coder → leave Feature Subagent Policy on **Default** and Agent-Managed Worktrees **off**. Copy a feature dispatch prompt. Confirm it contains no occurrence of the word "subagent".
2. Same, worktrees **on**: worktree instruction present, still no "subagent".
3. Set the radio to **No Subagents**, worktrees **off**: the ban appears, and it comes from the radio.
4. Set the radio to **Yes (Use Subagents)**, worktrees **off**: subagent instruction present with no "implement the subtasks directly" contradiction preceding it.
5. Custom Subagent with a name, worktrees **on**: both clauses present and coherent.
6. **Custom-agent feature dispatch** (Agents tab → a custom agent, feature mode, default policy, worktrees off): confirm the prompt contains `Work through the subtasks in a sensible order.` and `Do NOT create git worktrees for this dispatch.`, and contains no "subagent". This verifies the §2 path-3 fix.
7. **Skill export check:** trigger a skill export and confirm the generated `### Worktrees Per Plan` section no longer mentions subagents, and that `### Subagent Usage` is unchanged.
8. Grep the repo for `no worktrees, no subagents` — should return only the historical plan file `.switchboard/plans/feature_plan_20260709112352_prompts-tab-features-accordion.md`, with no live source hits.

---

## Follow-ups (not in this plan)

- The planner role renders a Feature Subagent Policy radio (`kanban.html:3165-3184`) whose value is deliberately discarded at `agentPromptBuilder.ts:861`. Same class of defect — a control shown but not honoured. Hide or disable it for the planner role.
- The coder feature path (`:1522`) and custom-agent feature path (`:1927`) disagree on whether `worktreePerPlanActive` is forced true in feature mode for the git block. Pre-existing inconsistency; reconcile in a separate plan if it causes divergent git-guardrail behaviour.

## Completion Report

Decoupled the Agent-Managed Worktrees toggle (`useWorktreesPerPlan`) from subagent directives so subagent behavior is exclusively controlled by Feature Subagent Policy (`featureSubagentPolicy`). Updated `buildFeatureSubagentClause`, `resolveFeatureOrchestrationDirective`, `WORKTREES_PER_PLAN_DIRECTIVE`, `buildCustomAgentPrompt`, UI tooltips in `sharedDefaults.js` and `kanban.html`, and prompt builder test suites. Modified files: `src/services/agentPromptBuilder.ts`, `src/webview/sharedDefaults.js`, `src/webview/kanban.html`, and `src/services/__tests__/agentPromptBuilder.test.ts`. No issues encountered.

