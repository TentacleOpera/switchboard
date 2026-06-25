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

- **Tags:** `prompt-builder`, `orchestrator`, `epics`, `add-ons`, `kanban`, `ux`
- **Complexity:** 5/10

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
- **Rewriting the orchestrator branch (`agentPromptBuilder.ts` L1162–1209) — CRITICAL.** Replace the fixed `promptParts` (and especially the `PLANS TO PROCESS:\n${planList}` entry) with: the selected add-on directive blocks (safeguards/git/skip/subagent/antigravity/suppress-walkthrough/**ultracode**, each already gated by its option) **plus an epic-doc-link line**. The subtask enumeration and `EPIC_ORCHESTRATION_DIRECTIVE`/`PLANS TO PROCESS` must be dropped **for the orchestrator role only**. The orchestrator's editable prompt override (`resolveBaseInstructions('orchestrator', …)`, applied as the base) and the legacy `epic_prompt_template` fallback must continue to work.
- **Epic-doc link source.** `buildEpicOrchestrationPrompt` (`KanbanProvider.ts` L2985–3030) must pass the epic doc's path/link to the prompt builder (e.g. a new `epicDocPath`/`epicDocLink` option) instead of the subtask plan list. The epic plan's `planFile` (already resolved at L3001) is the link source.
- **Guaranteeing the subtask block — CRITICAL for correctness.** Because the prompt now only links the epic doc, that doc MUST contain the subtask list at dispatch time. `_regenerateEpicFile` is only invoked on subtask-membership changes (L7422/7560/7574), not necessarily at epic creation or before an Orchestrate dispatch. Add a guaranteed regeneration: call `_regenerateEpicFile` at epic creation AND defensively at the top of `buildEpicOrchestrationPrompt` so the linked doc is always current.

## Edge-Case & Dependency Audit

**Migration (~4,000 installs on older versions):**
- **Existing epics without the SUBTASKS block.** Epics created before this change may lack the `<!-- BEGIN SUBTASKS … -->` block. The defensive `_regenerateEpicFile` call inside `buildEpicOrchestrationPrompt` backfills it on first orchestrate — `_regenerateEpicFile` already handles the "marker absent" case by appending the block (L8063–8064), so this is a safe no-op when the block is current and a backfill when it is missing.
- **`roleConfig` without the new `ultracode` add-on key.** Existing saved orchestrator role configs won't have `ultracode`. Resolution must default a missing add-on to `false` (absent → off) and must **preserve unknown/legacy add-on keys** rather than rewriting the config object. Do not assume a prior migration ran.
- **Legacy `epic_prompt_template` DB key + orchestrator prompt override.** Still read as today (`KanbanProvider.ts` L2936–2939, L2951–2967). The terse assembly must keep applying the orchestrator prompt override as its base and the legacy template fallback for non-orchestrator step-mode dispatch.

**Scope guard — do NOT change step mode.** When an epic is dragged onto a *non-orchestrator* column (planner/lead/etc., `role !== 'orchestrator'`), the existing `epicPromptTemplate` prepend + `PLANS TO PROCESS` path (L485–490, L2957–2967) must be left intact. This plan only restructures the **orchestrator** role branch. Verify the other roles' branches and `planList` usage are untouched.

**Tests that assert on the removed strings (must be updated):**
- `src/test/minimal-prompt.test.js` — asserts presence/absence of `FOCUS DIRECTIVE`, `GIT POLICY`, `FOCUS DIRECTIVE` for various roles.
- `src/test/agent-prompt-builder-subagents.test.js` (and the stale `.tmp` copy) — asserts `AUTHORIZATION TO EXECUTE` / `GIT POLICY` per role, subagent directives.
- `src/test/pipeline-orchestrator-regression.test.js` — orchestrator pipeline assertions.
Update these to reflect the new orchestrator assembly (add-on blocks + epic-doc link, no `PLANS TO PROCESS`). Add a new assertion: with only the `ultracode` add-on enabled, the orchestrator prompt is approximately "read the epic at `<link>` and use ultracode" and contains **no** subtask paths.

**Security / side effects:** None new. The epic doc link is a workspace-relative path already known to the provider; no new file reads are introduced beyond the existing `_regenerateEpicFile` write.

## Dependencies

- **Depends on / coordinates with `feature_plan_20260625110625_orchestrator-in-kanban-agents-and-prompts.md`** — that plan adds the orchestrator row to the kanban Agents tab and the `<option value="orchestrator">` to the Prompts-tab role selector, which is what makes the orchestrator's add-ons (including the new `ultracode` one) selectable in the UI. The `ultracode` add-on added here will only surface once that plan lands. Implement that plan first, or land them together; this plan adds the add-on *definition* and *prompt wiring* but does not re-do the UI row/option (avoid duplicating its kanban.html edits).
- **Context:** `feature_plan_20260625081837_epics-as-orchestration-onramp.md` (the broader onramp this completes).

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
7. In the orchestrator option-resolution path (~L2860–2975), map the new add-on: `ultracodeEnabled: <orchestrator addons>.ultracode ?? false`, mirroring `switchboardSafeguardsEnabled` (L2868). Preserve unknown add-on keys.
8. In `buildEpicOrchestrationPrompt` (L2985–3030): (a) call `await this._regenerateEpicFile(workspaceRoot, epic.planId, db)` defensively before assembling, so the linked doc always has the subtask block; (b) pass `epicDocLink` (the resolved `epic.planFile` path, L3001) into the options. The subtask `plans.push(...)` loop may remain for `subtaskCount`/preview metadata but those plans must no longer be enumerated in the orchestrator prompt body.
9. Ensure `_regenerateEpicFile` is also invoked at **epic creation** (verify the creation path calls it; if not, add the call) so the subtask block exists from the start.

### File 4 — `src/webview/kanban.html`
10. No new add-on-row work beyond the dependency plan; the `ultracode` checkbox renders automatically from `ROLE_ADDONS.orchestrator` once `feature_plan_20260625110625` has added the orchestrator role to the Prompts tab. (If that plan has not landed, this checkbox will not appear — call that out at implementation time.)

### File 5 — tests
11. Update `minimal-prompt.test.js`, `agent-prompt-builder-subagents.test.js`, and `pipeline-orchestrator-regression.test.js` for the new orchestrator assembly; add the "ultracode-only ⇒ terse, no subtask paths" assertion.

## Verification Plan

### Automated Tests
- Update the three test files above; add an assertion that the orchestrator prompt with only `ultracode` enabled ≈ "Read the epic … `<link>` … use ultracode" and contains no subtask file paths. (Run separately by the user per session norm.)

### Manual Verification
1. Kanban Prompts tab → select **Orchestrator** → the add-on list shows **Ultracode** (unchecked by default) alongside the existing add-ons.
2. With **all add-ons off except Ultracode**, the prompt preview is terse: a minimal "read this epic … use ultracode" + the epic doc link, with **no** `PLANS TO PROCESS`, no per-subtask paths, no `EPIC MODE`/`AUTHORIZATION`/`FOCUS`/`GIT` walls.
3. Toggle Switchboard Safeguards / Git Prohibition / Skip blocks on → each adds exactly its directive block; toggling off removes it. Preview == dispatch (byte-identical).
4. Orchestrate an epic whose doc was created **before** this change (no SUBTASKS block) → the doc is backfilled with the `## Subtasks` block and the dispatched prompt links it.
5. Orchestrate an epic → open the linked epic doc → the subtask list is present and current.
6. Drag an epic onto a non-orchestrator column (step mode) → the old `PLANS TO PROCESS` + template behavior is unchanged (regression guard).
7. Existing saved orchestrator role config (no `ultracode` key) → loads with Ultracode unchecked; unknown/legacy add-on keys preserved on save.

## Recommendation

Complexity 5/10 → **Send to Coder**. Mostly well-scoped wiring (one add-on, one option, one option-mapping), but the orchestrator-branch rewrite and the "epic doc must always carry subtasks" guarantee are the two careful spots; the migration/backfill and the step-mode scope guard must not be skipped.
