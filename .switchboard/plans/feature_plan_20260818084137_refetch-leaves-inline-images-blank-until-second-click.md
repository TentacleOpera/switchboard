# Refetch Leaves Inline Images Blank Until Second Click — Refresh Detail Pane in importAllTicketsComplete

## Goal

Make a ticket's inline description images survive a **refetch** without requiring the user to click the ticket a second time. After the Refetch button completes and `importAllTicketsComplete` fires, the detail pane for the currently selected ticket must proactively re-read its local `.md` file and recreate its `<img>` nodes — not silently hold stale or broken content until the user manually re-selects the ticket.

### Problem (as reported)

> "after refetching tickets from remote that have images displayed inline, i still have to click the ticket in the sidebar a second time to get them to display. i thought we fixed this? is there a plan in plan reviewed that fixes this? this is an outstanding bug that multiple agents have not been able to fix for some reason"

### Related plans (do NOT duplicate — this plan complements them)

| Plan ID | Column | Title | Relationship |
|---------|--------|-------|--------------|
| `163e1a63-d264-4b89-b0f1-9b8058bcd59e` | PLAN REVIEWED | "Tickets Panel: Inline Images Are Blank On First View And Only Appear After Clicking Around" | Addresses the **general** image-load failure mechanism: no `onerror` handler (Link 1), render memo making dead nodes permanent (Link 2), and the local-vs-remote race (Link 3). Does NOT mention `importAllTicketsComplete` or the refetch-specific trigger. This plan fixes the refetch-specific gap that plan does not cover. |
| `07fe719e-713e-42e0-ba8a-be104b4e2d65` | CODE REVIEWED | "Refetching a ticket replaces its local inline image paths with remote URLs that don't render" | Addresses CDN URL replacement at import time by persisting a local→CDN mapping and reversing it on import. Landed and working — the `.md` files now retain local paths after refetch. But the **display layer** still breaks: the detail pane is not refreshed after refetch, and when it IS refreshed (via file watcher), the render memo can prevent fresh `<img>` nodes from being created. |
| `378b8d3b-58f5-4fce-83b4-bb5982999494` | PLAN REVIEWED | "Tickets Panel — Stale Checklists and Blank Inline Images" | Feature grouping that bundles several inline-image subtasks. |

**Answer to the user's question**: Yes, there IS a plan in PLAN REVIEWED (`163e1a63`) that addresses the general image-blank mechanism. But it does not cover the refetch-specific trigger — the `importAllTicketsComplete` handler's failure to refresh the detail pane. That gap is what this plan closes.

### Root cause — two gaps, one trigger

**Gap 1 — `importAllTicketsComplete` does not refresh the detail pane.**

The Refetch button handler (`src/webview/tickets.js:5059-5082`) clears both detail caches (`linearIssueDetailCache.clear()`, `clickUpTaskDetailCache.clear()`) and posts `refreshTicketsDelta` with `forceFull: true`. When the backend finishes, it posts `importAllTicketsComplete`. The handler (`tickets.js:8136-8163`) does:

```js
case 'importAllTicketsComplete':
    // … status toast …
    loadLocalTicketFiles();          // ← sidebar list only
    _requestTicketSyncStatuses();    // ← sync badges only
    break;                            // ← NO detail pane refresh
```

`loadLocalTicketFiles()` posts `listLocalTicketFiles` which re-renders the **sidebar**. The **detail pane** — the area that actually shows the ticket description with inline images — is not touched. It continues to display whatever `selectedLinearIssue` / `selectedClickUpIssue` held before the refetch.

The detail pane's only hope of refreshing is the file watcher: when the backend writes new `.md` files, the VS Code file system watcher fires `_emitTicketFileChanged` (`TicketsPanelProvider.ts:733-741`), which posts `ticketFileChanged` to the webview. But this path is **unreliable after a refetch**:

- **macOS FSEvents drops events under burst I/O** — acknowledged in the code at `TicketsPanelProvider.ts:778` ("macOS FSEvents can drop filenames under burst I/O"). A refetch writes N ticket files in rapid succession; the watcher may not fire for all of them, including the currently selected one.
- **The debounce collapses multiple events** — `_scheduleSidebarRefreshFromFiles` (`tickets.js:1406-1411`) debounces sidebar reloads to 300 ms, but the `ticketFileChanged` → `_applyTicketFilePayloadToSelected` path is not debounced; it fires per-event. However, if the event is dropped entirely (FSEvents), no path fires at all.
- **The native folder watch fallback** (`TicketsPanelProvider.ts:780-804`) exists but also relies on OS-level file events that can be dropped.

**Gap 2 — the render memo prevents fresh `<img>` nodes even when the content IS refreshed.**

Even when `ticketFileChanged` DOES fire for the selected ticket, the refresh can be silently skipped by two independent equality gates:

**Gate A — `_applyTicketFilePayloadToSelected`** (`tickets.js:6931-6968`):
```js
const rendered = renderMarkdown(previewMarkdown);
const prev = isClickUp ? selectedClickUpIssue : selectedLinearIssue;
const prevTitle = isClickUp ? prev?.task?.title : prev?.issue?.title;
const nextTitle = message.title || prevTitle;
if (rendered === prev?.renderedDescriptionHtml && nextTitle === prevTitle) return false;
```
After a refetch, if the `.md` file's description body is identical (the remote didn't change the text, and the `07fe719e` fix relocalised the image paths back to the same local paths), the `rendered` HTML is byte-identical to `prev?.renderedDescriptionHtml`. The function returns `false` → `renderTicketsTab()` is never called → the detail pane is not re-rendered.

The `&v=<mtime>` cache-bust token (`TicketsPanelProvider.ts:554`) is supposed to prevent this: it's derived from the **image file's** mtime, not the `.md` file's mtime. A refetch that doesn't re-download the images leaves the image mtime unchanged → same `&v=` → same `rendered` → Gate A blocks the refresh.

**Gate B — the detail render memo** (`tickets.js:3452-3455`):
```js
if (_lastTicketsDetailContentHtml !== contentHtml) {
    detailContent.innerHTML = contentHtml;
    _lastTicketsDetailContentHtml = contentHtml;
}
```
Even if `renderTicketsTab()` IS called, if the `contentHtml` string is identical to the memo, `innerHTML` is not rewritten and no fresh `<img>` nodes are created. This is the same memo identified in plan `163e1a63` (Link 2), but in the refetch context it has a different entry vector: the refetch doesn't change the content, but it DOES invalidate the assumption that the currently displayed `<img>` nodes are healthy — a transient during the refetch burst (loopback route busy, asset file momentarily locked) can kill an `<img>` node, and the memo then prevents its recreation.

**Why the second click works:**

When the user clicks the ticket a second time:
1. `cachedLinear = linearIssueDetailCache.get(linearId)` — the cache was repopulated by the first click's `linearLoadTaskDetails` response (which set `detailsFetched: true`), so `cachedLinear` exists.
2. `selectedLinearIssue = cachedLinear` — the cached snapshot is rendered instantly.
3. `readLocalTicketFile` fires unconditionally (`tickets.js:5591`).
4. `linearLoadTaskDetails` does NOT fire (`cachedLinear.detailsFetched` is true, `tickets.js:5593`).
5. The `localTicketFileRead` response arrives → `_applyTicketFilePayloadToSelected`:
   - `prev` is the cached snapshot from step 2, which has `renderedDescriptionHtml` from the **remote** payload (CDN URLs) if the first click's race was lost.
   - `rendered` is from the **local** file (loopback URLs).
   - `rendered !== prev?.renderedDescriptionHtml` (local ≠ remote) → returns `true` → `renderTicketsTab()` → `contentHtml` differs from memo → `innerHTML` rewritten → fresh `<img>` nodes → images load.

The second click works because the first click's race left `renderedDescriptionHtml` holding the **remote** HTML, and the second click's local read produces **different** HTML that bypasses both gates. The fix is to make the post-refetch refresh bypass both gates directly, without requiring a second click.

**Key code-flow distinction the fix relies on:**

The `localTicketFileRead` handler (`tickets.js:7878-7949`) calls `renderTicketsTab()` **unconditionally** at line 7948 — after the `if (_isSelectedTicketPayload) / else if` block, right before `break`. This is different from the `ticketFileChanged` handler (`tickets.js:7951-7961`), which calls `renderTicketsTab()` **conditionally** (only when `_applyTicketFilePayloadToSelected` returns true). The fix leverages the unconditional call in `localTicketFileRead`: clearing the memos is sufficient because the unconditional `renderTicketsTab()` will fire and Gate B will write to DOM (empty memo ≠ contentHtml).

## Metadata

> **Superseded:** **Complexity:** 4
> **Reason:** The original complexity score accounted for two changes (Proposed Change 1 + Proposed Change 2). The improve pass identified Proposed Change 2 as redundant (see Superseded callout below). With only Proposed Change 1 remaining — a 3-line addition to one message handler using existing functions — the complexity drops.
> **Replaced with:** **Complexity:** 3

**Complexity:** 3
**Tags:** frontend, ui, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

None. The change is a targeted addition to one message handler, with no backend changes, no new network calls, and no CSP edits.

## Complexity Audit

### Routine
- Adding a memo clear (`_lastTicketsDetailContentHtml = ''`, `_lastTicketsClickUpDetailContentHtml = ''`) and `_refreshSelectedTicketFromFile()` call to the `importAllTicketsComplete` handler — one handler, three lines of code, all within the same IIFE scope.
- The change uses existing functions (`_refreshSelectedTicketFromFile`) and existing variables (`_lastTicketsDetailContentHtml`, `_lastTicketsClickUpDetailContentHtml`).
- This is the same pattern already used in the edit-mode exit code (`tickets.js:3192-3199`): clear both memos, call `renderTicketsTab()`, call `_refreshSelectedTicketFromFile()`. Battle-tested precedent.

### Complex / Risky

> **Superseded:** The original Complex/Risky section listed three risks: (1) memo clearing causing flash of empty content, (2) forced re-render looping, (3) edit mode guard. Risks (1) and (2) were specific to Proposed Change 2, which has been superseded. Risk (3) remains valid.
> **Reason:** Proposed Change 2 (forced `renderTicketsTab()` in `localTicketFileRead`) was found redundant — see the Superseded callout in the Proposed Changes section. The risks associated with it no longer apply.
> **Replaced with:** The single remaining risk (edit mode guard) and one new observation about auto-sync frequency.

- **Edit mode guard.** The change must respect `ticketsEditMode` — the existing `_refreshSelectedTicketFromFile()` already early-returns in edit mode (`tickets.js:2999`). The memo clear is harmless in edit mode: the detail renderers (`renderTicketsLinearTaskDetail` at `:3459`, `renderTicketsClickUpTaskDetail` at `:3459`) early-return when `ticketsEditMode` is true, so the empty memo is never consulted until the user exits edit mode. When the user exits edit mode, the existing exit code (`:3192-3199`) already clears the memos and calls `_refreshSelectedTicketFromFile()`, so the memo clear from `importAllTicketsComplete` is redundant but harmless.
- **Auto-sync frequency.** The `importAllTicketsComplete` handler fires for both manual refetch and auto-sync (every ~45s). The memo clear + `_refreshSelectedTicketFromFile()` will fire for auto-sync too. This means every ~45s, the detail pane's memos are cleared and a `readLocalTicketFile` is posted. The next `renderTicketsTab()` call will write to DOM even if content is unchanged. This is a minor overhead — `innerHTML` re-parse — but is consistent with the existing behavior: `loadLocalTicketFiles()` already fires unconditionally for auto-sync, and the `localTicketFilesListed` response already calls `renderTicketsTab()` at line 7874. The additional DOM write from the `localTicketFileRead` path is one extra re-parse per auto-sync cycle, on the selected ticket only. Not a performance concern.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Expected behaviour |
| --- | --- |
| Refetch completes while the user is viewing the selected ticket | `importAllTicketsComplete` clears memos and posts `readLocalTicketFile`. Two async responses arrive: `localTicketFilesListed` (from `loadLocalTicketFiles`) calls `renderTicketsTab()` at line 7874 → Gate B: empty memo ≠ contentHtml → DOM write → fresh `<img>` nodes from current `selectedLinearIssue` content. Then `localTicketFileRead` arrives → `_applyTicketFilePayloadToSelected` updates `selectedLinearIssue` with local file content → `renderTicketsTab()` at line 7948 (unconditional) → Gate B: if content changed, another DOM write with new content; if identical, memo already set from the first render, no write needed (nodes are already fresh). Images load without a second click. |
| Refetch completes while the user is in edit mode | `_refreshSelectedTicketFromFile()` early-returns (`ticketsEditMode` guard at `:2999`). The memos are cleared but the detail renderers early-return in edit mode (`:3459`). When the user exits edit mode, the existing exit code (`:3192-3199`) clears the memos and calls `_refreshSelectedTicketFromFile()` — the memo clear from `importAllTicketsComplete` is redundant but harmless. No conflict. |
| `localTicketFileRead` arrives with `success: false` (not-imported) | The handler breaks early (`tickets.js:7888-7893`). The memos remain cleared. The `localTicketFilesListed` response (from `loadLocalTicketFiles`) still calls `renderTicketsTab()` at line 7874 → Gate B: empty memo ≠ contentHtml → DOM write → fresh `<img>` nodes from current `selectedLinearIssue` content. If the content has broken images, they remain broken — but this is the same behaviour as today, and the `163e1a63` plan's `onerror` retry is what fixes that case. |
| `ticketFileChanged` fires for the selected ticket between the memo clear and the `localTicketFileRead` response | `ticketFileChanged` → `_applyTicketFilePayloadToSelected` → if content changed, returns true → `renderTicketsTab()` (conditional at line 7960) → memos are empty → `innerHTML` rewritten → fresh nodes. If content identical, returns false → no re-render. Then `localTicketFileRead` arrives → `_applyTicketFilePayloadToSelected` → same content → returns false. But `renderTicketsTab()` fires unconditionally at line 7948 → Gate B: if memo was set by the `ticketFileChanged` render, contentHtml matches → no write (nodes already fresh). If memo is still empty (no `ticketFileChanged` fired), contentHtml ≠ empty memo → DOM write → fresh nodes. Both paths produce fresh nodes. |
| No ticket is selected when refetch completes | `_refreshSelectedTicketFromFile()` checks `selectedLinearIssue?.issue?.id` / `selectedClickUpIssue?.task?.id` and does nothing if falsy (`:3000-3004`). Memos are cleared harmlessly. |
| Refetch changes the ticket content (remote description updated) | `localTicketFileRead` → `_applyTicketFilePayloadToSelected` → `rendered !== prev` → returns true → `renderTicketsTab()` at line 7948 → fresh nodes with new content. The memo clear ensured Gate B would have written even if content was identical, but in this case Gate A also passes. |

### Security
- No new network calls, no new URLs, no new user-controlled strings reaching `src`.
- The memo clear only affects when `innerHTML` is written, not what is written. The content still comes from `selectedLinearIssue.renderedDescriptionHtml`, which is built from the same `renderMarkdown` + `_rewriteLocalImagePaths` pipeline as today.

### Side Effects

| Case | Expected behaviour |
| --- | --- |
| Sidebar reload from `loadLocalTicketFiles` triggers `renderTicketsTab` before `localTicketFileRead` arrives | `localTicketFilesListed` → `renderTicketsTab()` at line 7874 → Gate B: memo is empty → `innerHTML` rewritten → fresh `<img>` nodes from current `selectedLinearIssue` content. If the current content has working image URLs, the images load immediately. If the URLs are stale, the `localTicketFileRead` response will update the content and trigger another re-render at line 7948. Either way, the user sees fresh nodes, not stale dead ones. |
| Multiple refetches in rapid succession | Each `importAllTicketsComplete` clears the memos and posts `readLocalTicketFile`. Multiple in-flight reads for the same ticket are harmless — the last response wins, and each response's unconditional `renderTicketsTab()` will write to DOM if the memo is still empty, or skip if a prior render already set it. |
| Standalone / browser cockpit host | Same `tickets.js` runs there. No CSP change needed — the existing CSP already allows the loopback origins and `https:`. The `importAllTicketsComplete` handler is identical in both hosts. |

### Dependencies & Conflicts
- **No backend changes.** This plan is entirely frontend (`src/webview/tickets.js`).
- **Complements plan `163e1a63`** (PLAN REVIEWED): that plan adds `onerror` retry and fixes the local-vs-remote race. This plan fixes the refetch trigger that causes the race to be lost. Both can ship independently; together they close the full loop.
- **Complements plan `07fe719e`** (CODE REVIEWED): that plan relocalises CDN URLs back to local paths at import time. This plan ensures the relocalised paths are actually rendered after a refetch.
- **Shares `src/webview/tickets.js`** with many other plans. The single edit site (`importAllTicketsComplete` handler at `:8136`) is in the message switch, which is a high-traffic area. The change is additive (3 new lines before `break`, no modifications to existing lines) and does not alter the control flow of adjacent cases.

## Dependencies

- `163e1a63-d264-4b89-b0f1-9b8058bcd59e` — "Tickets Panel: Inline Images Are Blank On First View And Only Appear After Clicking Around" (complementary, not blocking)
- `07fe719e-713e-42e0-ba8a-be104b4e2d65` — "Refetching a ticket replaces its local inline image paths with remote URLs that don't render" (landed, complementary)

## Adversarial Synthesis

Key risks: (1) memo clear on every auto-sync cycle causes one extra DOM re-parse per ~45s on the selected ticket — minor, consistent with existing sidebar reload behavior. (2) If `_refreshSelectedTicketFromFile()` is a no-op (no selection or edit mode), the memos are cleared but never written until the next render trigger — harmless, the edit-mode exit code re-clears and re-renders. Mitigations: the change mirrors the battle-tested edit-mode exit pattern (`:3192-3199`); the unconditional `renderTicketsTab()` at line 7948 ensures the memo clear always results in a DOM write when the `localTicketFileRead` response arrives.

## Proposed Changes

### `src/webview/tickets.js` — refresh the detail pane after refetch (`importAllTicketsComplete` handler, line 8162)

After the existing `loadLocalTicketFiles()` and `_requestTicketSyncStatuses()` calls, add a forced detail pane refresh:

```js
            case 'importAllTicketsComplete':
                if (!_isForThisPanel(message)) { break; }
                setTicketsLoadingState(false);
                isImportingAll = false;
                {
                    // … existing status toast code (unchanged) …
                }
                // Re-render sidebar from local files so newly imported tickets appear.
                loadLocalTicketFiles();
                _requestTicketSyncStatuses();
                // ── NEW: force-refresh the detail pane for the currently selected ticket ──
                // The refetch wrote new .md files, but the detail pane still shows
                // pre-refetch content. The file watcher may fire ticketFileChanged for
                // the selected ticket, but (a) macOS FSEvents can drop events under
                // burst I/O, and (b) even if it fires, the equality gate in
                // _applyTicketFilePayloadToSelected returns false when the rendered
                // HTML is byte-identical (same description, same image paths, same
                // &v= token because the image files didn't change). Clearing both
                // render memos ensures the next renderTicketsTab() actually writes
                // to the DOM, creating fresh <img> nodes. The _refreshSelectedTicket
                // FromFile() call posts readLocalTicketFile, whose response updates
                // the selected ticket's content. The localTicketFileRead handler
                // calls renderTicketsTab() unconditionally (line 7948), so Gate B
                // will see the empty memo and write to DOM. This is the same pattern
                // as the edit-mode exit code at lines 3192-3199.
                _lastTicketsDetailContentHtml = '';
                _lastTicketsClickUpDetailContentHtml = '';
                _refreshSelectedTicketFromFile();
                break;
```

### `src/webview/tickets.js` — force re-render when memos are empty (`localTicketFileRead` handler, ~line 7896)

> **Superseded:** The original plan proposed adding a `const _changed = _applyTicketFilePayloadToSelected(message);` capture and a conditional `if (!_changed && (_lastTicketsDetailContentHtml === '' || _lastTicketsClickUpDetailContentHtml === '')) { renderTicketsTab(); }` inside the `if (_isSelectedTicketPayload(message))` block.
>
> **Reason:** The `localTicketFileRead` handler already calls `renderTicketsTab()` **unconditionally** at line 7948 — after the `if (_isSelectedTicketPayload) / else if` block, right before `break`. The plan confused this handler with the `ticketFileChanged` handler (line 7959), which calls `renderTicketsTab()` conditionally (only when `_applyTicketFilePayloadToSelected` returns true). In `localTicketFileRead`, `renderTicketsTab()` fires regardless of the applier's return value. With memos cleared by Proposed Change 1, Gate B sees empty memo ≠ contentHtml → writes to DOM → fresh `<img>` nodes. The conditional `renderTicketsTab()` is redundant.
>
> Additionally, the plan's code block showed `clearTicketsStatus(); break;` at the end of the case — without the unconditional `renderTicketsTab()` at line 7948. If implemented literally, this would remove the unconditional render call, breaking the first-selection case (where `_isSelectedTicketPayload` is false, the `else if` branch builds the selection, but `renderTicketsTab()` is never called to display it).
>
> **Replaced with:** No change to the `localTicketFileRead` handler. The existing unconditional `renderTicketsTab()` at line 7948 is sufficient. Proposed Change 1 alone closes the gap.

### Why the single change is sufficient

> **Superseded:** The original "Why both changes are needed together" section argued that memo clear alone is insufficient (`_applyTicketFilePayloadToSelected` returns false → `renderTicketsTab()` is never called) and forced re-render alone is insufficient (without clearing the memo, `renderTicketsTab()` would skip the `innerHTML` write).
>
> **Reason:** The claim that "`renderTicketsTab()` is never called" is false for the `localTicketFileRead` path. Line 7948 calls it unconditionally. The plan confused `localTicketFileRead` (unconditional render) with `ticketFileChanged` (conditional render at line 7959).
>
> **Replaced with:** The single change (memo clear + `_refreshSelectedTicketFromFile()`) is sufficient because:

- **Memo clear** ensures Gate B will write to DOM: `_lastTicketsDetailContentHtml` is set to `''`, so the next `renderTicketsTab()` call sees `'' !== contentHtml` → `innerHTML` rewritten → fresh `<img>` nodes.
- **`_refreshSelectedTicketFromFile()`** posts `readLocalTicketFile`, whose response triggers the `localTicketFileRead` handler. That handler calls `renderTicketsTab()` **unconditionally** at line 7948. Gate B fires with the empty memo → DOM write.
- **Additionally**, `loadLocalTicketFiles()` (already called in the handler) posts `listLocalTicketFiles`, whose `localTicketFilesListed` response also calls `renderTicketsTab()` unconditionally at line 7874. This provides a first DOM write with the current `selectedLinearIssue` content (fresh `<img>` nodes) even before the `localTicketFileRead` response arrives.
- **If the `localTicketFileRead` response has identical content** (Gate A returns false), the unconditional `renderTicketsTab()` at line 7948 still fires. Gate B either writes (if memo is still empty from the clear) or skips (if the `localTicketFilesListed` render already set it). Either way, the nodes are fresh.

## Verification Plan

### Manual reproduction

1. Select a Linear or ClickUp ticket that has inline images in its description. Confirm the images render.
2. Click the **Refetch** button (full pull, not delta refresh).
3. Wait for the "Imported N tickets" toast.
4. **Without clicking the ticket again**, verify the inline images are still visible in the detail pane.
5. If the images disappeared and reappeared after a second click, the bug is not fixed.

### Automated test (grep-based assertion, scoped to `src/webview/tickets.js`)

```js
// Verify the importAllTicketsComplete handler clears both detail render memos
// and calls _refreshSelectedTicketFromFile after loadLocalTicketFiles.
const ticketsJs = fs.readFileSync('src/webview/tickets.js', 'utf8');

// The handler must clear both memos and call _refreshSelectedTicketFromFile.
assert(ticketsJs.includes("_lastTicketsDetailContentHtml = '';\n                _lastTicketsClickUpDetailContentHtml = '';\n                _refreshSelectedTicketFromFile();"),
    'importAllTicketsComplete must clear both detail memos and call _refreshSelectedTicketFromFile');

// CRITICAL: scope to tickets.js only — planning.js has a dead copy of these renderers.
// A grep across src/webview/ would false-pass on the dead planning.js copy.
```

### Regression checks

- **Edit mode**: Enter edit mode on a ticket, then trigger a refetch (from another panel or via auto-sync). Confirm the detail pane is not clobbered — `_refreshSelectedTicketFromFile()` early-returns in edit mode, and the detail renderers early-return when `ticketsEditMode` is true.
- **No selection**: Deselect all tickets (if possible) or switch to a provider with no tickets. Trigger a refetch. Confirm no error — `_refreshSelectedTicketFromFile()` checks for a selected ticket before posting.
- **Delta refresh (not full refetch)**: Click the **Refresh** button (delta, not refetch). The `importAllTicketsComplete` handler fires for both. Confirm the detail pane refreshes correctly — the memo clear and `_refreshSelectedTicketFromFile()` are harmless when the content hasn't changed.
- **Rapid refetch**: Click Refetch twice in quick succession. Confirm no infinite loop or visual thrash — each `importAllTicketsComplete` clears the memos once, and the unconditional `renderTicketsTab()` sets the memo, so subsequent identical-content events skip Gate B.
- **First selection after refetch**: After a refetch completes, click a ticket in the sidebar that you haven't viewed yet this session. Confirm the detail pane renders correctly — the `localTicketFileRead` handler's `else if (!ticketsEditMode)` branch builds the selection and the unconditional `renderTicketsTab()` at line 7948 renders it. (This regression check guards against the superseded Proposed Change 2, which would have broken this path.)
