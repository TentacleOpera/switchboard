# Memo Process Prompt: Add Complexity Ratings & Correct Metadata Format

## Goal

The memo "process memo" / "Send to Planner" path generates plans with inconsistent or missing metadata — specifically missing `**Complexity:**` numeric ratings, free-form tags outside the allowed vocabulary, and missing `**Project:**` pin lines. Bring the memo planner prompt's `## Plan File Format` section in line with the explicit metadata format already enforced by the chat prompt button (`DEFAULT_CHAT_BASE_INSTRUCTIONS` Rule #5) and the `improve-plan` SKILL.md workflow, so all plan-producing paths emit identical metadata instructions.

### Problem Analysis & Root Cause

**Symptom:** Plans produced from the Memo sub-tab's "Send to Planner" / "Copy Prompt" button frequently land in `.switchboard/plans/` with a `## Metadata` section that says only `tags, complexity 1-10` as a vague header, with no `**Complexity:** N` numeric field, invented tags, and no `**Project:**` line. This breaks downstream kanban import parsing (complexity-based routing, tag filtering, project pinning).

**Root cause:** The memo planner prompt is built by a standalone helper, `_buildMemoPlannerPrompt` in `src/services/TaskViewerProvider.ts` (private method at line 3979, invoked from the `memoGeneratePrompt` webview message handler at line 11638 for both the "copy" and "send" sub-tab actions). It bypasses the canonical prompt builder (`buildKanbanBatchPrompt` / `DEFAULT_CHAT_BASE_INSTRUCTIONS`) and does not prepend the `improve-plan` SKILL.md workflow. Its `## Plan File Format` block (lines 3998-4007) lists the section names but gives only a vague one-liner for Metadata:

```
- ## Metadata (tags, complexity 1-10)
```

It never tells the agent:
- to write a numeric `**Complexity:**` rating (1-10),
- the exact allowed `**Tags:**` vocabulary,
- to write `**Project:**` when a PROJECT PIN directive is present.

**Reference (the "correct format"):** The chat prompt button emits `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`src/services/agentPromptBuilder.ts:786-806`), whose Rule #5 (line 793) specifies the exact format:

> Every plan must have a descriptive H1 title (never generic), and a `## Metadata` section with `**Complexity:**` (1–10), `**Tags:**` (comma-separated, from: frontend, backend, auth, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library), and `**Project:**` (if the PROJECT PIN directive is present, write the exact project name specified).

The `improve-plan` SKILL.md (verified lines 34-38) specifies the same with an expanded tag list (adds `authentication`) and a `**Repo:**` line. The memo prompt matches neither.

**Secondary drift (confirmed):** The tag vocabulary is inconsistent between the two canonical sources — `DEFAULT_CHAT_BASE_INSTRUCTIONS` (agentPromptBuilder.ts:793) omits `authentication` while `improve-plan` SKILL.md (line 35) includes it. This plan reconciles to the SKILL.md list (the planner workflow's source of truth, and the superset) and syncs the chat-base list up to match, so a coder is never handed two "correct" formats.

## Metadata

- **Tags:** backend, refactor, bugfix
- **Complexity:** 2

## User Review Required

- **None.** This is a copy/reconcile of an already-canonical metadata format into a third prompt surface. No product decision. (Note: this plan deliberately does NOT alter `improve-plan` SKILL.md's `**Repo:**` line — see Edge-Case audit — because this workspace is single-repo and the memo prompt has no repo concept.)

## Complexity Audit

### Routine
- Single-function edit to a string template literal in one TypeScript file (`TaskViewerProvider.ts`), plus a one-word tag-list addition in `agentPromptBuilder.ts`.
- No control-flow, type, or API-surface changes — only prompt text content.
- The correct format already exists verbatim in `DEFAULT_CHAT_BASE_INSTRUCTIONS` and the `improve-plan` SKILL.md; this is a copy/reconcile, not new design.
- No database, no IPC, no webview contract change — the `memoGeneratePrompt` message handler and `_buildMemoPlannerPrompt` signature are untouched.

### Complex / Risky
- Tag-vocabulary reconciliation: choosing the canonical list affects plan import parsing. Picking the SKILL.md superset (with `authentication`) is safe because the importer only validates against a known set and ignores extras silently, but `DEFAULT_CHAT_BASE_INSTRUCTIONS` MUST be kept in sync (this plan does that) to avoid two "correct" formats drifting again.
- **Regression guard:** `src/test/prompt-split-guidance-sync.test.js` asserts that `_buildMemoPlannerPrompt`'s source keeps its Instructions step 5 splitting rule ("3+ distinct deliverables", "2+ independently-shippable phases") and the Important-section splitting reference. This plan's edit is confined to the `## Plan File Format` block (lines 3998-4007) and does NOT touch those lines (3996 / 4010), so the sync test stays green. Do not reword the splitting lines while editing the format block.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `_buildMemoPlannerPrompt` is a pure synchronous string builder called from the `memoGeneratePrompt` webview message handler. No shared mutable state.
- **Security:** No new prompt-injection surface; the inserted text is a static format spec, not user-controlled.
- **Side Effects:** Plans created via the memo path will now consistently carry `**Complexity:**`, `**Tags:**`, and `**Project:**` — improving kanban import, complexity routing, and project filtering. No regression for plans that previously happened to include these fields.
- **Dependencies & Conflicts:**
  - The `PROJECT_LINE_DIRECTIVE` is already appended after the prompt body (`TaskViewerProvider.ts:4015-4017`) when a project is active, so the new `**Project:**` instruction in the format spec is consistent with the existing directive — no conflict. The `_parseMemoEntries` helper and `dispatchCustomPromptToRole` flow are untouched.
  - **Shared-file coordination with the sibling grouping subtask:** the sibling subtask ("Memo Capture Should Prompt Agent to Suggest Feature Groupings When Relevant") also edits `_buildMemoPlannerPrompt`, but a **disjoint region** — the feature-grouping offer bullet at line ~4013 (Important section), not the `## Plan File Format` block this plan owns (lines 3998-4007). No overlap; the two edits are independently applicable. See the feature file's Dependencies & sequencing for the recommended landing order.
  - **`**Repo:**` deliberately NOT added:** the canonical `improve-plan` metadata spec includes a `**Repo:**` line, but this workspace is single-repo and the memo prompt targets one workspace root. Adding a repo field to the memo format spec would invite an inapplicable line. Omit it. (This plan's own metadata block above also omits `**Repo:**` for the same reason.)

## Adversarial Synthesis

Key risks: (1) editing the format block adjacent to the splitting-guidance lines that a sync test asserts on — mitigated by confining the edit to the `## Plan File Format` bullet and leaving the Instructions/Important splitting lines byte-for-byte intact; (2) reconciling tag vocab in only one of the two canonical sources, re-creating the drift — mitigated by syncing `DEFAULT_CHAT_BASE_INSTRUCTIONS` up to the SKILL.md superset in the same change. Both are low-severity, prompt-text-only risks with no runtime or data-integrity exposure.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `_buildMemoPlannerPrompt` (`## Plan File Format` block, lines ~3998-4007)

Replace the vague `## Plan File Format` Metadata bullet with the explicit format spec matching the chat prompt button / `improve-plan` SKILL.md.

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

This mirrors `DEFAULT_CHAT_BASE_INSTRUCTIONS` Rule #5 and the `improve-plan` SKILL.md `## Metadata` spec, so all three plan-producing paths (chat prompt button, kanban planner dispatch, memo process) emit identical metadata instructions.

**Constraint:** leave the Instructions step 5 (line 3996) and the "Important" bullets (lines 4009-4013) unchanged in this subtask — they carry the splitting-rule signals guarded by `prompt-split-guidance-sync.test.js`, and the grouping-offer bullet (line ~4013) is owned by the sibling subtask.

### `src/services/agentPromptBuilder.ts` — `DEFAULT_CHAT_BASE_INSTRUCTIONS` Rule #5 (line 793) — sync

Add `authentication` to the chat-base tag vocabulary so it matches the `improve-plan` SKILL.md canonical list (the superset). This eliminates the two-"correct"-formats drift the memo fix would otherwise inherit.

**Before (line 793, inside the tag list):**
```
...from: frontend, backend, auth, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library...
```

**After:**
```
...from: frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library...
```

> Note: `agentPromptBuilder.ts:783-784` documents that `DEFAULT_CHAT_BASE_INSTRUCTIONS` must be kept in sync with `.agents/workflows/switchboard-cloud.md`. If that workflow file also enumerates the tag list, add `authentication` there too so the sync contract holds. (Verify during implementation; if the workflow file does not list tags, no change is needed there.)

## Verification Plan

### Automated Tests
- Add/extend a unit test asserting `_buildMemoPlannerPrompt` output contains the substrings `**Complexity:**`, `**Tags:**`, the full allowed tag vocabulary (including `authentication`), and `**Project:**`. `_buildMemoPlannerPrompt` is private — either test via the public `memoGeneratePrompt` webview message path, or extract the prompt body into a testable pure function (`buildMemoPlannerPromptBody(issues, plansDir, projectName?)`) and have the method delegate to it (minimal refactor, no behavior change).
- Assert that when `projectName` is undefined, the prompt still instructs that the `**Project:**` line is conditional (the `PROJECT_LINE_DIRECTIVE` is simply not appended — existing behavior).
- **Do not regress** `src/test/prompt-split-guidance-sync.test.js` — it already asserts on `_buildMemoPlannerPrompt`'s splitting signals and on `DEFAULT_CHAT_BASE_INSTRUCTIONS`. Confirm it still passes after the tag-list edit. (The correct existing test file for the chat-base constant is `src/services/__tests__/agentPromptBuilder.test.ts`.)

### Manual Verification
1. Open the Memo sub-tab, add a test entry, click "Copy Prompt".
2. Inspect the clipboard prompt: confirm the `## Plan File Format` block lists `**Complexity:**`, `**Tags:**` (with the full vocabulary including `authentication`), and `**Project:**`.
3. Send the prompt to a planner agent against a scratch workspace; confirm the produced plan file's `## Metadata` contains `**Complexity:** N`, `**Tags:**` from the allowed list, and (when a project is active) `**Project:** <name>`.
4. Confirm the plan imports into the kanban board with the correct complexity score and project pin (visible in the card metadata).

## Recommendation

Complexity 2 → **Send to Intern.**

## Completion Summary

Replaced the vague `## Plan File Format` Metadata bullet in `src/services/TaskViewerProvider.ts` `_buildMemoPlannerPrompt` with explicit `**Complexity:**`, `**Tags:**`, and `**Project:**` instructions matching the canonical chat/improve-plan format. Synced the `authentication` tag into `DEFAULT_CHAT_BASE_INSTRUCTIONS` in `src/services/agentPromptBuilder.ts` and `.agents/workflows/switchboard-cloud.md`. The `_buildMemoPlannerPrompt` plan-splitting guidance lines were left untouched per the regression guard.
