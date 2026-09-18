# Bug: Memo Targets Wrong .switchboard Directory in Multi-Parent Workspaces

## Goal

Fix the memo feature so it always writes to the kanban board's canonical
(effective) workspace root — the parent that the board is showing — never a
nested child folder's `.switchboard`, in multi-parent workspace setups.

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
(effective). Confirmed against current source: lines 9591, 9602, 9611, 9618 all
call `_resolveWorkspaceRoot`; `_resolveStateWorkspaceRoot` at lines 1156-1161 is
the effective-resolution variant already used by `_resolveStateFilePath` (line
1164) and ~20 other call sites.

## Metadata
**Tags:** bugfix, backend, frontend, docs
**Complexity:** 4

## User Review Required
Yes — review the scoped-down Change 3 (agent-skill path is best-effort, not a
guaranteed fix) and confirm whether the `memoError` webview handler addition is
desired or whether the silent `break` fallback is acceptable.

## Complexity Audit

### Routine
- Change the four memo handlers to use `_resolveStateWorkspaceRoot` instead of
  `_resolveWorkspaceRoot`, so the effective (mapped parent) root is used.
- The `_getMemoPath` helper itself needs no change — it just receives the
  correct root.
- Add a 4-line `case 'memoError'` handler in the webview message switch (only
  if Change 2's postMessage is kept).

### Complex / Risky
- **`resolveEffectiveWorkspaceRoot` dependency on kanban provider.** The memo
  handlers live in `TaskViewerProvider`. `_resolveStateWorkspaceRoot` delegates
  to `this._kanbanProvider?.resolveEffectiveWorkspaceRoot(...)`. If the kanban
  provider is null (not yet initialized), the effective resolution is skipped
  and the raw root is used. This is the same fallback behavior as
  `_resolveStateWorkspaceRoot` — acceptable, but means the bug could persist if
  memo is used before the kanban provider initializes. Low risk in practice
  (kanban initializes at activation).
- **Agent skill path (best-effort, NOT guaranteed).** The agent `memo` skill
  (`.agents/workflows/memo.md`) instructs the agent to append to
  `.switchboard/memo.md`. The agent resolves the path from its own context (the
  working directory of the terminal it runs in). If the agent's CWD is a child
  folder, it writes to the child's `.switchboard`. The extension-side fix
  doesn't cover the agent-skill path. A documentation/protocol update can only
  provide a best-effort heuristic — the agent has no runtime access to the
  kanban board's active workspace mapping, so a guaranteed fix would require a
  new extension API surface, which is out of scope for this plan.

## Edge-Case & Dependency Audit

- **No workspace-database mappings configured:** `resolveEffectiveWorkspaceRoot`
  returns the input unchanged. No behavior change for single-workspace setups.
- **Memo file doesn't exist yet:** `memoLoad` catches the read error and returns
  empty content. Using the effective root doesn't change this — the file just
  gets created at the correct location on first `memoSave`.
- **`memoGeneratePrompt` dispatch:** This handler builds a planner prompt and
  dispatches to the planner role. It uses the resolved `workspaceRoot` for
  dispatch (line 9636) and for `_buildMemoPlannerPrompt` (line 9630) and the
  post-success `_getMemoPath` clear (line 9648). Using the effective root ensures
  the dispatch also targets the correct workspace. `dispatchCustomPromptToRole`
  already accepts effective roots (it's the same root the kanban board uses).
- **Backward compatibility:** No data migration needed. The memo is a transient
  capture buffer (cleared on `process memo`). An in-progress memo in a child
  folder may become orphaned after the fix (the memo now reads from the parent);
  this is low-impact because the content is transient and the user can re-enter
  it. No `*.migrated.bak` archival required.
- **Unmapped-parent mkdir (low priority):** If a workspace-database mapping
  points to a parent that is not an opened workspace folder, `memoSave` would
  `mkdir -p` a fresh `.switchboard` in an unopened folder. This implies
  misconfiguration of the mapping index, not a flaw in this fix. Note only; do
  not block.
- **`memoError` postMessage (verified gap):** The webview message switch
  (`implementation.html` lines 2183-2198) handles `memoContent` and
  `memoPromptResult` but has NO `memoError` case. Any `memoError` postMessage is
  silently dropped. Change 2 must either add the handler or drop the postMessage.

## Dependencies
- None. This is a self-contained bugfix with no prerequisite plans.

## Adversarial Synthesis
Key risks: (1) the proposed `memoError` postMessage has no webview handler and is
currently dead code — must add a `case 'memoError'` in the webview or drop the
postMessage; (2) the agent-skill path cannot be reliably fixed by documentation
alone (the agent has no runtime access to the kanban board's mapping) and must
be marked best-effort, not guaranteed. Mitigations: add the 4-line webview
handler to complete the feedback loop; reword Change 3 as a best-effort
heuristic with an explicit non-guarantee and drop the broken "topmost kanban.db"
rule.

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

**Change 1 — Use effective workspace root in all four memo handlers (lines 9591,
9602, 9611, 9618).**

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

This matches the established pattern: `_resolveStateFilePath` (line 1164) already
uses `_resolveStateWorkspaceRoot`, and ~20 other call sites in
`TaskViewerProvider.ts` apply `resolveEffectiveWorkspaceRoot` directly.

**Change 2 — Guard against null effective root (with a working feedback loop).**

`_resolveStateWorkspaceRoot` returns `string | null`. The existing handlers
already guard `if (!workspaceRoot) { break; }`, so the null case is handled. To
make the failure observable (instead of a silent `break`), post a `memoError`
message to the webview — BUT this requires a matching webview handler (see
Change 2b), otherwise the postMessage is dead code.

```typescript
const workspaceRoot = this._resolveStateWorkspaceRoot(data.workspaceRoot);
if (!workspaceRoot) {
    this._view?.webview.postMessage({ type: 'memoError', message: 'No workspace folder found for memo.' });
    break;
}
```

Apply this guard to all four handlers (`memoLoad`, `memoSave`, `memoClear`,
`memoGeneratePrompt`).

> **Clarification:** If the team prefers to keep the null path silent (it is an
> extreme edge case — no workspace folders open at all), drop the `memoError`
> postMessage and keep the bare `break`. The core fix (Change 1) does not depend
> on this. The user-review item above covers this decision.

### File: `src/webview/implementation.html`

**Change 2b — Add a `memoError` case to the webview message switch (only if
Change 2's postMessage is kept).**

Insert a new case adjacent to `memoContent` (line 2183) and `memoPromptResult`
(line 2194):

```javascript
case 'memoError': {
    const statusEl = document.getElementById('memo-status');
    if (statusEl) { statusEl.textContent = message.message || 'Memo error'; }
    break;
}
```

This reuses the existing `#memo-status` element already written by
`memoPromptResult`, so no new DOM is required. Without this handler, Change 2's
`memoError` postMessage is silently dropped (verified: no `memoError` case
exists today).

### File: `.agents/workflows/memo.md` (and `.claude/skills/memo/SKILL.md`)

**Change 3 — Best-effort workspace-root resolution directive for the agent skill
(NOT a guaranteed fix).**

Add a directive to the memo workflow that the agent should write to the kanban
board's root `.switchboard/memo.md`, not a nested child folder's. Because the
agent has no runtime access to the kanban board's active workspace mapping, this
is a **best-effort heuristic, not a guarantee**. The reliable path is the
sidebar Memo sub-tab (backend-driven), which is already correct after Change 1.

```markdown
### Workspace Root Resolution (Multi-Workspace) — BEST EFFORT

In a workspace with multiple parent directories that each have their own
`.switchboard` folder, the memo file SHOULD be written to the root workspace
that the kanban board is showing — the effective/canonical parent root — NOT a
nested child folder's `.switchboard`.

The agent cannot query the kanban board's runtime mapping. Use this best-effort
heuristic:
1. If the current working directory's `.switchboard/workspace-id` matches the
   kanban board's active workspace, use the current directory.
2. Otherwise, walk up to the nearest ancestor that contains a
   `.switchboard/workspace-id` corresponding to the kanban board's active
   workspace.
3. If no ancestor's workspace-id can be determined, prefer the nearest ancestor
   that contains a `.switchboard` directory that is NOT the current folder.
4. If undeterminable, fall back to the current directory and warn the user that
   the memo may be invisible to the kanban board's `process memo`.

NOTE: This heuristic is NOT guaranteed. For reliable capture in multi-parent
workspaces, use the Memo sub-tab in the sidebar (backend-driven, immune to this
resolution ambiguity).
```

> **Do NOT use a "topmost ancestor with `.switchboard/kanban.db`" rule** — the
> bug scenario is precisely that multiple ancestors each have their own
> `kanban.db`, so "topmost" picks the wrong one half the time.

## Verification Plan

> Per session directives: skip compilation and automated test execution. The
> steps below are manual/functional verification for the user to run after
> implementation. Automated tests are listed for the user to run separately.

### Automated Tests
- Deferred to the user. Suggested coverage if added later: a unit test for
  `TaskViewerProvider` memo handlers asserting `_resolveStateWorkspaceRoot` is
  used (stub `resolveEffectiveWorkspaceRoot` to remap child→parent and assert
  `_getMemoPath` receives the parent). No new tests are required by this plan.

### Manual Verification
1. **Repro on current build:** In a multi-parent workspace (parent with
   `.switchboard/kanban.db` + child with its own `.switchboard`), open the
   implementation panel from the child folder, enter memo capture, and add an
   entry. Confirm the entry is written to the child's
   `.switchboard/memo.md` (bug) and is invisible to the kanban board's
   `process memo`.
2. **Apply the fix** (Change 1, plus 2/2b if adopted, plus 3).
3. **Multi-parent memo test:** Repeat the repro. Confirm the memo entry is
   written to the PARENT's `.switchboard/memo.md` (the kanban board's root).
   Confirm `process memo` from the kanban board sees and processes the entry.
4. **Single-workspace regression test:** In a single-workspace setup (no
   mappings), enter memo capture and add an entry. Confirm it writes to the
   same `.switchboard/memo.md` as before (no behavior change).
5. **memoGeneratePrompt test:** In a multi-parent setup, run "process memo"
   (memoGeneratePrompt with action 'send'). Confirm the planner dispatch
   targets the effective parent workspace, not the child.
6. **Agent skill test (best-effort):** Activate the memo skill from a child
   folder's agent terminal. Confirm the agent follows the heuristic and writes
   to the parent's `.switchboard/memo.md` where determinable; where not
   determinable, confirm it warns the user per Change 3.
7. **Null-root guard test (only if Change 2/2b adopted):** Simulate a context
   with no workspace folders. Confirm the `memoError` message appears in
   `#memo-status` in the webview instead of a silent failure.

## Recommendation
Complexity 4 → **Send to Coder**. The core fix is a 4-line mechanical swap
following an established pattern; the webview handler (Change 2b) is a 4-line
addition; Change 3 is a documentation append. No architectural risk, no data
migration, no new dependencies.

---

## Code Review Pass (Reviewer-Executor)

### Stage 1 — Grumpy Principal Engineer

> **"Let me see if you actually read the plan you wrote, or just waved at it."**

**Change 1 — The four-handler swap.** `TaskViewerProvider.ts:9775,9789,9801,9811`. All four memo handlers (`memoLoad`, `memoSave`, `memoClear`, `memoGeneratePrompt`) now call `_resolveStateWorkspaceRoot(data.workspaceRoot)` instead of `_resolveWorkspaceRoot(data.workspaceRoot)`. This is the exact mechanical swap the plan demanded. The `_resolveStateWorkspaceRoot` method at line 1247 delegates to `resolveEffectiveWorkspaceRoot`, collapsing child→parent. **VERIFIED CORRECT.** Not bad. For once.

**Change 2 — The `memoError` postMessage guard.** All four handlers now post `{ type: 'memoError', message: 'No workspace folder found for memo.' }` before `break` on the null-root path. Lines 9777, 9791, 9803, 9813. **VERIFIED CORRECT.** The plan offered a clarification that the team could drop this in favor of a silent `break` — the implementer chose to keep it. Fine. But it's dead code without the webview handler, which brings me to...

**Change 2b — The webview `memoError` case.** `implementation.html:2193-2197`. A `case 'memoError'` block exists, writing `message.message || 'Memo error'` to `#memo-status`. **VERIFIED CORRECT.** The feedback loop is closed. Good. I was ready to scream if this was missing.

**Change 3 — The agent-skill workspace-root directive.** `.agents/workflows/memo.md:84-94` has the full "Workspace Root Resolution (Multi-Workspace) — BEST EFFORT" section with the 4-step heuristic and the non-guarantee note. **VERIFIED CORRECT** for the workflows file.

> **BUT.** The plan says — and I quote — `### File: .agents/workflows/memo.md (and .claude/skills/memo/SKILL.md)`. That "(and ...)" is not decorative. It means BOTH files get the directive. `.claude/skills/memo/SKILL.md` has **ZERO** mention of workspace root resolution. The Claude Code host reads from `.claude/skills/`, not `.agents/workflows/`. So every Claude Code agent using the memo skill in a multi-parent workspace gets **no guidance at all** and blithely writes to the child folder. This is a **MAJOR** finding — the fix is incomplete for an entire host platform.

**Severity: MAJOR** — `.claude/skills/memo/SKILL.md` missing the workspace root resolution directive specified in Change 3.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Disposition |
| :--- | :--- | :--- |
| Change 1 (four-handler swap) | — | **Keep.** Verified correct, matches plan exactly. |
| Change 2 (`memoError` postMessage) | — | **Keep.** Verified correct, all four handlers covered. |
| Change 2b (webview `memoError` case) | — | **Keep.** Verified correct, feedback loop closed. |
| Change 3 missing from `.claude/skills/memo/SKILL.md` | MAJOR | **Fix now.** The plan explicitly names both files; the Claude Code host reads from `.claude/skills/`. Without this, the agent-skill path is completely unguided on Claude Code. |

### Fixes Applied

- **`.claude/skills/memo/SKILL.md`**: Added the "Workspace Root Resolution (Multi-Workspace) — BEST EFFORT" section (lines 87-97) with the identical 4-step heuristic and non-guarantee note from `.agents/workflows/memo.md`. This completes Change 3 for the Claude Code host.

### Files Changed by Review

| File | Change |
| :--- | :--- |
| `.claude/skills/memo/SKILL.md` | Added workspace root resolution directive (Change 3 completion) |

### Verification Results

- **Compilation:** Skipped per session directives.
- **Tests:** Skipped per session directives.
- **Code inspection:** All four memo handlers verified at `TaskViewerProvider.ts:9775,9789,9801,9811` — use `_resolveStateWorkspaceRoot`. Webview `memoError` case verified at `implementation.html:2193-2197`. Both memo skill files now contain the workspace root resolution directive.

### Remaining Risks

- **Agent-skill path is best-effort, not guaranteed.** Even with the directive in both skill files, the agent has no runtime access to the kanban board's workspace mapping. The heuristic relies on `.switchboard/workspace-id` file presence and may fail in edge cases. This is documented and accepted per the plan's Complexity Audit.
- **Null kanban provider.** If memo is used before kanban provider initialization, `_resolveStateWorkspaceRoot` falls back to the raw root. Low risk (kanban initializes at activation). Documented in the plan's Complexity Audit.
- **Orphaned in-progress memos.** An in-progress memo in a child folder becomes invisible after the fix (memo now reads from the parent). Low-impact (transient content). Documented in the plan's Edge-Case Audit.
