# Add more controls to autoban config

## Notebook Plan

We need controls to only do low complexity plans, and where they go. E.g. low complexity only, high complexity only, low + high, whether all go to lead coder, or whether dynamic routing is enabled

## Goal
Add a **complexity filter** and a **routing mode** to the existing Autoban config panel, giving users control over which plans the Autoban engine processes and where they are sent.

## Source Code Verification (2026-03-15)

### Current Autoban State — `src/services/TaskViewerProvider.ts:102-114`
```typescript
private _autobanState: {
    enabled: boolean;
    batchSize: number;
    rules: Record<string, { enabled: boolean; intervalMinutes: number }>;
} = {
    enabled: false,
    batchSize: 3,
    rules: {
        'CREATED': { enabled: true, intervalMinutes: 10 },
        'PLAN REVIEWED': { enabled: true, intervalMinutes: 20 },
        'CODED': { enabled: true, intervalMinutes: 15 }
    }
};
```

### Current Complexity Routing — `src/services/TaskViewerProvider.ts:900-936`
The `_autobanTickColumn` method already has dynamic complexity routing for the `PLAN REVIEWED` column: Low → coder, High/Unknown → lead. This is hardcoded with no user control.

### Current UI — `src/webview/implementation.html:2927-3088` (`createAutobanPanel()`)
Has: master toggle, batch size selector, per-column enable/interval. Missing: complexity filter, routing mode.

### Persisted state — `src/services/TaskViewerProvider.ts:175-178`
State is persisted via `this._context.workspaceState.get/update('autoban.state')`.

## Proposed Changes

### Step 1 — Extend the autoban state type (Routine)
- **File:** `src/services/TaskViewerProvider.ts`
- **Lines 102-105:** Add two new fields to the `_autobanState` type:
  ```typescript
  private _autobanState: {
      enabled: boolean;
      batchSize: number;
      complexityFilter: 'all' | 'low_only' | 'high_only';
      routingMode: 'dynamic' | 'all_coder' | 'all_lead';
      rules: Record<string, { enabled: boolean; intervalMinutes: number }>;
  } = {
      enabled: false,
      batchSize: 3,
      complexityFilter: 'all',
      routingMode: 'dynamic',
      rules: { ... }
  };
  ```
- **Defaults:** `complexityFilter: 'all'` and `routingMode: 'dynamic'` preserve current behavior — no breaking change.

### Step 2 — Update `_autobanTickColumn` routing logic (Complex)
- **File:** `src/services/TaskViewerProvider.ts`
- **Method:** `_autobanTickColumn` (line 863)
- **Inside the `sourceColumn === 'PLAN REVIEWED'` block (lines 900-936):**
  1. After determining each card's complexity, apply the `complexityFilter`:
     - `'low_only'` → skip cards where complexity !== 'Low'
     - `'high_only'` → skip cards where complexity !== 'High' and complexity !== 'Unknown'
     - `'all'` → no filtering (current behavior)
  2. Apply the `routingMode`:
     - `'dynamic'` → Low → coder, High/Unknown → lead (current behavior)
     - `'all_coder'` → all cards → coder regardless of complexity
     - `'all_lead'` → all cards → lead regardless of complexity
  3. **Unknown complexity policy:** Treat as High in all modes. In `'low_only'` mode, Unknown plans are skipped.
- **Exact insertion point:** Replace the hardcoded routing at lines 910-921 with the new logic.

### Step 3 — Add UI controls to Autoban panel (Routine)
- **File:** `src/webview/implementation.html`
- **Function:** `createAutobanPanel()` (line 2927)
- **Insert after the batch size row (line 2987) and before the separator (line 2990):**
  1. Add a **Complexity Filter** dropdown:
     ```
     COMPLEXITY: [All ▾]  (options: All, Low Only, High Only)
     ```
  2. Add a **Routing Mode** dropdown:
     ```
     ROUTING:    [Dynamic ▾]  (options: Dynamic, All → Coder, All → Lead)
     ```
  3. Both dropdowns read from and write to `autobanState.complexityFilter` / `autobanState.routingMode`, calling `emitAutobanState()` on change.
- **Style:** Match existing `batchSelect` styling (monospace, dark background, border).

### Step 4 — Sync state shape in frontend (Routine)
- **File:** `src/webview/implementation.html`
- **Line ~1941:** Update the `autobanState` default object to include the new fields:
  ```javascript
  let autobanState = {
      enabled: false,
      batchSize: 3,
      complexityFilter: 'all',
      routingMode: 'dynamic',
      rules: { ... }
  };
  ```

### Step 5 — Compile (Routine)
- Run `npm run compile` to regenerate `TaskViewerProvider.js`.

## Verification Plan
1. Open Autoban tab → verify new dropdowns appear below batch size.
2. Set `complexityFilter: 'low_only'`, enable Autoban → verify only Low complexity plans are dispatched from PLAN REVIEWED. High/Unknown plans remain untouched.
3. Set `complexityFilter: 'high_only'` → verify only High/Unknown plans are dispatched.
4. Set `routingMode: 'all_coder'` → verify all plans go to coder agent, none to lead.
5. Set `routingMode: 'all_lead'` → verify all plans go to lead agent.
6. Set `routingMode: 'dynamic'` → verify Low → coder, High → lead (original behavior).
7. Disable and re-enable the extension → verify persisted state restores correctly.
8. Verify CREATED and CODED columns are unaffected by the new controls (they don't have complexity routing).

## Open Questions
- **Resolved:** Unknown complexity is treated as High. In `low_only` mode, Unknown plans are skipped.
- **Resolved:** Controls live in the existing Autoban panel, not the Kanban view.

---

## Internal Adversarial Review

### Grumpy-Style Critique
"Five routing modes? Three complexity filters? You're building a switchboard for the Switchboard. Most users just want 'run all my plans'. The 80% use case is 'dynamic' + 'all', and you're making everyone wade through dropdowns for the 5% who want fine-grained control. Also, `TaskViewerProvider.ts` is already 6777 lines — you want to stuff MORE routing logic in there?"

### Balanced Synthesis
- **Valid concern (monolith):** The routing logic in `_autobanTickColumn` is already 40 lines. Adding filter/mode branches will push it to ~60 lines. This is acceptable for now but a future refactor into `AutobanRouter` utility is recommended if more controls are added later.
- **Valid concern (UI clutter):** Mitigated by using two simple dropdowns that default to the current behavior (`all` + `dynamic`). Users who never touch them get identical behavior to today.
- **Rejected concern (over-engineering):** The user explicitly requested these controls. Two dropdowns with 3 options each is not over-engineering.

**Recommendation:** This plan has high complexity. Send it to the **Lead Coder**.