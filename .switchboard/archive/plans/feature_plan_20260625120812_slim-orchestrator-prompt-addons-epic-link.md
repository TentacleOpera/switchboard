# Slim the Epic Orchestrator Prompt to [Add-On Rules] + [Epic Doc Link]

## Goal

The epic orchestrator prompt that Switchboard dispatches is far too verbose, and it is built the wrong way. Today it apes the *other* batch roles (coder, lead, etc.): it enumerates every subtask plan file inline under a `PLANS TO PROCESS:` heading and stacks a fixed wall of directives (`AUTHORIZATION TO EXECUTE`, batch execution rules, `EPIC MODE`, `FOCUS DIRECTIVE`, `GIT POLICY`, subagent directive, "You are the Epic Orchestrator…" prose) regardless of how little the user wants.

The intended design — never finished — is different: the **orchestrator is a role configured from the kanban Prompts tab via selectable add-ons**, and the prompt it produces should collapse to essentially:

```
[selected add-on directive blocks] + [a link to the epic doc]
```

The subtasks should **not** be listed in the prompt at all. They already live in the epic doc (the auto-generated `## Subtasks` block). The prompt should just point the agent at the epic doc and let the agent read the subtask list from there. "Use ultracode" then becomes **one selectable add-on** among the others — so on a Claude Code host the user ticks the `ultracode` add-on and the dispatched prompt becomes something as terse as *"Read the epic at `<path>` and use ultracode."* On a non–Claude-Code host (Antigravity, etc.) the user simply does not select that add-on; host compatibility is handled entirely by add-on selection, with no host-detection code.

### Core problem & root cause

The orchestrator branch of `buildKanbanBatchPrompt` (`src/services/agentPromptBuilder.ts` L1162–1209) assembles the prompt from a fixed `promptParts` array:

```
[ "Please orchestrate the following epic.",
  executionDirective,                 // AUTHORIZATION TO EXECUTE  (L492)
  safeguardsBlock,                    // batchExecutionRules, gated by switchboardSafeguardsEnabled
  baseInstructions,                   // "You are the Epic Orchestrator…" prose (L1167-1171)
  suffixBlock,                        // [dispatchContextPrefix, FOCUS_DIRECTIVE, GIT_PROHIBITION_DIRECTIVE, antigravity, skip, subagent]
  "PLANS TO PROCESS:\n" + planList,   // <-- subtask enumeration
  suppressWalkthroughBlock ]
```

`planList` is produced by `buildPromptDispatchContext(plans)` (L477–478) and, in epic mode, is **prefixed** with `EPIC_ORCHESTRATION_DIRECTIVE(topic, count)` (the `EPIC MODE: …` paragraph, L320–325 / L485–490) and an optional `epicPromptTemplate`. The `plans` array passed in by `buildEpicOrchestrationPrompt` (`src/services/KanbanProvider.ts` L2985–3030) is `[epicPlan, ...subtaskPlans]` — so every subtask path is spelled out in the prompt. **This subtask enumeration is the root of the verbosity and the "functions too much like the other roles" problem.**

Root cause: when the orchestrator role was bolted on, it reused the generic batch-prompt scaffold (shared `planList` + directive blocks) instead of being given its own minimal "point at the epic doc" assembly. The add-on plumbing already exists and is generic — the orchestrator's add-ons are defined at `src/webview/sharedDefaults.js` L270–285 (`ROLE_ADDONS.orchestrator`) with defaults at L38 (`DEFAULT_ROLE_CONFIG.orchestrator`), and each add-on boolean is resolved into a `PromptBuilderOptions` flag (e.g. `switchboardSafeguardsEnabled`, `gitProhibitionEnabled`, `skipCompilation`, subagent policy) in `KanbanProvider.generateUnifiedPrompt`/option-resolution (`KanbanProvider.ts` ~L2860–2975) and consumed at `agentPromptBuilder.ts` L435–461. So the building blocks are in place; what is missing is (a) a terse orchestrator assembly that emits *only selected add-on blocks + the epic doc link*, (b) an `ultracode` add-on, and (c) a guarantee that the linked epic doc always contains the subtask list.

The epic doc already gets an auto-generated subtask block via `_regenerateEpicFile` (`KanbanProvider.ts` L8041–8068), which writes `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n…`. It is currently called on subtask membership changes (callers at L7422, L7560, L7574). The new prompt relies on that block being present, so the rule must guarantee it exists before dispatch (and backfill older epics).

## Metadata

- **Tags:** refactor, feature, ui, ux
- **Complexity:** 6/10 (raised from 5 after verification surfaced the missing `_getPromptsConfig` orchestrator wiring — see Complexity Audit)

## User Review Required

None. The two decisions that could have been forks are already made by the user:
1. The orchestrator prompt becomes `[selected add-on blocks] + [epic doc link]`; subtasks are **not** enumerated in the prompt.
2. `ultracode` is just one selectable add-on; multi-host compatibility is handled by add-on selection, not host detection.

## Complexity Audit

### Routine
- Add an `ultracode` add-on entry to `ROLE_ADDONS.orchestrator` (`sharedDefaults.js` L270–285) and a default to `DEFAULT_ROLE_CONFIG.orchestrator` (L38, default `false`).
- Add an `ULTRACODE_DIRECTIVE` constant and a `ultracodeEnabled` option to `PromptBuilderOptions` / the option defaults (`agentPromptBuilder.ts` L131–196, L435–446).
- Map the new add-on to its option in the orchestrator option-resolution path (`KanbanProvider.ts` ~L2860–2975), mirroring `switchboardSafeguardsEnabled` (L2868).

### Complex / Risky
- **`_getPromptsConfig` does NOT wire the orchestrator role at all — CRITICAL, discovered during verification.** `_getPromptsConfig` (`KanbanProvider.ts` L3050–3264) loads `plannerConfig … gathererConfig` but **never loads an `orchestratorConfig`**, and **none** of the `*ByRole` maps (`switchboardSafeguardsByRole`, `gitProhibitionByRole`, `skipCompilationByRole`, `skipTestsByRole`, `cavemanOutputByRole`, `clearAntigravityContextByRole`, `useSubagentsByRole`, `noSubagentsByRole`, `customSubagentNameByRole`, `useWorktreesPerPlanByRole`, `suppressWalkthroughByRole`) contain an `orchestrator:` key. Consequence: **every orchestrator add-on toggle in the Prompts tab is dead today** — option-resolution at L2858–2880 reads `promptsConfig.<x>ByRole?.['orchestrator']` which is `undefined`, so it falls through to the hardcoded generic `?? default` (e.g. `skipCompilation ?? false`, `cavemanOutput ?? false`), ignoring the user's saved orchestrator config. The entire premise of this plan ("toggle add-ons → terse prompt reflects them") and Manual Verification #3 depend on closing this gap. **It is in scope HERE**: the dependency plan `110625` is pure `kanban.html` UI work and does not touch `_getPromptsConfig` (verified). Without this, the new `ultracode` add-on resolves to `false` forever.
- **Rewriting the orchestrator branch (`agentPromptBuilder.ts` L1162–1209) — CRITICAL.** Replace the fixed `promptParts` (and especially the `PLANS TO PROCESS:\n${planList}` entry) with: the selected add-on directive blocks (safeguards/git/skip/subagent/antigravity/suppress-walkthrough/**ultracode**, each already gated by its option) **plus an epic-doc-link line**. The subtask enumeration and `EPIC_ORCHESTRATION_DIRECTIVE`/`PLANS TO PROCESS` must be dropped **for the orchestrator role only**. The orchestrator's editable prompt override (`resolveBaseInstructions('orchestrator', …)`, applied as the base) and the legacy `epic_prompt_template` fallback must continue to work.
- **Epic-doc link source.** `buildEpicOrchestrationPrompt` (`KanbanProvider.ts` L2985–3030) must pass the epic doc's path/link to the prompt builder (e.g. a new `epicDocPath`/`epicDocLink` option) instead of the subtask plan list. The epic plan's `planFile` (already resolved at L3001) is the link source.
- **Guaranteeing the subtask block — CRITICAL for correctness.** Because the prompt now only links the epic doc, that doc MUST contain the subtask list at dispatch time. `_regenerateEpicFile` is only invoked on subtask-membership changes (L7422/7560/7574), not necessarily at epic creation or before an Orchestrate dispatch. Add a guaranteed regeneration: call `_regenerateEpicFile` at epic creation AND defensively at the top of `buildEpicOrchestrationPrompt` so the linked doc is always current.

## Edge-Case & Dependency Audit

**Migration (~4,000 installs on older versions):**
- **Existing epics without the SUBTASKS block.** Epics created before this change may lack the `<!-- BEGIN SUBTASKS … -->` block. The defensive `_regenerateEpicFile` call inside `buildEpicOrchestrationPrompt` backfills it on first orchestrate — `_regenerateEpicFile` already handles the "marker absent" case by appending the block (L8063–8064), so this is a safe no-op when the block is current and a backfill when it is missing.
- **`roleConfig` without the new `ultracode` add-on key.** Existing saved orchestrator role configs won't have `ultracode`. Resolution must default a missing add-on to `false` (absent → off) and must **preserve unknown/legacy add-on keys** rather than rewriting the config object. Do not assume a prior migration ran.
- **Legacy `epic_prompt_template` DB key + orchestrator prompt override.** Still read as today (`KanbanProvider.ts` L2936–2939, L2951–2967). The terse assembly must keep applying the orchestrator prompt override as its base and the legacy template fallback for non-orchestrator step-mode dispatch.

**Scope guard — do NOT change step mode.** When an epic is dragged onto a *non-orchestrator* column (planner/lead/etc., `role !== 'orchestrator'`), the existing `epicPromptTemplate` prepend + `PLANS TO PROCESS` path (L485–490, L2957–2967) must be left intact. This plan only restructures the **orchestrator** role branch. Verify the other roles' branches and `planList` usage are untouched.

**Tests — corrected after reading them. NONE of the three currently break; the real work is NEW coverage:**
- `src/test/minimal-prompt.test.js` — verified: builds the **planner** prompt only (asserts `FOCUS DIRECTIVE`/`GIT POLICY`/`PLANS TO PROCESS` against a planner build, L76–77 and L250–256). It never builds the orchestrator role, so the orchestrator-branch rewrite cannot break it. **No edit required.**
- `src/test/agent-prompt-builder-subagents.test.js` (and the stale `.tmp` copy) — verified: every role list it iterates is `['planner','reviewer','tester','lead','coder']` (plus `intern`/`analyst` at L125). Orchestrator is **absent from all of them** (L35/45/61/107/125), so its `AUTHORIZATION TO EXECUTE`/`GIT POLICY`/subagent assertions are unaffected. **No edit required.**
- `src/test/pipeline-orchestrator-regression.test.js` — verified: asserts on `PipelineOrchestrator.ts` source (the autoban **pipeline** orchestrator), NOT the epic-orchestrator *role* prompt. Different subsystem entirely. **No edit required.**
- **NEW test (the actual deliverable):** add an orchestrator-role case (in `minimal-prompt.test.js` or a new `orchestrator-prompt.test.js`) asserting that with only the `ultracode` add-on enabled, the prompt ≈ "Read the epic … `<link>` … use ultracode", contains **no** `PLANS TO PROCESS`, **no** per-subtask paths, and **no** `EPIC MODE`/`AUTHORIZATION`/`FOCUS DIRECTIVE`/`GIT POLICY` walls; plus a second case asserting each toggled add-on (safeguards/git/skip) adds exactly its block and toggling off removes it.

**Intended default-behavior change from wiring the orchestrator role.** Once `_getPromptsConfig` reads `orchestratorConfig`, the orchestrator will finally honor its `sharedDefaults.js` L38 defaults (`skipCompilation:true`, `skipTests:true`, `cavemanOutput:true`, `subagentPolicy:'useSubagents'`) instead of the accidental generic fallbacks it gets today (skip=false, caveman=false, no-subagents). This is the **correct/intended** behavior — it matches the checkboxes users already see in the Prompts tab — but it IS a dispatched-behavior change on first run after upgrade. Each new `orchestrator:` `*ByRole` default MUST mirror the `sharedDefaults.js` L38 value, not the other roles' values.

**Security / side effects:** None new. The epic doc link is a workspace-relative path already known to the provider; no new file reads are introduced beyond the existing `_regenerateEpicFile` write.

## Dependencies

- **Depends on / coordinates with `feature_plan_20260625110625_orchestrator-in-kanban-agents-and-prompts.md`** — that plan adds the orchestrator row to the kanban Agents tab and the `<option value="orchestrator">` to the Prompts-tab role selector, which is what makes the orchestrator's add-ons (including the new `ultracode` one) selectable in the UI. The `ultracode` add-on added here will only surface once that plan lands. Implement that plan first, or land them together; this plan adds the add-on *definition* and *prompt wiring* but does not re-do the UI row/option (avoid duplicating its kanban.html edits).
- **Context:** `feature_plan_20260625081837_epics-as-orchestration-onramp.md` (the broader onramp this completes).

## Cross-Plan Coordination (this session)

- **The rewritten orchestrator branch must still carry the shared PRD block (↔ `feature_plan_20260625143400_per-project-prd-and-projects-tab.md`).** That plan injects the active project's PRD into the *shared* prompt scaffold that applies to every role. The orchestrator-branch rewrite here MUST NOT return a self-contained string that bypasses that shared injection — when project-context is on, the orchestrator prompt carries the PRD. "Terse" means dropping the subtask enumeration / `PLANS TO PROCESS` / directive walls, **not** dropping the PRD. (A PRD *link* is preferable to full PRD content in the orchestrator prompt, to keep it terse.) **Boundary:** Switchboard only makes the PRD *available* to the orchestrator; whether the orchestrator propagates it to its own subagents is the agent's decision — not a Switchboard guarantee. Optional nudge (not a guarantee): one line in the orchestrator base instruction — *"respect these project requirements and pass them to any subagents you spawn."*
- **Co-located option-resolution / `PromptBuilderOptions` edits (↔ `…143400`).** Both plans add option keys (`ultracodeEnabled` here; `prdEnabled`/`prdLink`/`prdContent` there) in `KanbanProvider.ts` ~L2860–2896 and to `PromptBuilderOptions`. Purely additive — coordinate to avoid merge friction.
- **Shared Orchestrate-button handler (↔ `feature_plan_20260625141208_epic-only-orchestrator-board-column.md`).** This plan builds + dispatches the terse orchestrator prompt; the column plan teleports the epic into `ORCHESTRATING` after dispatch. One handler, two plans' concerns — implement together (build prompt → dispatch → move).

## Adversarial Synthesis

Key risks: (1) the plan's premise that orchestrator add-on resolution "already exists" is false — `_getPromptsConfig` never wires the orchestrator role, so without adding `orchestratorConfig` + `orchestrator:` keys to the `*ByRole` maps, every add-on toggle (including the new `ultracode`) is a no-op; (2) the three named tests don't exercise the orchestrator role, so the work is *new* coverage, not edits; (3) wiring the role flips its effective defaults to the intended `sharedDefaults.js` L38 values (a benign but real first-run behavior change). Mitigations: promote the `_getPromptsConfig` wiring to a CRITICAL Proposed Change with per-key defaults mirroring L38; keep the shared-scaffold PRD injection seam intact (the terse join replaces only the subtask/directive-wall portion, never the shared injection); rely on the defensive `_regenerateEpicFile` call in `buildEpicOrchestrationPrompt` as the single guarantee that the linked epic doc carries the `## Subtasks` block at dispatch (it backfills missing markers, so it is safe for pre-change epics and promote-to-epic alike).

## Proposed Changes

### File 1 — `src/webview/sharedDefaults.js`
1. Add an `ultracode` add-on to `ROLE_ADDONS.orchestrator` (after the existing entries, ~L283):
   ```js
   { id: 'ultracode', label: 'Ultracode', tooltip: 'Append the "use ultracode" directive so a Claude Code host orchestrates the epic with multi-agent workflows', default: false },
   ```
2. Add `ultracode: false` to `DEFAULT_ROLE_CONFIG.orchestrator.addons` (L38).

### File 2 — `src/services/agentPromptBuilder.ts`
3. Add an exported directive constant near the other directives:
   ```ts
   export const ULTRACODE_DIRECTIVE = `use ultracode`;
   ```
   (Exact wording to confirm with the user; keep it minimal — the keyword is what matters.)
4. Add `ultracodeEnabled?: boolean` to `PromptBuilderOptions` (~L131–153) and `const ultracodeEnabled = options?.ultracodeEnabled ?? false;` (~L446).
5. Add an `epicDocLink?: string` option (or reuse an existing epic field) carrying the epic doc path.
6. **Rewrite the `role === 'orchestrator'` branch (L1162–1209):** build the prompt as the join of (a) the orchestrator base/override (kept minimal), (b) the *selected* add-on directive blocks already computed above (`safeguardsBlock`/`gitBlock`/`skipBlock`/`subagentBlock`/`antigravityBlock`/`suppressWalkthroughBlock`/**`ultracode` block**), and (c) an epic-doc-link line such as `Read the epic and its subtasks at: ${epicDocLink}`. **Remove** the `PLANS TO PROCESS:\n${planList}` part and the `EPIC_ORCHESTRATION_DIRECTIVE`/subtask enumeration for this role. Leave `EPIC_ORCHESTRATION_DIRECTIVE` and the epic-mode `planList` prefixing (L485–490) intact for non-orchestrator step mode.

### File 3 — `src/services/KanbanProvider.ts`
7. **Wire the orchestrator role into `_getPromptsConfig` (L3050–3264) — CRITICAL prerequisite (see Complexity Audit).**
   - (a) Load `const orchestratorConfig: any = this._getRoleConfig('orchestrator');` alongside the other role configs (L3054–3066).
   - (b) Add an `orchestrator:` key to every `*ByRole` map the orchestrator branch consumes, each defaulting to the `sharedDefaults.js` **L38** value (NOT the other roles' defaults):
     - `switchboardSafeguardsByRole.orchestrator: orchestratorConfig?.addons?.switchboardSafeguards ?? true`
     - `gitProhibitionByRole.orchestrator: orchestratorConfig?.addons?.gitProhibition ?? true`
     - `skipCompilationByRole.orchestrator: orchestratorConfig?.addons?.skipCompilation ?? true`
     - `skipTestsByRole.orchestrator: orchestratorConfig?.addons?.skipTests ?? true`
     - `cavemanOutputByRole.orchestrator: orchestratorConfig?.addons?.cavemanOutput ?? true`
     - `clearAntigravityContextByRole.orchestrator: orchestratorConfig?.addons?.clearAntigravityContext ?? false`
     - `useSubagentsByRole.orchestrator` / `noSubagentsByRole.orchestrator` / `customSubagentNameByRole.orchestrator` — mirror the existing `subagentPolicy === 'useSubagents' | 'noSubagents' | 'customSubagent'` pattern (orchestrator default policy is `'useSubagents'`, so `useSubagents` resolves `true` by default).
     - `useWorktreesPerPlanByRole.orchestrator: orchestratorConfig?.addons?.useWorktreesPerPlan === true`
     - `suppressWalkthroughByRole.orchestrator: orchestratorConfig?.addons?.suppressWalkthrough ?? false`
   - (c) Add a new `ultracodeByRole: { orchestrator: orchestratorConfig?.addons?.ultracode ?? false }` map.
   - Reading `orchestratorConfig.addons` is non-destructive (`_getRoleConfig` returns the saved object as-is); do not rewrite it — unknown/legacy add-on keys are preserved automatically.
8. In `resolvedOptions` (L2858–2880), add `ultracodeEnabled: promptsConfig.ultracodeByRole?.[role] ?? false`. Once step 7 lands, the existing generic lines (`skipCompilation`, `cavemanOutputEnabled`, `switchboardSafeguardsEnabled`, etc.) resolve correctly for the orchestrator too — no per-line orchestrator special-case needed.
9. In `buildEpicOrchestrationPrompt` (L2985–3030): (a) call `await this._regenerateEpicFile(workspaceRoot, epic.planId, db)` defensively before assembling, so the linked doc always has the subtask block; (b) pass `epicDocLink` into the options — prefer the workspace-relative `epic.planFile` (more portable in the prompt than the absolute path resolved at L3001). The subtask `plans.push(...)` loop may remain for `subtaskCount`/preview metadata but those plans must no longer be enumerated in the orchestrator prompt body.
10. Epic-creation coverage (verified): `createEpic` already calls `_regenerateEpicFile` (L7560) and `addSubtaskToEpic` does too (L7422); **`promoteToEpic` (L7426–7468) does NOT** — a freshly promoted single-plan epic carries no `## Subtasks` block until a subtask is added. The defensive call in step 9(a) is the real guarantee and already covers promote-to-epic, so no separate creation-path edit is strictly required; optionally add a `_regenerateEpicFile` call at the end of `promoteToEpic` as cheap belt-and-suspenders.

### File 4 — `src/webview/kanban.html`
11. No new add-on-row work beyond the dependency plan; the `ultracode` checkbox renders automatically from `ROLE_ADDONS.orchestrator` once `feature_plan_20260625110625` has added the orchestrator role to the Prompts tab. (If that plan has not landed, this checkbox will not appear — call that out at implementation time.)

### File 5 — tests
12. **Do NOT edit** `minimal-prompt.test.js`, `agent-prompt-builder-subagents.test.js`, or `pipeline-orchestrator-regression.test.js` for this change — none of them exercise the orchestrator role (verified; see Edge-Case audit). **Add** a new orchestrator-role test: with only the `ultracode` add-on enabled, the prompt ≈ "Read the epic … `<link>` … use ultracode", contains no subtask paths and none of the `PLANS TO PROCESS`/`EPIC MODE`/`AUTHORIZATION`/`FOCUS DIRECTIVE`/`GIT POLICY` walls; plus a per-add-on on/off assertion. (Run separately by the user per session norm.)

## Verification Plan

### Automated Tests
- Add a new orchestrator-role assertion (the three existing test files need no edits — verified): orchestrator prompt with only `ultracode` enabled ≈ "Read the epic … `<link>` … use ultracode", contains no subtask file paths and none of the directive walls; plus a per-add-on on/off assertion proving the `_getPromptsConfig` wiring takes effect. (Run separately by the user per session norm.)

### Manual Verification
1. Kanban Prompts tab → select **Orchestrator** → the add-on list shows **Ultracode** (unchecked by default) alongside the existing add-ons.
2. With **all add-ons off except Ultracode**, the prompt preview is terse: a minimal "read this epic … use ultracode" + the epic doc link, with **no** `PLANS TO PROCESS`, no per-subtask paths, no `EPIC MODE`/`AUTHORIZATION`/`FOCUS`/`GIT` walls.
3. Toggle Switchboard Safeguards / Git Prohibition / Skip blocks on → each adds exactly its directive block; toggling off removes it. Preview == dispatch (byte-identical). **(This now actually works — it relies on the File 3 step 7 `_getPromptsConfig` wiring; before that fix these toggles were dead for the orchestrator role.)**
4. Orchestrate an epic whose doc was created **before** this change (no SUBTASKS block) → the doc is backfilled with the `## Subtasks` block and the dispatched prompt links it.
5. Orchestrate an epic → open the linked epic doc → the subtask list is present and current.
6. Drag an epic onto a non-orchestrator column (step mode) → the old `PLANS TO PROCESS` + template behavior is unchanged (regression guard).
7. Existing saved orchestrator role config (no `ultracode` key) → loads with Ultracode unchecked; unknown/legacy add-on keys preserved on save.

## Recommendation

Complexity 6/10 → **Send to Coder**. Well-scoped, but now with **three** careful spots, not two: (1) the `_getPromptsConfig` orchestrator wiring — the newly discovered CRITICAL prerequisite without which every add-on toggle is dead; (2) the orchestrator-branch rewrite to the terse `[add-on blocks] + [epic-doc link]` form (preserving the shared PRD-injection seam); and (3) the "epic doc must always carry subtasks" guarantee via the defensive `_regenerateEpicFile` call. The migration/backfill, the intended default-behavior change, and the step-mode scope guard must not be skipped.

---

## Reviewer Pass — 2026-06-26

Adversarial in-place review of the as-implemented code against this plan. Verdict: **implementation is high-fidelity on every hard part** — the `_getPromptsConfig` orchestrator wiring (the actual CRITICAL of this plan) is complete with every `*ByRole` map carrying an `orchestrator:` key whose default mirrors `sharedDefaults.js:38`; the `PLANS TO PROCESS` / `EPIC_ORCHESTRATION_DIRECTIVE` subtask enumeration is genuinely gone from the orchestrator branch (the branch never references `planList`); the defensive `_regenerateEpicFile` and workspace-relative `epicDocLink` are in place; the shared PRD-injection seam survives via `dispatchContextPrefix` in the orchestrator `suffixBlock`. Two material gaps were found and fixed.

### Findings by severity

- **CRITICAL — `src/services/agentPromptBuilder.ts:1241` (pre-fix):** the orchestrator branch emitted `executionDirective` (the `AUTHORIZATION TO EXECUTE` wall) **unconditionally**, violating the Goal (which names `AUTHORIZATION TO EXECUTE` as the #1 fixed wall to remove), Manual Verification #2 ("all add-ons off except Ultracode → **no** `AUTHORIZATION` wall"), and the Proposed-Changes step-6 join (`base + [selected add-on blocks] + epic-doc-link` — `executionDirective` is in none of the three). **FIXED:** gated behind `switchboardSafeguardsEnabled` (`executionBlock = switchboardSafeguardsEnabled ? executionDirective : ''`), mirroring how `FOCUS_DIRECTIVE` — another Verification-#2 wall — is already gated. Terse case (safeguards off) → no AUTHORIZATION; default config (safeguards on) → execute-mode guard retained. Least-risky behavior change; execute-don't-replan intent also still lives in the orchestrator base instruction.
- **MAJOR — `src/test/orchestrator-prompt.test.js:24-29` (pre-fix):** the new deliverable test omitted the `AUTHORIZATION` and `EPIC MODE` absence assertions that the plan's test spec (Edge-Case audit L72 + File 5 step 12) explicitly requires — which is exactly why the CRITICAL above went undetected. **FIXED:** added `!includes('AUTHORIZATION TO EXECUTE')` and `!includes('EPIC MODE')` to the terse case, plus an on/off `AUTHORIZATION TO EXECUTE` pair to `testOrchestratorAddonsToggle` to lock the gating in both directions.
- **NIT (deferred):** double framing — `Please orchestrate the following epic.` (L1240) immediately precedes the base "You are the Epic Orchestrator." Harmless; left as-is.
- **NIT (deferred):** in a *multi-repo* epic (subtasks with `repoScope`), `buildPromptDispatchContext` emits a `MULTI-REPO BATCH:` block listing subtask *topics* (not plan-file paths) through `dispatchContextPrefix`. This is the shared scaffold the plan told us to preserve; single-repo epics (the common case) emit nothing. Left as-is.

### Fixes applied (files changed)
- `src/services/agentPromptBuilder.ts` — orchestrator branch: gated `executionDirective` behind `switchboardSafeguardsEnabled` via new `executionBlock`.
- `src/test/orchestrator-prompt.test.js` — added `AUTHORIZATION`/`EPIC MODE` absence assertions (terse case) and an `AUTHORIZATION` on/off pair (toggle case).

### Validation
- Per session directives: **compilation and automated tests were NOT run** (user runs the suite separately; the test imports `../../out/services/agentPromptBuilder`, so `out/` must be built first). Edits verified by inspection: `executionBlock` is a single guarded const consumed once in `promptParts`; `switchboardSafeguardsEnabled` and `executionDirective` are both already in scope at the edit site.
- Confirmed by reading: `_getPromptsConfig` orchestrator defaults match `sharedDefaults.js:38` for every key (skip*=true, caveman=true, safeguards/git=true, antigravity/worktrees/suppress=false, subagentPolicy=useSubagents, ultracode=false); `resolvedOptions` reads the maps generically by `[role]` (L2938-2961) so the orchestrator now resolves correctly; `buildEpicOrchestrationPrompt` calls `_regenerateEpicFile` defensively before assembling (L3105) and `promoteToEpic` adds the belt-and-suspenders call (L7747).

### Remaining risks
- **Behavior of the gating choice:** with the orchestrator's default config (safeguards on), the dispatched prompt still carries `AUTHORIZATION TO EXECUTE` — intended (default-on execute guard). Only the deliberately-terse "everything off except ultracode" config strips it. If the user instead wants AUTHORIZATION *always* absent for the orchestrator regardless of safeguards, that is a one-line change (delete `executionBlock` from `promptParts`) — flagged, not taken, because gating is the lower-risk reading of Verification #2 + #3.
- **Unrun tests:** the new assertions are not executed in this pass; they should pass given the fix, but the user's separate test run is the confirmation.
- **Multi-repo epic topic exposure** (NIT above) persists by design.
