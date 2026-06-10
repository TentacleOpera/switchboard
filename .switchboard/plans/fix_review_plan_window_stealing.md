# Fix: "Review Plan" Button Steals planning.html from Separate VS Code Windows

## Goal

1. Decouple "send activation message to planning panel" from "forcibly move planning panel into current window". If `planning.html` already exists anywhere, just message it. Only create/open a new panel if none exists.
2. Include `planFile` in the `reviewPlan` message so the fallback lookup works when `sessionId` is absent.
3. Update `findPendingKanbanMatch` to prioritize `planId` over the deprecated `sessionId`.

### Problem

When a user clicks the **"review plan"** button on a kanban card in `kanban.html`, and `planning.html` is already open in a **separate VS Code window** (e.g., moved to a second monitor via "Split Right" or "Move into New Window"), the existing `planning.html` panel is **forcibly moved back** into the current window. This closes the separate window if it was the last tab, which is jarring and destructive to the user's workspace layout.

### Root Cause

The `reviewPlan` message handler in `KanbanProvider` (src/services/KanbanProvider.ts:5467-5479) unconditionally calls `this._planningPanelProvider.reveal()` before posting the activation message:

```typescript
// src/services/KanbanProvider.ts
case 'reviewPlan': {
    const reviewSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
    if (reviewSessionId && this._planningPanelProvider) {
        this._planningPanelProvider.reveal(); // <-- Forces panel back to current window
        this._planningPanelProvider.postMessageToWebview({
            type: 'activateKanbanTabAndSelectPlan',
            ...
        });
    }
}
```

`PlanningPanelProvider.reveal()` (src/services/PlanningPanelProvider.ts:364-370) checks if `this._panel` exists and calls `_panel.reveal(vscode.ViewColumn.One)`. VS Code's `WebviewPanel.reveal()` API moves the panel into the **current window** if it lives elsewhere. The `_panel` reference is NOT cleared when the user moves the webview to another window via VS Code's native windowing commands, so the extension believes the panel is still "here" and tries to bring it back.

Meanwhile, `postMessageToWebview()` (src/services/PlanningPanelProvider.ts:372-374) works fine across windows — the `WebviewPanel` object remains valid and can receive messages regardless of which window it is in. The bug is that we **couple messaging with revealing**.

### Secondary Problem: Workspace Scoping Failure After Workspace Switch

When switching workspaces and then clicking "review plan", the panel opens the kanban tab but **cannot find the plan**. Two code-level causes:

1. **The review button omits `planFile`** — the `kanban.html` review button (src/webview/kanban.html:5024, click handler at :4835) only sends `sessionId`, `planId`, and `workspaceRoot`, but never includes `planFile`. Since `sessionId` is often empty (deprecated field), the `findPendingKanbanMatch` fallback to `planFile` is never reached because the message contains an empty string.

2. **`findPendingKanbanMatch` checks `sessionId` first** — `sessionId` is deprecated in favor of `planId`. The lookup (src/webview/planning.js:4442-4461) should prioritize `planId` as the primary key, with `sessionId` as a legacy fallback.

3. **(Clarification, discovered during review)** Even with the above fixed, the extension-side handler must explicitly forward `planId` in the `activateKanbanTabAndSelectPlan` message. `_resolveSessionId()` (src/services/KanbanProvider.ts:299-303) returns `sessionId` if present, else `planId`, and the result is sent in the `sessionId` field — so the webview's `planId`-primary lookup would otherwise always receive an empty `planId` and silently fall through to fallbacks.

## Metadata

- **Tags:** frontend, bugfix, ui, ux
- **Complexity:** 3

## User Review Required

- **Intentional UX behavior change:** After this fix, clicking "review" while `planning.html` lives in another window produces **no visible focus change in the current window** — the kanban tab activates silently in the other window. This is the desired non-stealing behavior, but the user must switch to that window themselves (no toast/notification is added; that would be net-new scope). Confirm this trade-off is acceptable.
- **Known limitation (pre-existing, documented below):** On the fresh-open path (panel did not exist), the activation message is posted immediately after `open()` resolves; there is no webview ready-handshake in this codebase, so in rare cases the message may arrive before the webview's message listener registers. Degradation is non-destructive (panel opens, plan not auto-selected). A ready-handshake protocol is noted as future work, out of scope here.

## Complexity Audit

### Routine
- Adding `data-plan-file` attribute to an existing button template and passing it through an existing message (kanban.html) — copies the established `data-*` pattern used by every other card button.
- Adding a one-line `hasPanel(): boolean` getter to `PlanningPanelProvider` — trivial accessor.
- Reordering identifier-priority checks in `findPendingKanbanMatch` — pure local logic, same function shape.
- Adding `planId`/`planFile` fields to an existing message payload — established pattern.

### Complex / Risky
- Conditional open-vs-message flow in the `reviewPlan` handler changes cross-window behavior; correctness depends on VS Code's `WebviewPanel` lifecycle (`_panel` validity across native window moves).
- Fresh-open path posts the activation message without a ready-handshake (pre-existing race, strictly improved by `await open()`, but not fully eliminated).

## Edge-Case & Dependency Audit

### Race Conditions
- **Panel disposed between `hasPanel()` and `postMessageToWebview()`:** safe no-op — `postMessageToWebview` uses optional chaining (`this._panel?.webview.postMessage(...)`, PlanningPanelProvider.ts:372-374), and `onDidDispose` clears `_panel` (PlanningPanelProvider.ts:4876).
- **Double-click on review button:** second handler invocation sees `this._panel` already set — `open()` assigns `_panel` synchronously (createWebviewPanel at PlanningPanelProvider.ts:274) before its first `await`, so the second call takes the `reveal` early-return path. No duplicate panels.
- **Fresh-open message delivery:** `open()` awaits sync-config resolution before returning, giving the webview time to load, but delivery before the listener at planning.js:3496 registers is not guaranteed. Non-destructive degradation; documented in User Review Required.
- **Pending selection cleared on tab switch:** planning.js:394-396 clears `_pendingKanbanSelection` when the user manually switches away from the kanban tab — intended behavior, prevents stale auto-selects.

### Security
- No new input surfaces. `planFile` is escaped via the existing `escapeAttr()` helper in the button template and travels only through `postMessage` payloads; no new filesystem access is introduced by this change.

### Side Effects
- `reveal()` and `open()` semantics unchanged — all other callers (e.g., "Open Planning Panel" command) keep their reveal behavior.
- `open()` resets local-docs/webview-roots dedup caches; this now only runs when no panel exists (fresh creation), which is exactly when those resets are required.
- Behavior change: review no longer steals/reveals an existing panel (see User Review Required).

### Dependencies & Conflicts
- Both `kanban.html` cards (via `KanbanProvider`) and the planning-panel cache (`PlanningPanelProvider._getKanbanPlans`, src/services/PlanningPanelProvider.ts:4884-4913) map `planFile` raw from the same `KanbanDatabase` field — the `p.planFile === planFile` comparison is apples-to-apples.
- `fetchKanbanPlans` dedups plans by `planId` across workspace roots (PlanningPanelProvider.ts:1626-1631), so `planId` is a valid cross-workspace primary key for the cache lookup.
- No new package dependencies.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the plan's original message payload omitted `planId`, which would have made the new primary lookup dead code — corrected by forwarding `planId` explicitly in the `reviewPlan` handler; (2) fresh-open activation message may race the webview listener (pre-existing, non-destructive, strictly improved by awaiting `open()`); (3) silent no-focus behavior when the panel lives in another window is an intentional UX change surfaced for user review. Mitigations: explicit `planId` passthrough, `await open()` on the create path, optional-chained message posting, and layered lookup fallbacks (`planId` → `sessionId` → `planFile` → compound).

## Proposed Changes

### 1. `src/webview/kanban.html`

Add `data-plan-file` to the review button and include it in the message:

```javascript
// Line ~5024: Add data-plan-file to the review button template
<button class="card-btn icon-btn review"
    data-plan-id="${cardId}"
    data-session="${escapeAttr(card.sessionId || '')}"
    data-plan-file="${escapeAttr(card.planFile || '')}"
    data-workspace-root="${escapeAttr(card.workspaceRoot)}"
    data-tooltip="Review plan">
    ...
</button>

// Line ~4835: Include planFile in the reviewPlan message
postKanbanMessage({
    type: 'reviewPlan',
    sessionId: btn.dataset.session || '',
    planId: btn.dataset.planId || '',
    planFile: btn.dataset.planFile || '',
    workspaceRoot: btn.dataset.workspaceRoot
});
```

- **Context:** `cardId` is `escapeAttr(card.planId || card.sessionId || '')` (kanban.html:5012); cards already carry `planFile` (used in the board signature at kanban.html:4149).
- **Edge Cases:** Empty `planFile` renders as `data-plan-file=""` and posts `''` — handled by falsy guards downstream.

### 2. `src/services/PlanningPanelProvider.ts`

Add a lightweight existence check so callers can decide whether to open or just message (place adjacent to `reveal()` at line ~364):

```typescript
public hasPanel(): boolean {
    return !!this._panel;
}
```

*(No change to `reveal()` or `open()` semantics — those methods are used elsewhere where actual reveal behavior is desired.)*

- **Context:** `_panel` is set synchronously in `open()` (line 274) and cleared in `dispose()` (line 4876 via `onDidDispose`), so `hasPanel()` accurately reflects panel existence even across native window moves (the `WebviewPanel` object stays valid).

### 3. `src/services/KanbanProvider.ts`

In the `reviewPlan` message handler (lines 5467-5479), replace the unconditional `reveal()` with a conditional open-then-message flow, and pass `planId` and `planFile` through:

```typescript
case 'reviewPlan': {
    const reviewId = this._resolveSessionId(msg.planId, msg.sessionId);
    if (reviewId && this._planningPanelProvider) {
        // Only open a new panel if none exists. If it exists in another window,
        // just message it — do NOT forcibly reveal (which steals it back).
        if (!this._planningPanelProvider.hasPanel()) {
            await this._planningPanelProvider.open();
        }
        this._planningPanelProvider.postMessageToWebview({
            type: 'activateKanbanTabAndSelectPlan',
            planId: msg.planId || '',
            sessionId: reviewId,
            planFile: msg.planFile || '',
            workspaceRoot: msg.workspaceRoot || ''
        });
    }
    break;
}
```

- **Context:** the surrounding `_handleMessage` dispatcher is already `async` (other cases use `await`), so `await this._planningPanelProvider.open()` is valid.
- **Logic (Clarification):** `planId: msg.planId || ''` is REQUIRED — without it, the webview's new `planId`-primary lookup receives an empty string and the primary path never executes. `_resolveSessionId()` returns `sessionId` if present (else `planId`) and that value goes in the `sessionId` field, so it cannot substitute for an explicit `planId`.
- **Edge Cases:** If both `planId` and `sessionId` are empty, `reviewId` is `undefined` and the handler no-ops (unchanged from current behavior).

### 4. `src/webview/planning.js`

Update `findPendingKanbanMatch` (lines 4442-4461) to prioritize `planId` (the current primary key) and treat `sessionId` as a legacy fallback. Also add `planId` to the pending selection payload:

```javascript
function findPendingKanbanMatch(cache) {
    if (!_pendingKanbanSelection || !cache || !cache.length) return null;
    const { planId, sessionId, planFile, workspaceRoot } = _pendingKanbanSelection;

    // Primary: planId (current canonical identifier)
    if (planId) {
        const byPlanId = cache.find(p => p.planId === planId);
        if (byPlanId) return byPlanId;
    }

    // Legacy fallback: sessionId (deprecated but still present on older plans)
    if (sessionId) {
        const bySession = cache.find(p => p.sessionId === sessionId);
        if (bySession) return bySession;
    }

    // Fallback: planFile
    if (planFile) {
        const byFile = cache.find(p => p.planFile === planFile);
        if (byFile) return byFile;
    }

    // Last resort: workspaceRoot + sessionId compound
    if (workspaceRoot && sessionId) {
        const byCompound = cache.find(p => p.workspaceRoot === workspaceRoot && p.sessionId === sessionId);
        if (byCompound) return byCompound;
    }

    return null;
}
```

Update the `activateKanbanTabAndSelectPlan` handler (lines 3597-3613) to include `planId` in `_pendingKanbanSelection`:

```javascript
case 'activateKanbanTabAndSelectPlan': {
    _pendingKanbanSelection = {
        planId: msg.planId || '',
        sessionId: msg.sessionId || '',
        planFile: msg.planFile || '',
        workspaceRoot: msg.workspaceRoot || ''
    };
    switchToTab('kanban');
    // ... rest of handler (preserve the existing immediate-match block that
    // queries `.kanban-plan-item[data-plan-id="${immediateMatch.planId}"]`,
    // clicks it, and clears _pendingKanbanSelection on success)
}
```

- **Context:** unresolved pending selections are retried in `handleKanbanPlansReady` (planning.js:5132-5142) on each plans fetch, and cleared only on successful match — the layered lookup composes with that retry loop.
- **Edge Cases:** `cardId` on the kanban side is `card.planId || card.sessionId`, so for legacy cards `msg.planId` may actually carry a sessionId value; the `planId` lookup misses harmlessly and the `sessionId`/`planFile` fallbacks recover.

## Edge Cases & Risks

- **Panel was closed/disposed by the user:** `hasPanel()` returns `false`, `open()` creates a fresh panel — correct behavior.
- **Panel exists in current window:** `hasPanel()` returns `true`, message is posted, panel stays put — correct behavior.
- **Panel exists in another window:** `hasPanel()` returns `true`, message is posted remotely, panel stays in the other window — correct behavior. User can alt-tab to it.
- **Other callers of `reveal()`/`open()`:** Unchanged. Commands like "Open Planning Panel" from the command palette still reveal the panel as expected.
- **Race condition:** If the panel is disposed between `hasPanel()` and `postMessageToWebview()`, `postMessageToWebview()` safely no-ops because it uses optional chaining (`this._panel?.webview.postMessage(...)`).
- **Legacy plans with only sessionId:** The `planId` check runs first but returns `null` when `planId` is empty, so the `sessionId` fallback still works for older plans.
- **Empty planId in message:** If the kanban card somehow lacks a `planId`, all lookups will miss and the kanban tab simply won't auto-select a plan — non-destructive.
- **Fresh-open delivery race:** On the create path the activation message may, in rare cases, arrive before the webview listener registers (no ready-handshake exists). Panel still opens; plan is not auto-selected. Pre-existing limitation, strictly improved by `await open()`.

## Files Changed

- `src/webview/kanban.html`
- `src/services/PlanningPanelProvider.ts`
- `src/services/KanbanProvider.ts`
- `src/webview/planning.js`

## Verification Plan

### Automated Tests

*(To be run separately by the user — not executed in this planning session.)*

- Add a regression test (e.g., `src/test/review-plan-window-stealing.test.js`, following the existing `*-regression.test.js` pattern) covering:
  1. `findPendingKanbanMatch` priority order: given a cache containing a plan with matching `planId`, a different plan with matching `sessionId`, and a third with matching `planFile`, the `planId` match wins; with `planId` empty, `sessionId` wins; with both empty, `planFile` wins; compound `workspaceRoot + sessionId` as last resort; no match returns `null`.
  2. `reviewPlan` handler: with a stubbed `PlanningPanelProvider` where `hasPanel()` returns `true`, assert `open()`/`reveal()` are NOT called and `postMessageToWebview` receives a payload containing `planId`, `sessionId`, `planFile`, and `workspaceRoot`; with `hasPanel()` returning `false`, assert `open()` IS awaited before the message is posted.
  3. `kanban.html` review message shape: the posted `reviewPlan` message includes a `planFile` field sourced from `data-plan-file`.

### Manual Validation

#### Window Stealing Fix
1. Open `kanban.html` in Window A.
2. Open `planning.html` in Window A, then use VS Code's "Move into New Window" to move it to Window B.
3. In Window A, click the "review" pencil icon on any kanban card.
4. **Expected:** `planning.html` stays in Window B. The kanban tab is activated inside `planning.html` (visible when switching to Window B). No window is closed.
5. **Before fix:** `planning.html` disappears from Window B and reopens in Window A, closing Window B.

#### Workspace Scoping Fix
1. Switch to a different workspace in `kanban.html`.
2. Click "review" on a plan that has no `sessionId` (empty string).
3. **Expected:** `planning.html` kanban tab opens and the correct plan is selected and previewed.
4. **Before fix:** The kanban tab opens but shows "Select a plan to preview" — the plan is not found because `planFile` was missing from the message and `sessionId` was empty.

#### Fresh-Open Path
1. Close `planning.html` entirely.
2. Click "review" on a kanban card.
3. **Expected:** `planning.html` opens in the current window, kanban tab active, plan selected (or, in the rare race case, plan not auto-selected but panel functional — re-clicking review recovers).

---

**Recommendation: Send to Intern**

## Review Findings

**Reviewer:** Direct reviewer pass (in-place). **Status:** Approved — no material issues found.

- **Files changed:** `src/webview/kanban.html`, `src/services/PlanningPanelProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/planning.js` — all four files contain the exact changes specified in the plan.
- **Validation:** Skipped per session directive (compilation and tests run separately by user). Visual inspection confirms no syntax errors, type mismatches, or logic regressions.
- **Grumpy Stage 1:** Zero CRITICAL/MAJOR findings. Two NITs surfaced: (a) `await open()` serializes potentially slow sync I/O on the fresh-create path (net improvement over prior fire-and-forget, but worth monitoring), and (b) legacy plans with empty `planId` may query `data-plan-id=""` in the kanban tab DOM — pre-existing, out of scope.
- **Balanced Stage 2:** All plan requirements implemented correctly. Conditional `hasPanel()` → `open()` / `postMessage` flow decouples messaging from revealing. `planId`-first lookup in `findPendingKanbanMatch` is correctly wired with explicit `planId` passthrough in the extension handler. `planFile` inclusion in the review message fixes the workspace-scoping fallback.
- **Remaining risks:** Fresh-open message-delivery race (pre-existing, documented, non-destructive); silent no-focus UX when panel lives in another window (intentional, documented).
