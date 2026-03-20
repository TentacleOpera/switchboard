# Make airlock the second tab

## Notebook Plan

In sidebar, change tab order - airlock should be second tab, autoban the third tab

## Goal
- Reorder the sidebar tabs so users see: **Agents → Airlock → Autoban** (currently: Agents → Autoban → Airlock).
- Single file change, no JS logic changes required.

## Source Code Verification (2026-03-15)
- **Tab bar HTML** at `src/webview/implementation.html:1273-1277` — current order is Agents, Autoban, Airlock.
- **Tab switching JS** at `src/webview/implementation.html:2434-2442` — `switchAgentTab()` uses `dataset.tab` attribute mapping, NOT DOM order. Safe to reorder.
- **Tab panels** at lines 1278-1284 — panels are identified by `id` (`agent-list-standard`, `agent-list-autoban`, `agent-list-webai`), toggled by key lookup in `const tabs = { agents: ..., autoban: ..., webai: ... }`. DOM order of panels is irrelevant.

## Proposed Changes

### Step 1 — Swap tab button order (Routine, single edit)
- **File:** `src/webview/implementation.html`
- **Lines 1274-1276:** Swap the Autoban and Airlock button elements.
- **Exact change:**
  ```html
  <!-- OLD (lines 1274-1276): -->
  <button class="sub-tab-btn is-active" data-tab="agents">Agents</button>
  <button class="sub-tab-btn" data-tab="autoban">Autoban</button>
  <button class="sub-tab-btn" data-tab="webai">Airlock</button>

  <!-- NEW: -->
  <button class="sub-tab-btn is-active" data-tab="agents">Agents</button>
  <button class="sub-tab-btn" data-tab="webai">Airlock</button>
  <button class="sub-tab-btn" data-tab="autoban">Autoban</button>
  ```

### No other files need changes.
- The panel `<div>` order (lines 1283-1284) does not need to change — panels are shown/hidden by `id` lookup, not DOM position.
- The `switchAgentTab` function (line 2434) does not need changes — it uses `dataset.tab` mapping.

## Verification Plan
1. Run the extension in development mode (`F5` launch).
2. Open the Switchboard sidebar.
3. Confirm tabs display as: **Agents | Airlock | Autoban** (left to right).
4. Click **Airlock** tab → verify `agent-list-webai` panel shows, tab is highlighted.
5. Click **Autoban** tab → verify `agent-list-autoban` panel shows, tab is highlighted.
6. Click **Agents** tab → verify `agent-list-standard` panel shows, tab is highlighted.

## Open Questions
- None.

---

## Adversarial Review

### Grumpy Critique
"This is barely a 'plan', it's a one-sentence chore! The only risk is if the JS relies on DOM indices — and it doesn't. Next."

### Balanced Synthesis
The critique is valid — this is trivially simple. The `data-tab` attribute-based switching makes DOM reordering safe. No JS changes needed.

**Recommendation:** This is a simple plan. Send it to the **Coder agent**.
