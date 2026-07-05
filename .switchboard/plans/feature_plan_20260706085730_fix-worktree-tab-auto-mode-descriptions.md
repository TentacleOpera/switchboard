# Fix Worktree Tab Features Auto Mode Descriptions

## Goal

In the Worktrees tab of `kanban.html`, the Features section's "Auto Mode" radio buttons have incomplete/incorrect descriptions:
1. The "None" radio description is incomplete — it should explain that manual button creation is available for individual project or feature worktrees.
2. The "Per Subtask" radio description should mention that subagents can work in parallel.

### Problem Analysis & Root Cause

The auto mode options are defined at lines 10021-10024 of `src/webview/kanban.html`:
```javascript
const AUTO_MODE_OPTIONS = [
    { value: 'none', label: 'None', desc: 'No automatic worktrees — use the manual button below.' },
    { value: 'per-subtask', label: 'Per Subtask', desc: 'Provision a dedicated worktree for every subtask added to a feature.' },
    { value: 'high-low', label: 'High/Low Complexity Split', desc: 'Provision two tier worktrees (high & low complexity) off the feature integration branch; the planner consolidates subtasks into two plans run in parallel.' }
];
```

The "None" description says "use the manual button below" but doesn't explain what the manual button does (create individual worktrees for a single project or feature to keep work isolated). The "Per Subtask" description doesn't mention the key benefit — parallel subagent work.

## Metadata

- **Tags:** ui-cleanup, worktree-tab, descriptions, kanban-html
- **Complexity:** 1

## Complexity Audit

**Routine.** Text-only changes to description strings. No logic changes, no backend changes.

## Edge-Case & Dependency Audit

- The `desc` field is rendered as `descSpan.textContent` (line 10051) — no HTML parsing, so plain text is safe.
- The descriptions are purely informational; they don't affect the radio button values or the backend `setFeatureWorktreeMode` message.
- No string length limits apply (the descriptions are displayed in a flex column layout that wraps).

## Proposed Changes

### `src/webview/kanban.html` — Update AUTO_MODE_OPTIONS descriptions (~lines 10021-10024)

**Before:**
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
    { value: 'none', label: 'None', desc: 'No automatic worktrees, use the manual button to create an individual worktree for a single project or feature to keep work isolated.' },
    { value: 'per-subtask', label: 'Per Subtask', desc: 'Provision a dedicated worktree for every subtask so that subagents can work in parallel.' },
    { value: 'high-low', label: 'High/Low Complexity Split', desc: 'Provision two tier worktrees (high & low complexity) off the feature integration branch; the planner consolidates subtasks into two plans run in parallel.' }
];
```

Key changes:
- "None" desc: Expanded to explain the manual button's purpose — creating individual worktrees for a single project or feature to keep work isolated.
- "Per Subtask" desc: Added "so that subagents can work in parallel" to explain the key benefit.
- "High/Low" desc: Unchanged (already complete).

## Verification Plan

1. Open the Kanban board and switch to the Worktrees tab.
2. Scroll to the Features section and find the "Auto Mode" radio buttons.
3. Verify the "None" radio description reads: "No automatic worktrees, use the manual button to create an individual worktree for a single project or feature to keep work isolated."
4. Verify the "Per Subtask" radio description reads: "Provision a dedicated worktree for every subtask so that subagents can work in parallel."
5. Verify the "High/Low Complexity Split" description is unchanged.
6. Verify the radio buttons still function correctly (selecting one sends the right mode to the backend).
