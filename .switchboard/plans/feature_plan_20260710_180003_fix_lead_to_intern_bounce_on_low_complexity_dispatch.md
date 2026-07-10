# Fix Lead Coder → Intern Bounce on Low-Complexity Dispatch

## Goal

When the user clicks "Copy coder prompt" (the advance button) on a low-complexity plan in the PLAN REVIEWED column with coder columns expanded, the card visibly bounces: it first appears in the Lead Coder column, then jumps to the Intern column. The card should go directly to the correct complexity-routed column without the intermediate Lead Coder hop.

### Problem Analysis & Root Cause

**Flow when clicking "Copy coder prompt" on a PLAN REVIEWED card:**

1. **Frontend (optimistic UI):** The click handler (kanban.html:5840) calls `getNextColumn('PLAN REVIEWED')` which returns `'LEAD CODED'` — the literal next column in the `columns` array: `['CREATED', 'PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'INTERN CODED', ...]`.
2. The handler calls `moveCardsOptimistically([sessionId], 'PLAN REVIEWED', 'LEAD CODED')` — the card is immediately moved to the LEAD CODED DOM container.
3. The handler sends `postKanbanMessage({ type: 'promptSelected', column: 'PLAN REVIEWED', sessionIds: [sessionId], workspaceRoot })`.
4. **Backend (complexity routing):** The `promptSelected` handler (KanbanProvider.ts:8329) sees `column === 'PLAN REVIEWED'`, calls `_partitionByComplexityRoute()` which resolves the plan's complexity score to a role (e.g., score 1 → `intern`), and calls `moveCardToColumn(workspaceRoot, sid, 'INTERN CODED')`.
5. The backend sends `postMessage({ type: 'moveCards', sessionIds: [...], targetColumn: 'INTERN CODED' })`.
6. **Visible bounce:** The card was in LEAD CODED (step 2), then the `moveCards` delta moves it to INTERN CODED (step 5). The user sees the card jump from LEAD CODED to INTERN CODED.

**Why it doesn't happen when collapsed:** When `collapseCodersEnabled` is true, all three coder columns (LEAD CODED, CODER CODED, INTERN CODED) share the synthetic `CODED_AUTO` DOM container. The optimistic move puts the card in CODED_AUTO, and the backend routing also resolves to CODED_AUTO — same container, no visible bounce.

**Why it doesn't happen for drag-and-drop onto CODED_AUTO:** The drag handler (kanban.html:6274) uses `resolveCodedAutoTarget(card)` (line 6256) which reads the card's complexity score and routes to the correct column via `routingMapConfig`. The advance button path doesn't use this function.

### Background Context

The `resolveCodedAutoTarget` function (kanban.html:6256) already implements client-side complexity routing for drag-and-drop:
```javascript
function resolveCodedAutoTarget(card) {
    if (!dynamicComplexityRoutingEnabled) return 'LEAD CODED';
    const score = parseInt(card?.complexity, 10);
    if (isNaN(score)) return 'CODER CODED';
    const roleMap = { lead: 'LEAD CODED', coder: 'CODER CODED', intern: 'INTERN CODED' };
    for (const [role, scores] of Object.entries(routingMapConfig)) {
        if (Array.isArray(scores) && scores.includes(score)) {
            const resolved = roleMap[role] || 'CODER CODED';
            if (resolved === 'INTERN CODED' && !columnDefinitions.some(d => d.id === 'INTERN CODED')) {
                return 'CODER CODED';
            }
            return resolved;
        }
    }
    return 'CODER CODED';
}
```

This same logic was the basis of the original proposed fix for the advance button.

> **Superseded:** Reuse `resolveCodedAutoTarget(card)` verbatim for the optimistic move whenever the source column is PLAN REVIEWED and dynamic routing is enabled.
> **Reason:** Reusing `resolveCodedAutoTarget` makes the *frontend* predict the *backend's* routing decision, and the two do **not** agree in three cases verified against the code:
> 1. **Unknown complexity.** `resolveCodedAutoTarget` returns `'CODER CODED'` for `isNaN(score)` (kanban.html:6259), but the backend's `_resolveComplexityRoutedRole` → `parseComplexityScore('Unknown') = 0` → `resolveRoutedRole(0) = 'lead'` (complexityScale.ts:64) → **LEAD CODED**. Worse, `_allowUnknownComplexityAutoMove` defaults to **true** (KanbanProvider.ts:405), so the backend *does* auto-advance unknown-complexity plans to LEAD CODED — it does **not** leave them in PLAN REVIEWED as the original edge-case analysis assumed. Predicting CODER CODED on the frontend therefore produces a fresh CODER→LEAD bounce.
> 2. **Pair-programming mode.** `resolveRoutedRole` applies a pair-mode bypass that rewrites `intern → coder` (KanbanProvider.ts:1108-1112). `resolveCodedAutoTarget` has no such bypass, so a low-complexity plan in pair mode is predicted INTERN CODED but routed to CODER CODED → bounce.
> 3. **Score-4 boundary (config-drift only).** The frontend's default `routingMapConfig` is `{ lead:[7,8,9,10], coder:[4,5,6], intern:[1,2,3] }` (kanban.html:4165) while the backend's built-in `scoreToRoutingRole` maps 1–4→intern, 5–6→coder, 7–10→lead (complexityScale.ts:61-65). These agree **only** while the backend has pushed its live `_routingMapConfig` to the webview (via the `routingConfig` message, kanban.html:6817). If that sync ever lags, score 4 diverges.
> **Replaced with:** A **confidence-gated hybrid** — only perform the optimistic complexity-routed move when the frontend can be confident it matches the backend; otherwise suppress the optimistic cross-stage move and let the backend's authoritative `moveCards` delta place the card (one move, no bounce). See Proposed Changes §1.

## Metadata
**Tags:** bugfix, frontend, ui
**Complexity:** 5
**Project:** switchboard

## User Review Required

This improve pass **superseded the original approach**. The original plan reused `resolveCodedAutoTarget` directly; this revision gates that reuse and adds a suppression fallback because the frontend and backend routing diverge on unknown-complexity, pair-mode, and (under config drift) score-4 plans. Please confirm you accept the hybrid approach in Proposed Changes §1 before implementation. If you prefer the absolute-simplest fix (suppress the optimistic move entirely for PLAN REVIEWED and always let the backend drive), that alternative is documented in the Adversarial Synthesis and is a one-line change.

## Complexity Audit

### Routine
- Single-file frontend change (`src/webview/kanban.html`), no backend edits.
- Reuses an existing helper (`resolveCodedAutoTarget`) and existing state (`dynamicComplexityRoutingEnabled`, `routingMapConfig`, pair-mode select).
- The backend routing is already correct — this is purely aligning the optimistic UI.

### Complex / Risky
- The fix must exactly mirror three backend routing behaviors (unknown→lead, pair-mode bypass, config-synced map) or it re-introduces a bounce in a different case. This is a frontend/backend consistency contract, not a localized tweak — the reason complexity is scored 5, not the original 4.
- Two additional call sites (column-header "prompt all" / "move all") share the same defect and must be fixed consistently or the bug persists at the batch level.

## Edge-Case & Dependency Audit

- **Race Conditions:** The optimistic move and the backend `moveCards` delta are two async events. If the optimistic move predicts the wrong column, the delta corrects it — that correction *is* the visible bounce. The fix removes the wrong prediction rather than trying to win the race.
- **Security:** None. No new data flows, no user-input parsing, no privilege surface.
- **Side Effects:** Suppressing the optimistic move for the uncertain cases means the card lingers in PLAN REVIEWED for the backend round-trip (~100–300ms) before moving once. This is a deliberate, benign latency trade for correctness.
- **Dependencies & Conflicts:** Depends on the backend continuing to push `routingConfig` and `dynamicComplexityRoutingEnabled` to the webview on init and on change (kanban.html:6817, 7050). Depends on the pair-programming mode being readable in the webview (the `pairProgrammingModeSelect` element already exists, kanban.html:2648/7759). If the backend ever changes its routing logic, the frontend prediction must be updated in lockstep OR the suppression fallback must widen — this is the standing maintenance hazard.

## Dependencies

- None. This plan is self-contained within `src/webview/kanban.html`.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the frontend can only *predict* the backend's routing, and the two diverge on unknown-complexity, pair-mode, and (under config drift) score-4 plans; (2) three separate call sites carry the same defect. Mitigations: gate the optimistic move on frontend confidence (known score + pair-mode off) and suppress it otherwise so the backend `moveCards` delta is the single source of truth; apply the identical gate to the column-header batch handlers. The simplest safe fallback — suppress the optimistic cross-stage move for all PLAN REVIEWED advances and always let the backend drive — trades ~100–300ms of feedback latency for guaranteed bounce-freedom and zero prediction-maintenance burden.

## Proposed Changes

### `src/webview/kanban.html` — card "copy coder prompt" click handler (line ~5840–5868)

**Context:** The `.card-btn.copy` click handler computes `nextCol = getNextColumn(nextColSource)` (line 5858) and then calls `moveCardsOptimistically([sessionId], column, nextCol)` (line 5867). For a PLAN REVIEWED source, `getNextColumn` returns the literal next column `LEAD CODED`, which is wrong for anything that complexity-routes elsewhere.

**Logic:** When the source column is PLAN REVIEWED and dynamic routing is on, decide the optimistic target by *confidence*:
- **Confident** (complexity is a known score 1–10 **and** pair-programming mode is off): route via `resolveCodedAutoTarget(card)` so the optimistic move matches the backend.
- **Not confident** (unknown/`NaN` complexity, or pair mode active): do **not** move optimistically. Skip `moveCardsOptimistically` (and the destination highlight) for this card and let the backend's `moveCards` delta place it. This eliminates the divergence classes rather than trying to reproduce them.

**Implementation** (insert after line 5858 `nextCol = getNextColumn(nextColSource);`, before the `if (nextCol)` block at line 5860):
```javascript
// PLAN REVIEWED advances are routed by the BACKEND (_partitionByComplexityRoute).
// The optimistic move must either predict that exactly or not move at all —
// otherwise the backend's moveCards delta bounces the card to the real column.
if (column === 'PLAN REVIEWED' && dynamicComplexityRoutingEnabled) {
    const card = currentCards.find(c => (c.planId || c.sessionId) === sessionId);
    const score = parseInt(card?.complexity, 10);
    const pairModeActive =
        (document.getElementById('pairProgrammingModeSelect')?.value || 'off') !== 'off';
    if (isNaN(score) || pairModeActive) {
        // Not confident the FE prediction matches the BE. Suppress the optimistic
        // cross-stage move; the backend moveCards delta is authoritative.
        nextCol = null;
    } else {
        // Confident: mirror the backend's complexity route so there is one clean move.
        const routedTarget = resolveCodedAutoTarget(card);
        if (routedTarget) nextCol = routedTarget;
    }
}
```
(The existing `postKanbanMessage({ type: 'promptSelected', ... })` at line 5871 is unchanged and always fires — the prompt is still copied and the backend still advances the card even when the optimistic move is suppressed.)

**Edge Cases:**
- Unknown complexity: `nextCol = null` → no optimistic move, no highlight; backend advances to LEAD CODED (default) via its own delta. One clean move.
- Pair mode: same suppression path; backend's intern→coder bypass lands the card in CODER CODED via the delta.
- Routing disabled: the outer `if (dynamicComplexityRoutingEnabled)` is false, so behavior is unchanged (goes to LEAD CODED, matching the backend's routing-disabled default which also returns `'lead'`, KanbanProvider.ts:6300-6302).
- INTERN CODED hidden: already handled inside `resolveCodedAutoTarget` (line 6265) — falls back to CODER CODED, matching the backend's `_targetColumnForDispatchRole` fallback.

### `src/webview/kanban.html` — column-header `promptSelected` / `promptAll` / `moveSelected` / `moveAll` handlers (lines ~5196–5273)

**Context:** The column icon-button handler computes a single `nextCol = getNextColumn(nextColSource)` (line 5193) and calls `moveCardsOptimistically(ids, column, nextCol)` for a *batch* of cards. For PLAN REVIEWED, every card is optimistically moved to the same LEAD CODED column, so mixed-complexity batches bounce per-card. The backend already routes each card individually (`_partitionByComplexityRoute`, KanbanProvider.ts:8391/8479).

**Logic:** For PLAN REVIEWED batch advances (`promptSelected`, `promptAll`, and the two `moveSelected`/`moveAll` variants that advance forward), apply the same per-card confidence gate. Because a batch spans multiple target columns, the clean approach is to **suppress the batch optimistic move for PLAN REVIEWED entirely** and let the backend's per-card `moveCards` deltas place each card. (A per-card optimistic split is possible but adds complexity for no UX gain over the ~100–300ms backend round-trip.)

**Implementation:** In each of the four `case` blocks, guard the `moveCardsOptimistically(...)` call:
```javascript
// PLAN REVIEWED batches are complexity-routed per-card by the backend; a single
// optimistic target would bounce mixed-complexity batches. Let the backend deltas drive.
if (column !== 'PLAN REVIEWED') {
    moveCardsOptimistically(ids, column, nextCol);
}
```
Keep the destination-highlight only when the move is actually performed (wrap it in the same guard).

**Edge Cases:**
- Non-PLAN-REVIEWED columns: unchanged — the optimistic move still fires (no complexity routing on those transitions).
- CODED_AUTO batches: unchanged — those are not PLAN REVIEWED and already resolve to a single container.

### Guard against INTERN CODED being hidden

No additional guard needed — `resolveCodedAutoTarget` already returns CODER CODED when INTERN CODED is absent (kanban.html:6265), and the confidence gate only calls it in the confident path.

## Verification Plan

> Session directive: automated tests and compilation are **not** run as part of this planning pass. The steps below are for the implementer to execute after coding.

### Automated Tests
- No existing unit test covers the optimistic-move column resolution for the advance button (it is DOM-coupled webview code). If a jest/DOM harness is added, assert that for `column === 'PLAN REVIEWED'`: (a) a card with score 1 and pair-mode off resolves the optimistic target to INTERN CODED; (b) a card with `complexity === 'Unknown'` performs no optimistic move; (c) pair-mode on performs no optimistic move.

### Manual Verification
1. Coder columns **expanded**, dynamic routing **enabled**, pair mode **off**:
   - Score-1 plan in PLAN REVIEWED → "Copy coder prompt" → card goes **directly** to INTERN CODED, no LEAD CODED hop.
   - Score-5 plan → directly to CODER CODED.
   - Score-9 plan → directly to LEAD CODED.
2. Coder columns **collapsed** (CODED_AUTO): repeat — no bounce (single container).
3. Dynamic routing **disabled**: advance a PLAN REVIEWED card → goes to LEAD CODED (matches backend default).
4. **Unknown-complexity** plan: advance → card does not move optimistically, then lands in LEAD CODED via the backend delta (one clean move, no bounce).
5. **Pair mode active**: advance a score-1 plan → no optimistic move, lands in CODER CODED via the backend delta.
6. Column-header "Copy prompt and advance all" on PLAN REVIEWED with a **mixed-complexity** batch → each card lands in its correct column with no per-card bounce.

## Recommendation

**Send to Coder** (complexity 5). The change is single-file frontend work but carries a frontend/backend routing-consistency contract and touches four call sites, which is beyond intern-tier "reuse an existing pattern" scope.
