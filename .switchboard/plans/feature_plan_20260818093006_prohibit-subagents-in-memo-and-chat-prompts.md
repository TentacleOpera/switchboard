# Prohibit Subagents in Memo and Chat Prompts

## Goal
When AI agents (such as Antigravity, Claude Code, or Codex) receive prompts generated from the Memo panel or the Chat consultation flow, they frequently invoke native subagents (spawning 5-10 parallel subagents) to research code or draft plan files. For simple tasks such as drafting plan markdown files or discussing architecture, invoking multiple native subagents is extremely slow, redundant, and prohibitively expensive.

The generated memo prompts and general chat prompts must include explicit, mandatory instructions forbidding the use of subagents, requiring agents to perform all research, investigation, and file drafting directly within their primary conversation context.

### Problem & Root Cause Analysis
1. **Missing Subagent Prohibition in `_buildMemoPlannerPrompt`**: In `src/services/TaskViewerProvider.ts`, `_buildMemoPlannerPrompt` provides a list of issues to refine but contains no directive regarding subagents. When handed 5+ memo issues, an AI agent's default heuristic is to spawn a subagent per issue.
2. **Missing Subagent Prohibition in `DEFAULT_CHAT_BASE_INSTRUCTIONS`**: In `src/services/agentPromptBuilder.ts`, `DEFAULT_CHAT_BASE_INSTRUCTIONS` (which is also mirrored in `.agents/workflows/switchboard-cloud.md`) lists Hard Rules (1–8) and Process Steps (1–5), but lacks a rule prohibiting subagent dispatch during consultation and planning.
3. **High Token & Latency Cost**: Agent platforms incur massive overhead when spinning up separate agent loops with full context duplication for tasks that can be performed with straightforward tool calls (e.g. `grep_search`, `view_file`, `write_to_file`) in a single thread.

### Existing Subagent Mechanism (context discovered during review)
The codebase already has a subagent prohibition mechanism: `NO_SUBAGENTS_DIRECTIVE` (exported constant at `src/services/agentPromptBuilder.ts:1075`) — `"SUBAGENT POLICY: You are strictly forbidden from spawning or invoking any subagents. Handle all tasks yourself."` — wired into three dispatch paths via the `noSubagentsEnabled` / `subagentPolicy: 'noSubagents'` toggle:
- **Batch dispatch** (`buildKanbanBatchPrompt`, line 1486) — applies `NO_SUBAGENTS_DIRECTIVE` as a suffix when `noSubagentsEnabled` is true.
- **Seat directive** (`buildSeatDirectiveBlock`, line 1145) — applies it when `subagentPolicy === 'noSubagents'`.
- **Custom agent** (`buildCustomAgentPrompt`, line 2347) — applies it when `addons?.subagentPolicy === 'noSubagents'`.

**Critical gap:** the **chat path** (`role === 'chat'`, line 2235) builds its `suffixBlock` from `[dispatchContextPrefix, focusBlock, planDestinationBlock, projectPinBlock, antigravityBlock]` (line 2252) — it does **not** include `subagentBlock`. So the existing toggle has **no effect on chat prompts**. The memo planner prompt (`_buildMemoPlannerPrompt`) is a standalone TS method that doesn't go through `buildKanbanBatchPrompt` at all, so it also has no subagent directive. This plan closes both gaps.

## Metadata
- **Complexity:** 3
- **Tags:** backend, feature, reliability
- **Project:** Browser Switchboard

## User Review Required
This plan makes a **design decision** to bake the subagent prohibition as an always-on Hard Rule in `DEFAULT_CHAT_BASE_INSTRUCTIONS` rather than wiring the existing `noSubagentsEnabled` toggle into the chat path's suffix mechanism. This means:
- The prohibition **cannot be toggled off** for chat prompts via the existing `subagentPolicy` setting.
- If a future need arises to allow subagents in chat consultation, the rule would need to be moved from the base instructions to the suffix block (adding `subagentBlock` to the chat path's `suffixBlock` array at line 2252).

The always-on approach is chosen because: (a) the chat path doesn't currently use the suffix mechanism for subagents, so adding suffix wiring is a larger change; (b) chat consultation is inherently a single-thread planning task where subagents provide no value; (c) a Hard Rule in the base covers both programmatic prompt injection AND direct-read of `switchboard-cloud.md` by an agent.

## Complexity Audit

### Routine
- Adding Hard Rule #9 text to the `DEFAULT_CHAT_BASE_INSTRUCTIONS` template literal in `src/services/agentPromptBuilder.ts`.
- Syncing the same rule text into `.agents/workflows/switchboard-cloud.md` (the markdown mirror — the sync test enforces this pair stays aligned).
- Appending the existing `NO_SUBAGENTS_DIRECTIVE` constant to the `_buildMemoPlannerPrompt` return string in `src/services/TaskViewerProvider.ts` (single `+=` line, reuses existing constant — no new wording invented).
- Adding a "no subagents" directive line to step 4 of `.agents/workflows/switchboard-memo.md` (the `process memo` plan-writing step).
- Adding test assertions to `src/test/prompt-split-guidance-sync.test.js` verifying the directive is present across the three new surfaces.

### Complex / Risky
- None. All changes are text/prompt-string additions with deterministic test coverage. No logic, no state, no control flow changes.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Prompt strings are built synchronously per-dispatch; no shared mutable state.

### Security
- None. No secrets, no credentials, no external I/O.

### Side Effects
- **Always-on prohibition for chat**: adding Hard Rule #9 to `DEFAULT_CHAT_BASE_INSTRUCTIONS` means every chat prompt will carry the prohibition. This is the intended behavior, but it means the existing `subagentPolicy` toggle cannot enable subagents for chat even if a user configures it — the toggle has no chat-path wiring (line 2252's `suffixBlock` omits `subagentBlock`), and the Hard Rule is in the base, not the suffix.
- **Memo prompt length**: appending `NO_SUBAGENTS_DIRECTIVE` adds ~90 characters to the memo planner prompt. Negligible.

### Spark Context — No Conflict (confirmed during user review)
The generated Spark context (`src/services/SparkContextExporter.ts`) authorizes research sub-agents for external surfaces (`:248`: *"You MAY dispatch your own research or coding sub-agents"*; `:254`: research directive override). This is **not in conflict** with a blanket subagent prohibition in the memo/chat prompts, because these prompts are **not intended for Spark**.

The intended Spark workflow is docs-based: the Connections panel's Web Agents tab produces a docs zip + HOW-TO-PLAN prompt, the user uploads it to Spark, Spark reads the docs (not code) and writes a plan back. Spark is slow at code reading due to tool-call overhead and subagent spawning, so the product design funnels Spark through docs, not through raw memo/chat prompts.

The memo planner prompt and chat prompt target **local filesystem-capable agents** (Antigravity, Claude Code, Codex) that can read code directly and have no need for subagents to parallelize simple plan drafting. If a user does paste a memo/chat prompt into Spark, the blanket "no subagents" rule is the **correct** behavior — it stops Spark from spinning up 10 subagents to read code it can't efficiently read, which is exactly the waste this plan exists to prevent.

The Spark context's research-subagent authorization applies to the **docs-based planning workflow** (a different prompt path), where Spark dispatches research subagents for external research while reading docs. That path is unaffected by this plan.

### Dependencies & Conflicts
- **`prompt-split-guidance-sync.test.js`**: this test syncs 9 surfaces for splitting-signal consistency. The new subagent assertions are additive (new `assert.ok` calls) and do not alter existing assertions. The test must continue to pass after the prompt changes.
- **`memo-panel-workspace-binding-contract.test.js`**: this contract test reads the memo planner prompt from the clipboard seam recorder and asserts on `plansDir` and PROJECT PIN content. Adding `NO_SUBAGENTS_DIRECTIVE` to the prompt string does not affect `plansDir` or PROJECT PIN assertions — the directive is appended after the existing template, before the optional `PROJECT_LINE_DIRECTIVE` suffix. No conflict.
- **`switchboard-memo.md` step 4/step 5 invariant**: the sync test asserts step 4 contains splitting signals and "no orphan plans are created", and step 5 does NOT mention splitting. Adding a "no subagents" line to step 4 is additive and does not break these assertions (the test checks for specific substrings, not exact-match of the step body).

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) the plan's original code block for `_buildMemoPlannerPrompt` was a full-template replacement that would have deleted the `## Plan File Format` section and the feature-grouping instruction — corrected to an additive diff; (2) the original plan invented divergent subagent-prohibition wording instead of reusing `NO_SUBAGENTS_DIRECTIVE` — corrected to reuse the existing constant; (3) the original plan placed the memo workflow directive in the Hard Rules section (capture-mode rules) instead of step 4 (plan-writing step) — corrected; (4) an earlier revision scoped the prohibition with a research exception for Spark — reverted to a blanket ban after user review confirmed these prompts are not intended for Spark (Spark's workflow is docs-based via Connections, not memo/chat prompt pasting). Mitigations: Superseded callouts document each correction; test assertions guard all three surfaces; the blanket `NO_SUBAGENTS_DIRECTIVE` constant is the single source of truth already wired into three dispatch paths.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
**Context:** `DEFAULT_CHAT_BASE_INSTRUCTIONS` (line 1322) is the base prompt for the `chat` role. It is mirrored in `.agents/workflows/switchboard-cloud.md` (the sync test enforces this). The chat path (line 2235) uses this as `baseInstructions` and appends a `suffixBlock` — but the suffix does not include `subagentBlock`, so the existing `noSubagentsEnabled` toggle has no effect on chat.

**Logic:** Add Hard Rule #9 to the base instructions (always-on for chat). This covers both programmatic prompt injection and direct-read of the `switchboard-cloud.md` mirror. The wording is a blanket prohibition — no exceptions — because these prompts target local filesystem-capable agents (Antigravity, Claude Code, Codex). Spark is not the intended audience for these prompts (see "Spark Context — No Conflict" above); if someone pastes them into Spark, the blanket ban is the correct behavior.

**Implementation:** In the `DEFAULT_CHAT_BASE_INSTRUCTIONS` template literal, after Hard Rule #8 (line 1332), add:

```typescript
9. **No subagents.** Do NOT invoke or spawn subagents (e.g. \`invoke_subagent\`, background agents, or task delegators). Perform all exploration, file reading, and plan drafting directly in this primary conversation session.
```

**Edge Cases:** The Hard Rule is always-on and cannot be toggled off for chat via the existing `subagentPolicy` setting. This is a deliberate design decision (see ## User Review Required). If a user has configured `subagentPolicy: 'useSubagents'` or `'customSubagent'`, those settings have no effect on the chat path today (the chat `suffixBlock` doesn't read them), so there is no contradiction between the Hard Rule and the toggle — the toggle simply doesn't apply to chat.

### `src/services/TaskViewerProvider.ts`
**Context:** `_buildMemoPlannerPrompt` (line 5812) builds the memo planner prompt string — a standalone TS method that does NOT go through `buildKanbanBatchPrompt`. It is invoked by the `memoGeneratePrompt` verb (line 14172) for both "copy to clipboard" and "send to planner" actions. The prompt currently has no subagent directive.

> **Superseded:** The original plan proposed a full replacement code block for `_buildMemoPlannerPrompt` that rewrote the entire template literal, adding step 6 ("DO NOT USE SUBAGENTS") to `## Instructions` and a "NO SUBAGENTS" bullet to `## Important`, but in doing so **omitted the entire `## Plan File Format` section** (lines 5831-5843 of the real file) and the **feature-grouping instruction** (end of line 5849). The original plan's intent was additive ("Add an instruction in the `## Instructions` and `## Important` sections"), but the code block it provided was a destructive full-template replacement.
> **Reason:** A coder implementing the original code block literally would delete the plan-file-format guidance (which tells the agent the exact Metadata fields, Tags allowed list, and Project pinning rules) and the feature-grouping gate (which tells the agent to cluster related plans and create features). This is a content-preservation violation — the prompt would be worse, not better.
> **Replaced with:** An additive change that appends the existing `NO_SUBAGENTS_DIRECTIVE` constant to the prompt string. This reuses the single source of truth for subagent prohibition (line 1075 of `agentPromptBuilder.ts`) and touches nothing else in the template.

> **Superseded:** The original plan invented new subagent-prohibition wording for the memo prompt ("DO NOT USE SUBAGENTS: Perform all investigation, code reading, and file writing directly in this conversation. Do NOT spawn or invoke subagents (e.g. invoke_subagent or background agents) under any circumstances." and "NO SUBAGENTS: Execute all steps sequentially in this primary agent context; native subagents are strictly prohibited.").
> **Reason:** The codebase already exports `NO_SUBAGENTS_DIRECTIVE` — `"SUBAGENT POLICY: You are strictly forbidden from spawning or invoking any subagents. Handle all tasks yourself."` — as the canonical subagent prohibition string, wired into three dispatch paths. Inventing divergent wording creates a second, unsynced source of truth that the sync test cannot catch (it asserts presence, not consistency).
> **Replaced with:** Append the existing `NO_SUBAGENTS_DIRECTIVE` constant to the `_buildMemoPlannerPrompt` return value. The constant is already imported or can be imported from `agentPromptBuilder.ts`. This is a single `+=` line, reuses the existing wording, and adds zero new prose to maintain. The blanket ban is correct here — the memo prompt targets local filesystem-capable agents, not Spark (see "Spark Context — No Conflict" above).

**Implementation:** After the existing template literal assignment (line 5849, ending with the feature-grouping instruction) and before the `PROJECT_LINE_DIRECTIVE` append (line 5851), add:

```typescript
        prompt += '\n\n' + NO_SUBAGENTS_DIRECTIVE;
```

This requires importing `NO_SUBAGENTS_DIRECTIVE` from `./agentPromptBuilder` if not already imported. Check existing imports at the top of `TaskViewerProvider.ts` — `PROJECT_LINE_DIRECTIVE` is already imported from the same module (used at line 5852), so `NO_SUBAGENTS_DIRECTIVE` can be added to the same import statement.

**Edge Cases:** The directive is appended before the optional `PROJECT_LINE_DIRECTIVE` suffix, so the prompt structure is: `[template] → [NO_SUBAGENTS_DIRECTIVE] → [optional PROJECT_PIN]`. This ordering is correct — the subagent policy is a standing rule, the project pin is a per-dispatch directive. The `memo-panel-workspace-binding-contract.test.js` test reads the prompt from the clipboard seam and asserts on `plansDir` and `PROJECT PIN` content — neither is affected by the appended directive.

### `.agents/workflows/switchboard-cloud.md`
**Context:** This file is the markdown mirror of `DEFAULT_CHAT_BASE_INSTRUCTIONS` (the sync test at `src/test/prompt-split-guidance-sync.test.js` enforces the pair stays aligned for splitting signals). It is also read directly by agents as a workflow file in cloud-VM planning sessions.

**Logic:** Sync Hard Rule #9 into the `## Hard Rules` section of `switchboard-cloud.md`, after rule #8 (line 18).

**Implementation:** Add after rule #8:

```markdown
9. **No subagents.** Do NOT invoke or spawn subagents (e.g. `invoke_subagent`, background agents, or task delegators). Perform all exploration, file reading, and plan drafting directly in this primary conversation session.
```

**Edge Cases:** The sync test does not currently assert the presence of a subagent rule in `switchboard-cloud.md` — the new test assertions (see below) will add this guard. The rule text must match `DEFAULT_CHAT_BASE_INSTRUCTIONS` verbatim (the sync test should assert the same substring in both).

### `.agents/workflows/switchboard-memo.md`
**Context:** This file is the Memo Capture Mode workflow. Its `## Hard Rules` (lines 18-26) are **capture-mode rules** — "Append, do not answer", "No eager action. Do not run tools", etc. These apply during capture mode (append-only). The subagent prohibition matters during `process memo` (step 4, line 53), when the agent exits capture mode and writes plan files — that is when an agent might spawn subagents to parallelize plan writing.

> **Superseded:** The original plan proposed syncing "Hard Rule #9" into `switchboard-memo.md` (implying the `## Hard Rules` section).
> **Reason:** The `## Hard Rules` in `switchboard-memo.md` are capture-mode rules that already prohibit ALL tools and ALL actions except appending to the memo file (Hard Rule #3: "Do not run tools, search the codebase, read files, or take any action beyond appending to the memo file"). A subagent rule there is redundant noise during capture and absent during `process memo` (when it actually matters). The `process memo` step (step 4) is where the agent exits capture mode, writes plan files, and could spawn subagents.
> **Replaced with:** Add the "no subagents" directive to **step 4** (`**Create one plan per entry.**`, line 53) of `switchboard-memo.md`, where plan writing happens. This is the semantically correct placement — it covers the `process memo` path where subagent spawning is a real risk.

**Implementation:** In step 4 of `switchboard-memo.md` (line 53), add a sentence after the existing splitting guidance and before the Project Pinning instruction. The step currently ends with: "...Otherwise, one entry = one plan." Add after that sentence:

```markdown
**No subagents.** Do NOT invoke or spawn subagents (e.g. `invoke_subagent`, background agents, or task delegators). Perform all exploration, code reading, and plan writing directly in this primary conversation session.
```

**Edge Cases:** The sync test asserts step 4 contains "Before writing", "3+ distinct deliverables", "2+ independently-shippable phases", and "no orphan plans are created" (lines 144-155 of the test). The new directive is additive text within the step body and does not break these substring assertions. The test also asserts step 5 does NOT mention "split" (line 166) — the new directive is in step 4, not step 5, so no conflict.

### `src/test/prompt-split-guidance-sync.test.js`
**Context:** This test syncs 9 prompt surfaces for splitting-signal consistency. It reads source files and asserts substrings are present. The new subagent assertions are additive — new `assert.ok` calls that verify the "No subagents" directive is present in the three new surfaces.

**Implementation:** Add a new assertion block after the existing surface-1 assertions (after line 100, the conditional-on-initiator gate checks). Add assertions for:

1. **`DEFAULT_CHAT_BASE_INSTRUCTIONS`** (surface 1) — assert `chatBase` includes the Hard Rule #9 text:
```javascript
assert.ok(
    /9\. \*\*No subagents\.\*\* Do NOT invoke or spawn subagents/.test(chatBase),
    'DEFAULT_CHAT_BASE_INSTRUCTIONS must include Hard Rule #9 prohibiting subagents.'
);
```

2. **`switchboard-cloud.md`** (surface 2) — assert the same rule text is present:
```javascript
assert.ok(
    /9\. \*\*No subagents\.\*\* Do NOT invoke or spawn subagents/.test(cloudWorkflow),
    'switchboard-cloud.md must include Hard Rule #9 prohibiting subagents (sync with chat base).'
);
```

3. **`_buildMemoPlannerPrompt`** (surface 4) — assert the `NO_SUBAGENTS_DIRECTIVE` text is present in `TaskViewerProvider.ts` source:
```javascript
assert.ok(
    taskViewerSource.includes('NO_SUBAGENTS_DIRECTIVE'),
    'TaskViewerProvider _buildMemoPlannerPrompt must append NO_SUBAGENTS_DIRECTIVE to the memo planner prompt.'
);
```

4. **`switchboard-memo.md`** (surface 3) — assert step 4 contains the "No subagents" directive. This requires extracting step 4 (the test already does this at line 138) and asserting:
```javascript
assert.ok(
    /No subagents\./.test(memoStep4),
    'switchboard-memo.md step 4 must include the "No subagents" directive (plan-writing step, not capture-mode Hard Rules).'
);
```

**Edge Cases:** The `memoStep4` variable is already extracted at line 143 of the test. The new assertion uses it directly. The `chatBase` variable is already extracted at line 68. The `cloudWorkflow` variable is already read at line 43. The `taskViewerSource` variable is already read at line 42. No new file reads needed.

## Verification Plan

### Automated Tests
- Run prompt synchronization and memo contract tests:
  - `npm test src/test/prompt-split-guidance-sync.test.js`
  - `npm test src/test/memo-panel-workspace-binding-contract.test.js`

### Manual Verification
1. Click "Copy Chat Prompt" in the Kanban/Planning tab: paste into a text editor and verify "No subagents" is listed as Hard Rule #9.
2. In the Memo tab, click "Process Memo" or "Copy Planner Prompt": verify the generated prompt contains the `NO_SUBAGENTS_DIRECTIVE` text ("SUBAGENT POLICY: You are strictly forbidden from spawning or invoking any subagents").
3. Read `.agents/workflows/switchboard-cloud.md` and verify Hard Rule #9 ("No subagents") is present in the `## Hard Rules` section.
4. Read `.agents/workflows/switchboard-memo.md` step 4 and verify the "No subagents" directive is present (NOT in the `## Hard Rules` section).

## Recommendation
Complexity 3 → **Send to Intern**. All changes are additive text/prompt-string edits with deterministic test coverage — no logic, no state, no control flow. The Superseded callouts and per-file Implementation sections provide exact insertion points and line numbers, making this straightforward for an intern to execute correctly. The sync test assertions are pre-written in the plan.
