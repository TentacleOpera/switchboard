# Grumpy Critique: Autoban Read Receipts + Tiered Interval Warnings

---

## CRITICAL

### C1 — You Removed the Guard But Kept the Race Condition

The whole justification for removing read receipts is "the timer is the signal now." Fine. But nothing in this plan addresses the **double-dispatch race** that was identified in the original risk analysis. The Autoban engine ticks on a `setInterval`. The tick reads cards from runsheets. The runsheet for a just-dispatched card is updated **before** dispatch (lines 610–615 in `handleKanbanBatchTrigger`). 

But the column is derived from `_deriveColumnFromEvents`, which reads `workflow` fields on events. A card dispatched to the coder gets a `handoff` event written — that's what moves it to `CODED`. If the tick fires again before that write completes (or before the file-system watcher propagates the change), the same card can be picked up **twice in the same tick window**. The read receipt was actually partially protecting against this by adding a delay signal. Removing it without adding dispatch-state deduplication (`_dispatchedThisTick = new Set<sessionId>`) is regressive.

**Show the receipt:** `_autobanTickColumn` (line 817) calls `getRunSheets()` which reads from disk. There is no in-memory "already dispatched this cycle" guard. The plan doesn't mention this at all.

---

### C2 — `AUTOBAN_FLOOR_MINUTES` Is a Dead Constant on the Backend

The plan says: *"The backend does NOT clamp to the floor. `AUTOBAN_FLOOR_MINUTES` drives UI warning tiers only."* So why is it a `private static readonly` on `TaskViewerProvider.ts`?

If it's UI-only, it belongs in `implementation.html` as a plain JS object. Putting it on the backend class creates a misleading API surface where someone (a future developer, or a delegate agent) sees `AUTOBAN_FLOOR_MINUTES` on the TypeScript class and assumes it's enforced. **It's documentation masquerading as enforcement.** Either enforce it, or put it where it's used.

---

### C3 — Prompt Numbering After Receipt Removal Is Not Specified

The plan says:
> The surrounding numbering should be adjusted: instruction 3 is deleted and instructions renumber naturally (only 2 remain).

But what does instruction 3 say? Let me check. The actual prompt text is:
```
1. Treat each file path below as a completely isolated context.
2. Execute each plan fully before moving to the next (if sequential).
3. Upon completing ALL plans, save a read receipt to the inbox.
```

After removing instruction 3, the result is a 2-item list. That's fine. But the plan gives NO specification for what the final prompt should look like. "Renumber naturally" is not an implementation instruction. Delegate agents will get this wrong. Every prompt-change plan should quote the exact before/after text. This one doesn't.

---

## MAJOR

### M1 — The Warning UI Is Stranded After Batch Size Changes

The warning threshold is `batchSize * floorPerPlan`. The user types their interval, sees no warning, saves. Then they change the **batch size selector**. The interval inputs are not re-validated on batch size change — only on interval `onChange`. So a user can:
1. Set `PLAN REVIEWED` to 20 min (no warning at batch size 1)
2. Change batch size to 5 → floor jumps to 25 min
3. 20 min is now below floor — **no warning shown, no re-evaluation triggered**

The `batchSelect.addEventListener('change', ...)` handler calls `emitAutobanState()` but doesn't recompute the warning labels. The plan doesn't address this.

### M2 — `warnLabel` Is Undefined in the Plan's Code Snippet

The code snippet references `warnLabel` but never defines where it comes from. It's not in the current `createAutobanPanel()` implementation. The plan says:

> `warnLabel` is a small `<div>` rendered below each interval input row; empty text keeps it invisible.

That's it. No DOM creation code. No ID. No reference from the `forEach` closure that builds each row. A delegate agent implementing this will either invent their own structure (inconsistency risk) or fail to find `warnLabel` entirely. This is a significant implementation gap.

### M3 — Default Interval Mismatch Risk Between UI and Backend

The plan updates defaults in TWO places:
- `TaskViewerProvider.ts` lines 109–111 (backend state)
- `implementation.html` lines 1760–1762 (frontend initial state)

These must stay in sync. The plan doesn't mention this coupling risk. If someone updates one and not the other, the sidebar will show 10/20/15 while the backend restores 5/10/10 on reload (or vice versa). The plan should mandate testing that both are updated atomically and note the coupling explicitly.

### M4 — No Persistence for Interval Settings

The original Autoban feature plan called for persisting settings to `vscode.workspace.getConfiguration('switchboard').update('autoban', state)`. The current plan says nothing about persistence. If the user configures their intervals (e.g. to 3 min for low-complexity batches) and reloads VS Code, they lose all their settings and revert to defaults. The warning UI becomes useless because the user can't trust their configured values survive a reload.

---

## NIT

### N1 — "Tiered" Is Three States, Draw the Tiers in the Prompt Too

The prompt instruction says "Execute each plan fully before moving to the next (if sequential)" — this remains after the receipt is removed. The warning tier table in the plan is fine, but the reference table uses `≥ floor / 50–99% / < 50%`. The `ratio` math in the code snippet uses `ratio < 0.5` and `ratio < 1.0`. These match, but the table description uses natural language while the code uses ratios. Pick one representation.

### N2 — `Math.max(1, parseInt(...))` Is the Wrong Guard

`parseInt('', 10)` returns `NaN`. `Math.max(1, NaN)` returns `NaN` in JavaScript. The plan's code snippet relies on the `|| defaultMin` fallback, but the order is: `Math.max(1, parseInt(minInput.value, 10) || defaultMin)`. If `parseInt` returns `NaN`, `NaN || defaultMin = defaultMin`, so `Math.max(1, defaultMin)` = fine. But if `parseInt` returns `0`, `0 || defaultMin` = `defaultMin`, which means the user can't actually set the interval to 0 (which is correct) but also can't distinguish "user typed 0" from "field was empty." Minor, but worth being aware of.

### N3 — Test 2 Verification Is Flawed

Test 2 says: "Check `[Autoban] Engine started with rules:` — should show `PLAN REVIEWED: 2m`." But that log line is only emitted when `_startAutobanEngine` is called. If the Autoban engine wasn't enabled before the reload, the log won't appear. The test needs to explicitly say: "Enable the engine before restarting."
