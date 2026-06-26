# Bug: Memo Targets Wrong .switchboard Directory in Multi-Parent Workspaces

## Goal

### Problem
In a workspace with multiple parent directories that each have their own
`.switchboard` folder, the memo feature in `implementation.html` (and when
activated via the agent `memo` skill) may write to the wrong `.switchboard`
directory. It should always target the root workspace that the kanban board is
showing — the canonical/effective workspace root — not a nested child folder's
`.switchboard`.

### Background
The memo feature writes to `.switchboard/memo.md`. The path is resolved in
`TaskViewerProvider.ts`:

```typescript
private _getMemoPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.switchboard', 'memo.md');
}
```

The memo message handlers (`memoLoad`, `memoSave`, `memoClear`,
`memoGeneratePrompt` at lines 9590-9644) all resolve the workspace root via:

```typescript
const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
if (!workspaceRoot) { break; }
const memoPath = this._getMemoPath(workspaceRoot);
```

`_resolveWorkspaceRoot` (lines 1100-1120) resolves in this order:
1. Explicit `data.workspaceRoot` argument, if it's in the allowed roots.
2. `this._kanbanProvider?.getCurrentWorkspaceRoot()` (the kanban board's root),
   if valid.
3. Fallback: `this._getWorkspaceRoots()[0]` — the first workspace folder.

The webview (`implementation.html`) sends `currentWorkspaceRoot` as
`data.workspaceRoot`. `currentWorkspaceRoot` is initialized from the
`initialState` message's `workspaceRoot` and updated by `workspaceChanged`
messages. A code comment at implementation.html lines 2174-2176 explicitly
acknowledges the risk:

```javascript
// NOTE: currentWorkspaceRoot MUST be set before this block —
// switchAgentTab('memo') fires memoLoad with workspaceRoot:
// currentWorkspaceRoot, and an empty value would force the host
// to fall back to a possibly-wrong workspace root.
```

### Root Cause
`_resolveWorkspaceRoot` returns the **raw** workspace root, but does NOT pass it
through `resolveEffectiveWorkspaceRoot` (the workspace-database mapping that
collapses a child folder to its canonical parent). Compare with
`_resolveStateWorkspaceRoot` (lines 1156-1161) which DOES:

```typescript
private _resolveStateWorkspaceRoot(workspaceRoot?: string): string | null {
    const selectedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!selectedWorkspaceRoot) { return null; }
    return this._kanbanProvider?.resolveEffectiveWorkspaceRoot(selectedWorkspaceRoot) || selectedWorkspaceRoot;
}
```

So in a multi-parent setup where:
- The kanban board's effective root is `/Users/patrick/parent` (via
  workspace-database mappings), and
- The implementation panel's `currentWorkspaceRoot` is
  `/Users/patrick/parent/child` (a child folder with its own `.switchboard`),

the memo handlers resolve to `/Users/patrick/parent/child/.switchboard/memo.md`
instead of `/Users/patrick/parent/.switchboard/memo.md` (where the kanban board
lives). The memo is written to the child's `.switchboard`, invisible to the
kanban board's plan-processing flow.

The same flaw affects the agent `memo` skill: the skill protocol (in
`.agents/workflows/memo.md`) instructs the agent to append to
`.switchboard/memo.md`, but the agent resolves the path from its own working
directory / workspace root, which may be the child folder, not the effective
parent.

**Bug status: STILL PRESENT** (verified in source). The memo handlers use
`_resolveWorkspaceRoot` (raw) instead of `_resolveStateWorkspaceRoot`
(effective).

## Metadata
**Tags:** bug, memo, workspace-resolution, multi-workspace, implementation-panel
**Complexity:** 4
**Repo:** switchboard (source at `/Users/patrickvuleta/Documents/GitHub/switchboard`)

## Complexity Audit

### Routine
1. Change the four memo handlers to use `_resolveStateWorkspaceRoot` instead of
   `_resolveWorkspaceRoot`, so the effective (mapped parent) root is used.
2. The `_getMemoPath` helper itself needs no change — it just receives the
   correct root.

### Complex / Risky
1. **`resolveEffectiveWorkspaceRoot` dependency on kanban provider.** The memo
   handlers live in `TaskViewerProvider`. `_resolveStateWorkspaceRoot` delegates
   to `this._kanbanProvider?.resolveEffectiveWorkspaceRoot(...)`. If the kanban
   provider is null (not yet initialized), the effective resolution is skipped
   and the raw root is used. This is the same fallback behavior as
   `_resolveStateWorkspaceRoot` — acceptable, but means the bug could persist if
   memo is used before the kanban provider initializes. Low risk in practice
   (kanban initializes at activation).
2. **Agent skill path.** The agent `memo` skill (`.agents/workflows/memo.md`)
   instructs the agent to append to `.switchboard/memo.md`. The agent resolves
   the path from its own context (the working directory of the terminal it runs
   in). If the agent's CWD is a child folder, it writes to the child's
   `.switchboard`. The extension-side fix doesn't cover the agent-skill path.
   The skill SKILL.md / workflow must instruct the agent to resolve the
   effective workspace root (the kanban board's root) before writing. This is a
   documentation/protocol fix in addition to the code fix.

## Edge-Case & Dependency Audit

- **No workspace-database mappings configured:** `resolveEffectiveWorkspaceRoot`
  returns the input unchanged. No behavior change for single-workspace setups.
- **Memo file doesn't exist yet:** `memoLoad` catches the read error and returns
  empty content. Using the effective root doesn't change this — the file just
  gets created at the correct location on first `memoSave`.
- **`memoGeneratePrompt` dispatch:** This handler builds a planner prompt and
  dispatches to the planner role. It already uses the resolved `workspaceRoot`
  for dispatch. Using the effective root ensures the dispatch also targets the
  correct workspace. Confirm `dispatchCustomPromptToRole` handles the effective
  root correctly (it should — it's the same root the kanban board uses).
- **Backward compatibility:** Existing memo content in a child `.switchboard`
  would become invisible after the fix (the memo now reads from the parent).
  If users have existing memos in child folders, they'd need to migrate them.
  Since the memo is a transient capture buffer (cleared on `process memo`), this
  is low-impact. No migration needed — at worst an in-progress memo in a child
  folder is orphaned.

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

**Change 1 — Use effective workspace root in all four memo handlers (lines 9590,
9601, 9610, 9617).**

Replace each occurrence of:
```typescript
const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
```
with:
```typescript
const workspaceRoot = this._resolveStateWorkspaceRoot(data.workspaceRoot);
```

Specifically in `memoLoad` (line 9591), `memoSave` (line 9602), `memoClear`
(line 9611), and `memoGeneratePrompt` (line 9618).

This routes the memo path through `resolveEffectiveWorkspaceRoot`, so a child
folder's `currentWorkspaceRoot` collapses to the kanban board's canonical parent
root. `_getMemoPath` then produces
`<effective-parent-root>/.switchboard/memo.md`.

**Change 2 — Guard against null effective root.**

`_resolveStateWorkspaceRoot` returns `string | null`. The existing handlers
already guard `if (!workspaceRoot) { break; }`, so the null case is handled. No
additional guard needed, but confirm the `break` doesn't silently swallow the
error — consider posting a `memoError` message to the webview so the user knows
the memo couldn't resolve a workspace:

```typescript
const workspaceRoot = this._resolveStateWorkspaceRoot(data.workspaceRoot);
if (!workspaceRoot) {
    this._view?.webview.postMessage({ type: 'memoError', message: 'No workspace folder found for memo.' });
    break;
}
```

### File: `.agents/workflows/memo.md` (and `.claude/skills/memo/SKILL.md`)

**Change 3 — Instruct the agent skill to resolve the effective workspace root.**

Add a directive to the memo workflow that the agent must write to the kanban
board's root `.switchboard/memo.md`, not a nested child folder's. The agent
should resolve the effective root by checking for a `.switchboard/workspace-id`
or `db-pointer` file in the nearest ancestor that the kanban board uses, or by
querying the kanban board's active workspace. Concretely, add to the workflow:

```markdown
### Workspace Root Resolution (Multi-Workspace)

In a workspace with multiple parent directories that each have their own
`.switchboard` folder, the memo file MUST be written to the root workspace that
the kanban board is showing — the effective/canonical parent root — NOT a nested
child folder's `.switchboard`.

To resolve the correct root:
1. Check for `.switchboard/workspace-id` and `.switchboard/db-pointer` in the
   nearest ancestor directory that the kanban board uses.
2. If the current working directory is a child folder with its own
   `.switchboard`, walk up to the parent that the kanban board's database
   mapping points to.
3. When in doubt, prefer the topmost ancestor that contains a
   `.switchboard/kanban.db`.
```

## Verification Plan

1. **Repro on current build:** In a multi-parent workspace (parent with
   `.switchboard/kanban.db` + child with its own `.switchboard`), open the
   implementation panel from the child folder, enter memo capture, and add an
   entry. Confirm the entry is written to the child's
   `.switchboard/memo.md` (bug) and is invisible to the kanban board's
   `process memo`.
2. **Apply the fix** and rebuild.
3. **Multi-parent memo test:** Repeat the repro. Confirm the memo entry is
   written to the PARENT's `.switchboard/memo.md` (the kanban board's root).
   Confirm `process memo` from the kanban board sees and processes the entry.
4. **Single-workspace regression test:** In a single-workspace setup (no
   mappings), enter memo capture and add an entry. Confirm it writes to the
   same `.switchboard/memo.md` as before (no behavior change).
5. **memoGeneratePrompt test:** In a multi-parent setup, run "process memo"
   (memoGeneratePrompt with action 'send'). Confirm the planner dispatch
   targets the effective parent workspace, not the child.
6. **Agent skill test:** Activate the memo skill from a child folder's agent
   terminal. Confirm the agent writes to the parent's `.switchboard/memo.md`
   per the updated workflow instructions.
7. **Null-root guard test:** Simulate a context with no workspace folders.
   Confirm the `memoError` message appears in the webview instead of a silent
   failure.
