# Code Researcher Role: Rebuild Around Advise-Research Round-Trip Flow

## Goal

Rebuild the `code_researcher` agent role so it uses the modern human-in-the-loop research flow (the same mechanism the Planning tab's Research add-on and the `advise_research` skill use), triggered by dragging a plan into a new dedicated **Code Researcher** kanban column.

Target behavior:
1. User drags a plan card into the **Code Researcher** column.
2. The agent reviews the plan for anything that could benefit from more research (uncertain assumptions, factual claims, API/library behavior it is not 100% sure about).
3. If gaps exist, the agent drafts a ready-to-run research prompt using the **same mechanism as the planner research add-on** (`ADVISE_RESEARCH_DIRECTIVE` / `.agents/skills/advise_research/SKILL.md`), records the uncertainties in the plan, and then **stops and waits**.
4. The user runs that prompt externally (e.g. Google AI Studio), organizes the findings, and pastes them back into the **same agent terminal session**.
5. The agent integrates the findings and updates the plan.

### Problem

The `code_researcher` role is wired to **outdated** logic. Its prompt branch (`src/services/agentPromptBuilder.ts:1001`) still uses the legacy autonomous-research approach: it injects `DEEP_RESEARCH_DIRECTIVE` (instructing the agent to perform 50–100 source web research itself) and then a "PHASE 5: Plan Update" instruction telling it to edit the plan in place. There is **no human in the loop** — it does not draft a research prompt for the user to run and paste back.

Meanwhile, the rest of Switchboard moved to a **draft-a-prompt / run-externally / paste-back** model:
- The Planning tab's Research sub-tab (`src/webview/planning.html` STEP 1–3, `generateResearchPrompt()` in `src/webview/planning.js:5150`) generates a *meta-prompt* that asks the agent to draft a research prompt — it does **not** perform the research.
- The planner's "Research When Unsure" add-on (`adviseResearchIfUnsure`) appends `ADVISE_RESEARCH_DIRECTIVE` (`src/services/agentPromptBuilder.ts:311`), which tells the agent to surface uncertainties and hand the user a ready-to-run research prompt, structured per `.agents/skills/advise_research/SKILL.md`.

The `code_researcher` role was never updated to match this pattern.

Additionally, `code_researcher` has **no kanban column**. The only research column is `RESEARCHER` (`src/services/agentConfig.ts:104`), which dispatches the *separate* `researcher` role (genuine autonomous deep web research — being left alone). `code_researcher` is currently reachable only through its Agents-tab terminal config and Prompts-tab settings; nothing drag-dispatches to it. So step 1 of the target behavior ("drag a plan into the column") has no column to drag into.

### Background Context

- Two distinct research roles exist and **both are wanted**:
  - `researcher` — autonomous deep web research producing a standalone synthesis document. Has the `RESEARCHER` column. **Keep unchanged** (genuine use case).
  - `code_researcher` — should become the advise-research, human-in-the-loop, plan-improvement role described above.
- The `code_researcher` role already has the surrounding scaffolding in place from prior work, so this change is mostly the prompt body + a new column + mappings:
  - Agents-tab terminal toggle + startup command field (`src/webview/kanban.html:2746`).
  - Prompts-tab option (`src/webview/kanban.html:2814`) and addon defaults (`src/webview/sharedDefaults.js:36`, `:229`).
  - `DEFAULT_VISIBLE_AGENTS` entry `code_researcher: false` (`src/webview/sharedDefaults.js:15`) and `BUILT_IN_AGENT_LABELS` entry (`src/webview/sharedDefaults.js:46`).
  - Config resolution in `KanbanProvider.ts` (with legacy `research_planner` fallback at `:3064`).

### Root Cause Analysis

Prompt-mode kanban columns dispatch the role carried by the column definition's `.role` field — the dispatch sites resolve the role as `spec?.role || this._columnToRole(column)` (`src/services/KanbanProvider.ts:1510`, `:5177`, `:5296`). The existing `RESEARCHER` column works purely because its definition carries `role: 'researcher'`; note `KanbanProvider._columnToRole` does **not** even list a `RESEARCHER` case. Therefore a working drag-to-dispatch role requires (a) a column definition whose `.role` is `code_researcher`, and (b) the supporting column→role mappings in `TaskViewerProvider` (used for prompt-template selection and post-dispatch card routing). Neither exists today, which is why `code_researcher` is orphaned from the board.

The behavioral mismatch (autonomous vs. advise) is isolated entirely to the `if (role === 'code_researcher')` branch of `buildKanbanBatchPrompt` (`src/services/agentPromptBuilder.ts:1001`), so the behavior fix is a self-contained rewrite of that branch.

## Metadata

- **Tags:** feature, refactor, ui
- **Complexity:** 6
- **Type:** Feature / behavior change (role rework + new kanban column)
- **Primary files:** `src/services/agentConfig.ts`, `src/services/agentPromptBuilder.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/kanban.html`
- **Tests:** `src/services/__tests__/agentPromptBuilder.test.ts`, `src/test/agent-prompt-builder-subagents.test.js`, `src/test/minimal-prompt.test.js`
- **Migration impact:** New built-in column added to `DEFAULT_KANBAN_COLUMNS`. Column is `hideWhenNoAgent: true` and `code_researcher` is hidden by default (`DEFAULT_VISIBLE_AGENTS.code_researcher = false`), so existing installs see no new column until they explicitly enable the Code Researcher agent. No state migration required; legacy `research_planner` config fallback (`KanbanProvider.ts:3064`) is preserved untouched.

## User Review Required

- **None.** Both prior open questions are now resolved by code inspection:
  - `KanbanColumnDefinition.role` is typed `role?: string` (`agentConfig.ts:73`), so the `role: 'code_researcher'` literal compiles with **no type widening** — disregard the plan's earlier "widen if the compiler objects" caveat.
  - Depth (`researchComplexity` / `researchDepth`) is no longer consumed by the rewritten branch; the leftover config field and the `KanbanProvider.ts:2917` assignment are harmless and may be left in place (clarity-only split is optional, not required).

## Complexity Audit

### Routine
- Adding the `CODE_RESEARCHER` column definition to `DEFAULT_KANBAN_COLUMNS`.
- Adding the three column→role mapping cases in `TaskViewerProvider`.
- Hiding the Research Complexity selector for `code_researcher` in the Prompts tab.
- Updating tests to assert the new prompt text.

### Complex / Risky
- Authoring the new advise-research round-trip directive so the agent reliably (a) stops after drafting and (b) resumes correctly when findings are pasted into the same terminal session. This is a prompt-engineering correctness concern, not a structural one.

## Edge-Case & Dependency Audit

- **No research needed case:** If the agent finds nothing uncertain, it must say so and leave the plan untouched (no spurious `## Uncertain Assumptions` section, no empty research prompt). Mirror the `advise_research` skill's "If you are confident about everything…omit both" rule.
- **Multiple plans in one drag:** `buildKanbanBatchPrompt` receives a `plans` array. The directive must handle multiple plans (review each; draft prompt(s) covering all uncertainties) without the round-trip becoming ambiguous. Keep batch semantics consistent with how the `researcher`/`splitter` prompt branches phrase `PLANS TO PROCESS`.
- **Column visibility:** `hideWhenNoAgent: true` means the column only renders when a `code_researcher` agent terminal is configured/visible. The Agents-tab entry already exists; confirm the column appears once the agent is enabled and disappears when it is not (parity with `RESEARCHER`/`SPLITTER`).
- **Post-dispatch routing:** After the plan is updated, the card should land in `PLAN REVIEWED` ("Planned"). `_targetColumnForRole` needs a `code_researcher` case; without it the card has no defined destination.
- **Order collision:** New column order `95` sits between `RESEARCHER` (90) and `PLAN REVIEWED` (100) with no collision.
- **Inert config controls:** The Prompts-tab "Research Complexity" selector currently shows for `code_researcher` but the new flow ignores depth (depth is deferred into the drafted prompt, like the Planning tab). Hide it for `code_researcher` to avoid implying it has an effect. The `researcher` role keeps it.
- **`researcher` untouched:** The rewrite must not alter the `researcher` branch, the `RESEARCHER` column, or `DEEP_RESEARCH_DIRECTIVE` (still used by `researcher` and by `addons.researchEnabled`).
- **BuiltInAgentRole type:** `code_researcher` is intentionally not in the `BuiltInAgentRole` union or `VALID_ROLES`. `VALID_ROLES` only gates `parseDefaultPromptOverrides`, and `code_researcher` is already in `PROMPT_OVERRIDE_EXCLUDED_KEYS` (`sharedDefaults.js:67`). The `KanbanColumnDefinition.role` field accepts the string; verify the column type does not require a `BuiltInAgentRole` (widen the field type if the compiler objects).

## Dependencies

- None. This is a self-contained role rework with no upstream session dependencies. All scaffolding (Agents-tab toggle, Prompts-tab option, `DEFAULT_VISIBLE_AGENTS`, `BUILT_IN_AGENT_LABELS`, `ROLE_ADDONS`, config resolution with `research_planner` fallback) already exists in the codebase and is verified present.

## Adversarial Synthesis

**Key risks:** (1) Prompt-correctness — the round-trip directive must make the agent reliably *stop* after drafting and *resume* on paste-back within the same terminal session; this is the one non-mechanical risk. (2) Resolver fragmentation — the codebase has *four* column→role mappings (`TaskViewerProvider._columnToRole`, `_roleForKanbanColumn`, the exported `columnToPromptRole`, and `KanbanProvider._columnToRole`); missing the `columnToPromptRole` case (originally omitted) would silently mis-route the Copy-Prompt button to a coder prompt. (3) UI fall-through — hiding the Research Complexity selector must not strand `saveToLocalDocsRow` in a stale-visible state.

**Mitigations:** Model the directive on the proven `ADVISE_RESEARCH_DIRECTIVE` wording (already battle-tested in the planner add-on) with an explicit STOP/WAIT and paste-back contract; add the `columnToPromptRole` case for parity with `RESEARCHER`/`SPLITTER`; add an unconditional `saveToLocalDocsRow` hide. Dispatch itself is low-risk — it rides the existing `column.role` resolution that already powers `RESEARCHER`.

## Proposed Changes

### 1. `src/services/agentConfig.ts` — Add the Code Researcher column

In `DEFAULT_KANBAN_COLUMNS` (after the `RESEARCHER` entry, line 104), add:

```ts
{ id: 'CODE_RESEARCHER', label: 'Code Researcher', role: 'code_researcher', order: 95, kind: 'review', source: 'built-in', autobanEnabled: false, dragDropMode: 'prompt', hideWhenNoAgent: true },
```

- `dragDropMode: 'prompt'` — dispatches the role's prompt to its terminal on drop (matches `RESEARCHER`/`SPLITTER`).
- `autobanEnabled: false` — never auto-advances; drag-only, because the round-trip requires a human.
- `hideWhenNoAgent: true` — only appears when the Code Researcher agent is enabled.

If `KanbanColumnDefinition.role` is typed as `BuiltInAgentRole`, widen it to `BuiltInAgentRole | string` (or add `'code_researcher'`) so the literal compiles. Confirm before choosing — prefer the minimal change that compiles cleanly.

### 2. `src/services/TaskViewerProvider.ts` — Column ↔ role mappings

- `_columnToRole` (line 1950, case block ≈ 1960): add `case 'CODE_RESEARCHER': return 'code_researcher';`
- `_roleForKanbanColumn` (line 2013, case block ≈ 2019): add `case 'CODE_RESEARCHER': return 'code_researcher';` (this method runs its `switch` over `_normalizeLegacyKanbanColumn(column)`; `CODE_RESEARCHER` is new and unaffected by legacy normalization, so the literal case matches as-is)
- `_targetColumnForRole` (line 1987, case block ≈ 1991): add `case 'code_researcher': return 'PLAN REVIEWED';`

(`KanbanProvider._columnToRole` at `KanbanProvider.ts:7720` needs no change — like `RESEARCHER`/`SPLITTER`, neither of which it lists, dispatch resolves the role from the column definition's `.role` field. Verified: `_resolveKanbanDispatchSpec` (`KanbanProvider.ts:3947`) returns `column.role` directly when the column carries one — `agentConfig.ts:104`'s `RESEARCHER` works this way and `CODE_RESEARCHER` will too. The drag-dispatch sites at `KanbanProvider.ts:1510`/`:5177`/`:5296` consume `dispatchSpec?.role`, so drag-to-dispatch is fully wired by Change #1 alone.)

### 2b. `src/services/agentPromptBuilder.ts` — Add CODE_RESEARCHER to `columnToPromptRole` (line 1250)

**This is a gap not in the original plan.** `columnToPromptRole` (the exported function at `agentPromptBuilder.ts:1250`, distinct from `KanbanProvider._columnToRole`) is the canonical column→role resolver and **already lists `RESEARCHER` and `SPLITTER`**. It is delegated to by `TaskViewerProvider._resolveColumnRole` (`:7216`) and used as the role fallback in the **copy-prompt / prompt-preview path** (`TaskViewerProvider.ts:13690`: `role = columnToPromptRole(effectiveColumn) || 'coder'`) and the source-column resolver (`KanbanProvider.ts:3771`).

Without a case, clicking **Copy Prompt** on a card sitting in the Code Researcher column resolves to the wrong role (`'coder'`) and generates a coder prompt instead of the advise-research prompt. Add, alongside the existing `RESEARCHER`/`SPLITTER` cases:

```ts
case 'CODE_RESEARCHER': return 'code_researcher';
```

**Do NOT add `CODE_RESEARCHER` to the client-side `scColumnRoleMap` (`kanban.html:7563`).** That map drives the *single-column autoban* source-column selector; the Code Researcher column is `autobanEnabled: false` and human-in-the-loop by design, so it must not be presented as an automatable source. Leaving it out keeps the round-trip drag-only. (If `CODE_RESEARCHER` is ever surfaced in that dropdown, revisit — but do not add it pre-emptively.)

### 3. `src/services/agentPromptBuilder.ts` — Rewrite the `code_researcher` branch

Replace the body of `if (role === 'code_researcher') { … }` (lines 1001–1051) so it no longer injects `DEEP_RESEARCH_DIRECTIVE` or the "PHASE 5 edit-in-place" text. New base persona implements the advise-research round-trip and references the canonical skill (as `ADVISE_RESEARCH_DIRECTIVE` does):

Persona/flow the prompt must encode (final wording to be tuned during implementation):

```
You are a Code Researcher Agent. Your job is to identify where each plan needs
more research, hand the user a ready-to-run research prompt, then incorporate
the findings they bring back.

STEP 1 — Review: For each plan in PLANS TO PROCESS, read it and track every
assumption, factual claim, or API/library/behavior detail you are NOT 100%
certain about. Read .agents/skills/advise_research/SKILL.md and follow it.

STEP 2 — If uncertainties exist:
  a. Add a brief "## Uncertain Assumptions" section to the plan file listing
     ONLY those uncertainties (do NOT put the research prompt itself in the plan).
  b. Output, in this terminal, a single ready-to-run research prompt structured
     per the skill (ROLE, CONTEXT, CENTRAL QUESTION, 4–6 SUB-QUESTIONS, SOURCE
     GUIDANCE, SCOPE, OUTPUT format, CITATIONS-at-end, DEPTH/source-count target).
  c. STOP. Tell the user to run that prompt (Google AI Studio with search
     grounding, or their research agent of choice), organize the results, and
     paste them back into THIS terminal. Do not proceed until they do.

STEP 3 — When the user pastes research findings back:
  Integrate them into the plan's existing sections (add to relevant Proposed
  Changes subsections, update the Edge-Case & Dependency Audit with newly
  discovered risks, resolve/remove the "## Uncertain Assumptions" items they
  answer). Do NOT truncate, summarize, or delete existing plan content. Do NOT
  add new top-level sections that duplicate or conflict with the plan's
  canonical structure.

If you are confident about everything, state that no research is needed, omit
the "## Uncertain Assumptions" section and the research prompt, and leave the
plan unchanged.
```

Keep the existing surrounding assembly intact: `resolveBaseInstructions('code_researcher', crBase, options)`, the `cavemanOutput`, `switchboardSafeguards` (`batchExecutionRules` + `FOCUS_DIRECTIVE`), `gitProhibition`, `dispatchContextPrefix`, `antigravityBlock`, `subagentBlock`, and the trailing `PLANS TO PROCESS:\n${planList}`. Only the persona/directive content changes.

Remove the now-unused depth parameterization (`depthLabels`, `researchDepth`, the `DEEP_RESEARCH_DIRECTIVE.replace(...)` calls) **from this branch only**. Consider extracting the new persona into an exported constant (e.g. `CODE_RESEARCH_ADVISORY_DIRECTIVE`) for testability and parity with how other directives are defined.

In `KanbanProvider.ts` (≈ line 2916), the `else if (role === 'researcher' || role === 'code_researcher')` block sets `resolvedOptions.researchDepth` for `code_researcher`. Since depth is no longer consumed by the branch, leave the option being set (harmless) or split the condition so `code_researcher` no longer reads depth. Prefer splitting for clarity, but it is not required for correctness.

### 4. `src/webview/kanban.html` — Hide Research Complexity for `code_researcher`

The "Research Complexity" config section (`#researchComplexityConfig`, defined `:2959`) is shown when `currentRole === 'researcher' || currentRole === 'code_researcher'` at `:3246` (visibility) and `:3276` (the `else if` that loads the radio + the researcher-only `saveToLocalDocsRow`).

- **Essential change:** remove `code_researcher` from the visibility condition at `:3246` so the selector is hidden for it (shows for `researcher` only).
- **`:3276` branch:** removing `code_researcher` here is the clean choice; it then falls into the trailing `else` (`:3290`) which still calls `renderRoleAddons(currentRole)`, so addons render correctly. **Edge case to handle:** the `:3276` branch hides `saveToLocalDocsRow` for non-researcher roles; if `code_researcher` no longer enters that branch, ensure `saveToLocalDocsRow` is hidden when switching *from* `researcher` *to* `code_researcher` (otherwise the row can persist stale). Simplest fix: hide `saveToLocalDocsRow` unconditionally before the role-specific show, or keep a guard in the `else` path. Alternatively, leave `code_researcher` in the `:3276` branch (it harmlessly sets a now-hidden radio) — but then it must stay out of the `:3246` visibility condition. **Recommended:** remove from `:3246`, remove from `:3276`, and add an unconditional `saveToLocalDocsRow` hide.
- Leave the `code_researcher` `<option>` (`:2814`) and read-only preview behavior (`:3296`, `:3974`) as-is — read-only preview is correct for the new flow (its prompt is template-driven, like the planner's).
- **Role description (`:3206`):** currently `'Uses research to scope and improve coding plans with codebase exploration and external research.'` — update to reflect the advise/round-trip behavior, e.g. `'Reviews plans for research gaps, hands you a ready-to-run research prompt, then integrates the findings you paste back.'`

### 5. Tests

- `src/services/__tests__/agentPromptBuilder.test.ts` (`buildKanbanBatchPrompt — code_researcher role`, ≈ line 177): replace assertions that expect deep-research/depth text with assertions for the new advise-research behavior (e.g. mentions reviewing for uncertainties, drafting a research prompt, the `## Uncertain Assumptions` section, the stop-and-wait instruction, and the skill reference). Add a "no depth dependency" check.
- `src/test/agent-prompt-builder-subagents.test.js` (≈ lines 239–265): the `code_researcher` cases assert `'You are a Code Researcher Agent.'` (keep) and depth-variant behavior (remove/replace). Update to the new flow.
- `src/test/minimal-prompt.test.js` (≈ line 220): adjust the `code_researcher`-specific branch if it asserts depth/deep-research text.

## Verification Plan

### Automated Tests

Run by the **user** separately (this planning session is directed to skip compilation and tests). The implementer should ensure these pass:

1. `npm run compile` (TypeScript) — confirms the `CODE_RESEARCHER` column literal (`role?: string`, no widening needed), the three `TaskViewerProvider` mapping cases, and the `columnToPromptRole` case all type-check.
2. `src/services/__tests__/agentPromptBuilder.test.ts:177` — the existing `code_researcher` suite asserts `PHASE 5: Plan Update` / `update each plan file listed in PLANS TO PROCESS` (`:180-181`). **Replace** with assertions for the new flow: reviews for uncertainties, references `.agents/skills/advise_research/SKILL.md`, writes a `## Uncertain Assumptions` section, drafts a ready-to-run research prompt, includes a STOP/wait-for-paste-back instruction, and integrates findings on resume. Add a "no depth dependency" assertion (prompt does **not** contain `DEEP RESEARCH MODE` / `TARGET SOURCE COUNT`).
3. `src/test/agent-prompt-builder-subagents.test.js:239-265` — keep the `'You are a Code Researcher Agent.'` assertion (`:243`); **remove** the deep-research/depth assertions (`:244-245`, `:248-251`) and replace with the advise-research expectations. Leave all `researcher` assertions (`:253-262`) untouched.
4. `src/test/minimal-prompt.test.js:220` — the `code_researcher` branch sets `promptOpts.researchDepth = 'deep'`; this stays harmless (the rewritten branch ignores it) but adjust any depth/deep-research text assertion if present. The generic `\n\n` paragraph-break check (`:230-231`) must still hold for the new prompt.
5. (Optional but recommended) Add a `columnToPromptRole('CODE_RESEARCHER') === 'code_researcher'` assertion alongside the existing `RESEARCHER`/`SPLITTER` cases.

### Manual Verification (installed VSIX)

6. Enable the **Code Researcher** agent in the Agents tab → confirm the **Code Researcher** column appears between Researcher (order 90) and Planned (order 100), and disappears when the agent is disabled (`hideWhenNoAgent` parity with Researcher).
7. Confirm the Prompts-tab **Research Complexity** selector is hidden for Code Researcher and still shown for Researcher; confirm switching Researcher → Code Researcher does not leave `saveToLocalDocsRow` stranded visible.
8. Drag a plan with at least one uncertain assumption into the column → confirm the agent reviews, writes `## Uncertain Assumptions` to the plan, prints a ready-to-run research prompt, and stops.
9. Paste fabricated research findings into the same terminal → confirm the agent integrates them into the plan's existing sections, resolves the uncertainties, does not clobber canonical sections, and the card routes to **Planned** (`_targetColumnForRole('code_researcher')`).
10. Drag a plan with no uncertainties → confirm the agent states no research is needed and leaves the plan untouched.
11. Click **Copy Prompt** on a card in the Code Researcher column → confirm it produces the advise-research prompt (not a coder prompt) — validates the `columnToPromptRole` case.
12. Regression: confirm the **Researcher** column still dispatches the unchanged autonomous `researcher` deep-research flow, and the Copy-Prompt button there is unchanged.

---

**Recommendation:** Complexity 6 (Mixed — mostly routine pattern-extension across five files, with one moderate prompt-correctness risk in the round-trip directive). → **Send to Coder.**

## Reviewer Pass (2026-06-26)

### Stage 1 — Adversarial Findings (Grumpy Principal Engineer)

| # | Severity | File:Line | Finding |
|---|---|---|---|
| 1 | MAJOR | `src/services/__tests__/agentPromptBuilder.test.ts:179-186` | Missing `## Uncertain Assumptions` positive assertion and `DEEP RESEARCH MODE` negative assertion. Plan Verification item #2 explicitly required both; only `TARGET SOURCE COUNT:` was checked. A future regression that re-injected `DEEP_RESEARCH_DIRECTIVE` or dropped the Uncertain Assumptions section would pass silently. |
| 2 | MAJOR | `src/test/agent-prompt-builder-subagents.test.js:241-251` | Same gap — no `## Uncertain Assumptions` positive, no `DEEP RESEARCH MODE` negative. Plan Verification item #3 said "replace with the advise-research expectations." The `!includes('depth set to "quick"')` check is a weak proxy that wouldn't catch `DEEP_RESEARCH_DIRECTIVE` re-injection. |
| 3 | NIT | `src/webview/kanban.html:2923` | Stale comment `(for researcher and code_researcher)` — section is now researcher-only per `:3211`. |
| 4 | NIT | `src/webview/kanban.html:3955` | Stale comment `(shared by researcher and code_researcher)` — no longer shared. |
| 5 | NIT (deferred) | `src/services/agentPromptBuilder.ts:1049-1062` | Plan optionally suggested extracting persona into exported `CODE_RESEARCH_ADVISORY_DIRECTIVE` constant for parity with `ADVISE_RESEARCH_DIRECTIVE`/`DEEP_RESEARCH_DIRECTIVE`. Not done; inline `crBase`. Acceptable per plan ("Consider extracting"). |

### Stage 2 — Balanced Synthesis

- **Fix now:** #1, #2 (add missing assertions — plan's explicit verification criteria, cheap), #3, #4 (stale comments, trivial).
- **Defer:** #5 (optional extraction, no correctness impact).
- **Verified correct (no action):** column definition (`agentConfig.ts:110`), all four role-mapping sites (`TaskViewerProvider.ts:1961,1994-1995,2024-2025`; `agentPromptBuilder.ts:1308`), prompt rewrite (`agentPromptBuilder.ts:1049-1083`), UI visibility/hiding (`kanban.html:3211,3214-3217,3246-3260`), read-only preview (`:3264,3949`), role description (`:3170`), `scColumnRoleMap` exclusion (`kanban.html:7584-7595` — `CODE_RESEARCHER` correctly absent), `KanbanProvider` depth split (`KanbanProvider.ts:3017-3022`), `researcher` branch untouched (`agentPromptBuilder.ts:1002-1047`), dispatch via `column.role` (`KanbanProvider.ts:4157-4163`), role-validation gate (`KanbanProvider.ts:3944`).

### Fixes Applied

1. `src/services/__tests__/agentPromptBuilder.test.ts:183,186` — added `assert.ok(prompt.includes('## Uncertain Assumptions'), ...)` and `assert.ok(!prompt.includes('DEEP RESEARCH MODE'), ...)`.
2. `src/test/agent-prompt-builder-subagents.test.js:247-248,254` — added `## Uncertain Assumptions` positive and `DEEP RESEARCH MODE` negative (both for default and depth-option variants).
3. `src/webview/kanban.html:2923` — comment corrected to `(researcher only; code_researcher uses the advise-research round-trip)`.
4. `src/webview/kanban.html:3955` — comment corrected to `(researcher only; code_researcher hides this section)`.

### Validation Results

- **Assertion sanity check (runtime):** extracted the `code_researcher` branch source and confirmed `## Uncertain Assumptions` → `true`, `DEEP RESEARCH MODE` → `false`, `TARGET SOURCE COUNT` → `false`, `DEEP_RESEARCH_DIRECTIVE` → `false`. All new assertions hold against the actual prompt text.
- **Compilation:** skipped per session policy (project assumed pre-compiled).
- **Automated tests:** skipped per session policy (user runs separately). The two modified test files now cover the plan's Verification items #2 and #3 in full.
- **Manual verification (items #6–#12):** not executed in this session — deferred to the user's installed-VSIX pass.

### Remaining Risks

- **Prompt-correctness (runtime, untestable here):** the round-trip directive's reliability in making a live agent *stop* after drafting and *resume* on paste-back within the same terminal session is a behavioral property that unit tests cannot verify. Manual items #8–#10 are the real gate.
- **Deferred NIT #5:** persona remains inline; if a future change needs to reference `CODE_RESEARCH_ADVISORY_DIRECTIVE` from another module or test, the extraction will be required at that point.
- **No state migration needed:** confirmed — `CODE_RESEARCHER` is a new built-in column with `hideWhenNoAgent: true` and `DEFAULT_VISIBLE_AGENTS.code_researcher = false`, so existing installs see no new column until they enable the agent. Legacy `research_planner` fallback (`KanbanProvider.ts` config resolution) is preserved.
