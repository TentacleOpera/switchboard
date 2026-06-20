# Fix: Tickets Detail Pane Redraw Oscillation (ClickUp)

## Goal

Stop the ClickUp ticket detail/preview pane in `planning.html` from redrawing every few seconds when the user is not interacting with it, eliminating the visible "line lengths keep changing" reflow oscillation.

## Problem Analysis & Root Cause

### Symptom
With a ClickUp ticket selected in the Tickets tab, the right-hand detail/preview pane re-renders roughly every few seconds with no user interaction. Each redraw causes wrapped text line lengths to shift visibly (oscillation).

### How the render pipeline works (confirmed via code trace)
- `renderTicketsTab()` (`src/webview/planning.js:6542`) dispatches to `renderTicketsClickUpPanel()` (`:6548`) or `renderTicketsLinearPanel()` (`:6546`).
- `renderTicketsClickUpPanel()` calls `renderTicketsClickUpTaskDetail()` unconditionally at `:7045`.
- `renderTicketsLinearPanel()` calls `renderTicketsLinearTaskDetail()` unconditionally at `:6593`.
- `renderTicketsClickUpTaskDetail` (`src/webview/planning.js:7336`) only replaces `detailContent.innerHTML` when the generated `contentHtml` differs from the cached `_lastTicketsClickUpDetailContentHtml` (`:7437`).
- `contentHtml` is built from `selectedClickUpIssue.renderedDescriptionHtml` + comments + attachments (`:7409-7435`).
- `renderMarkdown` (`src/webview/sharedUtils.js:90`) is fully deterministic — identical input always yields identical HTML.
- Therefore a visible `detailContent` redraw requires `contentHtml` to actually differ between cycles, which requires `selectedClickUpIssue.renderedDescriptionHtml` to change.

### Trigger path
The only recurring message that feeds new body content into `selectedClickUpIssue` is `ticketFileChanged` (`src/webview/planning.js:3501`), posted by the file watcher `_setupTicketsViewWatcher` (`src/services/PlanningPanelProvider.ts:6973`) on any create/change/delete of a ticket `.md` file (debounced 300ms). The handler updates `selectedClickUpIssue.renderedDescriptionHtml` with a fresh `renderMarkdown(changedBodyMarkdown)` and calls `renderTicketsTab()` (`:3507-3516`).

### Why line lengths oscillate
Each `detailContent.innerHTML` replacement forces a full browser reflow. When the content height sits near the vertical-scrollbar threshold, the reflow toggles the scrollbar, which changes the available text width, which changes wrap points — so line lengths visibly shift each cycle.

### The confirmed-vs-unconfirmed split
- **Confirmed:** The redraw is driven by `ticketFileChanged` firing repeatedly with body content that differs each time (defeating the `_lastTicketsClickUpDetailContentHtml` cache guard). No other recurring path (`ticketSyncStatusesLoaded`, `clickupTaskDetailsLoaded`, `localTicketFileRead`) fires on a timer, and all are gated behind user actions (click, status change, comment).
- **Unconfirmed (needs diagnostic):** *What* rewrites the selected ticket's `.md` body every few seconds. Static trace found no timer-driven writer of ticket body content: `pushTicketEdits` (`TaskViewerProvider.ts:17730`) does not rewrite the local file (it only updates the cache DB via `registerImportedTicket`); `readLocalTicketFile` (`PlanningPanelProvider.ts:4113`) is read-only; `ContinuousSyncService` targets kanban plans, not tickets, and runs at 60s. User confirmed the file is NOT open in an editor (no auto-save/formatter) and the repo is NOT under a cloud-synced folder. So the writer is either (a) an extension-internal path not yet found (e.g., a re-import triggered by another watcher), or (b) spurious watcher events producing differing content. Phase 1 resolves this.

### Additional suspects identified during plan improvement (code trace)

> **Refinement (added during improve-plan):** The original analysis above missed two critical paths. These are appended as additional Phase 1 suspects.

1. **`_updateTicketsAutoSyncWatcher`** (`PlanningPanelProvider.ts:7021`): A SECOND file watcher on the same `.switchboard/tickets/**/*.md` glob, separate from `_setupTicketsViewWatcher`. It watches `onDidChange` only (create/delete ignored — `createFileSystemWatcher(glob, true, false, true)` at `:7038`) with a 2000ms debounce. When a ticket `.md` changes, it triggers `pushTicketEdits` (`:7051`), which pushes local edits to the remote API. This watcher is enabled only when `ticketsAutoSync` is true (from `localService.getTicketsAutoSync()`, checked at `:1528`).

2. **`hostInlineImages` writeback** (`src/services/ImageHostingHelper.ts:87`): `pushTicketEdits` calls `hostInlineImages` (`TaskViewerProvider.ts:17784`/`17794`) to upload inline images and rewrite their references. When `replacements.length > 0`, `hostInlineImages` writes the updated content back to the local `.md` file (`ImageHostingHelper.ts:109`: `fs.writeFileSync(sourceFilePath, updatedContent, 'utf8')`). This writeback triggers the file watcher → `ticketFileChanged` → `renderTicketsTab()`. On the second pass the images are already hosted (no replacements), so this is at most a 2-iteration cascade — but if the initial file change recurs for other reasons, the cascade repeats.

3. **`ticketSyncStatusesLoaded` is NOT always user-gated when auto-sync is on:** The original analysis states all non-`ticketFileChanged` paths are "gated behind user actions." This is inaccurate when auto-sync is enabled. The `pushTicketResult` handler (`planning.js:3545`) calls `_requestTicketSyncStatuses()` automatically on success (`:3552`), which sends `getTicketSyncStatuses` to the backend, which responds with `ticketSyncStatusesLoaded`, which calls `renderTicketsTab()` (`:3404`). So the auto-sync flow can trigger `renderTicketsTab()` without user action. While this path doesn't change `detailContent.innerHTML` (the content guard holds), it DOES trigger the unguarded DOM writes (`statusSelect.innerHTML`, `subtasksNav.innerHTML`, `renderTicketTags`), causing reflow.

### Secondary issue (hygiene, not the root cause)
`renderTicketsClickUpTaskDetail` performs unguarded DOM writes on every call: `statusSelect.innerHTML` (`:7380`), `subtasksNav.innerHTML` (`:7401`), and `renderTicketTags` (`:7358`). These rebuild even when nothing changed, forcing unnecessary reflow on every `renderTicketsTab`. The same pattern exists in `renderTicketsLinearTaskDetail` (`:6865`). These do not cause the line-length oscillation (the detail content guard holds when content is stable) but should be guarded.

> **Refinement (added during improve-plan):** `renderTicketTags` (`planning.js:266`) unconditionally executes `container.innerHTML = ''` at `:270` and rebuilds all pill DOM elements on every call — even when the tags array is identical. This is the most frequent unguarded write since it fires on every `renderTicketsTab()` regardless of provider. Additionally, `renderTicketsLinearTaskDetail` has TWO separate `statusSelect.innerHTML` assignments — one at `:6907` (when `availableLinearStates.length > 0`) and one at `:6923` (fallback path) — both need guards.

## Metadata
**Tags:** frontend, backend, bugfix, ui, reliability
**Complexity:** 4

## User Review Required

Yes — Phase 1 (diagnostic instrumentation) introduces temporary logging that must be removed before commit. Phase 2's specific fix depends on Phase 1's findings and may require user confirmation of the identified writer path. The decision to reorder Phase 3 ahead of Phase 1 (see Implementation Plan refinement below) should be confirmed by the user, as it changes the plan's execution sequence.

## Complexity Audit

### Routine
- Adding equality guards following the existing `_lastTicketsClickUpDetailContentHtml` / `_lastTicketsDetailContentHtml` cache pattern (already proven in the codebase at `:7437` and `:6984`).
- Caching `statusSelect.innerHTML` and `subtasksNav.innerHTML` strings behind equality checks — same pattern as `_lastTicketsStateFilterHtml` (`:6610`), `_lastTicketsIssuesContainerHtml` (`:6859`), etc.
- Adding new cache variables to `resetTicketsInMemoryState` (`:7657`) alongside existing resets (`:7703-7710`).
- Temporary diagnostic instrumentation (console.log / Output channel logging) — straightforward, removed before commit.

### Complex / Risky
- Identifying the actual writer of the `.md` file (Phase 1 diagnostic) — the static trace was inconclusive and the auto-sync watcher + `hostInlineImages` writeback path adds complexity.
- Ensuring the equality guard in the `ticketFileChanged` handler (`:3507`) does not suppress legitimate rapid edits (e.g., user pasting a large block that triggers multiple watcher events).
- The `renderTicketTags` guard must handle the transition from "no tags / container hidden" to "has tags / container shown" correctly — a simple string comparison of the tags array is insufficient because the container's `display` state also matters.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The `ticketFileChanged` handler (`:3501`) and `ticketSyncStatusesLoaded` handler (`:3392`) can both call `renderTicketsTab()` in quick succession if the auto-sync watcher triggers `pushTicketEdits` → `pushTicketResult` → `_requestTicketSyncStatuses()` → `ticketSyncStatusesLoaded` while a `ticketFileChanged` event is also in flight. The equality guards and coalesce mitigate this.
- The 300ms debounce in `_setupTicketsViewWatcher` (`:7001`) and the 2000ms debounce in `_updateTicketsAutoSyncWatcher` (`:7048`) operate independently on the same file events. A file change triggers the view watcher at 300ms and the auto-sync watcher at 2000ms — if `hostInlineImages` writes back at ~2000ms+, the view watcher fires again at ~2300ms, creating a staggered cascade.

**Security:**
- No security implications. The fix is purely client-side render logic. No credentials, tokens, or user data are exposed or modified.

**Side Effects:**
- Adding equality guards changes the render behavior: previously, `renderTicketsTab()` always executed all sub-renders. After the fix, some sub-renders will be skipped. This is the intended behavior but must not skip renders that are needed for non-content state changes (e.g., status dropdown updates when `availableClickUpStatuses` changes).
- The `renderTicketTags` guard must not prevent tag display updates when the user adds/removes tags via the tags modal.
- New `_lastTickets*Html` cache variables consume module-scope memory. Negligible (small strings), but must be reset in `resetTicketsInMemoryState`.

**Dependencies & Conflicts:**
- The fix depends on `renderMarkdown` (`sharedUtils.js:90`) remaining deterministic. If a future change introduces non-determinism (e.g., random IDs, timestamps in output), the equality guards will fail and renders will resume. No current risk.
- The auto-sync watcher (`_updateTicketsAutoSyncWatcher`) and the view watcher (`_setupTicketsViewWatcher`) both watch the same file glob. Changes to either watcher's debounce timing or event filtering could affect the cascade behavior.
- No conflicts with other planned features identified.

## Dependencies

None — this is a standalone bugfix. No dependent sessions or prerequisite plans.

## Adversarial Synthesis

Key risks: (1) The plan's root-cause analysis missed the `_updateTicketsAutoSyncWatcher` and `hostInlineImages` writeback path, which could be the actual writer — Phase 1 instrumentation must cover this. (2) Reordering Phase 3 (defensive hardening) ahead of Phase 1 provides immediate symptom relief but may mask the root cause, making Phase 1 diagnosis harder if the symptom disappears. Mitigation: implement Phase 3 first for relief, then temporarily disable Phase 3 guards to run Phase 1 diagnostics if root-cause confirmation is still desired. (3) The `renderTicketTags` guard has a subtle edge case with container display state that a naive array comparison will miss.

## Proposed Changes

### src/webview/planning.js

**Context:** The primary webview render file. All permanent fixes live here. The file already uses an equality-guard pattern for `detailContent.innerHTML` (`:7437`/`:6984`) and for list/filter containers (`:6610`, `:6859`, `:7249`). The fix extends this pattern to the remaining unguarded writes and adds an early-exit guard in the `ticketFileChanged` handler.

**Logic:**
1. **Early-exit equality guard in `ticketFileChanged` handler** (`:3507`): Before calling `renderTicketsTab()` at `:3516`, compare the newly rendered HTML (`renderMarkdown(changedBodyMarkdown)`) to the existing `selectedClickUpIssue.renderedDescriptionHtml` / `selectedLinearIssue.renderedDescriptionHtml`. If identical, skip the `renderTicketsTab()` call entirely. This is the highest-impact fix — it prevents ALL sub-renders (including unguarded writes) when content hasn't changed.
2. **Guard `statusSelect.innerHTML`** in `renderTicketsClickUpTaskDetail` (`:7380`): Build the options string, compare to a new `_lastTicketsClickUpStatusSelectHtml` cache, only assign on diff.
3. **Guard `subtasksNav.innerHTML`** in `renderTicketsClickUpTaskDetail` (`:7401`): Same pattern with a `_lastTicketsClickUpSubtasksNavHtml` cache.
4. **Guard `renderTicketTags`** (`:266`): Add an internal equality check — compare the incoming tags array (by id+name for ClickUp, by id+name for Linear) to a cached `_lastTicketsTagsKey` string. If unchanged, early-return without clearing/rebuilding. Must also cache the provider to handle provider switches. Handle the empty-tags case: if tags go from non-empty to empty, still clear the container.
5. **Mirror guards 2-4 in `renderTicketsLinearTaskDetail`** (`:6865`): Guard both `statusSelect.innerHTML` writes (`:6907` and `:6923` — the fallback path) with a `_lastTicketsLinearStatusSelectHtml` cache. Guard `subtasksNav.innerHTML` (`:6948`) with a `_lastTicketsLinearSubtasksNavHtml` cache. The `renderTicketTags` guard (step 4) is shared.
6. **Coalesce rapid renders** (optional, secondary): Wrap the `renderTicketsTab()` call from `ticketFileChanged` in a `requestAnimationFrame` coalesce so back-to-back file events within the same frame produce a single render pass.
7. **Reset new caches** in `resetTicketsInMemoryState` (`:7657`): Add `_lastTicketsClickUpStatusSelectHtml = ''`, `_lastTicketsClickUpSubtasksNavHtml = ''`, `_lastTicketsLinearStatusSelectHtml = ''`, `_lastTicketsLinearSubtasksNavHtml = ''`, `_lastTicketsTagsKey = ''`, `_lastTicketsTagsProvider = ''` alongside existing resets (`:7703-7710`).

**Implementation:** All changes are in `src/webview/planning.js`. New cache variables declared at module scope near existing `_lastTickets*Html` declarations (`:205-212`). The `ticketFileChanged` handler guard goes at `:3507` before the `renderTicketsTab()` call at `:3516`.

**Edge Cases:**
- **Edit mode:** `renderTicketsClickUpTaskDetail` early-returns when `ticketsEditMode` is true (`:7337`). The equality guard in `ticketFileChanged` must also check `ticketsEditMode` — if editing, always render to reflect live saves. Alternatively, the existing early-return in the detail function is sufficient since `renderTicketsTab()` → `renderTicketsClickUpPanel()` → `renderTicketsClickUpTaskDetail()` which early-returns. But the equality guard at `:3507` would skip even the `renderTicketsClickUpPanel()` call, which updates the list. Safe to skip since edit mode doesn't change the list.
- **Legitimate rapid edits:** A user pasting a large block may trigger multiple watcher events. Each event carries different content (the file is being written), so the equality guard passes each time. The rAF coalesce (step 6) batches same-frame events into one render.
- **Status list changes:** When `availableClickUpStatuses` changes (e.g., loaded from API), the `statusSelect.innerHTML` guard must allow the update. The guard compares the generated HTML string, so a change in available statuses produces different HTML and passes the guard.
- **Tags modal:** When the user adds/removes tags via the tags modal, `renderTicketsTab()` is called with updated `currentTicketTags`. The `renderTicketTags` guard compares the new tags array — if different, it rebuilds. If the user opens and closes the modal without changes, the guard correctly skips.

### src/services/PlanningPanelProvider.ts (Phase 1 only — temporary, removed before commit)

**Context:** The extension backend that hosts the file watchers and posts messages to the webview.

**Logic:** Temporary diagnostic instrumentation in `handleTicketFileEvent` (`:6992`) to log file path, event type, mtime, and a body content hash. Also instrument the auto-sync watcher's `pushTicketEdits` trigger (`:7048`) and check whether `ticketsAutoSync` is enabled.

**Implementation:** Add logging before the `postMessage` call at `:7009`. Log to the `switchboard` Output channel. Also log in the auto-sync watcher's debounce callback (`:7048`) before the `pushTicketEdits` call. Check `localService.getTicketsAutoSync()` at startup and log whether auto-sync is enabled.

**Edge Cases:** All instrumentation is temporary and must be removed before commit. No permanent changes to this file.

### src/services/ImageHostingHelper.ts (potential Phase 2 target)

**Context:** `hostInlineImages` (`:87`) uploads inline images and writes hosted URLs back to the local `.md` file (`:109`).

**Logic:** If Phase 1 identifies `hostInlineImages` writeback as the writer, the fix is to suppress the writeback when the rewritten content matches the existing file content (compare before writing). Alternatively, track a short "ignore next event" window around extension-initiated writes in the view watcher.

**Implementation:** Add a content equality check at `:108` before `fs.writeFileSync` — if `updatedContent === content`, skip the write. This is already partially handled (`:108`: `if (updatedContent !== content)`), but the issue is that the FIRST writeback (with replacements) always differs from the original, triggering the watcher. The fix would be to either (a) suppress the view watcher for this specific write, or (b) accept the one-shot cascade since it self-terminates.

**Edge Cases:** The writeback only fires when `replacements.length > 0` (inline images exist). Tickets without inline images are unaffected.

## Verification Plan

### Automated Tests

Per session directives: **skip compilation** (`npm run compile` / webpack) and **skip automated tests** (unit, integration, e2e). The test suite will be run separately by the user. The verification below is manual-only.

### Manual Verification

1. Open the Tickets tab, select the offending ClickUp ticket, leave it idle for 60s. Confirm: no visible redraw, no line-length oscillation, dev console shows no `detailContent.innerHTML` writes after the initial render.
2. Edit the ticket's `.md` on disk externally (append a line, save). Confirm the preview DOES update (legitimate change still refreshes).
3. Repeat for a Linear ticket (parity check).
4. Enter Edit mode, confirm editing still works and the preview reflects saves.
5. If auto-sync is enabled: disable auto-sync, confirm the oscillation stops (isolates the auto-sync watcher as a variable). Re-enable auto-sync, confirm the fix still holds.
6. Open the tags modal, add/remove a tag, confirm the tags display updates correctly.
7. Change the ticket's status via the status dropdown, confirm the dropdown re-renders with the new selection.

## Constraints & Edge Cases

- **No confirm dialogs** (project rule). N/A here — no deletions involved.
- **Shipped-state migrations:** This is a pure bugfix to render/watcher logic; no user data, settings, or file formats change. No migration required.
- **Both providers:** The fix must apply to both ClickUp and Linear detail render paths (they share the same structure and the same `ticketFileChanged` trigger).
- **Edit mode:** `renderTicketsClickUpTaskDetail` early-returns when `ticketsEditMode` is true (`:7337`). The debounce/coalesce must not interfere with live editing.
- **Legitimate file changes:** When the user genuinely edits the `.md` on disk (external editor, or Edit mode save), the preview MUST still refresh. The fix must distinguish "real change" from "noise/identical-content churn."
- **`localDescription` guard:** When a local file is the source of truth (`localDescription: true`), `clickupTaskDetailsLoaded` preserves the local render (`:4096`). This must remain intact.

## Implementation Plan

> **Refinement (added during improve-plan):** The original plan ordered the phases as Diagnostic → Root-cause fix → Defensive hardening → Verification. The improved recommendation is to **reorder Phase 3 ahead of Phase 1** — implement the defensive render hardening FIRST, since it eliminates the visible symptom regardless of root cause and is low-risk (reuses existing patterns). Then run the diagnostic only if the symptom persists after hardening. This is a recommendation, not a requirement — the user may prefer to confirm root cause first (see ## User Review Required).

### Phase 1 — Diagnostic (confirm trigger + identify the writer)

Goal: Confirm `ticketFileChanged` is the trigger, capture what is changing in the body, and identify the writer. Temporary, removed before commit.

1. **Backend instrumentation** in `_setupTicketsViewWatcher`'s `handleTicketFileEvent` (`PlanningPanelProvider.ts:6992`): before posting `ticketFileChanged`, log to the Output channel (`switchboard`): file path, event type (create/change/delete), file mtime, and a short hash (e.g. first 8 chars of a djb2 hash of the stripped body). This reveals whether the body content actually differs across events and at what cadence.
2. **Webview instrumentation** in the `ticketFileChanged` handler (`planning.js:3501`): `console.log` the changed id, whether it is the selected ticket, and whether the new `renderedDescriptionHtml` equals the previous one.
3. **Webview instrumentation** in `renderTicketsClickUpTaskDetail` (`planning.js:7336`): `console.log` whether `contentHtml` differed from `_lastTicketsClickUpDetailContentHtml` (i.e., whether the guard let the write through).
4. **Reproduce:** Open the Tickets tab, select the offending ClickUp ticket, watch the Output channel + webview dev console for ~30s. Capture: cadence, whether body hash changes, and the diff between consecutive bodies (log the first differing line).

> **Added during improve-plan:** Also instrument the following:
> - **Auto-sync watcher check:** Log whether `ticketsAutoSync` is enabled at startup (`localService.getTicketsAutoSync()`). If disabled, the `_updateTicketsAutoSyncWatcher` is not active and can be eliminated as a suspect.
> - **Auto-sync watcher instrumentation:** In the `_updateTicketsAutoSyncWatcher` debounce callback (`PlanningPanelProvider.ts:7048`), log when `pushTicketEdits` is triggered and whether it succeeds. If it succeeds, log whether `hostInlineImages` wrote back to the file (check `replacements.length`).
> - **`ticketSyncStatusesLoaded` instrumentation:** In the webview handler (`planning.js:3392`), `console.log` when `ticketSyncStatusesLoaded` fires and calls `renderTicketsTab()`. This reveals whether the auto-sync → push → sync-status cascade is contributing to renders.

**Exit criterion:** Either (a) identify the exact writer path from the cadence/diff, or (b) confirm the body hash is actually stable and the redraw comes from elsewhere (which would invalidate the root-cause hypothesis and redirect the plan).

### Phase 2 — Root-cause fix (stop the repeated writes)

The specific fix depends on Phase 1's finding. The most likely outcomes and their fixes:

- **If a re-import/re-write loop is found** (e.g., a watcher triggers `importTaskAsDocument` or `saveLocalTicketFile` on the selected ticket repeatedly): break the loop by suppressing the write when the in-memory content matches the on-disk content, or by excluding self-writes from the watcher (track a short "ignore next event" window around extension-initiated writes).
- **If the body diff is trivial/noise** (e.g., a trailing-whitespace or timestamp line injected by some path): normalize the body before hashing/comparison (strip trailing whitespace per line, drop volatile lines) so the cache guard treats it as unchanged.
- **If spurious watcher events with identical body** (body hash stable but events still fire): the Phase 3 render-hash guard alone fixes the visible symptom.
- **If `hostInlineImages` writeback is the writer** (added during improve-plan): The writeback at `ImageHostingHelper.ts:109` fires when inline images are uploaded during `pushTicketEdits`. Since this is a one-shot per push (second pass has no replacements), the fix is either (a) accept the self-terminating cascade if it's only 2 iterations, or (b) add a short "ignore next event" window in the view watcher around `pushTicketEdits`-initiated writes, or (c) suppress the view watcher for files being actively pushed by the auto-sync watcher.

### Phase 3 — Defensive render hardening (applies regardless of Phase 2)

> **Refinement (added during improve-plan):** This phase is recommended to be executed FIRST (before Phase 1), as it eliminates the visible symptom regardless of root cause. See the note at the top of ## Implementation Plan.

These make the detail pane resilient to churn and are worth doing even after Phase 2:

1. **Add a rendered-HTML equality guard in the `ticketFileChanged` handler** (`planning.js:3507`): before calling `renderTicketsTab()`, compare the newly rendered HTML to `selectedClickUpIssue.renderedDescriptionHtml`. If equal, skip the `renderTicketsTab()` call entirely (avoids all unguarded sub-renders and the function-call overhead). Apply symmetrically to the Linear branch.
2. **Guard the unguarded DOM writes** in `renderTicketsClickUpTaskDetail`:
   - `statusSelect.innerHTML` (`:7380`): build the options string, compare to a `_lastTicketsClickUpStatusSelectHtml` cache, only assign on diff.
   - `subtasksNav.innerHTML` (`:7401`): same pattern with a `_lastTicketsClickUpSubtasksNavHtml` cache.
   - `renderTicketTags` (`:7358`): add an internal equality guard (compare tags array by id+name, plus provider) so it no-ops when unchanged. Must handle the empty-to-non-empty and non-empty-to-empty transitions.
   - Mirror these guards in `renderTicketsLinearTaskDetail` (`:6865`) for parity. Note: Linear has TWO `statusSelect.innerHTML` writes (`:6907` and `:6923`) — both need the same cache guard.
3. **Coalesce rapid renders:** wrap the `renderTicketsTab()` call from `ticketFileChanged` in a short microtask/`requestAnimationFrame` coalesce so that back-to-back file events within the same frame produce a single render pass rather than N.

### Phase 4 — Verification

> **Refinement (added during improve-plan):** Per session directives, compilation (`npm run compile`) and automated tests are SKIPPED. The test suite will be run separately by the user. See ## Verification Plan above for the full manual verification steps.

1. ~~`npm run compile` (webpack)~~ — **SKIPPED per session directive.**
2. Open the Tickets tab, select the offending ClickUp ticket, leave it idle for 60s. Confirm: no visible redraw, no line-length oscillation, dev console shows no `detailContent.innerHTML` writes after the initial render.
3. Edit the ticket's `.md` on disk externally (append a line, save). Confirm the preview DOES update (legitimate change still refreshes).
4. Repeat for a Linear ticket (parity check).
5. Enter Edit mode, confirm editing still works and the preview reflects saves.
6. ~~Run any existing ticket-related tests: `src/test/planning-*.test.js`.~~ — **SKIPPED per session directive.**

## Risks

- **False negative in Phase 1:** If the body hash turns out stable, the root-cause hypothesis is wrong and Phase 2 redirects. Phase 3 still hardens the render path and likely fixes the visible symptom on its own.
- **Over-suppression:** The Phase 3 equality guard + coalesce must not drop legitimate rapid edits (e.g., a user pasting a large block that triggers multiple watcher events). Mitigation: the guard compares rendered HTML, not raw events, so a real content change always passes; coalesce uses a single rAF, not a long debounce.
- **Cache-guard string growth:** The new `_lastTickets*Html` caches are small strings held in module scope; negligible memory. Reset them in `resetTicketsInMemoryState` (`planning.js:7657`) alongside the existing resets.
- **Masking root cause by reordering Phase 3 first** (added during improve-plan): If Phase 3 eliminates the visible symptom, the user may lose motivation to run Phase 1 diagnostics, leaving the root-cause writer active (wasting CPU on unnecessary file writes + API pushes). Mitigation: the auto-sync watcher's `pushTicketEdits` still fires on every file change regardless of render hardening — if the writer is active, the user will see unnecessary API pushes in the Output channel, providing a secondary signal that the root cause persists.

## Out of Scope

- Redesigning the file-watcher architecture (the create/change/delete-all-events design is intentional for atomic writes — see comment at `PlanningPanelProvider.ts:6987`).
- Changes to `renderMarkdown` (it is correct and deterministic).
- Any UI/UX changes to the Tickets tab layout.

---

**Recommendation:** Complexity 4 → **Send to Coder.** The permanent changes are confined to `src/webview/planning.js` (one file), reusing the existing equality-guard pattern already proven in the codebase. The diagnostic phase (Phase 1) is temporary and straightforward. The `renderTicketTags` guard has one moderate edge case (display-state transition) but is well-scoped. A coder can execute this plan with the reordered phases (Phase 3 first, Phase 1 only if needed).

---

## Reviewer Pass — Completed 2026-06-20

### Implementation Status

**Phase 3 (Defensive render hardening):** IMPLEMENTED. All permanent changes are in `src/webview/planning.js`.
- Early-exit equality guard in `ticketFileChanged` handler (`:3529-3546`): compares `renderedDescriptionHtml` before calling `renderTicketsTab()`. ✓
- `statusSelect.innerHTML` guard in `renderTicketsClickUpTaskDetail` (`:7456-7459`): `_lastTicketsClickUpStatusSelectHtml` cache. ✓
- `subtasksNav.innerHTML` guard in `renderTicketsClickUpTaskDetail` (`:7478-7481`): `_lastTicketsClickUpSubtasksNavHtml` cache. ✓
- `renderTicketTags` guard (`:283-285`): `_lastTicketsTagsKey` + `_lastTicketsTagsProvider` cache. ✓
- Linear parity: `statusSelect.innerHTML` guard (`:6963-6966`), `subtasksNav.innerHTML` guard (`:7004-7007`). ✓ (Linear's two status writes were consolidated into one guarded write — better than plan specified.)
- All 6 new cache variables reset in `resetTicketsInMemoryState` (`:7794-7799`). ✓

**Phase 1 (Diagnostic):** NOT IMPLEMENTED — acceptable per reordered plan (Phase 3 first, Phase 1 only if symptom persists).

**Phase 2 (Root-cause fix):** NOT IMPLEMENTED — acceptable per plan (conditional on Phase 1 findings).

**Phase 3 Step 6 (rAF coalesce):** NOT IMPLEMENTED — plan marks as "(optional, secondary)". Acceptable.

### Reviewer Findings (Grumpy → Balanced)

| # | Severity | File:Line | Finding | Disposition |
|---|----------|-----------|---------|-------------|
| 1 | NIT | `planning.js:291` | `renderTicketTags` set `container.style.display='flex'` unconditionally before empty-tags check, then set `'none'` — redundant style write | **Fixed** — moved `display='flex'` after empty check |
| 2 | NIT | `planning.js:3528,3548` | `ticketFileChanged` called `renderMarkdown()` twice with identical input when changed ticket was current; cache overwrite broke object identity with `selectedClickUpIssue` | **Fixed** — skip cache update block when ticket is current (cache already handled above) |
| 3 | NIT | `planning.js:6952-6960,6976-6981` | Linear fallback `stateMap` constructed twice (once for HTML, once for `.value`) | **Deferred** — fallback path, minor, consolidating hurts readability |
| 4 | NIT | N/A | rAF coalesce (Phase 3 step 6) not implemented | **Deferred** — plan explicitly marks optional |

### Fixes Applied by Reviewer

1. **`renderTicketTags` (`planning.js:290-297`):** Moved `container.style.display = 'flex'` after the empty-tags early-return. Empty-tags path now sets `display='none'` directly without a redundant `'flex'` write first.
2. **`ticketFileChanged` handler (`planning.js:3548-3570`):** Wrapped the "always update cache" block in `if (!isCurrentClickUp && !isCurrentLinear)` guard. When the changed ticket IS the current selected one, the cache was already updated at `:3534`/`:3540` (if `hasChanged`) or doesn't need updating (content identical). This eliminates the double `renderMarkdown` call and the object-identity divergence between `selectedClickUpIssue` and the cache entry.

### Verification

Per session directives: **compilation skipped** (`npm run compile` / webpack), **automated tests skipped**. Verification is manual-only (see ## Verification Plan above). The test suite will be run separately by the user.

**Static verification performed:**
- Confirmed all 6 new cache variables declared at module scope (`:213-218`) and reset in `resetTicketsInMemoryState` (`:7794-7799`). ✓
- Confirmed body normalization is consistent between `localTicketFileRead` (`:3489`) and `ticketFileChanged` (`:3527`) — both strip H1 + trim. ✓
- Confirmed `localDescription` guard in `clickupTaskDetailsLoaded` (`:4119-4127`) is preserved. ✓
- Confirmed no leftover Phase 1 diagnostic instrumentation in `PlanningPanelProvider.ts` or `planning.js`. ✓
- Confirmed `renderTicketTags` guard handles empty→non-empty, non-empty→empty, and provider-switch transitions correctly. ✓
- Confirmed no confirm dialogs added (project rule respected). ✓
- Confirmed `ImageHostingHelper.ts` unchanged (Phase 2 not needed). ✓

### Remaining Risks

1. **Root cause not confirmed:** Phase 1 diagnostics were not run. If the oscillation persists after Phase 3 hardening, Phase 1 should be executed to identify the actual writer of the `.md` file. The auto-sync watcher (`_updateTicketsAutoSyncWatcher`) and `hostInlineImages` writeback remain primary suspects.
2. **`ticketSyncStatusesLoaded` still triggers `renderTicketsTab()`:** When auto-sync is on, the `pushTicketResult` → `_requestTicketSyncStatuses()` → `ticketSyncStatusesLoaded` → `renderTicketsTab()` cascade still fires. The Phase 3 guards prevent the unguarded DOM writes from causing reflow, but the function call overhead remains. If this path contributes to residual oscillation, consider guarding it as well.
3. **rAF coalesce not implemented:** If rapid back-to-back file events cause multiple `renderTicketsTab()` calls within the same frame, the rAF coalesce (Phase 3 step 6) would batch them. Currently each event triggers a separate render pass (though the guards prevent unnecessary DOM writes).
4. **Linear fallback double `stateMap`:** Minor performance waste in a rarely-hit fallback path. No functional impact.
