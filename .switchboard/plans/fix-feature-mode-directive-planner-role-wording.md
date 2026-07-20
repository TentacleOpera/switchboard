# Fix: FEATURE MODE Directive Uses Execution Language for Planner Dispatches

## Goal

Make the `FEATURE MODE` orchestration directive role-aware, so a planner dispatched against a feature (improve-feature / improve-plan) gets planning-coded wording instead of the execution-coded "You are implementing the feature… Handle the subtasks yourself…" text that today contradicts the planner's actual job and mis-routes agents into writing product code when they were asked to restructure plan files.

### Problem & root-cause analysis

`resolveFeatureOrchestrationDirective` (`src/services/agentPromptBuilder.ts:758`) unconditionally emits:

> `FEATURE MODE: You are implementing the feature "<topic>" which consists of N subtask(s).`
> `Handle the subtasks yourself in a sensible order — do NOT create git worktrees or spawn subagents for this dispatch.`
> `All subtasks are part of a single delivery unit — do not treat them as independent tickets.`

The directive is role-agnostic by construction — the same string is appended to coder dispatches (where "implementing" is correct) and planner dispatches (where it is not).

The planner branch (`:1062`) prepends `Read ${workflowPath} and follow it step-by-step.`, where `workflowPath` resolves to `.agents/skills/improve-feature/SKILL.md` for feature dispatches (`:1065`) or `.agents/skills/improve-plan/SKILL.md` otherwise. Then at `:1139` it appends `featureDirectiveBlock` — the execution-coded text above.

So a feature-mode planner receives BOTH:
1. "Read improve-feature/SKILL.md and follow it step-by-step." (correct — the skill is about restructuring plan files, not shipping code)
2. "FEATURE MODE: You are implementing the feature… Handle the subtasks yourself… single delivery unit…" (wrong — reads as a mandate to write product code)

**Observed failure mode (this session):** a planner agent dispatched with this prompt read signal #2 as authoritative over #1, weighted "implementing" + "Handle the subtasks yourself" + "single delivery unit" as execution language, and wrote ~840 lines of product code (design.js canvas module, DesignPanelProvider.ts handlers, design.html tab, switchboard-site docs) instead of running the improve-feature workflow on the five subtask plan files. The agent's own summary flagged the misread: *"I weighted #2 over #1. Wrong call."*

Root cause: the directive was written for the coder/lead execution path and never adapted for the planner path. The planner branch reuses the coder's feature directive verbatim because `resolveFeatureOrchestrationDirective` does not take a `role` parameter and has no planner-specific wording branch.

**Where the trigger strings actually live (verified against live source):**
- The header line `FEATURE MODE: You are implementing the feature "<topic>"…` is emitted directly by `resolveFeatureOrchestrationDirective` at `:771`.
- The subtask clause `Handle the subtasks yourself in a sensible order — do NOT create git worktrees or spawn subagents for this dispatch. ` is emitted by `buildFeatureSubagentClause` at `:736` (default policy, `worktreesEnabled=false`), then concatenated by `resolveFeatureOrchestrationDirective` at `:770-772`. Other policy branches emit their own execution-coded variants: `:745` (noSubagents) → `…Handle all subtasks yourself. `; `:747` (useSubagents) → `Use your native subagent or orchestration capabilities to handle each subtask…`; `:751` (customSubagent) → `You are authorized to use the "<name>" subagent for this task…`.
- The standalone export `FEATURE_ORCHESTRATION_DIRECTIVE` (`:700-708`) is **unused at runtime** — repo-wide grep shows only the export line, doc comments, and plan files reference it. Zero runtime callers. (The live path is `resolveFeatureOrchestrationDirective` → `buildFeatureSubagentClause`.)

### Why this is a real bug, not a one-off confusion

- The improve-feature skill is unambiguous about its job: *"make the subtask **set** coherent: improve every subtask, detect inconsistencies between them, and then **restructure** — merge overlapping plans, delete superseded ones, rewrite contradictory ones, split oversized ones."* It is authorised to cut plan files; it is **not** authorised to (and does not) ship product code.
- The FEATURE MODE directive's "You are implementing the feature" / "Handle the subtasks yourself" / "single delivery unit" language directly contradicts that. An agent following the directive literally does the wrong thing; an agent following the skill ignores the directive. There is no reading where both are satisfied.
- The contradiction is deterministic — every feature-mode planner dispatch gets it, not just edge cases. The agent that hit it this session is a capable model; a less careful one would hit it more often.

## Metadata
**Tags:** backend, bugfix
**Complexity:** 3

## User Review Required
- None. Wording-only change; no persisted state, no config keys, no migration. Planner prompts change text; coder/lead/reviewer/tester prompts are unchanged.

## Complexity Audit
### Routine
- Adding a `role` parameter to `resolveFeatureOrchestrationDirective` (default `undefined` → current behaviour) and a `role === 'planner'` branch that emits planner-coded wording.
- Updating the one call site at `:1038` to pass `role` (already in scope inside `buildPrompt`).
- Adding a regression test asserting planner feature-mode prompts contain planning-coded verbs and NOT the execution-coded triggers; coder feature-mode prompts are unchanged.
- Deleting the dead `FEATURE_ORCHESTRATION_DIRECTIVE` export (`:700-708`) in the same change, or adding a `role` param for symmetry (deletion preferred — it is unused and diverges by construction).
### Complex / Risky
- **Wording must not over-swing.** The planner still needs the "single delivery unit / do not treat as independent tickets" framing — improve-feature's restructure step acts on the set as a whole, not plan-by-plan. Drop "implementing" and "Handle the subtasks yourself"; keep the unit-of-work framing.
- **The subtask clause lives in `buildFeatureSubagentClause`, not `resolveFeatureOrchestrationDirective`.** A role branch on the header alone leaves the named trigger string (`Handle the subtasks yourself`, `:736`) reaching planners via the default-policy path. The fix must bypass `buildFeatureSubagentClause` for `role === 'planner'` and emit a fixed planner-coded subtask clause inline — do NOT add a `role` param to `buildFeatureSubagentClause` itself (it is shared with the coder feature branch `:1393` and the custom-agent feature branch `:1743`; touching it risks those paths for no benefit, and planners don't use subagent-policy levers at all).
- **Do not change the coder/lead path.** The execution wording is correct for roles that ship code. The fix is additive (planner branch), not a rewrite of the base directive.

## Edge-Case & Dependency Audit
- **Call sites:** `resolveFeatureOrchestrationDirective` is called once in the main prompt builder (`:1038`) and exported for testability. `FEATURE_ORCHESTRATION_DIRECTIVE` (the standalone export at `:700`) is **confirmed unused at runtime** (repo-wide grep: only the export line, doc comments, and plan files reference it). Recommend deleting it in the same change; if kept, add a `role` param for symmetry. Do not leave the two diverging.
- **`buildFeatureSubagentClause` callers (verified):** `:770` (the path this fix owns — `resolveFeatureOrchestrationDirective`), `:1393` (coder feature branch), `:1743` (custom-agent feature branch). The fix bypasses the `:770` call for `role === 'planner'` only; `:1393` and `:1743` are untouched and keep current behaviour.
- **Custom-agent path:** `buildCustomAgentPrompt` (`:1625`) has its own feature wording assembly (the subject of `fix-custom-agent-feature-worktree-subagent-wording.md`). That plan migrates custom agents onto `buildFeatureSubagentClause`; this plan migrates the built-in planner onto a planner-coded feature directive. The two plans touch adjacent but non-overlapping code — verify ordering if both land together.
- **Tests:** `src/services/__tests__/agentPromptBuilder.test.ts` covers feature-mode prompt assembly (suites at `:255` and `:293`). **No existing test asserts the literal execution-coded strings** ("You are implementing the feature", "Handle the subtasks yourself", "FEATURE MODE") — confirmed via grep of `src/services/__tests__` (zero matches). The existing planner feature-mode tests (`:258`, `:294`, `:300`, `:305`, `:316`) assert workflow-path routing and double-labelling absence, not directive wording. No snapshot updates needed; only ADD a regression test.
- **No role-specific behaviour today:** the directive function signature is `(mode, featureTopic, subtaskCount, worktreesEnabled, _context, policy, customSubagentName)` — no `role`. The caller at `:1038` is inside `buildPrompt` where `role` is in scope, so passing it through is a one-line change.
- **Remote-mode interaction:** the remote-mode directive (`:1026`) is folded into the dispatch prefix, not the feature block. No interaction with this fix.
- **Subagent-policy levers for planners:** the board exposes `featureUseSubagentsEnabled` / `featureNoSubagentsEnabled` / `featureCustomSubagentName`, which the call site (`:1037`) maps to a `featureSubagentPolicy`. For `role === 'planner'` these are meaningless — improve-feature/improve-plan are single-agent plan-file workflows that never spawn subagents. The planner branch ignores them and emits one fixed planner-coded subtask clause.

## Dependencies
- None. Independent of `fix-custom-agent-feature-worktree-subagent-wording.md` (different code path, same feature-mode family).

## Adversarial Synthesis
Key risks: (1) over-swinging the planner wording so it loses the "treat the set as one unit" framing improve-feature needs — mitigated by keeping the "single delivery unit" line and only replacing the execution-coded verbs; (2) fixing only the header and leaving the `Handle the subtasks yourself` subtask clause (emitted by `buildFeatureSubagentClause` `:736`) still reaching planners — mitigated by bypassing `buildFeatureSubagentClause` for `role === 'planner'` and emitting a fixed planner-coded subtask clause inline; (3) accidentally changing the coder/custom-agent path — mitigated by gating the new wording on `role === 'planner'` inside `resolveFeatureOrchestrationDirective` only, leaving `buildFeatureSubagentClause` and its `:1393` / `:1743` callers untouched; (4) the dead `FEATURE_ORCHESTRATION_DIRECTIVE` export diverging — mitigated by deleting it (confirmed unused) in the same change.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` — make the feature directive role-aware

> **Superseded:** Replace "Handle the subtasks yourself in a sensible order" inside `resolveFeatureOrchestrationDirective` with "Handle the subtask plan files yourself in a sensible order" (or drop it).
> **Reason:** That string is NOT emitted by `resolveFeatureOrchestrationDirective` — it is emitted by `buildFeatureSubagentClause` at `:736` (default policy, `worktreesEnabled=false`) and concatenated at `:770-772`. A role branch on the header alone would leave the named mis-route trigger still reaching every planner dispatch via the default-policy path. The plan would pass its own success check ("header says planning") while the actual bug persists. Other policy branches (`:745` noSubagents → "Handle all subtasks yourself"; `:747` useSubagents → "Use your native subagent or orchestration capabilities to handle each subtask"; `:751` customSubagent) emit their own execution-coded variants that would also leak to planners.
> **Replaced with:** For `role === 'planner'`, bypass `buildFeatureSubagentClause` entirely inside `resolveFeatureOrchestrationDirective` and emit a fixed planner-coded subtask clause inline. Do NOT add a `role` parameter to `buildFeatureSubagentClause` itself — it is shared with the coder feature branch (`:1393`) and the custom-agent feature branch (`:1743`); touching it risks those paths for no benefit, and planners don't use subagent-policy levers at all (improve-feature/improve-plan never spawn subagents).

- **Add a `role` parameter** to `resolveFeatureOrchestrationDirective` (default `undefined` → preserves current behaviour for all existing callers). The caller at `:1038` already has `role` in scope.
- **For `role === 'planner'` only**, emit a planner-coded directive:
  - Header: `FEATURE MODE: You are planning the feature "<topic>" which consists of N subtask(s).` (verb "planning" matches improve-feature's job; "restructuring" is also acceptable — pick "planning" for symmetry with the role name.)
  - Subtask clause (fixed, ignores subagent policy): `Process the subtask plan files yourself in a sensible order — do NOT create git worktrees or spawn subagents for this dispatch. ` (keeps the "do NOT create worktrees/subagents" guardrail; swaps "Handle the subtasks" → "Process the subtask plan files" so the verb matches the planner's actual object — plan files, not product code.)
  - Keep: `All subtasks are part of a single delivery unit — do not treat them as independent tickets.` (improve-feature's restructure step acts on the set as a whole).
  - Keep: `Before starting, briefly tell the user how you are handling these subtasks (e.g. order, grouping, and any review/verification pass you plan to run).` (still useful — the planner should say "improving each subtask plan, then reconciling shared surfaces, then restructuring").
- **For non-planner roles (coder/lead/reviewer/tester/intern/custom-agent via the built-in path):** current behaviour unchanged — still call `buildFeatureSubagentClause(policy, customSubagentName, worktreesEnabled)` and emit the existing execution-coded header. The base directive stays as today.
- **Call site (`:1038`):** pass `role` as the new argument.
- **`FEATURE_ORCHESTRATION_DIRECTIVE` export (`:700-708`):** confirmed unused at runtime — delete it in the same change (preferred), or add a `role` param for symmetry. Do not leave the two diverging.

### `src/services/__tests__/agentPromptBuilder.test.ts` — add a planner-feature regression test

> **Superseded:** "Any test that asserts the literal 'You are implementing the feature' string for a planner-role feature dispatch is asserting the bug. Update to the new planner-coded wording."
> **Reason:** No such assertion exists. Grep of `src/services/__tests__` for "You are implementing the feature", "Handle the subtasks yourself", and "FEATURE MODE" returns zero matches. The existing planner feature-mode tests (`:258`, `:294`, `:300`, `:305`, `:316`) assert workflow-path routing and double-labelling absence, not directive wording. The plan invented a test-update burden that does not exist.
> **Replaced with:** ADD a regression test only — no snapshot updates needed. New test: `buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 })` contains "planning the feature" and "Process the subtask plan files" and does NOT contain "implementing the feature" or "Handle the subtasks yourself"; `buildKanbanBatchPrompt('coder', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 })` still contains "implementing the feature" and "Handle the subtasks yourself" (coder path unchanged). Add a second case: planner feature-mode with `featureNoSubagentsEnabled: true` still does NOT contain "Handle all subtasks yourself" (the noSubagents branch at `:745` is bypassed for planners).

## Verification Plan

### Automated Tests
- Skipped per session directive (SKIP TESTS, SKIP COMPILATION). The regression test proposed above is to be authored as a code change but not executed during this planning pass.

### Manual Verification
1. **Grep the generated prompt:** dispatch a planner against a feature with subtasks (default subagent policy); confirm the FEATURE MODE block contains "planning the feature" and "Process the subtask plan files yourself" and does NOT contain "implementing the feature" or "Handle the subtasks yourself".
2. **Grep the coder prompt (regression):** dispatch a coder against the same feature; confirm the FEATURE MODE block still contains "implementing the feature" and "Handle the subtasks yourself" — identical to today.
3. **NoSubagents policy regression:** dispatch a planner with `featureNoSubagentsEnabled: true`; confirm the prompt does NOT contain "Handle all subtasks yourself" (the `:745` noSubagents clause is bypassed for planners).
4. **Dead export check:** after deleting `FEATURE_ORCHESTRATION_DIRECTIVE`, grep the repo for any remaining reference — expect zero matches outside this plan file and the adjacent `fix-custom-agent-feature-worktree-subagent-wording.md` plan (which references it in prose only).
5. **Typecheck (manual, not run here):** `tsc --noEmit` should pass — the `role` parameter is already in scope at the call site and defaults to `undefined`, so no other caller needs updating. (Skipped per session directive; listed for the implementer to run.)

## Definition of Done
- A planner dispatched in feature mode receives a FEATURE MODE directive whose verbs match the improve-feature skill's job (restructure plan files), not the coder's job (ship product code). Both the header ("planning the feature") and the subtask clause ("Process the subtask plan files yourself") are planning-coded.
- A coder dispatched in feature mode receives the same execution-coded directive as today — no regression. The custom-agent feature path (`:1743`) is likewise unchanged.
- The contradiction that caused this session's mis-route ("Read improve-feature/SKILL.md and follow it step-by-step" + "You are implementing the feature… Handle the subtasks yourself") no longer appears in planner prompts — neither the header verb nor the subtask-clause verb.
- The dead `FEATURE_ORCHESTRATION_DIRECTIVE` export is deleted (or, if kept, carries a `role` param for symmetry).
- Regression test covers both branches (planner planning-coded; coder unchanged) plus the noSubagents-policy bypass case.

## Recommendation
Complexity 3 → **Send to Intern**.
