# Tickets tab: move Refetch into a "More" menu (keep Refresh primary)

## Goal

Declutter the Tickets top control strip by demoting **Refetch** out of the always-visible strip into an overflow **"⋯ More"** menu, while keeping **Refresh** as the primary, always-visible action. Refetch is a genuine drift-recovery escape hatch and must stay reachable — it just doesn't deserve a permanent top-strip slot next to Refresh, where the two read as confusing duplicates.

### Problem & root-cause analysis

The Tickets top control strip ([src/webview/planning.html:3899-3900](src/webview/planning.html)) carries two adjacent buttons:

```html
<button id="tickets-refresh" class="strip-btn" title="Refresh recent changes">Refresh</button>
<button id="tickets-refetch" class="strip-btn" title="Re-fetch from source and save local copies">Refetch</button>
```

Their handlers ([src/webview/planning.js:9731-9790](src/webview/planning.js)) hit the same backend path (`refreshTicketsDelta` → `importAllTasks`); the only difference is `forceFull`:

- **Refresh** (no flag) reads the saved per-list/project delta cursor and pulls only tickets **updated since** the last pull — incremental, fast. This is the everyday action.
- **Refetch** (`forceFull: true`) ignores the cursor and re-pulls the **entire** list/project, rewriting all local files ([PlanningPanelProvider.ts:5933-5940](src/services/PlanningPanelProvider.ts)).

For nearly every use the two produce the same visible result, so side-by-side they read as redundant clutter on an already-overflowing strip (`overflow-x: auto; flex-wrap: nowrap`, [:196-206](src/webview/planning.html)).

**But Refetch is not removable.** It was added to recover from a real bug where local ticket state drifted out of sync with the provider and a delta refresh could not repair it (the delta query is "updated-since" based, so it can miss changes the cursor already skipped past). Full re-pull is the only recovery path. So the fix is **relocation, not deletion**: keep Refresh visible, hide Refetch inside a "⋯ More" menu with a label that says what it's for.

## User Review Required

- Confirm moving **Sync changes** and **Agent API** into the same "⋯ More" menu alongside Refetch. These are occasional/power actions crowding the strip; relocating them leaves the strip as { filters + Source + Refresh + ⋯ More }. This is scope expansion beyond the literal "merge Refresh/Refetch" feature goal — confirm before implementation.
- Confirm the Refetch menu-item label: **"Full re-fetch (recover from sync drift)"** — communicates purpose, not just the mechanic.

## Metadata
**Tags:** frontend, ui, cleanup
**Complexity:** 3

## Complexity Audit

### Routine
- Removing `#tickets-refetch` (and `#tickets-sync-all`, `#tickets-agent-api`) from the always-visible strip and re-rendering them as items inside the "⋯ More" menu — DOM location changes only, ids/handlers preserved.
- Keeping `#tickets-refresh` exactly as-is — primary, always-visible, delta refresh. Handler unchanged.
- Updating `getTicketsTabElements()` ([planning.js:2298](src/webview/planning.js)) — `refetchButton` lookup still resolves (id unchanged, just moved).

### Complex / Risky
- **Popover inside a horizontally-scrolling flex container.** The top strip is `overflow-x: auto; flex-wrap: nowrap` ([:196-206](src/webview/planning.html)). An absolutely-positioned popover anchored to a "⋯ More" trigger inside this strip may be clipped or scroll with the strip's horizontal overflow. The meta-bar popover (other subtask) lives in a `flex-wrap: wrap` bar with no horizontal overflow — different CSS context. **Verify the popover escapes the strip's `overflow-x: auto`.** Likely fix: anchor the popover to the trigger with `position: fixed` (viewport-relative) computed from the trigger's `getBoundingClientRect()`, or render the popover in a top-level container outside the strip. A naive `position: absolute` inside the strip will be clipped.
- **Reusing the multi-instance overflow component.** This subtask depends on the component built in the *de-overload the ticket preview meta bar* subtask. That component must be multi-instance (this is the second instance). If the component was accidentally built single-instance id-based, this subtask will collide with the meta-bar instance. Verify before wiring.

## Edge-Case & Dependency Audit

- **Race Conditions:** None new. Refresh and Refetch handlers are unchanged; only their DOM location moves. The caches (`linearIssueDetailCache.clear()`, `clickUpTaskDetailCache.clear()`) still clear on each click.
- **Security:** No new surface. No user input, no eval, no external URLs.
- **Side Effects:** Moving `#tickets-sync-all` and `#tickets-agent-api` into the menu changes their DOM parents. Any code that walks the strip's direct children looking for these ids still resolves them by `getElementById` (ids unchanged). Verify no code assumes these buttons are direct children of `#controls-strip-tickets`.
- **Dependencies & Conflicts:**
  - **Depends on:** the reusable overflow-menu component introduced by the *de-overload the ticket preview meta bar* subtask. Land that first, or build the component in whichever subtask lands first and have the other reuse it. Do not build two overflow menus.
  - **Conflicts:** none on shared symbols — Refresh handler, Refetch handler, and the menu component are all distinct.

## Dependencies

- **Depends on** the reusable overflow-menu component introduced by the *de-overload the ticket preview meta bar* subtask. Land that first, or build the component in whichever subtask lands first and have the other reuse it.

## Adversarial Synthesis

Key risks: (1) the top strip's `overflow-x: auto` will clip a naively-positioned `position: absolute` popover — the meta-bar's `flex-wrap: wrap` context does not have this problem, so the component cannot blindly copy the meta-bar's anchoring; (2) the component must be multi-instance or this menu collides with the meta-bar instance. Mitigations: anchor the popover with `position: fixed` computed from the trigger's bounding rect (or render outside the strip), and verify the shared component is class/data-attribute scoped before wiring.

## Proposed Changes

### `src/webview/planning.html`
- **Context:** Top control strip at [:3899-3902](src/webview/planning.html) — Refresh, Refetch, Sync changes, Agent API buttons.
- **Logic:** Keep Refresh primary; move Refetch / Sync changes / Agent API into the "⋯ More" overflow menu.
- **Implementation:**
  1. **Keep `#tickets-refresh`** exactly as-is — primary, always-visible, delta refresh. Handler unchanged.
  2. **Remove `#tickets-refetch` from the always-visible strip** ([:3900](src/webview/planning.html)) and re-render it as an item inside a top-strip **"⋯ More"** overflow menu.
     - Reuse the overflow-menu component built in the **de-overload the ticket preview meta bar** subtask (do not build a second one). This subtask therefore depends on that component existing.
     - Label the menu item clearly, e.g. **"Full re-fetch (recover from sync drift)"**, so its purpose — not just its mechanic — is obvious. Keep its handler (`forceFull: true` payload) and its element wiring intact; only its DOM location moves.
  3. **Also move `Sync changes` and `Agent API` into the same "⋯ More" menu.** Both are occasional/power actions crowding the strip; relocating them leaves the strip as { filters + Source + Refresh + ⋯ More }. Keep their ids and handlers; only their DOM location moves.
- **Edge Cases:** Popover must escape the strip's `overflow-x: auto` — see Complexity Audit.

### `src/webview/planning.js`
- **Context:** `getTicketsTabElements()` at [planning.js:2298](src/webview/planning.js); refresh/refetch handlers at [planning.js:9731-9790](src/webview/planning.js).
- **Logic:** Update element lookups to match the new DOM locations; keep handlers intact.
- **Implementation:**
  1. Update `getTicketsTabElements()` / any `refetchButton` display toggles ([planning.js:2298](src/webview/planning.js)) to match the new location; grep `tickets-refetch` / `refetchButton` to confirm nothing dangles.
  2. The refresh handler ([planning.js:9731-9757](src/webview/planning.js)) and refetch handler ([planning.js:9760-9788](src/webview/planning.js)) stay unchanged — they are wired by id, and the ids survive the move.
  3. Wire the top-strip "⋯ More" trigger to the shared overflow component (second instance).
- **Edge Cases:** Verify the popover anchoring survives the strip's horizontal scroll — see Complexity Audit.

## Verification Plan

### Automated Tests
- Skipped per session directive (no automated tests run).

### Manual Checks
- Top strip shows Refresh (visible) + a "⋯ More" menu; Refetch is no longer a bare strip button.
- Refresh still does the delta pull (`refreshTicketsDelta`, no `forceFull`).
- Opening "⋯ More" → the full re-fetch item fires the `forceFull: true` payload and completes a full re-pull for both Linear and ClickUp.
- If Sync changes / Agent API were moved too, they still work from the menu.
- Grep confirms no dangling `tickets-refetch` references outside the menu wiring.
- **Popover-clip check:** open the "⋯ More" menu when the top strip is horizontally scrolled (narrow window) — the popover must not be clipped by the strip's `overflow-x: auto`.
- **Multi-instance check:** with the meta-bar "⋯ More" also landed, opening both menus must not collide.

## Decisions (confirmed)
- **Sync changes** and **Agent API** move into the "⋯ More" menu alongside Refetch.
- Refetch menu-item label: **"Full re-fetch (recover from sync drift)"** — communicates purpose, not just the mechanic.

## Routing
**Complexity 3 → Send to Intern.** Mostly DOM relocation + one well-scoped CSS risk (popover clipping in `overflow-x: auto`) that the dependent component subtask should already have solved. If the popover-clip risk turns out to require a non-trivial anchoring fix, escalate to Coder.

## Review Findings

Reviewed the committed implementation (commit 32bc8ab) against this plan. Refetch/Sync changes/Agent API are correctly moved into the top-strip "⋯ More" overflow menu with the purpose-stating label "Full re-fetch (recover from sync drift)"; Refresh stays primary and its handler is untouched. The shared overflow component uses `position: fixed` (planning.js:2293-2308) so the popover escapes the strip's `overflow-x: auto` — the plan's #1 risk is mitigated. Multi-instance scoping via `[data-overflow-menu]` data attributes means no collision with the meta-bar instance. No CRITICAL/MAJOR findings. Two NITs (defer): `ticketsMoreTrigger` in `getTicketsTabElements()` (planning.js:2397) is a dead property never read anywhere; the Refetch menu item's `title` attribute still says "Re-fetch from source and save local copies" while its label says "Full re-fetch (recover from sync drift)" — cosmetic tooltip/label mismatch. Verification: grep confirmed no dangling `tickets-refetch`/`refetchButton` references outside the menu wiring; handlers wired by id survive the DOM move. Remaining risk: none material — the popover repositions on scroll/resize via capture-phase listeners, and the `data-empty` trigger-hide logic correctly never fires for the top-strip menu (its items are always visible).
