# Balanced Review: Autoban Read Receipts + Tiered Interval Warnings

## Summary of Review

The plan is directionally correct — removing read receipts is the right call, and a warn-only UI is better UX than autocorrecting. However, the grumpy critique surfaced one genuine showstopper (double-dispatch gap), one significant architectural confusion (dead backend constant), one missing implementation detail (warnLabel DOM definition), and a real usability hole (warnings not re-evaluated on batch size change). The persistence gap is a pre-existing issue, not introduced by this plan, and should be tracked separately.

---

## Valid Concerns

### ✅ C1 — Double-Dispatch Gap Is Real
**Accept.** The existing `_autobanTickColumn` reads runsheets from disk with no in-memory deduplication guard. If a tick fires while a previous dispatch's runsheet write is in-flight, the same card can be picked up twice. This predates this plan but removing read receipts doesn't worsen it — the critique is slightly unfair in attributing this to the receipt removal. That said, a simple in-memory `_activeDispatches = new Set<string>()` guard (cleared when the engine stops) would close this and should be added to the plan.

### ✅ C2 — `AUTOBAN_FLOOR_MINUTES` Placement Is Misleading
**Accept.** If the constant is never enforced by the backend, it should live in `implementation.html` as a JS constant, not on the TypeScript class. Move it.

### ✅ M1 — Warning Not Re-Evaluated on Batch Size Change
**Accept.** The `batchSelect.addEventListener('change')` must trigger re-evaluation of all interval warning labels, not just emit state. This is a genuine UX bug in the plan.

### ✅ M2 — `warnLabel` DOM Definition Is Missing
**Accept.** The plan must specify exactly where `warnLabel` is created in the `forEach` loop. Without this, delegate agent implementation is a coin flip.

### ✅ C3 — Exact Prompt Text Not Specified
**Accept partially.** The plan should quote the final state of the prompt after the receipt line is removed. "Renumber naturally" is ambiguous when the agent reading this instruction might be automated.

---

## Action Plan

1. **Add in-flight dispatch guard**: Add `private _activeDispatchSessions = new Set<string>()` to `TaskViewerProvider`. Before dispatching a batch in `_autobanTickColumn`, filter out any `sessionId` already in the set. Add session IDs on dispatch; remove them when the next tick finds the card has moved column. This closes C1.

2. **Move `AUTOBAN_FLOOR_MINUTES` to frontend**: Remove it from `TaskViewerProvider.ts`. Define it as a plain JS `const` inside `createAutobanPanel()` or as a module-level constant in `implementation.html`. Closes C2.

3. **Re-evaluate warnings on batch size change**: In `batchSelect.addEventListener('change')`, after updating `autobanState.batchSize`, call `recomputeIntervalWarnings()` — a small helper that loops over `columnTransitions` and reapplies the warning logic to each visible `minInput`. Closes M1.

4. **Define `warnLabel` DOM element explicitly**: In the plan's `columnTransitions.forEach` loop, add after the `minInput` element:
   ```js
   const warnLabel = document.createElement('div');
   warnLabel.style.cssText = 'font-size:9px; padding:1px 8px; font-family:var(--font-mono); min-height:12px;';
   ruleRow.appendChild(minInput);
   ruleRow.appendChild(warnLabel);
   ```
   Closes M2.

5. **Specify exact prompt output**: Add a before/after to the plan:
   ```
   // Before:
   "1. Treat each file path below as a completely isolated context. Do not mix requirements between plans.\n2. Execute each plan fully before moving to the next (if sequential).\n3. Upon completing ALL plans, save a read receipt to the inbox.\n\n"

   // After:
   "1. Treat each file path below as a completely isolated context. Do not mix requirements between plans.\n2. Execute each plan fully before moving to the next (if sequential).\n\n"
   ```
   Closes C3.

6. **Fix Test 2 verification**: Add "Enable the Autoban engine" as step 1 of Test 2, before the restart. Closes N3.

---

## Dismissed Points

- **M3 (Default drift between UI and backend)**: Valid risk but pre-existing — not introduced by this plan. A comment in the code noting the coupling would be sufficient. Full ownership tracking is out of scope here.
- **M4 (No persistence)**: Pre-existing gap from the original Autoban feature plan. This plan doesn't make persistence worse. Track separately.
- **N1 (Tier representation consistency)**: Low value. The code is what matters; the table is documentation. NIT dismissed.
- **N2 (`parseInt` edge case)**: The `|| defaultMin` fallback handles this correctly in practice. The behaviour of `0 || defaultMin` is intentional (you shouldn't set an interval of 0). NIT dismissed.
