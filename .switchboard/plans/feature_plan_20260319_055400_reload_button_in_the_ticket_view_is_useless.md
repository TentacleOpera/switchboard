# Reload button in the ticket view is useless

## Goal
Wgy does the 'reload' button in the ticket view even exist? It does nothing useful. Remove it. 

## Root Cause Analysis

**Current Implementation:**
- Reload button: `src/webview/review.html:472` - `<button id="reload-ticket">Reload</button>`
- Button element reference: line 565 - `const reloadTicketButtonEl = document.getElementById('reload-ticket');`
- Click handler: lines 966-970 - Sends `{type: 'ready'}` message to backend
- Disabled state: line 661 - `reloadTicketButtonEl.disabled = disabled;`

**What It Does:**
Sends a `'ready'` message to the backend, which triggers the same data refresh that happens on initial webview load. This re-reads the plan file from disk and updates the view.

**Why It Feels Useless:**
1. The ticket view auto-updates after Save operations
2. No visual indicator shows when external changes exist
3. Users don't know when to use it vs when the view is already current
4. The mtime conflict check on save already warns about external changes

**Trade-off:**
Removing the button means users cannot manually sync external file changes (from other agents, git operations, or manual edits) without closing and reopening the ticket. However, the mtime conflict detection on save handles the critical case.

## Proposed Changes

### Step 1: Remove Reload Button from HTML
**File:** `src/webview/review.html`
**Line:** 472

**Change:**
```html
<!-- REMOVE THIS LINE -->
<button id="reload-ticket">Reload</button>
```

### Step 2: Remove Button Element Reference
**File:** `src/webview/review.html`
**Line:** 565

**Change:**
```javascript
// REMOVE THIS LINE
const reloadTicketButtonEl = document.getElementById('reload-ticket');
```

### Step 3: Remove Click Handler
**File:** `src/webview/review.html`
**Lines:** 966-970

**Change:**
```javascript
// REMOVE THESE LINES
reloadTicketButtonEl.addEventListener('click', () => {
    setBusy(true);
    setStatus('Reloading ticket...');
    vscode.postMessage({ type: 'ready' });
});
```

### Step 4: Remove Disabled State Management
**File:** `src/webview/review.html`
**Line:** 661

**Change:**
```javascript
// REMOVE THIS LINE
reloadTicketButtonEl.disabled = disabled;
```

## Implementation Steps

1. **Remove button from header actions** (line 472)
   - Delete `<button id="reload-ticket">Reload</button>`

2. **Remove element reference** (line 565)
   - Delete `const reloadTicketButtonEl = document.getElementById('reload-ticket');`

3. **Remove event listener** (lines 966-970)
   - Delete the entire `reloadTicketButtonEl.addEventListener('click', ...)` block

4. **Remove disabled state update** (line 661)
   - Delete `reloadTicketButtonEl.disabled = disabled;` from `setBusy()` function

5. **Verify no other references exist**
   - Search for `reload-ticket` or `reloadTicket` in review.html
   - Search for `reload.*ticket` in TaskViewerProvider.ts
   - Confirm no backend handlers depend on this button

## Complexity Audit

### Band A (Routine)
- Remove HTML button element (single line deletion)
- Remove JavaScript variable reference (single line deletion)
- Remove event listener (5 line deletion)
- Remove disabled state update (single line deletion)
- All changes are in a single file (review.html)
- No logic changes, just removal of unused UI element
- No backend changes required (the 'ready' message handler is still used for initial load)

### Band B (Complex/Risky)
- None

## Dependencies

**No conflicts found:**
- Search found 247 matches for "reload|refresh|ticket view" across 49 plans
- Most are unrelated (kanban refresh, autoban reload, etc.)
- No active plans specifically address the reload button functionality
- The mtime conflict detection (TaskViewerProvider.ts:5592) remains unchanged

## Verification Plan

1. **Visual verification:**
   - Open ticket view for any plan
   - Confirm reload button is no longer visible in header actions
   - Confirm remaining buttons (Save, Delete, Complete, Send to Agent, etc.) are still present

2. **Functional verification:**
   - Open ticket view
   - Make external changes to the plan file (edit in VS Code)
   - Click Save in ticket view
   - Verify mtime conflict warning appears: "Plan file changed on disk since this ticket was opened. Reload the ticket and try again."
   - Close and reopen ticket to see external changes

3. **No JavaScript errors:**
   - Open browser console (Developer Tools)
   - Interact with ticket view (edit, save, change column, etc.)
   - Confirm no errors related to `reloadTicketButtonEl`

4. **Regression test:**
   - Verify Save button still works
   - Verify Delete button still works
   - Verify Send to Agent button still works
   - Verify Complete button still works
   - Verify all other ticket view functionality remains intact

## Open Questions

1. Should we add a FileSystemWatcher to auto-refresh when the plan file changes externally?
2. Should the mtime conflict message include instructions to close/reopen the ticket?
3. Are there any workflows where users rely on manual reload (e.g., waiting for agent to finish editing)?

## Agent Recommendation

**This is a simple plan. Send it to the Coder agent.**

**Rationale:**
- Single-file change (review.html)
- Simple element and event listener removal
- No logic changes or architectural modifications
- Low risk of breaking existing functionality
- Straightforward verification steps

---

## Reviewer Pass — 2026-03-19

### Stage 1: Grumpy Principal Engineer Review

*Well, well, well. Someone actually managed to delete a button without burning down the entire extension. I'm genuinely impressed. Let me look harder for something to complain about.*

**NIT — The `'ready'` Message Handler Still Exists in the Backend** (Severity: NIT)
The `'ready'` message type handler in `TaskViewerProvider.ts` still exists (it's used for initial webview load). The plan correctly identified this is NOT a problem — the handler is needed for initial load. But zero documentation was added to clarify that `'ready'` is now ONLY for initial load, not for manual reload. Future devs might wonder why the handler exists if there's no reload button.

**NIT — Open Questions Left Unanswered** (Severity: NIT)
Questions 1-3 (FileSystemWatcher, mtime message improvement, workflows relying on reload) remain open. None are blocking, but they represent genuine UX gaps. A FileSystemWatcher for auto-refresh would be a proper replacement for the reload button — without it, users editing plan files externally must close and reopen tickets.

*That's it. That's all I've got. I hate it when the implementation is this clean. It gives me nothing to dramatically gesture about.*

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---|---|---|
| `'ready'` handler documentation | **Defer** | Cosmetic — not a code defect |
| Open questions (FileSystemWatcher) | **Defer** | Separate feature request, not part of this removal |

### Code Fix Applied

**None required.** Implementation is clean and complete.

### Validation Results

- **Grep verification**: `reload-ticket`, `reloadTicket`, `reload` — **zero hits** in `review.html`
- **TypeScript compilation**: `npx tsc --noEmit` — **PASS** (zero errors)
- **Backend handler**: `'ready'` message type still handled correctly for initial webview load
- **No orphaned references**: No dangling JS variables or event listeners

### Files Changed

| File | Change |
|---|---|
| `src/webview/review.html` | Removed button element, element reference, click handler, disabled state management |

### Remaining Risks

None. This is a clean, single-file removal with no side effects.
