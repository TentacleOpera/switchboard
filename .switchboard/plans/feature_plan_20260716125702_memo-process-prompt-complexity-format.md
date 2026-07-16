# Memo Process Prompt: Add Complexity Ratings & Correct Metadata Format

## Goal

The memo "process memo" / "Send to Planner" path generates plans with inconsistent or missing metadata — specifically missing `**Complexity:**` numeric ratings, free-form tags outside the allowed vocabulary, and missing `**Project:**` pin lines. The fix is to bring the memo planner prompt's `## Plan File Format` section in line with the explicit metadata format already enforced by the chat prompt button (`DEFAULT_CHAT_BASE_INSTRUCTIONS` Rule #5) and the improve-plan SKILL.md workflow.

### Problem Analysis & Root Cause

**Symptom:** Plans produced from the Memo sub-tab's "Send to Planner" / "Copy Prompt" button frequently land in `.switchboard/plans/` with a `## Metadata` section that says only `tags, complexity 1-10` as a vague header, with no `**Complexity:** N` numeric field, invented tags, and no `**Project:**` line. This breaks downstream kanban import parsing (complexity-based routing, tag filtering, project pinning).

**Root cause:** The memo planner prompt is built by a standalone helper, `_buildMemoPlannerPrompt` in <ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts" />, which bypasses the canonical prompt builder (`buildKanbanBatchPrompt` / `DEFAULT_CHAT_BASE_INSTRUCTIONS`) and does not prepend the improve-plan SKILL.md workflow. Its `## Plan File Format` block (lines 3998-4007) specifies the section list but gives only a vague one-liner for Metadata:

```
- ## Metadata (tags, complexity 1-10)
```

It never tells the agent:
- to write a numeric `**Complexity:**` rating (1-10),
- the exact allowed `**Tags:**` vocabulary,
- to write `**Project:**` when a PROJECT PIN directive is present.

**Reference (the "correct format"):** The chat prompt button emits `DEFAULT_CHAT_BASE_INSTRUCTIONS` (agentPromptBuilder.ts:786-806), whose Rule #5 specifies the exact format:

> Every plan must have a descriptive H1 title (never generic), and a `## Metadata` section with `**Complexity:**` (1–10), `**Tags:**` (comma-separated, from: frontend, backend, auth, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library), and `**Project:**` (if the PROJECT PIN directive is present, write the exact project name specified).

The improve-plan SKILL.md (lines 34-38) specifies the same with an expanded tag list (adds `authentication`) and a `**Repo:**` line. The memo prompt matches neither.

**Secondary drift:** The tag vocabulary is inconsistent between the two canonical sources — `DEFAULT_CHAT_BASE_INSTRUCTIONS` omits `authentication` while improve-plan SKILL.md includes it. This plan reconciles to the SKILL.md list (the planner workflow's source of truth, and the superset) and notes the chat-base drift as a follow-up.

## Metadata

- **Tags:** backend, refactor, bugfix
- **Complexity:** 2
- **Repo:** switchboard

## Complexity Audit

### Routine
- Single-function edit to a string template literal in one TypeScript file (`TaskViewerProvider.ts`).
- No control-flow, type, or API-surface changes — only prompt text content.
- The correct format already exists verbatim in `DEFAULT_CHAT_BASE_INSTRUCTIONS` and the improve-plan SKILL.md; this is a copy/reconcile, not new design.
- No database, no IPC, no webview contract change — the `memoGeneratePrompt` message handler and `_buildMemoPlannerPrompt` signature are untouched.

### Complex / Risky
- Tag-vocabulary reconciliation: choosing the canonical list affects plan import parsing. Picking the SKILL.md superset (with `authentication`) is safe because the importer only validates against a known set and ignores extras silently, but the chat base instructions should be kept in sync to avoid two "correct" formats drifting again. The sync of `DEFAULT_CHAT_BASE_INSTRUCTIONS` is a small follow-on edit flagged in Proposed Changes.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `_buildMemoPlannerPrompt` is a pure synchronous string builder called from the `memoGeneratePrompt` webview message handler. No shared mutable state.
- **Security:** No new prompt-injection surface; the inserted text is a static format spec, not user-controlled.
- **Side Effects:** Plans created via the memo path will now consistently carry `**Complexity:**`, `**Tags:**`, and `**Project:**` — improving kanban import, complexity routing, and project filtering. No regression for plans that previously happened to include these fields.
- **Dependencies & Conflicts:** The `PROJECT_LINE_DIRECTIVE` is already appended after the prompt body (TaskViewerProvider.ts:4015-4017) when a project is active, so the new `**Project:**` instruction in the format spec is consistent with the existing directive — no conflict. The `_parseMemoEntries` helper and `dispatchCustomPromptToRole` flow are untouched.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `_buildMemoPlannerPrompt` (lines ~3998-4007)

Replace the vague `## Plan File Format` Metadata bullet with the explicit format spec matching the chat prompt button / improve-plan SKILL.md.

**Before (lines 3998-4007):**
```typescript
## Plan File Format

Each plan file must include:
- # Title (derived from the issue)
- ## Goal (with problem analysis and root cause)
- ## Metadata (tags, complexity 1-10)
- ## Complexity Audit (Routine vs Complex/Risky)
- ## Edge-Case & Dependency Audit
- ## Proposed Changes (per-file breakdown with code snippets)
- ## Verification Plan
```

**After:**
```typescript
## Plan File Format

Each plan file must include:
- # Title (derived from the issue — descriptive, never generic)
- ## Goal (with problem analysis and root cause)
- ## Metadata — this section is REQUIRED and must contain these exact fields:
  - **Complexity:** <1-10> — assign a numeric complexity rating (1-2 Very Low, 3-4 Low, 5-6 Medium, 7-8 High, 9-10 Very High). This is mandatory; do not leave it blank or write "Unknown".
  - **Tags:** <comma-separated, from this allowed list ONLY: frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library>. Do NOT invent tags outside the list. If none apply, write **Tags:** none
  - **Project:** <name> — include this line ONLY if a PROJECT PIN directive is present below; write the exact project name it specifies. Otherwise omit the line. The workspace/repo name is NOT a project — never use it as a pin.
- ## Complexity Audit (Routine vs Complex/Risky)
- ## Edge-Case & Dependency Audit
- ## Proposed Changes (per-file breakdown with code snippets)
- ## Verification Plan
```

This mirrors `DEFAULT_CHAT_BASE_INSTRUCTIONS` Rule #5 and the improve-plan SKILL.md `## Metadata` spec, so all three plan-producing paths (chat prompt button, kanban planner dispatch, memo process) emit identical metadata instructions.

### `src/services/agentPromptBuilder.ts` — `DEFAULT_CHAT_BASE_INSTRUCTIONS` Rule #5 (line 793) — follow-on sync

Add `authentication` to the chat-base tag vocabulary so it matches the improve-plan SKILL.md canonical list (the superset). This eliminates the two-"correct"-formats drift the memo fix would otherwise inherit.

**Before (line 793, inside the tag list):**
```
...from: frontend, backend, auth, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library...
```

**After:**
```
...from: frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library...
```

## Verification Plan

### Automated Tests
- Add a unit test asserting `_buildMemoPlannerPrompt` output contains the substrings `**Complexity:**`, `**Tags:**`, the full allowed tag vocabulary (including `authentication`), and `**Project:**`. Since `_buildMemoPlannerPrompt` is private, test via the public `memoGeneratePrompt` webview message path or extract the prompt body into a testable pure function (preferred: extract `_buildMemoPlannerPrompt` body to a module-level exported `buildMemoPlannerPromptBody(issues, plansDir, projectName?)` and have the method delegate to it — minimal refactor, no behavior change).
- Assert that when `projectName` is undefined, the prompt still instructs the `**Project:**` line is conditional (the `PROJECT_LINE_DIRECTIVE` is simply not appended, which is existing behavior).
- Run `npm test` (or the project's test command) and confirm the new test plus the existing `agentPromptBuilder.test.ts` suite pass.

### Manual Verification
1. Open the Memo sub-tab, add a test entry, click "Copy Prompt".
2. Inspect the clipboard prompt: confirm the `## Plan File Format` block lists `**Complexity:**`, `**Tags:**` (with the vocabulary), and `**Project:**`.
3. Send the prompt to a planner agent against a scratch workspace; confirm the produced plan file's `## Metadata` contains `**Complexity:** N`, `**Tags:**` from the allowed list, and (when a project is active) `**Project:** <name>`.
4. Confirm the plan imports into the kanban board with the correct complexity score and project pin (visible in the card metadata).
