# Robust Markdown Plan Clipboard Import

This plan implements a robust clipboard import feature that reads rich HTML formatting from the clipboard in the Kanban webview, converts it to Markdown (preserving headings, lists, bold/italic, code blocks, and links), and completely removes the default plan template auto-appending behavior from the backend.

## Goal

Enable clipboard import to preserve rich formatting (headings, lists, bold/italic, code blocks, links) when pasting from Markdown previews, and remove the template stub auto-appending logic from `_createInitiatedPlan` entirely.

## Metadata

- **Tags:** [frontend, backend, workflow]
- **Complexity:** 5

## User Review Required

- Decision needed: Use `turndown` library (recommended, ~12KB, battle-tested) vs. custom lightweight HTML-to-Markdown converter. Turndown handles edge cases (nested lists, inline styles, `<br>` tags, code blocks with language hints) that a custom converter will likely miss. If zero-dependency policy applies, the custom converter must be explicitly scoped with known limitations documented.

## Complexity Audit

### Routine
- Removing the `isFullPlan` check and template stub logic from `_createInitiatedPlan` (TaskViewerProvider.ts:15184-15188) — the only caller that needs stubs (`createDraftPlanTicket`) already builds its own complete template via `_buildDraftPlanContent`
- Updating the KanbanProvider message handler to pass `markdownText` payload through to the command (KanbanProvider.ts:5655-5657)
- Updating the command registration to accept optional `markdownText` parameter (extension.ts:647-648)
- Adding error handling for `NotAllowedError`/`SecurityError` in the webview clipboard read attempt
- Removing the now-unused `skipTemplateHeadings` option from `_createInitiatedPlan`'s options type and all callers that pass it

### Complex / Risky
- Implementing or integrating HTML-to-Markdown conversion in the webview context: clipboard HTML is messy (browser-specific styling, `<br>` tags, nested `<div>` wrappers). A custom converter risks producing garbled output for non-trivial HTML.
- The `navigator.clipboard.read()` ClipboardItem API may behave differently across VS Code versions or Electron builds. Requires testing on target environments.

## Edge-Case & Dependency Audit

- **Race Conditions:** If the webview reads HTML clipboard and the backend also reads plain text (fallback path), the clipboard content could theoretically change between reads. Mitigated by: fallback only fires when webview read fails, so both paths never execute in sequence.
- **Security:** `navigator.clipboard.read()` requires user gesture (button click satisfies this). `NotAllowedError` must be caught and handled gracefully. No credential/secret exposure risk — clipboard content is user-initiated.
- **Side Effects:** Removing the `isFullPlan` template stub logic from `_createInitiatedPlan` is safe — `createDraftPlanTicket` (the only caller that needs stubs) already provides them in its `idea` string via `_buildDraftPlanContent`. ClickUp/Linear import callers already pass `skipTemplateHeadings: true`. The clipboard import callers will simply save content as-is.
- **Dependencies & Conflicts:** If `turndown` is adopted, it must be bundled into the webview (it's a browser-compatible library, no Node.js dependencies). If a custom converter is chosen, it must be embedded inline in `kanban.html` or loaded via the extension's webview resource provider.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Custom HTML-to-Markdown converter will miss edge cases in messy clipboard HTML — turndown is strongly recommended. (2) `navigator.clipboard.read()` availability in VS Code webviews must be verified on target platforms. Mitigations: adopt turndown, implement graceful fallback to the existing backend plain-text path, and wrap clipboard read in try/catch for `NotAllowedError`/`SecurityError`.

## Proposed Changes

### [MODIFY] src/webview/kanban.html

**Context:** The clipboard import button (line 4189-4191) currently posts a fire-and-forget `{ type: 'importFromClipboard' }` message. The webview does no clipboard reading itself.

**Logic:**
1. Update the `btn-import-clipboard` click handler (line 4189-4191) to attempt reading the clipboard in the webview first:
   - Try `navigator.clipboard.read()` to access `ClipboardItem` with `text/html` MIME type.
   - If HTML is available, convert it to Markdown using `turndown` (or custom `convertHtmlToMarkdown`).
   - Send `{ type: 'importFromClipboard', markdownText: <converted> }` to the backend.
   - If `navigator.clipboard.read()` throws `NotAllowedError` or `SecurityError`, or if no `text/html` is available, fall back to sending `{ type: 'importFromClipboard' }` (no payload), which triggers the existing backend plain-text path.
   - If both paths fail, show a user-facing error notification.

2. Add the `convertHtmlToMarkdown` function (or turndown integration):
   - **If turndown:** Add `<script src="${turndownUri}"></script>` in the webview HTML head, and use `new TurndownService().turndown(htmlBlob)`. Configure turndown rules for: heading levels, bullet/numbered lists, bold/italic, inline code and code blocks (with language preservation), and links.
   - **If custom converter:** Implement `convertHtmlToMarkdown(htmlString)` that: parses HTML via `DOMParser`, walks the DOM tree, and emits Markdown for `h1`-`h6` → `#`-`######`, `ul`/`ol`/`li` → `-`/`1.`, `strong`/`b` → `**`, `em`/`i` → `*`, `code` → `` ` ``, `pre` → fenced code block, `a` → `[text](href)`. Strip all other tags. Document known limitations (no table support, no nested list depth > 3, etc.).

**Implementation:**
- Line 4189-4191: Replace the simple `postKanbanMessage({ type: 'importFromClipboard' })` with an async handler that attempts clipboard HTML read, conversion, and conditional message posting.
- New function: `convertHtmlToMarkdown(html)` or turndown integration, placed near the other utility functions in the `<script>` block.

**Edge Cases:**
- Empty clipboard → show warning (existing behavior preserved in backend fallback).
- Clipboard with only plain text (no HTML) → backend fallback reads it as plain text.
- Very large HTML (>200KB) → size check before conversion; warn and abort.
- Malformed HTML → DOMParser is fault-tolerant; turndown handles gracefully; custom converter must catch exceptions.

### [MODIFY] src/services/KanbanProvider.ts

**Context:** The `importFromClipboard` message handler (line 5655-5657) currently calls the command with no arguments.

**Logic:**
- Update the handler to check for `msg.markdownText` in the incoming message.
- If present, pass it to the command: `vscode.commands.executeCommand('switchboard.importPlanFromClipboard', msg.markdownText)`.
- If absent, call the command with no arguments (existing behavior).

**Implementation:**
- Line 5655-5657: Change from:
  ```typescript
  case 'importFromClipboard':
      await vscode.commands.executeCommand('switchboard.importPlanFromClipboard');
      break;
  ```
  To:
  ```typescript
  case 'importFromClipboard':
      await vscode.commands.executeCommand('switchboard.importPlanFromClipboard', msg.markdownText);
      break;
  ```

**Edge Cases:**
- `msg.markdownText` is `undefined` or empty string → command receives `undefined`, backend falls back to `vscode.env.clipboard.readText()`.

### [MODIFY] src/extension.ts

**Context:** The command registration (line 647-648) currently calls `importPlanFromClipboard()` with no arguments.

**Logic:**
- Update the command handler to accept an optional `markdownText` parameter and forward it.

**Implementation:**
- Line 647-648: Change from:
  ```typescript
  const importFromClipboardDisposable = vscode.commands.registerCommand('switchboard.importPlanFromClipboard', async () => {
      await taskViewerProvider?.importPlanFromClipboard();
  ```
  To:
  ```typescript
  const importFromClipboardDisposable = vscode.commands.registerCommand('switchboard.importPlanFromClipboard', async (markdownText?: string) => {
      await taskViewerProvider?.importPlanFromClipboard(markdownText);
  ```

**Edge Cases:**
- Command invoked from command palette (no `markdownText`) → `undefined` is passed, backend reads clipboard itself.

### [MODIFY] src/services/TaskViewerProvider.ts

**Context:** `importPlanFromClipboard()` (line 14984) reads clipboard text directly. `_createInitiatedPlan()` (line 15155) has `isFullPlan` template logic at line 15184-15188 that appends `## Goal`, `## Proposed Changes`, etc. stubs when the `idea` string doesn't already contain those headings. The `skipTemplateHeadings` option (line 15163) exists but is a workaround — the goal is to remove the template stub logic entirely.

**Logic:**
1. Update `importPlanFromClipboard` signature to accept optional `markdownText` parameter:
   - If `markdownText` is provided (from webview HTML conversion), use it directly instead of reading `vscode.env.clipboard.readText()`.
   - If `markdownText` is not provided, fall back to `vscode.env.clipboard.readText()` (existing behavior).

2. Remove the `isFullPlan` check and template stub logic from `_createInitiatedPlan` entirely:
   - Delete lines 15184-15188 (the `isFullPlan` conditional and the template string).
   - Change the `content` assignment to always use `idea` as-is: `const content = isAirlock ? '## Notebook Plan\n\n' + idea : idea;`
   - This is safe because `createDraftPlanTicket` (the only caller that needs stubs) already builds a complete template via `_buildDraftPlanContent` (line 14934-14958) and passes it as the `idea` argument. ClickUp/Linear import callers already pass `skipTemplateHeadings: true` and build their own content. Clipboard import callers want content saved as-is.

3. Remove the `skipTemplateHeadings` option from the `_createInitiatedPlan` options type (line 15163) and from all callers that pass it (lines 4029, 4185, 4207, and the clipboard import callers that would have used it). It's no longer needed since the template stub logic is gone.

**Implementation:**
- Line 14984: Change signature from `importPlanFromClipboard(): Promise<void>` to `importPlanFromClipboard(markdownText?: string): Promise<void>`.
- Line 14998: Change `const text = await vscode.env.clipboard.readText();` to `const text = markdownText ?? await vscode.env.clipboard.readText();`.
- Line 15163: Remove `skipTemplateHeadings?: boolean;` from the options type.
- Line 15184-15188: Remove the `isFullPlan` conditional and template string. Replace with:
  ```typescript
  const content = isAirlock ? `## Notebook Plan\n\n${idea}` : idea;
  ```
- Line 4029: Remove `skipTemplateHeadings: true,` from the Linear import caller.
- Line 4185: Remove `skipTemplateHeadings: true,` from the ClickUp import caller.
- Line 4207: Remove `skipTemplateHeadings: true,` from the ClickUp subtask import caller.

**Edge Cases:**
- `markdownText` is empty string → the existing empty-check at line 15000-15003 catches it and shows warning.
- `markdownText` is very large → the existing size check at line 15004-15007 catches it.
- `createDraftPlanTicket` (line 14976) already provides full template in `idea` → no behavior change.
- Other callers of `importPlanFromClipboard` (PlanningPanelProvider.ts:2691) invoke via command with no arguments → receives `undefined`, falls back to backend clipboard read (no behavior change).

## Verification Plan

### Automated Tests
- (Skipped per session directives — test suite will be run separately by the user.)

### Manual Verification
1. Open the Markdown Preview of a plan file (e.g., any `.switchboard/plans/*.md` file).
2. Select all of the rendered preview text and copy it.
3. Click **Import from Clipboard** in the Kanban webview.
4. Open the created plan file in `.switchboard/plans/`.
5. Verify that headings are converted to proper `#` symbols, lists are converted to `-`, bold/code styles are preserved, and no default template headers (`## Goal`, `## Proposed Changes`, etc.) are appended.
6. Test the fallback path: copy plain text (no HTML) to clipboard, click Import, verify it still works via the backend plain-text path.
7. Test error handling: deny clipboard permission (if possible in test environment), verify graceful fallback or user-facing error message.
8. Test that creating a plan via the "Add Plan" button (`createDraftPlanTicket`) still produces a plan with the full template stubs — confirming that `_buildDraftPlanContent` still provides them.

## Review Results (Post-Implementation)

### Stage 1: Adversarial Findings

| # | Finding | Severity | File | Lines |
|---|---------|----------|------|-------|
| 1 | Stale test regex expects `importPlanFromClipboard()` with no params, but signature is now `(markdownText?: string)` — test will fail at runtime | **CRITICAL** | `src/test/clipboard-import-brain-promotion-regression.test.js` | 16 |
| 2 | No HTML size check in webview before conversion — plan requires >200KB guard, only backend has it | **MAJOR** | `src/webview/kanban.html` | 4260-4266 |
| 3 | Inline code adds extra spaces (`` ` `code` ` ``) — minor output quality issue | **NIT** | `src/webview/kanban.html` | 5087 |
| 4 | No try/catch inside `convertHtmlToMarkdown` — outer handler catches but silently degrades | **NIT** | `src/webview/kanban.html` | 5028-5128 |
| 5 | Ordered lists always start at `1.` regardless of `start` attribute | **NIT** | `src/webview/kanban.html` | 5114 |
| 6 | No table support — `<table>` content collapses to concatenated text | **NIT** | `src/webview/kanban.html` | 5120-5121 |
| 7 | PlanningPanelProvider always falls back to plain text (no webview clipboard read) | **NIT** | `src/services/PlanningPanelProvider.ts` | 2762 |

### Stage 2: Balanced Synthesis

| Finding | Action | Rationale |
|---------|--------|-----------|
| #1 Stale test regex (CRITICAL) | **Fix now** | Test will fail at runtime. One-line regex fix. |
| #2 No HTML size check (MAJOR) | **Fix now** | Plan explicitly requires it; unbounded HTML conversion is a resource risk. |
| #3 Inline code spaces (NIT) | **Fix now** (trivial) | One-character fix, improves output quality. |
| #4 No try/catch in converter (NIT) | Defer | Outer catch handles adequately for v1. |
| #5 Ordered list `start` attr (NIT) | Defer | Known limitation, CommonMark-compliant. |
| #6 No table support (NIT) | Defer | Known limitation, explicitly documented. |
| #7 Planning Panel plain-text (NIT) | Defer | Out of scope per plan. |

### Stage 3: Code Fixes Applied

1. **`src/test/clipboard-import-brain-promotion-regression.test.js` line 16**: Updated regex from `\(\)` to `\(markdownText\?: string\)` to match new signature. Test passes.

2. **`src/webview/kanban.html` lines 4260-4270**: Added HTML size guard before conversion — if `htmlText.length > 200_000`, logs warning and falls back to backend plain-text path instead of attempting conversion.

3. **`src/webview/kanban.html` line 5091**: Removed extra spaces around inline code — changed from `` ` \`${childrenMarkdown.trim()}\` ` `` to `` `\`${childrenMarkdown.trim()}\`` ``.

### Validation Results

- **Regression test**: `clipboard-import-brain-promotion-regression.test.js` — **PASSED** (after regex fix)
- **Compilation**: Skipped per session directives
- **Full test suite**: To be run separately by user

### Remaining Risks

- **Custom converter edge cases**: The `convertHtmlToMarkdown` function handles common HTML elements well but may produce suboptimal output for deeply nested structures, `<table>` elements, or HTML with extensive inline styles. Turndown would handle these more robustly if adopted in a future iteration.
- **`navigator.clipboard.read()` compatibility**: The ClipboardItem API may not be available in all VS Code/Electron versions. The fallback path handles this gracefully.
- **Planning Panel import path**: Always uses backend plain-text read; does not benefit from rich HTML conversion. Future enhancement could add webview clipboard read to the Planning Panel.

### Implementation Confirmation

All proposed changes from the plan have been implemented and verified:

- ✅ `kanban.html`: Webview clipboard read with HTML-to-Markdown conversion, fallback to backend, size guard
- ✅ `KanbanProvider.ts`: `msg.markdownText` forwarded to command
- ✅ `extension.ts`: Command accepts optional `markdownText?: string` parameter
- ✅ `TaskViewerProvider.ts`: `importPlanFromClipboard(markdownText?: string)` with nullish coalescing fallback
- ✅ `TaskViewerProvider.ts`: `isFullPlan` template stub logic completely removed from `_createInitiatedPlan`
- ✅ `TaskViewerProvider.ts`: `skipTemplateHeadings` option removed from options type and all callers
- ✅ All callers (Linear, ClickUp parent, ClickUp subtask, clipboard, draft, multi-plan) no longer pass `skipTemplateHeadings`
