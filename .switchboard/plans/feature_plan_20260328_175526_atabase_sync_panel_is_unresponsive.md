# Database & Sync Panel Is Unresponsive

## Goal
The Database & Sync panel in the sidebar does not respond to button clicks. All buttons (`Edit Path`, `Test`, cloud presets, `Set Archive Path`, `Install`, `Open DuckDB Terminal`, `EXPORT`, `STATS`, `RESET`) appear visually but clicking them produces no effect.

## Metadata
**Tags:** frontend, UI, bugfix
**Complexity:** High

## User Review Required

> [!IMPORTANT]
> This is a debugging/investigation bug. The root cause analysis below identifies the most likely cause (CSP-blocked inline `onclick` handlers), but the implementer MUST verify the hypothesis before applying the fix. If the root cause is different, adapt accordingly.

## Complexity Audit

### Routine
- Once root cause is confirmed, converting `onclick` attributes to `addEventListener` calls is mechanical refactoring.
- The toggle button (`db-sync-toggle-btn`) already uses `addEventListener` and works correctly — it serves as a working reference.

### Complex / Risky
- **Root cause investigation:** The code in `TaskViewerProvider.ts` (lines 3329-3527) has fully wired message handlers for ALL Database & Sync button types (`editDbPath`, `testDbConnection`, `setPresetDbPath`, `editArchivePath`, `installCliTool`, `openCliTerminal`, `exportToArchive`, `viewDbStats`, `resetDatabase`). The HTML in `implementation.html` (lines 1708-1777) has all buttons with `onclick` handlers. The backend response handlers (lines 2800-2814) exist. **The wiring is complete.** The issue is almost certainly that inline `onclick` attributes are being silently blocked by the webview's Content Security Policy (CSP), while `addEventListener` calls work fine.
- **CSP verification:** Must inspect the webview's CSP meta tag to confirm `'unsafe-inline'` for scripts is NOT present (which would block `onclick`). The kanban webview (`kanban.html`) uses `addEventListener` exclusively and works — this confirms the pattern.

## Edge-Case & Dependency Audit
- **Race Conditions:** None relevant. The buttons are synchronous click handlers.
- **Security:** Converting from inline `onclick` to `addEventListener` actually IMPROVES security posture — it allows the CSP to remain strict (no `'unsafe-inline'`).
- **Side Effects:** Each button triggers VS Code API calls (input boxes, clipboard, terminal creation, DB operations). These are all already implemented and tested via the message handler — only the frontend trigger mechanism is broken.
- **Dependencies & Conflicts:** None. No other pending plans modify the Database & Sync panel.

## Adversarial Synthesis

### Grumpy Critique
"Let me get this straight — you shipped an entire Database & Sync panel where EVERY button uses `onclick` inline handlers, while the rest of the extension uses `addEventListener`, and nobody noticed they were all dead on arrival? This is what happens when you don't have integration tests for your webview. The CSP hypothesis is solid, but here's what worries me: if you just blindly convert all `onclick` to `addEventListener`, you might introduce bugs with `vscode` not being in scope inside the listener, or with the `document.getElementById` calls returning null because the panel is collapsed (hidden) when the listeners are registered. Also, the DuckDB Install and Open Terminal buttons have conditional enable/disable logic — make sure that still works after the refactor."

### Balanced Response
1. **Testing gap acknowledged.** Webview integration testing is notoriously difficult in VS Code extensions. The fix should include a manual QA checklist for every button.
2. **Scope of `vscode`:** The `vscode` API object is acquired at the top of the script via `const vscode = acquireVsCodeApi()` and is available in module scope — `addEventListener` callbacks have the same closure access as `onclick` handlers.
3. **Collapsed panel / null elements:** The panel HTML is always in the DOM even when collapsed (the toggle just hides/shows via CSS class). `getElementById` will find the elements regardless of visibility. However, we will add null guards (`?.addEventListener`) for safety.
4. **Conditional enable/disable:** The `disabled` attribute on the DuckDB buttons is managed by the `updateCliToolStatus` response handler. This is independent of how click events are registered and will continue to work.

## Proposed Changes

### Root Cause Verification Step

#### [INVESTIGATE] `src/webview/implementation.html`
- **Context:** Before making changes, the implementer must verify the CSP hypothesis.
- **Logic:**
  1. Search for `<meta http-equiv="Content-Security-Policy"` in `implementation.html` or in the `TaskViewerProvider.ts` method that generates the webview HTML.
  2. Confirm that `script-src` does NOT include `'unsafe-inline'`.
  3. Open the VS Code Developer Tools (Help → Toggle Developer Tools) while the sidebar is open. Check the Console for CSP violation errors like `"Refused to execute inline event handler because it violates the following Content Security Policy directive"`.
  4. If CSP violation is confirmed, proceed with the fix below. If not, investigate alternative causes (JS errors preventing script execution, webview not fully loaded, etc.).

### Convert Inline Handlers to addEventListener

#### [MODIFY] `src/webview/implementation.html`
- **Context:** The Database & Sync panel buttons (lines 1708-1777) all use inline `onclick` attributes. These need to be converted to `addEventListener` calls in a `<script>` block.
- **Logic:**
  1. Remove all `onclick="..."` attributes from the Database & Sync panel buttons.
  2. Add `id` attributes to each button for targeting.
  3. Add a script section at the bottom of the webview (near the existing toggle handler at line 3960) that registers click listeners for each button.
- **Implementation:**

**Step 1 — Update button HTML** (lines 1708-1777). Remove `onclick` attributes and add `id` attributes:

Replace each button's `onclick` with an `id`. For example:

Current:
```html
<button onclick="vscode.postMessage({type:'editDbPath'})" class="db-secondary-btn">
  Edit Path
</button>
```

Replace with:
```html
<button id="db-edit-path-btn" class="db-secondary-btn">
  Edit Path
</button>
```

Apply the same pattern to ALL buttons in the panel:
| Current onclick | New id |
|---|---|
| `vscode.postMessage({type:'editDbPath'})` | `db-edit-path-btn` |
| `vscode.postMessage({type:'testDbConnection'})` | `db-test-connection-btn` |
| `vscode.postMessage({type:'setPresetDbPath',preset:'google-drive'})` | `db-preset-google-btn` |
| `vscode.postMessage({type:'setPresetDbPath',preset:'dropbox'})` | `db-preset-dropbox-btn` |
| `vscode.postMessage({type:'setPresetDbPath',preset:'icloud'})` | `db-preset-icloud-btn` |
| `vscode.postMessage({type:'editArchivePath'})` | `db-edit-archive-btn` |
| `vscode.postMessage({type:'installCliTool',tool:'duckdb'})` | `duckdb-install-btn` (already has this id) |
| `vscode.postMessage({type:'openCliTerminal',tool:'duckdb'})` | `open-duckdb-btn` (already has this id) |
| `vscode.postMessage({type:'exportToArchive'})` | `db-export-btn` |
| `vscode.postMessage({type:'viewDbStats'})` | `db-stats-btn` |
| `vscode.postMessage({type:'resetDatabase'})` | `db-reset-btn` |

**Step 2 — Add addEventListener registrations** (near line 3960, after the existing toggle handler):

```javascript
// Database & Sync panel button handlers
document.getElementById('db-edit-path-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'editDbPath' });
});
document.getElementById('db-test-connection-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'testDbConnection' });
});
document.getElementById('db-preset-google-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'setPresetDbPath', preset: 'google-drive' });
});
document.getElementById('db-preset-dropbox-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'setPresetDbPath', preset: 'dropbox' });
});
document.getElementById('db-preset-icloud-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'setPresetDbPath', preset: 'icloud' });
});
document.getElementById('db-edit-archive-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'editArchivePath' });
});
document.getElementById('duckdb-install-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'installCliTool', tool: 'duckdb' });
});
document.getElementById('open-duckdb-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openCliTerminal', tool: 'duckdb' });
});
document.getElementById('db-export-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'exportToArchive' });
});
document.getElementById('db-stats-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'viewDbStats' });
});
document.getElementById('db-reset-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'resetDatabase' });
});
```

- **Edge Cases Handled:** Optional chaining (`?.addEventListener`) guards against null elements. The `disabled` attribute on DuckDB buttons is managed by the `updateCliToolStatus` response handler and is independent of the event registration — disabled buttons won't fire click events regardless of how they're registered.

## Open Questions

- **Confirm CSP is the root cause:** The implementer must verify via Developer Tools console before applying the fix. If the CSP allows inline scripts, the root cause is something else (JS error, webview load timing, etc.) and the plan must be revised.

## Verification Plan

### Manual Verification
1. Open VS Code with Switchboard extension active.
2. Expand the Database & Sync panel in the sidebar.
3. **Edit Path:** Click "Edit Path" → VS Code input box should appear.
4. **Test:** Click "Test" → Success/failure message should appear.
5. **Google Drive preset:** Click "Google Drive" → Path should update.
6. **Dropbox preset:** Click "Dropbox" → Path should update.
7. **iCloud preset (macOS):** Click "iCloud" → Path should update.
8. **Set Archive Path:** Click → VS Code input box should appear.
9. **Install DuckDB:** Click → Modal with install command should appear.
10. **Open DuckDB Terminal:** Set archive path first, then click → Terminal should open.
11. **EXPORT:** Click → Export command should execute.
12. **STATS:** Click → Stats info message should appear.
13. **RESET:** Click → Confirmation dialog should appear.
14. **Toggle:** Verify the collapsible toggle still works (it already uses addEventListener).

### Build Verification
- Run `npm run compile` — no errors.
- Open Developer Tools console — verify NO CSP violation errors.

### Agent Recommendation
**Send to Lead Coder** — Requires root cause investigation/verification before applying the fix. The implementer needs to inspect CSP settings and potentially debug in Developer Tools.

---

## Reviewer Pass — 2026-03-28

### Verification Results
- **`npx tsc --noEmit`**: ✅ PASS — zero errors
- **CSP hypothesis confirmed**: `KanbanProvider.ts` line 2193 sets `script-src 'nonce-${nonce}'` — no `'unsafe-inline'`, confirming inline `onclick` attributes are blocked
- **Code review**: All plan steps verified against implementation

### Root Cause Verification
- CSP meta tag injected at `KanbanProvider.ts:2193`: `script-src 'nonce-${nonce}' ${webview.cspSource}` — no `'unsafe-inline'`
- `<script>` tags get `nonce` attribute via line 2195: `content.replace(/<script>/g, \`<script nonce="${nonce}">\`)`
- Inline `onclick="..."` HTML attributes have no nonce → blocked by CSP ✅
- Programmatic `.onclick = function` assignments (used elsewhere in file) are NOT blocked by CSP ✅
- Toggle button (`db-sync-toggle-btn`) already used `addEventListener` and worked — confirms pattern ✅

### Implementation Status

| Button | ID | addEventListener | Message Type |
|---|---|---|---|
| Edit Path | `db-edit-path-btn` | ✅ line 3969 | `editDbPath` |
| Test | `db-test-connection-btn` | ✅ line 3972 | `testDbConnection` |
| Google Drive | `db-preset-google-btn` | ✅ line 3975 | `setPresetDbPath` (google-drive) |
| Dropbox | `db-preset-dropbox-btn` | ✅ line 3978 | `setPresetDbPath` (dropbox) |
| iCloud | `db-preset-icloud-btn` | ✅ line 3981 | `setPresetDbPath` (icloud) |
| Set Archive Path | `db-edit-archive-btn` | ✅ line 3984 | `editArchivePath` |
| Install DuckDB | `duckdb-install-btn` | ✅ line 3987 | `installCliTool` (duckdb) |
| Open DuckDB Terminal | `open-duckdb-btn` | ✅ line 3990 | `openCliTerminal` (duckdb) |
| EXPORT | `db-export-btn` | ✅ line 3993 | `exportToArchive` |
| STATS | `db-stats-btn` | ✅ line 3996 | `viewDbStats` |
| RESET | `db-reset-btn` | ✅ line 3999 | `resetDatabase` |

### Files Changed
- `src/webview/implementation.html` — removed inline `onclick` from 11 buttons, added `id` attributes, added `addEventListener` registrations (lines 3968-4001)

### Review Findings
- **0 CRITICAL**, **0 MAJOR**, **2 NIT**
- NIT: MCP recheck span at line 1792 also has inline `onclick="..."` — same CSP issue, out of scope for this plan, file as follow-up
- NIT: No comment on disabled-button click suppression behavior — style preference

### Remaining Risks
- MCP recheck button (`recheckMcpConnection`) at line 1792 has the same inline `onclick` CSP issue — should be filed as a separate bug
