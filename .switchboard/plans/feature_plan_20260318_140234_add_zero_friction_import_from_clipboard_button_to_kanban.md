# Add zero-friction "Import from Clipboard" button to Kanban

## Goal
Add an "Import from Clipboard" button to the Kanban `New` (CREATED) column header. This solves the friction of pasting fully generated AI plans into the new Ticket View, which forces users to manually delete scaffolding and re-enter titles. The import button will bypass the Ticket View entirely, reading raw Markdown directly from the OS clipboard, automatically extracting the title, and instantly dropping the new card onto the board.

## Complexity Audit

### Band A — Routine
- Adding an icon button next to the existing `+` (Add Plan) button in `src/webview/kanban.html` CREATED column.
- Wiring a new `importFromClipboard` IPC message through `KanbanProvider.ts` → VS Code command → `TaskViewerProvider`.
- Adding `TaskViewerProvider.importPlanFromClipboard()` that reads `vscode.env.clipboard.readText()`, validates, extracts the `# ` heading, and writes the file.

### Band B — Complex / Risky
- None. This reuses the existing, highly stable `_createInitiatedPlan` file-creation-and-registry pattern verbatim.

### Recommended Route
**`/handoff-lead`** — 3 files touched, 1 new public method, 1 UI button, 1 message case, 1 command registration. All changes follow verified existing patterns. Estimated effort: 15–25 minutes.

## Edge-Case & Dependency Audit

| Concern | Analysis |
|:---|:---|
| **Race Conditions** | None. File creation uses the existing `_pendingPlanCreations` suppression set (line 114, `TaskViewerProvider.ts`) so the filesystem watcher (`_handlePlanCreation`, line 4967) doesn't create duplicate sessions. |
| **Security** | Standard clipboard access. VS Code natively handles clipboard read permissions. No new permissions required. |
| **Empty / junk clipboard** | Validated before write: abort if empty, >200 KB, or no `# ` header. Surface a warning toast. |
| **Fallback title** | If clipboard contains markdown without a `# Title` line, fall back to `"Imported Plan"`. |
| **Dependencies** | Relies on CREATED column header layout (lines 838–842 of `kanban.html`). No external packages. |

## Dependency Verification (Codebase Audit)

### `_pendingPlanCreations` (TaskViewerProvider.ts:114)
```typescript
private _pendingPlanCreations = new Set<string>(); // suppress watcher for internally created plans
```
- **Added:** line 7800 — before file write, via `_normalizePendingPlanPath()`
- **Checked:** line 4969 — in `_handlePlanCreation()` to skip watcher-induced duplicate registration
- **Removed:** line 7854 — after a 2-second timeout in `finally` block
- **Conclusion:** Safe to reuse. Our new method follows the identical add → try/finally → delete pattern.

### Plan filename convention (TaskViewerProvider.ts:7726–7737)
- **Slug:** `_toPlanSlug(title)` → lowercased, non-alphanumeric replaced with `_`, trimmed
- **Timestamp:** `_formatPlanTimestamp(now)` → `YYYYMMDD_HHMMSS`
- **Pattern:** `feature_plan_${timestamp}_${slug}.md`
- **Example:** `feature_plan_20260318_143025_add_clipboard_import.md`

### Session/runsheet creation (TaskViewerProvider.ts:7809–7822)
- Session ID: `sess_${Date.now()}`
- Written to `.switchboard/sessions/${sessionId}.json`
- Initial event: `{ workflow: 'initiate-plan', timestamp, action: 'start' }`
- Followed by `_registerPlan()`, `_logEvent()`, `_refreshRunSheets()`, `_promotePlanToBrain()`

### `_createInitiatedPlan` full-plan detection (TaskViewerProvider.ts:7802)
```typescript
const isFullPlan = idea.includes('## Proposed Changes') || idea.includes('## Goal');
```
When `isFullPlan` is true, the content is written **verbatim** — no scaffold injected. Our clipboard content will always be written as-is since we pass it directly.

### Inter-provider communication pattern
KanbanProvider has **no direct import** of TaskViewerProvider. All communication goes through VS Code commands (`vscode.commands.executeCommand`). The new feature follows this same pattern.

## Adversarial Synthesis

### Grumpy Critique
Reading directly from the clipboard without a confirmation dialog?! What if the user accidentally has a 50,000-line log file in their clipboard and clicks the button by mistake? You're going to instantly dump a massive garbage file into `.switchboard/plans/` and spawn a useless session runsheet!

### Balanced Response
Grumpy is right that blind clipboard imports carry a minor risk of accidental junk ingestion. To mitigate this, we will add a fast validation check in the provider before creating the file: if the clipboard text does not contain a markdown header (`# `) or is egregiously large (e.g., > 200 KB), we will surface a warning toast and abort the import.

---

## Proposed Changes (Detailed)

### 1. Webview UI — `src/webview/kanban.html`

**Location:** Lines 838–842 — the `rightSide` ternary for the CREATED column header.

**Current code (lines 838–842):**
```javascript
const rightSide = isCreated
    ? `<div style="display: flex; align-items: center; gap: 8px; line-height: 1;">
            <button class="btn-add-plan" id="btn-add-plan" title="Add Plan">+</button>
            <span class="column-count" id="count-${escapeAttr(def.id)}">0</span>
       </div>`
    : `<span class="column-count" id="count-${escapeAttr(def.id)}">0</span>`;
```

**After (insert clipboard button between `+` button and count span):**
```javascript
const rightSide = isCreated
    ? `<div style="display: flex; align-items: center; gap: 8px; line-height: 1;">
            <button class="btn-add-plan" id="btn-add-plan" title="Add Plan">+</button>
            <button class="btn-add-plan" id="btn-import-clipboard" title="Import plan from clipboard">📋</button>
            <span class="column-count" id="count-${escapeAttr(def.id)}">0</span>
       </div>`
    : `<span class="column-count" id="count-${escapeAttr(def.id)}">0</span>`;
```

**CSS:** No new CSS needed — reuses `.btn-add-plan` class (lines 172–195). The `📋` emoji auto-scales within the 18×18px flex container. The `font-size: 14px` on the class gives it the right size. The teal glow, hover, and border all apply automatically.

**Event listener — insert after line 890:**

Current (lines 888–890):
```javascript
document.getElementById('btn-add-plan')?.addEventListener('click', () => {
    postKanbanMessage({ type: 'createPlan' });
});
```

Add immediately after:
```javascript
document.getElementById('btn-import-clipboard')?.addEventListener('click', () => {
    postKanbanMessage({ type: 'importFromClipboard' });
});
```

### 2. Message Router — `src/services/KanbanProvider.ts`

**Location:** Line 1322, after the `case 'createPlan'` block.

**Current code (lines 1320–1323):**
```typescript
case 'createPlan':
    await vscode.commands.executeCommand('switchboard.initiatePlan');
    break;
}  // end of switch
```

**Insert new case before the closing brace:**
```typescript
case 'createPlan':
    await vscode.commands.executeCommand('switchboard.initiatePlan');
    break;
case 'importFromClipboard':
    await vscode.commands.executeCommand('switchboard.importPlanFromClipboard');
    break;
}  // end of switch
```

### 3. Command Registration — `src/extension.ts`

**Location:** Line 778, after `initiatePlanDisposable` registration (follows the exact same pattern).

**Current code (lines 775–778):**
```typescript
const initiatePlanDisposable = vscode.commands.registerCommand('switchboard.initiatePlan', async () => {
    await taskViewerProvider?.createDraftPlanTicket();
});
context.subscriptions.push(initiatePlanDisposable);
```

**Insert immediately after (line 779):**
```typescript
const importFromClipboardDisposable = vscode.commands.registerCommand('switchboard.importPlanFromClipboard', async () => {
    await taskViewerProvider?.importPlanFromClipboard();
});
context.subscriptions.push(importFromClipboardDisposable);
```

### 4. Backend Execution — `src/services/TaskViewerProvider.ts`

**Location:** Insert after `createDraftPlanTicket()` (line 7780), before `_createInitiatedPlan` (line 7782).

**New method:**
```typescript
public async importPlanFromClipboard(): Promise<void> {
    const text = await vscode.env.clipboard.readText();

    // Validate clipboard content
    if (!text || !text.trim()) {
        vscode.window.showWarningMessage('Clipboard is empty. Copy a Markdown plan first.');
        return;
    }
    if (text.length > 200_000) {
        vscode.window.showWarningMessage('Clipboard content is too large (>200 KB). Aborting import.');
        return;
    }

    // Extract title from first H1 heading, or fall back
    const h1Match = text.match(/^#\s+(.+)$/m);
    const title = h1Match ? h1Match[1].trim() : 'Imported Plan';

    if (!h1Match) {
        vscode.window.showWarningMessage('No "# Title" found in clipboard. Importing with default title.');
    }

    try {
        const { sessionId } = await this._createInitiatedPlan(title, text, false);
        await this._refreshRunSheets();
        vscode.window.showInformationMessage(`Imported plan: ${title}`);
    } catch (err: any) {
        const msg = err?.message || String(err);
        vscode.window.showErrorMessage(`Clipboard import failed: ${msg}`);
    }
}
```

**Why `_createInitiatedPlan` works directly:**
- The method checks `isFullPlan = idea.includes('## Proposed Changes') || idea.includes('## Goal')` (line 7802).
- Well-formed AI plans always contain `## Goal` and/or `## Proposed Changes`, so `isFullPlan` will be `true`.
- When `isFullPlan` is `true`, the content is written **verbatim** — no scaffold injection (line 7804–7806).
- Even if the clipboard lacks those sections, the scaffold wrapping is harmless (adds standard TODO sections).
- The method handles: file naming, `_pendingPlanCreations` guard, session creation, plan registration, event logging, brain promotion, and runsheet refresh.

---

## Verification Plan

### Automated Smoke Check
After implementation, run the build to ensure no compile errors:
```bash
npm run compile
```

### Manual Testing
1. **Happy path:** Copy a fully formatted Markdown plan (containing `# Feature Name` and `## Goal`) to the OS clipboard. Open CLI-BAN. Click the 📋 button in the New column. Verify the plan appears instantly with the correct title.
2. **Content fidelity:** Click "Review" on the new card. Verify the Markdown was imported perfectly without scaffold injection.
3. **No-header fallback:** Copy plain text without a `# Title` line. Click 📋. Verify a warning toast appears AND the plan is created with title "Imported Plan".
4. **Empty clipboard:** Clear clipboard, click 📋. Verify a warning toast: "Clipboard is empty."
5. **Oversized content:** Copy >200 KB of text, click 📋. Verify a warning toast: "Clipboard content is too large."
6. **Session integrity:** After import, verify `.switchboard/sessions/` contains a new `sess_*.json` runsheet with `workflow: 'initiate-plan'` and the correct `planFile` relative path.
7. **No duplicate from watcher:** After import, check the console for `[TaskViewerProvider] Ignoring internal plan creation` to confirm `_pendingPlanCreations` suppressed the watcher.

---

## Appendix A: File Change Summary

| File | Lines Affected | Change Type |
|:---|:---|:---|
| `src/webview/kanban.html` | ~840 (HTML), ~891 (JS) | Add button element + click listener |
| `src/services/KanbanProvider.ts` | ~1322 | Add `case 'importFromClipboard'` |
| `src/extension.ts` | ~779 | Register `switchboard.importPlanFromClipboard` command |
| `src/services/TaskViewerProvider.ts` | ~7780 | Add `importPlanFromClipboard()` public method |

**Total: 4 files, ~30 net new lines.**

## Appendix B: Implementation Diffs

### B.1 — `src/webview/kanban.html` (HTML)
```diff
 const rightSide = isCreated
     ? `<div style="display: flex; align-items: center; gap: 8px; line-height: 1;">
             <button class="btn-add-plan" id="btn-add-plan" title="Add Plan">+</button>
+            <button class="btn-add-plan" id="btn-import-clipboard" title="Import plan from clipboard">📋</button>
             <span class="column-count" id="count-${escapeAttr(def.id)}">0</span>
        </div>`
     : `<span class="column-count" id="count-${escapeAttr(def.id)}">0</span>`;
```

### B.2 — `src/webview/kanban.html` (JS event listener)
```diff
 document.getElementById('btn-add-plan')?.addEventListener('click', () => {
     postKanbanMessage({ type: 'createPlan' });
 });
+
+document.getElementById('btn-import-clipboard')?.addEventListener('click', () => {
+    postKanbanMessage({ type: 'importFromClipboard' });
+});
```

### B.3 — `src/services/KanbanProvider.ts`
```diff
         case 'createPlan':
             await vscode.commands.executeCommand('switchboard.initiatePlan');
             break;
+        case 'importFromClipboard':
+            await vscode.commands.executeCommand('switchboard.importPlanFromClipboard');
+            break;
     }
```

### B.4 — `src/extension.ts`
```diff
 const initiatePlanDisposable = vscode.commands.registerCommand('switchboard.initiatePlan', async () => {
     await taskViewerProvider?.createDraftPlanTicket();
 });
 context.subscriptions.push(initiatePlanDisposable);
+
+const importFromClipboardDisposable = vscode.commands.registerCommand('switchboard.importPlanFromClipboard', async () => {
+    await taskViewerProvider?.importPlanFromClipboard();
+});
+context.subscriptions.push(importFromClipboardDisposable);
```

### B.5 — `src/services/TaskViewerProvider.ts`
```diff
     public async createDraftPlanTicket(): Promise<void> {
         // ... existing code ...
     }
 
+    public async importPlanFromClipboard(): Promise<void> {
+        const text = await vscode.env.clipboard.readText();
+
+        if (!text || !text.trim()) {
+            vscode.window.showWarningMessage('Clipboard is empty. Copy a Markdown plan first.');
+            return;
+        }
+        if (text.length > 200_000) {
+            vscode.window.showWarningMessage('Clipboard content is too large (>200 KB). Aborting import.');
+            return;
+        }
+
+        const h1Match = text.match(/^#\s+(.+)$/m);
+        const title = h1Match ? h1Match[1].trim() : 'Imported Plan';
+
+        if (!h1Match) {
+            vscode.window.showWarningMessage('No "# Title" found in clipboard. Importing with default title.');
+        }
+
+        try {
+            const { sessionId } = await this._createInitiatedPlan(title, text, false);
+            await this._refreshRunSheets();
+            vscode.window.showInformationMessage(`Imported plan: ${title}`);
+        } catch (err: any) {
+            const msg = err?.message || String(err);
+            vscode.window.showErrorMessage(`Clipboard import failed: ${msg}`);
+        }
+    }
+
     private async _createInitiatedPlan(...) {
         // ... existing code ...
     }
```

---

## Code Review (2026-03-19)

### Stage 1 — Grumpy Principal Engineer

> *A clipboard import button. How delightfully pedestrian. Let me see if this masterpiece of UX innovation was implemented without burning down the session registry.*

- **NIT — Emoji replaced with icon image.** The plan spec says use `📋` emoji (line 92), but the implementation uses `<img src="${ICON_IMPORT_CLIPBOARD}">` with a proper sci-fi icon (`25-101-150 Sci-Fi Flat icons-121.png`). This is actually BETTER than the plan — consistent with the icon system used by every other button. But the plan-to-implementation delta should be documented. Someone reading only the plan would expect an emoji.
- **NIT — `_refreshRunSheets()` call might be redundant.** `_createInitiatedPlan` already calls `_refreshRunSheets()` internally (after plan registration and event logging). The explicit second call in `importPlanFromClipboard()` (line 7617) is harmless (runsheet refresh is idempotent) but unnecessary. Not a bug — just noise.
- **NIT — H1 regex anchoring.** The regex `/^#\s+(.+)$/m` will match the FIRST `# Heading` in the clipboard. If some psychopath has a clipboard with `## Subheading` before `# Title`, it still works because `^#\s+` only matches a single `#`. Correct behavior, but would be nice to document this is intentional.

**Severity summary:** 0 CRITICAL, 0 MAJOR, 3 NIT.

### Stage 2 — Balanced Synthesis

**Keep — everything.** This is a clean, minimal implementation that follows every existing pattern:
- **UI button:** `kanban.html` line 848 — proper icon, reuses `.btn-add-plan` class. ✅
- **Event listener:** `kanban.html` line 906-908 — posts `importFromClipboard` message. ✅
- **Message router:** `KanbanProvider.ts` line 1368-1370 — delegates to VS Code command. ✅
- **Command registration:** `extension.ts` line 780-783 — follows `initiatePlan` pattern exactly. ✅
- **Backend method:** `TaskViewerProvider.ts` line 7596-7623 — validates empty, oversized, and missing-header cases. Error handling with try/catch. Delegates to `_createInitiatedPlan`. ✅
- **Icon injection:** `KanbanProvider.ts` line 1452 — `ICON_IMPORT_CLIPBOARD` placeholder mapped to icon file. ✅
- **Icon file:** `icons/25-101-150 Sci-Fi Flat icons-121.png` — exists. ✅

**Fix now:** Nothing. All NITs are cosmetic or documentation-level.

**Defer:** Consider removing the redundant `_refreshRunSheets()` call in a future cleanup pass. Zero risk leaving it.

### Validation Results
- `npm run compile` — **PASS** (exit 0)
- All kanban regression tests — **PASS**

### Files Changed During Review
- None.

### Remaining Risks
- None material. The only risk is if `_createInitiatedPlan` changes its internal `_refreshRunSheets()` call in the future, but the redundant external call provides an extra safety net, not a liability.

### Review Status: ✅ APPROVED
