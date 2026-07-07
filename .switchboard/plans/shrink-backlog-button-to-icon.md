# Shrink "→ Backlog" Card Button to a Down-Arrow Icon

**Plan ID:** 4d8c36e2-29e8-4a80-bba3-b63a87d595a7

## Metadata
- **Complexity:** 2
- **Tags:** ui, refactor, frontend

## Goal

On cards in the NEW (CREATED) column, the "→ Backlog" action button is a full text button (`card-btn`) that visually dominates the card's action row. It should be reduced to a compact down-arrow icon button matching the size and style of the existing review (pencil) and complete (checkmark) icon buttons, and placed next to them in the right-side action group.

### Problem & Root Cause

- **Symptom:** The "→ Backlog" button looks oversized relative to its minor function.
- **Root cause:** `backlogActionBtn` (src/webview/kanban.html:5681) is rendered as a text button using the base `.card-btn` class (auto-sized to text content, `padding: 2px 6px`), while the review/complete buttons use `.card-btn.icon-btn` (fixed `20×20px`, `padding: 4px`, defined at line 1022). It is also placed in the **left** action group alongside the primary "Copy prompt and advance" text button (line 5711-5713), separating it from the other icon buttons.
- **Fix:** Convert it to an `.icon-btn` with a down-arrow SVG and relocate it into the right group with review + complete.

## Scope

- **In scope:** The `backlogActionBtn` rendered for `card.column === 'CREATED'` (non-backlog view).
- **Out of scope (per user decision):** The symmetric `send-to-new-btn` ("→ New") on BACKLOG cards stays as a text button. No behavior, tooltip semantics, or event-handler changes.

## User Review Required

No. This is a pure visual refactor of a single button's class and DOM position. No behavior, data, or handler changes. Safe to proceed directly to coding once the plan is reviewed.

## Complexity Audit

### Routine
- Single-file change (`src/webview/kanban.html`).
- Reuses the existing `.card-btn.icon-btn` CSS class (line 1022) — no new styles.
- Class-based click handler binding (line 5600) is structure-agnostic — moving the button's parent div does not affect binding.
- No JS, no data model, no backend touch.
- No tests reference `send-to-backlog-btn`, `→ Backlog`, or `backlogActionBtn` (verified across `src/test/`).

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The button is rendered once per `createCardHtml` call and bound once on render; no async state mutation overlaps.
- **Security:** None. No user input, no templating injection surface beyond existing `escapeAttr` usage, which is preserved unchanged.
- **Side Effects:** Pure visual. The `sendToBacklog` message payload (sessionId, planId, workspaceRoot) is read from `data-*` attributes that are preserved verbatim.
- **Dependencies & Conflicts:** None. No other code branches reference `backlogActionBtn`'s DOM location. The BACKLOG-branch `send-to-new-btn` is untouched.

### Empty-string insertion safety
When the card is not in CREATED column (or board is in backlog view), `backlogActionBtn` is `''`. Inserting an empty string into the right group is harmless — the existing left-group already tolerated the same empty string. No conditional wrapper is needed.

### Completed cards
`backlogActionBtn` is gated on `!isCompleted`, so completed cards (which render the Recover button + Done badge) are unaffected.

### Build / serving (resolved)
The extension resolves `kanban.html` via a fallback chain in `KanbanProvider.ts:9325-9327`: `dist/webview/` → `webview/` → `src/webview/`. During development the `src/webview/kanban.html` file is served directly — no `npm run compile` is required to test this change. `dist/` is a release-only artifact (per project convention). Verification proceeds by reloading the webview.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: none material. The only theoretical concern — handler rebinding after DOM relocation — is invalidated by the class-based `querySelectorAll('.send-to-backlog-btn')` binding at line 5600, which is parent-agnostic. Mitigation: preserve the `send-to-backlog-btn` class and all `data-*` attributes verbatim.

## Proposed Changes

### src/webview/kanban.html

**Context:** The card action row is built in `createCardHtml` (line 5633). `backlogActionBtn` is defined at line 5681 and injected into the left action group at line 5713. The right action group (review + complete) is at lines 5715-5720.

**Logic:** Convert the CREATED-branch button to an icon button and move its `${backlogActionBtn}` injection from the left group into the right group, ordered backlog → review → complete.

**Implementation:**

#### 1. Render `backlogActionBtn` as an icon button (line 5681)

Replace the CREATED-branch text button:

```js
`<button class="card-btn send-to-backlog-btn" ... data-tooltip="Move to Backlog">→ Backlog</button>`
```

with an icon button using the same `.card-btn.icon-btn` class as review/complete:

```js
`<button class="card-btn icon-btn send-to-backlog-btn" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Move to Backlog">
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v9M4.5 8.5L8 12l3.5-3.5"/></svg>
 </button>`
```

- Keep all `data-*` attributes (the existing click handler at line 5600 binds on `.send-to-backlog-btn` and reads them).
- Keep the `send-to-backlog-btn` class so the existing handler continues to bind.
- Add `icon-btn` class to inherit the 20×20 sizing from line 1022.
- The BACKLOG-branch (`send-to-new-btn`) is left unchanged.

#### 2. Move it into the right action group (lines 5710-5720)

Currently:
```html
<div class="card-actions" style="display: flex; justify-content: space-between; align-items: center;">
    <div style="display: flex; gap: 4px; flex-wrap: wrap;">
        ${primaryActionBtn}
        ${backlogActionBtn}
    </div>
    <div style="display: flex; gap: 4px;">
        <button ...review icon...>
        ${completeOrDoneBtn}
    </div>
</div>
```

Change to:
```html
<div class="card-actions" style="display: flex; justify-content: space-between; align-items: center;">
    <div style="display: flex; gap: 4px; flex-wrap: wrap;">
        ${primaryActionBtn}
    </div>
    <div style="display: flex; gap: 4px;">
        ${backlogActionBtn}
        <button ...review icon...>
        ${completeOrDoneBtn}
    </div>
</div>
```

Order in the right group: **backlog → review → complete** (backlog leftmost since it's the lowest-priority "shelve" action; complete rightmost as the terminal action). This keeps the most common actions (review, complete) in their familiar rightmost positions.

**Edge Cases:** Covered in the Edge-Case & Dependency Audit above — empty-string insertion is harmless, completed cards are unaffected, handler binding is class-based and parent-agnostic.

## Verification Plan

### Automated Tests
None required. No tests reference the modified button, and the change is purely visual (class + DOM position). Per session directive, automated tests are skipped.

### Manual Verification
1. Open the Switchboard kanban board in VS Code (reload the webview so `src/webview/kanban.html` is re-served).
2. Locate a card in the NEW (CREATED) column.
3. Confirm: a small 20×20 down-arrow icon button appears in the right action group, to the left of the review (pencil) and complete (checkmark) icons.
4. Hover the icon — tooltip reads "Move to Backlog".
5. Click it — card moves to BACKLOG (existing behavior).
6. Switch to Backlog view: confirm BACKLOG cards still show the "→ New" **text** button (unchanged).
7. Confirm review and complete icon buttons are unchanged in size/position.
8. Confirm completed cards render the Recover button + Done badge with no backlog icon.

## Notes

- No CSS additions required — `.card-btn.icon-btn` already exists (line 1022) and is reused.
- No JS handler changes required — binding is class-based (`querySelectorAll('.send-to-backlog-btn')` at line 5600).
- Single-file change: `src/webview/kanban.html`.
- No build step required for verification — `src/webview/kanban.html` is served directly in dev via the KanbanProvider fallback chain.

## Recommendation

Complexity 2 → **Send to Intern**.

**Stage Complete:** INTERN CODED

## Review Findings
Reviewed `src/webview/kanban.html` changes against plan requirements. The CREATED-branch `backlogActionBtn` was converted from a text `card-btn` to a `card-btn icon-btn send-to-backlog-btn` with a down-arrow SVG (line 5709), preserving all `data-*` attributes and the `send-to-backlog-btn` class so the existing class-based handler at line 5627 binds unchanged. The `${backlogActionBtn}` injection was moved from the left action group to the right group (line 5744), ordered backlog → review → complete. The BACKLOG-branch `send-to-new-btn` was left as a text button (out of scope, verified unchanged). Empty-string insertion for non-CREATED/completed cards is harmless. No material findings — implementation matches the plan verbatim. No compilation/tests run per directive. No remaining risks specific to this plan.

**Stage Complete:** CODE REVIEWED
