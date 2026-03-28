# Improving Ticket View Layout and Interactivity

## Goal

The Ticket View requires layout responsiveness improvements and more intuitive interactivity for editing and navigation. Specifically: (1) add an inline edit icon next to the ticket title, (2) remove the "Send to Agent" button, (3) sync sidebar selection when a plan is rendered, and (4) adjust the meta-grid media query breakpoint from 960px to 600px.

## Metadata
**Tags:** frontend, UI
**Complexity:** Low

## User Review Required
> [!NOTE]
> - The "Send to Agent" button and its event listener will be **permanently removed** from the Ticket View webview. The backend `sendToAgent` message handler in `ReviewProvider.ts` will remain intact (dead code) for now to avoid scope creep; it can be pruned in a follow-up.
> - The new `switchboard.selectSession` VS Code command is a public extension command. Any other provider can call it to sync the sidebar selection.

## Complexity Audit

### Routine
- Add `flex: 1` to `.header-copy` CSS rule (single property addition)
- Add an inline SVG edit icon next to the `<h1>` title in the header HTML
- Wire the edit icon click to toggle `.title-input` visibility (mirrors existing `applyMode` toggle logic)
- Remove the `<button id="send-to-agent">` element from HTML
- Remove the `sendToAgentButtonEl` DOM reference and its `addEventListener('click', ...)` handler from JavaScript
- Remove the `sendToAgentButtonEl` usage from `updateActionButtons()`
- Change `@media (max-width: 960px)` breakpoint to `@media (max-width: 600px)` on `.meta-grid`
- Reduce padding/gaps in the vertical stack mode within that media query
- Emit `planShown` message from webview when ticket data is rendered
- Register `switchboard.selectSession` command in `extension.ts` delegating to `taskViewerProvider.selectSession()`
- Handle `planShown` message in `ReviewProvider._handleMessage()`

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** The `planShown` message is emitted synchronously at the end of `renderTicketData()`. The `switchboard.selectSession` command calls `taskViewerProvider.selectSession()` which posts a message to the sidebar webview. If the sidebar is not yet initialized, the message will be silently dropped — this is acceptable because the sidebar initializes on extension activation and the Ticket View cannot be opened before the sidebar exists.
- **Security:** No new user input surfaces. The edit icon toggles an existing `<input>` that is already sanitized. The `planShown` handler passes a `sessionId` from the webview — this is validated to be a non-empty string before executing the command.
- **Side Effects:** Removing the "Send to Agent" button removes a user interaction path. The backend handler `case 'sendToAgent'` in `ReviewProvider._handleMessage()` becomes unreachable dead code but causes no harm.
- **Dependencies & Conflicts:** The Kanban board has a separate plan "Stale Kanban Card Persistence" (`sess_1774683968184`) in `PLAN REVIEWED`. It modifies `KanbanProvider.ts` but does not touch `review.html`, `ReviewProvider.ts`, or `extension.ts` — no conflict. The "∂atabase & sync panel is unresponsive" plan (`sess_1774680926180`) also does not touch these files.

## Adversarial Synthesis

### Grumpy Critique

*Oh WONDERFUL, another "just add a CSS property and ship it" plan. Let me count the ways this will go sideways:*

1. **The edit icon toggle is half-baked.** The plan says "clicking the edit icon toggles the title input visibility" but `applyMode()` already controls title input visibility based on `state.isPreview`. So what happens when the user clicks the edit icon while in preview mode? You'll show the `<input>` but the textarea stays hidden. Now you have a Franken-state: preview mode with an editable title and a non-editable body. **Define the interaction model precisely or you'll ship a confused UI.**

2. **Removing `sendToAgentButtonEl` from `updateActionButtons()` but leaving the backend handler is a maintenance trap.** Six months from now someone will see `case 'sendToAgent'` in `ReviewProvider.ts` and wonder why it exists. At minimum, add a `// DEAD CODE` comment.

3. **The breakpoint change from 960px to 600px is arbitrary.** VS Code sidebar panels in the default layout are ~300-500px wide. A 600px breakpoint means the vertical stack will NEVER trigger in a sidebar panel. Is that the intent? If the Ticket View is opened as a full editor tab it will trigger, but in a narrow panel it won't because the panel width is already < 600px and the breakpoint is max-width. **Actually wait — the media query uses `max-width`, which triggers when the viewport is LESS THAN 600px. So on narrow sidebar panels (300px), the vertical stack WILL trigger. On laptops (800px) it WON'T stack. This is correct.** Fine, I retract that one.

4. **The `planShown` → `selectSession` pipeline has no guard against the current session.** If the sidebar already has this session selected, you'll send a redundant `selectSession` message, which will re-render the sidebar item. Probably harmless, but wasteful.

5. **No accessibility consideration for the edit icon.** Raw SVG with no `aria-label`, no `tabindex`, no `role="button"`. Screen readers won't know it's interactive.

### Balanced Response

Grumpy raises valid concerns. Here's how the implementation addresses them:

1. **Edit icon interaction model:** The edit icon ONLY toggles the title input visibility — it does NOT switch between preview and edit mode for the body. This is intentional: users should be able to rename a ticket without entering full edit mode. The `applyMode()` function will be updated to NOT hide the title input if the user explicitly toggled it via the edit icon. However, to keep this simple and avoid state complexity, the edit icon will simply set `state.isPreview = false` and call `applyMode()` — same as clicking "Edit Plan". This is consistent and expected.

2. **Dead code comment:** Agreed. A `// NOTE: Handler retained for API compatibility; button removed from UI` comment will be added.

3. **Breakpoint:** The 600px value is correct as analyzed — it stacks on narrow panels and stays horizontal on laptop-width editor tabs.

4. **Redundant selectSession guard:** The sidebar's `selectSession` handler already does a no-op if the session is already active (it highlights the already-highlighted item). The redundancy is harmless and not worth a guard.

5. **Accessibility:** The edit icon will be wrapped in a `<button>` with `aria-label="Edit title"` and `title="Edit title"` for screen reader and tooltip support.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Complete code blocks below. No truncation.

---

### [Webview] review.html

#### [MODIFY] [review.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/review.html)

- **Context:** This is the Ticket View webview. Four changes are required: (1) add `flex: 1` to `.header-copy`, (2) add edit icon button next to the title, (3) remove the "Send to Agent" button, (4) change the media query breakpoint from 960px to 600px with reduced gaps.

##### Change 1: Add `flex: 1` to `.header-copy` (CSS, line ~49-51)

**Logic:** The `.header-copy` div contains the eyebrow label and title. On wide monitors, it should expand to fill available horizontal space so the title doesn't get cramped against the action buttons. Adding `flex: 1` achieves this within the existing flex container.

**Current code (lines 49-51):**
```css
.header-copy {
    min-width: 0;
}
```

**Replace with:**
```css
.header-copy {
    min-width: 0;
    flex: 1;
}
```

##### Change 2: Add edit icon button styles (CSS, after `.title-input` block, line ~75)

**Logic:** Add styles for the new edit title button that sits inline next to the `<h1>` title. The button is transparent with icon-only styling, and inherits the accent color on hover.

**Insert after the `.title-input` block (after line 75):**
```css
.edit-title-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    color: var(--muted);
    opacity: 0.7;
    transition: opacity 0.15s, color 0.15s;
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
    margin-left: 6px;
}

.edit-title-btn:hover {
    opacity: 1;
    color: var(--accent);
}

.edit-title-btn svg {
    width: 14px;
    height: 14px;
}

.title-row {
    display: flex;
    align-items: center;
    gap: 4px;
}
```

##### Change 3: Update header HTML to add edit icon and remove "Send to Agent" (HTML, lines ~484-498)

**Logic:** (a) Wrap the `<h1>` title in a `.title-row` flex container and add an edit icon button after it. (b) Remove the `<button id="send-to-agent">` element entirely.

**Current HTML (lines 484-498):**
```html
<div class="header">
    <div class="header-copy">
        <div class="eyebrow">Ticket View</div>
        <h1 class="title" id="header-title">Plan Ticket</h1>
        <input id="header-title-input" class="title-input hidden" type="text" placeholder="Untitled Plan" />
    </div>
    <div class="header-actions">
        <button id="copy-plan-link">Copy Link</button>
        <button id="open-log-modal">Log</button>
        <button id="send-to-agent">Send to Agent</button>
        <button id="complete-plan">Complete</button>
        <button id="delete-plan" class="danger">Delete</button>
        <button class="primary" id="save-plan">Save</button>
    </div>
</div>
```

**Replace with:**
```html
<div class="header">
    <div class="header-copy">
        <div class="eyebrow">Ticket View</div>
        <div class="title-row">
            <h1 class="title" id="header-title">Plan Ticket</h1>
            <button class="edit-title-btn" id="edit-title-btn" aria-label="Edit title" title="Edit title">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
        </div>
        <input id="header-title-input" class="title-input hidden" type="text" placeholder="Untitled Plan" />
    </div>
    <div class="header-actions">
        <button id="copy-plan-link">Copy Link</button>
        <button id="open-log-modal">Log</button>
        <button id="complete-plan">Complete</button>
        <button id="delete-plan" class="danger">Delete</button>
        <button class="primary" id="save-plan">Save</button>
    </div>
</div>
```

##### Change 4: Update media query breakpoint (CSS, lines 444-463)

**Logic:** Change the `@media (max-width: 960px)` breakpoint to `@media (max-width: 600px)`. This ensures that on laptop-width editor tabs (~800px), the Column/Complexity/Dependencies fields stay horizontal. Only on narrow sidebar panels do they stack vertically. Also reduce gaps in vertical mode for compact display.

**Current code (lines 444-463):**
```css
@media (max-width: 960px) {
    .meta-grid {
        flex-direction: column;
        align-items: stretch;
    }

    .field {
        flex-direction: column;
        align-items: stretch;
        gap: 3px;
    }

    .field select {
        width: 100%;
    }

    .field.dependencies {
        flex: unset;
    }
}
```

**Replace with:**
```css
@media (max-width: 600px) {
    .meta-grid {
        flex-direction: column;
        align-items: stretch;
        gap: 2px 10px;
        padding: 3px 10px;
    }

    .field {
        flex-direction: column;
        align-items: stretch;
        gap: 2px;
    }

    .field select {
        width: 100%;
    }

    .field.dependencies {
        flex: unset;
    }
}
```

##### Change 5: Update JavaScript — remove sendToAgent references, add edit icon, emit planShown (JS)

**Logic:**
- Remove `sendToAgentButtonEl` DOM reference (line 590)
- Remove `sendToAgentButtonEl` from `updateActionButtons()` (lines 671-672)
- Remove `sendToAgentButtonEl.addEventListener('click', ...)` handler (lines 992-996)
- Add `editTitleBtnEl` DOM reference and click handler to toggle into edit mode
- Emit `planShown` message at end of `renderTicketData()` to sync sidebar selection

**Remove the `sendToAgentButtonEl` variable declaration (line 590):**
```javascript
// DELETE this line:
const sendToAgentButtonEl = document.getElementById('send-to-agent');
```

**Remove `sendToAgentButtonEl` usage from `updateActionButtons()` (lines 671-672):**
```javascript
// DELETE these two lines:
sendToAgentButtonEl.disabled = !hasSession || disabled || isCompleted || isFinalColumn;
sendToAgentButtonEl.textContent = isCompleted ? 'Completed' : (isFinalColumn ? 'Already Reviewed' : 'Send to Agent');
```

**Remove `sendToAgentButtonEl.addEventListener(...)` (lines 992-996):**
```javascript
// DELETE this block:
sendToAgentButtonEl.addEventListener('click', () => {
    setBusy(true);
    setStatus('Sending to next agent...');
    vscode.postMessage({ type: 'sendToAgent', sessionId: state.sessionId });
});
```

**Add edit icon button reference and handler (after existing DOM references, around line 598):**
```javascript
const editTitleBtnEl = document.getElementById('edit-title-btn');
```

**Add click handler for edit icon (after the `headerTitleInputEl` input handler, around line 982):**
```javascript
editTitleBtnEl.addEventListener('click', () => {
    state.isPreview = false;
    applyMode();
    headerTitleInputEl.focus();
});
```

**Add `planShown` emission at end of `renderTicketData()` function (inside `renderTicketData`, after `setBusy(false)`, around line 908):**
```javascript
// Notify extension that this plan is currently being shown (sidebar sync)
if (state.sessionId) {
    vscode.postMessage({ type: 'planShown', sessionId: state.sessionId });
}
```

- **Edge Cases Handled:** The `planShown` message is only emitted when `state.sessionId` is truthy, avoiding sending empty/undefined session IDs for non-session-backed plans. The edit icon handler reuses the existing `applyMode()` pathway so all state transitions are consistent.

---

### [Extension] extension.ts

#### [MODIFY] [extension.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts)

- **Context:** Register a new VS Code command `switchboard.selectSession` that delegates to `taskViewerProvider.selectSession()`. This allows the `ReviewProvider` to trigger sidebar selection changes without holding a direct reference to `TaskViewerProvider`.
- **Logic:** Find the command registration block in the `activate()` function and add a new `registerCommand` call. The `TaskViewerProvider.selectSession()` method already exists (confirmed at line 685 of TaskViewerProvider.ts) and accepts a `sessionId: string`.
- **Implementation:** Add the following command registration alongside existing commands:

```typescript
context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.selectSession', (sessionId: string) => {
        if (typeof sessionId === 'string' && sessionId.trim()) {
            taskViewerProvider.selectSession(sessionId);
        }
    })
);
```

- **Edge Cases Handled:** Input validation ensures only non-empty strings are forwarded. If `sessionId` is undefined or empty, the command is a silent no-op.

---

### [Service] ReviewProvider.ts

#### [MODIFY] [ReviewProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/ReviewProvider.ts)

- **Context:** Handle the new `planShown` message from the webview to sync sidebar selection. Also add a dead-code comment on the `sendToAgent` handler.
- **Logic:** In `_handleMessage()`, add a case for `planShown` that extracts the `sessionId` and executes the new `switchboard.selectSession` command. The `sendToAgent` case remains but gets a comment noting the UI button was removed.

**Add new case in `_handleMessage()` switch block (after the `'ready'` case, around line 146):**

```typescript
case 'planShown': {
    // Sync the sidebar selection with the plan currently being viewed
    const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId.trim() : '';
    if (sessionId) {
        vscode.commands.executeCommand('switchboard.selectSession', sessionId);
    }
    break;
}
```

**Add comment to existing `sendToAgent` case (line 237):**

```typescript
// NOTE: UI button removed from review.html; handler retained for API compatibility
case 'sendToAgent': {
```

- **Edge Cases Handled:** Empty/undefined `sessionId` is silently ignored. The command execution is fire-and-forget (no `await` needed since `selectSession` is a synchronous webview message post).

## Verification Plan

### Automated Tests
- Compile the extension with `npm run compile` to verify no TypeScript errors.
- Grep for `send-to-agent` in `review.html` to confirm the button element and its JavaScript references are fully removed.
- Grep for `planShown` to confirm it appears in both `review.html` (emitted) and `ReviewProvider.ts` (handled).
- Grep for `switchboard.selectSession` to confirm it appears in `extension.ts` (registered) and `ReviewProvider.ts` (invoked).

### Manual Verification
- Open the Ticket View in VS Code.
- Resize the sidebar/panel to simulate different monitor sizes (Large Monitor, Laptop, Narrow Sidebar).
- Verify that:
    - The title field expands on large screens (flex: 1 on `.header-copy`).
    - The edit icon (pencil) appears next to the title and shows a tooltip on hover.
    - Clicking the edit icon switches to edit mode and focuses the title input.
    - The "Send to Agent" button is no longer visible.
    - Column, Complexity, and Dependencies stay horizontal on laptop-sized widths (~800px).
    - Layout stacks gracefully and compactly on narrow sidebar widths (<600px).
    - Opening a ticket auto-selects it in the sidebar.
