# Tickets Panel: Inline Images Are Blank On First View And Only Appear After Clicking Around

<!-- board-collapse-audit -->
> **COUPLING 2026-09-04 (Board Collapse audit).** The one-shot image retry this plan adds changes an image's rendered height **after first paint**. That is precisely the moment the markdown editor's scroll synchronisation re-measures: *The Editor and the Preview Stay Level* pairs each source image with its preview element and re-measures on `load`, because an image's height is unknown until it loads and that is when the editor and preview columns diverge.
> 
> Whichever of the two lands second must make this retry trigger that re-measure, or a retried image leaves the two panes misaligned by its height for the rest of the session. Ticket previews with inline images are the common case for both plans. The scroll-sync plan carries the same note.
> 
> This card now sits in the **Tickets images** feature and lands first of its two.


## Goal

Make a ticket's inline description images render on the **first** view of that ticket in `tickets.html`, and make a failed image load recover by itself instead of requiring the user to click to another ticket and back.

### The problem (as reported)

> "when tickets are first fetched in tickets.html, you cannot see any images. you have to click around a bit for images to appear. THIS BUG KEEPS HAPPENING"

Two facts in that report are load-bearing and have been under-weighted by every previous attempt at this bug:

1. **The description text renders fine.** Only the images are missing. So the render did happen and the `<img>` elements are (or should be) in the DOM — this is not a "the pane never painted" bug, and fixes aimed at *when* the pane renders cannot fix it.
2. **Clicking *around* fixes it** — not clicking the same ticket again. Selecting a different ticket and coming back is what makes the images appear. That distinction is the whole diagnosis: something makes the *first* `<img>` load fail, and something else makes that failure **permanent until the pane's HTML string changes**.

Every prior fix in this area (`ticket-inline-images-never-resolve-to-downloaded-copies`, `auto-download-inline-ticket-images-on-import`, the `localResourceRoots` addition at `TicketsPanelProvider.ts:1133-1165`, the ClickUp host-suffix repair at `TaskViewerProvider.ts:25224-25240`) targeted **URL generation** — making the right URL come out of the host. Those landed and are working: `_relocalizeInlineImages`, the dual-key `_recordAttachment`, and `_hydrateTicketAssets` all exist at HEAD, and 28 of the 79 inline refs in the live tickets tree are now local `attachments/…` paths that were CDN URLs before. The symptom did not change, because **the symptom was never in URL generation**. It is in the webview's render + image-load layer, which no previous plan touched.

### Root cause — a three-link chain

**Link 1 — a failed `<img>` load is silent and never retried.**
`renderMarkdown` (`src/webview/sharedUtils.js:374-377`) emits a bare element:

```js
.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
    const safeUrl = escapeAttr(sanitizeUrl(url));
    return `<img src="${safeUrl}" alt="${escapeAttr(alt)}" style="max-width:100%;height:auto;display:block;margin:4px 0;">`;
})
```

There is **no `onerror` and no `error` listener anywhere in `src/webview/tickets.js`** (grep for `onerror` / `'error'` returns only status-string matches). A browser retries a failed image load exactly zero times. One bad response — a 403 from the loopback asset route, a 401 from a provider CDN, a connection refused because the API server was not listening yet — and that `<img>` is dead for the lifetime of the node. `design.js` already has this pattern right (`design.js:2193` `img.addEventListener('error', …)`, `design.js:2412` `previewImage.onerror`); the tickets panel never got it.

**Link 2 — the render memo makes the dead node permanent. This is the "click around" mechanism.**
Both detail renderers gate the DOM write on a module-level string memo:

- `renderTicketsLinearTaskDetail` — `src/webview/tickets.js:3407-3410`
  ```js
  if (_lastTicketsDetailContentHtml !== contentHtml) {
      detailContent.innerHTML = contentHtml;
      _lastTicketsDetailContentHtml = contentHtml;
  }
  ```
- `renderTicketsClickUpTaskDetail` — `src/webview/tickets.js:3517-3519` (identical shape, `_lastTicketsClickUpDetailContentHtml`)

Re-selecting the **same** ticket rebuilds a byte-identical `contentHtml`: same title, same rendered description, and the loopback URL's `&v=<mtimeMs>` cache-bust token (`TicketsPanelProvider.ts:553-555`) is stable while the image file is unchanged. Identical string ⇒ the `innerHTML =` is skipped ⇒ **the broken `<img>` nodes are never recreated** ⇒ no new network request ⇒ still blank.

Selecting a *different* ticket writes a different string and sets the memo to it; coming back then finds `contentHtml !== memo`, rewrites, and creates **fresh** `<img>` nodes that issue fresh requests — which succeed, because by then the transient is over. That is precisely, mechanically, "you have to click around a bit for images to appear." The memo is what converts a one-off transient into a bug the user hits on every fetch.

> **Clarification (improve pass — confirms Link 2, adds the second gate).** Re-selecting the *same* ticket does still post a fresh `readLocalTicketFile` (`tickets.js:5591`/`:5602` fire unconditionally), so one might expect the host round-trip alone to heal the pane. It does not, and the reason is a **second** identical-content gate one layer up: `_applyTicketFilePayloadToSelected` (`tickets.js:6901`) early-returns `false` when `rendered === prev?.renderedDescriptionHtml && nextTitle === prevTitle`. An unchanged image file ⇒ unchanged `&v=` ⇒ unchanged `rendered` ⇒ the applier reports "nothing changed" ⇒ `renderTicketsTab()` produces the same `contentHtml` ⇒ the memo at `:3407` skips the write. **Two** independent equality gates must both be bypassed for a same-ticket re-select to recreate the nodes, and neither knows the pane is currently displaying a failure. This is corroboration of the diagnosis, not a change to it.

> **Clarification (improve pass — a hypothesis that is now dead).** "The image file was still being written when the URL was minted, so the first GET served a partial file" is **not** a possible transient here. `_fetchAssetToDisk` writes to `${targetFilePath}.part` and `fs.renameSync`s into place (`TaskViewerProvider.ts:25051`, `:25073`) — an atomic publish — and the ticket `.md` is written *after* `_hydrateTicketAssets` completes (`TaskViewerProvider.ts:22545` → `:22558`). By the time the webview holds a ref, the asset is whole. Recording this so the next pass does not re-derive it.

**Link 3 — the first paint can legitimately carry unloadable remote URLs.**
Selecting a card fires **two** requests in parallel (`src/webview/tickets.js:5582-5605`):

```js
vscode.postMessage({ type: 'readLocalTicketFile', provider: 'linear', id: linearId, … });
if (!cachedLinear || !cachedLinear.detailsFetched) {
    vscode.postMessage({ type: 'linearLoadTaskDetails', issueId: linearId, … });
}
```

The local read wins that race *usually* — but it is not guaranteed. `readLocalTicketFile` awaits `this._findTicketFilePath(...)` (`TicketsPanelProvider.ts:2431`), a directory scan across every configured ticket folder, and the two handlers interleave because `onDidReceiveMessage` is `async`. The only thing that stops the API response from stomping the local description is `_keepLinearDesc = _prevLinear?.localDescription` (`tickets.js:7630`, `:7664`) — a flag that **only exists once the local read has already landed**. If `linearTaskDetailsLoaded` arrives first, `_keepLinearDesc` is `false`, and the pane paints `message.renderedDescriptionHtml` — the description rendered from the **remote** payload, whose image refs are raw provider CDN URLs.

Those URLs are not loadable from the webview: `uploads.linear.app` requires an `Authorization` header the webview cannot send, and much of ClickUp's asset surface is re-signed with a ~60-minute TTL. They fail → Link 1 leaves them dead → Link 2 keeps them dead. Right after a **fetch** is exactly when this race is most likely to be lost: the import pass has the ticket folders busy, so `_findTicketFilePath`'s scan is at its slowest.

Confirmed at HEAD: the remote details arm renders `issue.description` verbatim through `markdown.api.render` (`TicketsPanelProvider.ts:2496-2503`, ClickUp mirror at `:2562-2569`) and never calls `_rewriteLocalImagePaths`. Only the two *file-read* paths — `_readTicketFilePayload` (`:726`) and the shared-utility bundle (`:1271`) — relocalise. So "remote payload ⇒ CDN refs" is structural, not incidental.

**A fourth contributor, secondary but worth closing:** `_rewriteLocalImagePaths` (`TicketsPanelProvider.ts:558-585`) has **four silent `return match` bail-outs** — non-existent file (`:571`), path outside the asset allow-list *and* no live panel (`:574`), `asWebviewUri` returning falsy (`:576`), and the bare `catch` (`:581`). Each one hands the webview the **original** ref. When that original is a bare relative path such as `attachments/foo.png`, `sanitizeUrl` passes it through untouched (`sharedUtils.js:27-37` — no scheme, so it returns the string verbatim) and the webview resolves it against `vscode-webview://<panel-id>/` → 404, permanently, with no message in any log. There is no counter, no warning, and no way for the user or a reviewer to tell "this ref never resolved" from "this ref resolved and the load failed". That absence of signal is why this bug keeps getting declared fixed.

### Related but deliberately NOT the fix here

- `_buildLocalAssetUrl` (`TicketsPanelProvider.ts:529-556`) and the `GET /design/asset` route (`LocalApiServer.ts:964-1020`) both gate on `getTicketsAssetRoots`, but over **different root sets**: the provider uses `this._getWorkspaceRoots()`, the route uses `this._options.workspaceRoot` + `this._options.allRoots`. When those disagree the provider emits a loopback URL the route then 403s — and because `_rewriteLocalImagePaths` returns route 1's URL unconditionally when it is non-`undefined` (`:572-573`), the `asWebviewUri` fallback at `:575` is never reached. This plan makes that failure **visible and recoverable** (§4, §1) rather than re-plumbing the two allow-lists, which is a separate change with its own security surface.

> **Superseded:** The `_buildLocalAssetUrl` / `/design/asset` root-set divergence is deferred wholesale; this plan only makes the resulting failure visible.
> **Reason:** The divergence is two different problems wearing one label, and only one of them is safely deferrable. **(a) In the extension host** it is a narrow edge case — `getTicketsAssetRoots` is dominated by *global* `ticketSaveLocation` paths that are identical for every root, so the two lists differ only in the per-root `<root>/.switchboard/tickets` entry, and only when `allRoots` misses a folder. Deferring that is correct. **(b) In the standalone / browser-cockpit host it is a total, deterministic failure, not an edge case.** `_getWorkspaceRoots()` reads `vscode.workspace.workspaceFolders` directly, and the standalone shim hardcodes that to `[]` (`src/standalone/vscodeShim.ts:189`). So `_buildLocalAssetUrl`'s `allowed` array is empty ⇒ `isAllowed` is false for every asset ⇒ it returns `undefined` ⇒ `this._panel` is also undefined in standalone ⇒ bail-out #2 fires ⇒ **every** inline image reaches the cockpit as a bare `attachments/foo.png`, resolves against the cockpit origin, and 404s. Forever. No retry, no memo bypass, and no amount of logging fixes that. Shipping §1–§4 alone would ship a browser cockpit in which every ticket image is a dashed "failed to load" placeholder — a *more honest* total failure, which is not the goal. It is also a live violation of PRD contract #3 (providers reach the host only through `hostSeams.ts`) and contract #6 (no surface that is reachable but non-functional).
> **Replaced with:** Split the two. The extension-host root-set unification stays deferred, as originally scoped and for the original reason. The standalone root resolution is **pulled into this plan as §5** — a scoped helper that reads the existing `HostWorkspace` seam, which already returns the real folder list in the editor and falls back to the configured root under the shim (`hostSeams.ts:516-529`), and which `bootstrap.ts:666,703` already injects into this exact provider with the standalone workspace root. In the extension host the seam and `_getWorkspaceRoots()` return the identical list, so §5 is behaviour-preserving there (PRD contract #2).

### Where the duplicate renderers live (scope note, improve pass)

`src/webview/planning.js` still contains a **full copy** of these renderers — `renderTicketsLinearTaskDetail` (`:8268`), `renderTicketsClickUpTaskDetail` (`:8652`), both memos (`:551`, `:7624`, `:8751`), and four `readLocalTicketFile` post sites (`:1555`, `:1557`, `:8101`, `:8118`). **It is dead residue from the panel extraction and must NOT be edited.** Proof: `planning.html`'s tab strip is DOCS / HTML / RESEARCH / WEB AGENTS (`:3667-3670`) with no `data-tab="tickets"` button, so `isTicketsTabActive()` (`planning.js:1538`) can never return true there; and every tickets IPC arm in planning.js is a comment reading "moved to tickets.js" (`:4962-4966`, `:5170-5178`). The only live copy is `src/webview/tickets.js`, whose own tab button is `tickets.html:4002`.

This matters for the tests in §Verification: any grep-based assertion **must be scoped to `src/webview/tickets.js`**, never to `src/webview/`, or it will match the dead planning.js copy and either false-pass or false-fail.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Attaching an `error` listener to description images after an `innerHTML` write. `design.js:2193` and `design.js:2412` are the in-repo reference implementations.
- Adding a `console.warn` to each bail-out branch in `_rewriteLocalImagePaths`.
- The §5 seam swap: one private helper, one call site, no behaviour change in the extension host.

### Complex / Risky

- **Touching the detail-render memo.** `_lastTicketsDetailContentHtml` / `_lastTicketsClickUpDetailContentHtml` exist to stop flicker and to preserve scroll position and focus inside the detail pane on the many redundant `renderTicketsTab()` calls the panel makes (every `ticketFileChanged`, every sync-status tick). Removing the memo outright would regress all of that. The change here must be a **narrow, one-shot bypass** — force one rewrite when, and only when, the pane currently holds an image that failed — never a blanket "always rewrite".
- **Re-entrancy.** The retry path sets a new `src` on an existing node; it must not itself trigger a full re-render, or a permanently-403ing image becomes an infinite render loop. The retry budget is a hard cap of one per node, tracked on the node itself via a `data-` attribute so it survives nothing (the node is discarded on the next real render, which is correct — a fresh node deserves a fresh attempt).
- **The two memos guard the same DOM element.** `renderTicketsLinearTaskDetail` and `renderTicketsClickUpTaskDetail` both write to `detailContent` but each consults its own memo. Any bypass must clear **both** memos, or a bypass driven from the Linear renderer can be immediately undone by a ClickUp render that still believes its own memo is accurate.
- **§3 mutates the hottest arm in the file, and the arm has a latent invariant.** `renderedDescriptionHtml: _keepLinearDesc ? _prevLinear.renderedDescriptionHtml : …` (`:7644`) dereferences `_prevLinear` with a **bare dot**. That is only safe because today `_keepLinearDesc` is derived *from* `_prevLinear?.localDescription`, so truthy implies present. Any new truthiness source for that flag breaks the invariant and throws inside `window.onmessage`. See the §3 superseded callout.
- **§3 must never be able to leave the pane empty.** Deferring the remote description is only acceptable if the deferral is always resolvable. A deferral that no local read ever answers is worse than the bug being fixed.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Expected behaviour |
| --- | --- |
| `linearTaskDetailsLoaded` / `clickupTaskDetailsLoaded` wins the race against `readLocalTicketFile` | The remote description is **stashed, not discarded** (§3). The pane shows a one-frame "Loading description…" line, then the local description with loadable URLs. |
| Local read wins (the common order) | Unchanged from today. `localDescription: true` already suppresses the later remote payload; §3 adds nothing on this path. |
| A second selection arrives while the first local read is still in flight | The in-flight key is `provider:id`, so a read for ticket A cannot defer ticket B's description. |
| `localTicketFileRead` returns `success:false, reason:'not-imported'` | The in-flight key is cleared **before** any branch, and the stashed remote description is **promoted** so the pane shows the remote body (CDN images and all, which the §2 placeholder then labels honestly). Never an empty pane. |
| `localTicketFileRead` never arrives at all (panel disposed mid-flight, verb dropped, host restarted) | A `_LOCAL_READ_DEFER_MS` timer armed at the post site clears the key and promotes the stash. The deferral is bounded in wall-clock time, not only by a response. |
| Loopback route not yet listening (API-server / provider registration race, documented at `TicketsPanelProvider.ts:1148-1155`) | First load fails, the retry ~600 ms later succeeds. This is the exact transient the retry is for. |

### Security

- §1 adds a class attribute only; the emitted `src` and `sanitizeUrl` behaviour are untouched.
- §2's retry rewrites `src` **only for URLs the host already emitted** and only by appending a cache-bust param, and only for loopback / `vscode-webview*` schemes (see the §2 superseded callout). No user-controlled string reaches `src` that did not already reach it.
- §4 logs a ref and an absolute path to the console. Ticket asset paths are already visible in the pane's own URLs; no token, header, or secret is logged.
- §5 **narrows nothing and widens nothing in the extension host** — the seam returns the identical folder list there. In standalone it makes the provider's allow-list match the root the server itself was booted with (`bootstrap.ts:1847` passes `allRoots: [workspaceRoot]`), so the provider can no longer emit a URL the route would 403, and cannot emit one for a folder the route would reject. The route's own realpath + prefix + extension gates (`LocalApiServer.ts:988-1022`) remain the enforcement point and are unchanged.

### Side Effects

| Case | Expected behaviour |
| --- | --- |
| Image URL is a provider CDN URL that genuinely 401s forever | One retry (no cache-bust param appended — see §2), then a visible inline placeholder naming the file and stating the load failed. Never an invisible gap, never a retry loop. |
| Image is a bare relative ref the host failed to rewrite (`attachments/foo.png`) | Host logs one warning naming the ref, the resolved absolute path, and which gate rejected it. Webview shows the placeholder. |
| Same image referenced N times in one description | Each `<img>` node retries independently; the cap is per node. N is small (the live tree's worst ticket has 7 refs). |
| A permanently-failing image plus repeated external re-renders | The memo bypass recreates the nodes on each *externally triggered* render, so a permanent failure costs 2 requests per render. There is no timer-driven render in `tickets.js` (no `setInterval`), so this is event-bounded, not a background loop. Accepted. |
| User is in edit mode (`ticketsEditMode`) | Both renderers early-return at `:3304` / `:3414`. The retry wiring must live behind the same guard and must not fight the markdown-editor preview, which owns `detailContent` and resets both memos at `:3085-3087`. |
| Standalone / browser cockpit host | Same `tickets.js` runs there; `headlessPanelHtml.ts:278` already allows `http://127.0.0.1:*` and `http://*.localhost:*` in `img-src`, so the retry needs no CSP change. The editor webview's CSP (`tickets.html:23`) likewise already carries `https:`, the loopback origins, `data:` and `file:`. **No CSP edit is part of this plan.** §5 is what makes the cockpit actually receive loopback URLs to load. |
| Panel CSS reaches both hosts from one edit | `headlessPanelHtml.getTicketsHtml` reads `dist/webview/tickets.html`, falling back to `src/webview/tickets.html` (`:419-420`), so the §2 placeholder style added to `src/webview/tickets.html` serves the cockpit too. No second copy to keep in sync. |
| `dist/` staleness | Out of scope per CLAUDE.md — testing is via an installed VSIX and `src/` is the source of truth. |

### Dependencies & Conflicts

- `src/webview/planning.js` holds a dead duplicate of both renderers and of the `readLocalTicketFile` post sites. **Do not edit it. Do not let a test grep reach it.** See "Where the duplicate renderers live" above for the proof it is unreachable.
- `renderMarkdown` in `sharedUtils.js` is shared by `tickets.js`, `design.js`, `project.js`, and `planning.js`. §1 adds a class to its `<img>` output; it must not change the `src`, the inline style, or the element order, or those three other panels' rendering shifts. Nothing in the repo selects on `img` inside markdown output today, so adding a class is additive.
- No schema change, no migration, no config key — nothing here is persisted state, so the shipped-state migration rule does not apply.
- No new dependency outside this repo.

## Dependencies

- None. This plan does not block on, and is not blocked by, any other session.

## Adversarial Synthesis

Key risks: (1) §3 rewrites the hottest message arm in `tickets.js` and, as originally written, would have dereferenced `_prevLinear` on a path where it can be `undefined` — a hard TypeError inside `window.onmessage` on the exact first-view path the plan exists to fix; the corrected shape stashes the remote description instead of suppressing it, so no branch can leave the pane empty. (2) §5 is the difference between fixing the bug and merely making it visible — without it the browser cockpit renders a dashed placeholder for every ticket image, because the standalone shim hardcodes `workspaceFolders` to `[]` and empties the provider's asset allow-list. (3) The memo bypass is narrow by construction (fires only when the pane holds a *proven* failure) and event-bounded, since `tickets.js` has no timer-driven render. Mitigations: optional-chain every `_prevLinear` read and keep `localDescription` derived only from a real local read; bound the deferral with a wall-clock timer as well as a response; scheme-gate the retry cache-buster; scope every grep-based test to `src/webview/tickets.js` so the dead planning.js copy cannot answer for the live one.

## Proposed Changes

### 1. `src/webview/sharedUtils.js` — tag description images so the webview can find and retry them

In the image branch of `renderMarkdown` (`:374-377`), add a marker class. Nothing else changes; the emitted `src` is untouched.

```js
.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
    const safeUrl = escapeAttr(sanitizeUrl(url));
    // `sb-md-img` is the hook the tickets panel uses to attach its one-shot
    // reload handler. A failed <img> is never retried by the browser, and the
    // detail-pane render memo means the node is not recreated on re-selecting
    // the same ticket — so without a handler a transient failure is permanent.
    return `<img class="sb-md-img" src="${safeUrl}" alt="${escapeAttr(alt)}" style="max-width:100%;height:auto;display:block;margin:4px 0;">`;
})
```

`renderedDescriptionHtml` coming from VS Code's `markdown.api.render` will **not** carry this class, so the wiring in §2 must select `img` broadly within the description container and not rely on the class alone. The class stays useful for targeting the placeholder styling and for the test assertion.

### 2. `src/webview/tickets.js` — one-shot image retry + a visible failure placeholder

Add a helper near the other detail-pane helpers, and call it from **both** renderers immediately after their `innerHTML` write.

> **Superseded:** The retry unconditionally appends a cache-bust param — `img.src = base + (base.includes('?') ? '&' : '?') + '_sbr=' + Date.now()` — to whatever URL the node already carries.
> **Reason:** Two problems. (a) It appends to **provider CDN URLs** as well as loopback ones. Those are signed/expiring URLs (the repo's own comment at `TaskViewerProvider.ts:22948-22951` records that "both providers re-sign asset URLs — ClickUp pre-signed with a 60-minute TTL; Linear signed on request"). An unsigned extra query parameter is at best ignored and at worst invalidates the signature outright, which would convert a *possibly recoverable* transient into a guaranteed failure — the retry actively making things worse on the one class of URL where it might have helped. (b) It ignores the case where the node's load already failed **before** the listener was attached (a node re-wired on a later render pass): no further `error` event will ever fire, so that node is silently excluded from the whole recovery mechanism.
> **Replaced with:** Scheme-gate the cache-buster — append it only for the loopback asset route and `vscode-webview*` URIs, which the repo already documents as ignoring unknown query params (`TicketsPanelProvider.ts:550-551`) and which `_rewriteLocalImagePaths` already appends `?v=` to (`:578-580`). For any other scheme, re-issue by clearing and restoring `src` rather than mutating the URL. And after attaching the listener, synthesise the failure path for a node that is already `complete` with `naturalWidth === 0`.

```js
// A failed <img> load is never retried by the browser, and the detail-pane
// memo below means re-selecting the same ticket rebuilds a byte-identical
// contentHtml and therefore skips the innerHTML write entirely — the dead node
// is kept. That is the whole "no images until you click to another ticket and
// back" report: only a DIFFERENT ticket changes the memo, which is what finally
// recreates the nodes. Retry once here so the pane heals itself.
const _IMG_RETRY_DELAY_MS = 600;

// Only these two URL families tolerate an added cache-bust param, and the test is a
// strict ALLOW-list so it fails closed on anything unrecognised. The loopback asset
// route ignores unknown query params by design (TicketsPanelProvider.ts:550) and
// _rewriteLocalImagePaths already appends `?v=` to webview URIs (:578).
//
// Everything else is presumed signed and must NOT be mutated. Confirmed by research
// (see "Research findings" below): ClickUp serves description images as AWS SigV4
// pre-signed URLs and Linear as GCS/CDN V4 signed URLs, and BOTH signing schemes fold
// the entire query string into the HMAC. An unsigned `&_sbr=` on either is not
// ignored — it is a hard 403 SignatureDoesNotMatch. A retry that mutates a signed URL
// manufactures the failure it exists to survive.
const _SIGNED_URL_PARAMS = /[?&](X-Amz-Signature|X-Goog-Signature|GoogleAccessId|Signature|Expires|Key-Pair-Id)=/i;
function _imgSrcAcceptsCacheBust(src) {
    if (_SIGNED_URL_PARAMS.test(src)) { return false; }   // belt-and-braces over the allow-list
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(src)
        || /^vscode-webview(-resource)?:/i.test(src);
}

function _retryDetailImage(img) {
    const base = img.dataset.sbImgBase || img.src;
    if (_imgSrcAcceptsCacheBust(base)) {
        img.src = base + (base.includes('?') ? '&' : '?') + '_sbr=' + Date.now();
        return;
    }
    // Signed/remote URL: re-issue the SAME request rather than mutating it.
    // removeAttribute first is load-bearing — it aborts the pending request and resets
    // the element's internal request state to `unavailable`, so the re-assignment runs
    // "update the image data" from scratch. Assigning an unchanged `src` directly does
    // NOT reliably re-fetch: Blink dedupes against its MemoryCache and WebKit's
    // ImageLoader explicitly short-circuits when `newURL == m_image->url()`.
    //
    // KNOWN LIMITATION, accepted: this resets DOM-level state but does not bypass the
    // HTTP cache, so a failure response that carried an explicit Cache-Control can be
    // answered from cache without touching the wire. It does not affect the path that
    // matters — our own /design/asset denials send only `Content-Type` and no
    // Cache-Control (LocalApiServer.ts:965-968), and 403/503 are not heuristically
    // cacheable without one — and that path takes the cache-bust branch above anyway.
    // The exposure is limited to a remote CDN that caches its own error, where the
    // outcome is one wasted retry before the placeholder, not a wrong render.
    //
    // NOT viable as an alternative: fetch(url, {cache:'reload'}) → createObjectURL.
    // The panel CSP allows these origins under img-src, not connect-src, and the
    // provider CDNs send no CORS headers — the fetch fails before the cache mode
    // matters. Do not "improve" this into a blob pipeline.
    img.removeAttribute('src');
    img.src = base;
}

function _failDetailImage(img) {
    // Second failure: stop, and make it VISIBLE. A silent gap is what made this
    // bug survive several rounds of "fixed".
    const note = document.createElement('div');
    note.className = 'sb-md-img-failed';
    note.setAttribute('data-sb-img-failed', '1');
    note.textContent = 'Image failed to load: ' + (img.getAttribute('alt') || '') +
        ' (' + _shortenImgSrc(img.dataset.sbImgBase || img.src) + ')';
    img.replaceWith(note);
}

function _wireDetailImageRecovery(container) {
    if (!container) return;
    container.querySelectorAll('img').forEach(img => {
        if (img.dataset.sbImgWired === '1') return;
        img.dataset.sbImgWired = '1';
        img.dataset.sbImgBase = img.src;   // the retry must not compound its own params
        img.addEventListener('error', () => {
            if (img.dataset.sbImgRetried !== '1') {
                img.dataset.sbImgRetried = '1';
                // Re-issue rather than re-render: a re-render would re-enter the
                // memo path and, for a permanently-failing URL, loop.
                setTimeout(() => _retryDetailImage(img), _IMG_RETRY_DELAY_MS);
                return;
            }
            _failDetailImage(img);
        }, { once: false });
        // A node whose load already failed before this listener existed will never
        // fire `error` again — `error` dispatches once, during "update the image
        // data", and nothing re-fires it while `complete` stays true. Without this,
        // such a node is invisible to the whole recovery mechanism — a silent gap,
        // which is the failure mode this plan exists to eliminate.
        // `src !== ''` excludes a node that never had a source to begin with, which is
        // also `complete` with zero naturalWidth but is not a failure.
        if (img.complete && img.naturalWidth === 0 && img.src !== '') {
            img.dataset.sbImgRetried = '1';
            setTimeout(() => _retryDetailImage(img), _IMG_RETRY_DELAY_MS);
        }
    });
}

// Loopback asset URLs carry the full absolute path in a query param; showing it
// raw blows out the pane. Keep the filename, which is what identifies the asset.
function _shortenImgSrc(src) {
    try {
        const u = new URL(src, 'http://localhost');
        const p = u.searchParams.get('path') || u.pathname;
        return decodeURIComponent(p).split(/[\\/]/).pop() || src;
    } catch { return src; }
}
```

Call sites — `renderTicketsLinearTaskDetail` (`:3407-3410`) and `renderTicketsClickUpTaskDetail` (`:3517-3519`) both become:

```js
if (_lastTicketsDetailContentHtml !== contentHtml || _detailHasFailedImage(detailContent)) {
    detailContent.innerHTML = contentHtml;
    _lastTicketsDetailContentHtml = contentHtml;
    _lastTicketsClickUpDetailContentHtml = '';   // the two memos guard the SAME element
}
_wireDetailImageRecovery(detailContent);
```

(and the mirrored form in the ClickUp renderer, setting `_lastTicketsClickUpDetailContentHtml` and clearing `_lastTicketsDetailContentHtml`).

`_wireDetailImageRecovery` is called on **every** render, not only when the write happens, so nodes that survive a memo skip still get wired. The `sbImgWired` guard makes the repeat calls free.

The bypass predicate is deliberately narrow — it fires only when the pane is *currently displaying a proven failure*, so the memo keeps doing its flicker/scroll job in every other case:

```js
// Narrow, one-shot memo bypass. Without it, re-selecting the same ticket after a
// failed image load rebuilds an identical contentHtml, the write is skipped, and
// the user's only recovery is to click a different ticket and come back.
function _detailHasFailedImage(container) {
    return !!container && !!container.querySelector('.sb-md-img-failed, [data-sb-img-failed="1"]');
}
```

Add the placeholder style alongside the other detail-pane rules in `src/webview/tickets.html` (which `headlessPanelHtml.getTicketsHtml` also serves to the browser cockpit — `headlessPanelHtml.ts:419-420` — so one edit covers both hosts):

```css
.sb-md-img-failed {
    display: block;
    margin: 4px 0;
    padding: 6px 8px;
    border: 1px dashed var(--border-color);
    border-radius: 4px;
    font-size: 11px;
    opacity: 0.75;
}
.tickets-desc-pending {
    opacity: 0.6;
    font-style: italic;
}
```

`--border-color` is already defined in both theme blocks of that file (`:98`, `:156`).

### 3. `src/webview/tickets.js` — stop the remote description from winning the first paint

Add an in-flight registry next to the detail caches (`:267-268`):

```js
// Selecting a card dispatches readLocalTicketFile AND <provider>LoadTaskDetails in
// parallel (:5582-5605). The only thing that keeps the API response from painting
// the REMOTE description — whose image refs are auth-gated Linear URLs and 60-min
// signed ClickUp URLs that the webview cannot load — is `localDescription`, a flag
// that does not exist until the local read has already landed. Whenever the API
// response wins that race, the first paint carries unloadable image URLs.
const _pendingLocalReads = new Set();   // `${provider}:${id}`
// Hard wall-clock bound. A deferral that is only ever released by a response is a
// deferral that leaks when no response comes (panel disposed mid-flight, verb
// dropped, host restarted) — and a leaked deferral means a permanently empty
// description pane, which is strictly worse than the broken images being fixed.
const _LOCAL_READ_DEFER_MS = 2500;
```

Mark on dispatch at `:5591` and `:5602` (and the same two verbs at `:2969`/`:2971` and `:3175`/`:3192`) through one helper, so a future post site cannot be added without the flag and without the bound:

```js
function _postLocalTicketFileRead(provider, id) {
    const key = provider + ':' + id;
    _pendingLocalReads.add(key);
    setTimeout(() => {
        if (_pendingLocalReads.delete(key)) { _promoteStashedRemoteDescription(provider, id); }
    }, _LOCAL_READ_DEFER_MS);
    vscode.postMessage({ type: 'readLocalTicketFile', provider, id, workspaceRoot: ticketsWorkspaceRoot });
}
```

All six existing `vscode.postMessage({ type: 'readLocalTicketFile', … })` calls become `_postLocalTicketFileRead(<provider>, <id>)`.

Clear on **every** terminal outcome in the `localTicketFileRead` arm (`:7833`) — the success path, the `not-imported` early `break` at `:7844`, and the untyped-failure `break` at `:7848` — by clearing once at the top of the arm, before any branch:

```js
case 'localTicketFileRead': {
    const _wasDeferred = _pendingLocalReads.delete(message.provider + ':' + message.id);
    if (!message.success) {
        // The details arm PARKED the remote description rather than discarding it.
        // There is now no local file to supply a better one, so hand the stash back.
        // Without this, a deferred description that never gets a local file leaves
        // the pane blank forever — a worse bug than the one being fixed.
        if (_wasDeferred) { _promoteStashedRemoteDescription(message.provider, message.id); }
        /* … existing branches unchanged … */
    }
```

> **Superseded:** Extend the existing guards in place — `const _keepLinearDesc = _prevLinear?.localDescription || _pendingLocalReads.has('linear:' + message.issue.id);` — and rely on the note that "when there is no previous entry that resolves to `undefined`".
> **Reason:** It throws, and the note is wrong. At `tickets.js:7644` the arm reads `_keepLinearDesc ? _prevLinear.renderedDescriptionHtml : …` with a **bare dot**, not `?.` — verified at HEAD, with the ClickUp mirror at `:7677`. That is safe today only because `_keepLinearDesc` is *derived from* `_prevLinear?.localDescription`, so truthy strictly implies `_prevLinear` exists. Adding `|| _pendingLocalReads.has(…)` destroys that invariant: on a first-ever selection there is no cache entry, so `_prevLinear` is `undefined` while the flag is `true`, and `_prevLinear.renderedDescriptionHtml` raises `TypeError: Cannot read properties of undefined`. It throws inside the `window.addEventListener('message')` handler, so the rest of the arm never runs — no `linearIssueDetailCache.set`, no `detailsFetched: true`, no `renderTicketsTab()` — on **the exact first-view-after-fetch path this plan exists to fix**. A second, quieter defect rides along: `localDescription: _keepLinearDesc || false` would then record `true` for a description that is not local, poisoning the cache entry so every later real details response is suppressed too. And structurally, *suppressing* the remote payload throws data away — once the local read comes back `not-imported`, there is nothing left to fall back to and the pane stays empty.
> **Replaced with:** Stash, don't suppress. Always compute the remote description and keep it on the cache entry; choose which one to *display* via a separate `descriptionPending` flag; optional-chain every `_prevLinear` read; and keep `localDescription` derived only from a real local read.

```js
case 'linearTaskDetailsLoaded': {
    const _prevLinear = linearIssueDetailCache.get(message.issue.id);
    const _keepLinearDesc = !!_prevLinear?.localDescription;
    const _linearSrc = (message.issue.description || '').trim();
    // ALWAYS compute the remote description; never discard it. It is the only
    // fallback if no local file turns up, and a discarded description cannot be
    // recovered by clearing a flag.
    const _remoteRendered = message.renderedDescriptionHtml || renderMarkdown(_linearSrc);
    const _remoteMarkdown = message.issue.description || '';
    // Defer only while a local read for THIS ticket is genuinely outstanding. The
    // local file's refs are rewritten to loadable loopback URLs; this payload's are
    // auth-gated CDN URLs that the webview cannot fetch.
    const _deferLinearDesc = !_keepLinearDesc
        && _pendingLocalReads.has('linear:' + message.issue.id);
    selectedLinearIssue = {
        issue: message.issue,
        subtasks: message.subtasks || [],
        comments: message.comments || [],
        attachments: message.attachments || [],
        // Every _prevLinear read is optional-chained: _deferLinearDesc can be true
        // with NO cache entry (first-ever selection), which a bare dot would throw on.
        renderedDescriptionHtml: _keepLinearDesc
            ? _prevLinear.renderedDescriptionHtml
            : (_deferLinearDesc ? (_prevLinear?.renderedDescriptionHtml || '') : _remoteRendered),
        descriptionMarkdown: _keepLinearDesc
            ? _prevLinear.descriptionMarkdown
            : (_deferLinearDesc ? (_prevLinear?.descriptionMarkdown || '') : _remoteMarkdown),
        // NOT `_keepLinearDesc || _deferLinearDesc`. A pending read is not a local
        // description; recording it as one would make every later details response
        // for this ticket suppress itself against a description that never arrived.
        localDescription: _keepLinearDesc,
        descriptionPending: _deferLinearDesc,
        // The stash. _promoteStashedRemoteDescription hands these back if the local
        // read resolves to "no local file".
        remoteRenderedDescriptionHtml: _remoteRendered,
        remoteDescriptionMarkdown: _remoteMarkdown,
        detailsFetched: true
    };
    /* … rest of the arm unchanged … */
```

and the mirror in `clickupTaskDetailsLoaded` (`:7660-7684`) using `message.task.id`, `_prevClickUp`, and `message.task.markdownDescription || message.task.description`.

The promoter:

```js
// Hands the stashed remote description back when the deferral cannot be honoured
// (no local file, or the read never answered inside _LOCAL_READ_DEFER_MS).
function _promoteStashedRemoteDescription(provider, id) {
    const cache = provider === 'clickup' ? clickUpTaskDetailCache : linearIssueDetailCache;
    const entry = cache.get(id);
    if (!entry || !entry.descriptionPending) return;
    const next = {
        ...entry,
        renderedDescriptionHtml: entry.remoteRenderedDescriptionHtml || '',
        descriptionMarkdown: entry.remoteDescriptionMarkdown || '',
        descriptionPending: false
    };
    cache.set(id, next);
    if (provider === 'clickup') {
        if (selectedClickUpIssue?.task?.id === id) selectedClickUpIssue = next;
    } else if (selectedLinearIssue?.issue?.id === id) {
        selectedLinearIssue = next;
    }
    if (!ticketsEditMode) renderTicketsTab();
}
```

Renderer guard — `renderTicketsLinearTaskDetail` (`:3376-3385`) and the ClickUp mirror. Without this the `else` branch falls through to `issue.description`, which **is** the remote markdown with the CDN refs, re-introducing exactly what the deferral removed:

```js
if (selectedLinearIssue.descriptionPending) {
    // Deferred, not missing. Never fall through to issue.description here — that is
    // the raw remote body whose image refs are the unloadable CDN URLs the deferral
    // exists to keep off the first paint.
    contentHtml += '<p class="tickets-desc-pending">Loading description…</p>';
} else if (selectedLinearIssue.renderedDescriptionHtml) {
    contentHtml += externalizeAnchors(selectedLinearIssue.renderedDescriptionHtml);
} else {
    /* … existing empty-state branch unchanged … */
}
```

Everything else on the details response (subtasks, comments, attachments, status) still applies immediately — only the description is deferred, and only for as long as a local read is genuinely outstanding.

### 4. `src/services/TicketsPanelProvider.ts` — make the rewrite's bail-outs loud

`_rewriteLocalImagePaths` (`:558-585`) currently returns the original ref from four branches with no signal. Give each a reason and warn once per `(file, ref, reason)` per session:

```ts
private _rewriteLocalImagePaths(markdown: string, baseDir: string): string {
    const bail = (ref: string, reason: string, detail?: string) => {
        const key = `${baseDir}::${ref}::${reason}`;
        if (this._imageRewriteWarned.has(key)) { return; }
        this._imageRewriteWarned.add(key);
        // Four silent `return match` paths are why this bug has been declared fixed
        // more than once: an unresolved ref and a resolved-but-403ing ref look
        // identical from the webview (a blank image, no log line anywhere).
        console.warn(`[TicketsPanel] inline image not localised (${reason}): ${ref}${detail ? ' → ' + detail : ''}`);
    };
    …
    if (!fs.existsSync(absPath)) { bail(trimmed, 'file-missing', absPath); return match; }
    const assetUrl = this._buildLocalAssetUrl(absPath);
    if (assetUrl) { return `![${alt}](${assetUrl})`; }
    if (!this._panel) { bail(trimmed, 'outside-asset-roots-and-no-panel', absPath); return match; }
    const webviewUri = this._panel.webview.asWebviewUri(vscode.Uri.file(absPath));
    if (!webviewUri) { bail(trimmed, 'as-webview-uri-empty', absPath); return match; }
    …
} catch (e: any) {
    bail(String(url).trim(), 'exception', e?.message);
    return match;
}
```

with `private readonly _imageRewriteWarned = new Set<string>();` on the class. `_buildLocalAssetUrl`'s own `isAllowed` rejection (`:541-544`) gets the same treatment, since that is the branch that silently downgrades to `asWebviewUri` and — when the panel's `localResourceRoots` also miss the folder — to nothing at all.

Bound the set: clear it in `dispose()` alongside the other per-panel state, so a long-lived host does not accumulate one entry per ref per ticket forever.

**This section is a diagnosis protocol, not only hygiene.** After this change, an image that is still blank must produce exactly one of two signals, and which one appears names the follow-up:

| Signal | Meaning | Follow-up |
| --- | --- | --- |
| `[TicketsPanel] inline image not localised (outside-asset-roots-and-no-panel)` | The host never emitted a loadable URL — an allow-list gate rejected the file. | The deferred extension-host root-set unification (`_getWorkspaceRoots()` vs `allRoots`). |
| Dashed `Image failed to load: …` placeholder with **no** host warning | The host emitted a URL and the *transport* refused it. | The `/design/asset` route's own gates, or the API-server listen race. |
| Neither — image renders | Fixed. | — |

### 5. `src/services/TicketsPanelProvider.ts` — resolve asset roots through the seam so the browser cockpit gets loadable URLs

*(Pulled in by the superseded callout under "Related but deliberately NOT the fix here". This is the half of the root-set divergence that is a total failure, not an edge case.)*

`_buildLocalAssetUrl` builds its allow-list from `this._getWorkspaceRoots()` (`:537`), which is `(vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath)` (`:175-177`). The standalone shim hardcodes `workspaceFolders` to `[]` (`src/standalone/vscodeShim.ts:189`), so in the browser cockpit that allow-list is empty, `isAllowed` is false for every asset, `_buildLocalAssetUrl` returns `undefined`, `this._panel` is also undefined, and every inline image reaches the webview as a bare `attachments/foo.png` that 404s against the cockpit origin.

The seam already solves exactly this. `VscodeHostWorkspace.getWorkspaceRoots()` returns the real folder list in the editor and falls back to the configured root when the shim reports none (`hostSeams.ts:516-529`), and `bootstrap.ts:666` builds the bundle with the standalone workspace root while `:703` injects it straight into this provider's `_hostSeams`.

Add a scoped helper and use it in `_buildLocalAssetUrl` **only** — `_getWorkspaceRoots()` has many other callers whose standalone behaviour is out of scope for this plan:

```ts
/**
 * Roots the inline-image allow-list is built from.
 *
 * NOT `_getWorkspaceRoots()`: that reads `vscode.workspace.workspaceFolders`
 * directly, and the standalone shim hardcodes it to `[]`
 * (src/standalone/vscodeShim.ts:189). In the browser cockpit that leaves this
 * allow-list empty, so EVERY inline ticket image fails `isAllowed`, falls through
 * to the `!this._panel` bail-out, and reaches the webview as a bare relative ref
 * that 404s against the cockpit origin — permanently, for every image, with no
 * retry able to help.
 *
 * The seam returns the identical list in the extension host (folders are always
 * populated there), so this is behaviour-preserving on the ~4k shipped installs
 * (PRD contract #2) while closing a direct `vscode.*` reach inside the provider
 * (PRD contract #3). The route's own realpath/prefix/extension gates
 * (LocalApiServer.ts:988-1022) remain the enforcement point and are unchanged.
 *
 * No recursion risk: `_seams()`'s lazy fallback calls `_getWorkspaceRoot()`
 * (singular, :179), which is a different function and still reads vscode directly.
 */
private _getAssetAllowRoots(): string[] {
    try {
        const roots = this._seams()?.workspace?.getWorkspaceRoots?.() || [];
        if (roots.length) { return roots; }
    } catch { /* seams unavailable — fall through to the direct read */ }
    return this._getWorkspaceRoots();
}
```

In `_buildLocalAssetUrl`:

```ts
const allowed = this._getAssetAllowRoots()
    .flatMap(root => this.getTicketsAssetRoots(root))
    .map(folder => realOf(path.resolve(folder)))
    .filter((f): f is string => !!f);
…
// `root=` is carried for readability only — the route explicitly does not trust it
// (LocalApiServer.ts:991-993) — but emitting an empty one in standalone made the
// URLs unreadable in logs. Take the first allow-list root instead.
const root = this._getAssetAllowRoots()[0] || this._getWorkspaceRoot() || '';
```

`localResourceRoots` (`:1162`) is deliberately **left alone**: it is only reachable when `this._panel` exists, i.e. in the extension host, where the seam and the direct read are identical.

## Verification Plan

**Build:** omitted here per the session's SKIP COMPILATION directive. `dist/` is not exercised during development or testing (CLAUDE.md); `npm run compile` is only needed when cutting a VSIX for the UAT below.

### Automated Tests

All grep-based assertions **must be scoped to `src/webview/tickets.js`**, never `src/webview/` — `planning.js` holds a dead duplicate of both renderers and of four `readLocalTicketFile` post sites (see the scope note in the Goal), and a directory-wide grep will match it and report a false result in either direction.

1. New test `src/test/tickets-detail-image-recovery.test.js` — source-shape assertions in the style of `tickets-description-markdown-fallback.test.js`:
   - `sharedUtils.js`'s image branch emits `class="sb-md-img"`, and still emits `src="${safeUrl}"` unchanged.
   - Both `renderTicketsLinearTaskDetail` and `renderTicketsClickUpTaskDetail` call `_wireDetailImageRecovery(detailContent)` **after** their `innerHTML` write, and both memo guards include `|| _detailHasFailedImage(detailContent)`.
   - Each renderer clears the *other* provider's memo when it writes.
   - `_wireDetailImageRecovery` caps retries at one per node (assert on the `sbImgRetried` guard) and wires the already-`complete`-with-zero-`naturalWidth` case.
   - `_retryDetailImage` gates the cache-bust param on `_imgSrcAcceptsCacheBust` — assert the mutation is inside that branch, so a future edit cannot start appending params to signed CDN URLs. Research confirmed this is a hard 403 on both providers, so treat it as a correctness pin, not style.
   - `_imgSrcAcceptsCacheBust` returns `false` for a URL carrying `X-Amz-Signature` or `X-Goog-Signature` even when the host would otherwise match, and the non-bustable branch calls `removeAttribute('src')` before restoring (same-value assignment does not reliably re-fetch in Blink or WebKit).
2. New test `src/test/tickets-local-read-race.test.js`:
   - `tickets.js` contains **zero** raw `vscode.postMessage({ type: 'readLocalTicketFile'` occurrences — every site goes through `_postLocalTicketFileRead`, so a new post site cannot skip the in-flight flag or its timeout. Assert the helper is called at least 6 times.
   - The `localTicketFileRead` arm deletes the key **before** any `break`, so all three terminal paths clear it, and calls `_promoteStashedRemoteDescription` on the failure path.
   - Both details arms compute the remote description **unconditionally** and store it as `remoteRenderedDescriptionHtml`; neither sets `localDescription` from the pending-read flag.
   - **Regression pin for the crash this plan nearly shipped:** no `_prevLinear.` or `_prevClickUp.` bare-dot dereference appears on a line that also mentions `_defer` — every read on a deferrable path is optional-chained.
   - Both renderers guard `descriptionPending` **before** the `renderedDescriptionHtml` branch, so the deferred path can never fall through to `issue.description`.
3. New test `src/test/tickets-asset-roots-standalone.test.js`:
   - `_buildLocalAssetUrl` calls `_getAssetAllowRoots()`, not `_getWorkspaceRoots()`.
   - `_getAssetAllowRoots` reads `workspace.getWorkspaceRoots` off `_seams()` and falls back to `_getWorkspaceRoots()`.
   - `_getWorkspaceRoot` (singular) still reads `vscode.workspace.workspaceFolders` directly — pins the no-recursion property of `_seams()`'s lazy init.
4. Run the existing suites that pin this area and confirm they stay green: `tickets-description-markdown-fallback.test.js`, `tickets-auto-refresh-on-file-change.test.js` (it pins the `_applyTicketFilePayloadToSelected` change guard at `:6901`), `tickets-subtask-embedding.test.js` (§20 of it executes `_relocalizeInlineImages`'s raw body via `new Function` — do not introduce TypeScript-only syntax anywhere near it), `webview-panel-runtime-surface.test.js`, `verb-engine-tickets-headless.test.js`.
5. Stash-verify first: five regression tests are red at HEAD for unrelated reasons — confirm the red set is unchanged before attributing any failure to this work.

### Manual UAT (installed VSIX — this is the real gate)

1. Open the Tickets panel, click **Fetch**/**Refetch** on a list whose tickets contain inline screenshots.
2. Click the **first** ticket that has images. **Expected: images render on this first view.** Today they do not.
3. Without leaving that ticket, if any image did fail: it must self-recover within ~1 s, or show the dashed "Image failed to load: <filename>" placeholder. **A silent blank gap is a failure of this plan.**
4. Click the same ticket again (re-select). No flicker, no re-fetch, images still shown.
5. Click a different ticket, then back. Images shown, no double-render.
6. Enter edit mode on a ticket with images, exit without saving. Preview still shows images; the markdown-editor path (`:3085-3087`) still owns `detailContent` correctly.
7. Open a ticket that has **not** been imported locally (so `localTicketFileRead` answers `not-imported`). The description must appear — the remote body, promoted from the stash — never an empty pane or a stuck "Loading description…".
8. Open the Output/dev-tools console and confirm that for any image that still does not render there is now a `[TicketsPanel] inline image not localised (<reason>)` line naming the ref. Read the result against the §4 table to name the follow-up.
9. Repeat steps 1-3 in the **browser cockpit** (standalone host) against the same workspace. **This is §5's acceptance gate:** before the change every inline image there resolves to a bare `attachments/…` ref and 404s; after it, the pane must show images. If it still shows placeholders, §5 did not take effect — check that `bootstrap.ts:703`'s seam injection reached the provider before the first read.

## Research findings (resolved — no open assumptions)

Two browser/API behaviours were not certain at authoring time. Web research was run and both are now settled; the answers are folded into §2 above. Everything else in this plan was verified directly against the repository at HEAD. **No open assumptions remain — do not re-research this before implementing.**

1. **Appending an unsigned query parameter to a signed asset URL is actively fatal — confirmed.** AWS SigV4 folds the entire query string (sorted, every key) into the `CanonicalRequest` that produces `X-Amz-Signature`, so an extra `&_sbr=` yields HTTP 403 `SignatureDoesNotMatch`. Legacy SigV2 ignored unknown params, but it is sunsetted and not in play. Both providers are affected: ClickUp serves description images as S3/CloudFront SigV4 pre-signed URLs, and Linear's `<img>`-usable URLs are GCS/CDN V4 signed URLs (its bearer-header path cannot be used from an `<img>` tag at all). **Consequence:** §2's cache-bust gate is *necessary*, not caution. The allow-list is kept as the primary gate because it fails closed on unrecognised schemes, with `_SIGNED_URL_PARAMS` added as a second, explicit block on `X-Amz-Signature` / `X-Goog-Signature` / `GoogleAccessId` / `Signature` / `Expires` / `Key-Pair-Id`.
2. **Same-value `src` re-assignment is unreliable; `removeAttribute` + restore fixes the DOM half but not the HTTP-cache half — confirmed, with a caveat now documented in code.** Blink dedupes an identical canonical URL against its MemoryCache and can reuse the cached error state without a network request; WebKit's `ImageLoader` explicitly short-circuits when `newURL == m_image->url()`. So the `removeAttribute('src')` in `_retryDetailImage` is required, not redundant. It does **not**, however, bypass the HTTP cache: a failure response carrying an explicit `Cache-Control` can be answered from cache. That exposure does not reach the path this plan cares about — our own `/design/asset` denial sends only `Content-Type` (`LocalApiServer.ts:965-968`), and 403/503 are not heuristically cacheable without an explicit header, so the loopback failure is always re-requestable; and that path takes the cache-bust branch regardless. The residual is one wasted retry against a remote CDN that caches its own error, which ends at the placeholder — accepted, and commented in `_retryDetailImage`. The `fetch(url, {cache:'reload'})` → blob workaround was evaluated and **rejected**: the panel CSP allows these origins under `img-src` only, and the provider CDNs send no CORS headers, so the fetch fails before the cache mode is reached.
3. **`img.complete && img.naturalWidth === 0` is the correct and reliable already-failed probe — confirmed.** `complete` becomes true once the fetch algorithm finishes in either the `completely available` or `broken` state, and `error` dispatches exactly once during "update the image data" with nothing re-firing it while `complete` stays true. §2's late-attach guard is therefore the only way such a node re-enters the recovery path. `img.src !== ''` was added to the condition to exclude a node that never had a source, which matches the same shape without being a failure.

---

**Recommendation: Send to Coder** (complexity 6).
