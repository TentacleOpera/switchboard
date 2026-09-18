# Remove `@` Prefix from All Copy-Link Clipboard Operations

## Goal

Remove the `@` prefix that is prepended to absolute file paths in every "Copy Link" clipboard operation across Switchboard's webviews and extension host, so that pasted paths are clean absolute paths that do not trigger CLI file-reference mechanisms.

### Problem

Every "Copy Link" button in Switchboard's webviews prepends an `@` character to the absolute file path before writing it to the clipboard. Example output:

```
@/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/epics/epic-3051b25c-35ae-48c8-9d21-b70436e0c8a2.md
```

The `@` prefix was originally added as an "agent-safe file reference" — the intent was that when pasted into an AI CLI (Claude Code, Cursor, etc.), the `@` would trigger the CLI's file-reference mechanism to inline the file contents.

### Root Cause

The `@` prefix is added in two layers:
1. **Frontend (webview JS):** A shared utility function `toAgentRef()` in `sharedUtils.js` prepends `@` to any path that doesn't already start with one. Both `planning.js` and `project.js` call this function in their Kanban plan "Copy Link" button handlers.
2. **Backend (extension host TS):** Several message handlers in `PlanningPanelProvider.ts` and `DesignPanelProvider.ts` independently prepend `@` before calling `vscode.env.clipboard.writeText()`.

### Why It's Unwanted

When the user pastes the copied path into a CLI, the `@` activates a command/mention mechanism in the target CLI — which is not always desired. The user wants a clean absolute path with no prefix, so the path is a plain path that can be used freely without triggering unintended CLI commands.

## Metadata

**Tags:** frontend, backend, bugfix, ui, ux
**Complexity:** 3

## User Review Required

Yes — this changes the behavior of every "Copy Link" button in the extension. Users who rely on the `@` prefix for AI CLI file-referencing will notice the change. Confirm that clean paths (no `@`) are the desired default behavior.

## Complexity Audit

### Routine
- Removing `'@' + ` string concatenation from 5 backend locations — each is a single-line edit.
- Changing `toAgentRef()` to a passthrough — 1-line logic change + JSDoc update.
- Updating 1 regression test assertion from positive to negative check.
- All changes follow the same pattern: remove prefix, keep the rest of the logic intact.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None. All clipboard operations are synchronous single-write calls. No concurrent access to shared state.

**Security:** None. Removing a prefix from a file path does not expose or leak any additional information. The paths written to the clipboard are already absolute filesystem paths.

**Side Effects:**
- Toast/notification messages that display the copied ref (e.g., `Document path copied to clipboard: ${docRef}`) will now show the clean path without `@`. This is the desired behavior.
- The `toAgentRef` function name becomes a misnomer (it no longer creates an "agent ref"). This is acceptable technical debt — renaming would expand scope to all call sites and any external references. The JSDoc will be updated to clarify the passthrough behavior.
- No data migration needed — this only affects future copy operations. Previously copied clipboard content is transient and not stored.

**Dependencies & Conflicts:** None. No other modules depend on the `@` prefix being present in clipboard output. The out-of-scope `@` usages (ClickUp mentions, prompt generation) are independent code paths.

## Dependencies

None — this is a self-contained change with no prerequisite plans.

## Adversarial Synthesis

Key risks: stale line numbers in the original plan would have led an implementer to edit the wrong lines — mitigated by replacing all line references with searchable code patterns. The `toAgentRef` function name becomes a misnomer after the passthrough change, but renaming would expand scope unnecessarily — mitigated by updating the JSDoc. No race conditions, security issues, or data migration concerns exist.

## Scope

### In Scope — All clipboard copy-link operations that prepend `@` to file paths

| # | File | Searchable Pattern | Function / Context | Current Behavior |
|---|------|--------------------|--------------------|------------------|
| 1 | `src/webview/sharedUtils.js` | `function toAgentRef(absPath)` | `toAgentRef()` | Returns `'@' + absPath` if not already prefixed |
| 2 | `src/webview/planning.js` | `toAgentRef(planFile)` in Copy Link handler | Kanban plan "Copy Link" button click handler | Calls `toAgentRef(planFile)` before `clipboard.writeText()` |
| 3 | `src/webview/project.js` | `toAgentRef(path)` in Copy Link handler | Kanban plan "Copy Link" button click handler | Calls `toAgentRef(path)` before `clipboard.writeText()` |
| 4 | `src/services/PlanningPanelProvider.ts` | `paths.push('@' + filePath)` | `copyToClipboard` handler — ticket link (per-id) | Pushes `'@' + filePath` into paths array |
| 5 | `src/services/PlanningPanelProvider.ts` | `paths.map(p => p.startsWith('@') ? p : '@' + p)` | `copyToClipboard` handler — ticket link (join) | Maps paths to add `@` prefix before join |
| 6 | `src/services/PlanningPanelProvider.ts` | `link.startsWith('@') ? link : '@' + link` in `copyInsightLink` | `copyInsightLink` handler | Prepends `@` to insight link |
| 7 | `src/services/PlanningPanelProvider.ts` | `docPath.startsWith('@') ? docPath : '@' + docPath` in `_handleLinkToDocument` | `linkToDocument` handler | Prepends `@` to document path |
| 8 | `src/services/DesignPanelProvider.ts` | `linkPath.startsWith('@') ? linkPath : '@' + linkPath` | `linkToDocument` handler | Prepends `@` to stitch asset path |

### Out of Scope — `@` usage that is NOT a clipboard copy-link operation

| File | Searchable Pattern | Why Excluded |
|------|--------------------|--------------|
| `src/services/ClickUpSyncService.ts` | `@` in comment parsing | ClickUp **user @mentions** in comment text parsing, not file-path clipboard operations. |
| `src/test/context-map-batching-regression.test.js` | `@${planFile}` assertion | Asserts `@${planFile}` in `TaskViewerProvider._buildBatchAnalystMapPrompt` — **internal prompt generation** for an AI analyst agent, not a clipboard copy. |
| `src/services/TaskViewerProvider.ts` | `_handleCopyPlanLink` | Copies a **generated prompt** (via `generateUnifiedPrompt`), not a raw file path. No `@` prefix is added. |
| `src/services/KanbanProvider.ts` | `clipboard.writeText` calls | All copy **prompts** (planner, coder, lead, chat, etc.), not file paths. No `@` prefix. |
| `src/services/PlanningPanelProvider.ts` | `_handleLinkToFolder` → `clipboard.writeText(resolvedFolder)` | Copies `resolvedFolder` **without** `@` prefix — already clean. |
| `src/webview/kanban.html` | `clipboard.writeText` in prompt copy | Copies an antigravity **prompt**, not a file path. |
| `src/webview/implementation.html` | `clipboard.writeText` in sprint copy | Copies a sprint **prompt**, not a file path. |

## Proposed Changes

### `src/webview/sharedUtils.js`

**Context:** The `toAgentRef()` function is defined at the top of `sharedUtils.js` and is loaded globally in all webviews. It is called from exactly 2 locations (planning.js and project.js Copy Link handlers).

**Logic:** Change the function to return `absPath` unchanged — a passthrough. This preserves the call-site contract so no caller needs to change.

**Implementation:**
```javascript
// Passthrough: returns the path as-is (no prefix).
// Kept as a function for call-site compatibility; the @ prefix was removed
// because users want clean absolute paths on clipboard copy.
function toAgentRef(absPath) {
    if (!absPath) return absPath;
    return absPath;
}
```

**Edge Cases:** If `absPath` is falsy (`null`, `undefined`, `''`), the existing guard returns it unchanged. No change needed to the guard.

### `src/webview/planning.js`

**Context:** The Kanban plan "Copy Link" button handler calls `toAgentRef(planFile)` before writing to clipboard. Since `toAgentRef` is now a passthrough, no change is needed here — the call remains and returns the clean path.

**Implementation:** No code change required. The passthrough in `sharedUtils.js` handles this automatically.

### `src/webview/project.js`

**Context:** Same as planning.js — the Kanban plan "Copy Link" button handler calls `toAgentRef(path)`. No change needed.

**Implementation:** No code change required. The passthrough in `sharedUtils.js` handles this automatically.

### `src/services/PlanningPanelProvider.ts` (4 locations)

**Context:** Four separate message handlers in `PlanningPanelProvider.ts` prepend `@` to file paths before clipboard writes. Each is an independent code path.

**Implementation:**

1. **Ticket link per-id** — Find `paths.push('@' + filePath); // agent-safe prefix` and change to:
   ```typescript
   paths.push(filePath);
   ```

2. **Ticket link join** — Find `const ticketRefs = paths.map(p => p.startsWith('@') ? p : '@' + p);` and change to:
   ```typescript
   const ticketRefs = paths;
   ```
   The `writeText(ticketRefs.join('\n'))` call remains unchanged.

3. **copyInsightLink** — Find `const linkRef = link.startsWith('@') ? link : '@' + link;` and change to:
   ```typescript
   const linkRef = link;
   ```
   The `writeText(linkRef)` call remains unchanged.

4. **linkToDocument** — Find `const docRef = docPath.startsWith('@') ? docPath : '@' + docPath;` and change to:
   ```typescript
   const docRef = docPath;
   ```
   The `writeText(docRef)` and `showInformationMessage` calls remain unchanged.

**Edge Cases:** None. Each handler independently resolves the path before the prefix step. Removing the prefix does not affect path resolution logic.

### `src/services/DesignPanelProvider.ts` (1 location)

**Context:** The `linkToDocument` handler in `DesignPanelProvider.ts` prepends `@` to the stitch asset path before clipboard write.

**Implementation:** Find `const linkRef = linkPath.startsWith('@') ? linkPath : '@' + linkPath;` and change to:
```typescript
const linkRef = linkPath;
```
The `writeText(linkRef)` and `showInformationMessage` calls remain unchanged.

### `src/test/tickets-link-to-ticket-regression.test.js`

**Context:** The test at lines 17–21 currently asserts that `PlanningPanelProvider.ts` contains `'@' + filePath`. After the fix, this assertion will fail.

**Implementation:** Replace the assertion block:
```javascript
    // (b) The copied path uses '@' + prefix
    assert.ok(
        planningProviderSource.includes("'@' + filePath"),
        "Expected PlanningPanelProvider.ts to prefix copied path with '@'"
    );
```
with:
```javascript
    // (b) The copied path does NOT use '@' + prefix
    assert.ok(
        !planningProviderSource.includes("'@' + filePath"),
        "Expected PlanningPanelProvider.ts to NOT prefix copied path with '@'"
    );
    assert.ok(
        planningProviderSource.includes("paths.push(filePath)"),
        "Expected PlanningPanelProvider.ts to push filePath without '@' prefix"
    );
```

**Edge Cases:** The test reads the source file as text and checks for string inclusion. The new assertions verify both the absence of the old pattern and the presence of the new pattern.

## Verification Plan

### Automated Tests

> **Note:** Per session directives, automated tests are NOT run during this planning session. The user will run them separately.

- `node src/test/tickets-link-to-ticket-regression.test.js` — should pass with updated assertions.
- `node src/test/context-map-batching-regression.test.js` — should pass unchanged (out of scope, no changes to that file).

### Manual Verification (via installed VSIX)

> **Note:** Per session directives, compilation is NOT run during this planning session. The user will compile and install the VSIX separately.

1. Planning panel Kanban tab: click "Copy Link" on a plan → paste into a text editor → confirm no `@` prefix.
2. Project panel Kanban tab: click "Copy Link" on a plan → paste → confirm no `@` prefix.
3. Planning panel Tickets tab: click "Link all" or individual ticket link → paste → confirm no `@` prefix.
4. Planning panel Documents tab: click "Copy Link" on a document → paste → confirm no `@` prefix.
5. Project panel Tuning tab: click "Copy Link" on an insight → paste → confirm no `@` prefix.
6. Design panel: click "Copy Link" on a stitch screen PNG → paste → confirm no `@` prefix.

### Final Grep Verification

After making all changes, run a final grep for `toAgentRef`, `'@' +`, and `startsWith('@')` across `src/webview/` and `src/services/` to confirm no remaining clipboard-related `@` prefixing exists (excluding the out-of-scope items listed above).

## Recommendation

Complexity is 3 (routine, single-concept change across multiple files, all following the same pattern). **Send to Coder.**

---

## Reviewer Pass — Completed

**Reviewer:** Direct in-place reviewer pass (Grumpy + Balanced).
**Date:** 2026-06-25

### Stage 1 — Grumpy Findings (severity-tagged)

| Severity | File:Line | Finding |
|----------|-----------|---------|
| NIT | `src/webview/sharedUtils.js:7-10` | `toAgentRef` passthrough has a redundant `if (!absPath)` guard — both branches return `absPath`. Per-spec; harmless. |
| NIT | `src/services/PlanningPanelProvider.ts:4671` | `const ticketRefs = paths;` is a pointless alias. Per-spec (minimizes diff). |
| NIT | `src/services/PlanningPanelProvider.ts:5570` | `const linkRef = link;` pointless alias. Per-spec. |
| NIT | `src/services/PlanningPanelProvider.ts:5735` | `const docRef = docPath;` pointless alias. Per-spec. |
| NIT | `src/services/DesignPanelProvider.ts:1512` | `const linkRef = linkPath;` pointless alias. Per-spec. |

No CRITICAL or MAJOR findings.

### Stage 2 — Balanced Synthesis

All 8 in-scope changes verified correct and matching the plan exactly. Out-of-scope `@` usages (TaskViewerProvider prompt generation, ClickUp mentions, `_handleLinkToFolder`) correctly untouched. Test assertions correctly inverted. No fixes required — all NITs are per-spec and not worth the scope expansion to clean up.

### Code Fixes Applied

None.

### Files Changed (verified)

| File | Change |
|------|--------|
| `src/webview/sharedUtils.js` | `toAgentRef` → passthrough (returns `absPath` unchanged) |
| `src/services/PlanningPanelProvider.ts` | 4 locations: `paths.push(filePath)`, `ticketRefs = paths`, `linkRef = link`, `docRef = docPath` |
| `src/services/DesignPanelProvider.ts` | 1 location: `linkRef = linkPath` |
| `src/test/tickets-link-to-ticket-regression.test.js` | Assertions inverted: absence of `'@' + filePath`, presence of `paths.push(filePath)` |

### Validation Results

- **Final grep** (`'@' +`, `startsWith('@')`) across `src/`: only matches are test-file negative assertions (expected). PASS
- **Out-of-scope verification**: `TaskViewerProvider.ts` `@${planFilePath}` intact; `_handleLinkToFolder` uses `resolvedFolder` without prefix. PASS
- **Compilation**: Skipped per session directives.
- **Tests**: Skipped per session directives.

### Remaining Risks

- **Low**: The `toAgentRef` function name is now a misnomer (documented in JSDoc). Future readers may be confused. Acceptable technical debt per plan.
- **Low**: The redundant guard and aliases in passthrough/alias variables are cosmetic debt. Defer to a future refactor.
- **None functional**: No behavioral risks. All clipboard operations now produce clean absolute paths.
