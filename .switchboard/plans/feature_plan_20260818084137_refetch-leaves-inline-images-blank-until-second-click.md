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

The Refetch button handler (`src/webview/tickets.js:5044-5057`) clears both detail caches (`linearIssueDetailCache.clear()`, `clickUpTaskDetailCache.clear()`) and posts `refreshTicketsDelta` with `forceFull: true`. When the backend finishes, it posts `importAllTicketsComplete`. The handler (`tickets.js:8091-8118`) does:

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
- **The native folder watch fallback** (`TicketsPanelProvider.ts:704-709`) exists but also relies on OS-level file events that can be dropped.

**Gap 2 — the render memo prevents fresh `<img>` nodes even when the content IS refreshed.**

Even when `ticketFileChanged` DOES fire for the selected ticket, the refresh can be silently skipped by two independent equality gates:

**Gate A — `_applyTicketFilePayloadToSelected`** (`tickets.js:6894-6901`):
```js
const rendered = renderMarkdown(previewMarkdown);
const prev = isClickUp ? selectedClickUpIssue : selectedLinearIssue;
if (rendered === prev?.renderedDescriptionHtml && nextTitle === prevTitle) return false;
```
After a refetch, if the `.md` file's description body is identical (the remote didn't change the text, and the `07fe719e` fix relocalised the image paths back to the same local paths), the `rendered` HTML is byte-identical to `prev?.renderedDescriptionHtml`. The function returns `false` → `renderTicketsTab()` is never called → the detail pane is not re-rendered.

The `&v=<mtime>` cache-bust token (`TicketsPanelProvider.ts:546-555`) is supposed to prevent this: it's derived from the **image file's** mtime, not the `.md` file's mtime. A refetch that doesn't re-download the images leaves the image mtime unchanged → same `&v=` → same `rendered` → Gate A blocks the refresh.

**Gate B — the detail render memo** (`tickets.js:3407-3410`):
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

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

None. The change is a targeted addition to one message handler and one response arm, with no backend changes, no new network calls, and no CSP edits.

## Complexity Audit

### Routine
- Adding a `_refreshSelectedTicketFromFile()` call and memo reset to the `importAllTicketsComplete` handler — one handler, three lines of code, all within the same IIFE scope.
- Adding a forced `renderTicketsTab()` call in the `localTicketFileRead` handler when the memos are empty — one conditional, same scope.
- Both changes use existing functions (`_refreshSelectedTicketFromFile`, `renderTicketsTab`) and existing variables (`_lastTicketsDetailContentHtml`, `_lastTicketsClickUpDetailContentHtml`).

### Complex / Risky
- **Memo clearing must not cause a flash of empty content.** Clearing the memos without immediately re-rendering could leave the detail pane blank if `renderTicketsTab()` is called by another code path (e.g. `localTicketFilesListed` from `loadLocalTicketFiles`) before the `localTicketFileRead` response arrives. The fix must either (a) clear the memos only after the `localTicketFileRead` response arrives, or (b) ensure `renderTicketsTab()` between the memo clear and the response still shows the current content (which it does — `selectedLinearIssue.renderedDescriptionHtml` is not cleared, only the memo is). Approach (b) is safe: the memo clear means "next render writes to DOM", but the content comes from `selectedLinearIssue` which is unchanged.
- **The forced re-render must not loop.** If `renderTicketsTab()` is called and the memo is set to the new `contentHtml`, a subsequent `ticketFileChanged` with identical content will skip (Gate A returns false, `renderTicketsTab()` is not called). No loop is possible.
- **Edit mode guard.** Both changes must respect `ticketsEditMode` — the existing `_refreshSelectedTicketFromFile()` already early-returns in edit mode (`tickets.js:2967`), and the `localTicketFileRead` handler already checks `_isSelectedTicketPayload` and `ticketsEditMode`.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Expected behaviour |
| --- | --- |
| Refetch completes while the user is viewing the selected ticket | `importAllTicketsComplete` clears memos and posts `readLocalTicketFile`. The `localTicketFileRead` response arrives and forces a full re-render with fresh `<img>` nodes. Images load without a second click. |
| Refetch completes while the user is in edit mode | `_refreshSelectedTicketFromFile()` early-returns (`ticketsEditMode` guard at `:2967`). The memos are cleared but `renderTicketsTab()` is not called (edit-mode guard in renderers at `:3304`/`:3414`). When the user exits edit mode, the memos are already cleared (`:3147-3148`) so the next render writes to DOM. No conflict. |
| `localTicketFileRead` arrives with `success: false` (not-imported) | The handler breaks early (`tickets.js:7843-7844`). The memos remain cleared. The next `renderTicketsTab()` call (from any trigger) will write to DOM with the current `selectedLinearIssue` content. If the content has broken images, they remain broken — but this is the same behaviour as today, and the `163e1a63` plan's `onerror` retry is what fixes that case. |
| `ticketFileChanged` fires for the selected ticket between the memo clear and the `localTicketFileRead` response | `ticketFileChanged` → `_applyTicketFilePayloadToSelected` → if content changed, returns true → `renderTicketsTab()` → memos are empty → `innerHTML` rewritten → fresh nodes. If content identical, returns false → no re-render. Then `localTicketFileRead` arrives → same content → `_applyTicketFilePayloadToSelected` returns false → but memos are still empty → forced `renderTicketsTab()` → `innerHTML` rewritten → fresh nodes. Both paths produce fresh nodes. |
| No ticket is selected when refetch completes | `_refreshSelectedTicketFromFile()` checks `selectedLinearIssue?.issue?.id` / `selectedClickUpIssue?.task?.id` and does nothing if falsy. Memos are cleared harmlessly. |
| Refetch changes the ticket content (remote description updated) | `localTicketFileRead` → `_applyTicketFilePayloadToSelected` → `rendered !== prev` → returns true → `renderTicketsTab()` → fresh nodes with new content. The forced re-render is redundant but harmless (memo is already set by the `renderTicketsTab()` call inside `_applyTicketFilePayloadToSelected`'s caller). |

### Security
- No new network calls, no new URLs, no new user-controlled strings reaching `src`.
- The memo clear only affects when `innerHTML` is written, not what is written. The content still comes from `selectedLinearIssue.renderedDescriptionHtml`, which is built from the same `renderMarkdown` + `_rewriteLocalImagePaths` pipeline as today.

### Side Effects

| Case | Expected behaviour |
| --- | --- |
| Sidebar reload from `loadLocalTicketFiles` triggers `renderTicketsTab` before `localTicketFileRead` arrives | `renderTicketsTab()` is called with the current (pre-refetch) `selectedLinearIssue` content. The memo is empty → `innerHTML` is rewritten → fresh `<img>` nodes from the current content. If the current content has working image URLs, the images load immediately. If the URLs are stale, the `localTicketFileRead` response will update the content and trigger another re-render. Either way, the user sees fresh nodes, not stale dead ones. |
| Multiple refetches in rapid succession | Each `importAllTicketsComplete` clears the memos and posts `readLocalTicketFile`. Multiple in-flight reads for the same ticket are harmless — the last response wins, and each response forces a re-render if the memos are still empty. |
| Standalone / browser cockpit host | Same `tickets.js` runs there. No CSP change needed — the existing CSP already allows the loopback origins and `https:`. The `importAllTicketsComplete` handler is identical in both hosts. |

### Dependencies & Conflicts
- **No backend changes.** This plan is entirely frontend (`src/webview/tickets.js`).
- **Complements plan `163e1a63`** (PLAN REVIEWED): that plan adds `onerror` retry and fixes the local-vs-remote race. This plan fixes the refetch trigger that causes the race to be lost. Both can ship independently; together they close the full loop.
- **Complements plan `07fe719e`** (CODE REVIEWED): that plan relocalises CDN URLs back to local paths at import time. This plan ensures the relocalised paths are actually rendered after a refetch.
- **Shares `src/webview/tickets.js`** with many other plans. The two edit sites (`importAllTicketsComplete` handler at `:8091`, `localTicketFileRead` handler at `:7833`) are in the message switch, which is a high-traffic area. The changes are additive (new lines, no modifications to existing lines) and do not alter the control flow of adjacent cases.

## Proposed Changes

### `src/webview/tickets.js` — refresh the detail pane after refetch (`importAllTicketsComplete` handler, ~line 8116)

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
                // the selected ticket's content and triggers renderTicketsTab().
                _lastTicketsDetailContentHtml = '';
                _lastTicketsClickUpDetailContentHtml = '';
                _refreshSelectedTicketFromFile();
                break;
```

### `src/webview/tickets.js` — force re-render when memos are empty (`localTicketFileRead` handler, ~line 7850)

After the existing `_applyTicketFilePayloadToSelected(message)` call, add a forced `renderTicketsTab()` when the memos are still empty (meaning a refetch cleared them but the content was identical so the applier returned false):

```js
            case 'localTicketFileRead': {
                if (!message.success) {
                    // … existing not-imported / failure handling (unchanged) …
                    break;
                }
                if (_isSelectedTicketPayload(message)) {
                    const _changed = _applyTicketFilePayloadToSelected(message);
                    // ── NEW: if the render memos were cleared (e.g. by importAllTicketsComplete)
                    // but the content is identical so the applier returned false, force a
                    // re-render anyway. The memos being empty means "the next render must
                    // write to DOM" — without this, the <img> nodes from before the refetch
                    // survive, and any that failed during the refetch burst stay dead. ──
                    if (!_changed && (_lastTicketsDetailContentHtml === '' || _lastTicketsClickUpDetailContentHtml === '')) {
                        renderTicketsTab();
                    }
                } else if (!ticketsEditMode) {
                    // … existing first-selection build code (unchanged) …
                }
                clearTicketsStatus();
                break;
            }
```

### Why both changes are needed together

- **Memo clear alone** is insufficient: `_applyTicketFilePayloadToSelected` returns false when content is identical → `renderTicketsTab()` is never called → the empty memo is never consulted → no DOM write.
- **Forced re-render alone** is insufficient: without clearing the memo, `renderTicketsTab()` would compare `contentHtml` to the non-empty memo → skip the `innerHTML` write → no fresh `<img>` nodes.
- **Together**: the memo clear ensures `renderTicketsTab()` will write to DOM, and the forced re-render ensures `renderTicketsTab()` is actually called.

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

// The handler must clear both memos.
assert(ticketsJs.includes("_lastTicketsDetailContentHtml = '';\n                _lastTicketsClickUpDetailContentHtml = '';\n                _refreshSelectedTicketFromFile();"),
    'importAllTicketsComplete must clear both detail memos and call _refreshSelectedTicketFromFile');

// The localTicketFileRead handler must force renderTicketsTab when memos are empty.
assert(ticketsJs.includes("if (!_changed && (_lastTicketsDetailContentHtml === '' || _lastTicketsClickUpDetailContentHtml === ''))"),
    'localTicketFileRead must force renderTicketsTab when memos are empty and content is unchanged');

// CRITICAL: scope to tickets.js only — planning.js has a dead copy of these renderers.
// A grep across src/webview/ would false-pass on the dead planning.js copy.
```

### Regression checks

- **Edit mode**: Enter edit mode on a ticket, then trigger a refetch (from another panel or via auto-sync). Confirm the detail pane is not clobbered — `_refreshSelectedTicketFromFile()` early-returns in edit mode.
- **No selection**: Deselect all tickets (if possible) or switch to a provider with no tickets. Trigger a refetch. Confirm no error — `_refreshSelectedTicketFromFile()` checks for a selected ticket before posting.
- **Delta refresh (not full refetch)**: Click the **Refresh** button (delta, not refetch). The `importAllTicketsComplete` handler fires for both. Confirm the detail pane refreshes correctly — the memo clear and forced re-render are harmless when the content hasn't changed.
- **Rapid refetch**: Click Refetch twice in quick succession. Confirm no infinite loop or visual thrash — each `importAllTicketsComplete` clears the memos once, and the forced re-render sets the memo, so subsequent identical-content events are skipped.
