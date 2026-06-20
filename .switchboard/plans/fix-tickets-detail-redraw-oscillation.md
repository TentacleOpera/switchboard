# Fix: Tickets Detail Pane Redraw Oscillation (ClickUp)

## Metadata
**Complexity:** 4
**Tags:** frontend, backend, bugfix, ui, reliability

## Goal

Stop the ClickUp ticket detail/preview pane in `planning.html` from redrawing every few seconds when the user is not interacting with it, eliminating the visible "line lengths keep changing" reflow oscillation.

## Problem Analysis & Root Cause

### Symptom
With a ClickUp ticket selected in the Tickets tab, the right-hand detail/preview pane re-renders roughly every few seconds with no user interaction. Each redraw causes wrapped text line lengths to shift visibly (oscillation).

### How the render pipeline works (confirmed via code trace)
- `renderTicketsClickUpTaskDetail` (`src/webview/planning.js:7336`) only replaces `detailContent.innerHTML` when the generated `contentHtml` differs from the cached `_lastTicketsClickUpDetailContentHtml` (`:7437`).
- `contentHtml` is built from `selectedClickUpIssue.renderedDescriptionHtml` + comments + attachments (`:7409-7435`).
- `renderMarkdown` (`src/webview/sharedUtils.js:90`) is fully deterministic — identical input always yields identical HTML.
- Therefore a visible redraw requires `contentHtml` to actually differ between cycles, which requires `selectedClickUpIssue.renderedDescriptionHtml` to change.

### Trigger path
The only recurring message that feeds new body content into `selectedClickUpIssue` is `ticketFileChanged` (`src/webview/planning.js:3501`), posted by the file watcher `_setupTicketsViewWatcher` (`src/services/PlanningPanelProvider.ts:6973`) on any create/change/delete of a ticket `.md` file (debounced 300ms). The handler updates `selectedClickUpIssue.renderedDescriptionHtml` with a fresh `renderMarkdown(changedBodyMarkdown)` and calls `renderTicketsTab()` (`:3507-3516`).

### Why line lengths oscillate
Each `detailContent.innerHTML` replacement forces a full browser reflow. When the content height sits near the vertical-scrollbar threshold, the reflow toggles the scrollbar, which changes the available text width, which changes wrap points — so line lengths visibly shift each cycle.

### The confirmed-vs-unconfirmed split
- **Confirmed:** The redraw is driven by `ticketFileChanged` firing repeatedly with body content that differs each time (defeating the `_lastTicketsClickUpDetailContentHtml` cache guard). No other recurring path (`ticketSyncStatusesLoaded`, `clickupTaskDetailsLoaded`, `localTicketFileRead`) fires on a timer, and all are gated behind user actions (click, status change, comment).
- **Unconfirmed (needs diagnostic):** *What* rewrites the selected ticket's `.md` body every few seconds. Static trace found no timer-driven writer of ticket body content: `pushTicketEdits` (`TaskViewerProvider.ts:17730`) does not rewrite the local file (it only updates the cache DB via `registerImportedTicket`); `readLocalTicketFile` (`PlanningPanelProvider.ts:4113`) is read-only; `ContinuousSyncService` targets kanban plans, not tickets, and runs at 60s. User confirmed the file is NOT open in an editor (no auto-save/formatter) and the repo is NOT under a cloud-synced folder. So the writer is either (a) an extension-internal path not yet found (e.g., a re-import triggered by another watcher), or (b) spurious watcher events producing differing content. Phase 1 resolves this.

### Secondary issue (hygiene, not the root cause)
`renderTicketsClickUpTaskDetail` performs unguarded DOM writes on every call: `statusSelect.innerHTML` (`:7380`), `subtasksNav.innerHTML` (`:7401`), and `renderTicketTags` (`:7358`). These rebuild even when nothing changed, forcing unnecessary reflow on every `renderTicketsTab`. The same pattern exists in `renderTicketsLinearTaskDetail` (`:6865`). These do not cause the line-length oscillation (the detail content guard holds when content is stable) but should be guarded.

## Constraints & Edge Cases

- **No confirm dialogs** (project rule). N/A here — no deletions involved.
- **Shipped-state migrations:** This is a pure bugfix to render/watcher logic; no user data, settings, or file formats change. No migration required.
- **Both providers:** The fix must apply to both ClickUp and Linear detail render paths (they share the same structure and the same `ticketFileChanged` trigger).
- **Edit mode:** `renderTicketsClickUpTaskDetail` early-returns when `ticketsEditMode` is true (`:7337`). The debounce/coalesce must not interfere with live editing.
- **Legitimate file changes:** When the user genuinely edits the `.md` on disk (external editor, or Edit mode save), the preview MUST still refresh. The fix must distinguish "real change" from "noise/identical-content churn."
- **`localDescription` guard:** When a local file is the source of truth (`localDescription: true`), `clickupTaskDetailsLoaded` preserves the local render (`:4096`). This must remain intact.

## Implementation Plan

### Phase 1 — Diagnostic (confirm trigger + identify the writer)

Goal: Confirm `ticketFileChanged` is the trigger, capture what is changing in the body, and identify the writer. Temporary, removed before commit.

1. **Backend instrumentation** in `_setupTicketsViewWatcher`'s `handleTicketFileEvent` (`PlanningPanelProvider.ts:6992`): before posting `ticketFileChanged`, log to the Output channel (`switchboard`): file path, event type (create/change/delete), file mtime, and a short hash (e.g. first 8 chars of a djb2 hash of the stripped body). This reveals whether the body content actually differs across events and at what cadence.
2. **Webview instrumentation** in the `ticketFileChanged` handler (`planning.js:3501`): `console.log` the changed id, whether it is the selected ticket, and whether the new `renderedDescriptionHtml` equals the previous one.
3. **Webview instrumentation** in `renderTicketsClickUpTaskDetail` (`planning.js:7336`): `console.log` whether `contentHtml` differed from `_lastTicketsClickUpDetailContentHtml` (i.e., whether the guard let the write through).
4. **Reproduce:** Open the Tickets tab, select the offending ClickUp ticket, watch the Output channel + webview dev console for ~30s. Capture: cadence, whether body hash changes, and the diff between consecutive bodies (log the first differing line).

**Exit criterion:** Either (a) identify the exact writer path from the cadence/diff, or (b) confirm the body hash is actually stable and the redraw comes from elsewhere (which would invalidate the root-cause hypothesis and redirect the plan).

### Phase 2 — Root-cause fix (stop the repeated writes)

The specific fix depends on Phase 1's finding. The most likely outcomes and their fixes:

- **If a re-import/re-write loop is found** (e.g., a watcher triggers `importTaskAsDocument` or `saveLocalTicketFile` on the selected ticket repeatedly): break the loop by suppressing the write when the in-memory content matches the on-disk content, or by excluding self-writes from the watcher (track a short "ignore next event" window around extension-initiated writes).
- **If the body diff is trivial/noise** (e.g., a trailing-whitespace or timestamp line injected by some path): normalize the body before hashing/comparison (strip trailing whitespace per line, drop volatile lines) so the cache guard treats it as unchanged.
- **If spurious watcher events with identical body** (body hash stable but events still fire): the Phase 3 render-hash guard alone fixes the visible symptom.

### Phase 3 — Defensive render hardening (applies regardless of Phase 2)

These make the detail pane resilient to churn and are worth doing even after Phase 2:

1. **Add a rendered-HTML equality guard in the `ticketFileChanged` handler** (`planning.js:3507`): before calling `renderTicketsTab()`, compare the newly rendered HTML to `selectedClickUpIssue.renderedDescriptionHtml`. If equal, skip the `renderTicketsTab()` call entirely (avoids all unguarded sub-renders and the function-call overhead). Apply symmetrically to the Linear branch.
2. **Guard the unguarded DOM writes** in `renderTicketsClickUpTaskDetail`:
   - `statusSelect.innerHTML` (`:7380`): build the options string, compare to a `_lastTicketsStatusSelectHtml` cache, only assign on diff.
   - `subtasksNav.innerHTML` (`:7401`): same pattern with a `_lastTicketsSubtasksNavHtml` cache.
   - `renderTicketTags` (`:7358`): add an internal equality guard (compare tags array by id+name) so it no-ops when unchanged.
   - Mirror these guards in `renderTicketsLinearTaskDetail` (`:6865`) for parity.
3. **Coalesce rapid renders:** wrap the `renderTicketsTab()` call from `ticketFileChanged` in a short microtask/`requestAnimationFrame` coalesce so that back-to-back file events within the same frame produce a single render pass rather than N.

### Phase 4 — Verification

1. `npm run compile` (webpack) — required after any `src/webview/*` edit (project rule).
2. Open the Tickets tab, select the offending ClickUp ticket, leave it idle for 60s. Confirm: no visible redraw, no line-length oscillation, dev console shows no `detailContent.innerHTML` writes after the initial render.
3. Edit the ticket's `.md` on disk externally (append a line, save). Confirm the preview DOES update (legitimate change still refreshes).
4. Repeat for a Linear ticket (parity check).
5. Enter Edit mode, confirm editing still works and the preview reflects saves.
6. Run any existing ticket-related tests: `src/test/planning-*.test.js`.

## Risks

- **False negative in Phase 1:** If the body hash turns out stable, the root-cause hypothesis is wrong and Phase 2 redirects. Phase 3 still hardens the render path and likely fixes the visible symptom on its own.
- **Over-suppression:** The Phase 3 equality guard + coalesce must not drop legitimate rapid edits (e.g., a user pasting a large block that triggers multiple watcher events). Mitigation: the guard compares rendered HTML, not raw events, so a real content change always passes; coalesce uses a single rAF, not a long debounce.
- **Cache-guard string growth:** The new `_lastTickets*Html` caches are small strings held in module scope; negligible memory. Reset them in `resetTicketsInMemoryState` (`planning.js:7657`) alongside the existing resets.

## Out of Scope

- Redesigning the file-watcher architecture (the create/change/delete-all-events design is intentional for atomic writes — see comment at `PlanningPanelProvider.ts:6987`).
- Changes to `renderMarkdown` (it is correct and deterministic).
- Any UI/UX changes to the Tickets tab layout.
