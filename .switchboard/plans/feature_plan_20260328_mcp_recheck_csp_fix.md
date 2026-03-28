# Fix MCP Recheck Button CSP Blocking

## Goal
Fix the MCP recheck button in the implementation panel that is currently non-functional due to CSP blocking its inline `onclick` handler.

## Background
The Database & Sync panel had the same issue (fixed in `feature_plan_20260328_175526_atabase_sync_panel_is_unresponsive.md`). The MCP recheck span at `implementation.html:1792` has an inline `onclick="vscode.postMessage(...)"` attribute that is blocked by the Content-Security-Policy header which uses `script-src 'nonce-...'` without `'unsafe-inline'`.

The button appears clickable but does nothing when clicked. This is a silent failure that degrades UX.

## Implementation

### 1. Add ID attribute to the span
**File:** `src/webview/implementation.html`

Change line 1792 from:
```html
<span id="mcp-recheck" title="Recheck MCP connection"
    style="cursor:pointer; margin-left:4px; opacity:0.6; font-size:11px;"
    onclick="vscode.postMessage({ type: 'recheckMcpConnection' })">&#x21bb;</span>
```

To:
```html
<span id="mcp-recheck-btn" title="Recheck MCP connection"
    style="cursor:pointer; margin-left:4px; opacity:0.6; font-size:11px;">&#x21bb;</span>
```

Note: Remove the `onclick` attribute, change `id` from `mcp-recheck` to `mcp-recheck-btn` for clarity.

### 2. Add event listener registration
**File:** `src/webview/implementation.html`

In the script section where other event listeners are registered (near the other `addEventListener` calls for the Database & Sync panel, around line 3968+), add:

```javascript
document.getElementById('mcp-recheck-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'recheckMcpConnection' });
});
```

### 3. Verify backend handler exists
**File:** `src/services/ImplementationProvider.ts` (or wherever `recheckMcpConnection` is handled)

Confirm that the message handler for `recheckMcpConnection` still exists and functions correctly. This handler was working before the CSP change broke the button trigger.

## Verification Plan

### Manual Verification
1. Open Switchboard implementation panel
2. Look at the MCP status line (should show "CHECKING", "CONNECTED", or similar)
3. Click the ↻ (recheck) icon next to the MCP status
4. **Expected:** The MCP status should briefly show "CHECKING" again, then update to current status
5. **Failure mode:** If broken, clicking does nothing (no visual feedback, no status change)

### Build Verification
- Run `npm run compile` — no TypeScript errors
- Run `npx tsc --noEmit` — no type regressions

## Complexity
- **Scope:** 1 file (`implementation.html`), 2 small edits
- **Risk:** Low — same fix pattern already validated for 11 buttons in the Database & Sync panel
- **Dependencies:** None

## Adversarial Considerations
- **What could go wrong:** 
  - If the backend `recheckMcpConnection` handler was removed or renamed, the button will appear to work but backend will ignore the message
  - If the element ID is mistyped, the event listener won't attach and button stays broken
- **How to verify:** Manual click test is sufficient; no silent failures possible (either works or doesn't)

## Agent Recommendation
**Send to Coder** — Single file, well-defined scope, established pattern from previous fix. No architectural decisions required.
