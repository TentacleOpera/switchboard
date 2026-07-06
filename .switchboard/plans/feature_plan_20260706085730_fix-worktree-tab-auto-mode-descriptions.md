# Fix Worktree Tab Features Auto Mode Descriptions

## Goal

In the Worktrees tab of `kanban.html`, the Features section's "Auto Mode" radio buttons have incomplete/incorrect descriptions:
1. The "None" radio description is incomplete — it should explain that manual button creation is available for individual project or feature worktrees.
2. The "Per Subtask" radio description should mention that subagents can work in parallel.

### Problem Analysis & Root Cause

The auto mode options are defined at lines **10000-10004** of `src/webview/kanban.html` (verified against current source; an earlier draft of this plan cited 10021-10024, which was off by ~20 lines):
```javascript
const AUTO_MODE_OPTIONS = [
    { value: 'none', label: 'None', desc: 'No automatic worktrees — use the manual button below.' },
    { value: 'per-subtask', label: 'Per Subtask', desc: 'Provision a dedicated worktree for every subtask added to a feature.' },
    { value: 'high-low', label: 'High/Low Complexity Split', desc: 'Provision two tier worktrees (high & low complexity) off the feature integration branch; the planner consolidates subtasks into two plans run in parallel.' }
];
```

The "None" description says "use the manual button below" but doesn't explain what the manual button does (create individual worktrees for a single project or feature to keep work isolated). The "Per Subtask" description doesn't mention the key benefit — parallel subagent work.

**Manual-button reality (verified):** There is no single "manual button." The Features section has a "Create Feature Worktree" button at line 10065, and the separate Projects section below it has a "Create Project Worktree" button at line 10145 (plus an unbound creation button at line 10191). The original copy's singular "the manual button below" referred only to the feature button immediately below the radios. Because the corrected description's scope intentionally spans both project and feature manual creation, the wording must use plural "buttons" to stay accurate.

**Parallel-subagent claim (verified):** The per-subtask mode genuinely enables parallel subagent work. `src/services/agentPromptBuilder.ts:463` (`FEATURE_ORCHESTRATION_DIRECTIVE_PER_SUBTASK`) explicitly instructs the agent to "dispatch one subagent per subtask into its assigned worktree path below, so subagents cannot collide on files." So adding "so that subagents can work in parallel" to the description is factually grounded, not marketing.

## Metadata

- **Tags:** ui
- **Complexity:** 1
- **Plan ID:** 8a7c3f2e-1b4d-4e9a-b6c2-7f5e8d0a1234

## User Review Required

Yes — lightweight. The two description strings are user-facing copy. Before coding, the user should confirm the final "None" wording (plural "buttons" vs. naming the Features/Projects sections explicitly) matches their intent, since the original plan's singular "button" was corrected during review. No other review gate; the change is text-only and has no behavioral impact.

## Complexity Audit

### Routine
- Text-only edits to two `desc` string literals inside a static array (`AUTO_MODE_OPTIONS`, `src/webview/kanban.html:10000-10004`).
- No logic, no backend, no schema, no message-contract change. Radio `value`s (`'none'`, `'per-subtask'`, `'high-low'`) are unchanged, so `setFeatureWorktreeMode` handling at `KanbanProvider.ts:8752-8756` (which validates against exactly those three modes) is unaffected.
- Rendering uses `descSpan.textContent = opt.desc` at line 10030 — plain-text assignment, no HTML parsing, no injection surface.
- Layout is a flex column that wraps; no string-length limit applies.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `AUTO_MODE_OPTIONS` is a `const` array literal built once per panel render (`createWorktreesPanel`, called from line 9694). No concurrent mutation path.
- **Security:** None. `textContent` assignment means even if a description contained `<` or `&`, it would render as literal text, not parsed HTML. No `innerHTML`, no `insertAdjacentHTML`, no template interpolation.
- **Side Effects:** None. The `desc` field is display-only; it is not read back by any handler, not persisted to `kanban.db`, and not sent in any `postKanbanMessage` payload (only `opt.value` is sent at line 10019).
- **Dependencies & Conflicts:** None. No other file references the `desc` strings. The `label`/`value` fields are untouched. No migration concern (this is unreleased dev copy on a feature branch; even if shipped, desc text is not persisted user state).

## Dependencies

- None. This plan is self-contained — a single text edit to one static array in one file.

## Adversarial Synthesis

Key risks: the original plan cited line numbers off by ~20 (corrected to 10000-10004 / 10030 after opening the file); the proposed singular "the manual button" became misleading once the description's scope expanded to cover both project and feature worktrees (corrected to plural "manual creation buttons" to match the two-button reality at lines 10065 and 10145); and the tags violated the workflow's allowed-vocabulary rule (corrected to `ui`). Mitigations: all line numbers re-verified against current source; wording aligned with the actual UI structure; tags constrained to the allowed list. The "Per Subtask" parallel-subagent claim was verified against `agentPromptBuilder.ts:463` and is accurate.

## Proposed Changes

### `src/webview/kanban.html` — Update AUTO_MODE_OPTIONS descriptions (lines 10000-10004)

**Context:** The `AUTO_MODE_OPTIONS` array is consumed by the `AUTO_MODE_OPTIONS.forEach` loop at line 10005, which builds one radio label per option. Each option's `desc` is rendered as `descSpan.textContent = opt.desc` at line 10030 inside a flex-column text wrapper (line 10024-10032). The `value` field is the only part sent to the backend (`setFeatureWorktreeMode` at line 10018); `desc` is purely informational.

**Logic:** No logic change. Only two string literals in the `desc` fields are edited.

**Implementation:**

**Before (lines 10000-10004, verified):**
```javascript
const AUTO_MODE_OPTIONS = [
    { value: 'none', label: 'None', desc: 'No automatic worktrees — use the manual button below.' },
    { value: 'per-subtask', label: 'Per Subtask', desc: 'Provision a dedicated worktree for every subtask added to a feature.' },
    { value: 'high-low', label: 'High/Low Complexity Split', desc: 'Provision two tier worktrees (high & low complexity) off the feature integration branch; the planner consolidates subtasks into two plans run in parallel.' }
];
```

**After:**
```javascript
const AUTO_MODE_OPTIONS = [
    { value: 'none', label: 'None', desc: 'No automatic worktrees — use the manual creation buttons below to create an individual worktree for a single project or feature to keep work isolated.' },
    { value: 'per-subtask', label: 'Per Subtask', desc: 'Provision a dedicated worktree for every subtask so that subagents can work in parallel.' },
    { value: 'high-low', label: 'High/Low Complexity Split', desc: 'Provision two tier worktrees (high & low complexity) off the feature integration branch; the planner consolidates subtasks into two plans run in parallel.' }
];
```

Key changes:
- **"None" desc:** Expanded to explain the manual buttons' purpose — creating individual worktrees for a single project or feature to keep work isolated. Wording uses plural "manual creation buttons" (Clarification, not a new requirement: the user's stated intent covered both project and feature worktrees, but the original plan's singular "the manual button" was inaccurate because there are two separate manual buttons — "Create Feature Worktree" at line 10065 in the Features section and "Create Project Worktree" at line 10145 in the Projects section). Em dash preserved for consistency with the other two descriptions.
- **"Per Subtask" desc:** Added "so that subagents can work in parallel" to surface the key benefit. Verified accurate against `agentPromptBuilder.ts:463`, which instructs the agent to "dispatch one subagent per subtask...so subagents cannot collide on files." Removed the trailing "added to a feature" clause since "every subtask" already implies the feature context (the radio lives in the Features section).
- **"High/Low" desc:** Unchanged (already complete).

**Edge Cases:** None. The descriptions are display-only plain text. No length limit, no parsing, no persistence.

## Verification Plan

> Per session directives: SKIP compilation (`npm run compile` not required — `src/` is the source of truth and testing is done via installed VSIX) and SKIP automated tests. Verification is manual UI inspection only.

### Automated Tests
- None required (skipped per session directive). The change is text-only with no behavioral surface; no unit test exercises the `desc` string, and none should — it is presentation copy.

### Manual Verification
1. Reload the VSIX (or reload the Kanban webview) so the updated `src/webview/kanban.html` is picked up.
2. Open the Kanban board and switch to the **Worktrees** tab.
3. Scroll to the **Features** section and find the "Auto Mode" radio buttons.
4. Verify the **"None"** radio description reads: "No automatic worktrees — use the manual creation buttons below to create an individual worktree for a single project or feature to keep work isolated."
5. Verify the **"Per Subtask"** radio description reads: "Provision a dedicated worktree for every subtask so that subagents can work in parallel."
6. Verify the **"High/Low Complexity Split"** description is unchanged.
7. Verify the three radio buttons still function correctly — selecting each one posts `setFeatureWorktreeMode` with the correct `mode` value (`'none'` / `'per-subtask'` / `'high-low'`) and the backend accepts it (no validation error in the extension host log).
8. Sanity-check that the longer "None" description wraps cleanly in the flex-column layout (no overflow, no layout break in the radio-option label).

## Recommendation

Complexity is **1** → **Send to Intern**. This is a two-string text edit with no logic, no backend, and no migration surface. Safe to hand to the least-experienced coder; verification is a single visual check.
