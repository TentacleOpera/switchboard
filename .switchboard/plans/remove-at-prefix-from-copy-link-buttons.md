# Remove `@` Prefix from All Copy-Link Clipboard Operations

## Metadata

**Complexity:** 3
**Tags:** frontend, backend, bugfix, ui, ux

## Goal

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

## Scope

### In Scope — All clipboard copy-link operations that prepend `@` to file paths

| # | File | Line(s) | Function / Context | Current Behavior |
|---|------|---------|--------------------|------------------|
| 1 | `src/webview/sharedUtils.js` | 6–9 | `toAgentRef()` | Returns `'@' + absPath` if not already prefixed |
| 2 | `src/webview/planning.js` | 5587 | Kanban plan "Copy Link" button click handler | Calls `toAgentRef(planFile)` before `clipboard.writeText()` |
| 3 | `src/webview/project.js` | 915 | Kanban plan "Copy Link" button click handler | Calls `toAgentRef(path)` before `clipboard.writeText()` |
| 4 | `src/services/PlanningPanelProvider.ts` | 4541 | `copyToClipboard` handler — ticket link (per-id) | `paths.push('@' + filePath)` |
| 5 | `src/services/PlanningPanelProvider.ts` | 4557 | `copyToClipboard` handler — ticket link (join) | `paths.map(p => p.startsWith('@') ? p : '@' + p)` |
| 6 | `src/services/PlanningPanelProvider.ts` | 5456 | `copyInsightLink` handler | `link.startsWith('@') ? link : '@' + link` |
| 7 | `src/services/PlanningPanelProvider.ts` | 5621 | `linkToDocument` handler (`_handleLinkToDocument`) | `docPath.startsWith('@') ? docPath : '@' + docPath` |
| 8 | `src/services/DesignPanelProvider.ts` | 1469 | `linkToDocument` handler | `linkPath.startsWith('@') ? linkPath : '@' + linkPath` |

### Out of Scope — `@` usage that is NOT a clipboard copy-link operation

| File | Line(s) | Why Excluded |
|------|---------|--------------|
| `src/services/ClickUpSyncService.ts` | 1671, 1740 | These are ClickUp **user @mentions** in comment text parsing, not file-path clipboard operations. |
| `src/test/context-map-batching-regression.test.js` | 79 | Asserts `@${planFile}` in `TaskViewerProvider._buildBatchAnalystMapPrompt` — this is **internal prompt generation** for an AI analyst agent, not a clipboard copy. The `@` there is part of the prompt text sent to the agent. |
| `src/services/TaskViewerProvider.ts` | 13697–13702 | `_handleCopyPlanLink` copies a **generated prompt** (via `generateUnifiedPrompt`), not a raw file path. No `@` prefix is added. |
| `src/services/KanbanProvider.ts` | various | All `clipboard.writeText` calls copy **prompts** (planner, coder, lead, chat, etc.), not file paths. No `@` prefix. |
| `src/services/PlanningPanelProvider.ts` | 5672 | `_handleLinkToFolder` copies `resolvedFolder` **without** `@` prefix — already clean. |
| `src/webview/kanban.html` | 6212 | Copies an antigravity **prompt**, not a file path. |
| `src/webview/implementation.html` | 3409 | Copies a sprint **prompt**, not a file path. |

## Implementation Plan

### Step 1 — Fix the shared utility (`sharedUtils.js`)

**File:** `src/webview/sharedUtils.js`, lines 4–9

Change `toAgentRef()` to return the path unchanged (no `@` prefix). The function signature and call sites remain the same — only the prefix logic is removed.

- Remove the `@` prepend logic.
- Update the JSDoc comment to reflect that it now returns the path as-is (or simply remove the function and replace call sites with direct path usage — but keeping the function as a no-op passthrough is lower-risk since it preserves the call-site contract).

**Decision:** Keep the function as a passthrough (return `absPath` unchanged). This avoids touching every call site and keeps the function available if prefix logic is ever needed again. Update the comment to say it returns the path as-is.

### Step 2 — Fix `PlanningPanelProvider.ts` (4 locations)

**File:** `src/services/PlanningPanelProvider.ts`

1. **Line 4541** — Remove `'@' + ` prefix: change `paths.push('@' + filePath)` to `paths.push(filePath)`. Remove the `// agent-safe prefix` comment.
2. **Line 4557** — Remove the `@` mapping: change `const ticketRefs = paths.map(p => p.startsWith('@') ? p : '@' + p)` to just use `paths` directly (or `const ticketRefs = paths` if a local is preferred for clarity). Update the `writeText` call to use `ticketRefs.join('\n')` or `paths.join('\n')`.
3. **Line 5456** — Remove `@` prefix: change `const linkRef = link.startsWith('@') ? link : '@' + link` to `const linkRef = link`. The `writeText(linkRef)` call remains.
4. **Line 5621** — Remove `@` prefix: change `const docRef = docPath.startsWith('@') ? docPath : '@' + docPath` to `const docRef = docPath`. The `writeText(docRef)` and `showInformationMessage` calls remain.

### Step 3 — Fix `DesignPanelProvider.ts` (1 location)

**File:** `src/services/DesignPanelProvider.ts`, line 1469

Remove `@` prefix: change `const linkRef = linkPath.startsWith('@') ? linkPath : '@' + linkPath` to `const linkRef = linkPath`. The `writeText(linkRef)` and `showInformationMessage` calls remain.

### Step 4 — Update the regression test

**File:** `src/test/tickets-link-to-ticket-regression.test.js`, lines 17–21

The test currently asserts that `PlanningPanelProvider.ts` contains `'@' + filePath`. After the fix, this assertion will fail. Update the test to assert the **absence** of the `@` prefix:

- Replace the assertion at lines 17–21 to verify that the copied path does NOT include `'@' + filePath`.
- Optionally assert that `paths.push(filePath)` (without `@`) is present instead.

### Step 5 — Verify no other `@`-prefix clipboard operations were missed

After making the changes, run a final grep for `toAgentRef`, `'@' +`, and `startsWith('@')` across `src/webview/` and `src/services/` to confirm no remaining clipboard-related `@` prefixing exists (excluding the out-of-scope items listed above).

## Edge Cases & Risks

1. **Existing clipboard content with `@`:** If a user has previously copied a path with `@` and pastes it somewhere that stored it, there's no migration needed — this only affects future copy operations.
2. **`toAgentRef` callers:** Only two call sites use `toAgentRef()` (planning.js line 5587, project.js line 915). Both are "Copy Link" buttons for Kanban plans. Making the function a passthrough is safe.
3. **`linkToDocument` in DesignPanelProvider:** The `copyStitchAssetLink` function in `design.js` sends a `linkToDocument` message to the backend, which is handled by `DesignPanelProvider.ts` line 1469. This is the "Copy Link" button for stitch screen PNGs. The fix in Step 3 covers this.
4. **`copyInsightLink` in project.js:** The "Copy Link" button for tuning insights in the project panel sends `copyInsightLink` to `PlanningPanelProvider.ts` line 5456. The fix in Step 2 covers this.
5. **Toast messages:** Several `showInformationMessage` calls display the copied ref (e.g., `Document path copied to clipboard: ${docRef}`). After the fix, these will show the clean path without `@` — this is the desired behavior.
6. **Test file `context-map-batching-regression.test.js`:** This test checks for `@${planFile}` in `TaskViewerProvider._buildBatchAnalystMapPrompt`. This is **not** a clipboard operation — it's internal prompt generation. Do NOT touch this test.

## Verification

1. Run `npm run compile` to confirm no TypeScript errors.
2. Run the regression tests: `node src/test/tickets-link-to-ticket-regression.test.js` — should pass with updated assertions.
3. Run `node src/test/context-map-batching-regression.test.js` — should pass unchanged (out of scope).
4. Manual verification (via installed VSIX):
   - Planning panel Kanban tab: click "Copy Link" on a plan → paste into a text editor → confirm no `@` prefix.
   - Project panel Kanban tab: click "Copy Link" on a plan → paste → confirm no `@` prefix.
   - Planning panel Tickets tab: click "Link all" or individual ticket link → paste → confirm no `@` prefix.
   - Planning panel Documents tab: click "Copy Link" on a document → paste → confirm no `@` prefix.
   - Project panel Tuning tab: click "Copy Link" on an insight → paste → confirm no `@` prefix.
   - Design panel: click "Copy Link" on a stitch screen PNG → paste → confirm no `@` prefix.
